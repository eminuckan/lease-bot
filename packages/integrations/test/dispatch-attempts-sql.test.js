import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createTestPool } from "../../../apps/api/test/helpers/test-db.js";
import { createPostgresQueueAdapter } from "../src/index.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/lease_bot_test";

let pool;

async function insertFixture() {
  const suffix = randomUUID().slice(0, 8);
  const ids = {
    platformAccountId: randomUUID(),
    conversationId: randomUUID(),
    messageId: randomUUID(),
    accountExternalId: `acct-${suffix}`,
    externalThreadId: `thread-${suffix}`,
    externalMessageId: `msg-${suffix}`
  };

  await pool.query(
    `INSERT INTO "PlatformAccounts" (id, platform, account_name, account_external_id, credentials, integration_mode)
     VALUES ($1::uuid, 'spareroom', 'Dispatch SQL Test', $2, '{}'::jsonb, 'rpa')`,
    [ids.platformAccountId, ids.accountExternalId]
  );

  await pool.query(
    `INSERT INTO "Conversations" (id, platform_account_id, external_thread_id)
     VALUES ($1::uuid, $2::uuid, $3)`,
    [ids.conversationId, ids.platformAccountId, ids.externalThreadId]
  );

  await pool.query(
    `INSERT INTO "Messages" (id, conversation_id, sender_type, direction, body, external_message_id)
     VALUES ($1::uuid, $2::uuid, 'lead', 'inbound', 'Hello', $3)`,
    [ids.messageId, ids.conversationId, ids.externalMessageId]
  );

  return ids;
}

async function cleanupFixture(ids) {
  await pool.query(`DELETE FROM "PlatformAccounts" WHERE id = $1::uuid`, [ids.platformAccountId]);
}

test.before(async () => {
  pool = await createTestPool(process.env.DATABASE_URL);
});

test.after(async () => {
  await pool?.end?.();
});

test("dispatch attempt metadata updates bind parameter types explicitly (no 42P08)", async () => {
  const ids = await insertFixture();
  const adapter = createPostgresQueueAdapter(pool);
  const now = new Date().toISOString();
  const dispatchKey = `dispatch-${randomUUID().slice(0, 8)}`;

  try {
    const attempt = await adapter.beginDispatchAttempt({
      messageId: ids.messageId,
      dispatchKey,
      platform: "spareroom",
      stage: "send",
      now
    });
    assert.equal(attempt.shouldDispatch, true);

    await adapter.completeDispatchAttempt({
      messageId: ids.messageId,
      dispatchKey,
      status: "queued",
      delivery: { externalMessageId: "out-1" },
      now
    });

    await adapter.failDispatchAttempt({
      messageId: ids.messageId,
      stage: "send",
      error: "boom",
      now,
      retry: { retryExhausted: false, failureCount: 1 }
    });
  } finally {
    await cleanupFixture(ids);
  }
});

