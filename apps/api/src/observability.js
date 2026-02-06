export function parsePositiveInt(value, fallback, { min = 1, max = 1000 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

export async function fetchObservabilitySnapshot(client, { windowHours = 24, auditLimit = 50, errorLimit = 25 } = {}) {
  const metricsResult = await client.query(
    `SELECT COUNT(*) FILTER (
              WHERE direction = 'inbound'
                AND sent_at >= NOW() - make_interval(hours => $1::int)
            ) AS inbound_messages,
            COUNT(*) FILTER (
              WHERE direction = 'outbound'
                AND sent_at >= NOW() - make_interval(hours => $1::int)
            ) AS outbound_messages,
            COUNT(*) FILTER (
              WHERE direction = 'outbound'
                AND COALESCE(metadata->>'reviewStatus', 'sent') = 'sent'
                AND sent_at >= NOW() - make_interval(hours => $1::int)
            ) AS outbound_sent,
            COUNT(*) FILTER (
              WHERE direction = 'outbound'
                AND COALESCE(metadata->>'reviewStatus', 'sent') = 'draft'
                AND sent_at >= NOW() - make_interval(hours => $1::int)
            ) AS outbound_draft,
            COUNT(*) FILTER (
              WHERE direction = 'outbound'
                AND COALESCE(metadata->>'reviewStatus', 'sent') = 'hold'
                AND sent_at >= NOW() - make_interval(hours => $1::int)
            ) AS outbound_hold,
            COUNT(*) FILTER (
              WHERE direction = 'outbound'
                AND COALESCE(metadata->>'reviewStatus', 'sent') IN ('draft', 'hold')
            ) AS outbound_pending_review
       FROM "Messages"`,
    [windowHours]
  );

  const auditMetricsResult = await client.query(
    `SELECT COUNT(*) FILTER (
              WHERE action = 'ai_reply_decision'
                AND created_at >= NOW() - make_interval(hours => $1::int)
            ) AS ai_decisions,
            COUNT(*) FILTER (
              WHERE action = 'ai_reply_created'
                AND created_at >= NOW() - make_interval(hours => $1::int)
            ) AS ai_replies_created,
            COUNT(*) FILTER (
              WHERE action = 'ai_reply_skipped'
                AND created_at >= NOW() - make_interval(hours => $1::int)
            ) AS ai_replies_skipped,
            COUNT(*) FILTER (
              WHERE action = 'ai_reply_escalated'
                AND created_at >= NOW() - make_interval(hours => $1::int)
            ) AS ai_escalations,
            COUNT(*) FILTER (
              WHERE action = 'ai_reply_error'
                AND created_at >= NOW() - make_interval(hours => $1::int)
            ) AS ai_reply_errors,
            COUNT(*) FILTER (
              WHERE action = 'platform_dispatch_error'
                AND created_at >= NOW() - make_interval(hours => $1::int)
            ) AS platform_dispatch_errors,
            COUNT(*) FILTER (
              WHERE action = 'showing_booking_created'
                AND created_at >= NOW() - make_interval(hours => $1::int)
            ) AS booking_created,
            COUNT(*) FILTER (
              WHERE action = 'showing_booking_replayed'
                AND created_at >= NOW() - make_interval(hours => $1::int)
            ) AS booking_replayed,
            COUNT(*) FILTER (
              WHERE action IN ('showing_booking_conflict', 'showing_booking_idempotency_conflict', 'showing_booking_failed')
                AND created_at >= NOW() - make_interval(hours => $1::int)
            ) AS booking_conflicts,
            COUNT(*) FILTER (
              WHERE action IN ('inbox_message_approved', 'inbox_message_rejected')
                AND created_at >= NOW() - make_interval(hours => $1::int)
            ) AS admin_review_decisions,
            COUNT(*) FILTER (
              WHERE created_at >= NOW() - make_interval(hours => $1::int)
            ) AS audit_events
       FROM "AuditLogs"`,
    [windowHours]
  );

  const escalationReasonResult = await client.query(
    `SELECT COALESCE(NULLIF(details->>'escalationReasonCode', ''), NULLIF(details#>>'{decision,reason}', ''), 'unknown') AS reason_code,
            COUNT(*)::int AS count
       FROM "AuditLogs"
      WHERE action IN ('ai_reply_decision', 'ai_reply_escalated', 'ai_reply_skipped')
        AND created_at >= NOW() - make_interval(hours => $1::int)
        AND (
          COALESCE(details->>'escalationReasonCode', details#>>'{decision,reason}', '') LIKE 'escalate_%'
          OR details->>'outcome' = 'escalate'
        )
      GROUP BY reason_code
      ORDER BY count DESC, reason_code ASC`,
    [windowHours]
  );

  const bookingSignalsResult = await client.query(
    `SELECT COALESCE(sa.status, 'unknown') AS status,
            COALESCE(pa.platform, 'unknown') AS platform,
            COUNT(*)::int AS count
       FROM "ShowingAppointments" sa
       LEFT JOIN "PlatformAccounts" pa ON pa.id = sa.platform_account_id
      WHERE sa.created_at >= NOW() - make_interval(hours => $1::int)
      GROUP BY status, platform
      ORDER BY count DESC, status ASC, platform ASC`,
    [windowHours]
  );

  const platformFailureResult = await client.query(
    `SELECT COALESCE(NULLIF(details->>'platform', ''), 'unknown') AS platform,
            action,
            COUNT(*)::int AS count
       FROM "AuditLogs"
      WHERE created_at >= NOW() - make_interval(hours => $1::int)
        AND action IN ('platform_dispatch_error', 'ai_reply_error', 'api_error', 'showing_booking_failed')
      GROUP BY platform, action
      ORDER BY count DESC, platform ASC, action ASC`,
    [windowHours]
  );

  const recentErrorsResult = await client.query(
    `SELECT id, actor_type, actor_id, entity_type, entity_id, action, details, created_at
       FROM "AuditLogs"
      WHERE action IN ('ai_reply_error', 'api_error', 'inbox_message_error', 'inbox_draft_error', 'platform_dispatch_error', 'showing_booking_failed')
      ORDER BY created_at DESC
      LIMIT $1`,
    [errorLimit]
  );

  const recentAuditResult = await client.query(
    `SELECT id, actor_type, actor_id, entity_type, entity_id, action, details, created_at
       FROM "AuditLogs"
      ORDER BY created_at DESC
      LIMIT $1`,
    [auditLimit]
  );

  const messages = metricsResult.rows[0] || {};
  const audit = auditMetricsResult.rows[0] || {};
  const bookingByStatus = {};
  const bookingByPlatform = {};

  for (const row of bookingSignalsResult.rows) {
    const status = row.status || "unknown";
    const platform = row.platform || "unknown";
    const count = Number(row.count || 0);
    bookingByStatus[status] = (bookingByStatus[status] || 0) + count;
    bookingByPlatform[platform] = (bookingByPlatform[platform] || 0) + count;
  }

  return {
    windowHours,
    coreMetrics: {
      inboundMessages: Number(messages.inbound_messages || 0),
      outboundMessages: Number(messages.outbound_messages || 0),
      outboundSent: Number(messages.outbound_sent || 0),
      outboundDraft: Number(messages.outbound_draft || 0),
      outboundHold: Number(messages.outbound_hold || 0),
      outboundPendingReview: Number(messages.outbound_pending_review || 0),
      aiDecisions: Number(audit.ai_decisions || 0),
      aiRepliesCreated: Number(audit.ai_replies_created || 0),
      aiRepliesSkipped: Number(audit.ai_replies_skipped || 0),
      aiEscalations: Number(audit.ai_escalations || 0),
      aiReplyErrors: Number(audit.ai_reply_errors || 0),
      platformDispatchErrors: Number(audit.platform_dispatch_errors || 0),
      bookingCreated: Number(audit.booking_created || 0),
      bookingReplayed: Number(audit.booking_replayed || 0),
      bookingConflicts: Number(audit.booking_conflicts || 0),
      adminReviewDecisions: Number(audit.admin_review_decisions || 0),
      auditEvents: Number(audit.audit_events || 0)
    },
    signals: {
      escalationReasons: escalationReasonResult.rows.map((row) => ({
        reasonCode: row.reason_code || "unknown",
        count: Number(row.count || 0)
      })),
      bookingsByStatus: Object.entries(bookingByStatus)
        .map(([status, count]) => ({ status, count }))
        .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status)),
      bookingsByPlatform: Object.entries(bookingByPlatform)
        .map(([platform, count]) => ({ platform, count }))
        .sort((a, b) => b.count - a.count || a.platform.localeCompare(b.platform)),
      platformFailures: platformFailureResult.rows.map((row) => ({
        platform: row.platform || "unknown",
        action: row.action,
        count: Number(row.count || 0)
      }))
    },
    recentErrors: recentErrorsResult.rows.map((row) => ({
      id: row.id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: row.action,
      details: row.details || {},
      createdAt: row.created_at
    })),
    recentAudit: recentAuditResult.rows.map((row) => ({
      id: row.id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: row.action,
      details: row.details || {},
      createdAt: row.created_at
    }))
  };
}
