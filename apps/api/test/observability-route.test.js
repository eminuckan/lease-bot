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

test("/api/admin/observability enforces auth guard behavior", async () => {
  const unauthorizedReq = createGetRequest("/api/admin/observability");
  const unauthorizedRes = createResponseCapture();

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => null
  });

  await routeApi(unauthorizedReq, unauthorizedRes, new URL(unauthorizedReq.url, "http://localhost"));
  assert.equal(unauthorizedRes.statusCode, 401);
  assert.deepEqual(parseJsonBody(unauthorizedRes), { error: "unauthorized" });

  const forbiddenReq = createGetRequest("/api/admin/observability");
  const forbiddenRes = createResponseCapture();

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "u1", role: "agent" } })
  });

  await routeApi(forbiddenReq, forbiddenRes, new URL(forbiddenReq.url, "http://localhost"));
  assert.equal(forbiddenRes.statusCode, 403);
  const forbiddenBody = parseJsonBody(forbiddenRes);
  assert.equal(forbiddenBody.error, "forbidden");
  assert.equal(forbiddenBody.currentRole, "agent");
});

test("/api/admin/observability clamps and handles query params", async () => {
  const req = createGetRequest("/api/admin/observability?windowHours=0&auditLimit=999&errorLimit=bad");
  const res = createResponseCapture();
  let snapshotArgs = null;

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "u1", role: "admin" } }),
    withClient: async (task) => task({ clientName: "test-client" }),
    fetchObservabilitySnapshot: async (_client, options) => {
      snapshotArgs = options;
      return {
        windowHours: options.windowHours,
        coreMetrics: {},
        recentErrors: [],
        recentAudit: []
      };
    }
  });

  await routeApi(req, res, new URL(req.url, "http://localhost"));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(snapshotArgs, {
    windowHours: 1,
    auditLimit: 200,
    errorLimit: 25
  });
  assert.equal(parseJsonBody(res).windowHours, 1);
});

test("/api/admin/observability returns snapshot payload from route wiring", async () => {
  const req = createGetRequest("/api/admin/observability?windowHours=48&auditLimit=3&errorLimit=2");
  const res = createResponseCapture();
  const fakeClient = { id: "client-1" };
  let clientReceived = null;

  const expectedSnapshot = {
    windowHours: 48,
    coreMetrics: {
      inboundMessages: 10,
      outboundMessages: 9,
      outboundSent: 7,
      outboundDraft: 1,
      outboundHold: 1,
      outboundPendingReview: 2,
      aiDecisions: 6,
      aiRepliesCreated: 4,
      aiRepliesSkipped: 1,
      aiReplyErrors: 1,
      adminReviewDecisions: 3,
      auditEvents: 22
    },
    recentErrors: [{ id: "err-1" }],
    recentAudit: [{ id: "aud-1" }]
  };

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "u1", role: "admin" } }),
    withClient: async (task) => task(fakeClient),
    fetchObservabilitySnapshot: async (client) => {
      clientReceived = client;
      return expectedSnapshot;
    }
  });

  await routeApi(req, res, new URL(req.url, "http://localhost"));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(clientReceived, fakeClient);
  assert.deepEqual(parseJsonBody(res), expectedSnapshot);
});
