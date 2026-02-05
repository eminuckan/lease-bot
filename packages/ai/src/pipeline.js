import { evaluateGuardrails } from "./guardrails.js";

const FOLLOW_UP_PATTERN = /\b(follow\s*up|any update|checking in|just checking|status\??)\b/i;

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

export function decideReplyEligibility({ intent, rule, templateBody, guardrails }) {
  if (intent === "unsubscribe") {
    return { eligible: false, reason: "unsubscribe_requested" };
  }
  if (guardrails.blocked) {
    return { eligible: false, reason: "guardrail_blocked" };
  }
  if (!rule) {
    return { eligible: false, reason: "no_matching_rule" };
  }
  if (!templateBody || !templateBody.trim()) {
    return { eligible: false, reason: "template_missing" };
  }
  if (intent === "unknown") {
    return { eligible: false, reason: "intent_unknown" };
  }

  return {
    eligible: true,
    reason: rule.enabled ? "auto_send" : "requires_review"
  };
}

export function runReplyPipeline(input) {
  const intent = classifyIntent(input.inboundBody);
  const followUp = detectFollowUp(input.inboundBody, input.hasRecentOutbound);
  const effectiveIntent = followUp ? "follow_up" : intent;
  const eligibilityIntent = intent === "unsubscribe" ? intent : followUp ? input.fallbackIntent || intent : intent;
  const templateBody = input.template?.body || "";
  const renderedReply = renderTemplate(templateBody, input.templateContext || {});
  const guardrails = evaluateGuardrails({
    inboundBody: input.inboundBody,
    outboundBody: renderedReply
  });
  const eligibility = decideReplyEligibility({
    intent: eligibilityIntent,
    rule: input.rule,
    templateBody,
    guardrails
  });

  return {
    intent,
    effectiveIntent,
    followUp,
    guardrails,
    eligibility,
    replyBody: renderedReply
  };
}
