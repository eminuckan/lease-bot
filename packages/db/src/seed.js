import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "./client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const seedFile = path.resolve(__dirname, "../seeds/001_basic_seed.sql");

async function run() {
  const client = createClient();
  await client.connect();

  try {
    const sql = await readFile(seedFile, "utf8");
    await client.query(sql);
    console.log("seed complete");
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error("seed failed");
  console.error(error.message);
  process.exitCode = 1;
});
