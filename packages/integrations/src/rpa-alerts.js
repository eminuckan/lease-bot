function parseBoolean(value, fallback = false) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseCsv(value, fallback = []) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function detectProvider(env) {
  const configured = typeof env.LEASE_BOT_RPA_ALERTS_PROVIDER === "string"
    ? env.LEASE_BOT_RPA_ALERTS_PROVIDER.trim().toLowerCase()
    : "";
  if (configured) {
    return configured;
  }

  const hasTelegram = Boolean(
    typeof env.LEASE_BOT_RPA_ALERT_TELEGRAM_BOT_TOKEN === "string"
      && env.LEASE_BOT_RPA_ALERT_TELEGRAM_BOT_TOKEN.trim().length > 0
      && typeof env.LEASE_BOT_RPA_ALERT_TELEGRAM_CHAT_ID === "string"
      && env.LEASE_BOT_RPA_ALERT_TELEGRAM_CHAT_ID.trim().length > 0
  );
  if (hasTelegram) {
    return "telegram";
  }

  const hasWebhook = Boolean(
    typeof env.LEASE_BOT_RPA_ALERT_WEBHOOK_URL === "string"
      && env.LEASE_BOT_RPA_ALERT_WEBHOOK_URL.trim().length > 0
  );
  if (hasWebhook) {
    return "webhook";
  }

  return "none";
}

function buildAlertMessage(event, source) {
  const lines = [
    `Lease Bot alert (${source})`,
    `Event: ${event.type || "unknown"}`,
    `Platform: ${event.platform || "unknown"}`,
    `Account: ${event.accountId || "unknown"}`,
    `Action: ${event.action || "unknown"}`
  ];

  if (event.reason) {
    lines.push(`Reason: ${event.reason}`);
  }
  if (event.retryAfterMs !== undefined && event.retryAfterMs !== null) {
    lines.push(`Retry after: ${event.retryAfterMs}ms`);
  }
  if (event.error) {
    lines.push(`Error: ${String(event.error).slice(0, 500)}`);
  }

  lines.push(`Time: ${new Date().toISOString()}`);
  return lines.join("\n");
}

export function createRpaAlertDispatcher(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const source = options.source || "runtime";
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const nowMs = options.nowMs || (() => Date.now());

  const enabled = parseBoolean(env.LEASE_BOT_RPA_ALERTS_ENABLED, false);
  const provider = detectProvider(env);
  const cooldownMs = parsePositiveInt(env.LEASE_BOT_RPA_ALERT_COOLDOWN_MS, 5 * 60 * 1000);
  const eventTypes = new Set(
    parseCsv(
      env.LEASE_BOT_RPA_ALERT_EVENT_TYPES,
      ["rpa_session_refresh_requested", "rpa_circuit_opened"]
    )
  );

  const lastSentByKey = new Map();

  function buildCooldownKey(event) {
    return [
      event?.type || "unknown",
      event?.platform || "unknown",
      event?.accountId || "unknown",
      event?.action || "unknown",
      event?.reason || ""
    ].join(":");
  }

  async function sendTelegram(text) {
    const token = String(env.LEASE_BOT_RPA_ALERT_TELEGRAM_BOT_TOKEN || "").trim();
    const chatId = String(env.LEASE_BOT_RPA_ALERT_TELEGRAM_CHAT_ID || "").trim();
    if (!token || !chatId) {
      throw new Error("telegram alert settings are missing");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("fetch is unavailable for telegram alerts");
    }

    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`telegram alert failed (${response.status}): ${body.slice(0, 400)}`);
    }
  }

  async function sendWebhook(text, event) {
    const webhookUrl = String(env.LEASE_BOT_RPA_ALERT_WEBHOOK_URL || "").trim();
    if (!webhookUrl) {
      throw new Error("webhook alert url is missing");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("fetch is unavailable for webhook alerts");
    }

    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        source,
        text,
        event,
        sentAt: new Date().toISOString()
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`webhook alert failed (${response.status}): ${body.slice(0, 400)}`);
    }
  }

  async function dispatchEvent(event) {
    if (!enabled) {
      return { sent: false, reason: "disabled" };
    }
    if (!event || typeof event !== "object") {
      return { sent: false, reason: "invalid_event" };
    }
    if (!eventTypes.has(event.type)) {
      return { sent: false, reason: "event_filtered" };
    }
    if (provider === "none") {
      return { sent: false, reason: "provider_unconfigured" };
    }

    const key = buildCooldownKey(event);
    const now = nowMs();
    const previous = lastSentByKey.get(key) || 0;
    if (now - previous < cooldownMs) {
      return { sent: false, reason: "cooldown" };
    }

    const text = buildAlertMessage(event, source);
    if (provider === "telegram") {
      await sendTelegram(text);
    } else if (provider === "webhook") {
      await sendWebhook(text, event);
    } else {
      return { sent: false, reason: "provider_unsupported" };
    }

    lastSentByKey.set(key, now);
    logger.warn?.("[alerts] rpa alert sent", {
      source,
      provider,
      type: event.type,
      platform: event.platform || "unknown",
      accountId: event.accountId || "unknown",
      action: event.action || "unknown"
    });
    return { sent: true };
  }

  function handleEvent(event) {
    void dispatchEvent(event).catch((error) => {
      logger.error?.("[alerts] failed sending rpa alert", {
        source,
        provider,
        type: event?.type || "unknown",
        platform: event?.platform || "unknown",
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  return {
    enabled,
    provider,
    cooldownMs,
    eventTypes: [...eventTypes],
    handleEvent,
    dispatchEvent
  };
}
