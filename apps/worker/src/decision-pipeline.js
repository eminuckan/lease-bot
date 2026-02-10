import { classifyIntent, detectFollowUp, runReplyPipelineWithAI } from "../../../packages/ai/src/index.js";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

let cachedPlaybookText = null;
let cachedPlaybookPath = null;

async function loadAiPlaybook() {
  const inline = process.env.WORKER_AI_PLAYBOOK;
  const path = process.env.WORKER_AI_PLAYBOOK_PATH;

  if (typeof inline === "string" && inline.trim()) {
    return inline;
  }

  if (!path) {
    return "";
  }

  if (cachedPlaybookText !== null && cachedPlaybookPath === path) {
    return cachedPlaybookText;
  }

  try {
    cachedPlaybookText = await readFile(path, "utf8");
    cachedPlaybookPath = path;
    return cachedPlaybookText;
  } catch {
    cachedPlaybookText = "";
    cachedPlaybookPath = path;
    return "";
  }
}

function parseCsvEnv(value) {
  if (typeof value !== "string") {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeLeadName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function getTimezoneLabel(timezone, date) {
  if (!timezone) {
    return "UTC";
  }

  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" }).formatToParts(date);
    const label = parts.find((part) => part.type === "timeZoneName")?.value;
    return label || timezone;
  } catch {
    return timezone;
  }
}

function formatSlotWindow(slot) {
  const timezone = slot.timezone || "UTC";
  const startsAt = new Date(slot.starts_at || slot.startsAt);
  const endsAt = new Date(slot.ends_at || slot.endsAt);
  const dateLabel = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" }).format(startsAt);
  const timeFormatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" });
  const startLabel = timeFormatter.format(startsAt);
  const endLabel = timeFormatter.format(endsAt);
  const tzLabel = getTimezoneLabel(timezone, startsAt);
  const agentName = typeof slot.agent_name === "string"
    ? slot.agent_name.trim()
    : typeof slot.agentName === "string"
    ? slot.agentName.trim()
    : "";
  const base = `${dateLabel} ${startLabel} - ${endLabel} ${tzLabel}`;
  return agentName ? `${base} (${agentName})` : base;
}

function normalizeSlotCandidate(slot) {
  const startsAt = slot?.starts_at || slot?.startsAt || null;
  const endsAt = slot?.ends_at || slot?.endsAt || null;
  const timezone = slot?.timezone || "UTC";
  if (!startsAt || !endsAt) {
    return null;
  }

  const normalized = {
    startsAt,
    endsAt,
    timezone,
    agentId: slot?.agent_id || slot?.agentId || null,
    agentName: typeof slot?.agent_name === "string"
      ? slot.agent_name.trim()
      : typeof slot?.agentName === "string"
      ? slot.agentName.trim()
      : null
  };

  normalized.label = formatSlotWindow(normalized);
  return normalized;
}

function normalizePendingSlotConfirmation(slot) {
  if (!slot || typeof slot !== "object") {
    return null;
  }

  const startsAt = slot.startsAt || slot.starts_at || null;
  const endsAt = slot.endsAt || slot.ends_at || null;
  if (!startsAt || !endsAt) {
    return null;
  }

  const normalized = normalizeSlotCandidate({
    startsAt,
    endsAt,
    timezone: slot.timezone || "UTC",
    agentId: slot.agentId || slot.agent_id || null,
    agentName: slot.agentName || slot.agent_name || null
  });

  if (!normalized) {
    return null;
  }

  return {
    ...normalized,
    label: typeof slot.label === "string" && slot.label.trim() ? slot.label.trim() : normalized.label
  };
}

function isSameSlotCandidate(left, right) {
  if (!left || !right) {
    return false;
  }
  return left.startsAt === right.startsAt
    && left.endsAt === right.endsAt
    && (left.timezone || "UTC") === (right.timezone || "UTC");
}

function compareSlotCandidates(left, right) {
  const leftStarts = Number(new Date(left.startsAt));
  const rightStarts = Number(new Date(right.startsAt));
  if (Number.isFinite(leftStarts) && Number.isFinite(rightStarts) && leftStarts !== rightStarts) {
    return leftStarts - rightStarts;
  }

  const leftEnds = Number(new Date(left.endsAt));
  const rightEnds = Number(new Date(right.endsAt));
  if (Number.isFinite(leftEnds) && Number.isFinite(rightEnds) && leftEnds !== rightEnds) {
    return leftEnds - rightEnds;
  }

  const leftAgent = String(left.agentName || left.agentId || "").toLowerCase();
  const rightAgent = String(right.agentName || right.agentId || "").toLowerCase();
  if (leftAgent !== rightAgent) {
    return leftAgent.localeCompare(rightAgent);
  }

  return String(left.label || "").localeCompare(String(right.label || ""));
}

function selectDeterministicSlotCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }
  const sorted = [...candidates].sort(compareSlotCandidates);
  return sorted[0] || null;
}

const SLOT_CONFIRMATION_POSITIVE_PATTERN = /\b(confirm|confirmed|yes|yep|yeah|sounds good|works for me|that works|book it|see you)\b/i;
const SLOT_CONFIRMATION_NEGATIVE_PATTERN = /\b(not|can't|cannot|unable|different|another|later|reschedule)\b/i;

function isExplicitSlotConfirmation(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return false;
  }
  if (!SLOT_CONFIRMATION_POSITIVE_PATTERN.test(normalized)) {
    return false;
  }
  return !SLOT_CONFIRMATION_NEGATIVE_PATTERN.test(normalized);
}

function buildSlotConfirmationPrompt({ leadName, slotLabel }) {
  const greeting = leadName ? `Hi ${leadName},` : "Hi,";
  return `${greeting}\n\nGreat, I can hold this showing slot for you:\n- ${slotLabel}\n\nPlease reply with "confirm" and I will lock it in.`;
}

function buildSlotConfirmedReply({ leadName, slotLabel }) {
  const greeting = leadName ? `Perfect ${leadName},` : "Perfect,";
  return `${greeting} you're confirmed for:\n- ${slotLabel}\n\nSee you then.`;
}

function buildTemplateContext(message, slotOptions) {
  const unit = message.propertyName && message.unitNumber ? `${message.propertyName} ${message.unitNumber}` : "";
  const firstSlot = slotOptions.length > 0 ? slotOptions[0] : "";
  const slotOptionsInline = slotOptions.join(", ");
  const slotOptionsList = slotOptions.map((slot) => `- ${slot}`).join("\n");

  return {
    unit,
    unit_number: message.unitNumber || "",
    slot: firstSlot,
    // Prefer a human-friendly list for templates; keep an inline variant for compact templates.
    slot_options: slotOptionsList || slotOptionsInline,
    slot_options_inline: slotOptionsInline,
    slot_options_list: slotOptionsList,
    slotOptions,
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
    escalations: {
      raised: 0,
      reasons: {}
    },
    platformFailures: {},
    platformFailureStages: {},
    dispatch: {
      duplicatesSuppressed: 0,
      dlqQueued: 0
    },
    errors: 0,
    auditLogsWritten: 0
  };
}

function incrementMetricBucket(bucket, key) {
  const normalizedKey = key || "unknown";
  bucket[normalizedKey] = (bucket[normalizedKey] || 0) + 1;
}

function getPolicyContext(message) {
  const policy = message.platformPolicy || {};
  const sendMode = policy.sendMode === "auto_send" ? "auto_send" : "draft_only";
  return {
    isActive: policy.isActive !== false,
    sendMode,
    sendModeOverride: policy.sendModeOverride ?? null,
    globalDefaultSendMode: policy.globalDefaultSendMode || "draft_only"
  };
}

function buildDispatchKey({ message, pipeline, status }) {
  const payload = JSON.stringify({
    messageId: message.id,
    conversationId: message.conversationId,
    externalThreadId: message.externalThreadId,
    platformAccountId: message.platformAccountId,
    platform: message.platform,
    status,
    body: pipeline.replyBody,
    intent: pipeline.intent,
    effectiveIntent: pipeline.effectiveIntent
  });
  return createHash("sha256").update(payload).digest("hex");
}

function getRetryDetails(error) {
  const attempts = Number(error?.retryAttempts || 1);
  const retryable = error?.retryable === true || (typeof error?.status === "number" && (error.status === 429 || error.status >= 500));
  return {
    attempts,
    retryExhausted: Boolean(error?.retryExhausted) || (retryable && attempts > 1),
    retryable
  };
}

function requiresHumanAction(pipeline) {
  if (pipeline.workflowOutcome === "human_required") {
    return true;
  }
  return typeof pipeline.escalationReasonCode === "string" && pipeline.escalationReasonCode.includes("human_required");
}

export function buildWorkflowPersistencePayload(workflowOutcome) {
  if (workflowOutcome === "human_required") {
    return {
      workflowOutcome: "human_required",
      followUpStage: null
    };
  }

  if (workflowOutcome === "showing_confirmed") {
    return {
      workflowOutcome: "showing_confirmed",
      showingState: "confirmed",
      followUpStage: null
    };
  }

  if (workflowOutcome === "wants_reschedule") {
    return {
      workflowOutcome: "wants_reschedule",
      showingState: "reschedule_requested",
      followUpStage: null
    };
  }

  if (workflowOutcome === "no_reply") {
    return {
      workflowOutcome: "no_reply",
      followUpStage: null
    };
  }

  if (workflowOutcome === "completed") {
    return {
      workflowOutcome: "completed",
      showingState: "completed",
      followUpStage: null
    };
  }

  if (workflowOutcome === "no_show") {
    return {
      workflowOutcome: "no_show",
      showingState: "no_show",
      followUpStage: null
    };
  }

  if (workflowOutcome === "not_interested") {
    return {
      workflowOutcome: "not_interested",
      showingState: "cancelled",
      followUpStage: null
    };
  }

  return null;
}

async function fetchSlotRowsForMessage(adapter, message) {
  if (!message.unitId) {
    return [];
  }

  if (typeof adapter.fetchAssignedAgentSlotOptions === "function") {
    const slotRows = await adapter.fetchAssignedAgentSlotOptions({
      unitId: message.unitId,
      assignedAgentId: message.assignedAgentId,
      limit: 6,
      includeAllAssignedAgents: true
    });
    if (Array.isArray(slotRows) && slotRows.length > 0) {
      return slotRows;
    }
  }

  if (typeof adapter.fetchSlotOptions === "function") {
    return adapter.fetchSlotOptions(message.unitId, 6);
  }

  return [];
}

export async function processPendingMessagesWithAi({
  adapter,
  logger = console,
  limit = 20,
  now = new Date(),
  workerId = null,
  claimTtlMs = null,
  aiClassifier,
  aiEnabled,
  geminiModel
}) {
  const leadAllowlist = parseCsvEnv(process.env.WORKER_AUTOREPLY_ALLOW_LEAD_NAMES);
  const leadAllowlistSet = new Set(leadAllowlist.map(normalizeLeadName));
  const leadAllowlistActive = leadAllowlistSet.size > 0;
  const maxAutoReplyAgeMinutes = Number(process.env.WORKER_AUTOREPLY_MAX_MESSAGE_AGE_MINUTES || 60);

  const pendingMessages = await adapter.fetchPendingMessages({
    limit,
    now: now.toISOString(),
    workerId,
    claimTtlMs
  });
  let repliesCreated = 0;
  const metrics = createMetricsSnapshot();

  for (const message of pendingMessages) {
    let msg = message;
    const platform = message.platform || "unknown";
    const platformPolicy = getPolicyContext(message);
    let failureStage = "pipeline";
    try {
      if (!platformPolicy.isActive) {
        const decisionReason = "policy_platform_inactive";
        const blockedMetadataPatch = {
          aiProcessedAt: now.toISOString(),
          replyEligible: false,
          replyDecisionReason: decisionReason,
          outcome: "blocked",
          platformPolicy
        };

        metrics.decisions.ineligible += 1;
        incrementMetricBucket(metrics.decisions.reasons, decisionReason);

        await adapter.markInboundProcessed({
          messageId: message.id,
          metadataPatch: blockedMetadataPatch
        });

        await adapter.recordLog({
          actorType: "worker",
          entityType: "message",
          entityId: message.id,
          action: "ai_reply_policy_blocked",
          details: {
            platform,
            reason: decisionReason,
            platformPolicy
          }
        });
        metrics.auditLogsWritten += 1;
        continue;
      }

      if (leadAllowlistActive) {
        const leadKey = normalizeLeadName(msg.leadName);
        if (!leadAllowlistSet.has(leadKey)) {
          const decisionReason = "test_allowlist_blocked";
          const blockedMetadataPatch = {
            aiProcessedAt: now.toISOString(),
            replyEligible: false,
            replyDecisionReason: decisionReason,
            outcome: "blocked",
            platformPolicy,
            allowlist: {
              type: "lead_name",
              env: "WORKER_AUTOREPLY_ALLOW_LEAD_NAMES",
              configured: leadAllowlist,
              matched: false
            }
          };

          metrics.decisions.ineligible += 1;
          incrementMetricBucket(metrics.decisions.reasons, decisionReason);

          await adapter.markInboundProcessed({
            messageId: msg.id,
            metadataPatch: blockedMetadataPatch
          });

          await adapter.recordLog({
            actorType: "worker",
            entityType: "message",
            entityId: msg.id,
            action: "ai_reply_test_allowlist_blocked",
            details: {
              platform,
              reason: decisionReason,
              leadName: msg.leadName || null,
              platformPolicy,
              allowlist: leadAllowlist
            }
          });
          metrics.auditLogsWritten += 1;
          continue;
        }

        if (typeof adapter.ensureDevTestConversationContext === "function" && (!msg.unitId || !msg.assignedAgentId)) {
          failureStage = "ensure_dev_test_conversation_context";
          const ensured = await adapter.ensureDevTestConversationContext({
            conversationId: msg.conversationId,
            platformAccountId: msg.platformAccountId,
            leadName: msg.leadName || null
          });
          if (ensured) {
            msg = {
              ...msg,
              ...ensured
            };
          }
        }

        if (Number.isFinite(maxAutoReplyAgeMinutes) && maxAutoReplyAgeMinutes > 0) {
          const sentAt = msg.sentAt ? new Date(msg.sentAt) : null;
          const ageMs = sentAt && Number.isFinite(sentAt.getTime()) ? now.getTime() - sentAt.getTime() : null;
          if (typeof ageMs === "number" && ageMs > maxAutoReplyAgeMinutes * 60_000) {
            const decisionReason = "test_allowlist_message_too_old";
            const blockedMetadataPatch = {
              aiProcessedAt: now.toISOString(),
              replyEligible: false,
              replyDecisionReason: decisionReason,
              outcome: "blocked",
              platformPolicy,
              allowlist: {
                type: "lead_name",
                env: "WORKER_AUTOREPLY_ALLOW_LEAD_NAMES",
                configured: leadAllowlist,
                matched: true,
                maxMessageAgeMinutes: maxAutoReplyAgeMinutes
              }
            };

            metrics.decisions.ineligible += 1;
            incrementMetricBucket(metrics.decisions.reasons, decisionReason);

            await adapter.markInboundProcessed({
              messageId: msg.id,
              metadataPatch: blockedMetadataPatch
            });

            await adapter.recordLog({
              actorType: "worker",
              entityType: "message",
              entityId: msg.id,
              action: "ai_reply_test_allowlist_blocked",
              details: {
                platform,
                reason: decisionReason,
                leadName: msg.leadName || null,
                sentAt: msg.sentAt || null,
                maxMessageAgeMinutes: maxAutoReplyAgeMinutes,
                platformPolicy,
                allowlist: leadAllowlist
              }
            });
            metrics.auditLogsWritten += 1;
            continue;
          }
        }
      }

      const slotRows = await fetchSlotRowsForMessage(adapter, msg);
      const maxSlotOptions = Math.max(1, Number(process.env.WORKER_AUTOREPLY_SLOT_OPTION_LIMIT || 4));
      let normalizedSlotCandidates = (Array.isArray(slotRows) ? slotRows : [])
        .map((slot) => normalizeSlotCandidate(slot))
        .filter(Boolean)
        .slice(0, maxSlotOptions);
      const pendingSlotConfirmation = normalizePendingSlotConfirmation(msg.pendingSlotConfirmation);
      if (
        pendingSlotConfirmation
        && !normalizedSlotCandidates.some((candidate) => isSameSlotCandidate(candidate, pendingSlotConfirmation))
      ) {
        normalizedSlotCandidates = [pendingSlotConfirmation, ...normalizedSlotCandidates].slice(0, maxSlotOptions);
      }
      const slotOptions = Array.from(new Set(normalizedSlotCandidates.map((slot) => slot.label))).slice(0, maxSlotOptions);
      const followUpRuleFallbackIntent = message.metadata?.intent || "tour_request";
      const messageIntent = classifyIntent(msg.body);
      const followUp = detectFollowUp(msg.body, msg.hasRecentOutbound);
      const ruleIntent = followUp ? followUpRuleFallbackIntent : messageIntent;

      const rule = await adapter.findRule({
        platformAccountId: msg.platformAccountId,
        intent: ruleIntent,
        fallbackIntent: followUpRuleFallbackIntent
      });

      const templateName = rule?.actionConfig?.template || null;
      const template = templateName
        ? await adapter.findTemplate({
            platformAccountId: msg.platformAccountId,
            templateName
          })
        : null;

      const templateContext = buildTemplateContext(msg, slotOptions);

      const provider = process.env.AI_DECISION_PROVIDER || "heuristic";
      const geminiEnabled = Boolean(aiEnabled ?? provider === "gemini");
      const contextMessageLimit = Math.max(0, Number(process.env.WORKER_AI_CONTEXT_MESSAGE_LIMIT || 12));
      const fewShotLimit = Math.max(0, Number(process.env.WORKER_AI_FEWSHOT_EXAMPLE_LIMIT || 3));

      const playbook = geminiEnabled ? await loadAiPlaybook() : "";
      let conversationContext = [];
      let fewShotExamples = [];

      if (geminiEnabled) {
        if (contextMessageLimit > 0 && typeof adapter.fetchConversationRecentMessages === "function" && msg.conversationId) {
          try {
            conversationContext = await adapter.fetchConversationRecentMessages({
              conversationId: msg.conversationId,
              limit: contextMessageLimit
            });
          } catch (error) {
            logger.warn?.("[worker] failed fetching conversation context", {
              conversationId: msg.conversationId,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }

        if (fewShotLimit > 0 && typeof adapter.fetchFewShotExamples === "function") {
          try {
            fewShotExamples = await adapter.fetchFewShotExamples({
              platformAccountId: msg.platformAccountId,
              limit: fewShotLimit,
              excludeConversationId: msg.conversationId
            });
          } catch (error) {
            logger.warn?.("[worker] failed fetching few-shot examples", {
              platformAccountId: msg.platformAccountId,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }

      let pipeline = await runReplyPipelineWithAI({
        inboundBody: msg.body,
        hasRecentOutbound: msg.hasRecentOutbound,
        fallbackIntent: followUpRuleFallbackIntent,
        rule,
        template,
        templateContext,
        autoSendEnabled: Boolean(rule?.enabled) && platformPolicy.sendMode === "auto_send",
        aiClassifier,
        aiEnabled,
        geminiModel,
        conversationContext,
        fewShotExamples,
        playbook
      });

      let selectedSlotCandidates = normalizedSlotCandidates;
      let slotConfirmationState = null;

      if (
        pendingSlotConfirmation
        && pipeline.workflowOutcome === "showing_confirmed"
        && !pipeline.selectedSlotIndex
        && isExplicitSlotConfirmation(msg.body)
      ) {
        selectedSlotCandidates = [pendingSlotConfirmation];
        pipeline = {
          ...pipeline,
          selectedSlotIndex: 1,
          replyBody: buildSlotConfirmedReply({
            leadName: msg.leadName || "",
            slotLabel: pendingSlotConfirmation.label
          })
        };
        slotConfirmationState = {
          status: "confirmed",
          strategy: "pending_slot_confirmation",
          slotCandidate: pendingSlotConfirmation
        };
      } else if (
        !pendingSlotConfirmation
        && pipeline.workflowOutcome === "showing_confirmed"
        && !pipeline.selectedSlotIndex
        && normalizedSlotCandidates.length > 1
      ) {
        const selectedCandidate = selectDeterministicSlotCandidate(normalizedSlotCandidates);
        if (selectedCandidate) {
          selectedSlotCandidates = [selectedCandidate];
          pipeline = {
            ...pipeline,
            workflowOutcome: "general_question",
            selectedSlotIndex: null,
            replyBody: buildSlotConfirmationPrompt({
              leadName: msg.leadName || "",
              slotLabel: selectedCandidate.label
            })
          };
          slotConfirmationState = {
            status: "pending",
            strategy: "deterministic_arbitration",
            slotCandidate: selectedCandidate
          };
        }
      }
      const humanActionRequired = requiresHumanAction(pipeline);
      const workflowPersistencePayload = buildWorkflowPersistencePayload(pipeline.workflowOutcome);

      if (workflowPersistencePayload && typeof adapter.transitionConversationWorkflow === "function" && message.conversationId) {
        failureStage = "persist_workflow_transition";
        await adapter.transitionConversationWorkflow({
          conversationId: message.conversationId,
          payload: workflowPersistencePayload,
          actorType: "worker",
          actorId: msg.assignedAgentId || null,
          source: "ai_outcome_decision",
          messageId: message.id
        });
      }

      if (
        workflowPersistencePayload
        && message.conversationId
        && typeof adapter.syncShowingFromWorkflowOutcome === "function"
      ) {
        failureStage = "sync_showing_from_workflow";
        await adapter.syncShowingFromWorkflowOutcome({
          conversationId: message.conversationId,
          workflowOutcome: pipeline.workflowOutcome,
          selectedSlotIndex: pipeline.selectedSlotIndex || null,
          slotCandidates: selectedSlotCandidates,
          inboundBody: msg.body,
          actorType: "worker",
          actorId: msg.assignedAgentId || null,
          source: "ai_outcome_decision",
          messageId: message.id
        });
      }

      await adapter.recordLog({
        actorType: "worker",
        entityType: "message",
        entityId: message.id,
        action: "ai_reply_decision",
        details: {
          intent: pipeline.intent,
          effectiveIntent: pipeline.effectiveIntent,
          followUp: pipeline.followUp,
          provider: pipeline.provider,
          outcome: pipeline.outcome,
          workflowOutcome: pipeline.workflowOutcome,
          confidence: pipeline.confidence,
          riskLevel: pipeline.riskLevel,
          selectedSlotIndex: pipeline.selectedSlotIndex,
          decision: pipeline.eligibility,
          escalationReasonCode: pipeline.escalationReasonCode,
          slotConfirmationState,
          platformPolicy,
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

      if (pipeline.outcome === "escalate") {
        metrics.escalations.raised += 1;
        incrementMetricBucket(metrics.escalations.reasons, pipeline.escalationReasonCode || pipeline.eligibility.reason);
        await adapter.recordLog({
          actorType: "worker",
          entityType: "message",
          entityId: message.id,
          action: "ai_reply_escalated",
          details: {
            platform,
            intent: pipeline.intent,
            effectiveIntent: pipeline.effectiveIntent,
            followUp: pipeline.followUp,
            provider: pipeline.provider,
            workflowOutcome: pipeline.workflowOutcome,
            confidence: pipeline.confidence,
            riskLevel: pipeline.riskLevel,
            escalationReasonCode: pipeline.escalationReasonCode,
            decision: pipeline.eligibility,
            platformPolicy,
            guardrails: pipeline.guardrails.reasons
          }
        });
        metrics.auditLogsWritten += 1;

        if (humanActionRequired) {
          await adapter.recordLog({
            actorType: "worker",
            entityType: "message",
            entityId: message.id,
            action: "ai_reply_human_required_queued",
            details: {
              platform,
              reason: pipeline.escalationReasonCode || pipeline.eligibility.reason,
              workflowOutcome: pipeline.workflowOutcome,
              confidence: pipeline.confidence,
              riskLevel: pipeline.riskLevel,
              queue: "agent_action"
            }
          });
          metrics.auditLogsWritten += 1;
        }
      }

      if (pipeline.eligibility.eligible) {
        const status = pipeline.outcome === "send" ? "sent" : "draft";
        const dispatchKey = buildDispatchKey({ message: msg, pipeline, status });
        let dispatchGuard = {
          shouldDispatch: true,
          duplicate: false,
          state: "new",
          delivery: null
        };

        if (typeof adapter.beginDispatchAttempt === "function") {
          failureStage = "dispatch_idempotency_guard";
          dispatchGuard = await adapter.beginDispatchAttempt({
            messageId: message.id,
            dispatchKey,
            platform,
            stage: "dispatch_outbound_message",
            now: now.toISOString()
          });
        }

        if (!dispatchGuard.shouldDispatch) {
          metrics.dispatch.duplicatesSuppressed += 1;
          await adapter.recordLog({
            actorType: "worker",
            entityType: "message",
            entityId: message.id,
            action: "ai_reply_dispatch_duplicate_suppressed",
            details: {
              platform,
              stage: "dispatch_outbound_message",
              dispatchKey,
              state: dispatchGuard.state || "completed"
            }
          });
          metrics.auditLogsWritten += 1;
        }

        metrics.sends.attempted += 1;
        failureStage = "dispatch_outbound_message";
        const deliveryReceipt = !dispatchGuard.shouldDispatch
          ? dispatchGuard.delivery || null
          : status === "sent" && typeof adapter.dispatchOutboundMessage === "function"
          ? await adapter.dispatchOutboundMessage({
              platformAccountId: msg.platformAccountId,
              platform: msg.platform,
              platformCredentials: msg.platformCredentials,
              externalThreadId: msg.externalThreadId,
              body: pipeline.replyBody,
              metadata: {
                intent: pipeline.intent,
                effectiveIntent: pipeline.effectiveIntent
              }
            })
          : null;

        if (dispatchGuard.shouldDispatch && typeof adapter.completeDispatchAttempt === "function") {
          failureStage = "dispatch_idempotency_complete";
          await adapter.completeDispatchAttempt({
            messageId: message.id,
            dispatchKey,
            status,
            delivery: deliveryReceipt,
            now: now.toISOString()
          });
        }

        failureStage = "record_audit_send";

        if (dispatchGuard.shouldDispatch) {
          await adapter.recordLog({
            actorType: "worker",
            entityType: "message",
            entityId: message.id,
            action: status === "sent" ? "ai_reply_send_attempted" : "ai_reply_draft_created",
            details: {
              platform,
              intent: pipeline.intent,
              effectiveIntent: pipeline.effectiveIntent,
              reviewStatus: status,
              platformPolicy,
              dispatchKey,
              selectedSlotIndex: pipeline.selectedSlotIndex,
              slotConfirmationState,
              delivery: deliveryReceipt
            }
          });
          metrics.auditLogsWritten += 1;
        }

        if (dispatchGuard.shouldDispatch) {
          const outboundMetadata = {
            reviewStatus: status,
            templateId: template?.id || null,
            intent: pipeline.intent,
            effectiveIntent: pipeline.effectiveIntent,
            followUp: pipeline.followUp,
            workerGeneratedAt: now.toISOString(),
            guardrails: pipeline.guardrails.reasons,
            escalationReasonCode: pipeline.escalationReasonCode,
            platformPolicy,
            selectedSlotIndex: pipeline.selectedSlotIndex,
            slotCandidates: selectedSlotCandidates,
            slotConfirmationState,
            dispatchKey,
            delivery: deliveryReceipt
          };
          if (slotConfirmationState?.status === "pending" && slotConfirmationState.slotCandidate) {
            outboundMetadata.slotConfirmationPending = {
              ...slotConfirmationState.slotCandidate,
              createdAt: now.toISOString(),
              sourceMessageId: msg.id
            };
          }
          if (slotConfirmationState?.status === "confirmed" && slotConfirmationState.slotCandidate) {
            outboundMetadata.slotConfirmationResolved = {
              ...slotConfirmationState.slotCandidate,
              resolvedAt: now.toISOString(),
              sourceMessageId: msg.id
            };
          }

          failureStage = "record_outbound_reply";
          await adapter.recordOutboundReply({
            conversationId: msg.conversationId,
            assignedAgentId: msg.assignedAgentId,
            body: pipeline.replyBody,
            metadata: outboundMetadata,
            channel: deliveryReceipt?.channel || "in_app",
            externalMessageId: deliveryReceipt?.externalMessageId || dispatchKey
          });

          repliesCreated += 1;
          if (status === "sent") {
            metrics.sends.sent += 1;
          } else {
            metrics.sends.drafted += 1;
          }
        }
      }

      failureStage = "mark_inbound_processed";
      const inboundMetadataPatch = {
        aiProcessedAt: now.toISOString(),
        intent: pipeline.intent,
        effectiveIntent: pipeline.effectiveIntent,
        followUp: pipeline.followUp,
        provider: pipeline.provider,
        workflowOutcome: pipeline.workflowOutcome,
        confidence: pipeline.confidence,
        riskLevel: pipeline.riskLevel,
        selectedSlotIndex: pipeline.selectedSlotIndex,
        replyEligible: pipeline.eligibility.eligible,
        replyDecisionReason: pipeline.eligibility.reason,
        outcome: pipeline.outcome,
        escalationReasonCode: pipeline.escalationReasonCode,
        slotConfirmationState,
        platformPolicy,
        guardrails: pipeline.guardrails.reasons,
        ...(humanActionRequired ? { reviewStatus: "hold", actionQueue: "agent_action" } : {})
      };

      await adapter.markInboundProcessed({
        messageId: message.id,
        metadataPatch: inboundMetadataPatch
      });

      failureStage = "record_audit_outcome";
      await adapter.recordLog({
        actorType: "worker",
        entityType: "message",
        entityId: message.id,
        action: pipeline.eligibility.eligible ? "ai_reply_created" : "ai_reply_skipped",
        details: {
          platform,
          intent: pipeline.intent,
          effectiveIntent: pipeline.effectiveIntent,
          followUp: pipeline.followUp,
          provider: pipeline.provider,
          outcome: pipeline.outcome,
          workflowOutcome: pipeline.workflowOutcome,
          confidence: pipeline.confidence,
          riskLevel: pipeline.riskLevel,
          selectedSlotIndex: pipeline.selectedSlotIndex,
          decision: pipeline.eligibility,
          escalationReasonCode: pipeline.escalationReasonCode,
          platformPolicy,
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
          platform,
          stage: failureStage,
          error: error instanceof Error ? error.message : String(error)
        }
      });
      if (failureStage.startsWith("dispatch_")) {
        const retry = getRetryDetails(error);
        incrementMetricBucket(metrics.platformFailures, platform);
        incrementMetricBucket(metrics.platformFailureStages, `${platform}:${failureStage}`);

        if (typeof adapter.failDispatchAttempt === "function") {
          await adapter.failDispatchAttempt({
            messageId: message.id,
            stage: failureStage,
            error: error instanceof Error ? error.message : String(error),
            now: now.toISOString(),
            retry
          });
        }

        await adapter.recordLog({
          actorType: "worker",
          entityType: "message",
          entityId: message.id,
          action: "platform_dispatch_error",
          details: {
            platform,
            stage: failureStage,
            error: error instanceof Error ? error.message : String(error),
            retry
          }
        });
        metrics.auditLogsWritten += 1;

        if (retry.retryExhausted) {
          metrics.dispatch.dlqQueued += 1;
          await adapter.recordLog({
            actorType: "worker",
            entityType: "message",
            entityId: message.id,
            action: "platform_dispatch_dlq",
            details: {
              platform,
              stage: failureStage,
              error: error instanceof Error ? error.message : String(error),
              retry
            }
          });
          metrics.auditLogsWritten += 1;

          await adapter.recordLog({
            actorType: "worker",
            entityType: "message",
            entityId: message.id,
            action: "ai_reply_dispatch_escalated",
            details: {
              platform,
              stage: failureStage,
              reason: "escalate_dispatch_retry_exhausted"
            }
          });
          metrics.auditLogsWritten += 1;
        }
      }
      metrics.auditLogsWritten += 1;
    }
  }

  return {
    scanned: pendingMessages.length,
    repliesCreated,
    metrics
  };
}
