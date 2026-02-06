import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/lease_bot_test";
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-value";

const {
  routeApi,
  setRouteTestOverrides,
  resetRouteTestOverrides,
  __testables
} = await import("../src/server.js");

function createRequest(method, pathnameWithQuery, body = null) {
  const payload = body ? Buffer.from(JSON.stringify(body)) : null;
  return {
    method,
    url: pathnameWithQuery,
    headers: {
      host: "localhost",
      "content-type": "application/json"
    },
    async *[Symbol.asyncIterator]() {
      if (payload) {
        yield payload;
      }
    }
  };
}

function createResponseCapture() {
  return {
    statusCode: null,
    body: "",
    headers: {},
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(payload = "") {
      this.body = payload;
    }
  };
}

function parseJsonBody(res) {
  return JSON.parse(res.body || "{}");
}

async function callRoute(method, pathnameWithQuery, { role = "admin", body = null, withClient } = {}) {
  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "user-1", role } }),
    ...(withClient ? { withClient } : {})
  });

  const req = createRequest(method, pathnameWithQuery, body);
  const res = createResponseCapture();
  await routeApi(req, res, new URL(req.url, "http://localhost"));
  return { res, json: parseJsonBody(res) };
}

test("R11: candidate query uses assignment mode gating and priority ordering", async () => {
  const rows = [
    {
      agent_id: "22222222-2222-4222-8222-222222222222",
      assignment_mode: "active",
      priority: 1,
      full_name: "A",
      agent_timezone: "UTC",
      unit_slot_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      unit_starts_at: "2026-04-15T15:00:00.000Z",
      unit_ends_at: "2026-04-15T16:00:00.000Z",
      unit_timezone: "UTC",
      agent_slot_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      agent_starts_at: "2026-04-15T15:00:00.000Z",
      agent_ends_at: "2026-04-15T16:00:00.000Z",
      agent_timezone_source: "UTC",
      candidate_starts_at: "2026-04-15T15:00:00.000Z",
      candidate_ends_at: "2026-04-15T16:00:00.000Z"
    },
    {
      agent_id: "33333333-3333-4333-8333-333333333333",
      assignment_mode: "passive",
      priority: 3,
      full_name: "B",
      agent_timezone: "UTC",
      unit_slot_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      unit_starts_at: "2026-04-15T15:00:00.000Z",
      unit_ends_at: "2026-04-15T16:00:00.000Z",
      unit_timezone: "UTC",
      agent_slot_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      agent_starts_at: "2026-04-15T15:00:00.000Z",
      agent_ends_at: "2026-04-15T16:00:00.000Z",
      agent_timezone_source: "UTC",
      candidate_starts_at: "2026-04-15T15:00:00.000Z",
      candidate_ends_at: "2026-04-15T16:00:00.000Z"
    }
  ];

  let sql = "";
  const activeOnlyClient = {
    query: async (statement, params) => {
      sql = statement;
      assert.equal(params[0], "11111111-1111-4111-8111-111111111111");
      return { rows: [rows[0]] };
    }
  };

  const activeOnly = await __testables.fetchUnitAgentSlotCandidates(activeOnlyClient, "11111111-1111-4111-8111-111111111111", {
    fromDate: "2026-04-15",
    toDate: "2026-04-15",
    timezone: "UTC",
    includePassive: false
  });

  assert.match(sql, /ua\.assignment_mode = 'active'/);
  assert.match(sql, /ORDER BY ua\.priority ASC, candidate_starts_at ASC/);
  assert.deepEqual(activeOnly.map((item) => item.assignmentMode), ["active"]);
  assert.deepEqual(activeOnly.map((item) => item.priority), [1]);

  const includePassiveClient = {
    query: async (statement) => {
      sql = statement;
      return { rows };
    }
  };

  const includePassive = await __testables.fetchUnitAgentSlotCandidates(includePassiveClient, "11111111-1111-4111-8111-111111111111", {
    fromDate: "2026-04-15",
    toDate: "2026-04-15",
    timezone: "UTC",
    includePassive: true
  });

  assert.match(sql, /ua\.assignment_mode IN \('active', 'passive'\)/);
  assert.deepEqual(includePassive.map((item) => item.assignmentMode), ["active", "passive"]);
  assert.deepEqual(includePassive.map((item) => item.priority), [1, 3]);
});

test("R12: candidate query anti-joins unavailable overlaps", async () => {
  let sql = "";
  const client = {
    query: async (statement) => {
      sql = statement;
      return { rows: [] };
    }
  };

  await __testables.fetchUnitAgentSlotCandidates(client, "11111111-1111-4111-8111-111111111111", {
    fromDate: "2026-04-16",
    toDate: "2026-04-16",
    timezone: "UTC",
    includePassive: false
  });

  assert.match(sql, /NOT EXISTS \(/);
  assert.match(sql, /blocked_slot\.status = 'unavailable'/);
  assert.match(sql, /tstzrange\(blocked_slot\.starts_at, blocked_slot\.ends_at, '\[\)'\)/);
  assert.match(sql, /GREATEST\(unit_slot\.starts_at, agent_slot\.starts_at\)/);
  assert.match(sql, /LEAST\(unit_slot\.ends_at, agent_slot\.ends_at\)/);
});

test("R16: API rejects conflicting active priority assignments", async () => {
  let callCount = 0;
  const response = await callRoute("PUT", "/api/units/11111111-1111-4111-8111-111111111111/agents", {
    role: "admin",
    body: {
      agentId: "22222222-2222-4222-8222-222222222222",
      assignmentMode: "active",
      priority: 1
    },
    withClient: async () => {
      callCount += 1;
      const error = new Error("duplicate active priority");
      error.code = "23505";
      throw error;
    }
  });

  assert.equal(callCount, 1);
  assert.equal(response.res.statusCode, 400);
  assert.equal(response.json.message, "priority already in use for active unit assignments");
});

test("R16: migration declares overlap/priority conflict-safety constraints", async () => {
  const migration = await readFile(new URL("../../../packages/db/migrations/003_unit_agent_assignment_and_availability.sql", import.meta.url), "utf8");

  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_unit_agent_assignments_active_priority/);
  assert.match(migration, /WHERE assignment_mode = 'active'/);
  assert.match(migration, /ADD CONSTRAINT agent_availability_no_overlap/);
  assert.match(migration, /EXCLUDE USING GIST/);
  assert.match(migration, /WHERE \(status = 'available'\)/);
});

test.after(() => {
  resetRouteTestOverrides();
});
