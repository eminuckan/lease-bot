import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/lease_bot_test";
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-value";

const {
  routeApi,
  setRouteTestOverrides,
  resetRouteTestOverrides
} = await import("../src/server.js");

function createGetRequest(pathnameWithQuery) {
  return {
    method: "GET",
    url: pathnameWithQuery,
    headers: {
      host: "localhost"
    }
  };
}

function createResponseCapture() {
  return {
    statusCode: null,
    body: "",
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(payload = "") {
      this.body = payload;
    }
  };
}

function parseJsonBody(res) {
  return JSON.parse(res.body || "{}");
}

test("/api/units/:id/agent-slot-candidates enforces auth", async () => {
  const req = createGetRequest("/api/units/33333333-3333-4333-8333-333333333333/agent-slot-candidates");
  const res = createResponseCapture();

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => null
  });

  await routeApi(req, res, new URL(req.url, "http://localhost"));
  assert.equal(res.statusCode, 401);
  assert.deepEqual(parseJsonBody(res), { error: "unauthorized" });
});

test("/api/units/:id/agent-slot-candidates validates timezone", async () => {
  const req = createGetRequest("/api/units/33333333-3333-4333-8333-333333333333/agent-slot-candidates?timezone=Bad/Timezone");
  const res = createResponseCapture();

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "u1", role: "agent" } })
  });

  await routeApi(req, res, new URL(req.url, "http://localhost"));
  assert.equal(res.statusCode, 400);
  assert.equal(parseJsonBody(res).message, "timezone must be a valid IANA timezone");
});

test("/api/units/:id/agent-slot-candidates returns candidate payload", async () => {
  const req = createGetRequest(
    "/api/units/33333333-3333-4333-8333-333333333333/agent-slot-candidates?fromDate=2026-02-10&toDate=2026-02-11&timezone=America/Chicago&includePassive=true"
  );
  const res = createResponseCapture();

  let candidateArgs = null;

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "u1", role: "agent" } }),
    withClient: async (task) => task({ id: "client-1" }),
    fetchUnitAgentSlotCandidates: async (_client, unitId, options) => {
      candidateArgs = { unitId, ...options };
      return [
        {
          unitId,
          agentId: "22222222-2222-2222-2222-222222222222",
          assignmentMode: "active",
          priority: 1,
          agentName: "Morgan Hale",
          startsAt: "2026-02-10T23:00:00.000Z",
          endsAt: "2026-02-10T23:30:00.000Z",
          localStart: "2026-02-10T17:00:00",
          localEnd: "2026-02-10T17:30:00",
          displayTimezone: "America/Chicago"
        }
      ];
    }
  });

  await routeApi(req, res, new URL(req.url, "http://localhost"));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(candidateArgs, {
    unitId: "33333333-3333-4333-8333-333333333333",
    fromDate: "2026-02-10",
    toDate: "2026-02-11",
    timezone: "America/Chicago",
    includePassive: true
  });
  assert.equal(parseJsonBody(res).items.length, 1);
});
