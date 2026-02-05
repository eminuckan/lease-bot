import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "./client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, "../migrations");

function checksum(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getExecutedMap(client) {
  const result = await client.query("SELECT name, checksum FROM schema_migrations");
  return new Map(result.rows.map((row) => [row.name, row.checksum]));
}

async function run() {
  const client = createClient();
  await client.connect();

  try {
    await ensureMigrationsTable(client);

    const entries = await readdir(migrationsDir, { withFileTypes: true });
    const migrationFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => entry.name)
      .sort();

    const executed = await getExecutedMap(client);

    for (const fileName of migrationFiles) {
      const fullPath = path.join(migrationsDir, fileName);
      const sql = await readFile(fullPath, "utf8");
      const digest = checksum(sql);

      if (executed.has(fileName)) {
        if (executed.get(fileName) !== digest) {
          throw new Error(`Migration checksum mismatch for ${fileName}`);
        }
        console.log(`skip ${fileName}`);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [fileName, digest]
        );
        await client.query("COMMIT");
        console.log(`applied ${fileName}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    console.log("migration complete");
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error("migration failed");
  console.error(error.message);
  process.exitCode = 1;
});
