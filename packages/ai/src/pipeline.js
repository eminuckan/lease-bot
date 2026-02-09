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
  selectedSlotIndex: z.number().int().min(1).nullable(),
  suggestedReply: z.string().nullable(),
  reasonCode: z.string().nullable()
});

export function classifyIntent(body) {
  const text = String(body || "").toLowerCase();
  const normalized = text.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "unknown";
  }
  if (/\b(stop|unsubscribe|do not contact)\b/.test(text)) {
    return "unsubscribe";
  }
  if (/\b(tour|visit|see the place|walkthrough|showing)\b/.test(text)) {
    return "tour_request";
  }

  // Pricing questions need explicit pricing intent. Avoid misclassifying generic phrases like
  // "interested in the room for rent" as a pricing question.
  const isPricingQuestion =
    /\b(price|deposit|fee|cost)\b/.test(normalized)
    || /\bhow much\b/.test(normalized)
    || /\$\s*\d/.test(normalized)
    || /\b(what('?s| is) (the )?rent)\b/.test(normalized)
    || /\bmonthly rent\b/.test(normalized)
    || /\brent (per|\/)\s*(month|mo)\b/.test(normalized)
    || /\brent\?\b/.test(normalized)
    || /\brent\s*[:=-]\s*\$?\s*\d/.test(normalized);

  if (isPricingQuestion) {
    return "pricing_question";
  }

  // Availability-like first messages ("I'm interested") should be handled with the slot-based reply.
  if (/\b(available|availability|still available|when can i|open slot|interested|interested in|looking to rent|looking for)\b/.test(normalized)) {
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

function truncateForPrompt(value, maxChars = 1200) {
  const text = String(value || "");
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...`;
}

function redactPromptPII(value) {
  let text = String(value || "");

  // Emails
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");

  // Phone-like numbers (US-ish + international-ish). This will still miss some formats but
  // the goal is to avoid leaking obvious PII into model prompts.
  text = text.replace(
    /(\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{4}\b/g,
    "[REDACTED_PHONE]"
  );

  // Long numeric sequences (often phone numbers / IDs)
  text = text.replace(/\b\d{9,}\b/g, "[REDACTED_NUMBER]");

  return text;
}

function formatConversationContext(conversationContext = []) {
  if (!Array.isArray(conversationContext) || conversationContext.length === 0) {
    return "";
  }

  const lines = conversationContext
    .filter((msg) => msg && typeof msg === "object")
    .map((msg) => {
      const direction = msg.direction === "outbound" ? "agent" : "lead";
      const body = truncateForPrompt(redactPromptPII(msg.body || ""), 800);
      return `- ${direction}: ${body}`;
    });

  return lines.join("\n");
}

function formatFewShotExamples(fewShotExamples = []) {
  if (!Array.isArray(fewShotExamples) || fewShotExamples.length === 0) {
    return "";
  }

  return fewShotExamples
    .filter((ex) => ex && typeof ex === "object")
    .map((ex, index) => {
      const inbound = truncateForPrompt(redactPromptPII(ex.inboundBody || ""), 800);
      const outbound = truncateForPrompt(redactPromptPII(ex.outboundBody || ""), 800);
      return [`Example ${index + 1}:`, `Inbound: ${inbound}`, `Our reply: ${outbound}`].join("\n");
    })
    .join("\n\n");
}

async function classifyWithGemini({
  inboundBody,
  templateContext = {},
  geminiModel = "gemini-2.5-flash",
  enabled = false,
  conversationContext = [],
  fewShotExamples = [],
  playbook = ""
}) {
  if (!enabled) {
    return null;
  }

  try {
    const inboundForPrompt = truncateForPrompt(redactPromptPII(inboundBody || ""), 2000);
    const unitForPrompt = truncateForPrompt(redactPromptPII(templateContext.unit || ""), 400);
    const slotOptionsForPrompt = truncateForPrompt(redactPromptPII(templateContext.slot_options || ""), 2000);
    const contextBlock = formatConversationContext(conversationContext);
    const examplesBlock = formatFewShotExamples(fewShotExamples);
    const playbookBlock = typeof playbook === "string" && playbook.trim()
      ? truncateForPrompt(playbook.trim(), 4000)
      : "";

    const promptParts = [
      "You are an assistant for a leasing inbox automation system.",
      "Return a JSON object that matches the schema exactly.",
      "Goal: classify the inbound message intent and recommend a safe workflow outcome for operations.",
      "If you are uncertain, set ambiguity=true and workflowOutcome=human_required.",
      "Allowed intents: tour_request, pricing_question, availability_question, unsubscribe, unknown.",
      "Choose workflowOutcome from: not_interested, wants_reschedule, no_reply, showing_confirmed, general_question, human_required.",
      "If user confirms one of the provided slot options, set selectedSlotIndex (1-based index from slot list). Otherwise set selectedSlotIndex=null.",
      "Provide confidence between 0 and 1 and riskLevel from low, medium, high, critical.",
      "For tour_request or availability_question, provide suggestedReply as a natural human message.",
      "Do not copy examples verbatim. Keep tone concise, friendly, and conversational.",
      "If slot options exist, include 2-4 relevant options and ask what works best.",
      "If no slots exist, ask for preferred days/times and offer a virtual tour.",
      "Do not fabricate unavailable data. Keep PII-safe wording.",
      playbookBlock ? `Playbook (style guidance):\n${playbookBlock}` : null,
      examplesBlock ? `Past reply examples (style guidance only):\n${examplesBlock}` : null,
      contextBlock ? `Conversation context (oldest -> newest):\n${contextBlock}` : null,
      `Inbound message:\n${inboundForPrompt}`,
      `Unit context:\n${unitForPrompt}`,
      `Slot options (if any):\n${slotOptionsForPrompt}`
    ].filter(Boolean);

    const result = await generateObject({
      model: google(geminiModel),
      schema: decisionSchema,
      prompt: promptParts.join("\n\n")
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

function normalizeSelectedSlotIndex(value, slotCount) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return null;
  }
  if (parsed < 1) {
    return null;
  }
  if (!Number.isFinite(slotCount) || slotCount < 1) {
    return null;
  }
  return parsed > slotCount ? null : parsed;
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
    selectedSlotIndex: null,
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
      enabled: aiEnabled,
      conversationContext: input.conversationContext || [],
      fewShotExamples: input.fewShotExamples || [],
      playbook: input.playbook || ""
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
    (
      aiSuggestedReply
      || renderedReply
      || (AUTO_REPLY_INTENTS.has(effectiveIntent) && slotCount > 0 ? createDefaultTourReply(input.templateContext) : "")
    );

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
  const selectedSlotIndex = normalizeSelectedSlotIndex(aiDecision?.selectedSlotIndex, slotCount);
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
    selectedSlotIndex,
    replyBody
  };
}

export function listWorkflowOutcomes() {
  return [...WORKFLOW_OUTCOMES];
}
