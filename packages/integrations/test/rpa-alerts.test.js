import assert from "node:assert/strict";
import test from "node:test";

import { createRpaAlertDispatcher } from "../src/rpa-alerts.js";

test("rpa alerts: disabled dispatcher does not send", async () => {
  const calls = [];
  const dispatcher = createRpaAlertDispatcher({
    env: {
      LEASE_BOT_RPA_ALERTS_ENABLED: "0",
      LEASE_BOT_RPA_ALERTS_PROVIDER: "telegram",
      LEASE_BOT_RPA_ALERT_TELEGRAM_BOT_TOKEN: "token",
      LEASE_BOT_RPA_ALERT_TELEGRAM_CHAT_ID: "chat"
    },
    fetchImpl: async (...args) => {
      calls.push(args);
      return { ok: true, text: async () => "" };
    }
  });

  const result = await dispatcher.dispatchEvent({
    type: "rpa_session_refresh_requested",
    platform: "spareroom",
    accountId: "acc-1",
    action: "ingest"
  });

  assert.equal(result.sent, false);
  assert.equal(result.reason, "disabled");
  assert.equal(calls.length, 0);
});

test("rpa alerts: telegram send works and cooldown blocks duplicates", async () => {
  const calls = [];
  let now = 1_000_000;
  const dispatcher = createRpaAlertDispatcher({
    env: {
      LEASE_BOT_RPA_ALERTS_ENABLED: "1",
      LEASE_BOT_RPA_ALERTS_PROVIDER: "telegram",
      LEASE_BOT_RPA_ALERT_EVENT_TYPES: "rpa_session_refresh_requested",
      LEASE_BOT_RPA_ALERT_COOLDOWN_MS: "60000",
      LEASE_BOT_RPA_ALERT_TELEGRAM_BOT_TOKEN: "token",
      LEASE_BOT_RPA_ALERT_TELEGRAM_CHAT_ID: "chat"
    },
    nowMs: () => now,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, text: async () => "" };
    }
  });

  const event = {
    type: "rpa_session_refresh_requested",
    platform: "spareroom",
    accountId: "acc-1",
    action: "ingest",
    reason: "session_expired"
  };

  const first = await dispatcher.dispatchEvent(event);
  assert.equal(first.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.telegram.org/bottoken/sendMessage");

  const second = await dispatcher.dispatchEvent(event);
  assert.equal(second.sent, false);
  assert.equal(second.reason, "cooldown");
  assert.equal(calls.length, 1);

  now += 61_000;
  const third = await dispatcher.dispatchEvent(event);
  assert.equal(third.sent, true);
  assert.equal(calls.length, 2);
});

test("rpa alerts: non-matching event is filtered", async () => {
  const calls = [];
  const dispatcher = createRpaAlertDispatcher({
    env: {
      LEASE_BOT_RPA_ALERTS_ENABLED: "1",
      LEASE_BOT_RPA_ALERTS_PROVIDER: "telegram",
      LEASE_BOT_RPA_ALERT_EVENT_TYPES: "rpa_circuit_opened",
      LEASE_BOT_RPA_ALERT_TELEGRAM_BOT_TOKEN: "token",
      LEASE_BOT_RPA_ALERT_TELEGRAM_CHAT_ID: "chat"
    },
    fetchImpl: async (...args) => {
      calls.push(args);
      return { ok: true, text: async () => "" };
    }
  });

  const result = await dispatcher.dispatchEvent({
    type: "rpa_session_refresh_requested",
    platform: "spareroom",
    accountId: "acc-1",
    action: "ingest"
  });

  assert.equal(result.sent, false);
  assert.equal(result.reason, "event_filtered");
  assert.equal(calls.length, 0);
});
