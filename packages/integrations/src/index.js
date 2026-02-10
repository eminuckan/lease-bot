import { runReplyPipeline } from "../../ai/src/index.js";
import { createConnectorRegistry, listSupportedPlatforms, resolvePlatformCredentials } from "./connectors.js";
import { createPlaywrightRpaRunner, createRpaRunner } from "./rpa-runner.js";
import { createRpaAlertDispatcher } from "./rpa-alerts.js";
import { createPlatformAdapterRegistry, REQUIRED_RPA_PLATFORMS } from "./platform-adapters.js";
import { calculateBackoffDelay, isRetryableError, withRetry } from "./retry.js";

const allowedSendModes = new Set(["auto_send", "draft_only"]);
const defaultPlatformSendMode = allowedSendModes.has(process.env.PLATFORM_DEFAULT_SEND_MODE)
  ? process.env.PLATFORM_DEFAULT_SEND_MODE
  : "draft_only";
const defaultWorkerClaimTtlMs = Number(process.env.WORKER_CLAIM_TTL_MS || 60000);
const workflowStateTransitionMap = {
  lead: new Set(["lead", "showing", "follow_up_1", "outcome"]),
  showing: new Set(["showing", "follow_up_1", "outcome"]),
  follow_up_1: new Set(["follow_up_1", "follow_up_2", "outcome"]),
  follow_up_2: new Set(["follow_up_2", "outcome"]),
  outcome: new Set(["outcome", "lead"])
};
const showingStateTransitionMap = {
  pending: new Set(["pending", "confirmed", "reschedule_requested", "cancelled", "no_show"]),
  confirmed: new Set(["confirmed", "reschedule_requested", "cancelled", "completed", "no_show"]),
  reschedule_requested: new Set(["reschedule_requested", "pending", "confirmed", "cancelled", "no_show"]),
  cancelled: new Set(["cancelled"]),
  completed: new Set(["completed"]),
  no_show: new Set(["no_show"])
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pickFirstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string") {
      const normalized = value.trim();
      if (normalized.length > 0) {
        return normalized;
      }
    }
  }
  return null;
}

function normalizeUuid(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!uuidPattern.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeTimestampValue(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }

  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return null;
}

function isAllowedTransition(map, fromState, toState) {
  if (toState === undefined || toState === null) {
    return true;
  }
  if (fromState === null || fromState === undefined) {
    return true;
  }
  const allowed = map[fromState];
  if (!allowed) {
    return false;
  }
  return allowed.has(toState);
}

function extractInboundLinkageContext(inbound) {
  const metadata = inbound?.metadata || {};
  const listingMeta = metadata.listing || {};
  const unitMeta = metadata.unit || {};
  const contextMeta = metadata.context || {};

  const listingId = normalizeUuid(
    pickFirstNonEmptyString(
      inbound?.listingId,
      metadata.listingId,
      metadata.listing_id,
      listingMeta.id,
      contextMeta.listingId,
      contextMeta.listing_id
    )
  );

  const unitId = normalizeUuid(
    pickFirstNonEmptyString(
      inbound?.unitId,
      metadata.unitId,
      metadata.unit_id,
      listingMeta.unitId,
      listingMeta.unit_id,
      unitMeta.id,
      contextMeta.unitId,
      contextMeta.unit_id
    )
  );

  return {
    listingId,
    listingExternalId: pickFirstNonEmptyString(
      inbound?.listingExternalId,
      metadata.listingExternalId,
      metadata.listing_external_id,
      listingMeta.externalId,
      listingMeta.external_id,
      contextMeta.listingExternalId,
      contextMeta.listing_external_id
    ),
    unitId,
    unitExternalId: pickFirstNonEmptyString(
      inbound?.unitExternalId,
      metadata.unitExternalId,
      metadata.unit_external_id,
      listingMeta.unitExternalId,
      listingMeta.unit_external_id,
      unitMeta.externalId,
      unitMeta.external_id,
      contextMeta.unitExternalId,
      contextMeta.unit_external_id
    ),
    propertyName: pickFirstNonEmptyString(
      inbound?.propertyName,
      metadata.propertyName,
      metadata.property_name,
      unitMeta.propertyName,
      unitMeta.property_name,
      contextMeta.propertyName,
      contextMeta.property_name
    ),
    unitNumber: pickFirstNonEmptyString(
      inbound?.unitNumber,
      metadata.unitNumber,
      metadata.unit_number,
      unitMeta.unitNumber,
      unitMeta.unit_number,
      contextMeta.unitNumber,
      contextMeta.unit_number
    )
  };
}

async function resolveInboundListingLinkage(client, platformAccountId, inbound) {
  const context = extractInboundLinkageContext(inbound);
  const hasLinkageHints = Boolean(
    context.listingId
    || context.listingExternalId
    || context.unitId
    || context.unitExternalId
    || (context.propertyName && context.unitNumber)
  );

  if (!hasLinkageHints) {
    return {
      listingId: null,
      unitId: null,
      strategy: "none",
      context,
      resolved: false
    };
  }

  const result = await client.query(
    `SELECT l.id AS listing_id,
            l.unit_id,
            CASE
              WHEN $2::uuid IS NOT NULL AND l.id = $2::uuid THEN 'listing_id'
              WHEN $3::text IS NOT NULL AND l.listing_external_id = $3::text THEN 'listing_external_id'
              WHEN $4::uuid IS NOT NULL AND l.unit_id = $4::uuid THEN 'unit_id'
              WHEN $5::text IS NOT NULL AND u.external_id = $5::text THEN 'unit_external_id'
              WHEN $6::text IS NOT NULL AND $7::text IS NOT NULL
                AND LOWER(u.property_name) = LOWER($6::text)
                AND LOWER(u.unit_number) = LOWER($7::text)
              THEN 'property_name_unit_number'
              ELSE 'unknown'
            END AS strategy,
            CASE
              WHEN $2::uuid IS NOT NULL AND l.id = $2::uuid THEN 500
              WHEN $3::text IS NOT NULL AND l.listing_external_id = $3::text THEN 400
              WHEN $4::uuid IS NOT NULL AND l.unit_id = $4::uuid THEN 300
              WHEN $5::text IS NOT NULL AND u.external_id = $5::text THEN 200
              WHEN $6::text IS NOT NULL AND $7::text IS NOT NULL
                AND LOWER(u.property_name) = LOWER($6::text)
                AND LOWER(u.unit_number) = LOWER($7::text)
              THEN 100
              ELSE 0
            END AS score
       FROM "Listings" l
       JOIN "Units" u ON u.id = l.unit_id
      WHERE l.platform_account_id = $1::uuid
        AND (
          ($2::uuid IS NOT NULL AND l.id = $2::uuid)
          OR ($3::text IS NOT NULL AND l.listing_external_id = $3::text)
          OR ($4::uuid IS NOT NULL AND l.unit_id = $4::uuid)
          OR ($5::text IS NOT NULL AND u.external_id = $5::text)
          OR (
            $6::text IS NOT NULL
            AND $7::text IS NOT NULL
            AND LOWER(u.property_name) = LOWER($6::text)
            AND LOWER(u.unit_number) = LOWER($7::text)
          )
        )
      ORDER BY score DESC, l.updated_at DESC
      LIMIT 1`,
    [
      platformAccountId,
      context.listingId,
      context.listingExternalId,
      context.unitId,
      context.unitExternalId,
      context.propertyName,
      context.unitNumber
    ]
  );

  if (result.rowCount === 0) {
    return {
      listingId: null,
      unitId: null,
      strategy: "unresolved",
      context,
      resolved: false
    };
  }

  const row = result.rows[0];
  return {
    listingId: row.listing_id,
    unitId: row.unit_id,
    strategy: row.strategy || "unknown",
    context,
    resolved: true
  };
}

function formatSlotWindow(slot) {
  const timezone = slot.timezone || "UTC";
  const startsAt = new Date(slot.starts_at || slot.startsAt).toISOString();
  const endsAt = new Date(slot.ends_at || slot.endsAt).toISOString();
  return `${startsAt} - ${endsAt} ${timezone}`;
}

function buildTemplateContext(message, slotOptions) {
  const unit = message.propertyName && message.unitNumber ? `${message.propertyName} ${message.unitNumber}` : "";
  const firstSlot = slotOptions.length > 0 ? slotOptions[0] : "";

  return {
    unit,
    unit_number: message.unitNumber || "",
    slot: firstSlot,
    slot_options: slotOptions.join(", "),
    lead_name: message.leadName || ""
  };
}

function createMetricsSnapshot() {
  return {
    decisions: {
      eligible: 0,
      ineligible: 0,
      reasons: {}
    },
    sends: {
      attempted: 0,
      sent: 0,
      drafted: 0
    },
    errors: 0,
    auditLogsWritten: 0
  };
}

function incrementMetricBucket(bucket, key) {
  const normalizedKey = key || "unknown";
  bucket[normalizedKey] = (bucket[normalizedKey] || 0) + 1;
}

export async function processPendingMessages({ adapter, logger = console, limit = 20, now = new Date() }) {
  const pendingMessages = await adapter.fetchPendingMessages(limit);
  let repliesCreated = 0;
  const metrics = createMetricsSnapshot();

  for (const message of pendingMessages) {
    try {
      const slotRows = message.unitId ? await adapter.fetchSlotOptions(message.unitId, 3) : [];
      const slotOptions = slotRows.map((slot) => formatSlotWindow(slot));
      const followUpRuleFallbackIntent = message.metadata?.intent || "tour_request";

      const intentOnly = runReplyPipeline({
        inboundBody: message.body,
        hasRecentOutbound: message.hasRecentOutbound,
        fallbackIntent: followUpRuleFallbackIntent,
        rule: { enabled: false },
        template: { body: "x" },
        templateContext: {}
      });

      const rule = await adapter.findRule({
        platformAccountId: message.platformAccountId,
        intent: intentOnly.effectiveIntent,
        fallbackIntent: followUpRuleFallbackIntent
      });

      const templateName = rule?.actionConfig?.template || null;
      const template = templateName
        ? await adapter.findTemplate({
            platformAccountId: message.platformAccountId,
            templateName
          })
        : null;

      const templateContext = buildTemplateContext(message, slotOptions);
      const pipeline = runReplyPipeline({
        inboundBody: message.body,
        hasRecentOutbound: message.hasRecentOutbound,
        fallbackIntent: followUpRuleFallbackIntent,
        rule,
        template,
        templateContext
      });

      await adapter.recordLog({
        actorType: "worker",
        entityType: "message",
        entityId: message.id,
        action: "ai_reply_decision",
        details: {
          intent: pipeline.intent,
          effectiveIntent: pipeline.effectiveIntent,
          followUp: pipeline.followUp,
          decision: pipeline.eligibility,
          guardrails: pipeline.guardrails.reasons
        }
      });
      metrics.auditLogsWritten += 1;
      if (pipeline.eligibility.eligible) {
        metrics.decisions.eligible += 1;
      } else {
        metrics.decisions.ineligible += 1;
      }
      incrementMetricBucket(metrics.decisions.reasons, pipeline.eligibility.reason);

      if (pipeline.eligibility.eligible) {
        const status = rule.enabled ? "sent" : "draft";
        metrics.sends.attempted += 1;
        const deliveryReceipt = status === "sent" && typeof adapter.dispatchOutboundMessage === "function"
          ? await adapter.dispatchOutboundMessage({
              platformAccountId: message.platformAccountId,
              platform: message.platform,
              platformCredentials: message.platformCredentials,
              externalThreadId: message.externalThreadId,
              body: pipeline.replyBody,
              metadata: {
                intent: pipeline.intent,
                effectiveIntent: pipeline.effectiveIntent
              }
            })
          : null;

        await adapter.recordLog({
          actorType: "worker",
          entityType: "message",
          entityId: message.id,
          action: status === "sent" ? "ai_reply_send_attempted" : "ai_reply_draft_created",
          details: {
            intent: pipeline.intent,
            effectiveIntent: pipeline.effectiveIntent,
            reviewStatus: status,
            delivery: deliveryReceipt
          }
        });
        metrics.auditLogsWritten += 1;

        const outboundMetadata = {
          reviewStatus: status,
          templateId: template.id,
          intent: pipeline.intent,
          effectiveIntent: pipeline.effectiveIntent,
          followUp: pipeline.followUp,
          workerGeneratedAt: now.toISOString(),
          guardrails: pipeline.guardrails.reasons,
          delivery: deliveryReceipt
        };

        await adapter.recordOutboundReply({
          conversationId: message.conversationId,
          assignedAgentId: message.assignedAgentId,
          body: pipeline.replyBody,
          metadata: outboundMetadata,
          channel: deliveryReceipt?.channel || "in_app",
          externalMessageId: deliveryReceipt?.externalMessageId || null
        });

        repliesCreated += 1;
        if (status === "sent") {
          metrics.sends.sent += 1;
        } else {
          metrics.sends.drafted += 1;
        }
      }

      const inboundMetadataPatch = {
        aiProcessedAt: now.toISOString(),
        intent: pipeline.intent,
        effectiveIntent: pipeline.effectiveIntent,
        followUp: pipeline.followUp,
        replyEligible: pipeline.eligibility.eligible,
        replyDecisionReason: pipeline.eligibility.reason,
        guardrails: pipeline.guardrails.reasons
      };

      await adapter.markInboundProcessed({
        messageId: message.id,
        metadataPatch: inboundMetadataPatch
      });

      await adapter.recordLog({
        actorType: "worker",
        entityType: "message",
        entityId: message.id,
        action: pipeline.eligibility.eligible ? "ai_reply_created" : "ai_reply_skipped",
        details: {
          intent: pipeline.intent,
          effectiveIntent: pipeline.effectiveIntent,
          followUp: pipeline.followUp,
          decision: pipeline.eligibility,
          guardrails: pipeline.guardrails.reasons
        }
      });
      metrics.auditLogsWritten += 1;
    } catch (error) {
      logger.error("[worker] failed processing message", {
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error)
      });
      metrics.errors += 1;
      await adapter.recordLog({
        actorType: "worker",
        entityType: "message",
        entityId: message.id,
        action: "ai_reply_error",
        details: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
      metrics.auditLogsWritten += 1;
    }
  }

  return {
    scanned: pendingMessages.length,
    repliesCreated,
    metrics
  };
}

export function createPostgresQueueAdapter(client, options = {}) {
  let connectorRegistry = options.connectorRegistry || null;
  const connectorRegistryFactory = options.connectorRegistryFactory || (() => createConnectorRegistry());
  const getConnectorRegistry = () => {
    if (!connectorRegistry) {
      connectorRegistry = connectorRegistryFactory();
    }
    return connectorRegistry;
  };

  const parseCsvEnv = (value) => {
    if (typeof value !== "string") {
      return [];
    }
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  };

  function parseRentCentsFromText(priceText) {
    const text = typeof priceText === "string" ? priceText : "";
    const match = text.match(/\$\s*([0-9][0-9,]*)/);
    if (!match) {
      return null;
    }

    const dollars = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(dollars)) {
      return null;
    }

    return Math.round(dollars * 100);
  }

  function normalizeUnitIdentityPart(value) {
    if (typeof value !== "string") {
      return "";
    }
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function stableHashBase36(value) {
    let hash = 2166136261;
    const input = typeof value === "string" ? value : "";
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function buildUnitSyncKey(platformAccountId, title, location) {
    const normalizedScope = normalizeUnitIdentityPart(platformAccountId || "global");
    const normalizedTitle = normalizeUnitIdentityPart(title);
    if (!normalizedTitle) {
      return null;
    }
    const normalizedLocation = normalizeUnitIdentityPart(location);
    return `listing-sync:${normalizedScope || "global"}:${normalizedTitle}|${normalizedLocation || "na"}`;
  }

  function buildGeneratedUnitNumber(unitSyncKey, listingExternalId) {
    if (unitSyncKey) {
      return `#u${stableHashBase36(unitSyncKey).slice(0, 8)}`;
    }
    return `#${listingExternalId}`;
  }

  function normalizeSlotCandidate(slot) {
    if (!slot || typeof slot !== "object") {
      return null;
    }

    const startsAt = normalizeTimestampValue(slot.starts_at || slot.startsAt);
    const endsAt = normalizeTimestampValue(slot.ends_at || slot.endsAt);
    if (!startsAt || !endsAt) {
      return null;
    }

    return {
      startsAt,
      endsAt,
      timezone: typeof slot.timezone === "string" && slot.timezone.trim() ? slot.timezone.trim() : "UTC",
      agentId: normalizeUuid(slot.agent_id || slot.agentId),
      agentName: typeof slot.agent_name === "string"
        ? slot.agent_name.trim()
        : typeof slot.agentName === "string"
        ? slot.agentName.trim()
        : null
    };
  }

  function buildWorkflowAppointmentIdempotencyKey(conversationId, slotCandidate) {
    const startsAt = slotCandidate?.startsAt || "na";
    const endsAt = slotCandidate?.endsAt || "na";
    return `wf:${conversationId}:${startsAt}:${endsAt}`;
  }

  async function createWorkflowShowingAppointment({
    conversationId,
    conversation,
    slotCandidate,
    workflowOutcome,
    source,
    messageId,
    selectedSlotIndex
  }) {
    const startsAt = slotCandidate.startsAt;
    const endsAt = slotCandidate.endsAt;
    const timezone = slotCandidate.timezone || "UTC";
    const agentId = slotCandidate.agentId || normalizeUuid(conversation.assigned_agent_id);
    const unitId = normalizeUuid(conversation.unit_id);
    const listingId = normalizeUuid(conversation.listing_id);
    const platformAccountId = normalizeUuid(conversation.platform_account_id);

    if (!agentId || !unitId || !platformAccountId) {
      return { applied: false, reason: "missing_slot_context" };
    }

    const idempotencyKey = buildWorkflowAppointmentIdempotencyKey(conversationId, slotCandidate);
    const metadata = {
      workflowOutcome,
      workflowSyncedAt: new Date().toISOString(),
      workflowSource: source,
      workflowMessageId: messageId || null,
      selectedSlotIndex: Number.isFinite(Number(selectedSlotIndex)) ? Number(selectedSlotIndex) : null,
      slotCandidate
    };

    try {
      const upsertResult = await client.query(
        `INSERT INTO "ShowingAppointments" (
           idempotency_key,
           platform_account_id,
           conversation_id,
           unit_id,
           listing_id,
           agent_id,
           starts_at,
           ends_at,
           timezone,
           status,
           source,
           metadata
         ) VALUES (
           $1,
           $2::uuid,
           $3::uuid,
           $4::uuid,
           $5::uuid,
           $6::uuid,
           $7::timestamptz,
           $8::timestamptz,
           $9,
           'confirmed',
           'ai_outcome',
           $10::jsonb
         )
         ON CONFLICT (idempotency_key)
         DO UPDATE SET
           status = 'confirmed',
           metadata = COALESCE("ShowingAppointments".metadata, '{}'::jsonb) || EXCLUDED.metadata,
           updated_at = NOW()
         RETURNING id, status, (xmax = 0) AS inserted`,
        [
          idempotencyKey,
          platformAccountId,
          conversationId,
          unitId,
          listingId,
          agentId,
          startsAt,
          endsAt,
          timezone,
          JSON.stringify(metadata)
        ]
      );

      return {
        applied: true,
        created: Boolean(upsertResult.rows[0]?.inserted),
        appointmentId: upsertResult.rows[0]?.id || null,
        status: upsertResult.rows[0]?.status || "confirmed"
      };
    } catch (error) {
      if (error?.code === "23P01") {
        return {
          applied: false,
          reason: "slot_conflict",
          error: "agent_slot_conflict"
        };
      }
      throw error;
    }
  }

  async function fetchAssignedAgentSlotOptionsInternal({
    unitId,
    assignedAgentId,
    limit = 3,
    includeAllAssignedAgents = false
  }) {
    if (!unitId) {
      return [];
    }

    const resolvedLimit = Math.max(1, Number(limit || 3));
    const normalizedAssignedAgentId = normalizeUuid(assignedAgentId);
    const preferAssignedAgent = includeAllAssignedAgents && normalizedAssignedAgentId ? 0 : 1;

    const result = await client.query(
      `SELECT ua.agent_id,
              ag.full_name AS agent_name,
              GREATEST(unit_slot.starts_at, agent_slot.starts_at) AS starts_at,
              LEAST(unit_slot.ends_at, agent_slot.ends_at) AS ends_at,
              COALESCE(unit_slot.timezone, agent_slot.timezone, 'UTC') AS timezone,
              ua.priority
         FROM "UnitAgentAssignments" ua
         JOIN "Agents" ag
           ON ag.id = ua.agent_id
         JOIN "AvailabilitySlots" unit_slot
           ON unit_slot.unit_id = ua.unit_id
          AND unit_slot.status = 'open'
         JOIN "AgentAvailabilitySlots" agent_slot
           ON agent_slot.agent_id = ua.agent_id
          AND agent_slot.status = 'available'
        WHERE ua.unit_id = $1::uuid
          AND ua.assignment_mode = 'active'
          AND (
            $2::boolean = TRUE
            OR ($3::uuid IS NOT NULL AND ua.agent_id = $3::uuid)
          )
          AND tstzrange(unit_slot.starts_at, unit_slot.ends_at, '[)')
              && tstzrange(agent_slot.starts_at, agent_slot.ends_at, '[)')
          AND NOT EXISTS (
            SELECT 1
              FROM "AgentAvailabilitySlots" blocked_slot
             WHERE blocked_slot.agent_id = ua.agent_id
               AND blocked_slot.status = 'unavailable'
               AND tstzrange(blocked_slot.starts_at, blocked_slot.ends_at, '[)')
                   && tstzrange(
                     GREATEST(unit_slot.starts_at, agent_slot.starts_at),
                     LEAST(unit_slot.ends_at, agent_slot.ends_at),
                     '[)'
                   )
          )
          AND NOT EXISTS (
            SELECT 1
              FROM "ShowingAppointments" appt
             WHERE appt.agent_id = ua.agent_id
               AND appt.unit_id <> ua.unit_id
               AND appt.status IN ('pending', 'confirmed', 'reschedule_requested')
               AND tstzrange(appt.starts_at, appt.ends_at, '[)')
                   && tstzrange(
                     GREATEST(unit_slot.starts_at, agent_slot.starts_at),
                     LEAST(unit_slot.ends_at, agent_slot.ends_at),
                     '[)'
                   )
          )
          AND GREATEST(unit_slot.starts_at, agent_slot.starts_at) < LEAST(unit_slot.ends_at, agent_slot.ends_at)
          AND GREATEST(unit_slot.starts_at, agent_slot.starts_at) >= NOW()
        ORDER BY
          CASE WHEN $4::int = 0 AND ua.agent_id = $3::uuid THEN 0 ELSE 1 END ASC,
          GREATEST(unit_slot.starts_at, agent_slot.starts_at) ASC,
          ua.priority ASC,
          ua.created_at ASC
        LIMIT $5`,
      [unitId, includeAllAssignedAgents, normalizedAssignedAgentId, preferAssignedAgent, resolvedLimit]
    );

    return result.rows;
  }

  return {
    async fetchPendingMessages(request = {}) {
      const normalizedRequest = typeof request === "number" ? { limit: request } : request;
      const limit = Number(normalizedRequest.limit || 20);
      const claimedAt = normalizedRequest.now || new Date().toISOString();
      const claimTtlMs = Math.max(Number(normalizedRequest.claimTtlMs || defaultWorkerClaimTtlMs), 1000);
      const claimExpiresAt = new Date(Date.parse(claimedAt) + claimTtlMs).toISOString();
      const workerId = normalizedRequest.workerId || process.env.WORKER_INSTANCE_ID || `worker-${process.pid}`;

      await client.query("BEGIN");
      let result;
      try {
        result = await client.query(
          `WITH claimable AS (
             SELECT m.id
               FROM "Messages" m
              WHERE m.direction = 'inbound'
                AND NOT (COALESCE(m.metadata, '{}'::jsonb) ? 'aiProcessedAt')
                AND (
                  COALESCE(NULLIF(COALESCE(m.metadata#>>'{workerClaim,claimExpiresAt}', ''), '')::timestamptz, to_timestamp(0)) <= $2::timestamptz
                )
              ORDER BY m.sent_at ASC, m.created_at ASC
              FOR UPDATE SKIP LOCKED
              LIMIT $1
           ),
	           claimed AS (
	             UPDATE "Messages" m
	                SET metadata = COALESCE(m.metadata, '{}'::jsonb) || jsonb_build_object(
	                  'workerClaim',
	                  jsonb_build_object(
	                    'workerId', $3::text,
	                    'claimedAt', $2::timestamptz,
	                    'claimExpiresAt', $4::timestamptz
	                  )
	                )
	               FROM claimable
	              WHERE m.id = claimable.id
	              RETURNING m.id
	           )
           SELECT m.id,
                  m.conversation_id,
                  m.body,
                  m.metadata,
                  m.sent_at,
                  c.showing_state,
                  c.platform_account_id,
                  pa.platform,
                  pa.credentials AS platform_credentials,
                  pa.is_active AS platform_is_active,
                  pa.send_mode AS platform_send_mode_override,
                  COALESCE(pa.send_mode, $5) AS platform_effective_send_mode,
                  c.assigned_agent_id,
                  c.external_thread_id,
                  c.lead_name,
                  u.id AS unit_id,
                  u.property_name,
                  u.unit_number,
                  pending_slot.pending_slot_metadata,
                  EXISTS (
                    SELECT 1
                      FROM "Messages" mo
                     WHERE mo.conversation_id = m.conversation_id
                       AND mo.direction = 'outbound'
                       AND mo.sent_at < m.sent_at
                  ) AS has_recent_outbound
             FROM claimed cl
             JOIN "Messages" m ON m.id = cl.id
             JOIN "Conversations" c ON c.id = m.conversation_id
             JOIN "PlatformAccounts" pa ON pa.id = c.platform_account_id
        LEFT JOIN "Listings" l ON l.id = c.listing_id
        LEFT JOIN "Units" u ON u.id = l.unit_id
        LEFT JOIN LATERAL (
          SELECT mo.metadata AS pending_slot_metadata
            FROM "Messages" mo
           WHERE mo.conversation_id = m.conversation_id
             AND mo.direction = 'outbound'
             AND (COALESCE(mo.metadata, '{}'::jsonb) ? 'slotConfirmationPending')
           ORDER BY mo.sent_at DESC, mo.created_at DESC
           LIMIT 1
        ) pending_slot ON TRUE
            ORDER BY m.sent_at ASC, m.created_at ASC`,
          [limit, claimedAt, workerId, claimExpiresAt, defaultPlatformSendMode]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }

      return result.rows.map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        body: row.body,
        metadata: row.metadata || {},
        sentAt: row.sent_at,
        platformAccountId: row.platform_account_id,
        platform: row.platform,
        platformCredentials: row.platform_credentials || {},
        platformPolicy: {
          isActive: row.platform_is_active !== false,
          sendMode: row.platform_effective_send_mode,
          sendModeOverride: row.platform_send_mode_override,
          globalDefaultSendMode: defaultPlatformSendMode
        },
        assignedAgentId: row.assigned_agent_id,
        externalThreadId: row.external_thread_id,
        leadName: row.lead_name,
        unitId: row.unit_id,
        propertyName: row.property_name,
        unitNumber: row.unit_number,
        hasRecentOutbound: Boolean(row.has_recent_outbound),
        showingState: row.showing_state || null,
        pendingSlotConfirmation: ["confirmed", "completed", "cancelled", "no_show"].includes(row.showing_state)
          ? null
          : row.pending_slot_metadata?.slotConfirmationPending || null
      }));
    },

    async fetchConversationRecentMessages({ conversationId, limit = 12 } = {}) {
      if (!conversationId) {
        return [];
      }

      const resolvedLimit = Math.max(1, Number(limit || 12));
      const result = await client.query(
        `SELECT id,
                direction,
                sender_type,
                sender_agent_id,
                body,
                sent_at,
                created_at
           FROM "Messages"
          WHERE conversation_id = $1::uuid
          ORDER BY sent_at DESC NULLS LAST, created_at DESC
          LIMIT $2`,
        [conversationId, resolvedLimit]
      );

      // Provide context chronologically (oldest -> newest).
      return result.rows
        .slice()
        .reverse()
        .map((row) => ({
          id: row.id,
          direction: row.direction,
          senderType: row.sender_type,
          senderAgentId: row.sender_agent_id,
          body: row.body,
          sentAt: row.sent_at,
          createdAt: row.created_at
        }));
    },

    async fetchFewShotExamples({ platformAccountId, limit = 3, excludeConversationId = null } = {}) {
      if (!platformAccountId) {
        return [];
      }

      const resolvedLimit = Math.max(1, Number(limit || 3));
      const excluded = excludeConversationId || null;
      const result = await client.query(
        `SELECT c.id AS conversation_id,
                mi.body AS inbound_body,
                mo.body AS outbound_body,
                mi.sent_at AS inbound_sent_at,
                mo.sent_at AS outbound_sent_at
           FROM "Conversations" c
           JOIN LATERAL (
             SELECT id, body, sent_at, created_at
               FROM "Messages"
              WHERE conversation_id = c.id
                AND direction = 'outbound'
                AND COALESCE(body, '') <> ''
              ORDER BY sent_at DESC NULLS LAST, created_at DESC
              LIMIT 1
           ) mo ON TRUE
           JOIN LATERAL (
             SELECT id, body, sent_at, created_at
               FROM "Messages"
              WHERE conversation_id = c.id
                AND direction = 'inbound'
                AND COALESCE(body, '') <> ''
                AND sent_at <= mo.sent_at
              ORDER BY sent_at DESC NULLS LAST, created_at DESC
              LIMIT 1
           ) mi ON TRUE
          WHERE c.platform_account_id = $1::uuid
            AND ($2::uuid IS NULL OR c.id <> $2::uuid)
          ORDER BY mo.sent_at DESC NULLS LAST, mo.created_at DESC
          LIMIT $3`,
        [platformAccountId, excluded, resolvedLimit]
      );

      return result.rows.map((row) => ({
        conversationId: row.conversation_id,
        inboundBody: row.inbound_body,
        outboundBody: row.outbound_body,
        inboundSentAt: row.inbound_sent_at,
        outboundSentAt: row.outbound_sent_at
      }));
    },

    async fetchSlotOptions(unitId, limit = 3) {
      const result = await client.query(
        `SELECT starts_at, ends_at, timezone
           FROM "AvailabilitySlots"
          WHERE unit_id = $1::uuid
            AND status = 'open'
            AND starts_at >= NOW()
          ORDER BY starts_at ASC
          LIMIT $2`,
        [unitId, limit]
      );

      return result.rows;
    },

    async fetchAssignedAgentSlotOptions({ unitId, assignedAgentId, limit = 3, includeAllAssignedAgents = false }) {
      return fetchAssignedAgentSlotOptionsInternal({
        unitId,
        assignedAgentId,
        limit,
        includeAllAssignedAgents
      });
    },

    // Dev helper: ensure a test conversation has a listing + assigned agent so we can compute slot options.
    // This is used by the worker when WORKER_AUTOREPLY_ALLOW_LEAD_NAMES is set (safe test-only mode).
    async ensureDevTestConversationContext({ conversationId, platformAccountId }) {
      if (process.env.NODE_ENV === "production") {
        return null;
      }
      if (process.env.LEASE_BOT_DEV_BOOTSTRAP_TEST_DATA === "0") {
        return null;
      }
      if (!conversationId || !platformAccountId) {
        return null;
      }

      const agentName = process.env.LEASE_BOT_DEV_AGENT_NAME || "Aleyna";
      const listingExternalId = process.env.LEASE_BOT_DEV_LISTING_EXTERNAL_ID || "dev_default";

      const agentResult = await client.query(
        `SELECT id
           FROM "Agents"
          WHERE platform_account_id = $1::uuid
            AND full_name = $2
          ORDER BY created_at ASC
          LIMIT 1`,
        [platformAccountId, agentName]
      );
      const agentId = agentResult.rows?.[0]?.id || null;
      if (!agentId) {
        return null;
      }

      const listingResult = await client.query(
        `SELECT l.id AS listing_id,
                u.id AS unit_id,
                u.property_name,
                u.unit_number
           FROM "Listings" l
           JOIN "Units" u ON u.id = l.unit_id
          WHERE l.platform_account_id = $1::uuid
            AND l.listing_external_id = $2
          LIMIT 1`,
        [platformAccountId, listingExternalId]
      );
      const listing = listingResult.rows?.[0] || null;
      if (!listing?.listing_id || !listing?.unit_id) {
        return null;
      }

      await client.query(
        `UPDATE "Conversations"
            SET listing_id = COALESCE(listing_id, $2::uuid),
                assigned_agent_id = COALESCE(assigned_agent_id, $3::uuid),
                updated_at = NOW()
          WHERE id = $1::uuid`,
        [conversationId, listing.listing_id, agentId]
      );

      await client.query(
        `INSERT INTO "UnitAgentAssignments" (unit_id, agent_id, assignment_mode, priority)
         VALUES ($1::uuid, $2::uuid, 'active', 100)
         ON CONFLICT (unit_id, agent_id) DO UPDATE
         SET assignment_mode = EXCLUDED.assignment_mode,
             priority = LEAST("UnitAgentAssignments".priority, EXCLUDED.priority),
             updated_at = NOW()`,
        [listing.unit_id, agentId]
      );

      return {
        assignedAgentId: agentId,
        unitId: listing.unit_id,
        propertyName: listing.property_name,
        unitNumber: listing.unit_number
      };
    },

    async findRule({ platformAccountId, intent, fallbackIntent }) {
      const queryRule = async (intentToFind) => {
        if (!intentToFind) {
          return null;
        }

        const result = await client.query(
          `SELECT id, is_enabled, action_config, conditions
             FROM "AutomationRules"
            WHERE platform_account_id = $1::uuid
              AND trigger_type = 'message_received'
              AND action_type = 'send_template'
              AND COALESCE(conditions->>'intent', '') = $2
            ORDER BY priority ASC, created_at ASC
            LIMIT 1`,
          [platformAccountId, intentToFind]
        );

        if (result.rowCount === 0) {
          return null;
        }

        return {
          id: result.rows[0].id,
          enabled: Boolean(result.rows[0].is_enabled),
          actionConfig: result.rows[0].action_config || {},
          conditions: result.rows[0].conditions || {}
        };
      };

      const direct = await queryRule(intent);
      if (direct) {
        return direct;
      }

      if (fallbackIntent && fallbackIntent !== intent) {
        return queryRule(fallbackIntent);
      }

      return null;
    },

    async findTemplate({ platformAccountId, templateName }) {
      const result = await client.query(
        `SELECT id, name, body
           FROM "Templates"
          WHERE name = $2
            AND is_active = TRUE
            AND (platform_account_id = $1::uuid OR platform_account_id IS NULL)
          ORDER BY CASE WHEN platform_account_id = $1::uuid THEN 0 ELSE 1 END, updated_at DESC
          LIMIT 1`,
        [platformAccountId, templateName]
      );

      if (result.rowCount === 0) {
        return null;
      }

      return result.rows[0];
    },

    async recordOutboundReply({ conversationId, assignedAgentId, body, metadata, channel = "in_app", externalMessageId = null }) {
      const insertResult = await client.query(
        `INSERT INTO "Messages" (
           conversation_id,
           sender_type,
           sender_agent_id,
           external_message_id,
           direction,
           channel,
           body,
           metadata,
           sent_at
         ) VALUES ($1::uuid, 'agent', $2::uuid, $3, 'outbound', $4, $5, $6::jsonb, NOW())
         ON CONFLICT (conversation_id, external_message_id) DO NOTHING
         RETURNING id`,
        [conversationId, assignedAgentId, externalMessageId, channel, body, JSON.stringify(metadata)]
      );

      if (insertResult.rowCount > 0) {
        await client.query(
          `UPDATE "Conversations"
              SET last_message_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1::uuid`,
          [conversationId]
        );
      }

      return {
        inserted: insertResult.rowCount > 0
      };
    },

    async beginDispatchAttempt({ messageId, dispatchKey, platform, stage, now }) {
      const attemptResult = await client.query(
        `UPDATE "Messages"
            SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'dispatch',
              jsonb_build_object(
                'key', $2::text,
                'state', 'in_progress',
                'platform', $3::text,
                'stage', $4::text,
                'attempts', COALESCE((COALESCE(metadata, '{}'::jsonb)#>>'{dispatch,attempts}')::int, 0) + 1,
                'lastAttemptAt', $5::timestamptz
              )
            )
          WHERE id = $1::uuid
            AND (
              COALESCE(metadata#>>'{dispatch,key}', '') <> $2::text
              OR COALESCE(metadata#>>'{dispatch,state}', '') NOT IN ('in_progress', 'completed')
            )
          RETURNING COALESCE(metadata->'dispatch', '{}'::jsonb) AS dispatch`,
        [messageId, dispatchKey, platform || "unknown", stage || "dispatch_outbound_message", now || new Date().toISOString()]
      );

      if (attemptResult.rowCount > 0) {
        return {
          shouldDispatch: true,
          duplicate: false,
          state: "in_progress",
          delivery: null
        };
      }

      const existingResult = await client.query(
        `SELECT COALESCE(metadata->'dispatch', '{}'::jsonb) AS dispatch
           FROM "Messages"
          WHERE id = $1::uuid`,
        [messageId]
      );
      const dispatch = existingResult.rows[0]?.dispatch || {};
      return {
        shouldDispatch: false,
        duplicate: true,
        state: dispatch.state || "completed",
        delivery: dispatch.delivery || null
      };
    },

    async completeDispatchAttempt({ messageId, dispatchKey, status, delivery, now }) {
      await client.query(
        `UPDATE "Messages"
            SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'dispatch',
              COALESCE(metadata->'dispatch', '{}'::jsonb) || jsonb_build_object(
                'state', 'completed',
                'status', $3::text,
                'completedAt', $4::timestamptz,
                'delivery', $5::jsonb
              )
            )
          WHERE id = $1::uuid
            AND COALESCE(metadata#>>'{dispatch,key}', '') = $2::text`,
        [messageId, dispatchKey, status, now || new Date().toISOString(), JSON.stringify(delivery || null)]
      );
    },

    async failDispatchAttempt({ messageId, stage, error, now, retry = {} }) {
      const retryExhausted = retry?.retryExhausted === true;
      await client.query(
        `UPDATE "Messages"
            SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'dispatch',
              COALESCE(metadata->'dispatch', '{}'::jsonb) || jsonb_build_object(
                'state', $6::text,
                'failedStage', $2::text,
                'lastError', $3::text,
                'failedAt', $4::timestamptz,
                'retry', $5::jsonb,
                'dlqQueuedAt', CASE WHEN $6::text = 'dlq' THEN $4::timestamptz ELSE NULL END,
                'escalationReason', CASE WHEN $6::text = 'dlq' THEN 'escalate_dispatch_retry_exhausted' ELSE NULL END
              )
            )
          WHERE id = $1::uuid`,
        [
          messageId,
          stage || "dispatch_outbound_message",
          error || "dispatch_failed",
          now || new Date().toISOString(),
          JSON.stringify(retry || {}),
          retryExhausted ? "dlq" : "failed"
        ]
      );
    },

    async markInboundProcessed({ messageId, metadataPatch }) {
      await client.query(
        `UPDATE "Messages"
            SET metadata = (COALESCE(metadata, '{}'::jsonb) - 'workerClaim') || $2::jsonb
          WHERE id = $1::uuid`,
        [messageId, JSON.stringify(metadataPatch)]
      );
    },

    async transitionConversationWorkflow({
      conversationId,
      payload,
      actorType = "worker",
      actorId = null,
      source = "worker",
      messageId = null
    }) {
      const currentResult = await client.query(
        `SELECT id,
                workflow_state,
                workflow_outcome,
                showing_state,
                follow_up_stage,
                follow_up_due_at,
                follow_up_owner_agent_id,
                follow_up_status
           FROM "Conversations"
          WHERE id = $1::uuid
          LIMIT 1`,
        [conversationId]
      );

      if (currentResult.rowCount === 0) {
        return { applied: false, reason: "not_found" };
      }

      const current = currentResult.rows[0];
      const hasWorkflowOutcome = Object.prototype.hasOwnProperty.call(payload, "workflowOutcome");
      const hasShowingState = Object.prototype.hasOwnProperty.call(payload, "showingState");
      const hasFollowUpStage = Object.prototype.hasOwnProperty.call(payload, "followUpStage");
      const hasWorkflowState = Object.prototype.hasOwnProperty.call(payload, "workflowState");

      let nextWorkflowState = hasWorkflowState
        ? payload.workflowState
        : current.workflow_state;

      if (!hasWorkflowState && hasWorkflowOutcome && payload.workflowOutcome) {
        nextWorkflowState = payload.workflowOutcome === "showing_confirmed" ? "showing" : "outcome";
      }

      const nextWorkflowOutcome = hasWorkflowOutcome ? payload.workflowOutcome : current.workflow_outcome;
      const nextShowingState = hasShowingState ? payload.showingState : current.showing_state;
      const nextFollowUpStage = hasFollowUpStage ? payload.followUpStage : current.follow_up_stage;
      const nextFollowUpDueAt = nextFollowUpStage ? current.follow_up_due_at : null;
      const nextFollowUpOwnerAgentId = nextFollowUpStage ? current.follow_up_owner_agent_id : null;
      const nextFollowUpStatus = nextFollowUpStage ? current.follow_up_status : "pending";

      if (!isAllowedTransition(workflowStateTransitionMap, current.workflow_state, nextWorkflowState)) {
        return {
          applied: false,
          reason: "invalid_transition",
          message: `Invalid workflowState transition from ${current.workflow_state} to ${nextWorkflowState}`
        };
      }
      if (!isAllowedTransition(showingStateTransitionMap, current.showing_state, nextShowingState)) {
        return {
          applied: false,
          reason: "invalid_transition",
          message: `Invalid showingState transition from ${current.showing_state} to ${nextShowingState}`
        };
      }

      if (
        current.workflow_state === nextWorkflowState
        && current.workflow_outcome === nextWorkflowOutcome
        && current.showing_state === nextShowingState
        && current.follow_up_stage === nextFollowUpStage
      ) {
        return { applied: false, reason: "no_change" };
      }

      const updatedResult = await client.query(
        `UPDATE "Conversations"
            SET workflow_state = $2,
                workflow_outcome = $3,
                showing_state = $4,
                follow_up_stage = $5,
                follow_up_due_at = $6::timestamptz,
                follow_up_owner_agent_id = $7::uuid,
                follow_up_status = $8,
                workflow_updated_at = NOW(),
                updated_at = NOW()
          WHERE id = $1::uuid
          RETURNING id,
                    workflow_state,
                    workflow_outcome,
                    showing_state,
                    follow_up_stage,
                    follow_up_due_at,
                    follow_up_owner_agent_id,
                    follow_up_status,
                    workflow_updated_at`,
        [
          conversationId,
          nextWorkflowState,
          nextWorkflowOutcome,
          nextShowingState,
          nextFollowUpStage,
          nextFollowUpDueAt,
          nextFollowUpOwnerAgentId,
          nextFollowUpStatus
        ]
      );

      await client.query(
        `INSERT INTO "AuditLogs" (actor_type, actor_id, entity_type, entity_id, action, details)
         VALUES ($1, $2, 'conversation', $3, 'workflow_state_transitioned', $4::jsonb)`,
        [
          actorType,
          actorId,
          String(conversationId),
          JSON.stringify({
            source,
            trigger: "ai_outcome_persistence",
            messageId,
            previous: {
              workflowState: current.workflow_state,
              workflowOutcome: current.workflow_outcome,
              showingState: current.showing_state,
              followUpStage: current.follow_up_stage
            },
            next: {
              workflowState: updatedResult.rows[0].workflow_state,
              workflowOutcome: updatedResult.rows[0].workflow_outcome,
              showingState: updatedResult.rows[0].showing_state,
              followUpStage: updatedResult.rows[0].follow_up_stage
            }
          })
        ]
      );

      return {
        applied: true,
        item: {
          id: updatedResult.rows[0].id,
          workflowState: updatedResult.rows[0].workflow_state,
          workflowOutcome: updatedResult.rows[0].workflow_outcome,
          showingState: updatedResult.rows[0].showing_state,
          followUpStage: updatedResult.rows[0].follow_up_stage,
          followUpDueAt: updatedResult.rows[0].follow_up_due_at,
          followUpOwnerAgentId: updatedResult.rows[0].follow_up_owner_agent_id,
          followUpStatus: updatedResult.rows[0].follow_up_status,
          workflowUpdatedAt: updatedResult.rows[0].workflow_updated_at
        }
      };
    },

    async syncShowingFromWorkflowOutcome({
      conversationId,
      workflowOutcome,
      selectedSlotIndex = null,
      slotCandidates = [],
      inboundBody = null,
      actorType = "worker",
      actorId = null,
      source = "worker",
      messageId = null
    }) {
      if (!conversationId || !workflowOutcome) {
        return { applied: false, reason: "missing_input" };
      }

      const statusMap = {
        showing_confirmed: "confirmed",
        wants_reschedule: "reschedule_requested",
        completed: "completed",
        no_show: "no_show",
        not_interested: "cancelled"
      };
      const nextStatus = statusMap[workflowOutcome] || null;
      if (!nextStatus) {
        return { applied: false, reason: "unsupported_outcome" };
      }

      const conversationResult = await client.query(
        `SELECT c.id,
                c.platform_account_id,
                c.listing_id,
                c.assigned_agent_id,
                l.unit_id
           FROM "Conversations" c
           LEFT JOIN "Listings" l ON l.id = c.listing_id
          WHERE c.id = $1::uuid
          LIMIT 1`,
        [conversationId]
      );

      if (conversationResult.rowCount === 0) {
        return { applied: false, reason: "conversation_not_found" };
      }

      const conversation = conversationResult.rows[0];

      const activeResult = await client.query(
        `SELECT id, status
           FROM "ShowingAppointments"
          WHERE conversation_id = $1::uuid
          ORDER BY starts_at DESC, created_at DESC
          LIMIT 1`,
        [conversationId]
      );

      const existingAppointment = activeResult.rows[0] || null;

      if (nextStatus === "confirmed" && !existingAppointment) {
        const normalizedCandidates = (Array.isArray(slotCandidates) ? slotCandidates : [])
          .map((slot) => normalizeSlotCandidate(slot))
          .filter(Boolean);

        let resolvedCandidates = normalizedCandidates;
        if (resolvedCandidates.length === 0) {
          const unitId = normalizeUuid(conversation.unit_id);
          if (!unitId) {
            return { applied: false, reason: "slot_candidates_unavailable" };
          }

          resolvedCandidates = (await fetchAssignedAgentSlotOptionsInternal({
            unitId,
            assignedAgentId: conversation.assigned_agent_id,
            limit: 6,
            includeAllAssignedAgents: true
          }))
            .map((slot) => normalizeSlotCandidate(slot))
            .filter(Boolean);
        }

        if (resolvedCandidates.length === 0) {
          return { applied: false, reason: "slot_candidates_unavailable" };
        }

        const requestedIndex = Number(selectedSlotIndex);
        const selectedIndex = Number.isInteger(requestedIndex) && requestedIndex >= 1
          ? requestedIndex - 1
          : 0;
        const selectedCandidate = resolvedCandidates[selectedIndex] || resolvedCandidates[0];

        const createResult = await createWorkflowShowingAppointment({
          conversationId,
          conversation,
          slotCandidate: selectedCandidate,
          workflowOutcome,
          source,
          messageId,
          selectedSlotIndex: selectedIndex + 1
        });

        if (!createResult.applied) {
          return createResult;
        }

        await client.query(
          `INSERT INTO "AuditLogs" (actor_type, actor_id, entity_type, entity_id, action, details)
           VALUES ($1, $2, 'showing_appointment', $3, 'showing_workflow_outcome_synced', $4::jsonb)`,
          [
            actorType,
            actorId,
            String(createResult.appointmentId),
            JSON.stringify({
              conversationId,
              workflowOutcome,
              previousStatus: null,
              nextStatus: "confirmed",
              source,
              messageId,
              selectedSlotIndex: selectedIndex + 1,
              inboundBody: typeof inboundBody === "string" ? inboundBody : null,
              autoCreated: true
            })
          ]
        );

        return {
          applied: true,
          appointmentId: createResult.appointmentId,
          status: createResult.status || "confirmed",
          autoCreated: true
        };
      }

      if (activeResult.rowCount === 0) {
        return { applied: false, reason: "appointment_not_found" };
      }

      const appointment = activeResult.rows[0];
      if (appointment.status === nextStatus) {
        return { applied: false, reason: "no_change", appointmentId: appointment.id };
      }

      await client.query(
        `UPDATE "ShowingAppointments"
            SET status = $2,
                metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
                updated_at = NOW()
          WHERE id = $1::uuid`,
        [
          appointment.id,
          nextStatus,
          JSON.stringify({
            workflowOutcome,
            workflowSyncedAt: new Date().toISOString(),
            workflowSource: source,
            workflowMessageId: messageId || null
          })
        ]
      );

      await client.query(
        `INSERT INTO "AuditLogs" (actor_type, actor_id, entity_type, entity_id, action, details)
         VALUES ($1, $2, 'showing_appointment', $3, 'showing_workflow_outcome_synced', $4::jsonb)`,
        [
          actorType,
          actorId,
          String(appointment.id),
          JSON.stringify({
            conversationId,
            workflowOutcome,
            previousStatus: appointment.status,
            nextStatus,
            source,
            messageId,
            selectedSlotIndex: Number.isFinite(Number(selectedSlotIndex)) ? Number(selectedSlotIndex) : null,
            inboundBody: typeof inboundBody === "string" ? inboundBody : null,
            autoCreated: false
          })
        ]
      );

      return {
        applied: true,
        appointmentId: appointment.id,
        status: nextStatus
      };
    },

    async recordLog({ actorType, entityType, entityId, action, details }) {
      await client.query(
        `INSERT INTO "AuditLogs" (actor_type, entity_type, entity_id, action, details)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [actorType, entityType, String(entityId), action, JSON.stringify(details || {})]
      );
    },

    async dispatchOutboundMessage({ platformAccountId, platform, platformCredentials, externalThreadId, body }) {
      if (!platformAccountId || !platform || !externalThreadId || !body) {
        return null;
      }

      const registry = getConnectorRegistry();
      return registry.sendMessageForAccount({
        account: {
          id: platformAccountId,
          platform,
          credentials: platformCredentials || {}
        },
        outbound: {
          externalThreadId,
          body
        }
      });
    },

    async syncConversationThread({ conversationId }) {
      if (!conversationId) {
        return { synced: false, reason: "missing_conversation_id" };
      }

      const conversationResult = await client.query(
        `SELECT c.id,
                c.platform_account_id,
                c.external_thread_id,
                c.last_message_at,
                c.created_at,
                pa.platform,
                pa.credentials
           FROM "Conversations" c
           JOIN "PlatformAccounts" pa ON pa.id = c.platform_account_id
          WHERE c.id = $1::uuid
          LIMIT 1`,
        [conversationId]
      );

      if (conversationResult.rowCount === 0) {
        return { synced: false, reason: "not_found" };
      }

      const conversation = conversationResult.rows[0];
      const platform = conversation.platform;
      const externalThreadId = conversation.external_thread_id;
      const platformAccountId = conversation.platform_account_id;
      if (!platform || !externalThreadId || !platformAccountId) {
        return { synced: false, reason: "missing_platform_details" };
      }

      const registry = getConnectorRegistry();
      const threadMessages = await registry.syncThreadForAccount({
        account: {
          id: platformAccountId,
          platform,
          credentials: conversation.credentials || {}
        },
        externalThreadId
      });

      const messages = Array.isArray(threadMessages) ? threadMessages : [];
      if (messages.length === 0) {
        return { synced: true, scanned: 0, inserted: 0, updated: 0, skipped: 0 };
      }

      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      let discoveredListingExternalId = null;
      let discoveredThreadLabel = null;
      let discoveredLeadName = null;

      await client.query("BEGIN");
      try {
        for (const message of messages) {
          const externalMessageId = typeof message?.externalMessageId === "string"
            ? message.externalMessageId.trim()
            : typeof message?.external_message_id === "string"
            ? message.external_message_id.trim()
            : "";
          if (!externalMessageId) {
            skipped += 1;
            continue;
          }

          const direction = message.direction === "outbound" ? "outbound" : "inbound";
          const senderType = direction === "outbound" ? "agent" : "lead";
          const channel = message.channel || "in_app";
          const body = message.body || "";
          const metadata = message.metadata || {};
          discoveredListingExternalId = discoveredListingExternalId
            || pickFirstNonEmptyString(
              message?.listingExternalId,
              metadata?.listingExternalId,
              metadata?.listing_external_id,
              metadata?.context?.listingExternalId,
              metadata?.context?.listing_external_id
            );
          discoveredThreadLabel = discoveredThreadLabel
            || pickFirstNonEmptyString(
              message?.threadLabel,
              metadata?.threadLabel,
              metadata?.thread_label,
              metadata?.inbox?.threadLabel,
              metadata?.context?.threadLabel,
              metadata?.context?.thread_label
            );
          discoveredLeadName = discoveredLeadName
            || pickFirstNonEmptyString(
              message?.leadName,
              metadata?.leadName,
              metadata?.lead_name,
              metadata?.context?.leadName,
              metadata?.context?.lead_name
            );
          const sentAt = normalizeTimestampValue(message.sentAt)
            || normalizeTimestampValue(conversation.last_message_at)
            || normalizeTimestampValue(conversation.created_at);
          if (!sentAt) {
            skipped += 1;
            continue;
          }

          const upsertResult = await client.query(
            `INSERT INTO "Messages" (
               conversation_id,
               sender_type,
               sender_agent_id,
               external_message_id,
               direction,
               channel,
               body,
               metadata,
               sent_at
             ) VALUES ($1::uuid, $2, NULL, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
             ON CONFLICT (conversation_id, external_message_id)
             DO UPDATE SET
               body = CASE
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_inbox'
                   AND COALESCE("Messages".metadata->>'sentAtSource', '') = 'platform_thread'
                 THEN "Messages".body
                 ELSE EXCLUDED.body
               END,
               channel = CASE
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_inbox'
                   AND COALESCE("Messages".metadata->>'sentAtSource', '') = 'platform_thread'
                 THEN "Messages".channel
                 ELSE EXCLUDED.channel
               END,
               direction = CASE
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_inbox'
                   AND COALESCE("Messages".metadata->>'sentAtSource', '') = 'platform_thread'
                 THEN "Messages".direction
                 ELSE EXCLUDED.direction
               END,
               metadata = CASE
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_inbox'
                   AND COALESCE("Messages".metadata->>'sentAtSource', '') = 'platform_thread'
                 THEN "Messages".metadata
                 ELSE COALESCE("Messages".metadata, '{}'::jsonb) || EXCLUDED.metadata
               END,
               sent_at = CASE
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_thread' THEN EXCLUDED.sent_at
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_inbox'
                   AND COALESCE("Messages".metadata->>'sentAtSource', '') <> 'platform_thread'
                 THEN CASE
                   WHEN COALESCE(EXCLUDED.metadata->>'sentAtHasTime', 'false') = 'true' THEN EXCLUDED.sent_at
                   ELSE "Messages".sent_at
                 END
                 ELSE "Messages".sent_at
               END
             WHERE
               "Messages".body IS DISTINCT FROM EXCLUDED.body
               OR "Messages".channel IS DISTINCT FROM EXCLUDED.channel
               OR "Messages".direction IS DISTINCT FROM EXCLUDED.direction
               OR "Messages".metadata IS DISTINCT FROM (COALESCE("Messages".metadata, '{}'::jsonb) || EXCLUDED.metadata)
               OR "Messages".sent_at IS DISTINCT FROM CASE
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_thread' THEN EXCLUDED.sent_at
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_inbox'
                   AND COALESCE("Messages".metadata->>'sentAtSource', '') <> 'platform_thread'
                 THEN CASE
                   WHEN COALESCE(EXCLUDED.metadata->>'sentAtHasTime', 'false') = 'true' THEN EXCLUDED.sent_at
                   ELSE "Messages".sent_at
                 END
                 ELSE "Messages".sent_at
               END
             RETURNING id, (xmax = 0) AS inserted`,
            [
              conversationId,
              senderType,
              externalMessageId,
              direction,
              channel,
              body,
              JSON.stringify(metadata),
              sentAt
            ]
          );

          if (upsertResult.rowCount === 0) {
            continue;
          }
          if (upsertResult.rows[0]?.inserted) {
            inserted += 1;
          } else {
            updated += 1;
          }
        }

        // Inbox preview rows are useful for fast list ingest, but once a thread sync succeeds
        // we prefer canonical thread rows in detail views to avoid truncated/partial duplicates.
        // Roomies preview ids use a `preview-` prefix and may fall back to clock timestamps,
        // so remove them explicitly as well.
        await client.query(
          `DELETE FROM "Messages"
            WHERE conversation_id = $1::uuid
              AND (
                COALESCE(metadata->>'sentAtSource', '') = 'platform_inbox'
                OR external_message_id LIKE 'preview-%'
              )`,
          [conversationId]
        );

        // Roomies parser now uses platform-native message ids when available (Alpine runtime state).
        // Older runs may have left fallback token ids for the same message body/signature.
        // Keep one canonical row per canonical signature, preferring numeric native ids.
        if (platform === "roomies") {
          await client.query(
            `WITH ranked AS (
               SELECT id,
                      ROW_NUMBER() OVER (
                        PARTITION BY conversation_id,
                                     direction,
                                     COALESCE(NULLIF(TRIM(body), ''), '__empty__'),
                                     COALESCE(
                                       NULLIF(
                                         LOWER(REGEXP_REPLACE(COALESCE(metadata->>'sentAtText', ''), '\\s+', ' ', 'g')),
                                         ''
                                       ),
                                       '__no_sent_at_text__'
                                     )
                        ORDER BY
                          CASE
                            WHEN COALESCE(external_message_id, '') ~ '^[0-9]+$' THEN 0
                            ELSE 1
                          END ASC,
                          created_at DESC,
                          id DESC
                      ) AS rn
                FROM "Messages"
                WHERE conversation_id = $1::uuid
                  AND COALESCE(metadata->>'sentAtSource', '') = 'platform_thread'
             )
             DELETE FROM "Messages" m
              USING ranked
              WHERE m.id = ranked.id
                AND ranked.rn > 1`,
            [conversationId]
          );

          // If we have canonical roomies thread rows, remove legacy outbound send fallbacks
          // (non-numeric external ids) with the same body so the UI does not show duplicates.
          await client.query(
            `DELETE FROM "Messages" m
              WHERE m.conversation_id = $1::uuid
                AND m.direction = 'outbound'
                AND COALESCE(m.external_message_id, '') !~ '^[0-9]+$'
                AND EXISTS (
                  SELECT 1
                    FROM "Messages" canonical
                   WHERE canonical.conversation_id = m.conversation_id
                     AND canonical.direction = 'outbound'
                     AND COALESCE(canonical.external_message_id, '') ~ '^[0-9]+$'
                     AND COALESCE(NULLIF(TRIM(LOWER(canonical.body)), ''), '__empty__')
                         = COALESCE(NULLIF(TRIM(LOWER(m.body)), ''), '__empty__')
                     AND COALESCE(canonical.metadata->>'sentAtSource', '') = 'platform_thread'
                )`,
            [conversationId]
          );
        }

        let resolvedListingId = normalizeUuid(conversation.listing_id);
        if (!resolvedListingId && discoveredListingExternalId) {
          const linkage = await resolveInboundListingLinkage(client, platformAccountId, {
            listingExternalId: discoveredListingExternalId,
            metadata: {
              listingExternalId: discoveredListingExternalId
            }
          });
          resolvedListingId = normalizeUuid(linkage?.listingId);
        }

        await client.query(
          `UPDATE "Conversations"
              SET listing_id = COALESCE(listing_id, $2::uuid),
                  external_thread_label = CASE
                    WHEN NULLIF($3::text, '') IS NOT NULL THEN $3::text
                    ELSE external_thread_label
                  END,
                  lead_name = COALESCE(NULLIF($4::text, ''), lead_name),
                  updated_at = NOW()
            WHERE id = $1::uuid`,
          [
            conversationId,
            resolvedListingId,
            discoveredThreadLabel,
            discoveredLeadName
          ]
        );

        await client.query(
          `UPDATE "Conversations" c
              SET last_message_at = latest.max_sent_at,
                  updated_at = NOW()
             FROM (
               SELECT MAX(sent_at) AS max_sent_at
                 FROM "Messages"
                WHERE conversation_id = $1::uuid
             ) latest
            WHERE c.id = $1::uuid
              AND latest.max_sent_at IS NOT NULL
              AND (c.last_message_at IS NULL OR latest.max_sent_at > c.last_message_at)`,
          [conversationId]
        );

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }

      return {
        synced: true,
        scanned: messages.length,
        inserted,
        updated,
        skipped
      };
    },

    async syncPlatformListings({ platforms = null } = {}) {
      const registry = getConnectorRegistry();
      const platformList = Array.isArray(platforms)
        ? platforms
        : typeof platforms === "string"
        ? parseCsvEnv(platforms)
        : null;

      const where = ["is_active = TRUE"];
      const params = [];
      if (platformList && platformList.length > 0) {
        params.push(platformList);
        where.push(`platform = ANY($${params.length}::text[])`);
      }

      const accountsResult = await client.query(
        `SELECT id, platform, credentials
           FROM "PlatformAccounts"
          WHERE ${where.join(" AND ")}
          ORDER BY platform ASC, created_at ASC`,
        params
      );

      const summaries = [];

      for (const account of accountsResult.rows) {
        const platform = account.platform;
        const platformAccountId = account.id;
        let listings;
        try {
          listings = await registry.syncListingsForAccount({
            account: {
              id: platformAccountId,
              platform,
              credentials: account.credentials || {}
            }
          });
        } catch (error) {
          summaries.push({
            platform,
            platformAccountId,
            fetched: 0,
            inserted: 0,
            updated: 0,
            skipped: 0,
            error: error instanceof Error ? error.message : String(error)
          });
          continue;
        }

        const fetched = Array.isArray(listings) ? listings.length : 0;
        let inserted = 0;
        let updated = 0;
        let skipped = 0;

        await client.query("BEGIN");
        try {
          for (const rawListing of Array.isArray(listings) ? listings : []) {
            const listingExternalId = typeof rawListing?.listingExternalId === "string"
              ? rawListing.listingExternalId.trim()
              : typeof rawListing?.listing_external_id === "string"
              ? rawListing.listing_external_id.trim()
              : "";
            if (!listingExternalId) {
              skipped += 1;
              continue;
            }

            const title = typeof rawListing?.title === "string" ? rawListing.title.trim() : "";
            const location = typeof rawListing?.location === "string" ? rawListing.location.trim() : "";
            const priceText = typeof rawListing?.priceText === "string" ? rawListing.priceText.trim() : "";
            const status = rawListing?.status === "active" ? "active" : "inactive";
            const currencyCode = "USD";
            const unitSyncKey = buildUnitSyncKey(platformAccountId, title, location);
            const generatedUnitNumber = buildGeneratedUnitNumber(unitSyncKey, listingExternalId);

            const lookup = await client.query(
              `SELECT id, unit_id, rent_cents
                 FROM "Listings"
                WHERE platform_account_id = $1::uuid
                  AND listing_external_id = $2
                LIMIT 1`,
              [platformAccountId, listingExternalId]
            );

            let unitId = lookup.rows?.[0]?.unit_id || null;
            const existingRentCents = lookup.rows?.[0]?.rent_cents ?? null;

            if (!unitId && unitSyncKey) {
              const existingUnit = await client.query(
                `SELECT id
                   FROM "Units"
                  WHERE external_id = $1
                  LIMIT 1`,
                [unitSyncKey]
              );
              unitId = existingUnit.rows?.[0]?.id || null;
            }

            if (unitId) {
              await client.query(
                `UPDATE "Units"
                    SET property_name = COALESCE(NULLIF($2, ''), property_name),
                        is_active = $3::boolean,
                        external_id = COALESCE(external_id, NULLIF($4, '')),
                        updated_at = NOW()
                  WHERE id = $1::uuid`,
                [unitId, title, status === "active", unitSyncKey]
              );
            } else {
              const unitInsert = await client.query(
                `INSERT INTO "Units" (external_id, property_name, unit_number, is_active)
                 VALUES ($1, $2, $3, $4::boolean)
                 ON CONFLICT (property_name, unit_number) DO UPDATE
                 SET is_active = EXCLUDED.is_active,
                     external_id = COALESCE("Units".external_id, EXCLUDED.external_id),
                     updated_at = NOW()
                 RETURNING id`,
                [unitSyncKey, title || `Listing ${listingExternalId}`, generatedUnitNumber, status === "active"]
              );
              unitId = unitInsert.rows?.[0]?.id || null;
            }

            if (!unitId) {
              skipped += 1;
              continue;
            }

            const rentCents = parseRentCentsFromText(priceText) ?? existingRentCents ?? 0;
            const metadata = {
              title: title || null,
              location: location || null,
              priceText: priceText || null,
              href: typeof rawListing?.href === "string" ? rawListing.href : null,
              headerText: typeof rawListing?.headerText === "string" ? rawListing.headerText : null,
              statusClasses: Array.isArray(rawListing?.statusClasses) ? rawListing.statusClasses : null,
              source: "rpa_listing_sync",
              syncedAt: new Date().toISOString()
            };

            const listingResult = await client.query(
              `INSERT INTO "Listings" (
                 unit_id,
                 platform_account_id,
                 listing_external_id,
                 status,
                 rent_cents,
                 currency_code,
                 available_on,
                 metadata
               ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, NULL, $7::jsonb)
               ON CONFLICT (platform_account_id, listing_external_id) DO UPDATE
               SET unit_id = EXCLUDED.unit_id,
                   status = EXCLUDED.status,
                   rent_cents = EXCLUDED.rent_cents,
                   currency_code = EXCLUDED.currency_code,
                   metadata = COALESCE(\"Listings\".metadata, '{}'::jsonb) || EXCLUDED.metadata,
                   updated_at = NOW()
               RETURNING id, (xmax = 0) AS inserted`,
              [unitId, platformAccountId, listingExternalId, status, rentCents, currencyCode, JSON.stringify(metadata)]
            );

            if (listingResult.rowCount > 0 && listingResult.rows[0].inserted) {
              inserted += 1;
            } else {
              updated += 1;
            }
          }

          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }

        summaries.push({
          platform,
          platformAccountId,
          fetched,
          inserted,
          updated,
          skipped
        });
      }

      return {
        ok: true,
        platforms: platformList || listSupportedPlatforms(),
        accounts: summaries
      };
    },

    async ingestInboundMessages({ limit = 50, platforms = null } = {}) {
      const registry = getConnectorRegistry();
      const activeAccounts = await client.query(
        `SELECT id, platform, account_external_id, credentials
           FROM "PlatformAccounts"
          WHERE is_active = TRUE`
      );

      let ingested = 0;
      let scanned = 0;
      const threadSyncEnabled = process.env.WORKER_THREAD_SYNC_ON_NEW_INBOUND === "1";
      const threadSyncPlatforms = process.env.WORKER_THREAD_SYNC_PLATFORMS
        ? process.env.WORKER_THREAD_SYNC_PLATFORMS.split(",").map((value) => value.trim()).filter(Boolean)
        : ["spareroom", "roomies", "leasebreak"];
      const threadSyncMaxPerCycle = Number(process.env.WORKER_THREAD_SYNC_MAX_PER_CYCLE || 2);
      let threadSyncUsed = 0;

      for (const account of activeAccounts.rows) {
        if (platforms && !platforms.includes(account.platform)) {
          continue;
        }

        let inboundMessages = [];
        try {
          inboundMessages = await registry.ingestMessagesForAccount(account);
        } catch (error) {
          console.warn("[ingest] failed ingesting messages for account", {
            platform: account.platform,
            accountId: account.id,
            error: error instanceof Error ? error.message : String(error)
          });
          continue;
        }

        const inboundWindow = inboundMessages.slice(0, limit);

        // Inbox sort rank is only valid for threads present in the current inbox snapshot.
        // When we limit scanned threads (e.g. to 20), previously-seen ranks become stale and can
        // incorrectly float older conversations to the top. Clear ranks for threads not present now.
        const hasInboxSortRanks = Array.isArray(inboundWindow)
          && inboundWindow.some((msg) => Number.isFinite(Number(msg?.inboxSortRank)));
        if (hasInboxSortRanks) {
          const seenThreadIds = [...new Set(inboundWindow.map((msg) => msg?.externalThreadId).filter(Boolean))];
          if (seenThreadIds.length > 0) {
            await client.query(
              `UPDATE "Conversations"
                  SET external_inbox_sort_rank = NULL
                WHERE platform_account_id = $1::uuid
                  AND external_inbox_sort_rank IS NOT NULL
                  AND NOT (external_thread_id = ANY($2::text[]))`,
              [account.id, seenThreadIds]
            );
          }

          // Optional dev-only behavior: archive conversations that disappear from the platform inbox,
          // but only for allowlisted lead names to avoid accidental churn on real leads.
          // Keep this scoped to SpareRoom for now until other platforms are validated in production.
          if (
            account.platform === "spareroom"
            && process.env.NODE_ENV !== "production"
            && process.env.LEASE_BOT_DEV_ARCHIVE_MISSING_THREADS === "1"
          ) {
            const allowlistedLeads = parseCsvEnv(process.env.WORKER_AUTOREPLY_ALLOW_LEAD_NAMES);
            if (allowlistedLeads.length > 0 && seenThreadIds.length > 0) {
              const archived = await client.query(
                `UPDATE "Conversations"
                    SET status = 'archived',
                        external_inbox_sort_rank = NULL,
                        updated_at = NOW()
                  WHERE platform_account_id = $1::uuid
                    AND status = 'open'
                    AND lead_name = ANY($2::text[])
                    AND NOT (external_thread_id = ANY($3::text[]))
                  RETURNING id, lead_name, external_thread_id`,
                [account.id, allowlistedLeads, seenThreadIds]
              );

              for (const row of archived.rows) {
                await client.query(
                  `INSERT INTO "AuditLogs" (actor_type, entity_type, entity_id, action, details)
                   VALUES ('system', 'conversation', $1, $2, $3::jsonb)`,
                  [
                    String(row.id),
                    "conversation_archived_missing_from_inbox",
                    JSON.stringify({
                      platform: account.platform,
                      platformAccountId: account.id,
                      leadName: row.lead_name || null,
                      externalThreadId: row.external_thread_id || null
                    })
                  ]
                );
              }
            }
          }
        }
        scanned += inboundMessages.length;

        for (const inbound of inboundWindow) {
          const linkage = await resolveInboundListingLinkage(client, account.id, inbound);
          const conversationResult = await client.query(
            `INSERT INTO "Conversations" (
               platform_account_id,
               listing_id,
               external_thread_id,
               lead_name,
               lead_contact,
               external_thread_label,
               external_thread_message_count,
               external_inbox_sort_rank,
               status,
               last_message_at
             ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7::int, $8::int, 'open', $9::timestamptz)
             ON CONFLICT (platform_account_id, external_thread_id)
             DO UPDATE SET
               listing_id = COALESCE("Conversations".listing_id, EXCLUDED.listing_id),
               status = CASE WHEN "Conversations".status = 'archived' THEN 'open' ELSE "Conversations".status END,
               lead_name = COALESCE(EXCLUDED.lead_name, "Conversations".lead_name),
               lead_contact = CASE
                 WHEN "Conversations".lead_contact IS NULL OR "Conversations".lead_contact = '{}'::jsonb THEN EXCLUDED.lead_contact
                 ELSE "Conversations".lead_contact
               END,
               external_thread_label = CASE
                 WHEN EXCLUDED.external_thread_label IS NOT NULL AND EXCLUDED.external_thread_label <> '' THEN EXCLUDED.external_thread_label
                 ELSE "Conversations".external_thread_label
               END,
               external_thread_message_count = CASE
                 WHEN EXCLUDED.external_thread_message_count IS NOT NULL THEN EXCLUDED.external_thread_message_count
                 ELSE "Conversations".external_thread_message_count
               END,
               external_inbox_sort_rank = CASE
                 WHEN EXCLUDED.external_inbox_sort_rank IS NOT NULL THEN EXCLUDED.external_inbox_sort_rank
                 ELSE "Conversations".external_inbox_sort_rank
               END,
               last_message_at = COALESCE("Conversations".last_message_at, EXCLUDED.last_message_at)
             RETURNING id, listing_id, (xmax = 0) AS inserted`,
            [
              account.id,
              linkage.listingId,
              inbound.externalThreadId,
              inbound.leadName,
              JSON.stringify(inbound.leadContact || {}),
              inbound.threadLabel || null,
              Number.isFinite(Number(inbound.threadMessageCount)) ? Number(inbound.threadMessageCount) : null,
              Number.isFinite(Number(inbound.inboxSortRank)) ? Number(inbound.inboxSortRank) : null,
              inbound.sentAt
            ]
          );

          const conversation = conversationResult.rows[0];
          const conversationId = conversation.id;
          const conversationInserted = Boolean(conversation.inserted);

          const direction = inbound.direction === "outbound" ? "outbound" : "inbound";
          const senderType = direction === "outbound" ? "agent" : "lead";
          const upsertResult = await client.query(
            `INSERT INTO "Messages" (
               conversation_id,
               sender_type,
               external_message_id,
               direction,
               channel,
               body,
               metadata,
               sent_at
             ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
             ON CONFLICT (conversation_id, external_message_id)
             DO UPDATE SET
               body = CASE
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_inbox'
                   AND COALESCE("Messages".metadata->>'sentAtSource', '') = 'platform_thread'
                 THEN "Messages".body
                 ELSE EXCLUDED.body
               END,
               channel = CASE
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_inbox'
                   AND COALESCE("Messages".metadata->>'sentAtSource', '') = 'platform_thread'
                 THEN "Messages".channel
                 ELSE EXCLUDED.channel
               END,
               direction = CASE
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_inbox'
                   AND COALESCE("Messages".metadata->>'sentAtSource', '') = 'platform_thread'
                 THEN "Messages".direction
                 ELSE EXCLUDED.direction
               END,
               metadata = CASE
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_inbox'
                   AND COALESCE("Messages".metadata->>'sentAtSource', '') = 'platform_thread'
                 THEN "Messages".metadata
                 ELSE COALESCE("Messages".metadata, '{}'::jsonb) || EXCLUDED.metadata
               END,
               sent_at = CASE
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_thread' THEN EXCLUDED.sent_at
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_inbox'
                   AND COALESCE("Messages".metadata->>'sentAtSource', '') <> 'platform_thread'
                 THEN CASE
                   WHEN COALESCE(EXCLUDED.metadata->>'sentAtHasTime', 'false') = 'true' THEN EXCLUDED.sent_at
                   ELSE "Messages".sent_at
                 END
                 ELSE "Messages".sent_at
               END
             WHERE
               "Messages".body IS DISTINCT FROM CASE
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_inbox'
                   AND COALESCE("Messages".metadata->>'sentAtSource', '') = 'platform_thread'
                 THEN "Messages".body
                 ELSE EXCLUDED.body
               END
               OR "Messages".channel IS DISTINCT FROM CASE
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_inbox'
                   AND COALESCE("Messages".metadata->>'sentAtSource', '') = 'platform_thread'
                 THEN "Messages".channel
                 ELSE EXCLUDED.channel
               END
               OR "Messages".direction IS DISTINCT FROM CASE
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_inbox'
                   AND COALESCE("Messages".metadata->>'sentAtSource', '') = 'platform_thread'
                 THEN "Messages".direction
                 ELSE EXCLUDED.direction
               END
               OR "Messages".metadata IS DISTINCT FROM CASE
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_inbox'
                   AND COALESCE("Messages".metadata->>'sentAtSource', '') = 'platform_thread'
                 THEN "Messages".metadata
                 ELSE COALESCE("Messages".metadata, '{}'::jsonb) || EXCLUDED.metadata
               END
               OR "Messages".sent_at IS DISTINCT FROM CASE
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_thread' THEN EXCLUDED.sent_at
                 WHEN EXCLUDED.metadata->>'sentAtSource' = 'platform_inbox'
                   AND COALESCE("Messages".metadata->>'sentAtSource', '') <> 'platform_thread'
                 THEN CASE
                   WHEN COALESCE(EXCLUDED.metadata->>'sentAtHasTime', 'false') = 'true' THEN EXCLUDED.sent_at
                   ELSE "Messages".sent_at
                 END
                 ELSE "Messages".sent_at
               END
             RETURNING id, (xmax = 0) AS inserted`,
            [
              conversationId,
              senderType,
              inbound.externalMessageId,
              direction,
              inbound.channel,
              inbound.body,
              JSON.stringify(inbound.metadata || {}),
              inbound.sentAt
            ]
          );

          const messageChanged = upsertResult.rowCount > 0;
          const messageInserted = Boolean(upsertResult.rows[0]?.inserted);

          if (messageChanged) {
            await client.query(
              `UPDATE "Conversations" c
                  SET last_message_at = latest.max_sent_at,
                      updated_at = NOW()
                 FROM (
                   SELECT MAX(sent_at) AS max_sent_at
                     FROM "Messages"
                    WHERE conversation_id = $1::uuid
                 ) latest
                WHERE c.id = $1::uuid
                  AND latest.max_sent_at IS NOT NULL
                  AND (c.last_message_at IS NULL OR latest.max_sent_at > c.last_message_at)`,
              [conversationId]
            );
          }

          if (messageInserted) {
            const linkageAuditAction = linkage.resolved
              ? "ingest_conversation_linkage_resolved"
              : "ingest_conversation_linkage_unresolved";
            const linkagePreserved = Boolean(linkage.listingId && conversation.listing_id && linkage.listingId !== conversation.listing_id);

            await client.query(
              `INSERT INTO "AuditLogs" (actor_type, entity_type, entity_id, action, details)
               VALUES ('system', 'conversation', $1, $2, $3::jsonb)`,
              [
                String(conversationId),
                linkageAuditAction,
                JSON.stringify({
                  externalThreadId: inbound.externalThreadId || null,
                  externalMessageId: inbound.externalMessageId || null,
                  linkage: {
                    resolved: linkage.resolved,
                    strategy: linkage.strategy,
                    attempted: linkage.context,
                    matchedListingId: linkage.listingId,
                    matchedUnitId: linkage.unitId,
                    appliedListingId: conversation.listing_id || null,
                    preservedExistingListing: linkagePreserved
                  }
                })
              ]
            );
          }

          if (messageInserted) {
            ingested += 1;
          }

          if (
            threadSyncEnabled
            && messageInserted
            && !conversationInserted
            && threadSyncUsed < threadSyncMaxPerCycle
            && threadSyncPlatforms.includes(account.platform)
          ) {
            threadSyncUsed += 1;
            try {
              await this.syncConversationThread({ conversationId });
            } catch (error) {
              console.warn("[ingest] thread sync failed", {
                platform: account.platform,
                accountId: account.id,
                conversationId,
                error: error instanceof Error ? error.message : String(error)
              });
            }
          }
        }
      }

      return {
        scanned,
        ingested,
        platforms: platforms || listSupportedPlatforms()
      };
    }
  };
}

export {
  createConnectorRegistry,
  listSupportedPlatforms,
  resolvePlatformCredentials,
  createPlaywrightRpaRunner,
  createRpaRunner,
  createRpaAlertDispatcher,
  createPlatformAdapterRegistry,
  REQUIRED_RPA_PLATFORMS,
  withRetry,
  isRetryableError,
  calculateBackoffDelay
};
