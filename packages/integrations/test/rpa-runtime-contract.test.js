import assert from "node:assert/strict";
import test from "node:test";

import {
  createConnectorRegistry,
  createPlatformAdapterRegistry,
  createPlaywrightRpaRunner,
  REQUIRED_RPA_PLATFORMS
} from "../src/index.js";

function createFakePlaywrightFactory(pageFactory) {
  return {
    async launch() {
      return {
        async newContext() {
          return {
            async newPage() {
              return pageFactory();
            },
            async close() {}
          };
        },
        async close() {}
      };
    }
  };
}

function createEnv() {
  return {
    SPAREROOM_USERNAME: "sp_user",
    SPAREROOM_PASSWORD: "sp_pass",
    ROOMIES_EMAIL: "roomies@example.com",
    ROOMIES_PASSWORD: "roomies-pass",
    LEASEBREAK_API_KEY: "leasebreak-key",
    RENTHOP_ACCESS_TOKEN: "renthop-token",
    FURNISHEDFINDER_USERNAME: "ff_user",
    FURNISHEDFINDER_PASSWORD: "ff_pass"
  };
}

function createAccounts() {
  return [
    {
      id: "acc-spareroom",
      platform: "spareroom",
      credentials: {
        usernameRef: "env:SPAREROOM_USERNAME",
        passwordRef: "env:SPAREROOM_PASSWORD"
      }
    },
    {
      id: "acc-roomies",
      platform: "roomies",
      credentials: {
        emailRef: "env:ROOMIES_EMAIL",
        passwordRef: "env:ROOMIES_PASSWORD"
      }
    },
    {
      id: "acc-leasebreak",
      platform: "leasebreak",
      credentials: {
        apiKeyRef: "env:LEASEBREAK_API_KEY"
      }
    },
    {
      id: "acc-renthop",
      platform: "renthop",
      credentials: {
        accessTokenRef: "env:RENTHOP_ACCESS_TOKEN"
      }
    },
    {
      id: "acc-furnishedfinder",
      platform: "furnishedfinder",
      credentials: {
        usernameRef: "env:FURNISHEDFINDER_USERNAME",
        passwordRef: "env:FURNISHEDFINDER_PASSWORD"
      }
    }
  ];
}

function createSpyLogger() {
  const logs = {
    info: [],
    warn: [],
    error: []
  };

  return {
    logs,
    info(message, details) {
      logs.info.push({ message, details });
    },
    warn(message, details) {
      logs.warn.push({ message, details });
    },
    error(message, details) {
      logs.error.push({ message, details });
    }
  };
}

test("R1/R3 contract: adapter registry exposes five required platforms", () => {
  const registry = createPlatformAdapterRegistry();
  assert.deepEqual(registry.supportedPlatforms.sort(), [...REQUIRED_RPA_PLATFORMS].sort());
  for (const platform of REQUIRED_RPA_PLATFORMS) {
    const adapter = registry.get(platform);
    assert.ok(adapter);
    assert.ok(adapter.inboxUrl.startsWith("https://"));
    assert.equal(typeof adapter.threadUrl("thread-1"), "string");
  }
});

test("R2/R3/R4 contract: browser runner executes ingest+send for all five platforms", async () => {
  const runtimeEvents = [];
  const callLog = [];
  const rpaRunner = createPlaywrightRpaRunner({
    playwrightFactory: createFakePlaywrightFactory(() => ({
      async goto() {},
      async fill() {},
      async click() {},
      async $() {
        return null;
      },
      async $$eval() {
        return [];
      }
    })),
    hooks: {
      onEvent(event) {
        runtimeEvents.push(event);
      }
    },
    actionHandlers: Object.fromEntries(
      REQUIRED_RPA_PLATFORMS.map((platform) => [
        platform,
        {
          async ingest() {
            callLog.push(`${platform}:ingest`);
            return {
              messages: [
                {
                  externalThreadId: `${platform}-thread-1`,
                  externalMessageId: `${platform}-message-1`,
                  body: `Inbound ${platform}`,
                  channel: "in_app",
                  sentAt: "2026-02-07T01:00:00.000Z",
                  metadata: {
                    platform
                  }
                }
              ]
            };
          },
          async send({ payload }) {
            callLog.push(`${platform}:send`);
            return {
              externalMessageId: `${platform}-outbound-1`,
              channel: "in_app",
              status: "queued",
              echo: payload
            };
          }
        }
      ])
    )
  });

  const connectorRegistry = createConnectorRegistry({
    env: createEnv(),
    rpaRunner
  });

  for (const account of createAccounts()) {
    const ingested = await connectorRegistry.ingestMessagesForAccount(account);
    assert.equal(ingested.length, 1);
    assert.equal(ingested[0].externalThreadId, `${account.platform}-thread-1`);

    const outbound = await connectorRegistry.sendMessageForAccount({
      account,
      outbound: {
        externalThreadId: `${account.platform}-thread-1`,
        body: "Tour windows available"
      }
    });
    assert.deepEqual(outbound, {
      externalMessageId: `${account.platform}-outbound-1`,
      channel: "in_app",
      providerStatus: "queued"
    });
  }

  assert.deepEqual(callLog.sort(), REQUIRED_RPA_PLATFORMS.flatMap((platform) => [`${platform}:ingest`, `${platform}:send`]).sort());
  assert.equal(runtimeEvents.filter((event) => event.type === "rpa_run_started").length, 10);
  assert.equal(runtimeEvents.filter((event) => event.type === "rpa_run_succeeded").length, 10);
});

test("R19 resilience: runtime normalizes captcha, challenge, and session errors", async () => {
  const rpaRunner = createPlaywrightRpaRunner({
    playwrightFactory: createFakePlaywrightFactory(() => ({
      async goto() {},
      async fill() {},
      async click() {},
      async $() {
        return null;
      },
      async $$eval() {
        return [];
      }
    })),
    actionHandlers: {
      leasebreak: {
        async ingest() {
          const error = new Error("captcha wall");
          error.code = "CAPTCHA_REQUIRED";
          throw error;
        }
      },
      spareroom: {
        async ingest() {
          const error = new Error("challenge page appeared");
          throw error;
        }
      },
      roomies: {
        async send() {
          const error = new Error("session expired");
          throw error;
        }
      }
    }
  });

  await assert.rejects(
    () => rpaRunner.run({ platform: "leasebreak", action: "ingest", account: { id: "a" } }),
    {
      code: "CAPTCHA_REQUIRED"
    }
  );

  await assert.rejects(
    () => rpaRunner.run({ platform: "spareroom", action: "ingest", account: { id: "a" } }),
    {
      code: "BOT_CHALLENGE"
    }
  );

  await assert.rejects(
    () => rpaRunner.run({ platform: "roomies", action: "send", account: { id: "a" }, payload: { externalThreadId: "t", body: "x" } }),
    {
      code: "SESSION_EXPIRED"
    }
  );
});

test("R19 resilience: connector emits reliability observability hooks for retry/session/circuit", async () => {
  const events = [];
  let ingestAttempts = 0;
  const registry = createConnectorRegistry({
    env: createEnv(),
    observabilityHook(event) {
      events.push(event);
    },
    retry: {
      retries: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      jitter: false
    },
    antiBot: {
      leasebreak: {
        minIntervalMs: 0,
        jitterMs: 0,
        maxCaptchaRetries: 1
      }
    },
    circuitBreaker: {
      leasebreak: {
        failureThreshold: 2,
        cooldownMs: 1_000
      }
    },
    sessionManager: {
      async get() {
        return { token: "session" };
      },
      async refresh() {}
    },
    rpaRunner: {
      async run({ action }) {
        if (action !== "ingest") {
          return {
            externalMessageId: "outbound-1",
            channel: "in_app",
            status: "sent"
          };
        }

        ingestAttempts += 1;
        if (ingestAttempts === 1) {
          const error = new Error("captcha page");
          error.code = "CAPTCHA_REQUIRED";
          throw error;
        }

        if (ingestAttempts <= 4) {
          const error = new Error("platform outage");
          error.status = 503;
          throw error;
        }

        return {
          messages: []
        };
      }
    }
  });

  const account = {
    id: "acc-leasebreak",
    platform: "leasebreak",
    credentials: {
      apiKeyRef: "env:LEASEBREAK_API_KEY"
    }
  };

  await assert.rejects(() => registry.ingestMessagesForAccount(account), /platform outage/);
  await assert.rejects(() => registry.ingestMessagesForAccount(account), /platform outage/);
  await assert.rejects(() => registry.ingestMessagesForAccount(account), {
    code: "CIRCUIT_OPEN"
  });

  assert.equal(events.some((event) => event.type === "rpa_session_refresh_requested"), true);
  assert.equal(events.some((event) => event.type === "rpa_retry_scheduled"), true);
  assert.equal(events.some((event) => event.type === "rpa_circuit_opened"), true);
  assert.equal(events.some((event) => event.type === "rpa_circuit_open_fail_fast"), true);
});

test("R19 resilience: default registry path logs reliability events without custom hook", async () => {
  const logger = createSpyLogger();
  let ingestAttempts = 0;
  const registry = createConnectorRegistry({
    env: createEnv(),
    logger,
    retry: {
      retries: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      jitter: false
    },
    antiBot: {
      leasebreak: {
        minIntervalMs: 0,
        jitterMs: 0,
        maxCaptchaRetries: 1
      }
    },
    circuitBreaker: {
      leasebreak: {
        failureThreshold: 2,
        cooldownMs: 1_000
      }
    },
    sessionManager: {
      async get() {
        return { token: "session" };
      },
      async refresh() {}
    },
    rpaRunner: {
      async run({ action }) {
        if (action !== "ingest") {
          return {
            externalMessageId: "outbound-1",
            channel: "in_app",
            status: "sent"
          };
        }

        ingestAttempts += 1;
        if (ingestAttempts === 1) {
          const error = new Error("captcha page");
          error.code = "CAPTCHA_REQUIRED";
          throw error;
        }

        if (ingestAttempts <= 4) {
          const error = new Error("platform outage");
          error.status = 503;
          throw error;
        }

        return {
          messages: []
        };
      }
    }
  });

  const account = {
    id: "acc-leasebreak",
    platform: "leasebreak",
    credentials: {
      apiKeyRef: "env:LEASEBREAK_API_KEY"
    }
  };

  await assert.rejects(() => registry.ingestMessagesForAccount(account), /platform outage/);
  await assert.rejects(() => registry.ingestMessagesForAccount(account), /platform outage/);
  await assert.rejects(() => registry.ingestMessagesForAccount(account), {
    code: "CIRCUIT_OPEN"
  });

  const reliabilityEvents = logger.logs.info
    .filter((entry) => entry.message === "[integrations] rpa reliability event")
    .map((entry) => entry.details?.type)
    .filter(Boolean);

  assert.equal(reliabilityEvents.includes("rpa_session_refresh_requested"), true);
  assert.equal(reliabilityEvents.includes("rpa_retry_scheduled"), true);
  assert.equal(reliabilityEvents.includes("rpa_circuit_opened"), true);
  assert.equal(reliabilityEvents.includes("rpa_circuit_open_fail_fast"), true);
});

test("R4 traceability: ingest p95 target metric wiring is configurable and emits evidence", async () => {
  const events = [];
  let tick = 0;
  const nowMs = () => {
    tick += 25;
    return tick;
  };

  const registry = createConnectorRegistry({
    env: createEnv(),
    nowMs,
    ingestMetrics: {
      p95TargetMs: 10
    },
    antiBot: {
      spareroom: {
        minIntervalMs: 0,
        jitterMs: 0
      }
    },
    observabilityHook(event) {
      events.push(event);
    },
    sessionManager: {
      async get() {
        return { token: "session" };
      },
      async refresh() {}
    },
    rpaRunner: {
      async run() {
        return {
          messages: []
        };
      }
    }
  });

  await registry.ingestMessagesForAccount({
    id: "acc-spareroom",
    platform: "spareroom",
    credentials: {
      usernameRef: "env:SPAREROOM_USERNAME",
      passwordRef: "env:SPAREROOM_PASSWORD"
    }
  });

  const latencyMeasuredEvent = events.find((event) => event.type === "rpa_ingest_latency_measured");
  assert.ok(latencyMeasuredEvent);
  assert.equal(latencyMeasuredEvent.platform, "spareroom");
  assert.equal(latencyMeasuredEvent.action, "ingest");
  assert.equal(latencyMeasuredEvent.p95TargetMs, 10);
  assert.equal(latencyMeasuredEvent.targetExceeded, true);
  assert.equal(typeof latencyMeasuredEvent.durationMs, "number");
  assert.equal(latencyMeasuredEvent.durationMs > latencyMeasuredEvent.p95TargetMs, true);

  const exceededEvent = events.find((event) => event.type === "rpa_ingest_latency_target_exceeded");
  assert.ok(exceededEvent);
  assert.equal(exceededEvent.p95TargetMs, 10);
});
