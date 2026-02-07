import { classifyIntent, detectFollowUp, runReplyPipelineWithAI } from "../../../packages/ai/src/index.js";

import { createHash } from "node:crypto";

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
  const pendingMessages = await adapter.fetchPendingMessages({
    limit,
    now: now.toISOString(),
    workerId,
    claimTtlMs
  });
  let repliesCreated = 0;
  const metrics = createMetricsSnapshot();

  for (const message of pendingMessages) {
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

      const slotRows = message.unitId ? await adapter.fetchSlotOptions(message.unitId, 3) : [];
      const slotOptions = slotRows.map((slot) => formatSlotWindow(slot));
      const followUpRuleFallbackIntent = message.metadata?.intent || "tour_request";
      const messageIntent = classifyIntent(message.body);
      const followUp = detectFollowUp(message.body, message.hasRecentOutbound);
      const ruleIntent = followUp ? followUpRuleFallbackIntent : messageIntent;

      const rule = await adapter.findRule({
        platformAccountId: message.platformAccountId,
        intent: ruleIntent,
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
      const pipeline = await runReplyPipelineWithAI({
        inboundBody: message.body,
        hasRecentOutbound: message.hasRecentOutbound,
        fallbackIntent: followUpRuleFallbackIntent,
        rule,
        template,
        templateContext,
        autoSendEnabled: Boolean(rule?.enabled) && platformPolicy.sendMode === "auto_send",
        aiClassifier,
        aiEnabled,
        geminiModel
      });
      const humanActionRequired = requiresHumanAction(pipeline);

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
          decision: pipeline.eligibility,
          escalationReasonCode: pipeline.escalationReasonCode,
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
        const dispatchKey = buildDispatchKey({ message, pipeline, status });
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
            dispatchKey,
            delivery: deliveryReceipt
          };

          failureStage = "record_outbound_reply";
          await adapter.recordOutboundReply({
            conversationId: message.conversationId,
            assignedAgentId: message.assignedAgentId,
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
        replyEligible: pipeline.eligibility.eligible,
        replyDecisionReason: pipeline.eligibility.reason,
        outcome: pipeline.outcome,
        escalationReasonCode: pipeline.escalationReasonCode,
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
