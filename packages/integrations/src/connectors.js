import { withRetry } from "./retry.js";

const SUPPORTED_PLATFORMS = ["spareroom", "roomies", "leasebreak", "renthop", "furnishedfinder"];

const CONNECTOR_DEFINITIONS = {
  spareroom: {
    mode: "rpa",
    requiredCredentials: ["username", "password"],
    apiBasePath: "/spareroom"
  },
  roomies: {
    mode: "rpa",
    requiredCredentials: ["email", "password"],
    apiBasePath: "/roomies"
  },
  leasebreak: {
    mode: "api",
    requiredCredentials: ["apiKey"],
    apiBasePath: "/leasebreak"
  },
  renthop: {
    mode: "api",
    requiredCredentials: ["accessToken"],
    apiBasePath: "/renthop"
  },
  furnishedfinder: {
    mode: "rpa",
    requiredCredentials: ["username", "password"],
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

function resolveEnvReference(reference, env, platform, key) {
  if (typeof reference !== "string" || reference.length === 0) {
    throw createMissingCredentialError(platform, key);
  }

  const envKey = reference.startsWith("env:") ? reference.slice(4) : reference;
  const resolved = env[envKey];
  if (resolved === undefined || resolved === null || resolved === "") {
    throw createMissingCredentialError(platform, key, reference);
  }

  return resolved;
}

function resolveCredentialValue(value, env, platform, key) {
  if (typeof value === "string" && value.startsWith("env:")) {
    return resolveEnvReference(value, env, platform, key);
  }

  if (value === undefined || value === null || value === "") {
    throw createMissingCredentialError(platform, key);
  }

  return value;
}

function resolveCredentials(platform, rawCredentials = {}, env = process.env) {
  const config = CONNECTOR_DEFINITIONS[platform];
  if (!config) {
    throw new Error(`Unsupported platform '${platform}'`);
  }

  const resolved = {};
  for (const key of config.requiredCredentials) {
    const inlineValue = rawCredentials[key];
    const referencedValue = rawCredentials[`${key}Ref`];

    if (inlineValue !== undefined && inlineValue !== null && inlineValue !== "") {
      resolved[key] = resolveCredentialValue(inlineValue, env, platform, key);
      continue;
    }

    if (referencedValue !== undefined && referencedValue !== null && referencedValue !== "") {
      resolved[key] = resolveEnvReference(referencedValue, env, platform, key);
      continue;
    }

    throw createMissingCredentialError(platform, key);
  }

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

function createRpaConnector({ platform, config, rpaRunner }) {
  return {
    id: platform,
    mode: config.mode,
    async ingest({ account }) {
      const result = await rpaRunner.run({
        platform,
        action: "ingest",
        account,
        credentials: account.credentials
      });

      const messages = Array.isArray(result?.messages) ? result.messages : [];
      return messages.map((message) => normalizeInboundMessage(message));
    },
    async send({ account, outbound }) {
      const result = await rpaRunner.run({
        platform,
        action: "send",
        account,
        credentials: account.credentials,
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
  return {
    async run({ action }) {
      if (action === "ingest") {
        return { messages: [] };
      }

      return {
        externalMessageId: `rpa_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
        status: "sent",
        channel: "in_app"
      };
    }
  };
}

export function createConnectorRegistry(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const transport = options.transport || createNoopTransport();
  const rpaRunner = options.rpaRunner || createNoopRpaRunner();
  const retry = options.retry || {};

  const connectors = new Map();
  for (const platform of SUPPORTED_PLATFORMS) {
    const config = CONNECTOR_DEFINITIONS[platform];
    const connector = config.mode === "api"
      ? createApiConnector({ platform, config, transport })
      : createRpaConnector({ platform, config, rpaRunner });

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
