import { classifyIntent, detectFollowUp, runReplyPipelineWithAI } from "../../../packages/ai/src/index.js";

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
    errors: 0,
    auditLogsWritten: 0
  };
}

function incrementMetricBucket(bucket, key) {
  const normalizedKey = key || "unknown";
  bucket[normalizedKey] = (bucket[normalizedKey] || 0) + 1;
}

export async function processPendingMessagesWithAi({ adapter, logger = console, limit = 20, now = new Date() }) {
  const pendingMessages = await adapter.fetchPendingMessages(limit);
  let repliesCreated = 0;
  const metrics = createMetricsSnapshot();

  for (const message of pendingMessages) {
    const platform = message.platform || "unknown";
    let failureStage = "pipeline";
    try {
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
        autoSendEnabled: Boolean(rule?.enabled)
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
          provider: pipeline.provider,
          outcome: pipeline.outcome,
          decision: pipeline.eligibility,
          escalationReasonCode: pipeline.escalationReasonCode,
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
            escalationReasonCode: pipeline.escalationReasonCode,
            decision: pipeline.eligibility,
            guardrails: pipeline.guardrails.reasons
          }
        });
        metrics.auditLogsWritten += 1;
      }

      if (pipeline.eligibility.eligible) {
        const status = pipeline.outcome === "send" ? "sent" : "draft";
        metrics.sends.attempted += 1;
        failureStage = "dispatch_outbound_message";
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

        failureStage = "record_audit_send";

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
            delivery: deliveryReceipt
          }
        });
        metrics.auditLogsWritten += 1;

        const outboundMetadata = {
          reviewStatus: status,
          templateId: template?.id || null,
          intent: pipeline.intent,
          effectiveIntent: pipeline.effectiveIntent,
          followUp: pipeline.followUp,
          workerGeneratedAt: now.toISOString(),
          guardrails: pipeline.guardrails.reasons,
          escalationReasonCode: pipeline.escalationReasonCode,
          delivery: deliveryReceipt
        };

        failureStage = "record_outbound_reply";
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

      failureStage = "mark_inbound_processed";
      const inboundMetadataPatch = {
        aiProcessedAt: now.toISOString(),
        intent: pipeline.intent,
        effectiveIntent: pipeline.effectiveIntent,
        followUp: pipeline.followUp,
        provider: pipeline.provider,
        replyEligible: pipeline.eligibility.eligible,
        replyDecisionReason: pipeline.eligibility.reason,
        outcome: pipeline.outcome,
        escalationReasonCode: pipeline.escalationReasonCode,
        guardrails: pipeline.guardrails.reasons
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
          decision: pipeline.eligibility,
          escalationReasonCode: pipeline.escalationReasonCode,
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
        incrementMetricBucket(metrics.platformFailures, platform);
        await adapter.recordLog({
          actorType: "worker",
          entityType: "message",
          entityId: message.id,
          action: "platform_dispatch_error",
          details: {
            platform,
            stage: failureStage,
            error: error instanceof Error ? error.message : String(error)
          }
        });
        metrics.auditLogsWritten += 1;
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
