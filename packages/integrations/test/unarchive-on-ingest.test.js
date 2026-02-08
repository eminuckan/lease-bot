import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createTestPool } from "../../../apps/api/test/helpers/test-db.js";
import { createPostgresQueueAdapter } from "../src/index.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/lease_bot_test";

// Ensure dev-only archiving logic doesn't interfere with this test.
delete process.env.LEASE_BOT_DEV_ARCHIVE_MISSING_THREADS;

let pool;

async function insertFixture() {
  const suffix = randomUUID().slice(0, 8);
  const ids = {
    platformAccountId: randomUUID(),
    conversationId: randomUUID(),
    accountExternalId: `acct-${suffix}`,
    externalThreadId: `thread-${suffix}`
  };

  await pool.query(
    `INSERT INTO "PlatformAccounts" (id, platform, account_name, account_external_id, credentials, integration_mode)
     VALUES ($1::uuid, 'spareroom', 'Unarchive Test Account', $2, '{}'::jsonb, 'rpa')`,
    [ids.platformAccountId, ids.accountExternalId]
  );

  await pool.query(
    `INSERT INTO "Conversations" (id, platform_account_id, external_thread_id, lead_name, status)
     VALUES ($1::uuid, $2::uuid, $3, 'Emin Uckan', 'archived')`,
    [ids.conversationId, ids.platformAccountId, ids.externalThreadId]
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

test("ingest re-opens archived conversations when the thread appears again", async () => {
  const ids = await insertFixture();

  const adapter = createPostgresQueueAdapter(pool, {
    connectorRegistry: {
      async ingestMessagesForAccount(account) {
        if (account.id !== ids.platformAccountId) {
          return [];
        }
        return [
          {
            externalThreadId: ids.externalThreadId,
            externalMessageId: `msg-${randomUUID().slice(0, 8)}`,
            channel: "in_app",
            body: "Hi, is this still available?",
            sentAt: "2026-02-08T20:00:00.000Z",
            leadName: "Emin Uckan",
            metadata: {}
          }
        ];
      }
    }
  });

  try {
    const result = await adapter.ingestInboundMessages({ limit: 10, platforms: ["spareroom"] });
    assert.equal(result.scanned, 1);

    const statusResult = await pool.query(
      `SELECT status
         FROM "Conversations"
        WHERE id = $1::uuid`,
      [ids.conversationId]
    );
    assert.equal(statusResult.rows[0]?.status, "open");
  } finally {
    await cleanupFixture(ids);
  }
});

