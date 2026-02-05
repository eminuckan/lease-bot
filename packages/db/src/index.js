import { createClient, getDatabaseUrl } from "./client.js";

export function getDbConfig() {
  return {
    url: process.env.DATABASE_URL || ""
  };
}

export { createClient, getDatabaseUrl };
