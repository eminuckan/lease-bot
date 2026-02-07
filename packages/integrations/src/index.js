import { runReplyPipeline } from "../../ai/src/index.js";
import { createConnectorRegistry, listSupportedPlatforms, resolvePlatformCredentials } from "./connectors.js";
import { createPlaywrightRpaRunner, createRpaRunner } from "./rpa-runner.js";
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
                    'workerId', $3,
                    'claimedAt', $2,
                    'claimExpiresAt', $4
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
        hasRecentOutbound: Boolean(row.has_recent_outbound)
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

    async fetchAssignedAgentSlotOptions({ unitId, assignedAgentId, limit = 3 }) {
      if (!unitId || !assignedAgentId) {
        return [];
      }

      const result = await client.query(
        `SELECT GREATEST(unit_slot.starts_at, agent_slot.starts_at) AS starts_at,
                LEAST(unit_slot.ends_at, agent_slot.ends_at) AS ends_at,
                COALESCE(unit_slot.timezone, agent_slot.timezone, 'UTC') AS timezone
           FROM "UnitAgentAssignments" ua
           JOIN "AvailabilitySlots" unit_slot
             ON unit_slot.unit_id = ua.unit_id
            AND unit_slot.status = 'open'
           JOIN "AgentAvailabilitySlots" agent_slot
             ON agent_slot.agent_id = ua.agent_id
            AND agent_slot.status = 'available'
          WHERE ua.unit_id = $1::uuid
            AND ua.agent_id = $2::uuid
            AND ua.assignment_mode = 'active'
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
          ORDER BY starts_at ASC
          LIMIT $3`,
        [unitId, assignedAgentId, limit]
      );

      return result.rows;
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
                'key', $2,
                'state', 'in_progress',
                'platform', $3,
                'stage', $4,
                'attempts', COALESCE((COALESCE(metadata, '{}'::jsonb)#>>'{dispatch,attempts}')::int, 0) + 1,
                'lastAttemptAt', $5
              )
            )
          WHERE id = $1::uuid
            AND (
              COALESCE(metadata#>>'{dispatch,key}', '') <> $2
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
                'status', $3,
                'completedAt', $4,
                'delivery', $5::jsonb
              )
            )
          WHERE id = $1::uuid
            AND COALESCE(metadata#>>'{dispatch,key}', '') = $2`,
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
                'state', $6,
                'failedStage', $2,
                'lastError', $3,
                'failedAt', $4,
                'retry', $5::jsonb,
                'dlqQueuedAt', CASE WHEN $6 = 'dlq' THEN $4 ELSE NULL END,
                'escalationReason', CASE WHEN $6 = 'dlq' THEN 'escalate_dispatch_retry_exhausted' ELSE NULL END
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
         VALUES ($1, $2::uuid, 'conversation', $3, 'workflow_state_transitioned', $4::jsonb)`,
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

    async ingestInboundMessages({ limit = 50, platforms = null } = {}) {
      const registry = getConnectorRegistry();
      const activeAccounts = await client.query(
        `SELECT id, platform, account_external_id, credentials
           FROM "PlatformAccounts"
          WHERE is_active = TRUE`
      );

      let ingested = 0;
      let scanned = 0;

      for (const account of activeAccounts.rows) {
        if (platforms && !platforms.includes(account.platform)) {
          continue;
        }

        const inboundMessages = await registry.ingestMessagesForAccount(account);
        scanned += inboundMessages.length;

        for (const inbound of inboundMessages.slice(0, limit)) {
          const linkage = await resolveInboundListingLinkage(client, account.id, inbound);
          const conversationResult = await client.query(
            `INSERT INTO "Conversations" (
               platform_account_id,
               listing_id,
               external_thread_id,
               lead_name,
               lead_contact,
               status,
               last_message_at
             ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, 'open', $6::timestamptz)
             ON CONFLICT (platform_account_id, external_thread_id)
             DO UPDATE SET
               listing_id = COALESCE("Conversations".listing_id, EXCLUDED.listing_id),
               lead_name = COALESCE(EXCLUDED.lead_name, "Conversations".lead_name),
               lead_contact = COALESCE(EXCLUDED.lead_contact, "Conversations".lead_contact),
               last_message_at = EXCLUDED.last_message_at,
               updated_at = NOW()
             RETURNING id, listing_id`,
            [
              account.id,
              linkage.listingId,
              inbound.externalThreadId,
              inbound.leadName,
              JSON.stringify(inbound.leadContact || {}),
              inbound.sentAt
            ]
          );

          const conversation = conversationResult.rows[0];
          const conversationId = conversation.id;
          const insertResult = await client.query(
            `INSERT INTO "Messages" (
               conversation_id,
               sender_type,
               external_message_id,
               direction,
               channel,
               body,
               metadata,
               sent_at
             ) VALUES ($1::uuid, 'lead', $2, 'inbound', $3, $4, $5::jsonb, $6::timestamptz)
             ON CONFLICT (conversation_id, external_message_id) DO NOTHING`,
            [conversationId, inbound.externalMessageId, inbound.channel, inbound.body, JSON.stringify(inbound.metadata || {}), inbound.sentAt]
          );

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

          if (insertResult.rowCount > 0) {
            ingested += 1;
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
  createPlatformAdapterRegistry,
  REQUIRED_RPA_PLATFORMS,
  withRetry,
  isRetryableError,
  calculateBackoffDelay
};
