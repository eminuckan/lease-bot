import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Pool } from "pg";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/lease_bot_test";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function ensureWorkflowMigration006() {
  const hasWorkflowState = await pool.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'Conversations'
        AND column_name = 'workflow_state'`
  );

  if (hasWorkflowState.rowCount > 0) {
    return;
  }

  const migration = await readFile(new URL("../../../packages/db/migrations/006_workflow_domain_state_model.sql", import.meta.url), "utf8");
  await pool.query(migration);
}

function buildFixtureIds() {
  const suffix = randomUUID().slice(0, 8);
  return {
    platformAccountId: randomUUID(),
    agentId: randomUUID(),
    conversationId: randomUUID(),
    accountExternalId: `acct-${suffix}`,
    externalThreadId: `thread-${suffix}`
  };
}

async function insertWorkflowFixture({
  workflowState = "lead",
  workflowOutcome = null,
  showingState = null,
  followUpStage = null,
  followUpDueAt = null,
  followUpStatus = "pending"
} = {}) {
  const ids = buildFixtureIds();

  await pool.query(
    `INSERT INTO "PlatformAccounts" (id, platform, account_name, account_external_id, credentials, integration_mode)
     VALUES ($1::uuid, 'spareroom', 'Workflow Test Account', $2, '{}'::jsonb, 'rpa')`,
    [ids.platformAccountId, ids.accountExternalId]
  );

  await pool.query(
    `INSERT INTO "Agents" (id, platform_account_id, full_name, timezone)
     VALUES ($1::uuid, $2::uuid, 'Workflow Test Agent', 'UTC')`,
    [ids.agentId, ids.platformAccountId]
  );

  const effectiveFollowUpDueAt = followUpStage ? (followUpDueAt || "2026-04-10T09:00:00.000Z") : null;
  const effectiveFollowUpOwnerAgentId = followUpStage ? ids.agentId : null;

  await pool.query(
    `INSERT INTO "Conversations" (
      id,
      platform_account_id,
      assigned_agent_id,
      external_thread_id,
      lead_name,
      lead_contact,
      workflow_state,
      workflow_outcome,
      showing_state,
      follow_up_stage,
      follow_up_due_at,
      follow_up_owner_agent_id,
      follow_up_status
    ) VALUES (
      $1::uuid,
      $2::uuid,
      $3::uuid,
      $4,
      'Workflow Test Lead',
      '{"email":"lead@example.com"}'::jsonb,
      $5,
      $6,
      $7,
      $8,
      $9::timestamptz,
      $10::uuid,
      $11
    )`,
    [
      ids.conversationId,
      ids.platformAccountId,
      ids.agentId,
      ids.externalThreadId,
      workflowState,
      workflowOutcome,
      showingState,
      followUpStage,
      effectiveFollowUpDueAt,
      effectiveFollowUpOwnerAgentId,
      followUpStatus
    ]
  );

  return ids;
}

async function cleanupFixture(ids) {
  await pool.query(`DELETE FROM "AuditLogs" WHERE entity_type = 'conversation' AND entity_id = $1`, [ids.conversationId]);
  await pool.query(`DELETE FROM "PlatformAccounts" WHERE id = $1::uuid`, [ids.platformAccountId]);
}

test.before(async () => {
  await ensureWorkflowMigration006();
});

test("R5/R7/R11/R12: migration 006 transition guards enforce runtime state semantics", async () => {
  const ids = await insertWorkflowFixture();

  try {
    await pool.query(
      `UPDATE "Conversations"
          SET workflow_state = 'showing',
              showing_state = 'confirmed',
              updated_at = NOW()
        WHERE id = $1::uuid`,
      [ids.conversationId]
    );

    await assert.rejects(
      pool.query(
        `UPDATE "Conversations"
            SET workflow_state = 'follow_up_2',
                updated_at = NOW()
          WHERE id = $1::uuid`,
        [ids.conversationId]
      ),
      (error) => {
        assert.equal(error.code, "22023");
        assert.match(error.message, /Invalid workflow_state transition from showing to follow_up_2/);
        return true;
      }
    );

    await assert.rejects(
      pool.query(
        `UPDATE "Conversations"
            SET showing_state = 'pending',
                updated_at = NOW()
          WHERE id = $1::uuid`,
        [ids.conversationId]
      ),
      (error) => {
        assert.equal(error.code, "22023");
        assert.match(error.message, /Invalid showing_state transition from confirmed to pending/);
        return true;
      }
    );
  } finally {
    await cleanupFixture(ids);
  }
});

test("R8: inbound message recovers no_reply outcome and writes recovery audit", async () => {
  const ids = await insertWorkflowFixture({ workflowState: "outcome", workflowOutcome: "no_reply" });

  try {
    await pool.query(
      `INSERT INTO "Messages" (id, conversation_id, sender_type, direction, body, external_message_id)
       VALUES ($1::uuid, $2::uuid, 'lead', 'outbound', 'outbound ping', $3)`,
      [randomUUID(), ids.conversationId, `msg-out-${randomUUID().slice(0, 8)}`]
    );

    const beforeInbound = await pool.query(
      `SELECT workflow_state, workflow_outcome
         FROM "Conversations"
        WHERE id = $1::uuid`,
      [ids.conversationId]
    );
    assert.equal(beforeInbound.rows[0].workflow_state, "outcome");
    assert.equal(beforeInbound.rows[0].workflow_outcome, "no_reply");

    const inboundMessageId = randomUUID();
    await pool.query(
      `INSERT INTO "Messages" (id, conversation_id, sender_type, direction, body, external_message_id)
       VALUES ($1::uuid, $2::uuid, 'lead', 'inbound', 'I am interested again', $3)`,
      [inboundMessageId, ids.conversationId, `msg-in-${randomUUID().slice(0, 8)}`]
    );

    const recovered = await pool.query(
      `SELECT workflow_state, workflow_outcome
         FROM "Conversations"
        WHERE id = $1::uuid`,
      [ids.conversationId]
    );
    assert.equal(recovered.rows[0].workflow_state, "lead");
    assert.equal(recovered.rows[0].workflow_outcome, null);

    const audit = await pool.query(
      `SELECT action,
              details->>'conversationId' AS conversation_id,
              details->>'messageId' AS message_id,
              details->>'trigger' AS trigger
         FROM "AuditLogs"
        WHERE entity_type = 'conversation'
          AND entity_id = $1
          AND action = 'workflow_no_reply_recovered'
        ORDER BY created_at DESC
        LIMIT 1`,
      [ids.conversationId]
    );

    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].action, "workflow_no_reply_recovered");
    assert.equal(audit.rows[0].conversation_id, ids.conversationId);
    assert.equal(audit.rows[0].message_id, inboundMessageId);
    assert.equal(audit.rows[0].trigger, "inbound_message");
  } finally {
    await cleanupFixture(ids);
  }
});

test.after(async () => {
  await pool.end();
});
