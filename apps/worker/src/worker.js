import { fileURLToPath } from "node:url";

import { createClient } from "../../../packages/db/src/index.js";
import { createPostgresQueueAdapter } from "../../../packages/integrations/src/index.js";

import { processPendingMessagesWithAi } from "./decision-pipeline.js";

const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS || 15000);
const queueBatchSize = Number(process.env.WORKER_QUEUE_BATCH_SIZE || 20);
const task = process.env.WORKER_TASK || "ai-triage-reply";
const runOnce = process.env.WORKER_RUN_ONCE === "1";

export async function runWorkerCycle(client, logger = console) {
  const adapter = createPostgresQueueAdapter(client);
  const startedAt = Date.now();
  const result = await processPendingMessages({
    adapter,
    logger,
    limit: queueBatchSize,
    now: new Date()
  });

  logger.log("[worker] cycle complete", {
    scanned: result.scanned,
    repliesCreated: result.repliesCreated,
    durationMs: Date.now() - startedAt
  });

  return result;
}

export async function processPendingMessages(params) {
  return processPendingMessagesWithAi(params);
}

export async function startWorker() {
  const client = createClient();
  await client.connect();

  console.log(`worker started (${task}) interval=${pollIntervalMs}ms batch=${queueBatchSize}`);

  let shuttingDown = false;
  let running = false;

  const executeCycle = async () => {
    if (running || shuttingDown) {
      return;
    }
    running = true;
    try {
      await runWorkerCycle(client, console);
    } catch (error) {
      console.error("[worker] cycle failed", error);
    } finally {
      running = false;
    }
  };

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log("[worker] shutting down");
    await client.end();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await executeCycle();
  if (runOnce) {
    await shutdown();
    return;
  }

  setInterval(executeCycle, pollIntervalMs);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  startWorker().catch((error) => {
    console.error("[worker] fatal startup error", error);
    process.exitCode = 1;
  });
}
