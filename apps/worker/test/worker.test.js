import assert from "node:assert/strict";
import test from "node:test";

import { classifyIntent, detectFollowUp, runReplyPipelineWithAI } from "../../../packages/ai/src/index.js";
import { processPendingMessages } from "../src/worker.js";
import {
  createConnectorRegistry,
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

test("policy gating prefers AI intent over heuristic intent", async () => {
  const result = await runReplyPipelineWithAI({
    inboundBody: "What is the monthly rent for this unit?",
    hasRecentOutbound: false,
    fallbackIntent: "unknown",
    rule: { enabled: true },
    template: null,
    templateContext: {
      unit: "Atlas Apartments 4B",
      slot_options: "2026-02-10T17:00:00.000Z - 2026-02-10T17:30:00.000Z UTC"
    },
    autoSendEnabled: true,
    aiClassifier: async () => ({
      intent: "tour_request",
      ambiguity: false,
      suggestedReply: "Tour windows are available this week.",
      reasonCode: null
    })
  });

  assert.equal(result.intent, "tour_request");
  assert.equal(result.effectiveIntent, "tour_request");
  assert.equal(result.outcome, "send");
  assert.equal(result.escalationReasonCode, null);
});

test("gemini env toggles set provider enablement and model", async () => {
  const previousProvider = process.env.AI_DECISION_PROVIDER;
  const previousModel = process.env.AI_GEMINI_MODEL;
  process.env.AI_DECISION_PROVIDER = "gemini";
  process.env.AI_GEMINI_MODEL = "gemini-2.0-flash";

  const calls = [];
  const aiClassifier = async (payload) => {
    calls.push(payload);
    return null;
  };

  try {
    await runReplyPipelineWithAI({
      inboundBody: "Can I tour this week?",
      hasRecentOutbound: false,
      fallbackIntent: "tour_request",
      rule: { enabled: false },
      template: {
        body: "Tours for {{unit_number}}: {{slot_options}}"
      },
      templateContext: {
        unit_number: "4B",
        slot_options: "2026-02-10T17:00:00.000Z - 2026-02-10T17:30:00.000Z UTC"
      },
      aiClassifier
    });
  } finally {
    if (previousProvider === undefined) {
      delete process.env.AI_DECISION_PROVIDER;
    } else {
      process.env.AI_DECISION_PROVIDER = previousProvider;
    }
    if (previousModel === undefined) {
      delete process.env.AI_GEMINI_MODEL;
    } else {
      process.env.AI_GEMINI_MODEL = previousModel;
    }
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].enabled, true);
  assert.equal(calls[0].geminiModel, "gemini-2.0-flash");
});

test("generation failure falls back to heuristic policy path", async () => {
  const result = await runReplyPipelineWithAI({
    inboundBody: "Can I tour this week?",
    hasRecentOutbound: false,
    fallbackIntent: "tour_request",
    rule: { enabled: false },
    template: {
      body: "Tours for {{unit_number}}: {{slot_options}}"
    },
    templateContext: {
      unit_number: "4B",
      slot_options: "2026-02-10T17:00:00.000Z - 2026-02-10T17:30:00.000Z UTC"
    },
    aiClassifier: async () => {
      throw new Error("gemini unavailable");
    }
  });

  assert.equal(result.provider, "heuristic");
  assert.equal(result.intent, "tour_request");
  assert.equal(result.outcome, "draft");
  assert.equal(result.escalationReasonCode, null);
});

test("R13 no-slot tour flow escalates with explicit reason", async () => {
  const result = await runReplyPipelineWithAI({
    inboundBody: "Can I schedule a showing tomorrow?",
    hasRecentOutbound: false,
    fallbackIntent: "tour_request",
    rule: { enabled: true },
    template: {
      body: "Tours for {{unit_number}}: {{slot_options}}"
    },
    templateContext: {
      unit_number: "4B",
      slot_options: ""
    },
    aiClassifier: async () => ({
      intent: "tour_request",
      ambiguity: false,
      suggestedReply: "",
      reasonCode: null
    })
  });

  assert.equal(result.outcome, "escalate");
  assert.equal(result.escalationReasonCode, "escalate_no_slot_candidates");
});

test("R13 slot-aware flow drafts when slots are present", async () => {
  const slotWindow = "2026-02-10T17:00:00.000Z - 2026-02-10T17:30:00.000Z UTC";
  const result = await runReplyPipelineWithAI({
    inboundBody: "Can I schedule a showing tomorrow?",
    hasRecentOutbound: false,
    fallbackIntent: "tour_request",
    rule: { enabled: false },
    template: null,
    templateContext: {
      unit: "Atlas Apartments 4B",
      slot_options: slotWindow
    },
    aiClassifier: async () => ({
      intent: "tour_request",
      ambiguity: false,
      suggestedReply: null,
      reasonCode: null
    })
  });

  assert.equal(result.outcome, "draft");
  assert.equal(result.effectiveIntent, "tour_request");
  assert.equal(result.replyBody.includes(slotWindow), true);
  assert.equal(result.escalationReasonCode, null);
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
  assert.equal(result.metrics.decisions.reasons.escalate_unsubscribe_requested, 1);
  assert.equal(fixture.outbound.length, 0);
  assert.equal(fixture.processed[0].metadataPatch.intent, "unsubscribe");
  assert.equal(fixture.processed[0].metadataPatch.followUp, true);
  assert.equal(fixture.processed[0].metadataPatch.replyEligible, false);
  assert.equal(fixture.processed[0].metadataPatch.replyDecisionReason, "escalate_unsubscribe_requested");
  assert.equal(fixture.processed[0].metadataPatch.outcome, "escalate");
  assert.equal(fixture.logs[0].action, "ai_reply_decision");
  assert.equal(fixture.logs[1].action, "ai_reply_escalated");
  assert.equal(fixture.logs[2].action, "ai_reply_skipped");
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
  assert.match(fixture.processed[0].metadataPatch.replyDecisionReason, /^escalate_/);
  assert.equal(fixture.logs[0].action, "ai_reply_decision");
  assert.equal(fixture.logs[1].action, "ai_reply_escalated");
  assert.equal(fixture.logs[2].action, "ai_reply_skipped");
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

test("dispatch failures emit platform failure metrics and audit signals", async () => {
  const fixture = createMemoryAdapter({
    pendingMessages: [
      {
        id: "m9",
        conversationId: "c9",
        body: "Can I tour this unit this weekend?",
        metadata: {},
        platform: "leasebreak",
        platformAccountId: "p9",
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

  fixture.adapter.dispatchOutboundMessage = async () => {
    throw new Error("platform outage");
  };

  const result = await processPendingMessages({
    adapter: fixture.adapter,
    logger: console,
    now: new Date("2026-02-06T10:00:00.000Z")
  });

  assert.equal(result.metrics.errors, 1);
  assert.equal(result.metrics.platformFailures.leasebreak, 1);
  assert.equal(fixture.logs.at(-2).action, "ai_reply_error");
  assert.equal(fixture.logs.at(-2).details.stage, "dispatch_outbound_message");
  assert.equal(fixture.logs.at(-1).action, "platform_dispatch_error");
  assert.equal(fixture.logs.at(-1).details.platform, "leasebreak");
});

test("connector registry exposes five platforms with API/RPA paths", async () => {
  const transportCalls = [];
  const rpaCalls = [];
  const registry = createConnectorRegistry({
    env: {
      SPAREROOM_USERNAME: "sp_user",
      SPAREROOM_PASSWORD: "sp_pass",
      ROOMIES_EMAIL: "rm@example.com",
      ROOMIES_PASSWORD: "rm_pass",
      LEASEBREAK_API_KEY: "lb_key",
      RENTHOP_ACCESS_TOKEN: "rh_token",
      FURNISHEDFINDER_USERNAME: "ff_user",
      FURNISHEDFINDER_PASSWORD: "ff_pass"
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
    "furnishedfinder",
    "leasebreak",
    "renthop",
    "roomies",
    "spareroom"
  ]);

  await registry.sendMessageForAccount({
    account: {
      id: "acc-leasebreak",
      platform: "leasebreak",
      credentials: { apiKey: "env:LEASEBREAK_API_KEY" }
    },
    outbound: {
      externalThreadId: "thread-leasebreak-1",
      body: "Tour slots available"
    }
  });

  await registry.sendMessageForAccount({
    account: {
      id: "acc-spareroom",
      platform: "spareroom",
      credentials: {
        usernameRef: "SPAREROOM_USERNAME",
        passwordRef: "env:SPAREROOM_PASSWORD"
      }
    },
    outbound: {
      externalThreadId: "thread-spareroom-1",
      body: "Tour slots available"
    }
  });

  assert.equal(transportCalls.length, 1);
  assert.equal(transportCalls[0].path, "/leasebreak/messages");
  assert.equal(rpaCalls.length, 1);
  assert.equal(rpaCalls[0].platform, "spareroom");
});

test("credentials resolve from env references and fail fast when missing", () => {
  const account = {
    platform: "renthop",
    credentials: {
      accessTokenRef: "RENTHOP_ACCESS_TOKEN"
    }
  };

  const credentials = resolvePlatformCredentials(account, {
    RENTHOP_ACCESS_TOKEN: "token-123"
  });

  assert.equal(credentials.accessToken, "token-123");

  assert.throws(
    () => resolvePlatformCredentials(account, {}),
    /Missing credential 'accessToken' for renthop/
  );
});

test("connector registry retries transient failures and keeps ingest/send contracts", async () => {
  const sleeps = [];
  let apiIngestAttempts = 0;
  let rpaSendAttempts = 0;

  const registry = createConnectorRegistry({
    env: {
      LEASEBREAK_API_KEY: "lb_key",
      FURNISHEDFINDER_USERNAME: "ff_user",
      FURNISHEDFINDER_PASSWORD: "ff_pass"
    },
    retry: {
      retries: 2,
      baseDelayMs: 1,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      }
    },
    transport: {
      async request(payload) {
        if (payload.method === "GET" && payload.path === "/leasebreak/messages") {
          apiIngestAttempts += 1;
          if (apiIngestAttempts === 1) {
            const error = new Error("leasebreak outage");
            error.status = 503;
            throw error;
          }

          return {
            messages: [
              {
                threadId: "thread-1",
                messageId: "msg-1",
                body: "Interested in a tour"
              }
            ]
          };
        }

        return { messages: [] };
      }
    },
    rpaRunner: {
      async run(payload) {
        if (payload.platform === "furnishedfinder" && payload.action === "send") {
          rpaSendAttempts += 1;
          if (rpaSendAttempts === 1) {
            const error = new Error("temporary timeout");
            error.code = "ETIMEDOUT";
            throw error;
          }

          return {
            externalMessageId: "ff-msg-1",
            channel: "email",
            status: "queued"
          };
        }

        return { messages: [] };
      }
    }
  });

  const ingested = await registry.ingestMessagesForAccount({
    id: "acc-lb-1",
    platform: "leasebreak",
    credentials: { apiKeyRef: "LEASEBREAK_API_KEY" }
  });

  assert.equal(apiIngestAttempts, 2);
  assert.equal(ingested.length, 1);
  assert.deepEqual(ingested[0], {
    externalThreadId: "thread-1",
    externalMessageId: "msg-1",
    body: "Interested in a tour",
    leadName: null,
    leadContact: {},
    channel: "in_app",
    sentAt: ingested[0].sentAt,
    metadata: {}
  });

  const sent = await registry.sendMessageForAccount({
    account: {
      id: "acc-ff-1",
      platform: "furnishedfinder",
      credentials: {
        usernameRef: "env:FURNISHEDFINDER_USERNAME",
        passwordRef: "FURNISHEDFINDER_PASSWORD"
      }
    },
    outbound: {
      externalThreadId: "thread-2",
      body: "Tour availability attached"
    }
  });

  assert.equal(rpaSendAttempts, 2);
  assert.deepEqual(sent, {
    externalMessageId: "ff-msg-1",
    channel: "email",
    providerStatus: "queued"
  });
  assert.equal(sleeps.length, 2);
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
        platform: "leasebreak",
        platformCredentials: { apiKey: "env:LEASEBREAK_API_KEY" },
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

test("auto-send disabled drafts policy-eligible tour replies", async () => {
  const fixture = createMemoryAdapter({
    pendingMessages: [
      {
        id: "m7",
        conversationId: "c7",
        body: "Can I schedule a showing this week?",
        metadata: {},
        platformAccountId: "p7",
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
        enabled: false,
        actionConfig: { template: "tour_invite_v1" }
      }
    },
    templatesByName: {
      tour_invite_v1: {
        id: "t1",
        body: "Tours for {{unit_number}}: {{slot_options}}"
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

  assert.equal(result.repliesCreated, 1);
  assert.equal(result.metrics.sends.sent, 0);
  assert.equal(result.metrics.sends.drafted, 1);
  assert.equal(fixture.outbound[0].metadata.reviewStatus, "draft");
  assert.equal(fixture.processed[0].metadataPatch.replyDecisionReason, "policy_draft_required");
  assert.equal(fixture.processed[0].metadataPatch.outcome, "draft");
});

test("non-tour intent escalates with explicit reason code", async () => {
  const fixture = createMemoryAdapter({
    pendingMessages: [
      {
        id: "m8",
        conversationId: "c8",
        body: "What is the monthly rent for this unit?",
        metadata: {},
        platformAccountId: "p8",
        assignedAgentId: "a1",
        leadName: "Jamie",
        unitId: "u1",
        propertyName: "Atlas Apartments",
        unitNumber: "4B",
        hasRecentOutbound: false
      }
    ],
    ruleByIntent: {
      pricing_question: {
        id: "r1",
        enabled: true,
        actionConfig: { template: "pricing_v1" }
      }
    },
    templatesByName: {
      pricing_v1: {
        id: "t1",
        body: "Rent details"
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

  assert.equal(result.repliesCreated, 0);
  assert.equal(result.metrics.escalations.raised, 1);
  assert.equal(fixture.processed[0].metadataPatch.outcome, "escalate");
  assert.equal(fixture.processed[0].metadataPatch.replyDecisionReason, "escalate_non_tour_intent");
});
