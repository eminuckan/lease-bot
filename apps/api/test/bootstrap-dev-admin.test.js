import test from "node:test";
import assert from "node:assert/strict";

import { ensureDevAdminUser } from "../src/bootstrap-dev-admin.js";

function createMockPool(responses) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const next = responses.shift();
      if (!next) {
        throw new Error("Unexpected query call");
      }
      return next;
    }
  };
}

function createMockLogger() {
  const calls = [];
  return {
    calls,
    log(...args) {
      calls.push({ level: "log", args });
    },
    warn(...args) {
      calls.push({ level: "warn", args });
    }
  };
}

test("ensureDevAdminUser is a no-op when disabled", async () => {
  const pool = createMockPool([]);
  const logger = createMockLogger();
  const auth = { api: { signUpEmail: async () => {} } };

  await ensureDevAdminUser(pool, auth, {
    env: { NODE_ENV: "development", LEASE_BOT_DEV_BOOTSTRAP_ADMIN: "0" },
    logger
  });

  assert.equal(pool.calls.length, 0);
  assert.equal(logger.calls.length, 0);
});

test("ensureDevAdminUser creates then promotes the dev admin when missing", async () => {
  const pool = createMockPool([
    { rows: [] },
    { rowCount: 1 }
  ]);
  const logger = createMockLogger();
  const signUpCalls = [];
  const auth = {
    api: {
      async signUpEmail(payload) {
        signUpCalls.push(payload);
      }
    }
  };

  await ensureDevAdminUser(pool, auth, {
    env: {
      NODE_ENV: "development",
      LEASE_BOT_DEV_BOOTSTRAP_ADMIN: "1",
      LEASE_BOT_DEV_ADMIN_EMAIL: "admin@leasebot.com",
      LEASE_BOT_DEV_ADMIN_PASSWORD: "dev-password",
      LEASE_BOT_DEV_ADMIN_NAME: "Lease Bot Admin"
    },
    logger
  });

  assert.equal(signUpCalls.length, 1);
  assert.equal(signUpCalls[0].body.email, "admin@leasebot.com");
  assert.equal(signUpCalls[0].body.password, "dev-password");
  assert.equal(signUpCalls[0].body.name, "Lease Bot Admin");

  assert.equal(pool.calls.length, 2);
  assert.match(pool.calls[0].sql, /SELECT id, role FROM \"user\"/);
  assert.match(pool.calls[1].sql, /UPDATE \"user\" SET role/);
});

test("ensureDevAdminUser only promotes when the dev admin already exists", async () => {
  const pool = createMockPool([
    { rows: [{ id: "user-1", role: "agent" }] },
    { rowCount: 1 }
  ]);
  const logger = createMockLogger();
  let signUpCalled = false;
  const auth = {
    api: {
      async signUpEmail() {
        signUpCalled = true;
      }
    }
  };

  await ensureDevAdminUser(pool, auth, {
    env: {
      NODE_ENV: "development",
      LEASE_BOT_DEV_BOOTSTRAP_ADMIN: "1",
      LEASE_BOT_DEV_ADMIN_EMAIL: "admin@leasebot.com",
      LEASE_BOT_DEV_ADMIN_PASSWORD: "dev-password",
      LEASE_BOT_DEV_ADMIN_NAME: "Lease Bot Admin"
    },
    logger
  });

  assert.equal(signUpCalled, false);
  assert.equal(pool.calls.length, 2);
  assert.match(pool.calls[0].sql, /SELECT id, role FROM \"user\"/);
  assert.match(pool.calls[1].sql, /UPDATE \"user\" SET role/);
});

