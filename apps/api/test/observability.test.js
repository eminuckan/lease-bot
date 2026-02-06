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
        ai_escalations: "2",
        ai_reply_errors: "2",
        platform_dispatch_errors: "1",
        booking_created: "6",
        booking_replayed: "1",
        booking_conflicts: "2",
        admin_review_decisions: "4",
        audit_events: "30"
      }]
    },
    {
      rows: [
        { reason_code: "escalate_no_slot_candidates", count: "4" },
        { reason_code: "escalate_non_tour_intent", count: "1" }
      ]
    },
    {
      rows: [
        { status: "confirmed", platform: "leasebreak", count: "3" },
        { status: "pending", platform: "spareroom", count: "2" },
        { status: "confirmed", platform: "spareroom", count: "1" }
      ]
    },
    {
      rows: [
        { platform: "leasebreak", action: "platform_dispatch_error", count: "2" },
        { platform: "unknown", action: "api_error", count: "1" }
      ]
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
    aiEscalations: 2,
    aiReplyErrors: 2,
    platformDispatchErrors: 1,
    bookingCreated: 6,
    bookingReplayed: 1,
    bookingConflicts: 2,
    adminReviewDecisions: 4,
    auditEvents: 30
  });
  assert.deepEqual(payload.signals.escalationReasons, [
    { reasonCode: "escalate_no_slot_candidates", count: 4 },
    { reasonCode: "escalate_non_tour_intent", count: 1 }
  ]);
  assert.deepEqual(payload.signals.bookingsByStatus, [
    { status: "confirmed", count: 4 },
    { status: "pending", count: 2 }
  ]);
  assert.deepEqual(payload.signals.bookingsByPlatform, [
    { platform: "leasebreak", count: 3 },
    { platform: "spareroom", count: 3 }
  ]);
  assert.deepEqual(payload.signals.platformFailures, [
    { platform: "leasebreak", action: "platform_dispatch_error", count: 2 },
    { platform: "unknown", action: "api_error", count: 1 }
  ]);
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

  assert.equal(client.calls.length, 7);
  assert.deepEqual(client.calls[0].params, [36]);
  assert.deepEqual(client.calls[1].params, [36]);
  assert.deepEqual(client.calls[2].params, [36]);
  assert.deepEqual(client.calls[3].params, [36]);
  assert.deepEqual(client.calls[4].params, [36]);
  assert.deepEqual(client.calls[5].params, [10]);
  assert.deepEqual(client.calls[6].params, [20]);

  assert.match(client.calls[1].sql, /showing_booking_created/);
  assert.match(client.calls[1].sql, /showing_booking_replayed/);
  assert.match(client.calls[1].sql, /showing_booking_conflict/);
  assert.match(client.calls[1].sql, /showing_booking_idempotency_conflict/);
  assert.match(client.calls[1].sql, /showing_booking_failed/);
  assert.match(client.calls[4].sql, /showing_booking_failed/);
  assert.match(client.calls[5].sql, /showing_booking_failed/);
});
