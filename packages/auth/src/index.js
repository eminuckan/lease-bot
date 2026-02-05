import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { admin as adminPlugin } from "better-auth/plugins";

const ROLE_ADMIN = "admin";
const ROLE_AGENT = "agent";
const ALLOWED_ROLES = new Set([ROLE_ADMIN, ROLE_AGENT]);

let pool;
let auth;

function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for auth");
  }
  return databaseUrl;
}

function getApiBaseUrl() {
  const configured = process.env.API_BASE_URL || process.env.BETTER_AUTH_URL;
  if (configured) {
    return configured;
  }

  const port = process.env.API_PORT || "3001";
  return `http://localhost:${port}`;
}

function getTrustedOrigins() {
  const raw = process.env.BETTER_AUTH_TRUSTED_ORIGINS || process.env.WEB_BASE_URL || "http://localhost:5173";
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: getDatabaseUrl()
    });
  }
  return pool;
}

export function normalizeRole(role) {
  if (typeof role !== "string") {
    return ROLE_AGENT;
  }

  const normalized = role.toLowerCase();
  return ALLOWED_ROLES.has(normalized) ? normalized : ROLE_AGENT;
}

export function hasAnyRole(currentRole, allowedRoles) {
  const role = normalizeRole(currentRole);
  return allowedRoles.some((candidate) => normalizeRole(candidate) === role);
}

export function getAuth() {
  if (!auth) {
    const secret = process.env.BETTER_AUTH_SECRET;
    if (!secret || secret === "change-me") {
      throw new Error("BETTER_AUTH_SECRET must be set to a non-default value");
    }

    auth = betterAuth({
      database: getPool(),
      secret,
      baseURL: getApiBaseUrl(),
      basePath: "/api/auth",
      trustedOrigins: getTrustedOrigins(),
      emailAndPassword: {
        enabled: true
      },
      plugins: [
        adminPlugin({
          defaultRole: ROLE_AGENT,
          adminRoles: [ROLE_ADMIN]
        })
      ]
    });
  }

  return auth;
}

export const roles = {
  admin: ROLE_ADMIN,
  agent: ROLE_AGENT
};
