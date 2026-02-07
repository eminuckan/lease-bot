import { isRetryableError, withRetry } from "./retry.js";
import { REQUIRED_RPA_PLATFORMS } from "./platform-adapters.js";
import { createRpaRunner } from "./rpa-runner.js";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

const SUPPORTED_PLATFORMS = [...REQUIRED_RPA_PLATFORMS];

const DEFAULT_RETRY_POLICY = {
  retries: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  factor: 2,
  jitter: true,
  jitterRatio: 0.2
};

const DEFAULT_ANTI_BOT_POLICY = {
  minIntervalMs: 1_200,
  jitterMs: 350,
  maxCaptchaRetries: 1
};

const DEFAULT_CIRCUIT_BREAKER_POLICY = {
  failureThreshold: 3,
  cooldownMs: 30_000
};

const DEFAULT_INGEST_METRICS_POLICY = {
  p95TargetMs: 60_000
};

function normalizeP95TargetMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_INGEST_METRICS_POLICY.p95TargetMs;
  }
  return Math.round(parsed);
}

const PLATFORM_ANTI_BOT_POLICIES = {
  spareroom: {
    minIntervalMs: 1_400,
    jitterMs: 400,
    maxCaptchaRetries: 1
  },
  roomies: {
    minIntervalMs: 1_250,
    jitterMs: 300,
    maxCaptchaRetries: 1
  },
  leasebreak: {
    minIntervalMs: 1_100,
    jitterMs: 250,
    maxCaptchaRetries: 1
  },
  renthop: {
    minIntervalMs: 1_100,
    jitterMs: 250,
    maxCaptchaRetries: 1
  },
  furnishedfinder: {
    minIntervalMs: 1_500,
    jitterMs: 450,
    maxCaptchaRetries: 1
  }
};

const CONNECTOR_DEFINITIONS = {
  spareroom: {
    mode: "rpa",
    apiBasePath: "/spareroom"
  },
  roomies: {
    mode: "rpa",
    apiBasePath: "/roomies"
  },
  leasebreak: {
    mode: "rpa",
    apiBasePath: "/leasebreak"
  },
  renthop: {
    mode: "rpa",
    apiBasePath: "/renthop"
  },
  furnishedfinder: {
    mode: "rpa",
    apiBasePath: "/furnishedfinder"
  }
};

function createMissingCredentialError(platform, key, ref) {
  const reference = ref ? ` (reference: ${ref})` : "";
  const error = new Error(`Missing credential '${key}' for ${platform}${reference}`);
  error.code = "CREDENTIAL_MISSING";
  error.retryable = false;
  return error;
}

function createPlaintextCredentialError(platform, key) {
  const error = new Error(`Credential '${key}' for ${platform} must use env: or secret: reference`);
  error.code = "CREDENTIAL_PLAINTEXT_FORBIDDEN";
  error.retryable = false;
  return error;
}

function resolveReferencedCredential(reference, env, platform, key) {
  if (typeof reference !== "string" || reference.length === 0) {
    throw createMissingCredentialError(platform, key);
  }

  const normalizedRef = reference.trim();
  if (normalizedRef.length === 0) {
    throw createMissingCredentialError(platform, key);
  }

  if (!normalizedRef.startsWith("env:") && !normalizedRef.startsWith("secret:")) {
    throw createPlaintextCredentialError(platform, key);
  }

  const envKey = normalizedRef.startsWith("env:") ? normalizedRef.slice(4) : normalizedRef.slice(7);
  const resolved = env[envKey];
  if (resolved === undefined || resolved === null || resolved === "") {
    throw createMissingCredentialError(platform, key, normalizedRef);
  }

  return resolved;
}

function resolveCredentialValue(value, env, platform, key) {
  if (value === undefined || value === null || value === "") {
    throw createMissingCredentialError(platform, key);
  }

  if (typeof value === "string") {
    return resolveReferencedCredential(value, env, platform, key);
  }

  throw createPlaintextCredentialError(platform, key);
}

function resolveCredentials(platform, rawCredentials = {}, env = process.env) {
  const config = CONNECTOR_DEFINITIONS[platform];
  if (!config) {
    throw new Error(`Unsupported platform '${platform}'`);
  }

  const resolved = {};

  const loginId = rawCredentials.loginIdRef
    ? resolveReferencedCredential(rawCredentials.loginIdRef, env, platform, "loginId")
    : rawCredentials.loginId
    ? resolveCredentialValue(rawCredentials.loginId, env, platform, "loginId")
    : null;

  const username = rawCredentials.usernameRef
    ? resolveReferencedCredential(rawCredentials.usernameRef, env, platform, "username")
    : rawCredentials.username
    ? resolveCredentialValue(rawCredentials.username, env, platform, "username")
    : null;

  const email = rawCredentials.emailRef
    ? resolveReferencedCredential(rawCredentials.emailRef, env, platform, "email")
    : rawCredentials.email
    ? resolveCredentialValue(rawCredentials.email, env, platform, "email")
    : null;

  const password = rawCredentials.passwordRef
    ? resolveReferencedCredential(rawCredentials.passwordRef, env, platform, "password")
    : rawCredentials.password
    ? resolveCredentialValue(rawCredentials.password, env, platform, "password")
    : null;

  const storageState = rawCredentials.storageStateRef
    ? resolveReferencedCredential(rawCredentials.storageStateRef, env, platform, "storageStateRef")
    : rawCredentials.sessionRef
    ? resolveReferencedCredential(rawCredentials.sessionRef, env, platform, "sessionRef")
    : rawCredentials.storageState
    ? resolveCredentialValue(rawCredentials.storageState, env, platform, "storageState")
    : rawCredentials.session
    ? resolveCredentialValue(rawCredentials.session, env, platform, "session")
    : null;

  const storageStatePath = rawCredentials.storageStatePathRef
    ? resolveReferencedCredential(rawCredentials.storageStatePathRef, env, platform, "storageStatePathRef")
    : rawCredentials.storageStatePath
    ? resolveCredentialValue(rawCredentials.storageStatePath, env, platform, "storageStatePath")
    : null;

  const userDataDir = rawCredentials.userDataDirRef
    ? resolveReferencedCredential(rawCredentials.userDataDirRef, env, platform, "userDataDirRef")
    : rawCredentials.userDataDir
    ? resolveCredentialValue(rawCredentials.userDataDir, env, platform, "userDataDir")
    : null;

  if (loginId) {
    resolved.loginId = loginId;
  }
  if (username) {
    resolved.username = username;
  }
  if (email) {
    resolved.email = email;
  }
  if (password) {
    resolved.password = password;
  }
  if (storageState) {
    resolved.storageState = storageState;
  }
  if (storageStatePath) {
    resolved.storageStatePath = storageStatePath;
  }
  if (userDataDir) {
    resolved.userDataDir = userDataDir;
  }

  const hasSession = Boolean(resolved.storageState || resolved.storageStatePath || resolved.userDataDir);
  const hasLoginId = Boolean(resolved.loginId || resolved.username || resolved.email);
  const hasPassword = Boolean(resolved.password);

  if (!hasSession) {
    if (!hasLoginId) {
      throw createMissingCredentialError(platform, "loginId");
    }
    if (!hasPassword) {
      throw createMissingCredentialError(platform, "password");
    }
  }

  // Normalized alias the runtime can rely on.
  resolved.loginId = resolved.loginId || resolved.username || resolved.email || null;

  return resolved;
}

function normalizeInboundMessage(rawMessage, fallback = {}) {
  return {
    externalThreadId: rawMessage.externalThreadId || rawMessage.threadId || fallback.externalThreadId || "",
    externalMessageId: rawMessage.externalMessageId || rawMessage.messageId || `msg_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    body: rawMessage.body || "",
    leadName: rawMessage.leadName || fallback.leadName || null,
    leadContact: rawMessage.leadContact || fallback.leadContact || {},
    channel: rawMessage.channel || fallback.channel || "in_app",
    sentAt: rawMessage.sentAt || new Date().toISOString(),
    metadata: rawMessage.metadata || {}
  };
}

function sleepWithTimeout(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function loadAdapterOverridesFromEnv(env = process.env, logger = console) {
  const jsonValue = typeof env.LEASE_BOT_PLATFORM_ADAPTER_OVERRIDES_JSON === "string"
    ? env.LEASE_BOT_PLATFORM_ADAPTER_OVERRIDES_JSON.trim()
    : "";
  if (jsonValue) {
    try {
      const parsed = JSON.parse(jsonValue);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch (error) {
      logger.warn?.("[integrations] failed parsing LEASE_BOT_PLATFORM_ADAPTER_OVERRIDES_JSON", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const pathValue = typeof env.LEASE_BOT_PLATFORM_ADAPTER_OVERRIDES_PATH === "string"
    ? env.LEASE_BOT_PLATFORM_ADAPTER_OVERRIDES_PATH.trim()
    : "";
  if (pathValue) {
    try {
      const file = readFileSync(pathValue, "utf8");
      const parsed = JSON.parse(file);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch (error) {
      logger.warn?.("[integrations] failed loading LEASE_BOT_PLATFORM_ADAPTER_OVERRIDES_PATH", {
        path: pathValue,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return null;
}

function isSessionExpiredError(error) {
  const message = String(error?.message || "").toLowerCase();
  return error?.code === "SESSION_EXPIRED"
    || error?.code === "AUTH_REFRESH_REQUIRED"
    || error?.status === 401
    || error?.statusCode === 401
    || error?.status === 419
    || error?.statusCode === 419
    || message.includes("session expired")
    || message.includes("not authenticated");
}

function isCaptchaError(error) {
  const message = String(error?.message || "").toLowerCase();
  return error?.code === "CAPTCHA_REQUIRED"
    || error?.code === "BOT_CHALLENGE"
    || error?.code === "ACCESS_BLOCKED"
    || message.includes("captcha")
    || message.includes("challenge page")
    || message.includes("cloudflare");
}

function looksLikeJson(value) {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

async function parseStorageStateValue(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.startsWith("base64:")) {
    const decoded = Buffer.from(trimmed.slice(7), "base64").toString("utf8");
    return JSON.parse(decoded);
  }

  if (looksLikeJson(trimmed)) {
    return JSON.parse(trimmed);
  }

  // Otherwise treat it as a path.
  const file = await readFile(trimmed, "utf8");
  return JSON.parse(file);
}

function createEnvSessionManager(logger = console) {
  return {
    async get({ platform, account }) {
      const creds = account?.credentials || {};
      const userDataDirValue = creds.userDataDir || null;
      const storageStateValue = creds.storageStatePath || creds.storageState || null;
      if (!userDataDirValue && !storageStateValue) {
        return null;
      }

      try {
        const storageState = storageStateValue ? await parseStorageStateValue(storageStateValue) : null;
        return {
          ...(userDataDirValue ? { userDataDir: userDataDirValue } : {}),
          ...(storageState ? { storageState } : {})
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw Object.assign(new Error(`Invalid storageState for ${platform}: ${message}`), {
          code: "SESSION_INVALID",
          retryable: false
        });
      }
    },
    async refresh({ platform, account, reason, error }) {
      // We can't solve challenges automatically. Emit log so ops can rotate the sessionRef/path.
      logger.warn?.("[integrations] session refresh required", {
        platform,
        accountId: account?.id || null,
        reason,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  };
}

function createCircuitOpenError({ platform, accountId, action, retryAfterMs }) {
  const error = new Error(`Circuit open for ${platform}:${accountId}:${action}`);
  error.code = "CIRCUIT_OPEN";
  error.retryable = false;
  error.retryAfterMs = retryAfterMs;
  return error;
}

function createApiConnector({ platform, config, transport }) {
  return {
    id: platform,
    mode: config.mode,
    async ingest({ account }) {
      const response = await transport.request({
        method: "GET",
        path: `${config.apiBasePath}/messages`,
        credentials: account.credentials,
        account
      });

      const messages = Array.isArray(response?.messages) ? response.messages : [];
      return messages.map((message) => normalizeInboundMessage(message));
    },
    async send({ account, outbound }) {
      const response = await transport.request({
        method: "POST",
        path: `${config.apiBasePath}/messages`,
        credentials: account.credentials,
        account,
        body: {
          externalThreadId: outbound.externalThreadId,
          body: outbound.body
        }
      });

      return {
        externalMessageId: response?.externalMessageId || response?.id || null,
        channel: response?.channel || "in_app",
        providerStatus: response?.status || "sent"
      };
    }
  };
}

function createRpaConnector({
  platform,
  config,
  rpaRunner,
  logger,
  observabilityHook,
  retry,
  sleep,
  sessionManager,
  antiBotPolicy,
  circuitBreakerPolicy,
  ingestMetricsPolicy,
  nowMs,
  random,
  pacingState,
  circuitState
}) {
  const normalizedIngestP95TargetMs = normalizeP95TargetMs(ingestMetricsPolicy?.p95TargetMs);

  function emitReliabilityEvent(event) {
    logger.info?.("[integrations] rpa reliability event", event);
    if (typeof observabilityHook === "function") {
      try {
        observabilityHook(event);
      } catch (hookError) {
        logger.warn?.("[integrations] rpa reliability hook failed", {
          platform,
          error: hookError instanceof Error ? hookError.message : String(hookError)
        });
      }
    }
  }

  async function enforcePacing(account, action) {
    const accountId = account?.id || account?.account_external_id || "unknown";
    const pacingKey = `${platform}:${accountId}:${action}`;
    const priorTimestamp = pacingState.get(pacingKey) || 0;

    const minIntervalMs = Math.max(0, Number(antiBotPolicy.minIntervalMs || 0));
    const jitterMs = Math.max(0, Number(antiBotPolicy.jitterMs || 0));
    const jitterDelay = jitterMs > 0 ? Math.round(jitterMs * random()) : 0;

    const waitUntil = priorTimestamp + minIntervalMs + jitterDelay;
    const waitMs = Math.max(0, waitUntil - nowMs());
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    pacingState.set(pacingKey, nowMs());
  }

  async function runWithAutomationResilience({ account, action, payload }) {
    const accountId = account?.id || account?.account_external_id || "unknown";
    const breakerKey = `${platform}:${accountId}:${action}`;
    const breaker = circuitState.get(breakerKey) || {
      state: "closed",
      failureCount: 0,
      openedAtMs: 0,
      halfOpenInFlight: false
    };
    const failureThreshold = Math.max(1, Number(circuitBreakerPolicy.failureThreshold || 1));
    const cooldownMs = Math.max(0, Number(circuitBreakerPolicy.cooldownMs || 0));
    const now = nowMs();

    if (breaker.state === "open") {
      const elapsedMs = now - breaker.openedAtMs;
      if (elapsedMs < cooldownMs) {
        emitReliabilityEvent({
          type: "rpa_circuit_open_fail_fast",
          platform,
          accountId,
          action,
          retryAfterMs: Math.max(0, cooldownMs - elapsedMs)
        });
        throw createCircuitOpenError({
          platform,
          accountId,
          action,
          retryAfterMs: Math.max(0, cooldownMs - elapsedMs)
        });
      }

      breaker.state = "half_open";
      breaker.halfOpenInFlight = true;
      emitReliabilityEvent({
        type: "rpa_circuit_half_open_probe",
        platform,
        accountId,
        action,
        cooldownMs
      });
      circuitState.set(breakerKey, breaker);
    } else if (breaker.state === "half_open") {
      if (breaker.halfOpenInFlight) {
        emitReliabilityEvent({
          type: "rpa_circuit_half_open_busy",
          platform,
          accountId,
          action,
          retryAfterMs: cooldownMs
        });
        throw createCircuitOpenError({
          platform,
          accountId,
          action,
          retryAfterMs: cooldownMs
        });
      }

      breaker.halfOpenInFlight = true;
      circuitState.set(breakerKey, breaker);
    }

    let captchaRetries = 0;
    const maxCaptchaRetries = Math.max(0, Number(antiBotPolicy.maxCaptchaRetries || 0));

    try {
      const result = await withRetry(
        async (attempt) => {
          await enforcePacing(account, action);

          const session = await sessionManager.get({
            platform,
            account,
            action,
            attempt
          });

          try {
            return await rpaRunner.run({
              platform,
              action,
              account,
              credentials: account.credentials,
              payload,
              session,
              antiBotPolicy,
              attempt
            });
          } catch (error) {
            if (isSessionExpiredError(error) || isCaptchaError(error)) {
              const refreshReason = isCaptchaError(error) ? "captcha_or_bot_challenge" : "session_expired";
              emitReliabilityEvent({
                type: "rpa_session_refresh_requested",
                platform,
                accountId,
                action,
                attempt,
                reason: refreshReason,
                error: error.message
              });
              await sessionManager.refresh({
                platform,
                account,
                action,
                reason: refreshReason,
                error
              });
            }

            throw error;
          }
        },
        {
          ...DEFAULT_RETRY_POLICY,
          ...retry,
          sleep,
          shouldRetry: (error, attempt) => {
            if (isSessionExpiredError(error)) {
              return true;
            }

            if (isCaptchaError(error)) {
              if (captchaRetries >= maxCaptchaRetries) {
                return false;
              }
              captchaRetries += 1;
              return true;
            }

            return isRetryableError(error, attempt);
          },
          onRetry: ({ delayMs, error, attempt }) => {
            const reason = isCaptchaError(error) ? "captcha_or_challenge" : isSessionExpiredError(error) ? "session_refresh" : "transient_failure";
            emitReliabilityEvent({
              type: "rpa_retry_scheduled",
              platform,
              accountId: account.id,
              action,
              attempt,
              delayMs,
              reason,
              error: error.message
            });
            logger.warn?.("[integrations] anti-bot retry", {
              platform,
              accountId: account.id,
              action,
              attempt,
              delayMs,
              reason,
              error: error.message
            });
          }
        }
      );

      breaker.state = "closed";
      breaker.failureCount = 0;
      breaker.openedAtMs = 0;
      breaker.halfOpenInFlight = false;
      emitReliabilityEvent({
        type: "rpa_circuit_closed",
        platform,
        accountId,
        action
      });
      circuitState.set(breakerKey, breaker);
      return result;
    } catch (error) {
      let opened = false;
      if (breaker.state === "half_open") {
        breaker.state = "open";
        breaker.failureCount = failureThreshold;
        breaker.openedAtMs = nowMs();
        breaker.halfOpenInFlight = false;
        opened = true;
      } else {
        breaker.failureCount += 1;
        if (breaker.failureCount >= failureThreshold) {
          breaker.state = "open";
          breaker.openedAtMs = nowMs();
          breaker.halfOpenInFlight = false;
          opened = true;
        }
      }

      if (opened) {
        emitReliabilityEvent({
          type: "rpa_circuit_opened",
          platform,
          accountId,
          action,
          failureCount: breaker.failureCount,
          failureThreshold,
          error: error?.message || String(error)
        });
      }

      circuitState.set(breakerKey, breaker);
      throw error;
    }
  }

  return {
    id: platform,
    mode: config.mode,
    async ingest({ account }) {
      const startedAtMs = nowMs();
      const result = await runWithAutomationResilience({
        account,
        action: "ingest",
        payload: null
      });
      const durationMs = Math.max(0, nowMs() - startedAtMs);
      const targetExceeded = durationMs > normalizedIngestP95TargetMs;
      emitReliabilityEvent({
        type: "rpa_ingest_latency_measured",
        platform,
        accountId: account?.id || account?.account_external_id || "unknown",
        action: "ingest",
        durationMs,
        p95TargetMs: normalizedIngestP95TargetMs,
        targetExceeded
      });
      if (targetExceeded) {
        emitReliabilityEvent({
          type: "rpa_ingest_latency_target_exceeded",
          platform,
          accountId: account?.id || account?.account_external_id || "unknown",
          action: "ingest",
          durationMs,
          p95TargetMs: normalizedIngestP95TargetMs
        });
      }

      const messages = Array.isArray(result?.messages) ? result.messages : [];
      return messages.map((message) => normalizeInboundMessage(message));
    },
    async send({ account, outbound }) {
      const result = await runWithAutomationResilience({
        account,
        action: "send",
        payload: {
          externalThreadId: outbound.externalThreadId,
          body: outbound.body
        }
      });

      return {
        externalMessageId: result?.externalMessageId || null,
        channel: result?.channel || "in_app",
        providerStatus: result?.status || "sent"
      };
    }
  };
}

function createNoopTransport() {
  return {
    async request({ method, path, body }) {
      if (method === "GET" && path.endsWith("/messages")) {
        return { messages: [] };
      }

      if (method === "POST" && path.endsWith("/messages")) {
        return {
          id: `api_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
          status: "sent",
          channel: "in_app",
          echo: body || {}
        };
      }

      return {};
    }
  };
}

function createNoopRpaRunner() {
  return createRpaRunner({ runtimeMode: "mock" });
}

function createNoopSessionManager() {
  return {
    async get() {
      return null;
    },
    async refresh() {
      return null;
    }
  };
}

export function createConnectorRegistry(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const ingestMetrics = options.ingestMetrics || {};
  const defaultIngestP95TargetMs = normalizeP95TargetMs(
    ingestMetrics.p95TargetMs ?? env.LEASE_BOT_INGEST_P95_TARGET_MS
  );
  const transport = options.transport || createNoopTransport();
  const adapterOverridesFromEnv = loadAdapterOverridesFromEnv(env, logger);
  const rpaRunner = options.rpaRunner || createRpaRunner({
    runtimeMode: options.rpaRuntimeMode || env.LEASE_BOT_RPA_RUNTIME || "mock",
    logger,
    adapterOverrides: options.platformAdapters || adapterOverridesFromEnv || undefined,
    hooks: {
      onEvent(event) {
        logger.info?.("[integrations] rpa runtime event", event);
      }
    }
  });
  const retry = options.retry || {};
  const sleep = options.sleep || retry.sleep || sleepWithTimeout;
  const sessionManager = options.sessionManager || createEnvSessionManager(logger);
  const observabilityHook = options.observabilityHook || options.hooks?.onReliabilityEvent;
  const nowMs = options.nowMs || (() => Date.now());
  const random = options.random || Math.random;
  const pacingState = new Map();
  const circuitState = new Map();

  const connectors = new Map();
  for (const platform of SUPPORTED_PLATFORMS) {
    const config = CONNECTOR_DEFINITIONS[platform];
    const antiBotPolicy = {
      ...DEFAULT_ANTI_BOT_POLICY,
      ...(PLATFORM_ANTI_BOT_POLICIES[platform] || {}),
      ...(options.antiBot?.[platform] || {})
    };
    const circuitBreakerPolicy = {
      ...DEFAULT_CIRCUIT_BREAKER_POLICY,
      ...(options.circuitBreaker?.[platform] || {})
    };
    const ingestMetricsPolicy = {
      ...DEFAULT_INGEST_METRICS_POLICY,
      p95TargetMs: normalizeP95TargetMs(
        options.ingestMetrics?.[platform]?.p95TargetMs ?? defaultIngestP95TargetMs
      )
    };

    const connector = config.mode === "api"
      ? createApiConnector({ platform, config, transport })
      : createRpaConnector({
          platform,
          config,
          rpaRunner,
          logger,
          observabilityHook,
          retry,
          sleep,
          sessionManager,
          antiBotPolicy,
          circuitBreakerPolicy,
          ingestMetricsPolicy,
          nowMs,
          random,
          pacingState,
          circuitState
        });

    connectors.set(platform, connector);
  }

  function getConnector(platform) {
    const connector = connectors.get(platform);
    if (!connector) {
      throw new Error(`Unsupported platform '${platform}'`);
    }
    return connector;
  }

  function normalizeAccount(account) {
    return {
      ...account,
      credentials: resolveCredentials(account.platform, account.credentials || {}, env)
    };
  }

  return {
    supportedPlatforms: [...SUPPORTED_PLATFORMS],

    getConnector,

    async ingestMessagesForAccount(account) {
      const normalizedAccount = normalizeAccount(account);
      const connector = getConnector(normalizedAccount.platform);
      if (connector.mode === "rpa") {
        return connector.ingest({ account: normalizedAccount });
      }

      return withRetry(
        () => connector.ingest({ account: normalizedAccount }),
        {
          ...retry,
          onRetry: ({ attempt, delayMs, error }) => {
            logger.warn?.("[integrations] retrying ingest", {
              platform: normalizedAccount.platform,
              accountId: normalizedAccount.id,
              attempt,
              delayMs,
              error: error.message
            });
          }
        }
      );
    },

    async sendMessageForAccount({ account, outbound }) {
      const normalizedAccount = normalizeAccount(account);
      const connector = getConnector(normalizedAccount.platform);
      if (connector.mode === "rpa") {
        return connector.send({ account: normalizedAccount, outbound });
      }

      return withRetry(
        () => connector.send({ account: normalizedAccount, outbound }),
        {
          ...retry,
          onRetry: ({ attempt, delayMs, error }) => {
            logger.warn?.("[integrations] retrying send", {
              platform: normalizedAccount.platform,
              accountId: normalizedAccount.id,
              attempt,
              delayMs,
              error: error.message
            });
          }
        }
      );
    }
  };
}

export function listSupportedPlatforms() {
  return [...SUPPORTED_PLATFORMS];
}

export function resolvePlatformCredentials(account, env = process.env) {
  return resolveCredentials(account.platform, account.credentials || {}, env);
}
