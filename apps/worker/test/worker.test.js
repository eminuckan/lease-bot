import assert from "node:assert/strict";
import test from "node:test";

import { classifyIntent, detectFollowUp } from "../../../packages/ai/src/index.js";
import {
  createConnectorRegistry,
  processPendingMessages,
  resolvePlatformCredentials,
  withRetry
} from "../../../packages/integrations/src/index.js";

function createMemoryAdapter({ pendingMessages, ruleByIntent, templatesByName, slotOptionsByUnit = {} }) {
  const processed = [];
  const outbound = [];
  const logs = [];

  return {
    adapter: {
      async fetchPendingMessages() {
        return pendingMessages;
      },
      async fetchSlotOptions(unitId) {
        return slotOptionsByUnit[unitId] || [];
      },
      async findRule({ intent, fallbackIntent }) {
        return ruleByIntent[intent] || ruleByIntent[fallbackIntent] || null;
      },
      async findTemplate({ templateName }) {
        return templatesByName[templateName] || null;
      },
      async recordOutboundReply(payload) {
        outbound.push(payload);
      },
      async markInboundProcessed(payload) {
        processed.push(payload);
      },
      async recordLog(payload) {
        logs.push(payload);
      }
    },
    processed,
    outbound,
    logs
  };
}

test("classifies intent and follow-up signals", () => {
  assert.equal(classifyIntent("Can I tour this unit this week?"), "tour_request");
  assert.equal(classifyIntent("What is the monthly rent?"), "pricing_question");
  assert.equal(detectFollowUp("Just checking in, any update?", true), true);
  assert.equal(detectFollowUp("Just checking in, any update?", false), false);
});

test("queue processing creates template-based reply and logs result", async () => {
  const fixture = createMemoryAdapter({
    pendingMessages: [
      {
        id: "m1",
        conversationId: "c1",
        body: "Hi, can I tour tomorrow?",
        metadata: {},
        platformAccountId: "p1",
        assignedAgentId: "a1",
        leadName: "Jamie",
        unitId: "u1",
        propertyName: "Atlas Apartments",
        unitNumber: "4B",
        hasRecentOutbound: false
      }
    ],
    ruleByIntent: {
      tour_request: {
        id: "r1",
        enabled: true,
        actionConfig: { template: "tour_invite_v1" }
      }
    },
    templatesByName: {
      tour_invite_v1: {
        id: "t1",
        body: "Thanks {{lead_name}}. Tours for {{unit_number}}: {{slot_options}}"
      }
    },
    slotOptionsByUnit: {
      u1: [
        {
          starts_at: "2026-02-10T17:00:00.000Z",
          ends_at: "2026-02-10T17:30:00.000Z",
          timezone: "UTC"
        }
      ]
    }
  });

  const result = await processPendingMessages({
    adapter: fixture.adapter,
    logger: console,
    now: new Date("2026-02-06T10:00:00.000Z")
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.repliesCreated, 1);
  assert.equal(result.metrics.decisions.eligible, 1);
  assert.equal(result.metrics.sends.sent, 1);
  assert.equal(result.metrics.auditLogsWritten, 3);
  assert.equal(fixture.outbound.length, 1);
  assert.match(fixture.outbound[0].body, /Tours for 4B/);
  assert.equal(fixture.processed[0].metadataPatch.replyEligible, true);
  assert.equal(fixture.logs[0].action, "ai_reply_decision");
  assert.equal(fixture.logs[1].action, "ai_reply_send_attempted");
  assert.equal(fixture.logs[2].action, "ai_reply_created");
});

test("follow-up message falls back to prior intent rule", async () => {
  const fixture = createMemoryAdapter({
    pendingMessages: [
      {
        id: "m2",
        conversationId: "c2",
        body: "Any update on this?",
        metadata: { intent: "tour_request" },
        platformAccountId: "p1",
        assignedAgentId: "a1",
        leadName: "Jamie",
        unitId: "u1",
        propertyName: "Atlas Apartments",
        unitNumber: "4B",
        hasRecentOutbound: true
      }
    ],
    ruleByIntent: {
      tour_request: {
        id: "r1",
        enabled: true,
        actionConfig: { template: "tour_invite_v1" }
      }
    },
    templatesByName: {
      tour_invite_v1: {
        id: "t1",
        body: "Following up with available slots for {{unit_number}}: {{slot_options}}"
      }
    },
    slotOptionsByUnit: {
      u1: [
        {
          starts_at: "2026-02-10T17:00:00.000Z",
          ends_at: "2026-02-10T17:30:00.000Z",
          timezone: "UTC"
        }
      ]
    }
  });

  await processPendingMessages({ adapter: fixture.adapter, logger: console, now: new Date("2026-02-06T10:00:00.000Z") });

  assert.equal(fixture.outbound.length, 1);
  assert.equal(fixture.processed[0].metadataPatch.followUp, true);
  assert.equal(fixture.processed[0].metadataPatch.effectiveIntent, "follow_up");
});

test("unsubscribe follow-up stays ineligible even with fallback rule", async () => {
  const fixture = createMemoryAdapter({
    pendingMessages: [
      {
        id: "m4",
        conversationId: "c4",
        body: "Please stop messaging me, any update?",
        metadata: { intent: "tour_request" },
        platformAccountId: "p1",
        assignedAgentId: "a1",
        leadName: "Jamie",
        unitId: "u1",
        propertyName: "Atlas Apartments",
        unitNumber: "4B",
        hasRecentOutbound: true
      }
    ],
    ruleByIntent: {
      tour_request: {
        id: "r1",
        enabled: true,
        actionConfig: { template: "tour_invite_v1" }
      }
    },
    templatesByName: {
      tour_invite_v1: {
        id: "t1",
        body: "Following up with available slots for {{unit_number}}: {{slot_options}}"
      }
    },
    slotOptionsByUnit: {
      u1: [
        {
          starts_at: "2026-02-10T17:00:00.000Z",
          ends_at: "2026-02-10T17:30:00.000Z",
          timezone: "UTC"
        }
      ]
    }
  });

  const result = await processPendingMessages({
    adapter: fixture.adapter,
    logger: console,
    now: new Date("2026-02-06T10:00:00.000Z")
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.repliesCreated, 0);
  assert.equal(result.metrics.decisions.ineligible, 1);
  assert.equal(result.metrics.decisions.reasons.unsubscribe_requested, 1);
  assert.equal(fixture.outbound.length, 0);
  assert.equal(fixture.processed[0].metadataPatch.intent, "unsubscribe");
  assert.equal(fixture.processed[0].metadataPatch.followUp, true);
  assert.equal(fixture.processed[0].metadataPatch.replyEligible, false);
  assert.equal(fixture.processed[0].metadataPatch.replyDecisionReason, "unsubscribe_requested");
  assert.equal(fixture.logs[0].action, "ai_reply_decision");
  assert.equal(fixture.logs[1].action, "ai_reply_skipped");
});

test("guardrails block unsafe messages and still record logs", async () => {
  const fixture = createMemoryAdapter({
    pendingMessages: [
      {
        id: "m3",
        conversationId: "c3",
        body: "My attorney will contact you soon",
        metadata: {},
        platformAccountId: "p1",
        assignedAgentId: "a1",
        leadName: "Jamie",
        unitId: "u1",
        propertyName: "Atlas Apartments",
        unitNumber: "4B",
        hasRecentOutbound: false
      }
    ],
    ruleByIntent: {
      unknown: {
        id: "r2",
        enabled: true,
        actionConfig: { template: "tour_invite_v1" }
      }
    },
    templatesByName: {
      tour_invite_v1: {
        id: "t1",
        body: "Thanks for your message"
      }
    }
  });

  const result = await processPendingMessages({ adapter: fixture.adapter, logger: console, now: new Date("2026-02-06T10:00:00.000Z") });

  assert.equal(result.scanned, 1);
  assert.equal(result.repliesCreated, 0);
  assert.equal(result.metrics.decisions.ineligible, 1);
  assert.equal(fixture.outbound.length, 0);
  assert.equal(fixture.processed[0].metadataPatch.replyEligible, false);
  assert.match(fixture.processed[0].metadataPatch.replyDecisionReason, /guardrail_blocked|intent_unknown/);
  assert.equal(fixture.logs[0].action, "ai_reply_decision");
  assert.equal(fixture.logs[1].action, "ai_reply_skipped");
});

test("processing failures are captured in metrics and error logs", async () => {
  const fixture = createMemoryAdapter({
    pendingMessages: [
      {
        id: "m6",
        conversationId: "c6",
        body: "Can I tour this unit this weekend?",
        metadata: {},
        platformAccountId: "p1",
        assignedAgentId: "a1",
        leadName: "Jamie",
        unitId: "u1",
        propertyName: "Atlas Apartments",
        unitNumber: "4B",
        hasRecentOutbound: false
      }
    ],
    ruleByIntent: {
      tour_request: {
        id: "r1",
        enabled: true,
        actionConfig: { template: "tour_invite_v1" }
      }
    },
    templatesByName: {
      tour_invite_v1: {
        id: "t1",
        body: "Tours for {{unit_number}}"
      }
    }
  });

  fixture.adapter.recordOutboundReply = async () => {
    throw new Error("db insert failed");
  };

  const result = await processPendingMessages({
    adapter: fixture.adapter,
    logger: console,
    now: new Date("2026-02-06T10:00:00.000Z")
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.repliesCreated, 0);
  assert.equal(result.metrics.errors, 1);
  assert.equal(fixture.logs.at(-1).action, "ai_reply_error");
});

test("connector registry exposes five platforms with API/RPA paths", async () => {
  const transportCalls = [];
  const rpaCalls = [];
  const registry = createConnectorRegistry({
    env: {
      ZILLOW_API_KEY: "zk_123",
      ZUMPER_ACCESS_TOKEN: "zt_123",
      APARTMENTS_COM_USERNAME: "ac_user",
      APARTMENTS_COM_PASSWORD: "ac_pass",
      REALTOR_COM_USERNAME: "rc_user",
      REALTOR_COM_PASSWORD: "rc_pass",
      CRAIGSLIST_EMAIL: "cl@example.com",
      CRAIGSLIST_PASSWORD: "cl_pass"
    },
    transport: {
      async request(payload) {
        transportCalls.push(payload);
        if (payload.method === "POST") {
          return { id: "api-1", status: "sent", channel: "in_app" };
        }
        return { messages: [] };
      }
    },
    rpaRunner: {
      async run(payload) {
        rpaCalls.push(payload);
        return { externalMessageId: "rpa-1", status: "sent", channel: "sms" };
      }
    }
  });

  assert.deepEqual(registry.supportedPlatforms.sort(), [
    "apartments_com",
    "craigslist",
    "realtor_com",
    "zillow",
    "zumper"
  ]);

  await registry.sendMessageForAccount({
    account: {
      id: "acc-zillow",
      platform: "zillow",
      credentials: { apiKey: "env:ZILLOW_API_KEY" }
    },
    outbound: {
      externalThreadId: "thread-zillow-1",
      body: "Tour slots available"
    }
  });

  await registry.sendMessageForAccount({
    account: {
      id: "acc-apartments",
      platform: "apartments_com",
      credentials: {
        username: "env:APARTMENTS_COM_USERNAME",
        password: "env:APARTMENTS_COM_PASSWORD"
      }
    },
    outbound: {
      externalThreadId: "thread-apartments-1",
      body: "Tour slots available"
    }
  });

  assert.equal(transportCalls.length, 1);
  assert.equal(transportCalls[0].path, "/zillow/messages");
  assert.equal(rpaCalls.length, 1);
  assert.equal(rpaCalls[0].platform, "apartments_com");
});

test("credentials resolve from env references and fail fast when missing", () => {
  const account = {
    platform: "zumper",
    credentials: {
      accessToken: "env:ZUMPER_ACCESS_TOKEN"
    }
  };

  const credentials = resolvePlatformCredentials(account, {
    ZUMPER_ACCESS_TOKEN: "token-123"
  });

  assert.equal(credentials.accessToken, "token-123");

  assert.throws(
    () => resolvePlatformCredentials(account, {}),
    /Missing credential 'accessToken' for zumper/
  );
});

test("retry backoff retries transient failures before succeeding", async () => {
  const attempts = [];
  const sleeps = [];
  const result = await withRetry(
    async (attempt) => {
      attempts.push(attempt);
      if (attempt < 3) {
        const error = new Error("temporary outage");
        error.status = 503;
        throw error;
      }
      return "ok";
    },
    {
      retries: 3,
      baseDelayMs: 5,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      }
    }
  );

  assert.equal(result, "ok");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.equal(sleeps.length, 2);
  assert.equal(sleeps[0] > 0, true);
});

test("queue processing dispatches through connector when auto-send is enabled", async () => {
  const fixture = createMemoryAdapter({
    pendingMessages: [
      {
        id: "m5",
        conversationId: "c5",
        body: "Can I tour this place this weekend?",
        metadata: {},
        platformAccountId: "p5",
        platform: "zillow",
        platformCredentials: { apiKey: "env:ZILLOW_API_KEY" },
        externalThreadId: "thread-5",
        assignedAgentId: "a1",
        leadName: "Jamie",
        unitId: "u1",
        propertyName: "Atlas Apartments",
        unitNumber: "4B",
        hasRecentOutbound: false
      }
    ],
    ruleByIntent: {
      tour_request: {
        id: "r1",
        enabled: true,
        actionConfig: { template: "tour_invite_v1" }
      }
    },
    templatesByName: {
      tour_invite_v1: {
        id: "t1",
        body: "Tours for {{unit_number}}"
      }
    }
  });

  fixture.adapter.dispatchOutboundMessage = async () => ({
    externalMessageId: "ext-123",
    channel: "in_app",
    providerStatus: "sent"
  });

  await processPendingMessages({
    adapter: fixture.adapter,
    logger: console,
    now: new Date("2026-02-06T10:00:00.000Z")
  });

  assert.equal(fixture.outbound.length, 1);
  assert.equal(fixture.outbound[0].externalMessageId, "ext-123");
  assert.equal(fixture.outbound[0].channel, "in_app");
  assert.equal(fixture.outbound[0].metadata.delivery.externalMessageId, "ext-123");
});
