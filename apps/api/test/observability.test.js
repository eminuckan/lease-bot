import test from "node:test";
import assert from "node:assert/strict";

import { fetchObservabilitySnapshot, parsePositiveInt } from "../src/observability.js";

function createMockClient(responses) {
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

test("parsePositiveInt clamps values and falls back on invalid values", () => {
  assert.equal(parsePositiveInt("24", 8, { min: 1, max: 168 }), 24);
  assert.equal(parsePositiveInt("0", 8, { min: 1, max: 168 }), 1);
  assert.equal(parsePositiveInt("999", 8, { min: 1, max: 168 }), 168);
  assert.equal(parsePositiveInt("abc", 8, { min: 1, max: 168 }), 8);
});

test("builds observability payload with core metrics and recent feeds", async () => {
  const client = createMockClient([
    {
      rows: [{
        inbound_messages: "11",
        outbound_messages: "8",
        outbound_sent: "5",
        outbound_draft: "2",
        outbound_hold: "1",
        outbound_pending_review: "3"
      }]
    },
    {
      rows: [{
        ai_decisions: "12",
        ai_replies_created: "7",
        ai_replies_skipped: "3",
        ai_reply_errors: "2",
        admin_review_decisions: "4",
        audit_events: "30"
      }]
    },
    {
      rows: [{
        id: "err-1",
        actor_type: "system",
        actor_id: null,
        entity_type: "request",
        entity_id: "GET /api/inbox",
        action: "api_error",
        details: { error: "boom" },
        created_at: "2026-02-06T10:00:00.000Z"
      }]
    },
    {
      rows: [{
        id: "aud-1",
        actor_type: "admin",
        actor_id: "11111111-1111-1111-1111-111111111111",
        entity_type: "message",
        entity_id: "22222222-2222-2222-2222-222222222222",
        action: "inbox_message_approved",
        details: { reviewStatus: "sent" },
        created_at: "2026-02-06T10:01:00.000Z"
      }]
    }
  ]);

  const payload = await fetchObservabilitySnapshot(client, {
    windowHours: 36,
    auditLimit: 20,
    errorLimit: 10
  });

  assert.equal(payload.windowHours, 36);
  assert.deepEqual(payload.coreMetrics, {
    inboundMessages: 11,
    outboundMessages: 8,
    outboundSent: 5,
    outboundDraft: 2,
    outboundHold: 1,
    outboundPendingReview: 3,
    aiDecisions: 12,
    aiRepliesCreated: 7,
    aiRepliesSkipped: 3,
    aiReplyErrors: 2,
    adminReviewDecisions: 4,
    auditEvents: 30
  });
  assert.equal(payload.recentErrors.length, 1);
  assert.deepEqual(payload.recentErrors[0], {
    id: "err-1",
    actorType: "system",
    actorId: null,
    entityType: "request",
    entityId: "GET /api/inbox",
    action: "api_error",
    details: { error: "boom" },
    createdAt: "2026-02-06T10:00:00.000Z"
  });
  assert.equal(payload.recentAudit.length, 1);
  assert.deepEqual(payload.recentAudit[0], {
    id: "aud-1",
    actorType: "admin",
    actorId: "11111111-1111-1111-1111-111111111111",
    entityType: "message",
    entityId: "22222222-2222-2222-2222-222222222222",
    action: "inbox_message_approved",
    details: { reviewStatus: "sent" },
    createdAt: "2026-02-06T10:01:00.000Z"
  });

  assert.equal(client.calls.length, 4);
  assert.deepEqual(client.calls[0].params, [36]);
  assert.deepEqual(client.calls[1].params, [36]);
  assert.deepEqual(client.calls[2].params, [10]);
  assert.deepEqual(client.calls[3].params, [20]);
});
