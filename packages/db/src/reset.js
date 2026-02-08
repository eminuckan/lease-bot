import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createClient } from "./client.js";

function runNodeScript(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: "inherit",
      env: process.env
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Script failed (${scriptPath}) with exit code ${code}`));
    });
  });
}

async function run() {
  const client = createClient();
  await client.connect();

  try {
    await client.query("BEGIN");
    try {
      await client.query("DROP SCHEMA IF EXISTS public CASCADE;");
      await client.query("CREATE SCHEMA public;");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
  }

  const migratePath = fileURLToPath(new URL("./migrate.js", import.meta.url));
  await runNodeScript(migratePath);
}

run().catch((error) => {
  console.error("db reset failed");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

