import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Pool } from "pg";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/lease_bot_test";
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-value";

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

const {
  routeApi,
  setRouteTestOverrides,
  resetRouteTestOverrides
} = await import("../src/server.js");

function createRequest(method, pathnameWithQuery, body = null) {
  const payload = body ? Buffer.from(JSON.stringify(body)) : null;
  return {
    method,
    url: pathnameWithQuery,
    headers: {
      host: "localhost",
      "content-type": "application/json"
    },
    async *[Symbol.asyncIterator]() {
      if (payload) {
        yield payload;
      }
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

async function callRoute(method, path, { role = "agent", sessionUserId = "22222222-2222-4222-8222-222222222222", body = null, overrides = {} } = {}) {
  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: sessionUserId, role } }),
    ...overrides
  });

  const req = createRequest(method, path, body);
  const res = createResponseCapture();
  await routeApi(req, res, new URL(req.url, "http://localhost"));
  return { res, json: parseJsonBody(res) };
}

async function insertWorkflowFixture({ workflowState = "lead", showingState = null, assignedAgentId = null } = {}) {
  const suffix = randomUUID().slice(0, 8);
  const ids = {
    platformAccountId: randomUUID(),
    agentId: assignedAgentId || randomUUID(),
    conversationId: randomUUID(),
    accountExternalId: `wf-acct-${suffix}`,
    externalThreadId: `wf-thread-${suffix}`
  };

  await pool.query(
    `INSERT INTO "PlatformAccounts" (id, platform, account_name, account_external_id, credentials, integration_mode)
     VALUES ($1::uuid, 'spareroom', 'Workflow Route Test Account', $2, '{}'::jsonb, 'rpa')`,
    [ids.platformAccountId, ids.accountExternalId]
  );

  await pool.query(
    `INSERT INTO "Agents" (id, platform_account_id, full_name, timezone)
     VALUES ($1::uuid, $2::uuid, 'Workflow Route Test Agent', 'UTC')`,
    [ids.agentId, ids.platformAccountId]
  );

  await pool.query(
    `INSERT INTO "Conversations" (
      id,
      platform_account_id,
      assigned_agent_id,
      external_thread_id,
      lead_name,
      lead_contact,
      workflow_state,
      showing_state
    ) VALUES (
      $1::uuid,
      $2::uuid,
      $3::uuid,
      $4,
      'Workflow Route Lead',
      '{"email":"lead@example.com"}'::jsonb,
      $5,
      $6
    )`,
    [ids.conversationId, ids.platformAccountId, ids.agentId, ids.externalThreadId, workflowState, showingState]
  );

  return ids;
}

async function insertInboundIdentityFixture() {
  const suffix = randomUUID().slice(0, 8);
  const ids = {
    platformAccountId: randomUUID(),
    agentId: randomUUID(),
    unitId: randomUUID(),
    listingId: randomUUID(),
    conversationId: randomUUID(),
    messageId: randomUUID(),
    accountExternalId: `id-acct-${suffix}`,
    externalThreadId: `id-thread-${suffix}`,
    externalMessageId: `id-msg-${suffix}`
  };

  await pool.query(
    `INSERT INTO "PlatformAccounts" (id, platform, account_name, account_external_id, credentials, integration_mode)
     VALUES ($1::uuid, 'spareroom', 'Identity Test Account', $2, '{}'::jsonb, 'rpa')`,
    [ids.platformAccountId, ids.accountExternalId]
  );

  await pool.query(
    `INSERT INTO "Agents" (id, platform_account_id, full_name, timezone)
     VALUES ($1::uuid, $2::uuid, 'Identity Test Agent', 'UTC')`,
    [ids.agentId, ids.platformAccountId]
  );

  await pool.query(
    `INSERT INTO "Units" (id, property_name, unit_number, city, state)
     VALUES ($1::uuid, 'Atlas Residences', '12B', 'Austin', 'TX')`,
    [ids.unitId]
  );

  await pool.query(
    `INSERT INTO "Listings" (
       id,
       unit_id,
       platform_account_id,
       listing_external_id,
       rent_cents,
       currency_code,
       status,
       metadata
     ) VALUES (
       $1::uuid,
       $2::uuid,
       $3::uuid,
       $4,
       245000,
       'USD',
       'active',
       '{}'::jsonb
     )`,
    [ids.listingId, ids.unitId, ids.platformAccountId, `id-listing-${suffix}`]
  );

  await pool.query(
    `INSERT INTO "Conversations" (
       id,
       platform_account_id,
       listing_id,
       assigned_agent_id,
       external_thread_id,
       lead_name,
       lead_contact,
       workflow_state
     ) VALUES (
       $1::uuid,
       $2::uuid,
       $3::uuid,
       $4::uuid,
       $5,
       'Inbound Identity Lead',
       '{"email":"identity@example.com"}'::jsonb,
       'lead'
     )`,
    [ids.conversationId, ids.platformAccountId, ids.listingId, ids.agentId, ids.externalThreadId]
  );

  await pool.query(
    `INSERT INTO "Messages" (
       id,
       conversation_id,
       sender_type,
       direction,
       body,
       external_message_id,
       metadata,
       sent_at
     ) VALUES (
       $1::uuid,
       $2::uuid,
       'lead',
       'inbound',
       'Hi, I am interested in unit 12B.',
       $3,
       $4::jsonb,
       NOW()
     )`,
    [
      ids.messageId,
      ids.conversationId,
      ids.externalMessageId,
      JSON.stringify({
        senderName: "Taylor Tenant",
        senderHandle: "@taylortenant",
        platform: "spareroom",
        threadId: ids.externalThreadId
      })
    ]
  );

  return ids;
}

async function cleanupWorkflowFixture(ids) {
  await pool.query(`DELETE FROM "AuditLogs" WHERE entity_type = 'conversation' AND entity_id = $1`, [ids.conversationId]);
  await pool.query(`DELETE FROM "PlatformAccounts" WHERE id = $1::uuid`, [ids.platformAccountId]);
}

async function cleanupInboundIdentityFixture(ids) {
  await pool.query(`DELETE FROM "AuditLogs" WHERE entity_type = 'conversation' AND entity_id = $1`, [ids.conversationId]);
  await pool.query(`DELETE FROM "PlatformAccounts" WHERE id = $1::uuid`, [ids.platformAccountId]);
  await pool.query(`DELETE FROM "Units" WHERE id = $1::uuid`, [ids.unitId]);
}

test.before(async () => {
  await ensureWorkflowMigration006();
});

test("R11: showing appointments route accepts reschedule_requested and no_show filters", async () => {
  let statusA = null;
  let statusB = null;

  const responseA = await callRoute("GET", "/api/showing-appointments?status=reschedule_requested", {
    overrides: {
      withClient: async (task) => task({ id: "client-1" }),
      fetchShowingAppointments: async (_client, filters) => {
        statusA = filters.status;
        return [];
      }
    }
  });

  const responseB = await callRoute("GET", "/api/showing-appointments?status=no_show", {
    overrides: {
      withClient: async (task) => task({ id: "client-1" }),
      fetchShowingAppointments: async (_client, filters) => {
        statusB = filters.status;
        return [];
      }
    }
  });

  assert.equal(responseA.res.statusCode, 200);
  assert.equal(responseB.res.statusCode, 200);
  assert.equal(statusA, "reschedule_requested");
  assert.equal(statusB, "no_show");
});

test("R12/R27: workflow-state endpoint validates payload enums", async () => {
  const response = await callRoute(
    "POST",
    "/api/conversations/66666666-6666-4666-8666-666666666666/workflow-state",
    {
      body: {
        workflowState: "bad_state",
        workflowOutcome: "bad_outcome",
        followUpStage: "follow_up_9"
      },
      overrides: {
        withClient: async (task) => task({ id: "client-1" }),
        transitionConversationWorkflow: async () => ({
          error: "validation_error",
          details: ["workflowState must be one of lead, showing, follow_up_1, follow_up_2, outcome"]
        })
      }
    }
  );

  assert.equal(response.res.statusCode, 400);
  assert.equal(response.json.error, "validation_error");
  assert.match(response.json.message, /Invalid workflow transition payload/);
});

test("R12/R27: workflow-state endpoint forwards accepted transitions", async () => {
  let transitionArgs = null;
  const response = await callRoute(
    "POST",
    "/api/conversations/66666666-6666-4666-8666-666666666666/workflow-state",
    {
      body: {
        workflowState: "follow_up_1",
        followUpStage: "follow_up_1",
        followUpDueAt: "2026-03-10T18:00:00.000Z",
        followUpOwnerAgentId: "22222222-2222-4222-8222-222222222222",
        followUpStatus: "pending"
      },
      overrides: {
        withClient: async (task) => task({ id: "client-1" }),
        transitionConversationWorkflow: async (_client, conversationId, payload, access) => {
          transitionArgs = { conversationId, payload, accessRole: access.role };
          return {
            item: {
              id: conversationId,
              workflowState: payload.workflowState,
              followUpStage: payload.followUpStage,
              followUpDueAt: payload.followUpDueAt,
              followUpOwnerAgentId: payload.followUpOwnerAgentId,
              followUpStatus: payload.followUpStatus
            }
          };
        }
      }
    }
  );

  assert.equal(response.res.statusCode, 200);
  assert.equal(response.json.item.workflowState, "follow_up_1");
  assert.equal(transitionArgs.conversationId, "66666666-6666-4666-8666-666666666666");
  assert.equal(transitionArgs.payload.followUpStage, "follow_up_1");
  assert.equal(transitionArgs.accessRole, "agent");
});

test("R27: workflow-state endpoint returns transition conflicts as 409", async () => {
  const response = await callRoute(
    "POST",
    "/api/conversations/66666666-6666-4666-8666-666666666666/workflow-state",
    {
      body: {
        workflowState: "lead"
      },
      overrides: {
        withClient: async (task) => task({ id: "client-1" }),
        transitionConversationWorkflow: async () => ({
          error: "invalid_transition",
          message: "Invalid workflowState transition from outcome to lead"
        })
      }
    }
  );

  assert.equal(response.res.statusCode, 409);
  assert.equal(response.json.error, "invalid_transition");
});

test("R7/R12: workflow-state endpoint returns 409 for invalid transition using core transition behavior", async () => {
  const ids = await insertWorkflowFixture({ workflowState: "showing" });

  try {
    const response = await callRoute(
      "POST",
      `/api/conversations/${ids.conversationId}/workflow-state`,
      {
        body: {
          workflowState: "follow_up_2"
        },
        sessionUserId: ids.agentId
      }
    );

    assert.equal(response.res.statusCode, 409);
    assert.equal(response.json.error, "invalid_transition");
    assert.match(response.json.message, /Invalid workflowState transition from showing to follow_up_2/);
  } finally {
    await cleanupWorkflowFixture(ids);
  }
});

test("R27: dashboard outcome updates persist not_interested/wants_reschedule/no_show/completed", async () => {
  const outcomes = ["not_interested", "wants_reschedule", "no_show", "completed"];

  for (const workflowOutcome of outcomes) {
    const ids = await insertWorkflowFixture({ workflowState: "showing" });

    try {
      const response = await callRoute(
        "POST",
        `/api/conversations/${ids.conversationId}/workflow-state`,
        {
          body: { workflowOutcome },
          sessionUserId: ids.agentId
        }
      );

      assert.equal(response.res.statusCode, 200);
      assert.equal(response.json.item.workflowOutcome, workflowOutcome);
      assert.equal(response.json.item.workflowState, "outcome");

      const persisted = await pool.query(
        `SELECT workflow_state, workflow_outcome
           FROM "Conversations"
          WHERE id = $1::uuid`,
        [ids.conversationId]
      );
      assert.equal(persisted.rows[0].workflow_state, "outcome");
      assert.equal(persisted.rows[0].workflow_outcome, workflowOutcome);
    } finally {
      await cleanupWorkflowFixture(ids);
    }
  }
});

test("R11/R27: lifecycle states transition end-to-end and lock terminal states", async () => {
  const cancelledPath = await insertWorkflowFixture({ workflowState: "showing", showingState: "pending" });

  try {
    const initialState = await pool.query(
      `SELECT showing_state
         FROM "Conversations"
        WHERE id = $1::uuid`,
      [cancelledPath.conversationId]
    );
    assert.equal(initialState.rows[0].showing_state, "pending");

    const confirm = await callRoute(
      "POST",
      `/api/conversations/${cancelledPath.conversationId}/workflow-state`,
      {
        body: { showingState: "confirmed" },
        sessionUserId: cancelledPath.agentId
      }
    );
    assert.equal(confirm.res.statusCode, 200);
    assert.equal(confirm.json.item.showingState, "confirmed");

    const reschedule = await callRoute(
      "POST",
      `/api/conversations/${cancelledPath.conversationId}/workflow-state`,
      {
        body: { showingState: "reschedule_requested" },
        sessionUserId: cancelledPath.agentId
      }
    );
    assert.equal(reschedule.res.statusCode, 200);
    assert.equal(reschedule.json.item.showingState, "reschedule_requested");

    const pendingAgain = await callRoute(
      "POST",
      `/api/conversations/${cancelledPath.conversationId}/workflow-state`,
      {
        body: { showingState: "pending" },
        sessionUserId: cancelledPath.agentId
      }
    );
    assert.equal(pendingAgain.res.statusCode, 200);
    assert.equal(pendingAgain.json.item.showingState, "pending");

    const cancelled = await callRoute(
      "POST",
      `/api/conversations/${cancelledPath.conversationId}/workflow-state`,
      {
        body: { showingState: "cancelled" },
        sessionUserId: cancelledPath.agentId
      }
    );
    assert.equal(cancelled.res.statusCode, 200);
    assert.equal(cancelled.json.item.showingState, "cancelled");

    const afterCancelled = await callRoute(
      "POST",
      `/api/conversations/${cancelledPath.conversationId}/workflow-state`,
      {
        body: { showingState: "confirmed" },
        sessionUserId: cancelledPath.agentId
      }
    );
    assert.equal(afterCancelled.res.statusCode, 409);
    assert.equal(afterCancelled.json.error, "invalid_transition");
  } finally {
    await cleanupWorkflowFixture(cancelledPath);
  }

  const completedPath = await insertWorkflowFixture({ workflowState: "showing", showingState: "confirmed" });

  try {
    const initialState = await pool.query(
      `SELECT showing_state
         FROM "Conversations"
        WHERE id = $1::uuid`,
      [completedPath.conversationId]
    );
    assert.equal(initialState.rows[0].showing_state, "confirmed");

    const completed = await callRoute(
      "POST",
      `/api/conversations/${completedPath.conversationId}/workflow-state`,
      {
        body: { showingState: "completed" },
        sessionUserId: completedPath.agentId
      }
    );
    assert.equal(completed.res.statusCode, 200);
    assert.equal(completed.json.item.showingState, "completed");

    const afterCompleted = await callRoute(
      "POST",
      `/api/conversations/${completedPath.conversationId}/workflow-state`,
      {
        body: { showingState: "no_show" },
        sessionUserId: completedPath.agentId
      }
    );
    assert.equal(afterCompleted.res.statusCode, 409);
    assert.equal(afterCompleted.json.error, "invalid_transition");
  } finally {
    await cleanupWorkflowFixture(completedPath);
  }

  const noShowPath = await insertWorkflowFixture({ workflowState: "showing", showingState: "confirmed" });

  try {
    const initialState = await pool.query(
      `SELECT showing_state
         FROM "Conversations"
        WHERE id = $1::uuid`,
      [noShowPath.conversationId]
    );
    assert.equal(initialState.rows[0].showing_state, "confirmed");

    const noShow = await callRoute(
      "POST",
      `/api/conversations/${noShowPath.conversationId}/workflow-state`,
      {
        body: { showingState: "no_show" },
        sessionUserId: noShowPath.agentId
      }
    );
    assert.equal(noShow.res.statusCode, 200);
    assert.equal(noShow.json.item.showingState, "no_show");

    const afterNoShow = await callRoute(
      "POST",
      `/api/conversations/${noShowPath.conversationId}/workflow-state`,
      {
        body: { showingState: "completed" },
        sessionUserId: noShowPath.agentId
      }
    );
    assert.equal(afterNoShow.res.statusCode, 409);
    assert.equal(afterNoShow.json.error, "invalid_transition");
  } finally {
    await cleanupWorkflowFixture(noShowPath);
  }
});

test("R5: inbound identity context persists and links across DB + inbox detail API", async () => {
  const ids = await insertInboundIdentityFixture();

  try {
    const response = await callRoute("GET", `/api/inbox/${ids.conversationId}`, {
      role: "agent",
      sessionUserId: ids.agentId
    });

    assert.equal(response.res.statusCode, 200);
    assert.equal(response.json.conversation.platformAccountId, ids.platformAccountId);
    assert.equal(response.json.conversation.externalThreadId, ids.externalThreadId);
    assert.equal(response.json.conversation.listingId, ids.listingId);
    assert.equal(response.json.conversation.unit, "Atlas Residences 12B");
    assert.equal(response.json.messages.length, 1);
    assert.equal(response.json.messages[0].conversationId, ids.conversationId);
    assert.equal(response.json.messages[0].direction, "inbound");
    assert.equal(response.json.messages[0].senderType, "lead");
    assert.equal(response.json.messages[0].metadata.senderHandle, "@taylortenant");
    assert.equal(response.json.messages[0].metadata.threadId, ids.externalThreadId);

    const linkage = await pool.query(
      `SELECT pa.platform,
              c.external_thread_id,
              c.listing_id,
              l.unit_id,
              m.direction,
              m.sender_type,
              m.metadata->>'senderHandle' AS sender_handle,
              m.metadata->>'threadId' AS thread_id,
              m.metadata->>'platform' AS message_platform
         FROM "Messages" m
         JOIN "Conversations" c ON c.id = m.conversation_id
         JOIN "PlatformAccounts" pa ON pa.id = c.platform_account_id
         LEFT JOIN "Listings" l ON l.id = c.listing_id
        WHERE m.id = $1::uuid`,
      [ids.messageId]
    );

    assert.equal(linkage.rowCount, 1);
    assert.equal(linkage.rows[0].platform, "spareroom");
    assert.equal(linkage.rows[0].external_thread_id, ids.externalThreadId);
    assert.equal(linkage.rows[0].listing_id, ids.listingId);
    assert.equal(linkage.rows[0].unit_id, ids.unitId);
    assert.equal(linkage.rows[0].direction, "inbound");
    assert.equal(linkage.rows[0].sender_type, "lead");
    assert.equal(linkage.rows[0].sender_handle, "@taylortenant");
    assert.equal(linkage.rows[0].thread_id, ids.externalThreadId);
    assert.equal(linkage.rows[0].message_platform, "spareroom");
  } finally {
    await cleanupInboundIdentityFixture(ids);
  }
});

test.after(async () => {
  resetRouteTestOverrides();
  await pool.end();
});
