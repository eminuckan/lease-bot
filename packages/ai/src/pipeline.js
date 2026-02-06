import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";

import { evaluateGuardrails } from "./guardrails.js";

const FOLLOW_UP_PATTERN = /\b(follow\s*up|any update|checking in|just checking|status\??)\b/i;
const AMBIGUOUS_PATTERN = /\b(not sure|maybe|can you explain|confused|what do you mean|unclear)\b/i;
const TOUR_INTENTS = new Set(["tour_request", "follow_up"]);

const decisionSchema = z.object({
  intent: z.enum(["tour_request", "pricing_question", "availability_question", "unsubscribe", "unknown"]),
  ambiguity: z.boolean(),
  suggestedReply: z.string().nullable(),
  reasonCode: z.string().nullable()
});

export function classifyIntent(body) {
  const text = String(body || "").toLowerCase();

  if (!text.trim()) {
    return "unknown";
  }
  if (/\b(stop|unsubscribe|do not contact)\b/.test(text)) {
    return "unsubscribe";
  }
  if (/\b(tour|visit|see the place|walkthrough|showing)\b/.test(text)) {
    return "tour_request";
  }
  if (/\b(price|rent|deposit|fee|cost)\b/.test(text)) {
    return "pricing_question";
  }
  if (/\b(available|availability|when can i|open slot)\b/.test(text)) {
    return "availability_question";
  }

  return "unknown";
}

export function detectFollowUp(body, hasRecentOutbound = false) {
  if (!hasRecentOutbound) {
    return false;
  }
  return FOLLOW_UP_PATTERN.test(String(body || ""));
}

export function renderTemplate(body, context = {}) {
  if (typeof body !== "string") {
    return "";
  }

  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = context[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

function deriveSlotCount(templateContext = {}) {
  if (Array.isArray(templateContext.slotOptions)) {
    return templateContext.slotOptions.length;
  }

  const slotOptions = templateContext.slot_options;
  if (typeof slotOptions !== "string") {
    return 0;
  }

  return slotOptions
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean).length;
}

function createDefaultTourReply(templateContext = {}) {
  const unit = templateContext.unit || "the unit";
  const slotOptions = typeof templateContext.slot_options === "string" ? templateContext.slot_options : "";
  return `Thanks for your interest in ${unit}. Here are the next available showing windows: ${slotOptions}`;
}

async function classifyWithGemini({ inboundBody, templateContext = {}, geminiModel = "gemini-2.5-flash", enabled = false }) {
  if (!enabled) {
    return null;
  }

  try {
    const result = await generateObject({
      model: google(geminiModel),
      schema: decisionSchema,
      prompt: [
        "Classify leasing inbound intent for operations policy.",
        "Allowed intents: tour_request, pricing_question, availability_question, unsubscribe, unknown.",
        "Mark ambiguity=true when message is unclear or risky to auto-handle.",
        "For tour_request you may provide a concise suggestedReply that references slot options if present.",
        `Inbound message: ${String(inboundBody || "")}`,
        `Unit context: ${String(templateContext.unit || "")}`,
        `Slot options: ${String(templateContext.slot_options || "")}`
      ].join("\n")
    });

    return result.object;
  } catch {
    return null;
  }
}

function resolvePolicyIntent({ heuristicIntent, aiIntent, fallbackIntent, followUp }) {
  const fallback = fallbackIntent || heuristicIntent || "unknown";
  const resolvedIntent = aiIntent || heuristicIntent || fallback;
  const policyIntent = followUp && resolvedIntent === "unknown" ? fallback : resolvedIntent;
  const effectiveIntent = followUp ? "follow_up" : resolvedIntent;

  return {
    policyIntent,
    effectiveIntent
  };
}

export function decideReplyEligibility({
  intent,
  effectiveIntent,
  isAmbiguous,
  rule,
  templateBody,
  guardrails,
  slotCount = 0,
  autoSendEnabled = false
}) {
  if (intent === "unsubscribe") {
    return { eligible: false, reason: "escalate_unsubscribe_requested", outcome: "escalate" };
  }
  if (guardrails.blocked) {
    return { eligible: false, reason: `escalate_${guardrails.reasons[0] || "policy_guardrail"}`, outcome: "escalate" };
  }
  if (isAmbiguous || intent === "unknown") {
    return { eligible: false, reason: "escalate_ambiguous_intent", outcome: "escalate" };
  }
  if (!TOUR_INTENTS.has(effectiveIntent)) {
    return { eligible: false, reason: "escalate_non_tour_intent", outcome: "escalate" };
  }
  if (slotCount < 1) {
    return { eligible: false, reason: "escalate_no_slot_candidates", outcome: "escalate" };
  }
  if (!rule) {
    return { eligible: false, reason: "escalate_no_matching_rule", outcome: "escalate" };
  }
  if (!templateBody || !templateBody.trim()) {
    return { eligible: false, reason: "escalate_template_missing", outcome: "escalate" };
  }

  return {
    eligible: true,
    reason: autoSendEnabled ? "policy_send_allowed" : "policy_draft_required",
    outcome: autoSendEnabled ? "send" : "draft"
  };
}

export function runReplyPipeline(input) {
  const intent = classifyIntent(input.inboundBody);
  const followUp = detectFollowUp(input.inboundBody, input.hasRecentOutbound);
  const fallbackIntent = input.fallbackIntent || intent;
  const policyIntent = followUp && intent === "unknown" ? fallbackIntent : intent;
  const effectiveIntent = followUp ? fallbackIntent : intent;
  const templateBody = input.template?.body || "";
  const slotCount = deriveSlotCount(input.templateContext || {});
  const renderedReply = renderTemplate(templateBody, input.templateContext || {});
  const guardrails = evaluateGuardrails({
    inboundBody: input.inboundBody,
    outboundBody: renderedReply
  });
  const eligibility = decideReplyEligibility({
    intent: policyIntent,
    effectiveIntent,
    isAmbiguous: AMBIGUOUS_PATTERN.test(String(input.inboundBody || "")),
    rule: input.rule,
    templateBody,
    guardrails,
    slotCount,
    autoSendEnabled: Boolean(input.rule?.enabled)
  });

  return {
    intent: policyIntent,
    effectiveIntent: followUp ? "follow_up" : effectiveIntent,
    followUp,
    guardrails,
    eligibility,
    outcome: eligibility.outcome,
    escalationReasonCode: eligibility.outcome === "escalate" ? eligibility.reason : null,
    replyBody: renderedReply
  };
}

export async function runReplyPipelineWithAI(input) {
  const followUp = detectFollowUp(input.inboundBody, input.hasRecentOutbound);
  const heuristicIntent = classifyIntent(input.inboundBody);
  const fallbackIntent = input.fallbackIntent || heuristicIntent;
  const templateBody = input.template?.body || "";
  const slotCount = deriveSlotCount(input.templateContext || {});
  const aiEnabled = input.aiEnabled ?? process.env.AI_DECISION_PROVIDER === "gemini";
  const geminiModel = input.geminiModel || process.env.AI_GEMINI_MODEL || "gemini-2.5-flash";
  const classify = typeof input.aiClassifier === "function" ? input.aiClassifier : classifyWithGemini;

  let aiDecision = null;
  try {
    aiDecision = await classify({
      inboundBody: input.inboundBody,
      templateContext: input.templateContext || {},
      geminiModel,
      enabled: aiEnabled
    });
  } catch {
    aiDecision = null;
  }

  const { policyIntent, effectiveIntent } = resolvePolicyIntent({
    heuristicIntent,
    aiIntent: aiDecision?.intent || null,
    fallbackIntent,
    followUp
  });
  const aiSuggestedReply = aiDecision?.suggestedReply ? String(aiDecision.suggestedReply) : "";
  const renderedReply = renderTemplate(templateBody, input.templateContext || {});
  const replyBody = renderedReply || (TOUR_INTENTS.has(effectiveIntent) && slotCount > 0 ? aiSuggestedReply || createDefaultTourReply(input.templateContext) : "");

  const guardrails = evaluateGuardrails({
    inboundBody: input.inboundBody,
    outboundBody: replyBody
  });
  const eligibility = decideReplyEligibility({
    intent: policyIntent,
    effectiveIntent,
    isAmbiguous: Boolean(aiDecision?.ambiguity) || AMBIGUOUS_PATTERN.test(String(input.inboundBody || "")),
    rule: input.rule,
    templateBody: replyBody,
    guardrails,
    slotCount,
    autoSendEnabled: Boolean(input.autoSendEnabled ?? input.rule?.enabled)
  });

  return {
    intent: policyIntent,
    effectiveIntent,
    followUp,
    guardrails,
    eligibility,
    outcome: eligibility.outcome,
    escalationReasonCode: eligibility.outcome === "escalate" ? eligibility.reason : null,
    provider: aiDecision ? "gemini" : "heuristic",
    replyBody
  };
}
