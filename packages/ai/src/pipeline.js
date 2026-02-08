import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";

import { evaluateGuardrails } from "./guardrails.js";

const FOLLOW_UP_PATTERN = /\b(follow\s*up|any update|checking in|just checking|status\??)\b/i;
const AMBIGUOUS_PATTERN = /\b(not sure|maybe|can you explain|confused|what do you mean|unclear)\b/i;
// Intents we can safely auto-handle with a slot-based reply.
// Note: availability questions ("is this available?") are high-volume and should be eligible.
const AUTO_REPLY_INTENTS = new Set(["tour_request", "availability_question", "follow_up"]);
const WORKFLOW_OUTCOMES = new Set([
  "not_interested",
  "wants_reschedule",
  "no_reply",
  "showing_confirmed",
  "general_question",
  "human_required"
]);
const RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);
const LOW_CONFIDENCE_THRESHOLD = 0.55;
const RESCHEDULE_PATTERN = /\b(reschedule|another time|later|different time|move (it|this)|change (the )?(time|slot))\b/i;
const NOT_INTERESTED_PATTERN = /\b(not interested|no longer interested|found another place|stop|unsubscribe|do not contact)\b/i;
const SHOWING_CONFIRMED_PATTERN = /\b(confirmed|see you|i('ll| will) be there|works for me|book it|that time works)\b/i;

const decisionSchema = z.object({
  intent: z.enum(["tour_request", "pricing_question", "availability_question", "unsubscribe", "unknown"]),
  workflowOutcome: z.enum(["not_interested", "wants_reschedule", "no_reply", "showing_confirmed", "general_question", "human_required"]).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  riskLevel: z.enum(["low", "medium", "high", "critical"]).nullable(),
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
        "Choose workflowOutcome from: not_interested, wants_reschedule, no_reply, showing_confirmed, general_question, human_required.",
        "Provide confidence between 0 and 1 and riskLevel from low, medium, high, critical.",
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

function normalizeConfidence(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (parsed < 0 || parsed > 1) {
    return null;
  }
  return parsed;
}

function normalizeRiskLevel(value) {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (!RISK_LEVELS.has(normalized)) {
    return null;
  }
  return normalized;
}

function classifyWorkflowOutcomeFromHeuristics(inboundBody) {
  const body = String(inboundBody || "");
  if (NOT_INTERESTED_PATTERN.test(body)) {
    return { outcome: "not_interested", confidence: 0.9, riskLevel: "low" };
  }
  if (RESCHEDULE_PATTERN.test(body)) {
    return { outcome: "wants_reschedule", confidence: 0.85, riskLevel: "low" };
  }
  if (SHOWING_CONFIRMED_PATTERN.test(body)) {
    return { outcome: "showing_confirmed", confidence: 0.8, riskLevel: "low" };
  }
  return { outcome: "general_question", confidence: 0.65, riskLevel: "medium" };
}

function deriveWorkflowClassification({ inboundBody, aiDecision, isAmbiguous, guardrails }) {
  const heuristic = classifyWorkflowOutcomeFromHeuristics(inboundBody);
  const aiWorkflowOutcome = typeof aiDecision?.workflowOutcome === "string" && WORKFLOW_OUTCOMES.has(aiDecision.workflowOutcome)
    ? aiDecision.workflowOutcome
    : null;
  const aiConfidence = normalizeConfidence(aiDecision?.confidence);
  const aiRiskLevel = normalizeRiskLevel(aiDecision?.riskLevel);
  const riskLevel = aiRiskLevel || heuristic.riskLevel;
  const confidence = aiConfidence ?? heuristic.confidence;
  let workflowOutcome = aiWorkflowOutcome || heuristic.outcome;

  if (isAmbiguous || guardrails.blocked || riskLevel === "high" || riskLevel === "critical" || confidence < LOW_CONFIDENCE_THRESHOLD) {
    workflowOutcome = "human_required";
  }

  return {
    workflowOutcome,
    confidence,
    riskLevel
  };
}

export function decideReplyEligibility({
  intent,
  effectiveIntent,
  isAmbiguous,
  rule,
  templateBody,
  guardrails,
  workflowOutcome,
  confidence,
  riskLevel,
  slotCount = 0,
  autoSendEnabled = false
}) {
  if (workflowOutcome === "human_required") {
    return { eligible: false, reason: "escalate_human_required", outcome: "escalate" };
  }
  if (typeof confidence === "number" && confidence < LOW_CONFIDENCE_THRESHOLD) {
    return { eligible: false, reason: "escalate_low_confidence_human_required", outcome: "escalate" };
  }
  if (riskLevel === "high" || riskLevel === "critical") {
    return { eligible: false, reason: `escalate_risk_${riskLevel}_human_required`, outcome: "escalate" };
  }
  if (intent === "unsubscribe") {
    return { eligible: false, reason: "escalate_unsubscribe_requested", outcome: "escalate" };
  }
  if (guardrails.blocked) {
    return { eligible: false, reason: `escalate_${guardrails.reasons[0] || "policy_guardrail"}`, outcome: "escalate" };
  }
  if (isAmbiguous || intent === "unknown") {
    return { eligible: false, reason: "escalate_ambiguous_intent", outcome: "escalate" };
  }
  if (!AUTO_REPLY_INTENTS.has(effectiveIntent)) {
    return { eligible: false, reason: "escalate_non_tour_intent", outcome: "escalate" };
  }
  if (slotCount < 1) {
    return { eligible: false, reason: "escalate_no_slot_candidates", outcome: "escalate" };
  }
  if (!rule) {
    return { eligible: false, reason: "escalate_no_matching_rule", outcome: "escalate" };
  }
  if (rule.enabled === false) {
    return { eligible: false, reason: "skip_rule_disabled", outcome: "skip" };
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
  const workflow = deriveWorkflowClassification({
    inboundBody: input.inboundBody,
    aiDecision: null,
    isAmbiguous: AMBIGUOUS_PATTERN.test(String(input.inboundBody || "")),
    guardrails
  });
  const eligibility = decideReplyEligibility({
    intent: policyIntent,
    effectiveIntent,
    isAmbiguous: AMBIGUOUS_PATTERN.test(String(input.inboundBody || "")),
    rule: input.rule,
    templateBody,
    guardrails,
    workflowOutcome: workflow.workflowOutcome,
    confidence: workflow.confidence,
    riskLevel: workflow.riskLevel,
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
    workflowOutcome: workflow.workflowOutcome,
    confidence: workflow.confidence,
    riskLevel: workflow.riskLevel,
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
  const replyBody =
    renderedReply || (AUTO_REPLY_INTENTS.has(effectiveIntent) && slotCount > 0 ? aiSuggestedReply || createDefaultTourReply(input.templateContext) : "");

  const guardrails = evaluateGuardrails({
    inboundBody: input.inboundBody,
    outboundBody: replyBody
  });
  const isAmbiguous = Boolean(aiDecision?.ambiguity) || AMBIGUOUS_PATTERN.test(String(input.inboundBody || ""));
  const workflow = deriveWorkflowClassification({
    inboundBody: input.inboundBody,
    aiDecision,
    isAmbiguous,
    guardrails
  });
  const eligibility = decideReplyEligibility({
    intent: policyIntent,
    effectiveIntent,
    isAmbiguous,
    rule: input.rule,
    templateBody: replyBody,
    guardrails,
    workflowOutcome: workflow.workflowOutcome,
    confidence: workflow.confidence,
    riskLevel: workflow.riskLevel,
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
    workflowOutcome: workflow.workflowOutcome,
    confidence: workflow.confidence,
    riskLevel: workflow.riskLevel,
    escalationReasonCode: eligibility.outcome === "escalate" ? eligibility.reason : null,
    provider: aiDecision ? "gemini" : "heuristic",
    replyBody
  };
}

export function listWorkflowOutcomes() {
  return [...WORKFLOW_OUTCOMES];
}
