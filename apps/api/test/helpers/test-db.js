import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/migrations", import.meta.url));

function checksum(content) {
  return createHash("sha256").update(content).digest("hex");
}

function parseDatabaseName(connectionString) {
  const url = new URL(connectionString);
  const name = url.pathname.replace(/^\//, "");
  if (!name) {
    throw new Error("DATABASE_URL must include a database name");
  }
  if (!/^[a-z0-9_]+$/i.test(name)) {
    throw new Error(`Unsupported database name '${name}' (only alnum + underscore allowed)`);
  }
  return { url, name };
}

async function ensureDatabaseExists(connectionString) {
  const { url, name } = parseDatabaseName(connectionString);
  const adminUrl = new URL(url.toString());
  adminUrl.pathname = "/postgres";

  const pool = new Pool({ connectionString: adminUrl.toString() });
  try {
    const existing = await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (existing.rowCount > 0) {
      return;
    }

    try {
      await pool.query(`CREATE DATABASE "${name}"`);
    } catch (error) {
      // Parallel test files may race to create the same DB.
      if (error?.code !== "42P04") {
        throw error;
      }
    }
  } finally {
    await pool.end();
  }
}

async function ensureMigrationsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getExecutedMap(pool) {
  const result = await pool.query("SELECT name, checksum FROM schema_migrations");
  return new Map(result.rows.map((row) => [row.name, row.checksum]));
}

async function runMigrations(pool) {
  // Node's test runner may execute test files concurrently. Serialize migrations per DB to avoid
  // DDL races (e.g. CREATE TYPE) when multiple test processes start at the same time.
  // Advisory locks are connection-scoped and automatically released if the process dies.
  const migrationLockKey = 915_000_123; // arbitrary constant for this repo
  await pool.query("SELECT pg_advisory_lock($1)", [migrationLockKey]);
  try {
  await ensureMigrationsTable(pool);
  const executed = await getExecutedMap(pool);

  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const migrationFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  for (const fileName of migrationFiles) {
    const fullPath = path.join(migrationsDir, fileName);
    const sql = await readFile(fullPath, "utf8");
    const digest = checksum(sql);

    if (executed.has(fileName)) {
      if (executed.get(fileName) !== digest) {
        throw new Error(`Migration checksum mismatch for ${fileName}`);
      }
      continue;
    }

    // Some migrations include their own BEGIN/COMMIT blocks; let them manage transactions.
    await pool.query(sql);
    await pool.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [fileName, digest]);
    executed.set(fileName, digest);
  }
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [migrationLockKey]);
  }
}

export async function createTestPool(connectionString) {
  await ensureDatabaseExists(connectionString);
  const pool = new Pool({ connectionString });
  await runMigrations(pool);
  return pool;
}
