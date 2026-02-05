import { Client } from "pg";

export function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return databaseUrl;
}

export function createClient() {
  return new Client({
    connectionString: getDatabaseUrl()
  });
}
