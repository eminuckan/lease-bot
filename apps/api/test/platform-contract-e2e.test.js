import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/lease_bot_test";
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-value";

const {
  routeApi,
  setRouteTestOverrides,
  resetRouteTestOverrides
} = await import("../src/server.js");

const REQUIRED_PLATFORMS = ["spareroom", "roomies", "leasebreak", "renthop", "furnishedfinder"];

function createRequest(method, pathnameWithQuery) {
  return {
    method,
    url: pathnameWithQuery,
    headers: {
      host: "localhost"
    },
    async *[Symbol.asyncIterator]() {
      // No body.
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

function buildPolicy(platform, index) {
  return {
    id: `${index}`.padStart(8, "0") + "-1111-4111-8111-111111111111",
    platform,
    accountName: `${platform}-main`,
    accountExternalId: `${platform}-main`,
    isActive: true,
    integrationMode: "rpa",
    sendMode: "draft_only",
    sendModeOverride: null,
    globalDefaultSendMode: "draft_only",
    credentials: {},
    createdAt: "2026-02-06T00:00:00.000Z",
    updatedAt: "2026-02-06T00:00:00.000Z"
  };
}

test("R13 contract: platform policy endpoint reports all five required platforms", async () => {
  const req = createRequest("GET", "/api/admin/platform-policies");
  const res = createResponseCapture();
  const policyItems = REQUIRED_PLATFORMS.map((platform, index) => buildPolicy(platform, index + 1));

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "u-admin", role: "admin" } }),
    withClient: async (task) => task({ id: "fake" }),
    fetchPlatformPolicies: async () => policyItems
  });

  await routeApi(req, res, new URL(req.url, "http://localhost"));

  assert.equal(res.statusCode, 200);
  const payload = parseJsonBody(res);
  assert.deepEqual(payload.requiredPlatforms, REQUIRED_PLATFORMS);
  assert.deepEqual(payload.missingPlatforms, []);
  assert.equal(payload.items.length, 5);
  assert.deepEqual(payload.items.map((item) => item.platform).sort(), [...REQUIRED_PLATFORMS].sort());
  assert.equal(payload.items.every((item) => item.integrationMode === "rpa"), true);
});

test("R13 contract: missingPlatforms lists required platforms absent from account policies", async () => {
  const req = createRequest("GET", "/api/admin/platform-policies");
  const res = createResponseCapture();
  const enabledPlatforms = ["spareroom", "roomies", "leasebreak"];
  const policyItems = enabledPlatforms.map((platform, index) => buildPolicy(platform, index + 1));

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "u-admin", role: "admin" } }),
    withClient: async (task) => task({ id: "fake" }),
    fetchPlatformPolicies: async () => policyItems
  });

  await routeApi(req, res, new URL(req.url, "http://localhost"));

  assert.equal(res.statusCode, 200);
  const payload = parseJsonBody(res);
  assert.deepEqual(payload.missingPlatforms, ["renthop", "furnishedfinder"]);
});
