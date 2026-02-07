import { createPlatformAdapterRegistry } from "./platform-adapters.js";

function createRunnerError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
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
  return {
    async launch({ headless }) {
      try {
        const playwright = await import("playwright");
        const chromium = playwright.chromium || playwright.default?.chromium;
        if (!chromium || typeof chromium.launch !== "function") {
          throw new Error("chromium_launch_unavailable");
        }
        return chromium.launch({ headless });
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
  };
}

async function detectProtectionLayer(page, adapter) {
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
}

async function defaultIngestHandler({ adapter, page, clock }) {
  await page.goto(adapter.inboxUrl, { waitUntil: "domcontentloaded" });
  await detectProtectionLayer(page, adapter);

  const selector = adapter.selectors?.messageItems?.[0] || "[data-thread-id][data-message-id]";
  const bodySelector = adapter.selectors?.messageBody?.[0] || "[data-role='message-body']";
  const messages = await page.$$eval(
    selector,
    (elements, meta) => elements.map((element, index) => {
      const threadId = element.getAttribute("data-thread-id") || element.getAttribute("data-thread") || `thread-${index + 1}`;
      const messageId = element.getAttribute("data-message-id") || `message-${index + 1}`;
      const bodyElement = element.querySelector(meta.bodySelector);
      const body = bodyElement?.textContent?.trim() || element.textContent?.trim() || "";
      const leadName = element.getAttribute("data-lead-name") || null;
      return {
        externalThreadId: threadId,
        externalMessageId: messageId,
        body,
        leadName,
        channel: "in_app",
        sentAt: new Date(meta.nowIso).toISOString(),
        metadata: {
          adapter: meta.platform,
          source: "playwright_rpa"
        }
      };
    }),
    {
      bodySelector,
      platform: adapter.platform,
      nowIso: clock().toISOString()
    }
  );

  return { messages };
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

  await page.goto(adapter.threadUrl(threadId), { waitUntil: "domcontentloaded" });
  await detectProtectionLayer(page, adapter);
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
  const headless = options.headless !== false;
  const clock = options.clock || (() => new Date());
  const playwrightFactory = options.playwrightFactory || createDefaultPlaywrightFactory(logger);

  return {
    async run({ platform, action, account, payload, session, attempt }) {
      const adapter = adapterRegistry.get(platform);
      if (!adapter) {
        throw createRunnerError("UNSUPPORTED_PLATFORM", `Unsupported platform '${platform}'`, {
          retryable: false
        });
      }

      const actionHandler = actionHandlers?.[platform]?.[action]
        || (action === "ingest" ? defaultIngestHandler : action === "send" ? defaultSendHandler : null);

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
      try {
        browser = await playwrightFactory.launch({ platform, action, account, headless });
        context = await browser.newContext({
          storageState: session?.storageState || undefined
        });
        const page = await context.newPage();
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
        const error = normalizeAutomationError(rawError);
        hooks.onEvent?.({
          type: "rpa_run_failed",
          platform,
          action,
          accountId: account?.id || null,
          code: error?.code || "UNKNOWN",
          message: error?.message || String(error)
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
  const runtimeMode = options.runtimeMode || process.env.LEASE_BOT_RPA_RUNTIME || "mock";
  if (runtimeMode === "playwright") {
    return createPlaywrightRpaRunner(options);
  }
  return createMockRpaRunner(options);
}
