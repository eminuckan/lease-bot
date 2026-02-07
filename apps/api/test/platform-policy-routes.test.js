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
    getSession: async () => ({ user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "agent" } }),
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
      integrationMode: "rpa",
      globalDefaultSendMode: "draft_only",
      lastSuccessfulIngestAt: "2026-02-06T10:10:00.000Z",
      lastSuccessfulSendAt: "2026-02-06T10:12:00.000Z",
      errorCount24h: 3,
      disableReason: "disabled_by_admin_policy",
      health: "inactive",
      error: {
        count24h: 3,
        lastErrorAt: "2026-02-06T10:14:00.000Z"
      }
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
  assert.equal(payload.items[0].isActive, false);
  assert.equal(payload.items[0].sendMode, "draft_only");
  assert.equal(payload.items[0].integrationMode, "rpa");
  assert.equal(payload.items[0].health, "inactive");
  assert.equal(payload.items[0].error.count24h, 3);
});

test("R18: fetchPlatformHealthSnapshot maps admin visibility fields from DB row", async () => {
  let capturedSql = "";
  const fakeClient = {
    query: async (sql) => {
      capturedSql = sql;
      return {
        rowCount: 1,
        rows: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            platform: "leasebreak",
            account_name: "Leasebreak Main",
            account_external_id: "lb-main",
            is_active: true,
            send_mode: "auto_send",
            integration_mode: "rpa",
            last_successful_ingest_at: "2026-02-06T10:10:00.000Z",
            last_successful_send_at: "2026-02-06T10:12:00.000Z",
            error_count_24h: "0",
            last_error_at: null,
            disable_reason: null
          }
        ]
      };
    }
  };

  const items = await __testables.fetchPlatformHealthSnapshot(fakeClient);

  assert.match(capturedSql, /pa\.is_active/);
  assert.match(capturedSql, /pa\.send_mode/);
  assert.match(capturedSql, /pa\.integration_mode/);
  assert.match(capturedSql, /error_count_24h/);
  assert.equal(items.length, 1);
  assert.equal(items[0].isActive, true);
  assert.equal(items[0].sendMode, "auto_send");
  assert.equal(items[0].integrationMode, "rpa");
  assert.equal(items[0].health, "healthy");
  assert.deepEqual(items[0].error, { count24h: 0, lastErrorAt: null });
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

test("R15: GET /api/inbox?status=hold surfaces human_required agent-action work", async () => {
  const req = createRequest("GET", "/api/inbox?status=hold");
  const res = createResponseCapture();

  const fakeClient = {
    query: async (sql) => {
      if (sql.includes("FROM \"Conversations\" c") && sql.includes("COALESCE(counts.hold_count")) {
        return {
          rowCount: 2,
          rows: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              platform_account_id: "22222222-2222-4222-8222-222222222222",
              listing_id: null,
              assigned_agent_id: "33333333-3333-4333-8333-333333333333",
              external_thread_id: "thread-hold",
              lead_name: "Hold Queue Lead",
              lead_contact: { email: "hold@example.com" },
              conversation_status: "open",
              workflow_state: "lead",
              workflow_outcome: "human_required",
              showing_state: null,
              follow_up_stage: null,
              follow_up_due_at: null,
              follow_up_owner_agent_id: null,
              follow_up_status: null,
              workflow_updated_at: "2026-02-06T00:00:00.000Z",
              last_message_at: "2026-02-06T00:00:00.000Z",
              updated_at: "2026-02-06T00:00:00.000Z",
              property_name: "Atlas Apartments",
              unit_number: "4B",
              latest_body: "Can you explain next steps?",
              latest_direction: "inbound",
              latest_metadata: { reviewStatus: "hold", actionQueue: "agent_action" },
              new_count: 0,
              draft_count: 0,
              hold_count: 1,
              sent_count: 0
            },
            {
              id: "44444444-4444-4444-8444-444444444444",
              platform_account_id: "22222222-2222-4222-8222-222222222222",
              listing_id: null,
              assigned_agent_id: "33333333-3333-4333-8333-333333333333",
              external_thread_id: "thread-sent",
              lead_name: "Sent Lead",
              lead_contact: { email: "sent@example.com" },
              conversation_status: "open",
              workflow_state: "lead",
              workflow_outcome: "general_question",
              showing_state: null,
              follow_up_stage: null,
              follow_up_due_at: null,
              follow_up_owner_agent_id: null,
              follow_up_status: null,
              workflow_updated_at: "2026-02-06T00:00:00.000Z",
              last_message_at: "2026-02-06T00:00:00.000Z",
              updated_at: "2026-02-06T00:00:00.000Z",
              property_name: "Atlas Apartments",
              unit_number: "5A",
              latest_body: "Thanks!",
              latest_direction: "outbound",
              latest_metadata: { reviewStatus: "sent" },
              new_count: 0,
              draft_count: 0,
              hold_count: 0,
              sent_count: 1
            }
          ]
        };
      }
      return { rowCount: 0, rows: [] };
    }
  };

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "agent" } }),
    withClient: async (task) => task(fakeClient)
  });

  await routeApi(req, res, new URL(req.url, "http://localhost"));

  assert.equal(res.statusCode, 200);
  const payload = parseJsonBody(res);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].workflowOutcome, "human_required");
  assert.equal(payload.items[0].messageStatus, "hold");
  assert.equal(payload.items[0].counts.holdCount, 1);
  assert.equal(payload.items[0].latestStatus, "hold");
});

test("R17: inbox draft guardrail path forces draft and records audit policy details", async () => {
  const conversationId = "55555555-5555-4555-8555-555555555555";
  const req = createRequest("POST", `/api/inbox/${conversationId}/draft`, {
    body: "Please send legal details before we proceed.",
    metadata: {
      requiresAdminReview: true,
      guardrails: ["manual_review_required"],
      riskLevel: "critical"
    }
  });
  const res = createResponseCapture();

  let insertedMessageMetadata = null;
  let auditAction = null;
  let auditDetails = null;

  const fakeClient = {
    query: async (sql, params = []) => {
      if (sql.includes("FROM \"Conversations\" c") && sql.includes("WHERE c.id = $1::uuid")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: conversationId,
              platform_account_id: "66666666-6666-4666-8666-666666666666",
              listing_id: null,
              assigned_agent_id: "77777777-7777-4777-8777-777777777777",
              external_thread_id: "thread-guardrail",
              lead_name: "Guardrail Lead",
              lead_contact: { email: "guardrail@example.com" },
              status: "open",
              workflow_state: "lead",
              workflow_outcome: "human_required",
              showing_state: null,
              follow_up_stage: null,
              follow_up_due_at: null,
              follow_up_owner_agent_id: null,
              follow_up_status: null,
              workflow_updated_at: "2026-02-06T00:00:00.000Z",
              last_message_at: "2026-02-06T00:00:00.000Z",
              updated_at: "2026-02-06T00:00:00.000Z",
              property_name: null,
              unit_number: null,
              unit_id: null
            }
          ]
        };
      }
      if (sql.includes("FROM \"Messages\"") && sql.includes("WHERE conversation_id = $1::uuid")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("FROM \"Templates\"") && sql.includes("platform_account_id = $1::uuid")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("FROM \"PlatformAccounts\"") && sql.includes("WHERE id = $1::uuid")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "66666666-6666-4666-8666-666666666666",
              platform: "leasebreak",
              is_active: true,
              send_mode: "auto_send"
            }
          ]
        };
      }
      if (sql.includes("INSERT INTO \"Messages\"")) {
        insertedMessageMetadata = JSON.parse(params[4]);
        return {
          rowCount: 1,
          rows: [{ id: "88888888-8888-4888-8888-888888888888" }]
        };
      }
      if (sql.includes("UPDATE \"Conversations\"")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO \"AuditLogs\"")) {
        auditAction = params[4];
        auditDetails = JSON.parse(params[5]);
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }
  };

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "99999999-9999-4999-8999-999999999999", role: "agent" } }),
    withClient: async (task) => task(fakeClient)
  });

  await routeApi(req, res, new URL(req.url, "http://localhost"));

  assert.equal(res.statusCode, 201);
  const payload = parseJsonBody(res);
  assert.equal(payload.status, "draft");
  assert.equal(payload.requiresAdminReview, true);
  assert.deepEqual(payload.guardrailReviewReasons, ["explicit_admin_review", "guardrails_blocked", "risk_critical"]);
  assert.equal(insertedMessageMetadata.reviewStatus, "draft");
  assert.equal(insertedMessageMetadata.reviewRequired, true);
  assert.deepEqual(insertedMessageMetadata.guardrailReviewReasons, ["explicit_admin_review", "guardrails_blocked", "risk_critical"]);
  assert.equal(auditAction, "inbox_draft_saved");
  assert.equal(auditDetails.autoSendEnabled, true);
  assert.equal(auditDetails.reviewStatus, "draft");
  assert.equal(auditDetails.requiresAdminReview, true);
  assert.deepEqual(auditDetails.guardrailReviewReasons, ["explicit_admin_review", "guardrails_blocked", "risk_critical"]);
});

test("R23: agent inbox list is server-scoped to assigned/follow-up ownership", async () => {
  const req = createRequest("GET", "/api/inbox");
  const res = createResponseCapture();
  const sessionAgentId = "99999999-9999-4999-8999-999999999999";
  let scopedParams = null;

  const fakeClient = {
    query: async (sql, params = []) => {
      if (sql.includes("FROM \"Conversations\" c") && sql.includes("c.assigned_agent_id") && sql.includes("c.follow_up_owner_agent_id")) {
        scopedParams = params;
        return {
          rowCount: 1,
          rows: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              platform_account_id: "22222222-2222-4222-8222-222222222222",
              listing_id: null,
              assigned_agent_id: sessionAgentId,
              external_thread_id: "thread-1",
              lead_name: "Scoped Lead",
              lead_contact: { email: "scoped@example.com" },
              conversation_status: "open",
              workflow_state: "lead",
              workflow_outcome: "human_required",
              showing_state: null,
              follow_up_stage: null,
              follow_up_due_at: null,
              follow_up_owner_agent_id: sessionAgentId,
              follow_up_status: null,
              workflow_updated_at: "2026-02-06T00:00:00.000Z",
              last_message_at: "2026-02-06T00:00:00.000Z",
              updated_at: "2026-02-06T00:00:00.000Z",
              property_name: "Atlas Apartments",
              unit_number: "4B",
              latest_body: "Need help",
              latest_direction: "inbound",
              latest_metadata: { reviewStatus: "hold" },
              new_count: 0,
              draft_count: 0,
              hold_count: 1,
              sent_count: 0
            }
          ]
        };
      }
      return { rowCount: 0, rows: [] };
    }
  };

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: sessionAgentId, role: "agent" } }),
    withClient: async (task) => task(fakeClient)
  });

  await routeApi(req, res, new URL(req.url, "http://localhost"));

  assert.equal(res.statusCode, 200);
  const payload = parseJsonBody(res);
  assert.equal(payload.items.length, 1);
  assert.equal(scopedParams[0], sessionAgentId);
});

test("R23: agent cannot fetch out-of-scope inbox conversation detail", async () => {
  const req = createRequest("GET", "/api/inbox/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const res = createResponseCapture();
  const sessionAgentId = "99999999-9999-4999-8999-999999999999";

  const fakeClient = {
    query: async () => ({ rowCount: 0, rows: [] })
  };

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: sessionAgentId, role: "agent" } }),
    withClient: async (task) => task(fakeClient)
  });

  await routeApi(req, res, new URL(req.url, "http://localhost"));

  assert.equal(res.statusCode, 404);
  const payload = parseJsonBody(res);
  assert.equal(payload.error, "not_found");
});

test("R24: admin can view inbox detail outside agent scope", async () => {
  const conversationId = "12121212-1212-4121-8121-121212121212";
  const req = createRequest("GET", `/api/inbox/${conversationId}`);
  const res = createResponseCapture();
  let scopeQueryParams = null;

  const fakeClient = {
    query: async (sql, params = []) => {
      if (sql.includes("FROM \"Conversations\" c") && sql.includes("WHERE c.id = $1::uuid")) {
        scopeQueryParams = params;
        return {
          rowCount: 1,
          rows: [
            {
              id: conversationId,
              platform_account_id: "22222222-2222-4222-8222-222222222222",
              listing_id: null,
              assigned_agent_id: "33333333-3333-4333-8333-333333333333",
              external_thread_id: "thread-admin-visibility",
              lead_name: "Out of Scope Lead",
              lead_contact: { email: "lead@example.com" },
              status: "open",
              workflow_state: "lead",
              workflow_outcome: "human_required",
              showing_state: null,
              follow_up_stage: null,
              follow_up_due_at: null,
              follow_up_owner_agent_id: null,
              follow_up_status: null,
              workflow_updated_at: "2026-02-06T00:00:00.000Z",
              last_message_at: "2026-02-06T00:00:00.000Z",
              updated_at: "2026-02-06T00:00:00.000Z",
              property_name: "Atlas Apartments",
              unit_number: "4B",
              unit_id: null
            }
          ]
        };
      }
      if (sql.includes("FROM \"Messages\"") && sql.includes("WHERE conversation_id = $1::uuid")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("FROM \"Templates\"") && sql.includes("platform_account_id = $1::uuid")) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }
  };

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "u-admin", role: "admin" } }),
    withClient: async (task) => task(fakeClient)
  });

  await routeApi(req, res, new URL(req.url, "http://localhost"));

  assert.equal(res.statusCode, 200);
  const payload = parseJsonBody(res);
  assert.equal(payload.conversation.id, conversationId);
  assert.equal(payload.conversation.assignedAgentId, "33333333-3333-4333-8333-333333333333");
  assert.equal(scopeQueryParams.length, 1);
});

test("R24: admin can manage workflow beyond assignment while agent remains restricted", async () => {
  const conversationId = "34343434-3434-4434-8434-343434343434";
  let updateCalled = false;
  let updateParams = null;
  let auditAction = null;

  const fakeClient = {
    query: async (sql, params = []) => {
      if (sql.includes("FROM \"Conversations\"") && sql.includes("WHERE id = $1::uuid") && sql.includes("workflow_state")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: conversationId,
              assigned_agent_id: "55555555-5555-4555-8555-555555555555",
              workflow_state: "showing",
              workflow_outcome: null,
              showing_state: "confirmed",
              follow_up_stage: null,
              follow_up_due_at: null,
              follow_up_owner_agent_id: null,
              follow_up_status: null,
              workflow_updated_at: "2026-02-06T00:00:00.000Z",
              updated_at: "2026-02-06T00:00:00.000Z"
            }
          ]
        };
      }
      if (sql.includes("UPDATE \"Conversations\"")) {
        updateCalled = true;
        updateParams = params;
        return {
          rowCount: 1,
          rows: [
            {
              id: conversationId,
              assigned_agent_id: "55555555-5555-4555-8555-555555555555",
              workflow_state: params[1],
              workflow_outcome: params[2],
              showing_state: params[3],
              follow_up_stage: params[4],
              follow_up_due_at: params[5],
              follow_up_owner_agent_id: params[6],
              follow_up_status: params[7],
              workflow_updated_at: "2026-02-06T00:10:00.000Z",
              updated_at: "2026-02-06T00:10:00.000Z"
            }
          ]
        };
      }
      if (sql.includes("INSERT INTO \"AuditLogs\"")) {
        auditAction = params[4];
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }
  };

  const payload = { workflowOutcome: "wants_reschedule", showingState: "reschedule_requested" };

  const agentReq = createRequest("POST", `/api/conversations/${conversationId}/workflow-state`, payload);
  const agentRes = createResponseCapture();
  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "99999999-9999-4999-8999-999999999999", role: "agent" } }),
    withClient: async (task) => task(fakeClient)
  });

  await routeApi(agentReq, agentRes, new URL(agentReq.url, "http://localhost"));
  assert.equal(agentRes.statusCode, 403);
  assert.equal(updateCalled, false);

  const adminReq = createRequest("POST", `/api/conversations/${conversationId}/workflow-state`, payload);
  const adminRes = createResponseCapture();
  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "u-admin", role: "admin" } }),
    withClient: async (task) => task(fakeClient)
  });

  await routeApi(adminReq, adminRes, new URL(adminReq.url, "http://localhost"));

  assert.equal(adminRes.statusCode, 200);
  const adminPayload = parseJsonBody(adminRes);
  assert.equal(updateCalled, true);
  assert.equal(updateParams[1], "outcome");
  assert.equal(updateParams[2], "wants_reschedule");
  assert.equal(updateParams[3], "reschedule_requested");
  assert.equal(adminPayload.item.workflowState, "outcome");
  assert.equal(adminPayload.item.workflowOutcome, "wants_reschedule");
  assert.equal(adminPayload.item.showingState, "reschedule_requested");
  assert.equal(auditAction, "workflow_state_transitioned");
});

test("R27: workflow-state route rejects invalid showing regression after terminal state", async () => {
  const conversationId = "56565656-5656-4565-8565-565656565656";

  const fakeClient = {
    query: async (sql) => {
      if (sql.includes("FROM \"Conversations\"") && sql.includes("WHERE id = $1::uuid") && sql.includes("workflow_state")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: conversationId,
              assigned_agent_id: "99999999-9999-4999-8999-999999999999",
              workflow_state: "showing",
              workflow_outcome: null,
              showing_state: "completed",
              follow_up_stage: null,
              follow_up_due_at: null,
              follow_up_owner_agent_id: null,
              follow_up_status: null,
              workflow_updated_at: "2026-02-06T00:00:00.000Z",
              updated_at: "2026-02-06T00:00:00.000Z"
            }
          ]
        };
      }
      throw new Error("update must not run for invalid transition");
    }
  };

  const req = createRequest("POST", `/api/conversations/${conversationId}/workflow-state`, {
    showingState: "pending"
  });
  const res = createResponseCapture();

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "99999999-9999-4999-8999-999999999999", role: "agent" } }),
    withClient: async (task) => task(fakeClient)
  });

  await routeApi(req, res, new URL(req.url, "http://localhost"));

  assert.equal(res.statusCode, 409);
  const payload = parseJsonBody(res);
  assert.equal(payload.error, "invalid_transition");
  assert.match(payload.message, /Invalid showingState transition from completed to pending/);
});

test("R16: manual inbox reply dispatches to platform thread and logs audit", async () => {
  process.env.LEASEBREAK_API_KEY = process.env.LEASEBREAK_API_KEY || "test-key";
  const conversationId = "55555555-5555-4555-8555-555555555555";
  const req = createRequest("POST", `/api/inbox/${conversationId}/draft`, {
    body: "Great, confirming your showing now.",
    dispatchNow: true
  });
  const res = createResponseCapture();
  let insertedExternalMessageId = null;
  let auditAction = null;
  let auditDetails = null;
  let dispatchPayload = null;

  const fakeClient = {
    query: async (sql, params = []) => {
      if (sql.includes("FROM \"Conversations\" c") && sql.includes("WHERE c.id = $1::uuid")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: conversationId,
              platform_account_id: "66666666-6666-4666-8666-666666666666",
              listing_id: null,
              assigned_agent_id: "77777777-7777-4777-8777-777777777777",
              external_thread_id: "thread-manual-dispatch",
              lead_name: "Manual Dispatch Lead",
              lead_contact: { email: "manual@example.com" },
              status: "open",
              workflow_state: "lead",
              workflow_outcome: "human_required",
              showing_state: null,
              follow_up_stage: null,
              follow_up_due_at: null,
              follow_up_owner_agent_id: null,
              follow_up_status: null,
              workflow_updated_at: "2026-02-06T00:00:00.000Z",
              last_message_at: "2026-02-06T00:00:00.000Z",
              updated_at: "2026-02-06T00:00:00.000Z",
              property_name: null,
              unit_number: null,
              unit_id: null
            }
          ]
        };
      }
      if (sql.includes("FROM \"Messages\"") && sql.includes("WHERE conversation_id = $1::uuid")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("FROM \"Templates\"") && sql.includes("platform_account_id = $1::uuid")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("SELECT id, platform, credentials") && sql.includes("FROM \"PlatformAccounts\"")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "66666666-6666-4666-8666-666666666666",
              platform: "leasebreak",
              credentials: { apiKeyRef: "env:LEASEBREAK_API_KEY" },
              is_active: true,
              send_mode: "draft_only"
            }
          ]
        };
      }
      if (sql.includes("INSERT INTO \"Messages\"")) {
        insertedExternalMessageId = params[2];
        return {
          rowCount: 1,
          rows: [{ id: "88888888-8888-4888-8888-888888888888" }]
        };
      }
      if (sql.includes("UPDATE \"Conversations\"")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO \"AuditLogs\"")) {
        auditAction = params[4];
        auditDetails = JSON.parse(params[5]);
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }
  };

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "99999999-9999-4999-8999-999999999999", role: "agent" } }),
    withClient: async (task) => task(fakeClient),
    dispatchOutboundMessage: async (payload) => {
      dispatchPayload = payload;
      return {
        externalMessageId: "platform-msg-1",
        channel: "in_app",
        providerStatus: "sent"
      };
    }
  });

  await routeApi(req, res, new URL(req.url, "http://localhost"));

  assert.equal(res.statusCode, 201);
  const payload = parseJsonBody(res);
  assert.equal(payload.status, "sent");
  assert.equal(payload.dispatched, true);
  assert.equal(dispatchPayload.externalThreadId, "thread-manual-dispatch");
  assert.equal(insertedExternalMessageId, "platform-msg-1");
  assert.equal(auditAction, "inbox_manual_reply_dispatched");
  assert.equal(auditDetails.externalThreadId, "thread-manual-dispatch");
});
