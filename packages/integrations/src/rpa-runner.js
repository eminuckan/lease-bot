import { createPlatformAdapterRegistry } from "./platform-adapters.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { formatInTimezone, zonedTimeToUtc } from "./timezone.js";

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

const TIMEZONE_ABBREVIATION_MAP = new Map([
  ["EST", "America/New_York"],
  ["EDT", "America/New_York"],
  ["CST", "America/Chicago"],
  ["CDT", "America/Chicago"],
  ["MST", "America/Denver"],
  ["MDT", "America/Denver"],
  ["PST", "America/Los_Angeles"],
  ["PDT", "America/Los_Angeles"],
  ["UTC", "Etc/UTC"],
  ["GMT", "Etc/GMT"]
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

function extractTrailingTimezoneAbbreviation(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/\b([A-Za-z]{2,5})$/);
  if (!match) {
    return null;
  }
  const token = String(match[1] || "").toUpperCase();
  return TIMEZONE_ABBREVIATION_MAP.has(token) ? token : null;
}

function addDaysToIsoDate(dateString, deltaDays) {
  const [year, month, day] = String(dateString || "").split("-").map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  const base = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  base.setUTCDate(base.getUTCDate() + Number(deltaDays || 0));

  const two = (n) => String(n).padStart(2, "0");
  return `${base.getUTCFullYear()}-${two(base.getUTCMonth() + 1)}-${two(base.getUTCDate())}`;
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

function hasExplicitTimeInHumanDateText(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) {
    return false;
  }

  const normalized = raw.replace(/\s+/g, " ").trim();

  const relMatch = normalized.match(/^(today|yesterday)(?:\s+(.*))?$/i);
  if (relMatch) {
    const timePart = relMatch[2] ? relMatch[2].trim() : "";
    return Boolean(parseTimeOfDay(timePart));
  }

  const slashMatch = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(.*))?$/);
  if (slashMatch) {
    const timePart = slashMatch[4] ? slashMatch[4].trim() : "";
    return Boolean(parseTimeOfDay(timePart));
  }

  const monthMatch = normalized.match(
    /^([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})(?:\s+(.*))?$/
  );
  if (monthMatch) {
    const timePart = monthMatch[4] ? monthMatch[4].trim() : "";
    return Boolean(parseTimeOfDay(timePart));
  }

  return Boolean(parseTimeOfDay(normalized));
}

function parseHumanDateTextInTimezone(text, now, timezone) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) {
    return null;
  }
  if (typeof timezone !== "string" || timezone.trim().length === 0) {
    return null;
  }

  const normalized = raw.replace(/\s+/g, " ").trim();
  const zonedNow = formatInTimezone(now, timezone);
  const zonedNowDate = zonedNow.slice(0, 10);
  const zonedNowTime = zonedNow.slice(11, 19);

  const two = (n) => String(n).padStart(2, "0");

  // Relative keywords.
  const relMatch = normalized.match(/^(today|yesterday)(?:\s+(.*))?$/i);
  if (relMatch) {
    const relKey = String(relMatch[1] || "").toLowerCase();
    const timePart = relMatch[2] ? relMatch[2].trim() : "";
    const parsedTime = parseTimeOfDay(timePart);

    const baseDate = relKey === "yesterday" ? addDaysToIsoDate(zonedNowDate, -1) : zonedNowDate;
    if (!baseDate) {
      return null;
    }

    // If time isn't present (e.g. "Today"), treat it as "now" to avoid false "too old" gating.
    const timeString = parsedTime
      ? `${two(parsedTime.hours)}:${two(parsedTime.minutes)}:${two(parsedTime.seconds)}`
      : zonedNowTime;

    return zonedTimeToUtc(baseDate, timeString, timezone);
  }

  // US-style "MM/DD/YYYY" (SpareRoom thread pages sometimes use this).
  const slashMatch = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(.*))?$/);
  if (slashMatch) {
    const month = Number(slashMatch[1]);
    const day = Number(slashMatch[2]);
    const year = Number(slashMatch[3]);
    if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) {
      return null;
    }

    const dateString = `${year}-${two(month)}-${two(day)}`;
    const timePart = slashMatch[4] ? slashMatch[4].trim() : "";
    const parsedTime = parseTimeOfDay(timePart);
    const timeString = parsedTime
      ? `${two(parsedTime.hours)}:${two(parsedTime.minutes)}:${two(parsedTime.seconds)}`
      : "12:00:00";

    return zonedTimeToUtc(dateString, timeString, timezone);
  }

  // Month name formats:
  // - "Jan 20 2026"
  // - "February 1 2026"
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

    const dateString = `${year}-${two(monthIndex + 1)}-${two(day)}`;
    const timePart = monthMatch[4] ? monthMatch[4].trim() : "";
    const parsedTime = parseTimeOfDay(timePart);
    const timeString = parsedTime
      ? `${two(parsedTime.hours)}:${two(parsedTime.minutes)}:${two(parsedTime.seconds)}`
      : "12:00:00";

    return zonedTimeToUtc(dateString, timeString, timezone);
  }

  return null;
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

function resolveParsingTimezone(adapter, sentAtText) {
  const abbrev = extractTrailingTimezoneAbbreviation(sentAtText);
  if (abbrev) {
    return TIMEZONE_ABBREVIATION_MAP.get(abbrev) || null;
  }

  if (adapter?.platform === "spareroom") {
    const envTimezone = typeof process.env.LEASE_BOT_RPA_TIMEZONE_SPAREROOM === "string"
      ? process.env.LEASE_BOT_RPA_TIMEZONE_SPAREROOM.trim()
      : "";
    const devFallback = typeof process.env.LEASE_BOT_DEV_AGENT_TIMEZONE === "string"
      ? process.env.LEASE_BOT_DEV_AGENT_TIMEZONE.trim()
      : "";

    return envTimezone || devFallback || "America/New_York";
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
    async launchPersistentContext({ headless, userDataDir, contextOptions = {} }) {
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
        ({ omitChannel }) =>
          chromium.launchPersistentContext(userDataDir, {
            ...buildLaunchOptions(headless, { omitChannel }),
            ...(contextOptions && typeof contextOptions === "object" ? contextOptions : {})
          }),
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

function toSelectorList(value, fallback = []) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? [normalized] : [];
  }
  return Array.isArray(fallback) ? fallback.filter(Boolean) : [];
}

async function pickFirstExistingSelector(page, selectors = []) {
  for (const selector of selectors) {
    if (!selector) {
      continue;
    }
    try {
      if (await page.$(selector)) {
        return selector;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function defaultIngestHandler({ adapter, page, clock }) {
  const response = await page.goto(adapter.inboxUrl, { waitUntil: "domcontentloaded" });
  await detectProtectionLayer(page, adapter, response);

  const messageSelectors = toSelectorList(adapter.selectors?.messageItems, [
    "[data-thread-id][data-message-id]",
    "[data-thread-id]",
    "a[href*='/messages/']",
    "a[href*='/inbox/']"
  ]);
  const bodySelectors = toSelectorList(adapter.selectors?.messageBody, ["[data-role='message-body']", "p", "span"]);
  const sentAtSelectors = toSelectorList(adapter.selectors?.messageSentAt, ["time[datetime]", "[class*='time' i]", "[class*='date' i]"]);
  const leadNameSelectors = toSelectorList(adapter.selectors?.leadName, ["[class*='name' i]", "h3", "h4", "strong"]);
  const threadLabelSelectors = toSelectorList(adapter.selectors?.threadLabel, ["[class*='listing' i]", "[class*='title' i]"]);
  const maxThreads = Number(process.env.LEASE_BOT_RPA_INBOX_THREAD_LIMIT || 0);
  const now = clock();
  const messages = await page.evaluate(
    (meta) => {
      const dedupeElements = new Set();
      const orderedElements = [];
      const safeQueryAll = (selector) => {
        try {
          return Array.from(document.querySelectorAll(selector));
        } catch {
          return [];
        }
      };

      for (const selector of meta.messageSelectors) {
        const nodes = safeQueryAll(selector);
        for (const node of nodes) {
          if (!dedupeElements.has(node)) {
            dedupeElements.add(node);
            orderedElements.push(node);
          }
        }
      }

      const extractTextBySelectors = (root, selectors) => {
        for (const selector of selectors) {
          if (!selector) {
            continue;
          }
          try {
            const element = root.querySelector(selector);
            const text = element?.textContent?.replace(/\s+/g, " ").trim();
            if (text) {
              return text;
            }
          } catch {
            continue;
          }
        }
        return "";
      };

      const parseThreadId = (element, index) => {
        const fromAttr = element.getAttribute("data-thread-id")
          || element.getAttribute("data-thread")
          || element.getAttribute("data-conversation-id")
          || element.getAttribute("data-id");
        if (fromAttr && String(fromAttr).trim()) {
          return String(fromAttr).trim();
        }

        const anchor = element.matches("a[href]")
          ? element
          : element.querySelector("a[href*='/messages/'], a[href*='/inbox/']");
        const href = anchor?.getAttribute("href") || "";
        const match = href.match(/\/(?:messages|inbox)\/([^/?#]+)/i);
        if (match?.[1]) {
          return String(match[1]).trim();
        }
        const queryMatch = href.match(/[?&](?:thread_id|conversation_id|conversation|thread|message_thread_id|id)=([^&#]+)/i);
        if (queryMatch?.[1]) {
          try {
            return decodeURIComponent(String(queryMatch[1])).trim();
          } catch {
            return String(queryMatch[1]).trim();
          }
        }
        return `thread-${index + 1}`;
      };

      const parseListingExternalId = (element, threadId) => {
        const fromAttr = element.getAttribute("data-listing-id")
          || element.getAttribute("data-room-id")
          || element.getAttribute("data-unit-id");
        if (fromAttr && String(fromAttr).trim()) {
          return String(fromAttr).trim();
        }

        const anchor = element.matches("a[href]")
          ? element
          : element.querySelector("a[href*='/rooms/'], a[href*='/listings/'], a[href*='/listing/'], a[href*='/for-rent/'], a[href*='/apartment/']");
        const href = anchor?.getAttribute("href") || "";
        const roomMatch = href.match(/\/rooms\/([^/?#]+)/i);
        if (roomMatch?.[1]) {
          return String(roomMatch[1]).trim();
        }
        const listingMatch = href.match(/\/listings\/([^/?#]+)/i);
        if (listingMatch?.[1]) {
          return String(listingMatch[1]).trim();
        }
        const leasebreakListingMatch = href.match(/\/(?:listing|for-rent|apartments?)\/([^/?#]+)/i);
        if (leasebreakListingMatch?.[1]) {
          return String(leasebreakListingMatch[1]).trim();
        }
        const queryMatch = href.match(/[?&](?:listing_id|listing|room_id|unit_id|advert_id)=([^&#]+)/i);
        if (queryMatch?.[1]) {
          try {
            return decodeURIComponent(String(queryMatch[1])).trim();
          } catch {
            return String(queryMatch[1]).trim();
          }
        }

        if (meta.platform === "spareroom" && typeof threadId === "string") {
          const sparseMatch = threadId.match(/^(\d+)_([0-9]+)$/);
          if (sparseMatch?.[2]) {
            return sparseMatch[2];
          }
        }

        return null;
      };

      const parseLeadExternalId = (element, threadId) => {
        const fromAttr = element.getAttribute("data-lead-id")
          || element.getAttribute("data-user-id")
          || element.getAttribute("data-profile-id");
        if (fromAttr && String(fromAttr).trim()) {
          return String(fromAttr).trim();
        }

        if (meta.platform === "spareroom" && typeof threadId === "string") {
          const sparseMatch = threadId.match(/^(\d+)_([0-9]+)$/);
          if (sparseMatch?.[1]) {
            return sparseMatch[1];
          }
        }

        return null;
      };

      const parseMessageId = (element, threadId, body, sentAtText, direction, index) => {
        const idAttr = element.getAttribute("data-message-id")
          || element.getAttribute("data-last-message-id")
          || element.getAttribute("data-id");
        if (idAttr && String(idAttr).trim()) {
          return String(idAttr).trim();
        }

        const rawId = element.getAttribute("id") || "";
        if (rawId) {
          const match = rawId.match(/^(?:msg|message)[_-](.+)$/i);
          if (match?.[1]) {
            return String(match[1]).trim();
          }
          return rawId.trim();
        }

        const stableToken = [threadId, sentAtText || "", body.slice(0, 120), direction || "inbound"]
          .join("|")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 120);
        if (stableToken) {
          return `preview-${stableToken}`;
        }
        return `message-${index + 1}`;
      };

      const rawRows = (meta.maxThreads > 0 ? orderedElements.slice(0, meta.maxThreads) : orderedElements)
        .map((element, index) => {
          const threadId = parseThreadId(element, index);
          const className = String(element.getAttribute("class") || "").toLowerCase();
          const direction = className.includes("thread_out")
            || className.includes("outbound")
            || className.includes("from-me")
            || className.includes("message_out")
            ? "outbound"
            : "inbound";

          const body = extractTextBySelectors(element, meta.bodySelectors)
            || (element.textContent || "").replace(/\s+/g, " ").trim();
          const sentAtText = extractTextBySelectors(element, meta.sentAtSelectors) || "";
          const leadNameRaw = element.getAttribute("data-lead-name")
            || extractTextBySelectors(element, meta.leadNameSelectors)
            || "";
          const threadLabel = extractTextBySelectors(element, meta.threadLabelSelectors);

          const threadMessageCountMatch = leadNameRaw.match(/\((\d+)\)\s*$/);
          const threadMessageCount = threadMessageCountMatch?.[1]
            ? Number(threadMessageCountMatch[1])
            : null;
          const leadName = leadNameRaw ? leadNameRaw.replace(/\s*\(\d+\)\s*$/, "").trim() : null;

          const listingExternalId = parseListingExternalId(element, threadId);
          const leadExternalId = parseLeadExternalId(element, threadId);
          const messageId = parseMessageId(element, threadId, body, sentAtText, direction, index);

          return {
            externalThreadId: threadId,
            externalMessageId: messageId,
            body,
            leadName,
            direction,
            threadLabel: threadLabel || null,
            threadMessageCount: Number.isFinite(threadMessageCount) ? threadMessageCount : null,
            inboxSortRank: index + 1,
            sentAtText: sentAtText || null,
            channel: "in_app",
            metadata: {
              adapter: meta.platform,
              source: "playwright_rpa",
              ...(listingExternalId ? { listingExternalId } : {}),
              ...(leadExternalId ? { leadExternalId } : {}),
              inbox: {
                sortRank: index + 1,
                threadLabel: threadLabel || null,
                threadMessageCount: Number.isFinite(threadMessageCount) ? threadMessageCount : null
              }
            }
          };
        })
        .filter((row) => row.externalThreadId && row.externalMessageId);

      const seenMessageIds = new Set();
      return rawRows.filter((row) => {
        if (seenMessageIds.has(row.externalMessageId)) {
          return false;
        }
        seenMessageIds.add(row.externalMessageId);
        return true;
      });
    },
    {
      platform: adapter.platform,
      messageSelectors,
      bodySelectors,
      sentAtSelectors,
      leadNameSelectors,
      threadLabelSelectors,
      maxThreads: Number.isFinite(maxThreads) && maxThreads > 0 ? Math.round(maxThreads) : 0
    }
  );

  const normalizedMessages = messages.map((message) => {
    const sentAtHasTime = message.sentAtText ? hasExplicitTimeInHumanDateText(message.sentAtText) : false;
    const parsingTimezone = message.sentAtText ? resolveParsingTimezone(adapter, message.sentAtText) : null;
    let parsed = null;
    if (message.sentAtText) {
      try {
        parsed = parsingTimezone
          ? parseHumanDateTextInTimezone(message.sentAtText, now, parsingTimezone)
          : parseHumanDateText(message.sentAtText, now);
      } catch {
        parsed = null;
      }
    }
    const sentAt = parsed ? parsed.toISOString() : now.toISOString();
    const sentAtSource = parsed ? "platform_inbox" : "clock";

    return {
      ...message,
      body: sanitizeMessageBody(message.body),
      sentAt,
      metadata: {
        ...(message.metadata || {}),
        sentAtSource,
        sentAtHasTime,
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

  const threadMessageSelectors = toSelectorList(adapter.selectors?.threadMessageItems, [
    "li.message[id^='msg_']",
    "[data-message-id]",
    "[data-testid='thread-message']",
    "[class*='message' i]"
  ]);
  const bodySelectors = toSelectorList(adapter.selectors?.threadMessageBody, [
    "dd.message_body",
    "[data-testid='message-body']",
    "[class*='message-body' i]",
    "p"
  ]);
  const sentAtSelectors = toSelectorList(adapter.selectors?.threadMessageSentAt, [
    "dd.message_date",
    "time[datetime]",
    "[data-testid='message-time']",
    "[class*='time' i]",
    "[class*='date' i]"
  ]);
  const composerSelectors = toSelectorList(adapter.selectors?.composer, ["textarea"]);
  const now = clock();

  const rawMessages = await page.evaluate(
    (meta) => {
      const dedupeElements = new Set();
      const orderedElements = [];

      const safeQueryAll = (selector) => {
        try {
          return Array.from(document.querySelectorAll(selector));
        } catch {
          return [];
        }
      };

      const textBySelectors = (root, selectors) => {
        for (const selector of selectors) {
          try {
            const node = root.querySelector(selector);
            const value = node?.textContent?.replace(/\s+/g, " ").trim();
            if (value) {
              return value;
            }
          } catch {
            continue;
          }
        }
        return "";
      };

      const containsAnySelector = (root, selectors) => {
        for (const selector of selectors) {
          if (!selector) {
            continue;
          }
          try {
            if (root.matches(selector) || root.querySelector(selector)) {
              return true;
            }
          } catch {
            continue;
          }
        }
        return false;
      };

      for (const selector of meta.threadMessageSelectors) {
        const nodes = safeQueryAll(selector);
        for (const node of nodes) {
          if (!dedupeElements.has(node)) {
            dedupeElements.add(node);
            orderedElements.push(node);
          }
        }
      }

      const rows = [];
      for (let index = 0; index < orderedElements.length; index += 1) {
        const element = orderedElements[index];
        if (containsAnySelector(element, meta.composerSelectors)) {
          continue;
        }

        const className = String(element.getAttribute("class") || "").toLowerCase();
        const dataDirection = String(element.getAttribute("data-direction") || "").toLowerCase();
        const dataAuthor = String(element.getAttribute("data-author") || "").toLowerCase();
        const isOutbound = className.includes("message_out")
          || className.includes("outbound")
          || className.includes("from-me")
          || className.includes("sent")
          || className.includes("self")
          || className.includes("right")
          || dataDirection === "outbound"
          || dataAuthor === "me"
          || dataAuthor === "self";

        const body = textBySelectors(element, meta.bodySelectors)
          || (element.childElementCount <= 8 ? (element.textContent || "").replace(/\s+/g, " ").trim() : "");
        if (!body) {
          continue;
        }
        if (body.length > 8_000) {
          continue;
        }

        const sentAtText = textBySelectors(element, meta.sentAtSelectors) || "";
        const idValue = element.getAttribute("id")
          || element.getAttribute("data-message-id")
          || element.getAttribute("data-id")
          || "";
        let externalMessageId = "";
        if (idValue) {
          const match = String(idValue).match(/^(?:msg|message)[_-](.+)$/i);
          externalMessageId = (match?.[1] || idValue).trim();
        }
        if (!externalMessageId) {
          const stableToken = [meta.threadId, sentAtText || "", body.slice(0, 120), isOutbound ? "outbound" : "inbound"]
            .join("|")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 120);
          externalMessageId = stableToken ? `thread-${stableToken}` : `message-${index + 1}`;
        }

        rows.push({
          externalThreadId: meta.threadId,
          externalMessageId,
          direction: isOutbound ? "outbound" : "inbound",
          body,
          channel: "in_app",
          sentAtText: sentAtText || null
        });
      }

      const seenMessageIds = new Set();
      return rows.filter((row) => {
        if (seenMessageIds.has(row.externalMessageId)) {
          return false;
        }
        seenMessageIds.add(row.externalMessageId);
        return true;
      });
    },
    {
      threadId,
      threadMessageSelectors,
      bodySelectors,
      sentAtSelectors,
      composerSelectors
    }
  );

  let threadListingExternalId = null;
  let threadLeadExternalId = null;
  if (adapter.platform === "spareroom" && typeof threadId === "string") {
    const match = threadId.match(/^(\d+)_([0-9]+)$/);
    if (match) {
      threadLeadExternalId = match[1] || null;
      threadListingExternalId = match[2] || null;
    }
  }

  const normalizedMessages = rawMessages
    .map((message) => {
      const parsingTimezone = message.sentAtText ? resolveParsingTimezone(adapter, message.sentAtText) : null;
      let parsed = null;
      if (message.sentAtText) {
        try {
          parsed = parsingTimezone
            ? parseHumanDateTextInTimezone(message.sentAtText, now, parsingTimezone)
            : parseHumanDateText(message.sentAtText, now);
        } catch {
          parsed = null;
        }
      }
      const sentAt = parsed ? parsed.toISOString() : now.toISOString();
      return {
        ...message,
        body: sanitizeMessageBody(message.body),
        sentAt,
        metadata: {
          adapter: adapter.platform,
          source: "playwright_rpa",
          sentAtSource: parsed ? "platform_thread" : "clock",
          ...(threadListingExternalId ? { listingExternalId: threadListingExternalId } : {}),
          ...(threadLeadExternalId ? { leadExternalId: threadLeadExternalId } : {}),
          ...(message.sentAtText ? { sentAtText: message.sentAtText } : {})
        }
      };
    })
    .filter((message) => message.body.length > 0);

  return { messages: normalizedMessages };
}

async function defaultListingSyncHandler({ adapter, page }) {
  if (adapter.platform === "roomies" || adapter.platform === "leasebreak") {
    const listingSyncConfig = adapter.listingSync || {};
    const maxPages = Math.max(
      1,
      Number(process.env.LEASE_BOT_RPA_LISTINGS_MAX_PAGES || listingSyncConfig.maxPages || 25)
    );
    const pageParam = typeof listingSyncConfig.pageParam === "string" && listingSyncConfig.pageParam.trim()
      ? listingSyncConfig.pageParam.trim()
      : "page";
    const configuredPaths = Array.isArray(listingSyncConfig.paths)
      ? listingSyncConfig.paths.filter((pathValue) => typeof pathValue === "string" && pathValue.trim())
      : [];
    const candidatePaths = configuredPaths.length > 0
      ? configuredPaths
      : ["/my-listings", "/listings", "/rooms", "/messages"];
    const listings = [];
    const seenExternalIds = new Set();

    const inboxResponse = await page.goto(adapter.inboxUrl, { waitUntil: "domcontentloaded" });
    await detectProtectionLayer(page, adapter, inboxResponse);

    const discoveredPaths = await page.evaluate(() => {
      const result = new Set();
      const nodes = Array.from(document.querySelectorAll("a[href]"));
      for (const node of nodes) {
        const href = node.getAttribute("href") || "";
        if (!href) {
          continue;
        }
        try {
          const parsed = new URL(href, location.origin);
          if (parsed.origin !== location.origin) {
            continue;
          }
          const lowered = parsed.pathname.toLowerCase();
          if (
            lowered.includes("listing")
            || lowered.includes("room")
            || lowered.includes("manage")
            || lowered.includes("landlord")
            || lowered.includes("rent")
            || lowered.includes("apartment")
          ) {
            result.add(`${parsed.pathname}${parsed.search || ""}`);
          }
        } catch {
          continue;
        }
      }
      return Array.from(result).slice(0, 40);
    });

    const mergedPaths = [...new Set([...candidatePaths, ...discoveredPaths])];

    for (const candidatePath of mergedPaths) {
      let discoveredOnCandidate = false;
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const url = new URL(candidatePath, adapter.baseUrl);
        if (pageIndex > 0) {
          url.searchParams.set(pageParam, String(pageIndex + 1));
        }

        const response = await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
        await detectProtectionLayer(page, adapter, response);

        const pageListings = await page.evaluate((meta) => {
          const safeQueryAll = (selector) => {
            try {
              return Array.from(document.querySelectorAll(selector));
            } catch {
              return [];
            }
          };
          const textBySelectors = (root, selectors) => {
            for (const selector of selectors) {
              if (!selector) {
                continue;
              }
              try {
                const node = root.querySelector(selector);
                const text = node?.textContent?.replace(/\s+/g, " ").trim();
                if (text) {
                  return text;
                }
              } catch {
                continue;
              }
            }
            return "";
          };
          const rootText = (document.body?.innerText || "").toLowerCase();
          const hasManageMarkers = meta.managePageMarkers.some((marker) => rootText.includes(marker));
          if (!hasManageMarkers) {
            return [];
          }

          const dedupeCards = new Set();
          const cards = [];

          for (const selector of meta.listingItemSelectors) {
            const nodes = safeQueryAll(selector);
            for (const node of nodes) {
              if (!dedupeCards.has(node)) {
                dedupeCards.add(node);
                cards.push(node);
              }
            }
          }

          const listingAnchors = safeQueryAll("a[href*='/rooms/'], a[href*='/listings/'], a[href*='/listing/'], a[href*='/for-rent/'], a[href*='/apartment/']");
          for (const anchor of listingAnchors) {
            const card = anchor.closest("article, li, div");
            if (!card) {
              continue;
            }
            if (!dedupeCards.has(card)) {
              dedupeCards.add(card);
              cards.push(card);
            }
          }

          const normalized = [];
          for (const card of cards) {
            const linkElement = card.matches("a[href]")
              ? card
              : card.querySelector(meta.listingLinkSelectors.join(", "))
              || card.querySelector("a[href*='/rooms/'], a[href*='/listings/'], a[href*='/listing/'], a[href*='/for-rent/'], a[href*='/apartment/']");
            const href = linkElement?.getAttribute("href") || "";
            const roomMatch = href.match(/\/rooms\/([^/?#]+)/i);
            const listingMatch = href.match(/\/listings\/([^/?#]+)/i);
            const genericListingMatch = href.match(/\/(?:listing|for-rent|apartments?)\/([^/?#]+)/i);
            const queryListingMatch = href.match(/[?&](?:listing_id|listing|room_id|unit_id|advert_id)=([^&#]+)/i);
            const attrExternalId = card.getAttribute("data-listing-id")
              || card.getAttribute("data-room-id")
              || card.getAttribute("data-id")
              || "";
            const listingExternalId = (
              roomMatch?.[1]
              || listingMatch?.[1]
              || genericListingMatch?.[1]
              || queryListingMatch?.[1]
              || attrExternalId
              || ""
            ).trim();
            if (!listingExternalId) {
              continue;
            }

            const title = textBySelectors(card, meta.listingTitleSelectors)
              || linkElement?.textContent?.replace(/\s+/g, " ").trim()
              || null;
            const location = textBySelectors(card, meta.listingLocationSelectors) || null;
            const priceText = textBySelectors(card, meta.listingPriceSelectors) || null;
            const statusText = textBySelectors(card, meta.listingStatusSelectors)
              || (card.textContent || "").replace(/\s+/g, " ").trim();
            const statusLower = (statusText || "").toLowerCase();
            const status = statusLower.includes("inactive")
              || statusLower.includes("deactivate")
              || statusLower.includes("deactivated")
              || statusLower.includes("paused")
              || statusLower.includes("archiv")
              || statusLower.includes("off market")
              || statusLower.includes("draft")
              || statusLower.includes("rented")
              || statusLower.includes("expired")
              || statusLower.includes("closed")
              ? "inactive"
              : "active";

            normalized.push({
              listingExternalId,
              status,
              statusClasses: String(card.className || "")
                .split(/\s+/g)
                .map((value) => value.trim())
                .filter(Boolean),
              title,
              location,
              priceText,
              href: href || null,
              headerText: statusText || null
            });
          }

          return normalized;
        }, {
          listingItemSelectors: toSelectorList(adapter.selectors?.listingItems, [
            "[data-listing-id]",
            "[data-room-id]",
            "[data-testid='listing-card']"
          ]),
          listingTitleSelectors: toSelectorList(adapter.selectors?.listingTitle, [
            "[data-testid='listing-title']",
            "[class*='listing-title' i]",
            "[class*='room-title' i]",
            "h2",
            "h3"
          ]),
          listingLocationSelectors: toSelectorList(adapter.selectors?.listingLocation, [
            "[data-testid='listing-location']",
            "[class*='location' i]"
          ]),
          listingPriceSelectors: toSelectorList(adapter.selectors?.listingPrice, [
            "[data-testid='listing-price']",
            "[class*='price' i]"
          ]),
          listingStatusSelectors: toSelectorList(adapter.selectors?.listingStatus, [
            "[data-testid='listing-status']",
            "[class*='status' i]",
            ".badge"
          ]),
          listingLinkSelectors: toSelectorList(adapter.selectors?.listingLink, [
            "a[href*='/rooms/']",
            "a[href*='/listings/']",
            "a[href*='/listing/']",
            "a[href*='/for-rent/']"
          ]),
          managePageMarkers: Array.isArray(listingSyncConfig.managePageMarkers)
            ? listingSyncConfig.managePageMarkers
                .map((value) => String(value || "").toLowerCase().trim())
                .filter(Boolean)
            : ["my listings", "your listings", "manage listings", "edit listing", "deactivate", "my room", "active listings", "inactive listings"]
        });

        if (pageListings.length === 0) {
          break;
        }
        discoveredOnCandidate = true;
        let newCount = 0;
        for (const item of pageListings) {
          const externalId = typeof item?.listingExternalId === "string" ? item.listingExternalId.trim() : "";
          if (!externalId || seenExternalIds.has(externalId)) {
            continue;
          }
          seenExternalIds.add(externalId);
          listings.push(item);
          newCount += 1;
        }
        if (newCount === 0) {
          break;
        }
      }
      if (discoveredOnCandidate && listings.length > 0) {
        break;
      }
    }

    return {
      listings
    };
  }

  if (adapter.platform !== "spareroom") {
    throw createRunnerError("LISTING_SYNC_UNSUPPORTED", `Listing sync is not supported for ${adapter.platform}`, {
      retryable: false
    });
  }

  const pageSize = Math.max(1, Number(process.env.LEASE_BOT_RPA_LISTINGS_PAGE_SIZE || 10));
  const maxPages = Math.max(1, Number(process.env.LEASE_BOT_RPA_LISTINGS_MAX_PAGES || 50));
  const listings = [];
  const seenExternalIds = new Set();

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const offset = pageIndex * pageSize;
    const url = new URL(`/roommate/mylistings.pl?offset=${encodeURIComponent(String(offset))}&`, adapter.baseUrl).toString();

    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    await detectProtectionLayer(page, adapter, response);

    const pageListings = await page.$$eval("li.listing-result[id^='advert-']", (elements) =>
      elements
        .map((element) => {
          const externalIdRaw = element.getAttribute("id") || "";
          const externalId = externalIdRaw.startsWith("advert-") ? externalIdRaw.slice(7) : externalIdRaw;
          const statusClasses = Array.from(element.classList || []).filter((cls) => cls.startsWith("listing-result--"));
          const headerText = element.querySelector("h3")?.innerText?.replace(/\\s+/g, " ").trim() || "";
          const title = element.querySelector(".listing-card__title")?.textContent?.trim() || null;
          const location = element.querySelector(".listing-card__location")?.textContent?.trim() || null;
          const priceText = element.querySelector(".listing-card__price")?.textContent?.trim() || null;
          const href = element.querySelector("a[href]")?.getAttribute("href") || null;

          let status = "inactive";
          if (element.classList.contains("listing-result--live")) {
            status = "active";
          } else if (element.classList.contains("listing-result--not_live")) {
            status = "inactive";
          } else if (headerText.toLowerCase().includes("live")) {
            status = "active";
          } else if (headerText.toLowerCase().includes("deactivated")) {
            status = "inactive";
          }

          return {
            listingExternalId: externalId || null,
            status,
            statusClasses,
            title,
            location,
            priceText,
            href,
            headerText
          };
        })
        .filter((item) => item.listingExternalId)
    );

    if (pageListings.length === 0) {
      break;
    }

    let newCount = 0;
    for (const item of pageListings) {
      const externalId = item.listingExternalId;
      if (!externalId) {
        continue;
      }
      if (seenExternalIds.has(externalId)) {
        continue;
      }
      seenExternalIds.add(externalId);
      listings.push(item);
      newCount += 1;
    }

    if (newCount === 0) {
      break;
    }
  }

  return {
    listings
  };
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

  const composerSelectors = toSelectorList(adapter.selectors?.composer, ["textarea[name='message']", "textarea"]);
  const submitSelectors = toSelectorList(adapter.selectors?.submit, ["button[type='submit']"]);
  const composerSelector = await pickFirstExistingSelector(page, composerSelectors);
  if (!composerSelector) {
    throw createRunnerError("OUTBOUND_COMPOSER_MISSING", `Could not find message composer on ${adapter.platform}`, {
      retryable: false
    });
  }
  const submitSelector = await pickFirstExistingSelector(page, submitSelectors);

  // SpareRoom: after sending, the thread page appends a new <li id="msg_<id>">. Capture it so
  // outbound records use the same externalMessageId as thread sync ingestion.
  const threadMessageSelector = toSelectorList(adapter.selectors?.threadMessageItems, ["li.message[id^='msg_']"])[0];
  let beforeMeta = null;
  if (adapter.platform === "spareroom" && typeof page?.evaluate === "function") {
    try {
      beforeMeta = await page.evaluate((selector) => {
        const nodes = Array.from(document.querySelectorAll(selector));
        const last = nodes[nodes.length - 1];
        return {
          count: nodes.length,
          lastId: last?.id || null
        };
      }, threadMessageSelector);
    } catch {
      beforeMeta = null;
    }
  }

  await page.fill(composerSelector, payload.body);
  if (submitSelector) {
    await page.click(submitSelector);
  } else if (typeof page?.keyboard?.press === "function") {
    await page.keyboard.press("Enter");
  } else {
    throw createRunnerError("OUTBOUND_SUBMIT_MISSING", `Could not find send button on ${adapter.platform}`, {
      retryable: false
    });
  }

  let capturedExternalMessageId = null;
  if (
    adapter.platform === "spareroom"
    && beforeMeta
    && typeof page?.waitForFunction === "function"
    && typeof page?.evaluate === "function"
  ) {
    try {
      await page.waitForFunction(
        (meta) => {
          const nodes = Array.from(document.querySelectorAll(meta.selector));
          if (nodes.length === 0) {
            return false;
          }
          const last = nodes[nodes.length - 1];
          if (!last?.id || last.id === meta.beforeLastId) {
            return false;
          }
          if (nodes.length <= meta.beforeCount) {
            return false;
          }
          // SpareRoom flags outbound rows with `message_out` class.
          const className = last.getAttribute("class") || "";
          return className.includes("message_out");
        },
        {
          selector: threadMessageSelector,
          beforeCount: Number(beforeMeta.count || 0),
          beforeLastId: beforeMeta.lastId || ""
        },
        { timeout: 15_000 }
      );

      const lastId = await page.evaluate((selector) => {
        const nodes = Array.from(document.querySelectorAll(selector));
        const last = nodes[nodes.length - 1];
        return last?.id || "";
      }, threadMessageSelector);
      const match = String(lastId || "").match(/^msg_(.+)$/);
      capturedExternalMessageId = match?.[1] || null;
    } catch {
      capturedExternalMessageId = null;
    }
  }

  return {
    externalMessageId: capturedExternalMessageId || `${adapter.platform}-${threadId}-${clock().getTime()}`,
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
      if (action === "listing_sync") {
        return { listings: [] };
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
  const defaultHeadless = typeof options.headless === "boolean" ? options.headless : envHeadless === null ? true : envHeadless;
  const clock = options.clock || (() => new Date());
  const playwrightFactory = options.playwrightFactory || createDefaultPlaywrightFactory(logger);
  const spareroomHeadlessFallbackUserAgent =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
  const roomiesHeadlessFallbackUserAgent =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
  const leasebreakHeadlessFallbackUserAgent =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

  function resolveHeadlessForPlatform(platform) {
    const normalizedPlatform = String(platform || "").trim().toLowerCase();
    const platformEnvKey = `LEASE_BOT_RPA_HEADLESS_${normalizedPlatform.toUpperCase()}`;
    const envOverride = parseBooleanEnv(process.env[platformEnvKey]);
    if (envOverride !== null) {
      return envOverride;
    }
    return defaultHeadless;
  }

  function resolveContextOptionsForPlatform(platform, runHeadless) {
    const normalizedPlatform = String(platform || "").trim().toLowerCase();
    const platformKey = normalizedPlatform.toUpperCase();
    const contextOptions = {};

    const userAgentEnvKey = `LEASE_BOT_RPA_USER_AGENT_${platformKey}`;
    const localeEnvKey = `LEASE_BOT_RPA_LOCALE_${platformKey}`;
    const timezoneEnvKey = `LEASE_BOT_RPA_CONTEXT_TIMEZONE_${platformKey}`;

    const envUserAgent = typeof process.env[userAgentEnvKey] === "string" ? process.env[userAgentEnvKey].trim() : "";
    const envLocale = typeof process.env[localeEnvKey] === "string" ? process.env[localeEnvKey].trim() : "";
    const envTimezone = typeof process.env[timezoneEnvKey] === "string" ? process.env[timezoneEnvKey].trim() : "";

    if (envUserAgent) {
      contextOptions.userAgent = envUserAgent;
    }
    if (envLocale) {
      contextOptions.locale = envLocale;
    }
    if (envTimezone) {
      contextOptions.timezoneId = envTimezone;
    }

    // SpareRoom can return an auth gate in headless mode when UA includes HeadlessChrome.
    // Use a non-headless Chrome UA by default for headless runs unless explicitly overridden.
    if (normalizedPlatform === "spareroom" && runHeadless && !contextOptions.userAgent) {
      contextOptions.userAgent = spareroomHeadlessFallbackUserAgent;
    }

    if (normalizedPlatform === "roomies" && runHeadless && !contextOptions.userAgent) {
      contextOptions.userAgent = roomiesHeadlessFallbackUserAgent;
    }

    if (normalizedPlatform === "leasebreak" && runHeadless && !contextOptions.userAgent) {
      contextOptions.userAgent = leasebreakHeadlessFallbackUserAgent;
    }

    return contextOptions;
  }

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
              : action === "listing_sync"
                ? defaultListingSyncHandler
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
        const runHeadless = resolveHeadlessForPlatform(platform);
        const contextOptions = resolveContextOptionsForPlatform(platform, runHeadless);
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
            headless: runHeadless,
            userDataDir: session.userDataDir,
            contextOptions
          });
          browser = typeof context?.browser === "function" ? context.browser() : null;
        } else {
          browser = await playwrightFactory.launch({ platform, action, account, headless: runHeadless });
          context = await browser.newContext({
            storageState: session?.storageState || undefined,
            ...contextOptions
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
