import { createPlatformAdapterRegistry } from "./platform-adapters.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function sanitizeMessageBody(value) {
  if (value === undefined || value === null) {
    return "";
  }
  const body = String(value).replace(/\s+/g, " ").trim();
  if (!body) {
    return "";
  }
  // Some inbox rows can accidentally include injected JS snippets; drop anything after common markers.
  const jqueryIndex = body.indexOf("jQuery(");
  if (jqueryIndex >= 0) {
    return body.slice(0, jqueryIndex).trim();
  }
  return body;
}

const MONTHS = new Map([
  ["jan", 0],
  ["january", 0],
  ["feb", 1],
  ["february", 1],
  ["mar", 2],
  ["march", 2],
  ["apr", 3],
  ["april", 3],
  ["may", 4],
  ["jun", 5],
  ["june", 5],
  ["jul", 6],
  ["july", 6],
  ["aug", 7],
  ["august", 7],
  ["sep", 8],
  ["sept", 8],
  ["september", 8],
  ["oct", 9],
  ["october", 9],
  ["nov", 10],
  ["november", 10],
  ["dec", 11],
  ["december", 11]
]);

function stripTrailingTimezone(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return "";
  }
  // e.g. "Yesterday 11:21 PM EST" -> drop "EST" (but keep AM/PM).
  return trimmed.replace(/\s+([A-Za-z]{2,5})$/, (match, token) => {
    const normalized = String(token || "").toLowerCase();
    if (normalized === "am" || normalized === "pm") {
      return match;
    }
    if (normalized.length < 3) {
      return match;
    }
    return "";
  }).trim();
}

function parseTimeOfDay(text) {
  if (typeof text !== "string") {
    return null;
  }
  const cleaned = stripTrailingTimezone(text).trim();
  if (!cleaned) {
    return null;
  }

  const match = cleaned.match(/^(\d{1,2})(?::(\d{2}))(?::(\d{2}))?\s*([AaPp][Mm])?$/);
  if (!match) {
    return null;
  }

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] ? Number(match[3]) : 0;
  const meridiem = match[4] ? match[4].toLowerCase() : null;

  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }
  if (minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
    return null;
  }

  if (meridiem) {
    if (hours < 1 || hours > 12) {
      return null;
    }
    const isPm = meridiem === "pm";
    hours = hours % 12;
    if (isPm) {
      hours += 12;
    }
  } else if (hours < 0 || hours > 23) {
    return null;
  }

  return { hours, minutes, seconds };
}

function parseHumanDateText(text, now = new Date()) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) {
    return null;
  }

  const normalized = raw.replace(/\s+/g, " ").trim();

  // Relative keywords.
  const relMatch = normalized.match(/^(today|yesterday)(?:\s+(.*))?$/i);
  if (relMatch) {
    const base = new Date(now);
    base.setHours(12, 0, 0, 0);
    if (String(relMatch[1]).toLowerCase() === "yesterday") {
      base.setDate(base.getDate() - 1);
    }

    const timePart = relMatch[2] ? relMatch[2].trim() : "";
    const parsedTime = parseTimeOfDay(timePart);
    if (parsedTime) {
      base.setHours(parsedTime.hours, parsedTime.minutes, parsedTime.seconds, 0);
    }

    return base;
  }

  // US-style "MM/DD/YYYY" (SpareRoom thread pages often use this).
  const slashMatch = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(.*))?$/);
  if (slashMatch) {
    const month = Number(slashMatch[1]);
    const day = Number(slashMatch[2]);
    const year = Number(slashMatch[3]);
    if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) {
      return null;
    }
    const date = new Date(year, month - 1, day, 12, 0, 0, 0);
    const timePart = slashMatch[4] ? slashMatch[4].trim() : "";
    const parsedTime = parseTimeOfDay(timePart);
    if (parsedTime) {
      date.setHours(parsedTime.hours, parsedTime.minutes, parsedTime.seconds, 0);
    }
    return date;
  }

  // Month name formats:
  // - "Jan 20 2026"
  // - "February 1 2026"
  // - optional comma / ordinal suffix.
  const monthMatch = normalized.match(
    /^([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})(?:\s+(.*))?$/
  );
  if (monthMatch) {
    const monthKey = monthMatch[1].toLowerCase();
    const monthIndex = MONTHS.get(monthKey);
    const day = Number(monthMatch[2]);
    const year = Number(monthMatch[3]);
    if (monthIndex === undefined || !Number.isFinite(day) || !Number.isFinite(year)) {
      return null;
    }
    const date = new Date(year, monthIndex, day, 12, 0, 0, 0);
    const timePart = monthMatch[4] ? monthMatch[4].trim() : "";
    const parsedTime = parseTimeOfDay(timePart);
    if (parsedTime) {
      date.setHours(parsedTime.hours, parsedTime.minutes, parsedTime.seconds, 0);
    }
    return date;
  }

  // Fall back to Date.parse for other free-form formats.
  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }
  return null;
}

function createRunnerError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function parseJsonArray(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseBooleanEnv(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

function normalizeAutomationError(error) {
  const message = String(error?.message || "").toLowerCase();

  if (error?.code === "SESSION_EXPIRED" || message.includes("session expired") || error?.status === 401 || error?.statusCode === 401) {
    return createRunnerError("SESSION_EXPIRED", error.message || "session expired", {
      retryable: true,
      cause: error
    });
  }

  if (error?.code === "CAPTCHA_REQUIRED" || message.includes("captcha")) {
    return createRunnerError("CAPTCHA_REQUIRED", error.message || "captcha required", {
      retryable: true,
      cause: error
    });
  }

  if (error?.code === "BOT_CHALLENGE" || message.includes("challenge") || message.includes("cloudflare")) {
    return createRunnerError("BOT_CHALLENGE", error.message || "bot challenge detected", {
      retryable: true,
      cause: error
    });
  }

  return error;
}

function createDefaultPlaywrightFactory(logger = console) {
  function readLaunchConfig() {
    const env = process.env || {};
    const launchArgs = parseJsonArray(env.LEASE_BOT_RPA_LAUNCH_ARGS_JSON) || [];
    const browserChannel = typeof env.LEASE_BOT_RPA_BROWSER_CHANNEL === "string" && env.LEASE_BOT_RPA_BROWSER_CHANNEL.trim().length > 0
      ? env.LEASE_BOT_RPA_BROWSER_CHANNEL.trim()
      : undefined;
    const chromiumSandbox = env.LEASE_BOT_RPA_CHROMIUM_SANDBOX === "0" ? false : undefined;

    return {
      launchArgs,
      browserChannel,
      chromiumSandbox
    };
  }

  function buildLaunchOptions(headless, { omitChannel = false } = {}) {
    const { launchArgs, browserChannel, chromiumSandbox } = readLaunchConfig();

    return {
      headless,
      ...(!omitChannel && browserChannel ? { channel: browserChannel } : {}),
      ...(chromiumSandbox === false ? { chromiumSandbox } : {}),
      ...(launchArgs.length > 0 ? { args: launchArgs } : {})
    };
  }

  async function loadChromium() {
    try {
      const playwright = await import("playwright");
      const chromium = playwright.chromium || playwright.default?.chromium;
      if (!chromium) {
        throw new Error("chromium_unavailable");
      }
      return chromium;
    } catch (error) {
      logger.error?.("[integrations] playwright runtime unavailable", {
        error: error instanceof Error ? error.message : String(error)
      });
      throw createRunnerError("RPA_RUNTIME_UNAVAILABLE", "Playwright runtime is unavailable", {
        retryable: false,
        cause: error
      });
    }
  }

  async function withChannelFallback(action, { platform = null, userDataDir = null } = {}) {
    try {
      return await action({ omitChannel: false });
    } catch (error) {
      const { browserChannel } = readLaunchConfig();
      if (!browserChannel) {
        throw error;
      }

      logger.warn?.("[integrations] playwright launch failed; retrying without browser channel", {
        ...(platform ? { platform } : {}),
        ...(userDataDir ? { userDataDir } : {}),
        channel: browserChannel,
        error: error instanceof Error ? error.message : String(error)
      });

      return action({ omitChannel: true });
    }
  }

  return {
    async launch({ headless }) {
      const chromium = await loadChromium();
      if (typeof chromium.launch !== "function") {
        throw createRunnerError("RPA_RUNTIME_UNAVAILABLE", "Playwright runtime is unavailable", {
          retryable: false
        });
      }

      return withChannelFallback(({ omitChannel }) => chromium.launch(buildLaunchOptions(headless, { omitChannel })));
    }
    ,
    async launchPersistentContext({ headless, userDataDir }) {
      if (typeof userDataDir !== "string" || userDataDir.trim().length === 0) {
        throw createRunnerError("RPA_PROFILE_INVALID", "Invalid userDataDir for persistent context", {
          retryable: false
        });
      }

      const chromium = await loadChromium();
      if (typeof chromium.launchPersistentContext !== "function") {
        throw createRunnerError("RPA_RUNTIME_UNAVAILABLE", "Playwright runtime is unavailable", {
          retryable: false
        });
      }

      return withChannelFallback(
        ({ omitChannel }) => chromium.launchPersistentContext(userDataDir, buildLaunchOptions(headless, { omitChannel })),
        { userDataDir }
      );
    }
  };
}

async function detectProtectionLayer(page, adapter, response = null) {
  const challengeSelectors = adapter.selectors?.challenge || [];
  for (const selector of challengeSelectors) {
    if (await page.$(selector)) {
      throw createRunnerError("BOT_CHALLENGE", `Bot challenge detected on ${adapter.platform}`, { retryable: true });
    }
  }

  const captchaSelectors = adapter.selectors?.captcha || [];
  for (const selector of captchaSelectors) {
    if (await page.$(selector)) {
      throw createRunnerError("CAPTCHA_REQUIRED", `Captcha detected on ${adapter.platform}`, { retryable: true });
    }
  }

  // Auth/session gate detection (login page, "please log in" interstitial, etc).
  // The concrete patterns live in adapter definitions so we don't overfit generic heuristics.
  let url = "";
  if (typeof page?.url === "function") {
    try {
      url = await page.url();
    } catch {
      url = "";
    }
  }
  const authRequiredUrlPatterns = adapter.authRequiredUrlPatterns || [];
  for (const pattern of authRequiredUrlPatterns) {
    if (typeof pattern === "string" && pattern.length > 0 && url.includes(pattern)) {
      throw createRunnerError("SESSION_EXPIRED", `Authentication required on ${adapter.platform}`, { retryable: true });
    }
  }

  const authRequiredText = adapter.authRequiredText || [];
  if (authRequiredText.length > 0) {
    let text = "";
    if (typeof page?.evaluate === "function") {
      try {
        text = await page.evaluate(() => (document.body?.innerText || ""));
      } catch {
        text = "";
      }
    }
    const normalizedText = String(text || "").toLowerCase();
    for (const marker of authRequiredText) {
      if (typeof marker === "string" && marker.length > 0 && normalizedText.includes(marker.toLowerCase())) {
        throw createRunnerError("SESSION_EXPIRED", `Authentication required on ${adapter.platform}`, { retryable: true });
      }
    }
  }

  // Fallback detection for common anti-bot layers (Cloudflare "Just a moment", "blocked", etc).
  let title = "";
  if (typeof page?.title === "function") {
    try {
      title = await page.title();
    } catch {
      title = "";
    }
  }
  const normalizedTitle = title.toLowerCase();
  const status = typeof response?.status === "function" ? response.status() : null;

  const titleLooksLikeChallenge = normalizedTitle.includes("just a moment")
    || normalizedTitle.includes("attention required")
    || normalizedTitle.includes("access denied")
    || normalizedTitle.includes("request blocked")
    || normalizedTitle.includes("service unavailable");

  if (titleLooksLikeChallenge || status === 403 || status === 429 || status === 503) {
    let text = "";
    if (typeof page?.evaluate === "function") {
      try {
        text = await page.evaluate(() => (document.body?.innerText || ""));
      } catch {
        text = "";
      }
    }
    const normalizedText = String(text || "").toLowerCase();

    if (
      normalizedText.includes("verifying you are human")
      || normalizedText.includes("needs to review the security of your connection")
      || normalizedText.includes("performance & security by cloudflare")
      || normalizedText.includes("ray id")
      || normalizedText.includes("cloudflare")
    ) {
      if (normalizedText.includes("sorry, you have been blocked") || normalizedText.includes("unable to access")) {
        throw createRunnerError("ACCESS_BLOCKED", `Access blocked on ${adapter.platform}`, { retryable: false });
      }
      throw createRunnerError("BOT_CHALLENGE", `Bot challenge detected on ${adapter.platform}`, { retryable: true });
    }
  }
}

async function defaultIngestHandler({ adapter, page, clock }) {
  const response = await page.goto(adapter.inboxUrl, { waitUntil: "domcontentloaded" });
  await detectProtectionLayer(page, adapter, response);

  const selector = adapter.selectors?.messageItems?.[0] || "[data-thread-id][data-message-id]";
  const bodySelector = adapter.selectors?.messageBody?.[0] || "[data-role='message-body']";
  const sentAtSelector = Array.isArray(adapter.selectors?.messageSentAt)
    ? adapter.selectors.messageSentAt[0]
    : typeof adapter.selectors?.messageSentAt === "string"
    ? adapter.selectors.messageSentAt
    : null;
  const leadNameSelector = Array.isArray(adapter.selectors?.leadName)
    ? adapter.selectors.leadName[0]
    : typeof adapter.selectors?.leadName === "string"
    ? adapter.selectors.leadName
    : null;
  const now = clock();
  const messages = await page.$$eval(
    selector,
    (elements, meta) => elements.map((element, index) => {
      const threadId = element.getAttribute("data-thread-id") || element.getAttribute("data-thread") || `thread-${index + 1}`;
      const messageId = element.getAttribute("data-message-id") || `message-${index + 1}`;
      const bodyElement = element.querySelector(meta.bodySelector);
      const body = bodyElement?.textContent?.trim() || element.textContent?.trim() || "";
      const sentAtText = meta.sentAtSelector ? element.querySelector(meta.sentAtSelector)?.textContent?.trim() : null;
      const leadNameRaw = element.getAttribute("data-lead-name")
        || (meta.leadNameSelector ? element.querySelector(meta.leadNameSelector)?.textContent?.trim() : null)
        || null;
      const leadName = leadNameRaw ? leadNameRaw.replace(/\s*\(\d+\)\s*$/, "").trim() : null;
      return {
        externalThreadId: threadId,
        externalMessageId: messageId,
        body,
        leadName,
        sentAtText,
        channel: "in_app",
        metadata: {
          adapter: meta.platform,
          source: "playwright_rpa"
        }
      };
    }),
    {
      bodySelector,
      sentAtSelector,
      leadNameSelector,
      platform: adapter.platform,
      nowIso: now.toISOString()
    }
  );

  const normalizedMessages = messages.map((message) => {
    const parsed = message.sentAtText ? parseHumanDateText(message.sentAtText, now) : null;
    const sentAt = parsed ? parsed.toISOString() : now.toISOString();
    const sentAtSource = parsed ? "platform_inbox" : "clock";

    return {
      ...message,
      body: sanitizeMessageBody(message.body),
      sentAt,
      metadata: {
        ...(message.metadata || {}),
        sentAtSource,
        ...(message.sentAtText ? { sentAtText: message.sentAtText } : {})
      }
    };
  });

  return { messages: normalizedMessages };
}

async function defaultThreadSyncHandler({ adapter, page, payload, clock }) {
  const threadId = payload?.externalThreadId || payload?.threadId;
  if (!threadId) {
    throw createRunnerError("THREAD_ID_REQUIRED", `Missing externalThreadId for ${adapter.platform}`, {
      retryable: false
    });
  }

  const response = await page.goto(adapter.threadUrl(threadId), { waitUntil: "domcontentloaded" });
  await detectProtectionLayer(page, adapter, response);

  if (adapter.platform !== "spareroom") {
    throw createRunnerError("THREAD_SYNC_UNSUPPORTED", `Thread sync is not supported for ${adapter.platform}`, {
      retryable: false
    });
  }

  const selector = adapter.selectors?.threadMessageItems?.[0] || "li.message[id^='msg_']";
  const bodySelector = adapter.selectors?.threadMessageBody?.[0] || "dd.message_body";
  const sentAtSelector = adapter.selectors?.threadMessageSentAt?.[0] || "dd.message_date";
  const now = clock();

  const rawMessages = await page.$$eval(
    selector,
    (elements, meta) => elements.map((element, index) => {
      const idValue = element.getAttribute("id") || "";
      const match = idValue.match(/^msg_(.+)$/);
      const messageId = match?.[1] || element.getAttribute("data-message-id") || `message-${index + 1}`;
      const bodyElement = element.querySelector(meta.bodySelector);
      const body = bodyElement?.textContent?.trim() || "";
      const sentAtText = element.querySelector(meta.sentAtSelector)?.textContent?.trim() || "";
      const className = element.getAttribute("class") || "";
      const isOutbound = className.includes("message_out");

      return {
        externalThreadId: meta.threadId,
        externalMessageId: messageId,
        direction: isOutbound ? "outbound" : "inbound",
        body,
        channel: "in_app",
        sentAtText
      };
    }),
    { threadId, bodySelector, sentAtSelector }
  );

  const normalizedMessages = rawMessages
    .map((message) => {
      const parsed = message.sentAtText ? parseHumanDateText(message.sentAtText, now) : null;
      const sentAt = parsed ? parsed.toISOString() : now.toISOString();
      return {
        ...message,
        body: sanitizeMessageBody(message.body),
        sentAt,
        metadata: {
          adapter: adapter.platform,
          source: "playwright_rpa",
          sentAtSource: "platform_thread",
          ...(message.sentAtText ? { sentAtText: message.sentAtText } : {})
        }
      };
    })
    .filter((message) => message.body.length > 0);

  return { messages: normalizedMessages };
}

async function defaultSendHandler({ adapter, page, payload, clock }) {
  const threadId = payload?.externalThreadId;
  if (!threadId) {
    throw createRunnerError("OUTBOUND_THREAD_REQUIRED", `Missing externalThreadId for ${adapter.platform}`, {
      retryable: false
    });
  }
  if (!payload?.body) {
    throw createRunnerError("OUTBOUND_BODY_REQUIRED", `Missing outbound body for ${adapter.platform}`, {
      retryable: false
    });
  }

  const response = await page.goto(adapter.threadUrl(threadId), { waitUntil: "domcontentloaded" });
  await detectProtectionLayer(page, adapter, response);
  await page.fill(adapter.selectors.composer, payload.body);
  await page.click(adapter.selectors.submit);

  return {
    externalMessageId: `${adapter.platform}-${threadId}-${clock().getTime()}`,
    channel: "in_app",
    status: "sent"
  };
}

function createMockRpaRunner() {
  return {
    async run({ action, platform }) {
      if (action === "ingest") {
        return { messages: [] };
      }
      if (action === "thread_sync") {
        return { messages: [] };
      }
      return {
        externalMessageId: `${platform || "rpa"}-${Date.now()}`,
        status: "sent",
        channel: "in_app"
      };
    }
  };
}

export function createPlaywrightRpaRunner(options = {}) {
  const logger = options.logger || console;
  const adapterRegistry = options.adapterRegistry || createPlatformAdapterRegistry(options.adapterOverrides);
  const actionHandlers = options.actionHandlers || {};
  const hooks = options.hooks || {};
  const debugArtifactsEnabled = options.debugArtifactsEnabled ?? process.env.LEASE_BOT_RPA_DEBUG === "1";
  const debugArtifactsDir = options.debugArtifactsDir || process.env.LEASE_BOT_RPA_DEBUG_DIR || ".playwright/rpa-debug";
  const envHeadless = parseBooleanEnv(process.env.LEASE_BOT_RPA_HEADLESS);
  const headless = typeof options.headless === "boolean" ? options.headless : envHeadless === null ? true : envHeadless;
  const clock = options.clock || (() => new Date());
  const playwrightFactory = options.playwrightFactory || createDefaultPlaywrightFactory(logger);

  async function captureDebugArtifacts(page, meta) {
    if (!debugArtifactsEnabled || !page) {
      return null;
    }

    const safePlatform = String(meta.platform || "unknown").replace(/[^a-z0-9_-]/gi, "_");
    const safeAction = String(meta.action || "unknown").replace(/[^a-z0-9_-]/gi, "_");
    const safeAccount = String(meta.accountId || "unknown").replace(/[^a-z0-9_-]/gi, "_");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const baseName = `${stamp}-${safePlatform}-${safeAction}-${safeAccount}-attempt${meta.attempt || 1}`;

    await mkdir(debugArtifactsDir, { recursive: true });

    const result = {
      dir: debugArtifactsDir,
      screenshotPath: path.join(debugArtifactsDir, `${baseName}.png`),
      htmlPath: path.join(debugArtifactsDir, `${baseName}.html`),
      metaPath: path.join(debugArtifactsDir, `${baseName}.json`)
    };

    try {
      const html = await page.content().catch(() => "");
      let url = "";
      try {
        url = page.url();
      } catch {
        url = "";
      }
      await Promise.allSettled([
        page.screenshot({ path: result.screenshotPath, fullPage: true }),
        writeFile(result.htmlPath, html || "", "utf8"),
        writeFile(result.metaPath, JSON.stringify({ ...meta, url }, null, 2), "utf8")
      ]);
    } catch (error) {
      logger.warn?.("[integrations] failed capturing rpa debug artifacts", {
        platform: meta.platform,
        action: meta.action,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }

    return result;
  }

  return {
    async run({ platform, action, account, payload, session, attempt }) {
      const adapter = adapterRegistry.get(platform);
      if (!adapter) {
        throw createRunnerError("UNSUPPORTED_PLATFORM", `Unsupported platform '${platform}'`, {
          retryable: false
        });
      }

      const actionHandler = actionHandlers?.[platform]?.[action]
        || (action === "ingest"
          ? defaultIngestHandler
          : action === "send"
            ? defaultSendHandler
            : action === "thread_sync"
              ? defaultThreadSyncHandler
              : null);

      if (!actionHandler) {
        throw createRunnerError("UNSUPPORTED_ACTION", `Unsupported action '${action}' for ${platform}`, {
          retryable: false
        });
      }

      const startedAt = Date.now();
      hooks.onEvent?.({
        type: "rpa_run_started",
        platform,
        action,
        accountId: account?.id || null,
        attempt: attempt || 1
      });

      let browser;
      let context;
      let page;
      try {
        if (session?.userDataDir) {
          if (typeof playwrightFactory.launchPersistentContext !== "function") {
            throw createRunnerError("RPA_PROFILE_UNSUPPORTED", "Persistent profile is not supported by the current runner", {
              retryable: false
            });
          }
          context = await playwrightFactory.launchPersistentContext({
            platform,
            action,
            account,
            headless,
            userDataDir: session.userDataDir
          });
          browser = typeof context?.browser === "function" ? context.browser() : null;
        } else {
          browser = await playwrightFactory.launch({ platform, action, account, headless });
          context = await browser.newContext({
            storageState: session?.storageState || undefined
          });
        }
        page = await context.newPage();
        const result = await actionHandler({
          adapter,
          page,
          payload,
          account,
          session,
          attempt: attempt || 1,
          clock
        });

        hooks.onEvent?.({
          type: "rpa_run_succeeded",
          platform,
          action,
          accountId: account?.id || null,
          durationMs: Date.now() - startedAt
        });

        return result;
      } catch (rawError) {
        const debugArtifacts = await captureDebugArtifacts(page, {
          platform,
          action,
          accountId: account?.id || null,
          attempt: attempt || 1
        });
        const error = normalizeAutomationError(rawError);
        hooks.onEvent?.({
          type: "rpa_run_failed",
          platform,
          action,
          accountId: account?.id || null,
          code: error?.code || "UNKNOWN",
          message: error?.message || String(error),
          ...(debugArtifacts ? { debugArtifacts } : {})
        });
        throw error;
      } finally {
        try {
          await context?.close();
        } catch {
          logger.warn?.("[integrations] failed closing playwright context", { platform, action });
        }
        try {
          await browser?.close();
        } catch {
          logger.warn?.("[integrations] failed closing playwright browser", { platform, action });
        }
      }
    }
  };
}

export function createRpaRunner(options = {}) {
  const runtimeMode = String(options.runtimeMode || process.env.LEASE_BOT_RPA_RUNTIME || "mock").trim().toLowerCase();
  const appEnv = String(options.appEnv || process.env.NODE_ENV || "development").trim().toLowerCase();

  if (appEnv === "production" && runtimeMode !== "playwright") {
    throw createRunnerError(
      "MOCK_RUNTIME_FORBIDDEN",
      "Mock RPA runtime is forbidden in production; set LEASE_BOT_RPA_RUNTIME=playwright"
    );
  }

  if (runtimeMode === "playwright") {
    return createPlaywrightRpaRunner(options);
  }
  return createMockRpaRunner(options);
}
