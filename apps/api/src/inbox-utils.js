const supportedStatuses = new Set(["new", "draft", "sent", "hold"]);
const variablePattern = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function normalizeMessageStatus(direction, metadata) {
  const rawStatus = metadata && typeof metadata === "object" ? metadata.reviewStatus : null;
  if (typeof rawStatus === "string" && supportedStatuses.has(rawStatus)) {
    return rawStatus;
  }

  if (direction === "inbound") {
    return "new";
  }
  return "sent";
}

export function parseTemplateVariables(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

export function extractVariablesFromBody(body) {
  const matches = new Set();
  if (typeof body !== "string") {
    return [];
  }

  for (const match of body.matchAll(variablePattern)) {
    matches.add(match[1]);
  }

  return Array.from(matches.values());
}

export function renderTemplate(body, context) {
  if (typeof body !== "string") {
    return "";
  }
  return body.replace(variablePattern, (_, key) => {
    const value = context[key];
    return value === undefined || value === null ? "" : String(value);
  });
}
