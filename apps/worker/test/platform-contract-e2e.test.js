import assert from "node:assert/strict";
import test from "node:test";

import { createConnectorRegistry } from "../../../packages/integrations/src/index.js";

const REQUIRED_PLATFORMS = ["spareroom", "roomies", "leasebreak", "renthop", "furnishedfinder"];

test("R13 e2e: connector registry supports ingest+outbound contracts for all required RPA platforms", async (t) => {
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
    rpaRunner: {
      async run(payload) {
        rpaCalls.push(payload);
        if (payload.action === "ingest") {
          return {
            messages: [
              {
                threadId: `${payload.platform}-thread-1`,
                messageId: `${payload.platform}-message-1`,
                body: `Inbound on ${payload.platform}`
              }
            ]
          };
        }

        return {
          externalMessageId: `${payload.platform}-outbound-1`,
          status: "queued",
          channel: "in_app"
        };
      }
    }
  });

  const platformAccounts = [
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

  assert.deepEqual(registry.supportedPlatforms.sort(), [...REQUIRED_PLATFORMS].sort());

  for (const account of platformAccounts) {
    await t.test(`${account.platform} ingest+outbound contract`, async () => {
      const ingested = await registry.ingestMessagesForAccount(account);
      const sent = await registry.sendMessageForAccount({
        account,
        outbound: {
          externalThreadId: `${account.platform}-thread-1`,
          body: "Tour slots available"
        }
      });

      assert.equal(ingested.length, 1);
      assert.equal(ingested[0].externalThreadId, `${account.platform}-thread-1`);
      assert.equal(ingested[0].externalMessageId, `${account.platform}-message-1`);
      assert.deepEqual(sent, {
        externalMessageId: `${account.platform}-outbound-1`,
        channel: "in_app",
        providerStatus: "queued"
      });
    });
  }

  const ingestCalls = rpaCalls.filter((call) => call.action === "ingest");
  const sendCalls = rpaCalls.filter((call) => call.action === "send");
  assert.equal(ingestCalls.length, 5);
  assert.equal(sendCalls.length, 5);
  assert.deepEqual(
    ingestCalls.map((call) => call.platform).sort(),
    [...REQUIRED_PLATFORMS].sort()
  );
  assert.deepEqual(
    sendCalls.map((call) => call.platform).sort(),
    [...REQUIRED_PLATFORMS].sort()
  );
});
