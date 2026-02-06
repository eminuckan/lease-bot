import test from "node:test";
import assert from "node:assert/strict";

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
  const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url: pathnameWithQuery,
    headers: {
      host: "localhost",
      ...(body === null ? {} : { "content-type": "application/json" })
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    }
  };
}

function createResponseCapture() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(statusCode, headers) {
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

test("GET /api/admin/platform-policies returns policy contract payload", async () => {
  const req = createRequest("GET", "/api/admin/platform-policies");
  const res = createResponseCapture();
  const expectedItems = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      platform: "leasebreak",
      accountName: "Leasebreak",
      accountExternalId: "lb-1",
      isActive: true,
      integrationMode: "rpa",
      sendMode: "draft_only",
      sendModeOverride: null,
      globalDefaultSendMode: "draft_only",
      credentials: {},
      createdAt: "2026-02-06T00:00:00.000Z",
      updatedAt: "2026-02-06T00:00:00.000Z"
    }
  ];

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "u1", role: "admin" } }),
    withClient: async (task) => task({ id: "fake" }),
    fetchPlatformPolicies: async () => expectedItems
  });

  await routeApi(req, res, new URL(req.url, "http://localhost"));

  assert.equal(res.statusCode, 200);
  const payload = parseJsonBody(res);
  assert.equal(payload.globalDefaultSendMode, "draft_only");
  assert.equal(Array.isArray(payload.requiredPlatforms), true);
  assert.equal(Array.isArray(payload.missingPlatforms), true);
  assert.deepEqual(payload.items, expectedItems);
});

test("PUT /api/admin/platform-policies/:id validates payload fields", async () => {
  const req = createRequest("PUT", "/api/admin/platform-policies/11111111-1111-4111-8111-111111111111", {
    sendMode: "send_now",
    credentials: {
      passwordRef: "plain-text-secret"
    }
  });
  const res = createResponseCapture();

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "u1", role: "admin" } })
  });

  await routeApi(req, res, new URL(req.url, "http://localhost"));

  assert.equal(res.statusCode, 400);
  const payload = parseJsonBody(res);
  assert.equal(payload.error, "validation_error");
  assert.equal(payload.details.includes("sendMode must be auto_send, draft_only, or null"), true);
  assert.equal(payload.details.includes("credentials.passwordRef must reference env: or secret:"), true);
});

test("PUT /api/admin/platform-policies/:id updates policy and returns dto", async () => {
  const platformAccountId = "11111111-1111-4111-8111-111111111111";
  const req = createRequest("PUT", `/api/admin/platform-policies/${platformAccountId}`, {
    isActive: false,
    sendMode: null,
    integrationMode: "rpa",
    credentials: {
      apiKeyRef: "env:LEASEBREAK_API_KEY"
    }
  });
  const res = createResponseCapture();

  const fakeClient = {
    query: async (sql) => {
      if (sql.includes("SELECT id, platform") && sql.includes("FROM \"PlatformAccounts\"")) {
        return {
          rowCount: 1,
          rows: [{ id: platformAccountId, platform: "leasebreak" }]
        };
      }

      if (sql.includes("UPDATE \"PlatformAccounts\"")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: platformAccountId,
              platform: "leasebreak",
              account_name: "Leasebreak",
              account_external_id: "lb-1",
              credentials: { apiKeyRef: "env:LEASEBREAK_API_KEY" },
              is_active: false,
              send_mode: null,
              integration_mode: "rpa",
              created_at: "2026-02-06T00:00:00.000Z",
              updated_at: "2026-02-06T00:05:00.000Z"
            }
          ]
        };
      }

      if (sql.includes("INSERT INTO \"AuditLogs\"")) {
        return { rowCount: 1, rows: [] };
      }

      return { rowCount: 1, rows: [] };
    }
  };

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({
      user: {
        id: "22222222-2222-4222-8222-222222222222",
        role: "admin"
      }
    }),
    withClient: async (task) => task(fakeClient)
  });

  await routeApi(req, res, new URL(req.url, "http://localhost"));

  assert.equal(res.statusCode, 200);
  const payload = parseJsonBody(res);
  assert.equal(payload.id, platformAccountId);
  assert.equal(payload.isActive, false);
  assert.equal(payload.sendModeOverride, null);
  assert.equal(payload.sendMode, "draft_only");
  assert.equal(payload.integrationMode, "rpa");
  assert.deepEqual(payload.credentials, { apiKeyRef: "env:LEASEBREAK_API_KEY" });
});

test("GET /api/listings includeInactive is admin-only", async () => {
  const agentReq = createRequest("GET", "/api/listings?includeInactive=true");
  const agentRes = createResponseCapture();
  const calls = [];

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "u-agent", role: "agent" } }),
    withClient: async (task) => task({ id: "fake" }),
    fetchListings: async (_client, _unitId, options) => {
      calls.push(options);
      return [];
    }
  });

  await routeApi(agentReq, agentRes, new URL(agentReq.url, "http://localhost"));
  assert.equal(agentRes.statusCode, 200);
  assert.deepEqual(calls[0], { onlyActivePlatform: true });

  const adminReq = createRequest("GET", "/api/listings?includeInactive=true");
  const adminRes = createResponseCapture();
  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "u-admin", role: "admin" } }),
    withClient: async (task) => task({ id: "fake" }),
    fetchListings: async (_client, _unitId, options) => {
      calls.push(options);
      return [];
    }
  });

  await routeApi(adminReq, adminRes, new URL(adminReq.url, "http://localhost"));
  assert.equal(adminRes.statusCode, 200);
  assert.deepEqual(calls[1], { onlyActivePlatform: false });
});

test("GET /api/admin/platform-health returns platform health fields", async () => {
  const req = createRequest("GET", "/api/admin/platform-health");
  const res = createResponseCapture();

  const expectedItems = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      platform: "leasebreak",
      accountName: "Leasebreak Main",
      accountExternalId: "lb-main",
      isActive: false,
      sendMode: "draft_only",
      sendModeOverride: null,
      globalDefaultSendMode: "draft_only",
      lastSuccessfulIngestAt: "2026-02-06T10:10:00.000Z",
      lastSuccessfulSendAt: "2026-02-06T10:12:00.000Z",
      errorCount24h: 3,
      disableReason: "disabled_by_admin_policy"
    }
  ];

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "u1", role: "admin" } }),
    withClient: async (task) => task({ id: "fake" }),
    fetchPlatformHealthSnapshot: async () => expectedItems
  });

  await routeApi(req, res, new URL(req.url, "http://localhost"));

  assert.equal(res.statusCode, 200);
  const payload = parseJsonBody(res);
  assert.equal(typeof payload.generatedAt, "string");
  assert.deepEqual(payload.items, expectedItems);
});

test("collectGuardrailReviewReasons identifies auto-send review blockers", () => {
  assert.deepEqual(__testables.collectGuardrailReviewReasons(null), []);
  assert.deepEqual(
    __testables.collectGuardrailReviewReasons({
      requiresAdminReview: true,
      guardrails: ["manual_review_required"],
      riskLevel: "critical"
    }),
    ["explicit_admin_review", "guardrails_blocked", "risk_critical"]
  );
});
