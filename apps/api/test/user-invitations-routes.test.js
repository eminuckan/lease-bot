import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/lease_bot_test";
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-value";
process.env.INVITE_BASE_URL = "http://localhost:5173";

const {
  routeApi,
  setRouteTestOverrides,
  resetRouteTestOverrides
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

function createFakeDb() {
  const now = new Date().toISOString();
  const state = {
    users: [],
    invitations: [],
    auditCount: 0
  };

  const client = {
    async query(sql, params = []) {
      if (sql.includes("SELECT id") && sql.includes('FROM "user"') && sql.includes("LOWER(email)")) {
        const email = String(params[0] || "").toLowerCase();
        const found = state.users.find((item) => item.email.toLowerCase() === email);
        return {
          rowCount: found ? 1 : 0,
          rows: found ? [{ id: found.id }] : []
        };
      }

      if (sql.includes("UPDATE \"UserInvitations\"") && sql.includes("LOWER(email) = LOWER($1)")) {
        const email = String(params[0] || "").toLowerCase();
        for (const invite of state.invitations) {
          if (invite.email.toLowerCase() === email && !invite.accepted_at && !invite.revoked_at) {
            invite.revoked_at = now;
            invite.updated_at = now;
          }
        }
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("INSERT INTO \"UserInvitations\"")) {
        const [id, email, firstName, lastName, role, tokenHash, invitedBy, expiresAt] = params;
        const row = {
          id,
          email,
          first_name: firstName,
          last_name: lastName,
          role,
          token_hash: tokenHash,
          invited_by: invitedBy,
          expires_at: expiresAt,
          accepted_at: null,
          revoked_at: null,
          created_at: now,
          updated_at: now
        };
        state.invitations.push(row);
        return { rowCount: 1, rows: [row] };
      }

      if (sql.includes('SELECT id,') && sql.includes('FROM "UserInvitations"') && sql.includes("WHERE token_hash = $1")) {
        const tokenHash = params[0];
        const found = state.invitations.find((item) => item.token_hash === tokenHash);
        return { rowCount: found ? 1 : 0, rows: found ? [found] : [] };
      }

      if (sql.includes("UPDATE \"user\"") && sql.includes("SET role = $2")) {
        const [email, role, name] = params;
        const found = state.users.find((item) => item.email.toLowerCase() === String(email).toLowerCase());
        if (found) {
          found.role = role;
          found.name = name;
          found.updated_at = now;
        }
        return { rowCount: found ? 1 : 0, rows: [] };
      }

      if (sql.includes("UPDATE \"UserInvitations\"") && sql.includes("SET accepted_at = NOW()")) {
        const inviteId = params[0];
        const found = state.invitations.find((item) => item.id === inviteId && !item.accepted_at && !item.revoked_at);
        if (found) {
          found.accepted_at = now;
          found.updated_at = now;
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes("UPDATE \"UserInvitations\"") && sql.includes("SET revoked_at = NOW()") && sql.includes("WHERE id = $1::uuid")) {
        const inviteId = params[0];
        const found = state.invitations.find((item) => item.id === inviteId && !item.accepted_at && !item.revoked_at);
        if (found) {
          found.revoked_at = now;
          found.updated_at = now;
          return { rowCount: 1, rows: [{ id: found.id }] };
        }
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes('SELECT id,') && sql.includes('FROM "user"') && sql.includes('ORDER BY "createdAt" DESC')) {
        return {
          rowCount: state.users.length,
          rows: state.users.map((item) => ({
            id: item.id,
            email: item.email,
            name: item.name,
            role: item.role,
            created_at: item.created_at,
            updated_at: item.updated_at
          }))
        };
      }

      if (sql.includes('SELECT id,') && sql.includes('FROM "UserInvitations"') && sql.includes("ORDER BY created_at DESC")) {
        return {
          rowCount: state.invitations.length,
          rows: state.invitations.slice().reverse()
        };
      }

      if (sql.includes('INSERT INTO "AuditLogs"')) {
        state.auditCount += 1;
        return { rowCount: 1, rows: [] };
      }

      return { rowCount: 0, rows: [] };
    }
  };

  return { state, client };
}

test("invitation flow: create, verify, accept, list", async () => {
  const { state, client } = createFakeDb();
  let inviteUrl = "";

  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: "admin-1", role: "admin", email: "admin@leasebot.com", name: "Admin User" } }),
    withClient: async (task) => task(client),
    sendInvitationEmail: async ({ inviteUrl: nextInviteUrl }) => {
      inviteUrl = nextInviteUrl;
      return { delivery: "logged", messageId: null, previewUrl: nextInviteUrl };
    },
    signUpEmail: async ({ body }) => {
      const exists = state.users.find((item) => item.email.toLowerCase() === String(body.email).toLowerCase());
      if (exists) {
        throw new Error("user already exists");
      }
      state.users.push({
        id: randomUUID(),
        email: body.email,
        name: body.name,
        role: "agent",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    }
  });

  const createReq = createRequest("POST", "/api/admin/users/invitations", {
    email: "agent.new@example.com",
    firstName: "New",
    lastName: "Agent",
    role: "agent"
  });
  const createRes = createResponseCapture();
  await routeApi(createReq, createRes, new URL(createReq.url, "http://localhost"));

  assert.equal(createRes.statusCode, 201);
  const createdPayload = parseJsonBody(createRes);
  assert.equal(createdPayload.invitation.email, "agent.new@example.com");
  assert.equal(createdPayload.invitation.status, "pending");
  assert.equal(typeof inviteUrl, "string");
  assert.equal(inviteUrl.includes("/invite?token="), true);

  const token = new URL(inviteUrl).searchParams.get("token");
  assert.ok(token);

  const verifyReq = createRequest("GET", `/api/invitations/verify?token=${encodeURIComponent(token)}`);
  const verifyRes = createResponseCapture();
  await routeApi(verifyReq, verifyRes, new URL(verifyReq.url, "http://localhost"));

  assert.equal(verifyRes.statusCode, 200);
  const verifyPayload = parseJsonBody(verifyRes);
  assert.equal(verifyPayload.valid, true);
  assert.equal(verifyPayload.invitation.email, "agent.new@example.com");

  const acceptReq = createRequest("POST", "/api/invitations/accept", {
    token,
    password: "StrongPass123!"
  });
  const acceptRes = createResponseCapture();
  await routeApi(acceptReq, acceptRes, new URL(acceptReq.url, "http://localhost"));

  assert.equal(acceptRes.statusCode, 200);
  const acceptPayload = parseJsonBody(acceptRes);
  assert.equal(acceptPayload.accepted, true);
  assert.equal(acceptPayload.email, "agent.new@example.com");

  const listReq = createRequest("GET", "/api/admin/users");
  const listRes = createResponseCapture();
  await routeApi(listReq, listRes, new URL(listReq.url, "http://localhost"));

  assert.equal(listRes.statusCode, 200);
  const listPayload = parseJsonBody(listRes);
  assert.equal(Array.isArray(listPayload.users), true);
  assert.equal(Array.isArray(listPayload.invitations), true);
  assert.equal(listPayload.users.some((item) => item.email === "agent.new@example.com"), true);
  assert.equal(listPayload.invitations.some((item) => item.email === "agent.new@example.com" && item.status === "accepted"), true);
});

