const BLOCKED_INBOUND_PATTERNS = [
  { reason: "legal_escalation", pattern: /\b(attorney|lawyer|legal notice|lawsuit)\b/i },
  { reason: "abusive_language", pattern: /\b(hate you|idiot|stupid)\b/i },
  { reason: "payment_or_pii", pattern: /\b(ssn|social security|credit card|routing number)\b/i }
];

export function evaluateGuardrails({ inboundBody, outboundBody }) {
  const reasons = [];
  const inboundText = typeof inboundBody === "string" ? inboundBody : "";
  const outboundText = typeof outboundBody === "string" ? outboundBody : "";

  for (const candidate of BLOCKED_INBOUND_PATTERNS) {
    if (candidate.pattern.test(inboundText)) {
      reasons.push(candidate.reason);
    }
  }

  if (/\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/.test(outboundText)) {
    reasons.push("outbound_contains_ssn_pattern");
  }

  return {
    blocked: reasons.length > 0,
    reasons
  };
}
