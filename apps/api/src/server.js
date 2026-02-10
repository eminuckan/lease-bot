import http from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { toNodeHandler } from "better-auth/node";
import { Pool } from "pg";
import nodemailer from "nodemailer";

import { getAuth, hasAnyRole, normalizeRole, roles } from "@lease-bot/auth";
import {
  createConnectorRegistry,
  createPostgresQueueAdapter,
  createRpaAlertDispatcher
} from "../../../packages/integrations/src/index.js";
import { ensureDevTestData } from "../../../packages/integrations/src/bootstrap-dev-test-data.js";
import { ensureRequiredPlatformAccounts } from "../../../packages/integrations/src/bootstrap-platform-accounts.js";
import { LocalTimeValidationError, formatInTimezone, zonedTimeToUtc } from "./availability-timezone.js";
import { ensureDevAdminUser } from "./bootstrap-dev-admin.js";
import {
  extractVariablesFromBody,
  normalizeMessageStatus,
  parseTemplateVariables,
  renderTemplate
} from "./inbox-utils.js";
import { fetchObservabilitySnapshot, parsePositiveInt } from "./observability.js";

const host = process.env.API_HOST || "0.0.0.0";
const port = Number(process.env.API_PORT || 3001);
const auth = getAuth();
const authHandler = toNodeHandler(auth);
const databaseUrl = process.env.DATABASE_URL;
let routeTestOverrides = null;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for API routes");
}

const pool = new Pool({ connectionString: databaseUrl });
const rpaAlertDispatcher = createRpaAlertDispatcher({
  env: process.env,
  logger: console,
  source: "api"
});

const connectorRegistry = createConnectorRegistry({
  observabilityHook(event) {
    rpaAlertDispatcher.handleEvent(event);
  }
});

const allowedOrigins = new Set(
  (process.env.BETTER_AUTH_TRUSTED_ORIGINS || process.env.WEB_BASE_URL || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

const requiredPlatforms = ["spareroom", "roomies", "leasebreak", "renthop", "furnishedfinder"];
const requiredPlatformSet = new Set(requiredPlatforms);
const allowedSendModes = new Set(["auto_send", "draft_only"]);
const allowedIntegrationModes = new Set(["rpa"]);
const inviteRoles = new Set([roles.admin, roles.agent]);
const allowPublicSignup = process.env.LEASE_BOT_ALLOW_PUBLIC_SIGNUP === "1";
const inviteEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let inviteMailer = null;
// Platform account credentials must be env:/secret: references (never plaintext).
// Authentication can be provided either via loginId+password (username/email) or a captured storageState / persistent profile.
const platformCredentialAllowedKeys = new Set([
  "loginId",
  "loginIdRef",
  "username",
  "usernameRef",
  "email",
  "emailRef",
  "password",
  "passwordRef",
  "sessionRef",
  "storageStateRef",
  "storageStatePathRef",
  "userDataDir",
  "userDataDirRef"
]);
const globalDefaultSendMode = allowedSendModes.has(process.env.PLATFORM_DEFAULT_SEND_MODE)
  ? process.env.PLATFORM_DEFAULT_SEND_MODE
  : "draft_only";

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-credentials", "true");
  }

  res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,authorization");
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function buildHeaders(nodeHeaders) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(nodeHeaders)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item) {
          headers.append(name, item);
        }
      }
      continue;
    }

    if (value) {
      headers.append(name, value);
    }
  }

  return headers;
}

async function getSession(req) {
  return auth.api.getSession({
    headers: buildHeaders(req.headers)
  });
}

async function requireRole(req, res, permittedRoles) {
  const session = routeTestOverrides?.getSession
    ? await routeTestOverrides.getSession(req)
    : await getSession(req);

  if (!session?.user) {
    json(res, 401, {
      error: "unauthorized"
    });
    return null;
  }

  const role = normalizeRole(session.user.role);
  if (!hasAnyRole(role, permittedRoles)) {
    json(res, 403, {
      error: "forbidden",
      requiredRoles: permittedRoles,
      currentRole: role
    });
    return null;
  }

  return {
    role,
    session
  };
}

function notFound(res) {
  json(res, 404, { error: "not_found" });
}

function enforceAgentSelfScope(res, access, requestedAgentId) {
  if (access.role !== roles.agent) {
    return requestedAgentId || null;
  }

  const sessionAgentId = access.session?.user?.id;
  if (!isUuid(sessionAgentId)) {
    json(res, 403, {
      error: "forbidden",
      message: "agent session is missing a valid agent id"
    });
    return null;
  }

  if (requestedAgentId && requestedAgentId !== sessionAgentId) {
    json(res, 403, {
      error: "forbidden",
      message: "agents may only access their own showing appointments"
    });
    return null;
  }

  return sessionAgentId;
}

function isConversationInAgentScope(conversation, agentId) {
  if (!conversation || !agentId) {
    return false;
  }

  return conversation.assignedAgentId === agentId || conversation.followUpOwnerAgentId === agentId;
}

function badRequest(res, message, details = null) {
  json(res, 400, {
    error: "validation_error",
    message,
    details
  });
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isTimeString(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function assertTimezone(timezone) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function getWeekdayInTimezone(dateString, timezone) {
  const instant = zonedTimeToUtc(dateString, "12:00", timezone);
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(instant)
    .replace("Sun", "0")
    .replace("Mon", "1")
    .replace("Tue", "2")
    .replace("Wed", "3")
    .replace("Thu", "4")
    .replace("Fri", "5")
    .replace("Sat", "6"));
}

function nextDateByWeekday(startDate, dayOfWeek, timezone) {
  let cursor = startDate;
  for (let index = 0; index < 7; index += 1) {
    if (getWeekdayInTimezone(cursor, timezone) === dayOfWeek) {
      return cursor;
    }
    const next = new Date(`${cursor}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = next.toISOString().slice(0, 10);
  }
  return startDate;
}

function addDays(dateString, count) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function parseRuleIdFromNotes(notes) {
  if (typeof notes !== "string") {
    return null;
  }
  const matched = notes.match(/^rule:([0-9a-f\-]+)/i);
  return matched ? matched[1] : null;
}

function splitLocalDateTime(value) {
  if (typeof value !== "string") {
    return null;
  }
  const matched = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!matched) {
    return null;
  }
  return {
    date: matched[1],
    time: matched[2]
  };
}

function isObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function parsePlatformPolicyPayload(payload, { partial = false } = {}) {
  const errors = [];
  const updates = {};

  if (!partial || payload.isActive !== undefined) {
    if (typeof payload.isActive !== "boolean") {
      errors.push("isActive must be a boolean");
    } else {
      updates.isActive = payload.isActive;
    }
  }

  if (!partial || payload.sendMode !== undefined) {
    if (payload.sendMode !== null && !allowedSendModes.has(payload.sendMode)) {
      errors.push("sendMode must be auto_send, draft_only, or null");
    } else {
      updates.sendMode = payload.sendMode;
    }
  }

  if (!partial || payload.integrationMode !== undefined) {
    if (!allowedIntegrationModes.has(payload.integrationMode)) {
      errors.push("integrationMode must be rpa");
    } else {
      updates.integrationMode = payload.integrationMode;
    }
  }

  if (!partial || payload.credentials !== undefined) {
    if (!isObject(payload.credentials)) {
      errors.push("credentials must be an object");
    } else {
      for (const [key, value] of Object.entries(payload.credentials)) {
        if (typeof value !== "string" || !/^(env|secret):/.test(value)) {
          errors.push(`credentials.${key} must reference env: or secret:`);
        }
      }
      if (errors.length === 0) {
        updates.credentials = payload.credentials;
      }
    }
  }

  return {
    errors,
    updates
  };
}

function normalizeInviteEmail(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function normalizeInviteNamePart(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().replace(/\s+/g, " ");
}

function buildDisplayName(firstName, lastName) {
  return `${firstName} ${lastName}`.trim();
}

function splitDisplayName(name) {
  if (typeof name !== "string") {
    return {
      firstName: "",
      lastName: ""
    };
  }

  const normalized = name.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return {
      firstName: "",
      lastName: ""
    };
  }

  const parts = normalized.split(" ");
  if (parts.length === 1) {
    return {
      firstName: parts[0],
      lastName: ""
    };
  }

  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1]
  };
}

function resolveInviteTtlHours(env = process.env) {
  const parsed = Number(env.INVITE_TOKEN_TTL_HOURS || 72);
  if (!Number.isFinite(parsed)) {
    return 72;
  }
  return Math.max(1, Math.min(240, Math.floor(parsed)));
}

function createInviteToken() {
  return randomBytes(32).toString("base64url");
}

function hashInviteToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function resolveInviteBaseUrl(env = process.env) {
  return env.INVITE_BASE_URL || env.WEB_BASE_URL || "http://localhost:5173";
}

function buildInviteUrl(token, env = process.env) {
  const invitePath = env.INVITE_ACCEPT_PATH || "/invite";
  const inviteUrl = new URL(invitePath, resolveInviteBaseUrl(env));
  inviteUrl.searchParams.set("token", token);
  return inviteUrl.toString();
}

function buildInviteEmailContent({ firstName, inviterName, inviteUrl, expiresAt }) {
  const safeFirstName = firstName || "there";
  const displayExpiresAt = new Date(expiresAt).toUTCString();
  const subject = "You are invited to Lease Bot";
  const text = [
    `Hi ${safeFirstName},`,
    "",
    `${inviterName || "An admin"} invited you to Lease Bot.`,
    "Use the secure link below to set your password and activate your account:",
    inviteUrl,
    "",
    `This link expires on ${displayExpiresAt}.`,
    "If you did not expect this invite, you can ignore this email."
  ].join("\n");

  return { subject, text };
}

async function sendInvitationEmail({ to, firstName, inviterName, inviteUrl, expiresAt }) {
  if (typeof routeTestOverrides?.sendInvitationEmail === "function") {
    return routeTestOverrides.sendInvitationEmail({ to, firstName, inviterName, inviteUrl, expiresAt });
  }

  const smtpUrl = process.env.INVITE_SMTP_URL || process.env.SMTP_URL || "";
  const smtpHost = process.env.INVITE_SMTP_HOST || process.env.SMTP_HOST || "";
  const smtpPort = Number(process.env.INVITE_SMTP_PORT || process.env.SMTP_PORT || 587);
  const smtpUser = process.env.INVITE_SMTP_USER || process.env.SMTP_USER || "";
  const smtpPassword = process.env.INVITE_SMTP_PASSWORD || process.env.SMTP_PASSWORD || "";
  const from = process.env.INVITE_FROM_EMAIL || process.env.SMTP_FROM || "Lease Bot <no-reply@leasebot.local>";

  if (!smtpUrl && !smtpHost) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Invitation email delivery is not configured (SMTP)");
    }

    console.warn("[invite] smtp_not_configured", { to, inviteUrl });
    return {
      delivery: "logged",
      messageId: null,
      previewUrl: inviteUrl
    };
  }

  if (!inviteMailer) {
    if (smtpUrl) {
      inviteMailer = nodemailer.createTransport(smtpUrl);
    } else {
      inviteMailer = nodemailer.createTransport({
        host: smtpHost,
        port: Number.isFinite(smtpPort) ? smtpPort : 587,
        secure: Number(smtpPort) === 465,
        auth: smtpUser || smtpPassword
          ? {
              user: smtpUser,
              pass: smtpPassword
            }
          : undefined
      });
    }
  }

  const { subject, text } = buildInviteEmailContent({ firstName, inviterName, inviteUrl, expiresAt });
  const info = await inviteMailer.sendMail({
    from,
    to,
    subject,
    text
  });

  return {
    delivery: "email",
    messageId: info?.messageId || null,
    previewUrl: null
  };
}

function toInvitationDto(row) {
  const expiresAtMs = Date.parse(row.expires_at);
  const isExpired = Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
  let status = "pending";
  if (row.revoked_at) {
    status = "revoked";
  } else if (row.accepted_at) {
    status = "accepted";
  } else if (isExpired) {
    status = "expired";
  }

  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    role: normalizeRole(row.role),
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status
  };
}

function validateInvitationCreatePayload(payload) {
  const email = normalizeInviteEmail(payload?.email);
  const firstName = normalizeInviteNamePart(payload?.firstName);
  const lastName = normalizeInviteNamePart(payload?.lastName);
  const role = normalizeRole(payload?.role);
  const errors = [];

  if (!email || !inviteEmailPattern.test(email)) {
    errors.push("email must be a valid email address");
  }
  if (!firstName || firstName.length > 80) {
    errors.push("firstName is required and must be 80 characters or fewer");
  }
  if (!lastName || lastName.length > 80) {
    errors.push("lastName is required and must be 80 characters or fewer");
  }
  if (!inviteRoles.has(role)) {
    errors.push("role must be admin or agent");
  }

  return {
    errors,
    value: {
      email,
      firstName,
      lastName,
      role
    }
  };
}

function validateInvitationAcceptPayload(payload) {
  const token = typeof payload?.token === "string" ? payload.token.trim() : "";
  const password = typeof payload?.password === "string" ? payload.password : "";
  const errors = [];

  if (!token || token.length < 30) {
    errors.push("token is invalid");
  }

  if (password.length < 8) {
    errors.push("password must be at least 8 characters");
  }

  return {
    errors,
    value: {
      token,
      password
    }
  };
}

function validatePlatformCredentialPayload(platform, credentials) {
  const errors = [];

  for (const key of Object.keys(credentials || {})) {
    if (!platformCredentialAllowedKeys.has(key)) {
      errors.push(
        `credentials.${key} is not supported for ${platform}; allowed keys: ${[...platformCredentialAllowedKeys].join(", ")}`
      );
    }
  }

  const hasSession =
    Boolean(credentials?.sessionRef)
    || Boolean(credentials?.storageStateRef)
    || Boolean(credentials?.storageStatePathRef)
    || Boolean(credentials?.userDataDirRef)
    || Boolean(credentials?.userDataDir);
  const hasLoginId =
    Boolean(credentials?.loginId)
    || Boolean(credentials?.loginIdRef)
    || Boolean(credentials?.username)
    || Boolean(credentials?.usernameRef)
    || Boolean(credentials?.email)
    || Boolean(credentials?.emailRef);
  const hasPassword =
    Boolean(credentials?.password)
    || Boolean(credentials?.passwordRef);

  if (!hasSession) {
    if (!hasLoginId) {
      errors.push(`credentials.loginIdRef (or usernameRef/emailRef) is required for ${platform} (or provide credentials.sessionRef / credentials.userDataDirRef)`);
    }
    if (!hasPassword) {
      errors.push(`credentials.passwordRef is required for ${platform} (or provide credentials.sessionRef / credentials.userDataDirRef)`);
    }
  }

  return errors;
}

function toPlatformPolicyDto(row) {
  const sendModeOverride = row.send_mode;
  return {
    id: row.id,
    platform: row.platform,
    accountName: row.account_name,
    accountExternalId: row.account_external_id,
    isActive: row.is_active,
    integrationMode: row.integration_mode,
    sendMode: sendModeOverride || globalDefaultSendMode,
    sendModeOverride,
    globalDefaultSendMode,
    credentials: row.credentials || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid_json");
  }
}

function validateUnitPayload(payload, { partial = false } = {}) {
  const errors = [];

  if (!partial || payload.propertyName !== undefined) {
    if (typeof payload.propertyName !== "string" || payload.propertyName.trim().length < 2) {
      errors.push("propertyName must be at least 2 characters");
    }
  }

  if (!partial || payload.unitNumber !== undefined) {
    if (typeof payload.unitNumber !== "string" || payload.unitNumber.trim().length < 1) {
      errors.push("unitNumber is required");
    }
  }

  if (payload.bedrooms !== undefined && payload.bedrooms !== null) {
    if (!Number.isInteger(payload.bedrooms) || payload.bedrooms < 0 || payload.bedrooms > 20) {
      errors.push("bedrooms must be an integer between 0 and 20");
    }
  }

  if (payload.bathrooms !== undefined && payload.bathrooms !== null) {
    const bathrooms = Number(payload.bathrooms);
    if (!Number.isFinite(bathrooms) || bathrooms < 0 || bathrooms > 20) {
      errors.push("bathrooms must be between 0 and 20");
    }
  }

  if (payload.squareFeet !== undefined && payload.squareFeet !== null) {
    if (!Number.isInteger(payload.squareFeet) || payload.squareFeet < 0) {
      errors.push("squareFeet must be a positive integer");
    }
  }

  return errors;
}

function validateListingPayload(payload, { partial = false } = {}) {
  const errors = [];

  if (!partial || payload.unitId !== undefined) {
    if (!isUuid(payload.unitId)) {
      errors.push("unitId must be a valid UUID");
    }
  }

  if (!partial || payload.platformAccountId !== undefined) {
    if (!isUuid(payload.platformAccountId)) {
      errors.push("platformAccountId must be a valid UUID");
    }
  }

  if (!partial || payload.rentCents !== undefined) {
    if (!Number.isInteger(payload.rentCents) || payload.rentCents <= 0) {
      errors.push("rentCents must be a positive integer");
    }
  }

  if (payload.currencyCode !== undefined) {
    if (typeof payload.currencyCode !== "string" || !/^[A-Z]{3}$/.test(payload.currencyCode)) {
      errors.push("currencyCode must be an ISO-4217 code");
    }
  }

  if (payload.availableOn !== undefined && payload.availableOn !== null) {
    if (!isDateString(payload.availableOn)) {
      errors.push("availableOn must be YYYY-MM-DD");
    }
  }

  if (payload.status !== undefined) {
    const allowed = new Set(["active", "paused", "leased", "draft"]);
    if (!allowed.has(payload.status)) {
      errors.push("status must be one of active, paused, leased, draft");
    }
  }

  if (payload.metadata !== undefined && (payload.metadata === null || Array.isArray(payload.metadata) || typeof payload.metadata !== "object")) {
    errors.push("metadata must be an object");
  }

  if (payload.assignedAgentId !== undefined && payload.assignedAgentId !== null && !isUuid(payload.assignedAgentId)) {
    errors.push("assignedAgentId must be a valid UUID");
  }

  return errors;
}

function validateWeeklyRulePayload(payload) {
  const errors = [];
  const dayOfWeek = Number(payload.dayOfWeek);
  const weeks = Number(payload.weeks || 8);

  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    errors.push("dayOfWeek must be an integer from 0 to 6");
  }

  if (!isTimeString(payload.startTime) || !isTimeString(payload.endTime)) {
    errors.push("startTime and endTime must be HH:MM");
  }

  if (!payload.timezone || !assertTimezone(payload.timezone)) {
    errors.push("timezone must be a valid IANA timezone");
  }

  if (payload.fromDate && !isDateString(payload.fromDate)) {
    errors.push("fromDate must be YYYY-MM-DD");
  }

  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 26) {
    errors.push("weeks must be an integer from 1 to 26");
  }

  const start = payload.startTime;
  const end = payload.endTime;
  if (isTimeString(start) && isTimeString(end) && start >= end) {
    errors.push("endTime must be after startTime");
  }

  if (payload.listingId !== undefined && payload.listingId !== null && !isUuid(payload.listingId)) {
    errors.push("listingId must be a valid UUID");
  }

  return errors;
}

function validateDailyOverridePayload(payload) {
  const errors = [];

  if (!isDateString(payload.date)) {
    errors.push("date must be YYYY-MM-DD");
  }
  if (!isTimeString(payload.startTime) || !isTimeString(payload.endTime)) {
    errors.push("startTime and endTime must be HH:MM");
  }
  if (isTimeString(payload.startTime) && isTimeString(payload.endTime) && payload.startTime >= payload.endTime) {
    errors.push("endTime must be after startTime");
  }
  if (!payload.timezone || !assertTimezone(payload.timezone)) {
    errors.push("timezone must be a valid IANA timezone");
  }
  if (payload.listingId !== undefined && payload.listingId !== null && !isUuid(payload.listingId)) {
    errors.push("listingId must be a valid UUID");
  }

  return errors;
}

function validateUnitAgentAssignmentPayload(payload) {
  const errors = [];

  if (!isUuid(payload.agentId)) {
    errors.push("agentId must be a valid UUID");
  }

  if (payload.assignmentMode !== undefined) {
    const assignmentMode = String(payload.assignmentMode);
    if (assignmentMode !== "active" && assignmentMode !== "passive") {
      errors.push("assignmentMode must be active or passive");
    }
  }

  if (payload.priority !== undefined) {
    const priority = Number(payload.priority);
    if (!Number.isInteger(priority) || priority < 1 || priority > 1000) {
      errors.push("priority must be an integer between 1 and 1000");
    }
  }

  return errors;
}

function validateAgentWeeklyAvailabilityPayload(payload) {
  const errors = [];
  const dayOfWeek = Number(payload.dayOfWeek);
  const weeks = Number(payload.weeks || 8);

  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    errors.push("dayOfWeek must be an integer from 0 to 6");
  }

  if (!isTimeString(payload.startTime) || !isTimeString(payload.endTime)) {
    errors.push("startTime and endTime must be HH:MM");
  }

  if (isTimeString(payload.startTime) && isTimeString(payload.endTime) && payload.startTime >= payload.endTime) {
    errors.push("endTime must be after startTime");
  }

  if (!payload.timezone || !assertTimezone(payload.timezone)) {
    errors.push("timezone must be a valid IANA timezone");
  }

  if (payload.fromDate && !isDateString(payload.fromDate)) {
    errors.push("fromDate must be YYYY-MM-DD");
  }

  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 26) {
    errors.push("weeks must be an integer from 1 to 26");
  }

  if (payload.status !== undefined && payload.status !== "available" && payload.status !== "unavailable") {
    errors.push("status must be available or unavailable");
  }

  return errors;
}

function validateAgentDailyOverridePayload(payload) {
  const errors = [];

  if (!isDateString(payload.date)) {
    errors.push("date must be YYYY-MM-DD");
  }
  if (!isTimeString(payload.startTime) || !isTimeString(payload.endTime)) {
    errors.push("startTime and endTime must be HH:MM");
  }
  if (isTimeString(payload.startTime) && isTimeString(payload.endTime) && payload.startTime >= payload.endTime) {
    errors.push("endTime must be after startTime");
  }
  if (!payload.timezone || !assertTimezone(payload.timezone)) {
    errors.push("timezone must be a valid IANA timezone");
  }
  if (payload.status !== undefined && payload.status !== "available" && payload.status !== "unavailable") {
    errors.push("status must be available or unavailable");
  }

  return errors;
}

const showingAppointmentStatuses = new Set(["pending", "confirmed", "reschedule_requested", "cancelled", "completed", "no_show"]);
const conversationWorkflowStates = new Set(["lead", "showing", "follow_up_1", "follow_up_2", "outcome"]);
const conversationWorkflowOutcomes = new Set([
  "not_interested",
  "wants_reschedule",
  "no_reply",
  "showing_confirmed",
  "general_question",
  "human_required",
  "no_show",
  "completed"
]);
const followUpStages = new Set(["follow_up_1", "follow_up_2"]);
const followUpStatuses = new Set(["pending", "completed", "cancelled"]);

const workflowStateTransitionMap = {
  lead: new Set(["lead", "showing", "follow_up_1", "outcome"]),
  showing: new Set(["showing", "follow_up_1", "outcome"]),
  follow_up_1: new Set(["follow_up_1", "follow_up_2", "outcome"]),
  follow_up_2: new Set(["follow_up_2", "outcome"]),
  outcome: new Set(["outcome", "lead"])
};

const showingStateTransitionMap = {
  pending: new Set(["pending", "confirmed", "reschedule_requested", "cancelled", "no_show"]),
  confirmed: new Set(["confirmed", "reschedule_requested", "cancelled", "completed", "no_show"]),
  reschedule_requested: new Set(["reschedule_requested", "pending", "confirmed", "cancelled", "no_show"]),
  cancelled: new Set(["cancelled"]),
  completed: new Set(["completed"]),
  no_show: new Set(["no_show"])
};

function isIsoDateTime(value) {
  if (typeof value !== "string") {
    return false;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime());
}

function validateShowingBookingPayload(payload) {
  const errors = [];

  if (!isUuid(payload.platformAccountId)) {
    errors.push("platformAccountId must be a valid UUID");
  }
  if (!isUuid(payload.unitId)) {
    errors.push("unitId must be a valid UUID");
  }
  if (!isUuid(payload.agentId)) {
    errors.push("agentId must be a valid UUID");
  }
  if (payload.listingId !== undefined && payload.listingId !== null && !isUuid(payload.listingId)) {
    errors.push("listingId must be a valid UUID");
  }
  if (payload.conversationId !== undefined && payload.conversationId !== null && !isUuid(payload.conversationId)) {
    errors.push("conversationId must be a valid UUID");
  }
  if (typeof payload.idempotencyKey !== "string" || payload.idempotencyKey.trim().length < 6) {
    errors.push("idempotencyKey must be at least 6 characters");
  }
  if (!isIsoDateTime(payload.startsAt) || !isIsoDateTime(payload.endsAt)) {
    errors.push("startsAt and endsAt must be valid ISO datetime strings");
  }
  if (isIsoDateTime(payload.startsAt) && isIsoDateTime(payload.endsAt) && new Date(payload.endsAt) <= new Date(payload.startsAt)) {
    errors.push("endsAt must be after startsAt");
  }
  if (!payload.timezone || !assertTimezone(payload.timezone)) {
    errors.push("timezone must be a valid IANA timezone");
  }
  if (payload.status !== undefined && !showingAppointmentStatuses.has(payload.status)) {
    errors.push("status must be one of pending, confirmed, reschedule_requested, cancelled, completed, no_show");
  }
  if (payload.metadata !== undefined && (payload.metadata === null || Array.isArray(payload.metadata) || typeof payload.metadata !== "object")) {
    errors.push("metadata must be an object");
  }

  return errors;
}

function isAllowedTransition(map, fromState, toState) {
  if (toState === undefined || toState === null) {
    return true;
  }
  if (fromState === null || fromState === undefined) {
    return true;
  }
  const allowed = map[fromState];
  if (!allowed) {
    return false;
  }
  return allowed.has(toState);
}

function normalizeIsoDateTimeOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (!isIsoDateTime(value)) {
    return null;
  }
  return new Date(value).toISOString();
}

function doesCandidateCoverSelection(candidate, payload) {
  if (!candidate || candidate.agentId !== payload.agentId) {
    return false;
  }

  const candidateStartsAt = new Date(candidate.startsAt).toISOString();
  const candidateEndsAt = new Date(candidate.endsAt).toISOString();
  const selectedStartsAt = new Date(payload.startsAt).toISOString();
  const selectedEndsAt = new Date(payload.endsAt).toISOString();

  return candidateStartsAt <= selectedStartsAt && candidateEndsAt >= selectedEndsAt;
}

async function validateBookingSlotSelection(client, payload, fetchCandidatesRunner) {
  const date = payload.startsAt.slice(0, 10);
  const candidates = await fetchCandidatesRunner(client, payload.unitId, {
    fromDate: date,
    toDate: date,
    timezone: payload.timezone,
    includePassive: true
  });

  const hasMatchingCandidate = candidates.some((candidate) => doesCandidateCoverSelection(candidate, payload));
  return {
    ok: hasMatchingCandidate,
    alternatives: candidates
  };
}

async function fetchConversationWorkflow(client, conversationId) {
  const result = await client.query(
    `SELECT id,
            assigned_agent_id,
            workflow_state,
            workflow_outcome,
            showing_state,
            follow_up_stage,
            follow_up_due_at,
            follow_up_owner_agent_id,
            follow_up_status,
            workflow_updated_at,
            updated_at
       FROM "Conversations"
      WHERE id = $1::uuid
      LIMIT 1`,
    [conversationId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    assignedAgentId: row.assigned_agent_id,
    workflowState: row.workflow_state,
    workflowOutcome: row.workflow_outcome,
    showingState: row.showing_state,
    followUpStage: row.follow_up_stage,
    followUpDueAt: row.follow_up_due_at,
    followUpOwnerAgentId: row.follow_up_owner_agent_id,
    followUpStatus: row.follow_up_status,
    workflowUpdatedAt: row.workflow_updated_at,
    updatedAt: row.updated_at
  };
}

async function transitionConversationWorkflow(client, conversationId, payload, access) {
  const current = await fetchConversationWorkflow(client, conversationId);
  if (!current) {
    return { error: "not_found" };
  }

  if (access.role === roles.agent && !isConversationInAgentScope(current, access.session.user.id)) {
    return { error: "forbidden" };
  }

  const errors = [];
  const requestedState = payload.workflowState;
  const requestedOutcome = payload.workflowOutcome;
  const requestedShowingState = payload.showingState;
  const requestedFollowUpStage = payload.followUpStage;
  const requestedFollowUpDueAt = payload.followUpDueAt;
  const requestedFollowUpOwnerAgentId = payload.followUpOwnerAgentId;
  const requestedFollowUpStatus = payload.followUpStatus;

  if (requestedState !== undefined && !conversationWorkflowStates.has(requestedState)) {
    errors.push("workflowState must be one of lead, showing, follow_up_1, follow_up_2, outcome");
  }
  if (requestedOutcome !== undefined && requestedOutcome !== null && !conversationWorkflowOutcomes.has(requestedOutcome)) {
    errors.push("workflowOutcome must be one of not_interested, wants_reschedule, no_reply, showing_confirmed, general_question, human_required, no_show, completed");
  }
  if (requestedShowingState !== undefined && requestedShowingState !== null && !showingAppointmentStatuses.has(requestedShowingState)) {
    errors.push("showingState must be one of pending, confirmed, reschedule_requested, cancelled, completed, no_show");
  }
  if (requestedFollowUpStage !== undefined && requestedFollowUpStage !== null && !followUpStages.has(requestedFollowUpStage)) {
    errors.push("followUpStage must be one of follow_up_1, follow_up_2");
  }
  if (requestedFollowUpStatus !== undefined && !followUpStatuses.has(requestedFollowUpStatus)) {
    errors.push("followUpStatus must be one of pending, completed, cancelled");
  }
  if (requestedFollowUpOwnerAgentId !== undefined && requestedFollowUpOwnerAgentId !== null && !isUuid(requestedFollowUpOwnerAgentId)) {
    errors.push("followUpOwnerAgentId must be a UUID");
  }
  if (requestedFollowUpDueAt !== undefined && requestedFollowUpDueAt !== null && !isIsoDateTime(requestedFollowUpDueAt)) {
    errors.push("followUpDueAt must be a valid ISO datetime string");
  }
  if (errors.length > 0) {
    return { error: "validation_error", details: errors };
  }

  let nextWorkflowState = requestedState ?? current.workflowState;
  const nextWorkflowOutcome = Object.prototype.hasOwnProperty.call(payload, "workflowOutcome")
    ? requestedOutcome
    : current.workflowOutcome;
  const nextShowingState = Object.prototype.hasOwnProperty.call(payload, "showingState")
    ? requestedShowingState
    : current.showingState;
  const nextFollowUpStage = Object.prototype.hasOwnProperty.call(payload, "followUpStage")
    ? requestedFollowUpStage
    : current.followUpStage;
  const nextFollowUpDueAt = Object.prototype.hasOwnProperty.call(payload, "followUpDueAt")
    ? normalizeIsoDateTimeOrNull(requestedFollowUpDueAt)
    : current.followUpDueAt;
  const nextFollowUpOwnerAgentId = Object.prototype.hasOwnProperty.call(payload, "followUpOwnerAgentId")
    ? requestedFollowUpOwnerAgentId
    : current.followUpOwnerAgentId;
  const nextFollowUpStatus = Object.prototype.hasOwnProperty.call(payload, "followUpStatus")
    ? requestedFollowUpStatus
    : current.followUpStatus;

  if (requestedState === undefined && requestedOutcome) {
    nextWorkflowState = requestedOutcome === "showing_confirmed" ? "showing" : "outcome";
  }
  if (requestedState === undefined && requestedFollowUpStage) {
    nextWorkflowState = requestedFollowUpStage;
  }

  if (!isAllowedTransition(workflowStateTransitionMap, current.workflowState, nextWorkflowState)) {
    return {
      error: "invalid_transition",
      message: `Invalid workflowState transition from ${current.workflowState} to ${nextWorkflowState}`
    };
  }
  if (!isAllowedTransition(showingStateTransitionMap, current.showingState, nextShowingState)) {
    return {
      error: "invalid_transition",
      message: `Invalid showingState transition from ${current.showingState} to ${nextShowingState}`
    };
  }

  if (current.followUpStage === "follow_up_1" && nextFollowUpStage === null) {
    return { error: "invalid_transition", message: "followUpStage cannot transition from follow_up_1 to null" };
  }
  if (current.followUpStage === "follow_up_2" && nextFollowUpStage !== "follow_up_2" && nextWorkflowState !== "outcome") {
    return { error: "invalid_transition", message: "followUpStage cannot regress after follow_up_2" };
  }
  if (nextFollowUpStage === "follow_up_2" && current.followUpStage !== "follow_up_1" && current.followUpStage !== "follow_up_2") {
    return { error: "invalid_transition", message: "followUpStage follow_up_2 requires follow_up_1 first" };
  }
  if (nextFollowUpStage && (!nextFollowUpDueAt || !nextFollowUpOwnerAgentId)) {
    return {
      error: "validation_error",
      details: ["followUpStage requires followUpDueAt and followUpOwnerAgentId"]
    };
  }

  const updated = await client.query(
    `UPDATE "Conversations"
        SET workflow_state = $2,
            workflow_outcome = $3,
            showing_state = $4,
            follow_up_stage = $5,
            follow_up_due_at = $6::timestamptz,
            follow_up_owner_agent_id = $7::uuid,
            follow_up_status = $8,
            workflow_updated_at = NOW(),
            updated_at = NOW()
      WHERE id = $1::uuid
      RETURNING id,
                assigned_agent_id,
                workflow_state,
                workflow_outcome,
                showing_state,
                follow_up_stage,
                follow_up_due_at,
                follow_up_owner_agent_id,
                follow_up_status,
                workflow_updated_at,
                updated_at`,
    [
      conversationId,
      nextWorkflowState,
      nextWorkflowOutcome,
      nextShowingState,
      nextFollowUpStage,
      nextFollowUpDueAt,
      nextFollowUpOwnerAgentId,
      nextFollowUpStatus
    ]
  );

  await recordAuditLog(client, {
    actorType: access.role === roles.admin ? "admin" : "agent",
    actorId: access.session.user.id,
    entityType: "conversation",
    entityId: conversationId,
    action: "workflow_state_transitioned",
    details: {
      previous: {
        workflowState: current.workflowState,
        workflowOutcome: current.workflowOutcome,
        showingState: current.showingState,
        followUpStage: current.followUpStage,
        followUpDueAt: current.followUpDueAt,
        followUpOwnerAgentId: current.followUpOwnerAgentId,
        followUpStatus: current.followUpStatus
      },
      next: {
        workflowState: nextWorkflowState,
        workflowOutcome: nextWorkflowOutcome,
        showingState: nextShowingState,
        followUpStage: nextFollowUpStage,
        followUpDueAt: nextFollowUpDueAt,
        followUpOwnerAgentId: nextFollowUpOwnerAgentId,
        followUpStatus: nextFollowUpStatus
      }
    }
  });

  return {
    item: {
      id: updated.rows[0].id,
      assignedAgentId: updated.rows[0].assigned_agent_id,
      workflowState: updated.rows[0].workflow_state,
      workflowOutcome: updated.rows[0].workflow_outcome,
      showingState: updated.rows[0].showing_state,
      followUpStage: updated.rows[0].follow_up_stage,
      followUpDueAt: updated.rows[0].follow_up_due_at,
      followUpOwnerAgentId: updated.rows[0].follow_up_owner_agent_id,
      followUpStatus: updated.rows[0].follow_up_status,
      workflowUpdatedAt: updated.rows[0].workflow_updated_at,
      updatedAt: updated.rows[0].updated_at
    }
  };
}

async function withClient(task) {
  const client = await pool.connect();
  try {
    return await task(client);
  } finally {
    client.release();
  }
}

async function recordAuditLog(client, { actorType, actorId = null, entityType, entityId, action, details = {} }) {
  await client.query(
    `INSERT INTO "AuditLogs" (actor_type, actor_id, entity_type, entity_id, action, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [actorType, actorId ? String(actorId) : null, entityType, String(entityId), action, JSON.stringify(details)]
  );
}

async function fetchPlatformPolicies(client) {
  const result = await client.query(
    `SELECT id,
            platform,
            account_name,
            account_external_id,
            credentials,
            is_active,
            send_mode,
            integration_mode,
            created_at,
            updated_at
       FROM "PlatformAccounts"
      ORDER BY platform ASC, account_name ASC`
  );

  return result.rows.map((row) => toPlatformPolicyDto(row));
}

async function updatePlatformPolicy(client, id, updates) {
  const isActiveProvided = Object.prototype.hasOwnProperty.call(updates, "isActive");
  const sendModeProvided = Object.prototype.hasOwnProperty.call(updates, "sendMode");
  const integrationModeProvided = Object.prototype.hasOwnProperty.call(updates, "integrationMode");
  const credentialsProvided = Object.prototype.hasOwnProperty.call(updates, "credentials");

  const result = await client.query(
    `UPDATE "PlatformAccounts"
        SET is_active = CASE WHEN $2::boolean THEN $3::boolean ELSE is_active END,
            send_mode = CASE WHEN $4::boolean THEN $5 ELSE send_mode END,
            integration_mode = CASE WHEN $6::boolean THEN $7 ELSE integration_mode END,
            credentials = CASE WHEN $8::boolean THEN $9::jsonb ELSE credentials END,
            updated_at = NOW()
      WHERE id = $1::uuid
      RETURNING id,
                platform,
                account_name,
                account_external_id,
                credentials,
                is_active,
                send_mode,
                integration_mode,
                created_at,
                updated_at`,
    [
      id,
      isActiveProvided,
      updates.isActive ?? false,
      sendModeProvided,
      sendModeProvided ? updates.sendMode : null,
      integrationModeProvided,
      integrationModeProvided ? updates.integrationMode : null,
      credentialsProvided,
      credentialsProvided ? JSON.stringify(updates.credentials) : null
    ]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return toPlatformPolicyDto(result.rows[0]);
}

async function fetchUnits(client) {
  const result = await client.query(
    `SELECT u.id,
            u.external_id,
            u.property_name,
            u.unit_number,
            u.address_line1,
            u.city,
            u.state,
            u.postal_code,
            u.bedrooms,
            u.bathrooms,
            u.square_feet,
            u.is_active,
            u.created_at,
            u.updated_at,
            assignment.primary_assigned_agent_id,
            assignment.assignments
       FROM "Units" u
        LEFT JOIN LATERAL (
          SELECT
            (
              SELECT ua2.agent_id
                FROM "UnitAgentAssignments" ua2
               WHERE ua2.unit_id = u.id
                 AND ua2.assignment_mode = 'active'
               ORDER BY ua2.priority ASC, ua2.created_at ASC
               LIMIT 1
            ) AS primary_assigned_agent_id,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'agentId', ua.agent_id,
                  'assignmentMode', ua.assignment_mode,
                  'priority', ua.priority,
                  'createdAt', ua.created_at,
                  'updatedAt', ua.updated_at
                )
                ORDER BY ua.priority ASC, ua.created_at ASC
              ) FILTER (WHERE ua.id IS NOT NULL),
              '[]'::jsonb
            ) AS assignments
            FROM "UnitAgentAssignments" ua
           WHERE ua.unit_id = u.id
        ) assignment ON TRUE
       ORDER BY u.property_name ASC, u.unit_number ASC`
  );

  return result.rows.map((row) => ({
    id: row.id,
    externalId: row.external_id,
    propertyName: row.property_name,
    unitNumber: row.unit_number,
    addressLine1: row.address_line1,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms === null ? null : Number(row.bathrooms),
    squareFeet: row.square_feet,
    isActive: row.is_active,
    assignedAgentId: row.primary_assigned_agent_id,
    assignedAgents: Array.isArray(row.assignments) ? row.assignments : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

async function fetchListings(client, unitId = null, { onlyActivePlatform = true } = {}) {
  const result = await client.query(
    `SELECT l.id,
            l.unit_id,
            l.platform_account_id,
            pa.platform,
            l.listing_external_id,
            l.status,
            l.rent_cents,
            l.currency_code,
            l.available_on,
            l.metadata,
            pa.is_active AS platform_is_active,
            pa.send_mode AS platform_send_mode,
            pa.integration_mode AS platform_integration_mode,
            l.created_at,
            l.updated_at
        FROM "Listings" l
        JOIN "PlatformAccounts" pa ON pa.id = l.platform_account_id
       WHERE ($1::uuid IS NULL OR l.unit_id = $1::uuid)
         AND ($2::boolean = FALSE OR pa.is_active = TRUE)
       ORDER BY l.updated_at DESC`,
    [unitId, onlyActivePlatform]
  );

  return result.rows.map((row) => ({
    id: row.id,
    unitId: row.unit_id,
    platformAccountId: row.platform_account_id,
    platform: row.platform,
    listingExternalId: row.listing_external_id,
    status: row.status,
    rentCents: row.rent_cents,
    currencyCode: row.currency_code,
    availableOn: row.available_on,
    metadata: row.metadata || {},
    assignedAgentId: row.metadata?.assignedAgentId || null,
    platformPolicy: {
      isActive: row.platform_is_active,
      integrationMode: row.platform_integration_mode,
      sendMode: row.platform_send_mode || globalDefaultSendMode,
      sendModeOverride: row.platform_send_mode,
      globalDefaultSendMode
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

async function fetchAvailability(client, unitId, { fromDate, toDate, timezone }) {
  const where = ["unit_id = $1::uuid"];
  const params = [unitId];

  if (fromDate) {
    params.push(fromDate);
    where.push(`starts_at >= ($${params.length}::date)::timestamptz`);
  }
  if (toDate) {
    params.push(toDate);
    where.push(`starts_at < (($${params.length}::date + INTERVAL '1 day'))::timestamptz`);
  }

  const result = await client.query(
    `SELECT id,
            unit_id,
            listing_id,
            starts_at,
            ends_at,
            timezone,
            status,
            source,
            notes,
            created_at
       FROM "AvailabilitySlots"
      WHERE ${where.join(" AND ")}
      ORDER BY starts_at ASC`,
    params
  );

  return result.rows.map((row) => {
    const outTimezone = timezone || row.timezone;
    return {
      id: row.id,
      unitId: row.unit_id,
      listingId: row.listing_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      timezone: row.timezone,
      displayTimezone: outTimezone,
      localStart: formatInTimezone(row.starts_at, outTimezone),
      localEnd: formatInTimezone(row.ends_at, outTimezone),
      status: row.status,
      source: row.source,
      notes: row.notes,
      createdAt: row.created_at
    };
  });
}

async function upsertWeeklyRule(client, unitId, payload, existingRuleId = null) {
  const ruleId = existingRuleId || randomUUID();
  const status = payload.status || "open";
  const timezone = payload.timezone;
  const fromDate = payload.fromDate || new Date().toISOString().slice(0, 10);
  const weeks = Number(payload.weeks || 8);
  const notesSuffix = typeof payload.notes === "string" && payload.notes.trim().length > 0 ? ` | ${payload.notes.trim()}` : "";
  const source = "weekly_recurring";
  const ruleNotes = `rule:${ruleId}${notesSuffix}`;

  await client.query("BEGIN");
  try {
    await client.query(
      `DELETE FROM "AvailabilitySlots"
        WHERE unit_id = $1::uuid
          AND source = 'weekly_recurring'
          AND notes LIKE $2`,
      [unitId, `rule:${ruleId}%`]
    );

    const firstDate = nextDateByWeekday(fromDate, Number(payload.dayOfWeek), timezone);
    const inserts = [];

    for (let index = 0; index < weeks; index += 1) {
      const currentDate = addDays(firstDate, index * 7);
      const startsAt = zonedTimeToUtc(currentDate, payload.startTime, timezone);
      const endsAt = zonedTimeToUtc(currentDate, payload.endTime, timezone);

      inserts.push(
        client.query(
          `INSERT INTO "AvailabilitySlots" (
             unit_id,
             listing_id,
             starts_at,
             ends_at,
             timezone,
             status,
             source,
             notes
           ) VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8)`,
          [unitId, payload.listingId || null, startsAt.toISOString(), endsAt.toISOString(), timezone, status, source, ruleNotes]
        )
      );
    }

    await Promise.all(inserts);
    await client.query("COMMIT");

    return {
      ruleId,
      generatedSlots: inserts.length
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function fetchWeeklyRules(client, unitId) {
  const result = await client.query(
    `SELECT id, starts_at, ends_at, timezone, status, source, notes, listing_id
       FROM "AvailabilitySlots"
      WHERE unit_id = $1::uuid
        AND source = 'weekly_recurring'
      ORDER BY starts_at ASC`,
    [unitId]
  );

  const grouped = new Map();

  for (const row of result.rows) {
    const ruleId = parseRuleIdFromNotes(row.notes);
    if (!ruleId) {
      continue;
    }

    const bucket = grouped.get(ruleId) || {
      ruleId,
      timezone: row.timezone,
      status: row.status,
      listingId: row.listing_id,
      notes: row.notes,
      occurrences: []
    };

    bucket.occurrences.push({
      slotId: row.id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      localStart: formatInTimezone(row.starts_at, row.timezone),
      localEnd: formatInTimezone(row.ends_at, row.timezone)
    });

    grouped.set(ruleId, bucket);
  }

  return Array.from(grouped.values());
}

async function fetchUnitAgentAssignments(client, unitId) {
  const result = await client.query(
    `SELECT ua.unit_id,
            ua.agent_id,
            ua.assignment_mode,
            ua.priority,
            ua.created_at,
            ua.updated_at,
            a.full_name,
            a.email,
            a.timezone,
            a.role
       FROM "UnitAgentAssignments" ua
       JOIN "Agents" a ON a.id = ua.agent_id
      WHERE ua.unit_id = $1::uuid
      ORDER BY ua.priority ASC, ua.created_at ASC`,
    [unitId]
  );

  return result.rows.map((row) => ({
    unitId: row.unit_id,
    agentId: row.agent_id,
    assignmentMode: row.assignment_mode,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    agent: {
      id: row.agent_id,
      fullName: row.full_name,
      email: row.email,
      timezone: row.timezone,
      role: row.role
    }
  }));
}

async function upsertUnitAgentAssignment(client, unitId, payload) {
  const assignmentMode = payload.assignmentMode || "active";
  const priority = Number(payload.priority || 100);

  const unitCheck = await client.query(`SELECT id FROM "Units" WHERE id = $1::uuid`, [unitId]);
  if (unitCheck.rowCount === 0) {
    return { error: "unit_not_found" };
  }

  const agentCheck = await client.query(`SELECT id FROM "Agents" WHERE id = $1::uuid`, [payload.agentId]);
  if (agentCheck.rowCount === 0) {
    return { error: "agent_not_found" };
  }

  await client.query(
    `INSERT INTO "UnitAgentAssignments" (unit_id, agent_id, assignment_mode, priority)
     VALUES ($1::uuid, $2::uuid, $3, $4)
     ON CONFLICT (unit_id, agent_id)
     DO UPDATE SET
       assignment_mode = EXCLUDED.assignment_mode,
       priority = EXCLUDED.priority,
       updated_at = NOW()`,
    [unitId, payload.agentId, assignmentMode, priority]
  );

  return { ok: true };
}

async function fetchAgentAvailability(client, agentId, { fromDate, toDate, timezone }) {
  const where = ["agent_id = $1::uuid"];
  const params = [agentId];

  if (fromDate) {
    params.push(fromDate);
    where.push(`starts_at >= ($${params.length}::date)::timestamptz`);
  }
  if (toDate) {
    params.push(toDate);
    where.push(`starts_at < (($${params.length}::date + INTERVAL '1 day'))::timestamptz`);
  }

  const result = await client.query(
    `SELECT id,
            agent_id,
            starts_at,
            ends_at,
            timezone,
            status,
            source,
            notes,
            created_at
       FROM "AgentAvailabilitySlots"
      WHERE ${where.join(" AND ")}
      ORDER BY starts_at ASC`,
    params
  );

  return result.rows.map((row) => {
    const outTimezone = timezone || row.timezone;
    return {
      id: row.id,
      agentId: row.agent_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      timezone: row.timezone,
      displayTimezone: outTimezone,
      localStart: formatInTimezone(row.starts_at, outTimezone),
      localEnd: formatInTimezone(row.ends_at, outTimezone),
      status: row.status,
      source: row.source,
      notes: row.notes,
      createdAt: row.created_at
    };
  });
}

async function fetchAgentAvailabilitySlotOwner(client, slotId) {
  const result = await client.query(
    `SELECT agent_id
       FROM "AgentAvailabilitySlots"
      WHERE id = $1::uuid
      LIMIT 1`,
    [slotId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return result.rows[0].agent_id || null;
}

async function upsertAgentWeeklyRule(client, agentId, payload, existingRuleId = null) {
  const ruleId = existingRuleId || randomUUID();
  const status = payload.status || "available";
  const timezone = payload.timezone;
  const fromDate = payload.fromDate || new Date().toISOString().slice(0, 10);
  const weeks = Number(payload.weeks || 8);
  const notesSuffix = typeof payload.notes === "string" && payload.notes.trim().length > 0 ? ` | ${payload.notes.trim()}` : "";
  const source = "weekly_recurring";
  const ruleNotes = `rule:${ruleId}${notesSuffix}`;

  await client.query("BEGIN");
  try {
    await client.query(
      `DELETE FROM "AgentAvailabilitySlots"
        WHERE agent_id = $1::uuid
          AND source = 'weekly_recurring'
          AND notes LIKE $2`,
      [agentId, `rule:${ruleId}%`]
    );

    const firstDate = nextDateByWeekday(fromDate, Number(payload.dayOfWeek), timezone);
    const inserts = [];

    for (let index = 0; index < weeks; index += 1) {
      const currentDate = addDays(firstDate, index * 7);
      const startsAt = zonedTimeToUtc(currentDate, payload.startTime, timezone);
      const endsAt = zonedTimeToUtc(currentDate, payload.endTime, timezone);

      inserts.push(
        client.query(
          `INSERT INTO "AgentAvailabilitySlots" (
             agent_id,
             starts_at,
             ends_at,
             timezone,
             status,
             source,
             notes
           ) VALUES ($1::uuid, $2::timestamptz, $3::timestamptz, $4, $5, $6, $7)`,
          [agentId, startsAt.toISOString(), endsAt.toISOString(), timezone, status, source, ruleNotes]
        )
      );
    }

    await Promise.all(inserts);
    await client.query("COMMIT");

    return {
      ruleId,
      generatedSlots: inserts.length
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function fetchAgentWeeklyRules(client, agentId) {
  const result = await client.query(
    `SELECT id, starts_at, ends_at, timezone, status, source, notes
       FROM "AgentAvailabilitySlots"
      WHERE agent_id = $1::uuid
        AND source = 'weekly_recurring'
      ORDER BY starts_at ASC`,
    [agentId]
  );

  const grouped = new Map();

  for (const row of result.rows) {
    const ruleId = parseRuleIdFromNotes(row.notes);
    if (!ruleId) {
      continue;
    }

    const bucket = grouped.get(ruleId) || {
      ruleId,
      timezone: row.timezone,
      status: row.status,
      notes: row.notes,
      occurrences: []
    };

    bucket.occurrences.push({
      slotId: row.id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      localStart: formatInTimezone(row.starts_at, row.timezone),
      localEnd: formatInTimezone(row.ends_at, row.timezone)
    });

    grouped.set(ruleId, bucket);
  }

  return Array.from(grouped.values());
}

async function fetchUnitAgentSlotCandidates(client, unitId, { fromDate, toDate, timezone, includePassive }) {
  const params = [unitId];
  let assignmentModePredicate = "ua.assignment_mode = 'active'";

  if (includePassive) {
    assignmentModePredicate = "ua.assignment_mode IN ('active', 'passive')";
  }

  let fromToPredicate = "";
  if (fromDate) {
    params.push(fromDate);
    fromToPredicate += ` AND unit_slot.ends_at >= ($${params.length}::date)::timestamptz`;
    fromToPredicate += ` AND agent_slot.ends_at >= ($${params.length}::date)::timestamptz`;
  }
  if (toDate) {
    params.push(toDate);
    fromToPredicate += ` AND unit_slot.starts_at < (($${params.length}::date + INTERVAL '1 day'))::timestamptz`;
    fromToPredicate += ` AND agent_slot.starts_at < (($${params.length}::date + INTERVAL '1 day'))::timestamptz`;
  }

  const result = await client.query(
    `SELECT ua.agent_id,
            ua.assignment_mode,
            ua.priority,
            a.full_name,
            a.timezone AS agent_timezone,
            unit_slot.id AS unit_slot_id,
            unit_slot.starts_at AS unit_starts_at,
            unit_slot.ends_at AS unit_ends_at,
            unit_slot.timezone AS unit_timezone,
            agent_slot.id AS agent_slot_id,
            agent_slot.starts_at AS agent_starts_at,
            agent_slot.ends_at AS agent_ends_at,
            agent_slot.timezone AS agent_timezone_source,
            GREATEST(unit_slot.starts_at, agent_slot.starts_at) AS candidate_starts_at,
            LEAST(unit_slot.ends_at, agent_slot.ends_at) AS candidate_ends_at
       FROM "UnitAgentAssignments" ua
       JOIN "Agents" a
         ON a.id = ua.agent_id
       JOIN "AvailabilitySlots" unit_slot
         ON unit_slot.unit_id = ua.unit_id
        AND unit_slot.status = 'open'
       JOIN "AgentAvailabilitySlots" agent_slot
          ON agent_slot.agent_id = ua.agent_id
         AND agent_slot.status = 'available'
       WHERE ua.unit_id = $1::uuid
         AND ${assignmentModePredicate}
         AND tstzrange(unit_slot.starts_at, unit_slot.ends_at, '[)')
             && tstzrange(agent_slot.starts_at, agent_slot.ends_at, '[)')
          AND NOT EXISTS (
            SELECT 1
              FROM "AgentAvailabilitySlots" blocked_slot
            WHERE blocked_slot.agent_id = ua.agent_id
              AND blocked_slot.status = 'unavailable'
              AND tstzrange(blocked_slot.starts_at, blocked_slot.ends_at, '[)')
                  && tstzrange(
                    GREATEST(unit_slot.starts_at, agent_slot.starts_at),
                    LEAST(unit_slot.ends_at, agent_slot.ends_at),
                    '[)'
                  )
          )
           AND NOT EXISTS (
             SELECT 1
               FROM "ShowingAppointments" appt
              WHERE appt.agent_id = ua.agent_id
                AND appt.unit_id <> ua.unit_id
                AND appt.status IN ('pending', 'confirmed', 'reschedule_requested')
                AND tstzrange(appt.starts_at, appt.ends_at, '[)')
                    && tstzrange(
                      GREATEST(unit_slot.starts_at, agent_slot.starts_at),
                      LEAST(unit_slot.ends_at, agent_slot.ends_at),
                      '[)'
                   )
          )
          ${fromToPredicate}
        ORDER BY ua.priority ASC, candidate_starts_at ASC`,
    params
  );

  return result.rows
    .filter((row) => row.candidate_starts_at < row.candidate_ends_at)
    .map((row) => {
      const displayTimezone = timezone || row.unit_timezone || row.agent_timezone || "UTC";
      return {
        unitId,
        agentId: row.agent_id,
        assignmentMode: row.assignment_mode,
        priority: row.priority,
        agentName: row.full_name,
        agentTimezone: row.agent_timezone,
        unitSlotId: row.unit_slot_id,
        agentSlotId: row.agent_slot_id,
        startsAt: row.candidate_starts_at,
        endsAt: row.candidate_ends_at,
        displayTimezone,
        localStart: formatInTimezone(row.candidate_starts_at, displayTimezone),
        localEnd: formatInTimezone(row.candidate_ends_at, displayTimezone)
      };
    });
}

function toShowingAppointmentDto(row, displayTimezone = null) {
  const resolvedTimezone = displayTimezone || row.timezone || "UTC";
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    platformAccountId: row.platform_account_id,
    conversationId: row.conversation_id,
    unitId: row.unit_id,
    listingId: row.listing_id,
    agentId: row.agent_id,
    agentName: row.agent_name || null,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timezone: row.timezone,
    displayTimezone: resolvedTimezone,
    localStart: formatInTimezone(row.starts_at, resolvedTimezone),
    localEnd: formatInTimezone(row.ends_at, resolvedTimezone),
    status: row.status,
    source: row.source,
    externalBookingRef: row.external_booking_ref,
    notes: row.notes,
    metadata: row.metadata || {},
    unit: row.property_name && row.unit_number ? `${row.property_name} ${row.unit_number}` : null,
    conversation: {
      externalThreadId: row.external_thread_id || null,
      leadName: row.lead_name || null,
      platform: row.platform || null
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function fetchShowingAppointmentByIdempotencyKey(client, idempotencyKey) {
  const result = await client.query(
    `SELECT sa.id,
            sa.idempotency_key,
            sa.platform_account_id,
            pa.platform,
            sa.conversation_id,
            sa.unit_id,
            sa.listing_id,
            sa.agent_id,
            sa.starts_at,
            sa.ends_at,
            sa.timezone,
            sa.status,
            sa.source,
            sa.external_booking_ref,
            sa.notes,
            sa.metadata,
            sa.created_at,
            sa.updated_at,
            u.property_name,
            u.unit_number,
            a.full_name AS agent_name,
            c.external_thread_id,
            c.lead_name
       FROM "ShowingAppointments" sa
       JOIN "PlatformAccounts" pa ON pa.id = sa.platform_account_id
       JOIN "Units" u ON u.id = sa.unit_id
       JOIN "Agents" a ON a.id = sa.agent_id
  LEFT JOIN "Conversations" c ON c.id = sa.conversation_id
      WHERE sa.idempotency_key = $1
      LIMIT 1`,
    [idempotencyKey]
  );

  return result.rowCount > 0 ? result.rows[0] : null;
}

function matchesIdempotentBooking(existingRow, payload) {
  return (
    existingRow.platform_account_id === payload.platformAccountId &&
    existingRow.unit_id === payload.unitId &&
    existingRow.agent_id === payload.agentId &&
    new Date(existingRow.starts_at).toISOString() === new Date(payload.startsAt).toISOString() &&
    new Date(existingRow.ends_at).toISOString() === new Date(payload.endsAt).toISOString() &&
    (existingRow.listing_id || null) === (payload.listingId || null) &&
    (existingRow.conversation_id || null) === (payload.conversationId || null)
  );
}

async function resolveShowingBookingIdempotency(client, payload) {
  const existing = await fetchShowingAppointmentByIdempotencyKey(client, payload.idempotencyKey.trim());
  if (!existing) {
    return null;
  }

  if (!matchesIdempotentBooking(existing, payload)) {
    return {
      error: "idempotency_payload_mismatch",
      appointment: toShowingAppointmentDto(existing)
    };
  }

  return {
    appointment: toShowingAppointmentDto(existing),
    idempotentReplay: true
  };
}

async function fetchShowingAppointments(client, { agentId = null, status = null, unitId = null, fromDate = null, toDate = null, timezone = null }) {
  const where = [];
  const params = [];

  if (agentId) {
    params.push(agentId);
    where.push(`sa.agent_id = $${params.length}::uuid`);
  }
  if (status) {
    params.push(status);
    where.push(`sa.status = $${params.length}`);
  }
  if (unitId) {
    params.push(unitId);
    where.push(`sa.unit_id = $${params.length}::uuid`);
  }
  if (fromDate) {
    params.push(fromDate);
    where.push(`sa.ends_at >= ($${params.length}::date)::timestamptz`);
  }
  if (toDate) {
    params.push(toDate);
    where.push(`sa.starts_at < (($${params.length}::date + INTERVAL '1 day'))::timestamptz`);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const result = await client.query(
    `SELECT sa.id,
            sa.idempotency_key,
            sa.platform_account_id,
            sa.conversation_id,
            sa.unit_id,
            sa.listing_id,
            sa.agent_id,
            sa.starts_at,
            sa.ends_at,
            sa.timezone,
            sa.status,
            sa.source,
            sa.external_booking_ref,
            sa.notes,
            sa.metadata,
            sa.created_at,
            sa.updated_at,
            u.property_name,
            u.unit_number,
            a.full_name AS agent_name,
            c.external_thread_id,
            c.lead_name
       FROM "ShowingAppointments" sa
       JOIN "Units" u ON u.id = sa.unit_id
       JOIN "Agents" a ON a.id = sa.agent_id
  LEFT JOIN "Conversations" c ON c.id = sa.conversation_id
      ${whereClause}
      ORDER BY sa.starts_at ASC, sa.created_at ASC`,
    params
  );

  return result.rows.map((row) => toShowingAppointmentDto(row, timezone));
}

async function createShowingAppointment(client, payload) {
  const startsAtIso = new Date(payload.startsAt).toISOString();
  const endsAtIso = new Date(payload.endsAt).toISOString();

  await client.query("BEGIN");
  try {
    const existingRow = await fetchShowingAppointmentByIdempotencyKey(client, payload.idempotencyKey.trim());
    if (existingRow) {
      if (!matchesIdempotentBooking(existingRow, payload)) {
        await client.query("ROLLBACK");
        return {
          error: "idempotency_payload_mismatch",
          appointment: toShowingAppointmentDto(existingRow)
        };
      }

      await client.query("COMMIT");
      return {
        appointment: toShowingAppointmentDto(existingRow),
        idempotentReplay: true
      };
    }

    const inserted = await client.query(
      `INSERT INTO "ShowingAppointments" (
         idempotency_key,
         platform_account_id,
         conversation_id,
         unit_id,
         listing_id,
         agent_id,
         starts_at,
         ends_at,
         timezone,
         status,
         source,
         external_booking_ref,
         notes,
         metadata
       ) VALUES (
         $1,
         $2::uuid,
         $3::uuid,
         $4::uuid,
         $5::uuid,
         $6::uuid,
         $7::timestamptz,
         $8::timestamptz,
         $9,
         $10,
         $11,
         $12,
         $13,
         $14::jsonb
       )
       RETURNING id`,
      [
        payload.idempotencyKey.trim(),
        payload.platformAccountId,
        payload.conversationId || null,
        payload.unitId,
        payload.listingId || null,
        payload.agentId,
        startsAtIso,
        endsAtIso,
        payload.timezone,
        payload.status || "confirmed",
        payload.source || "lead_selection",
        payload.externalBookingRef || null,
        payload.notes || null,
        JSON.stringify(payload.metadata || {})
      ]
    );

    const byId = await client.query(
      `SELECT sa.id,
              sa.idempotency_key,
              sa.platform_account_id,
              sa.conversation_id,
              sa.unit_id,
              sa.listing_id,
              sa.agent_id,
              sa.starts_at,
              sa.ends_at,
              sa.timezone,
              sa.status,
              sa.source,
              sa.external_booking_ref,
              sa.notes,
              sa.metadata,
              sa.created_at,
              sa.updated_at,
              u.property_name,
              u.unit_number,
              a.full_name AS agent_name,
              c.external_thread_id,
              c.lead_name
         FROM "ShowingAppointments" sa
         JOIN "Units" u ON u.id = sa.unit_id
         JOIN "Agents" a ON a.id = sa.agent_id
    LEFT JOIN "Conversations" c ON c.id = sa.conversation_id
        WHERE sa.id = $1::uuid
        LIMIT 1`,
      [inserted.rows[0].id]
    );

    await client.query("COMMIT");
    return {
      appointment: toShowingAppointmentDto(byId.rows[0]),
      idempotentReplay: false
    };
  } catch (error) {
    await client.query("ROLLBACK");

    if (error?.code === "23505") {
      const replay = await fetchShowingAppointmentByIdempotencyKey(client, payload.idempotencyKey.trim());
      if (replay && matchesIdempotentBooking(replay, payload)) {
        return {
          appointment: toShowingAppointmentDto(replay),
          idempotentReplay: true
        };
      }
    }

    throw error;
  }
}

function handleLocalTimeValidationError(res, error) {
  if (!(error instanceof LocalTimeValidationError)) {
    return false;
  }

  badRequest(res, "Invalid local time for timezone transition", [
    `${error.details.date} ${error.details.time} is not a valid local time in ${error.details.timezone}`
  ]);
  return true;
}

function handleAvailabilityConflictError(res, error, message) {
  if (error?.code !== "23P01") {
    return false;
  }

  badRequest(res, message, ["Requested availability overlaps an existing available slot"]);
  return true;
}

function handleShowingConflictError(error) {
  return error?.code === "23P01";
}

function normalizeTemplateVariables(payload) {
  const explicit = parseTemplateVariables(payload.variables);
  const inferred = extractVariablesFromBody(payload.body);
  const merged = new Set([...explicit, ...inferred]);
  return Array.from(merged.values());
}

function toMessageDto(row) {
  const metadata = row.metadata || {};
  return {
    id: row.id,
    conversationId: row.conversation_id,
    externalMessageId: row.external_message_id || null,
    senderType: row.sender_type,
    senderAgentId: row.sender_agent_id,
    direction: row.direction,
    body: row.body,
    metadata,
    status: normalizeMessageStatus(row.direction, metadata),
    sentAt: row.sent_at,
    createdAt: row.created_at
  };
}

function summarizeConversationStatus(counts) {
  if (counts.draftCount > 0) {
    return "draft";
  }
  if (counts.holdCount > 0) {
    return "hold";
  }
  if (counts.newCount > 0) {
    return "new";
  }
  return "sent";
}

async function fetchAutoSendRule(client, platformAccountId) {
  const result = await client.query(
    `SELECT id, platform_account_id, is_enabled, action_config
       FROM "AutomationRules"
      WHERE platform_account_id = $1::uuid
        AND trigger_type = 'message_received'
        AND action_type = 'send_template'
      ORDER BY priority ASC, created_at ASC
      LIMIT 1`,
    [platformAccountId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return {
    id: result.rows[0].id,
    platformAccountId: result.rows[0].platform_account_id,
    enabled: Boolean(result.rows[0].is_enabled),
    actionConfig: result.rows[0].action_config || {}
  };
}

async function fetchPlatformSendPolicy(client, platformAccountId) {
  const result = await client.query(
    `SELECT id, platform, is_active, send_mode
       FROM "PlatformAccounts"
      WHERE id = $1::uuid
      LIMIT 1`,
    [platformAccountId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    platform: row.platform,
    isActive: Boolean(row.is_active),
    sendMode: row.send_mode || globalDefaultSendMode,
    sendModeOverride: row.send_mode
  };
}

async function fetchPlatformDispatchAccount(client, platformAccountId) {
  const result = await client.query(
    `SELECT id, platform, credentials, is_active, send_mode
       FROM "PlatformAccounts"
      WHERE id = $1::uuid
      LIMIT 1`,
    [platformAccountId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    platform: row.platform,
    credentials: row.credentials || {},
    isActive: Boolean(row.is_active),
    sendMode: row.send_mode || globalDefaultSendMode,
    sendModeOverride: row.send_mode
  };
}

function collectGuardrailReviewReasons(metadata) {
  if (!isObject(metadata)) {
    return [];
  }

  const reasons = [];
  if (metadata.requiresAdminReview === true || metadata.forceAdminReview === true) {
    reasons.push("explicit_admin_review");
  }

  if (Array.isArray(metadata.guardrails) && metadata.guardrails.length > 0) {
    reasons.push("guardrails_blocked");
  }

  const riskLevel = typeof metadata.riskLevel === "string" ? metadata.riskLevel.toLowerCase() : "";
  if (riskLevel === "high" || riskLevel === "critical") {
    reasons.push(`risk_${riskLevel}`);
  }

  const uniqueReasons = Array.from(new Set(reasons));
  return uniqueReasons;
}

async function fetchPlatformHealthSnapshot(client) {
  const result = await client.query(
    `SELECT pa.id,
            pa.platform,
            pa.account_name,
            pa.account_external_id,
            pa.is_active,
            pa.send_mode,
            pa.integration_mode,
            (
              SELECT MAX(m.sent_at)
                FROM "Messages" m
                JOIN "Conversations" c ON c.id = m.conversation_id
               WHERE c.platform_account_id = pa.id
                 AND m.direction = 'inbound'
            ) AS last_successful_ingest_at,
            (
              SELECT MAX(m.sent_at)
                FROM "Messages" m
                JOIN "Conversations" c ON c.id = m.conversation_id
               WHERE c.platform_account_id = pa.id
                 AND m.direction = 'outbound'
                 AND COALESCE(m.metadata->>'reviewStatus', 'sent') = 'sent'
            ) AS last_successful_send_at,
            (
              SELECT COUNT(*)::int
                FROM "AuditLogs" al
               WHERE al.created_at >= NOW() - INTERVAL '24 hours'
                 AND COALESCE(
                   NULLIF(al.details->>'platform', ''),
                   NULLIF(al.details#>>'{platformPolicy,platform}', ''),
                   NULLIF(al.details#>>'{delivery,platform}', ''),
                   'unknown'
                 ) = pa.platform
                  AND al.action IN ('platform_dispatch_error', 'ai_reply_error', 'api_error', 'inbox_draft_error', 'inbox_message_error')
            ) AS error_count_24h,
            (
              SELECT MAX(al.created_at)
                FROM "AuditLogs" al
               WHERE al.created_at >= NOW() - INTERVAL '24 hours'
                 AND COALESCE(
                   NULLIF(al.details->>'platform', ''),
                   NULLIF(al.details#>>'{platformPolicy,platform}', ''),
                   NULLIF(al.details#>>'{delivery,platform}', ''),
                   'unknown'
                 ) = pa.platform
                 AND al.action IN ('platform_dispatch_error', 'ai_reply_error', 'api_error', 'inbox_draft_error', 'inbox_message_error')
            ) AS last_error_at,
            (
              SELECT COALESCE(
                NULLIF(al.details->>'disableReason', ''),
                NULLIF(al.details#>>'{updates,disableReason}', ''),
                'disabled_by_admin_policy'
              )
                FROM "AuditLogs" al
               WHERE al.action = 'platform_policy_updated'
                 AND al.entity_id = pa.id::text
                 AND (
                   al.details->>'isActive' = 'false'
                   OR al.details#>>'{updates,isActive}' = 'false'
                 )
               ORDER BY al.created_at DESC
               LIMIT 1
            ) AS disable_reason
       FROM "PlatformAccounts" pa
      ORDER BY pa.platform ASC, pa.account_name ASC`
  );

  return result.rows.map((row) => {
    const isActive = Boolean(row.is_active);
    const errorCount24h = Number(row.error_count_24h || 0);
    const health = !isActive
      ? "inactive"
      : errorCount24h > 0
        ? "degraded"
        : "healthy";

    return {
      id: row.id,
      platform: row.platform,
      accountName: row.account_name,
      accountExternalId: row.account_external_id,
      isActive,
      sendMode: row.send_mode || globalDefaultSendMode,
      sendModeOverride: row.send_mode,
      integrationMode: row.integration_mode,
      globalDefaultSendMode,
      lastSuccessfulIngestAt: row.last_successful_ingest_at,
      lastSuccessfulSendAt: row.last_successful_send_at,
      errorCount24h,
      disableReason: isActive ? null : row.disable_reason || "disabled_by_admin_policy",
      health,
      error: {
        count24h: errorCount24h,
        lastErrorAt: row.last_error_at
      }
    };
  });
}

async function fetchInboxList(client, statusFilter = null, access = null, platformFilter = null) {
  const where = [];
  const params = [];

  // Default inbox view shows active conversations only.
  where.push(`c.status = 'open'`);

  if (access?.role === roles.agent) {
    const sessionAgentId = access.session?.user?.id;
    if (!isUuid(sessionAgentId)) {
      return [];
    }
    params.push(sessionAgentId);
    where.push(`(c.assigned_agent_id = $${params.length}::uuid OR c.follow_up_owner_agent_id = $${params.length}::uuid)`);
  }

  if (platformFilter) {
    params.push(platformFilter);
    where.push(`pa.platform = $${params.length}`);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const roomiesThreadGuard = `AND NOT (pa.platform = 'roomies' AND (c.external_thread_id IS NULL OR c.external_thread_id !~ '^[0-9]+$'))`;
  const orderByClause = `ORDER BY
                                effective_last_message_at DESC NULLS LAST,
                                CASE WHEN c.external_inbox_sort_rank IS NULL THEN 1 ELSE 0 END ASC,
                                c.external_inbox_sort_rank ASC NULLS LAST,
                                c.updated_at DESC NULLS LAST,
                                c.id ASC`;
  const result = await client.query(
    `SELECT c.id,
            c.platform_account_id,
            c.listing_id,
            c.assigned_agent_id,
            c.external_thread_id,
            c.lead_name,
            c.lead_contact,
            c.external_thread_label,
            c.external_thread_message_count,
            c.external_inbox_sort_rank,
            c.status AS conversation_status,
            c.workflow_state,
            c.workflow_outcome,
            c.showing_state,
            c.follow_up_stage,
            c.follow_up_due_at,
            c.follow_up_owner_agent_id,
            c.follow_up_status,
            c.workflow_updated_at,
            c.last_message_at,
            c.updated_at,
            COALESCE(
              GREATEST(c.last_message_at, latest.sent_at),
              c.last_message_at,
              latest.sent_at
            ) AS effective_last_message_at,
            pa.platform,
            u.property_name,
            u.unit_number,
            latest.body AS latest_body,
            latest.direction AS latest_direction,
            latest.sent_at AS latest_sent_at,
            latest.metadata AS latest_metadata,
            COALESCE(counts.new_count, 0) AS new_count,
            COALESCE(counts.draft_count, 0) AS draft_count,
            COALESCE(counts.hold_count, 0) AS hold_count,
            COALESCE(counts.sent_count, 0) AS sent_count
       FROM "Conversations" c
       JOIN "PlatformAccounts" pa ON pa.id = c.platform_account_id
       LEFT JOIN "Listings" l ON l.id = c.listing_id
       LEFT JOIN "Units" u ON u.id = l.unit_id
       LEFT JOIN LATERAL (
         SELECT m.body, m.direction, m.metadata, m.sent_at
           FROM "Messages" m
          WHERE m.conversation_id = c.id
          ORDER BY m.sent_at DESC, m.created_at DESC
          LIMIT 1
       ) latest ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (
                  WHERE COALESCE(m.metadata->>'reviewStatus', CASE WHEN m.direction = 'inbound' THEN 'new' ELSE 'sent' END) = 'new'
                ) AS new_count,
                COUNT(*) FILTER (
                  WHERE COALESCE(m.metadata->>'reviewStatus', CASE WHEN m.direction = 'inbound' THEN 'new' ELSE 'sent' END) = 'draft'
                ) AS draft_count,
                COUNT(*) FILTER (
                  WHERE COALESCE(m.metadata->>'reviewStatus', CASE WHEN m.direction = 'inbound' THEN 'new' ELSE 'sent' END) = 'hold'
                ) AS hold_count,
                COUNT(*) FILTER (
                  WHERE COALESCE(m.metadata->>'reviewStatus', CASE WHEN m.direction = 'inbound' THEN 'new' ELSE 'sent' END) = 'sent'
                ) AS sent_count
           FROM "Messages" m
          WHERE m.conversation_id = c.id
       ) counts ON TRUE
       ${whereClause}
       ${whereClause ? roomiesThreadGuard : `WHERE ${roomiesThreadGuard.replace(/^AND\s+/i, "")}`}
       ${orderByClause}`,
    params
  );

  const items = result.rows.map((row) => {
    const counts = {
      newCount: Number(row.new_count || 0),
      draftCount: Number(row.draft_count || 0),
      holdCount: Number(row.hold_count || 0),
      sentCount: Number(row.sent_count || 0)
    };

    return {
      id: row.id,
      platformAccountId: row.platform_account_id,
      platform: row.platform,
      listingId: row.listing_id,
      assignedAgentId: row.assigned_agent_id,
      externalThreadId: row.external_thread_id,
      leadName: row.lead_name,
      leadContact: row.lead_contact || {},
      conversationStatus: row.conversation_status,
      workflowState: row.workflow_state,
      workflowOutcome: row.workflow_outcome,
      showingState: row.showing_state,
      followUpStage: row.follow_up_stage,
      followUpDueAt: row.follow_up_due_at,
      followUpOwnerAgentId: row.follow_up_owner_agent_id,
      followUpStatus: row.follow_up_status,
      workflowUpdatedAt: row.workflow_updated_at,
      messageStatus: summarizeConversationStatus(counts),
      counts,
      unit: row.property_name && row.unit_number
        ? `${row.property_name} ${row.unit_number}`
        : row.external_thread_label || null,
      threadLabel: row.external_thread_label || null,
      threadMessageCount: row.external_thread_message_count === null || row.external_thread_message_count === undefined
        ? null
        : Number(row.external_thread_message_count),
      inboxSortRank: row.external_inbox_sort_rank === null || row.external_inbox_sort_rank === undefined
        ? null
        : Number(row.external_inbox_sort_rank),
      latestMessage: row.latest_body,
      latestDirection: row.latest_direction,
      latestStatus: normalizeMessageStatus(row.latest_direction, row.latest_metadata || {}),
      latestSentAtText: row.latest_metadata?.sentAtText || null,
      lastMessageAt: row.effective_last_message_at || row.last_message_at,
      updatedAt: row.updated_at
    };
  });

  if (!statusFilter) {
    return items;
  }
  return items.filter((item) => item.messageStatus === statusFilter);
}

async function fetchConversationDetail(client, conversationId, access = null) {
  const queryParams = [conversationId];
  const scopePredicates = ["c.id = $1::uuid"];

  if (access?.role === roles.agent) {
    const sessionAgentId = access.session?.user?.id;
    if (!isUuid(sessionAgentId)) {
      return null;
    }
    queryParams.push(sessionAgentId);
    scopePredicates.push(`(c.assigned_agent_id = $${queryParams.length}::uuid OR c.follow_up_owner_agent_id = $${queryParams.length}::uuid)`);
  }

  const conversationResult = await client.query(
    `SELECT c.id,
            c.platform_account_id,
            c.listing_id,
            c.assigned_agent_id,
            c.external_thread_id,
            c.lead_name,
            c.lead_contact,
            c.external_thread_label,
            c.external_thread_message_count,
            c.external_inbox_sort_rank,
            c.status,
            c.workflow_state,
            c.workflow_outcome,
            c.showing_state,
            c.follow_up_stage,
            c.follow_up_due_at,
            c.follow_up_owner_agent_id,
            c.follow_up_status,
            c.workflow_updated_at,
            c.last_message_at,
            c.updated_at,
            pa.platform,
            u.property_name,
            u.unit_number,
            u.id AS unit_id
       FROM "Conversations" c
       JOIN "PlatformAccounts" pa ON pa.id = c.platform_account_id
       LEFT JOIN "Listings" l ON l.id = c.listing_id
       LEFT JOIN "Units" u ON u.id = l.unit_id
       WHERE ${scopePredicates.join(" AND ")}
       LIMIT 1`,
    queryParams
  );

  if (conversationResult.rowCount === 0) {
    return null;
  }

  const conversation = conversationResult.rows[0];

  // SpareRoom inbox ingestion stores preview rows (sentAtSource=platform_inbox) and thread sync stores
  // canonical rows (sentAtSource=platform_thread). Do not blanket-drop inbox rows: keep them when they are
  // the only representation of a message, and dedupe by external_message_id preferring canonical sources.
  const spareroomMessagesSql = `WITH ranked AS (
         SELECT m.id,
                m.conversation_id,
                m.external_message_id,
                m.sender_type,
                m.sender_agent_id,
                m.direction,
                m.body,
                m.metadata,
                m.sent_at,
                m.created_at,
                COALESCE(NULLIF(m.external_message_id, ''), '__row__' || m.id::text) AS dedupe_key,
                CASE
                  WHEN COALESCE(m.metadata->>'sentAtSource', '') = 'platform_thread' THEN 0
                  WHEN COALESCE(m.metadata->>'sentAtSource', '') = 'platform_outbound_send' THEN 1
                  WHEN COALESCE(m.metadata->>'sentAtSource', '') = 'platform_inbox' THEN 2
                  ELSE 3
                END AS source_rank
           FROM "Messages" m
          WHERE m.conversation_id = $1::uuid
       ),
       deduped AS (
         SELECT *,
                ROW_NUMBER() OVER (
                  PARTITION BY dedupe_key
                  ORDER BY source_rank ASC, sent_at DESC, created_at DESC, id DESC
                ) AS rn
           FROM ranked
       )
       SELECT id,
              conversation_id,
              external_message_id,
              sender_type,
              sender_agent_id,
              direction,
              body,
              metadata,
              sent_at,
              created_at
         FROM deduped
        WHERE rn = 1
        ORDER BY sent_at ASC, created_at ASC`
  const spareroomMessagesSqlFallback = `WITH ranked AS (
         SELECT m.id,
                m.conversation_id,
                NULL::text AS external_message_id,
                m.sender_type,
                m.sender_agent_id,
                m.direction,
                m.body,
                m.metadata,
                m.sent_at,
                m.created_at,
                '__row__' || m.id::text AS dedupe_key,
                CASE
                  WHEN COALESCE(m.metadata->>'sentAtSource', '') = 'platform_thread' THEN 0
                  WHEN COALESCE(m.metadata->>'sentAtSource', '') = 'platform_outbound_send' THEN 1
                  WHEN COALESCE(m.metadata->>'sentAtSource', '') = 'platform_inbox' THEN 2
                  ELSE 3
                END AS source_rank
           FROM "Messages" m
          WHERE m.conversation_id = $1::uuid
       ),
       deduped AS (
         SELECT *,
                ROW_NUMBER() OVER (
                  PARTITION BY dedupe_key
                  ORDER BY source_rank ASC, sent_at DESC, created_at DESC, id DESC
                ) AS rn
           FROM ranked
       )
       SELECT id,
              conversation_id,
              external_message_id,
              sender_type,
              sender_agent_id,
              direction,
              body,
              metadata,
              sent_at,
              created_at
         FROM deduped
        WHERE rn = 1
        ORDER BY sent_at ASC, created_at ASC`;
  const genericMessagesSql = `WITH ranked AS (
         SELECT m.id,
                m.conversation_id,
                m.external_message_id,
                m.sender_type,
                m.sender_agent_id,
                m.direction,
                m.body,
                m.metadata,
                m.sent_at,
                m.created_at,
                COALESCE(NULLIF(m.external_message_id, ''), '__row__' || m.id::text) AS dedupe_key,
                CASE
                  WHEN COALESCE(m.metadata->>'sentAtSource', '') = 'platform_thread' THEN 0
                  WHEN COALESCE(m.metadata->>'sentAtSource', '') = 'platform_outbound_send' THEN 1
                  WHEN COALESCE(m.metadata->>'sentAtSource', '') = 'platform_inbox' THEN 2
                  ELSE 3
                END AS source_rank
           FROM "Messages" m
          WHERE m.conversation_id = $1::uuid
       ),
       deduped AS (
         SELECT *,
                ROW_NUMBER() OVER (
                  PARTITION BY dedupe_key
                  ORDER BY source_rank ASC, sent_at DESC, created_at DESC, id DESC
                ) AS rn
           FROM ranked
       )
       SELECT id,
              conversation_id,
              external_message_id,
              sender_type,
              sender_agent_id,
              direction,
              body,
              metadata,
              sent_at,
              created_at
         FROM deduped
        WHERE rn = 1
        ORDER BY sent_at ASC, created_at ASC`;
  const genericMessagesSqlFallback = `SELECT id,
              conversation_id,
              NULL::text AS external_message_id,
              sender_type,
              sender_agent_id,
              direction,
              body,
              metadata,
              sent_at,
              created_at
         FROM "Messages"
        WHERE conversation_id = $1::uuid
        ORDER BY sent_at ASC, created_at ASC`;

  const preferredMessagesSql = conversation.platform === "spareroom"
    ? spareroomMessagesSql
    : genericMessagesSql;
  const fallbackMessagesSql = conversation.platform === "spareroom"
    ? spareroomMessagesSqlFallback
    : genericMessagesSqlFallback;

  let messagesResult;
  try {
    messagesResult = await client.query(preferredMessagesSql, [conversationId]);
  } catch (error) {
    if (error?.code !== "42703") {
      throw error;
    }
    messagesResult = await client.query(fallbackMessagesSql, [conversationId]);
  }

  const templatesResult = await client.query(
    `SELECT id,
            platform_account_id,
            name,
            locale,
            body,
            variables,
            is_active,
            updated_at
       FROM "Templates"
      WHERE platform_account_id = $1::uuid OR platform_account_id IS NULL
      ORDER BY updated_at DESC`,
    [conversation.platform_account_id]
  );

  const slotLabels = [];
  if (conversation.unit_id) {
    const slotResult = await client.query(
      `SELECT starts_at, ends_at, timezone
         FROM "AvailabilitySlots"
        WHERE unit_id = $1::uuid
          AND status = 'open'
          AND starts_at >= NOW()
        ORDER BY starts_at ASC
        LIMIT 3`,
      [conversation.unit_id]
    );

    if (slotResult.rowCount > 0) {
      for (const slot of slotResult.rows) {
        const timezone = slot.timezone || "UTC";
        slotLabels.push(`${formatInTimezone(slot.starts_at, timezone)} - ${formatInTimezone(slot.ends_at, timezone)} ${timezone}`);
      }
    }
  }

  const nextSlot = slotLabels[0] || "";
  const slotOptionsList = slotLabels.length > 0 ? slotLabels.map((label) => `- ${label}`).join("\n") : "";
  const slotOptionsInline = slotLabels.join(", ");

  const templateContext = {
    unit: conversation.property_name && conversation.unit_number
      ? `${conversation.property_name} ${conversation.unit_number}`
      : conversation.external_thread_label || "",
    unit_number: conversation.unit_number || "",
    lead_name: conversation.lead_name || "",
    slot: nextSlot,
    slot_options_list: slotOptionsList,
    slot_options_inline: slotOptionsInline,
    // Keep a backwards compatible alias used by some templates/contexts.
    slot_options: slotOptionsList || slotOptionsInline
  };

  return {
    conversation: {
      id: conversation.id,
      platformAccountId: conversation.platform_account_id,
      platform: conversation.platform,
      listingId: conversation.listing_id,
      assignedAgentId: conversation.assigned_agent_id,
      externalThreadId: conversation.external_thread_id,
      leadName: conversation.lead_name,
      leadContact: conversation.lead_contact || {},
      status: conversation.status,
      workflowState: conversation.workflow_state,
      workflowOutcome: conversation.workflow_outcome,
      showingState: conversation.showing_state,
      followUpStage: conversation.follow_up_stage,
      followUpDueAt: conversation.follow_up_due_at,
      followUpOwnerAgentId: conversation.follow_up_owner_agent_id,
      followUpStatus: conversation.follow_up_status,
      workflowUpdatedAt: conversation.workflow_updated_at,
      unit: templateContext.unit,
      threadLabel: conversation.external_thread_label || null,
      threadMessageCount: conversation.external_thread_message_count === null || conversation.external_thread_message_count === undefined
        ? null
        : Number(conversation.external_thread_message_count),
      inboxSortRank: conversation.external_inbox_sort_rank === null || conversation.external_inbox_sort_rank === undefined
        ? null
        : Number(conversation.external_inbox_sort_rank),
      lastMessageAt: conversation.last_message_at,
      updatedAt: conversation.updated_at
    },
    messages: messagesResult.rows.map((row) => toMessageDto(row)),
    templates: templatesResult.rows.map((row) => ({
      id: row.id,
      platformAccountId: row.platform_account_id,
      name: row.name,
      locale: row.locale,
      body: row.body,
      variables: Array.isArray(row.variables) ? row.variables : [],
      isActive: row.is_active,
      updatedAt: row.updated_at
    })),
    templateContext
  };
}

function shouldHydrateConversationThread(detail) {
  const platform = detail?.conversation?.platform;
  if (!["spareroom", "roomies", "leasebreak"].includes(platform)) {
    return false;
  }

  const messages = Array.isArray(detail?.messages) ? detail.messages : [];
  if (messages.length === 0) {
    return true;
  }

  const hasThreadRows = messages.some(
    (message) => String(message?.metadata?.sentAtSource || "") === "platform_thread"
  );
  const hasInboxPreviewRows = messages.some(
    (message) => String(message?.metadata?.sentAtSource || "") === "platform_inbox"
  );
  const hasLikelyTruncatedPreview = messages.some((message) => {
    const source = String(message?.metadata?.sentAtSource || "");
    const body = typeof message?.body === "string" ? message.body.trim() : "";
    return source === "platform_inbox" && /\.\.\.\s*$/.test(body);
  });

  if (!hasThreadRows && hasInboxPreviewRows) {
    return true;
  }
  if (!hasThreadRows && hasLikelyTruncatedPreview) {
    return true;
  }

  return false;
}

export async function routeApi(req, res, url) {
  if (url.pathname === "/api/me" && req.method === "GET") {
    const session = await getSession(req);
    if (!session?.user) {
      json(res, 401, {
        authenticated: false,
        error: "unauthorized"
      });
      return;
    }

    json(res, 200, {
      authenticated: true,
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        role: normalizeRole(session.user.role)
      }
    });
    return;
  }

  if (url.pathname === "/api/protected/agent" && req.method === "GET") {
    const access = await requireRole(req, res, [roles.agent, roles.admin]);
    if (!access) {
      return;
    }

    json(res, 200, {
      ok: true,
      scope: "agent",
      role: access.role
    });
    return;
  }

  if (url.pathname === "/api/protected/admin" && req.method === "GET") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    json(res, 200, {
      ok: true,
      scope: "admin",
      role: access.role
    });
    return;
  }

  if (url.pathname === "/api/admin/observability" && req.method === "GET") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    const windowHours = parsePositiveInt(url.searchParams.get("windowHours"), 24, { min: 1, max: 168 });
    const auditLimit = parsePositiveInt(url.searchParams.get("auditLimit"), 50, { min: 1, max: 200 });
    const errorLimit = parsePositiveInt(url.searchParams.get("errorLimit"), 25, { min: 1, max: 200 });
    const signalLimit = parsePositiveInt(url.searchParams.get("signalLimit"), 25, { min: 1, max: 100 });

    const withClientRunner = routeTestOverrides?.withClient || withClient;
    const fetchObservabilitySnapshotRunner = routeTestOverrides?.fetchObservabilitySnapshot || fetchObservabilitySnapshot;

    const snapshot = await withClientRunner((client) =>
      fetchObservabilitySnapshotRunner(client, {
        windowHours,
        auditLimit,
        errorLimit,
        signalLimit
      })
    );

    json(res, 200, snapshot);
    return;
  }

  if (url.pathname === "/api/agents" && req.method === "GET") {
    const access = await requireRole(req, res, [roles.agent, roles.admin]);
    if (!access) {
      return;
    }

    const result = await pool.query(
      `SELECT id, full_name, email, timezone, role
         FROM "Agents"
        ORDER BY full_name ASC`
    );

    json(res, 200, {
      items: result.rows.map((row) => ({
        id: row.id,
        fullName: row.full_name,
        email: row.email,
        timezone: row.timezone,
        role: row.role
      }))
    });
    return;
  }

  if (url.pathname === "/api/message-automation" && req.method === "GET") {
    const access = await requireRole(req, res, [roles.agent, roles.admin]);
    if (!access) {
      return;
    }

    const platformAccountId = url.searchParams.get("platformAccountId") || "11111111-1111-1111-1111-111111111111";
    if (!isUuid(platformAccountId)) {
      badRequest(res, "platformAccountId must be a UUID");
      return;
    }

    const payload = await withClient(async (client) => {
      const rule = await fetchAutoSendRule(client, platformAccountId);
      return {
        platformAccountId,
        autoSendEnabled: rule ? rule.enabled : false,
        ruleId: rule?.id || null,
        actionConfig: rule?.actionConfig || {}
      };
    });

    json(res, 200, payload);
    return;
  }

  if (url.pathname === "/api/admin/platform-policies" && req.method === "GET") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    const withClientRunner = routeTestOverrides?.withClient || withClient;
    const fetchPlatformPoliciesRunner = routeTestOverrides?.fetchPlatformPolicies || fetchPlatformPolicies;
    const items = await withClientRunner((client) => fetchPlatformPoliciesRunner(client));
    const missingPlatforms = requiredPlatforms.filter((platform) => !items.some((item) => item.platform === platform));

    json(res, 200, {
      globalDefaultSendMode,
      requiredPlatforms,
      missingPlatforms,
      items
    });
    return;
  }

  if (url.pathname === "/api/admin/platform-health" && req.method === "GET") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    const withClientRunner = routeTestOverrides?.withClient || withClient;
    const fetchPlatformHealthSnapshotRunner = routeTestOverrides?.fetchPlatformHealthSnapshot || fetchPlatformHealthSnapshot;
    const items = await withClientRunner((client) => fetchPlatformHealthSnapshotRunner(client));

    json(res, 200, {
      generatedAt: new Date().toISOString(),
      items
    });
    return;
  }

  if (url.pathname === "/api/admin/users" && req.method === "GET") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    const withClientRunner = routeTestOverrides?.withClient || withClient;
    const payload = await withClientRunner(async (client) => {
      const usersResult = await client.query(
        `SELECT id,
                email,
                name,
                role,
                "createdAt" AS created_at,
                "updatedAt" AS updated_at
           FROM "user"
          ORDER BY "createdAt" DESC, email ASC`
      );

      const invitationsResult = await client.query(
        `SELECT id,
                email,
                first_name,
                last_name,
                role,
                invited_by,
                expires_at,
                accepted_at,
                revoked_at,
                created_at,
                updated_at
           FROM "UserInvitations"
          ORDER BY created_at DESC`
      );

      return {
        users: usersResult.rows.map((row) => {
          const splitName = splitDisplayName(row.name);
          return {
            id: row.id,
            email: row.email,
            firstName: splitName.firstName,
            lastName: splitName.lastName,
            fullName: row.name,
            role: normalizeRole(row.role),
            createdAt: row.created_at,
            updatedAt: row.updated_at
          };
        }),
        invitations: invitationsResult.rows.map((row) => toInvitationDto(row))
      };
    });

    json(res, 200, payload);
    return;
  }

  if (url.pathname === "/api/admin/users/invitations" && req.method === "POST") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      badRequest(res, "Request body must be valid JSON");
      return;
    }

    const { errors, value } = validateInvitationCreatePayload(payload);
    if (errors.length > 0) {
      badRequest(res, "Invalid invitation payload", errors);
      return;
    }

    const inviteToken = createInviteToken();
    const inviteTokenHash = hashInviteToken(inviteToken);
    const expiresAt = new Date(Date.now() + resolveInviteTtlHours() * 60 * 60 * 1000).toISOString();
    const withClientRunner = routeTestOverrides?.withClient || withClient;

    const created = await withClientRunner(async (client) => {
      const existingUser = await client.query(
        `SELECT id
           FROM "user"
          WHERE LOWER(email) = LOWER($1)
          LIMIT 1`,
        [value.email]
      );

      if (existingUser.rowCount > 0) {
        return { error: "user_exists" };
      }

      await client.query(
        `UPDATE "UserInvitations"
            SET revoked_at = NOW(),
                updated_at = NOW()
          WHERE LOWER(email) = LOWER($1)
            AND accepted_at IS NULL
            AND revoked_at IS NULL`,
        [value.email]
      );

      const inserted = await client.query(
        `INSERT INTO "UserInvitations" (
           id,
           email,
           first_name,
           last_name,
           role,
           token_hash,
           invited_by,
           expires_at
         ) VALUES (
           $1::uuid,
           $2,
           $3,
           $4,
           $5,
           $6,
           $7,
           $8::timestamptz
         )
         RETURNING id,
                   email,
                   first_name,
                   last_name,
                   role,
                   invited_by,
                   expires_at,
                   accepted_at,
                   revoked_at,
                   created_at,
                   updated_at`,
        [
          randomUUID(),
          value.email,
          value.firstName,
          value.lastName,
          value.role,
          inviteTokenHash,
          String(access.session.user.id),
          expiresAt
        ]
      );

      const row = inserted.rows[0];
      await recordAuditLog(client, {
        actorType: "user",
        actorId: access.session.user.id,
        entityType: "user_invitation",
        entityId: row.id,
        action: "user_invited",
        details: {
          email: row.email,
          role: row.role
        }
      });

      return {
        row,
        token: inviteToken
      };
    });

    if (created?.error === "user_exists") {
      json(res, 409, {
        error: "user_exists",
        message: "A user with this email already exists"
      });
      return;
    }

    const inviteUrl = buildInviteUrl(created.token);
    const inviterName = access.session?.user?.name || access.session?.user?.email || "Lease Bot Admin";
    let delivery;
    try {
      delivery = await sendInvitationEmail({
        to: value.email,
        firstName: value.firstName,
        inviterName,
        inviteUrl,
        expiresAt
      });
    } catch (error) {
      await withClientRunner((client) =>
        client.query(
          `UPDATE "UserInvitations"
              SET revoked_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1::uuid
              AND accepted_at IS NULL`,
          [created.row.id]
        )
      );

      json(res, 500, {
        error: "invite_delivery_failed",
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    json(res, 201, {
      invitation: {
        ...toInvitationDto(created.row),
        delivery: delivery.delivery,
        messageId: delivery.messageId || null,
        previewUrl: delivery.previewUrl || null
      }
    });
    return;
  }

  const revokeInviteMatch = url.pathname.match(/^\/api\/admin\/users\/invitations\/([0-9a-f\-]+)\/revoke$/i);
  if (revokeInviteMatch && req.method === "POST") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    const invitationId = revokeInviteMatch[1];
    if (!isUuid(invitationId)) {
      badRequest(res, "invitationId must be a UUID");
      return;
    }

    const withClientRunner = routeTestOverrides?.withClient || withClient;
    const revoked = await withClientRunner(async (client) => {
      const result = await client.query(
        `UPDATE "UserInvitations"
            SET revoked_at = NOW(),
                updated_at = NOW()
          WHERE id = $1::uuid
            AND accepted_at IS NULL
            AND revoked_at IS NULL
         RETURNING id`,
        [invitationId]
      );

      if (result.rowCount === 0) {
        return null;
      }

      await recordAuditLog(client, {
        actorType: "user",
        actorId: access.session.user.id,
        entityType: "user_invitation",
        entityId: invitationId,
        action: "user_invitation_revoked"
      });

      return { revoked: true };
    });

    if (!revoked) {
      notFound(res);
      return;
    }

    json(res, 200, revoked);
    return;
  }

  if (url.pathname === "/api/invitations/verify" && req.method === "GET") {
    const rawToken = url.searchParams.get("token");
    const token = typeof rawToken === "string" ? rawToken.trim() : "";

    if (!token || token.length < 30) {
      badRequest(res, "token is required");
      return;
    }

    const tokenHash = hashInviteToken(token);
    const withClientRunner = routeTestOverrides?.withClient || withClient;
    const invitation = await withClientRunner(async (client) => {
      const result = await client.query(
        `SELECT id,
                email,
                first_name,
                last_name,
                role,
                invited_by,
                expires_at,
                accepted_at,
                revoked_at,
                created_at,
                updated_at
           FROM "UserInvitations"
          WHERE token_hash = $1
          LIMIT 1`,
        [tokenHash]
      );
      return result.rows[0] || null;
    });

    if (!invitation) {
      json(res, 404, {
        valid: false,
        error: "invalid_token"
      });
      return;
    }

    const dto = toInvitationDto(invitation);
    if (dto.status !== "pending") {
      json(res, 409, {
        valid: false,
        error: "invite_unavailable",
        status: dto.status
      });
      return;
    }

    json(res, 200, {
      valid: true,
      invitation: {
        email: dto.email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        role: dto.role,
        expiresAt: dto.expiresAt
      }
    });
    return;
  }

  if (url.pathname === "/api/invitations/accept" && req.method === "POST") {
    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      badRequest(res, "Request body must be valid JSON");
      return;
    }

    const { errors, value } = validateInvitationAcceptPayload(payload);
    if (errors.length > 0) {
      badRequest(res, "Invalid invitation payload", errors);
      return;
    }

    const tokenHash = hashInviteToken(value.token);
    const withClientRunner = routeTestOverrides?.withClient || withClient;

    const invitation = await withClientRunner(async (client) => {
      const result = await client.query(
        `SELECT id,
                email,
                first_name,
                last_name,
                role,
                invited_by,
                expires_at,
                accepted_at,
                revoked_at,
                created_at,
                updated_at
           FROM "UserInvitations"
          WHERE token_hash = $1
          LIMIT 1`,
        [tokenHash]
      );
      return result.rows[0] || null;
    });

    if (!invitation) {
      json(res, 404, {
        error: "invalid_token"
      });
      return;
    }

    const invitationDto = toInvitationDto(invitation);
    if (invitationDto.status !== "pending") {
      json(res, 409, {
        error: "invite_unavailable",
        status: invitationDto.status
      });
      return;
    }

    const displayName = buildDisplayName(invitationDto.firstName, invitationDto.lastName);
    const signUpRunner = routeTestOverrides?.signUpEmail || ((args) => auth.api.signUpEmail(args));
    try {
      await signUpRunner({
        // better-auth expects body wrapper for direct API usage
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        body: {
          email: invitationDto.email,
          password: value.password,
          name: displayName
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/user already exists/i.test(message)) {
        json(res, 409, {
          error: "user_exists",
          message: "A user with this email already exists"
        });
        return;
      }

      json(res, 500, {
        error: "invite_accept_failed",
        message
      });
      return;
    }

    await withClientRunner(async (client) => {
      await client.query(
        `UPDATE "user"
            SET role = $2,
                name = $3,
                "emailVerified" = TRUE,
                "updatedAt" = NOW()
          WHERE LOWER(email) = LOWER($1)`,
        [invitationDto.email, invitationDto.role, displayName]
      );

      await client.query(
        `UPDATE "UserInvitations"
            SET accepted_at = NOW(),
                updated_at = NOW()
          WHERE id = $1::uuid
            AND accepted_at IS NULL
            AND revoked_at IS NULL`,
        [invitationDto.id]
      );

      await recordAuditLog(client, {
        actorType: "system",
        entityType: "user_invitation",
        entityId: invitationDto.id,
        action: "user_invitation_accepted",
        details: {
          email: invitationDto.email,
          role: invitationDto.role
        }
      });
    });

    json(res, 200, {
      accepted: true,
      email: invitationDto.email
    });
    return;
  }

  const adminPlatformPolicyMatch = url.pathname.match(/^\/api\/admin\/platform-policies\/([0-9a-f\-]+)$/i);
  if (adminPlatformPolicyMatch && req.method === "PUT") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    const platformAccountId = adminPlatformPolicyMatch[1];
    if (!isUuid(platformAccountId)) {
      badRequest(res, "platformAccountId must be a UUID");
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      badRequest(res, "Request body must be valid JSON");
      return;
    }

    const { errors, updates } = parsePlatformPolicyPayload(payload, { partial: true });
    if (errors.length > 0) {
      badRequest(res, "Invalid platform policy payload", errors);
      return;
    }

    if (Object.keys(updates).length === 0) {
      badRequest(res, "At least one policy field must be provided");
      return;
    }

    const withClientRunner = routeTestOverrides?.withClient || withClient;
    const updated = await withClientRunner(async (client) => {
      const targetResult = await client.query(
        `SELECT id, platform
           FROM "PlatformAccounts"
          WHERE id = $1::uuid
          LIMIT 1`,
        [platformAccountId]
      );

      if (targetResult.rowCount === 0) {
        return null;
      }

      const target = targetResult.rows[0];
      if (!requiredPlatformSet.has(target.platform)) {
        return { error: "platform_not_supported" };
      }

      if (Object.prototype.hasOwnProperty.call(updates, "credentials")) {
        const credentialErrors = validatePlatformCredentialPayload(target.platform, updates.credentials);
        if (credentialErrors.length > 0) {
          return {
            error: "validation_error",
            details: credentialErrors
          };
        }
      }

      const nextPolicy = await updatePlatformPolicy(client, platformAccountId, updates);

      await recordAuditLog(client, {
        actorType: "user",
        actorId: access.session.user.id,
        entityType: "platform_account",
        entityId: platformAccountId,
        action: "platform_policy_updated",
        details: {
          updates,
          effectiveSendMode: nextPolicy?.sendMode || null,
          integrationMode: nextPolicy?.integrationMode || null,
          isActive: nextPolicy?.isActive || false
        }
      });

      return nextPolicy;
    });

    if (updated?.error === "platform_not_supported") {
      badRequest(res, "Only mandatory RPA platforms may be updated");
      return;
    }

    if (updated?.error === "validation_error") {
      badRequest(res, "Invalid platform policy payload", updated.details || []);
      return;
    }

    if (!updated) {
      notFound(res);
      return;
    }

    json(res, 200, updated);
    return;
  }

  if (url.pathname === "/api/message-automation" && req.method === "PUT") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      badRequest(res, "Request body must be valid JSON");
      return;
    }

    const platformAccountId = payload.platformAccountId || "11111111-1111-1111-1111-111111111111";
    if (!isUuid(platformAccountId)) {
      badRequest(res, "platformAccountId must be a UUID");
      return;
    }
    if (typeof payload.enabled !== "boolean") {
      badRequest(res, "enabled must be a boolean");
      return;
    }

    const result = await withClient(async (client) => {
      const existing = await fetchAutoSendRule(client, platformAccountId);

      if (existing) {
        await client.query(
          `UPDATE "AutomationRules"
              SET is_enabled = $2,
                  updated_at = NOW()
            WHERE id = $1::uuid`,
          [existing.id, payload.enabled]
        );

        return {
          ruleId: existing.id,
          autoSendEnabled: payload.enabled,
          platformAccountId
        };
      }

      const inserted = await client.query(
        `INSERT INTO "AutomationRules" (
           platform_account_id,
           name,
           description,
           trigger_type,
           conditions,
           action_type,
           action_config,
           priority,
           is_enabled
         ) VALUES ($1::uuid, $2, $3, 'message_received', '{}'::jsonb, 'send_template', $4::jsonb, 10, $5)
         RETURNING id`,
        [
          platformAccountId,
          "Auto reply to tour intent",
          "Respond with unit and slot context when a lead requests a tour.",
          JSON.stringify({ template: "tour_invite_v1" }),
          payload.enabled
        ]
      );

      return {
        ruleId: inserted.rows[0].id,
        autoSendEnabled: payload.enabled,
        platformAccountId
      };
    });

    json(res, 200, result);
    return;
  }

  if (url.pathname === "/api/templates" && req.method === "GET") {
    const access = await requireRole(req, res, [roles.agent, roles.admin]);
    if (!access) {
      return;
    }

    const platformAccountId = url.searchParams.get("platformAccountId") || "11111111-1111-1111-1111-111111111111";
    if (!isUuid(platformAccountId)) {
      badRequest(res, "platformAccountId must be a UUID");
      return;
    }

    const result = await pool.query(
      `SELECT id, platform_account_id, name, channel, locale, body, variables, is_active, updated_at
         FROM "Templates"
        WHERE platform_account_id = $1::uuid OR platform_account_id IS NULL
        ORDER BY updated_at DESC`,
      [platformAccountId]
    );

    json(res, 200, {
      items: result.rows.map((row) => ({
        id: row.id,
        platformAccountId: row.platform_account_id,
        name: row.name,
        channel: row.channel,
        locale: row.locale,
        body: row.body,
        variables: Array.isArray(row.variables) ? row.variables : [],
        isActive: row.is_active,
        updatedAt: row.updated_at
      }))
    });
    return;
  }

  if (url.pathname === "/api/templates" && req.method === "POST") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      badRequest(res, "Request body must be valid JSON");
      return;
    }

    const platformAccountId = payload.platformAccountId || "11111111-1111-1111-1111-111111111111";
    if (!isUuid(platformAccountId)) {
      badRequest(res, "platformAccountId must be a UUID");
      return;
    }
    if (typeof payload.name !== "string" || payload.name.trim().length < 2) {
      badRequest(res, "name must be at least 2 characters");
      return;
    }
    if (typeof payload.body !== "string" || payload.body.trim().length < 3) {
      badRequest(res, "body must be at least 3 characters");
      return;
    }

    const variables = normalizeTemplateVariables(payload);

    try {
      const result = await pool.query(
        `INSERT INTO "Templates" (platform_account_id, name, channel, locale, body, variables, is_active)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING id`,
        [
          platformAccountId,
          payload.name.trim(),
          payload.channel || "in_app",
          payload.locale || "en-US",
          payload.body,
          JSON.stringify(variables),
          payload.isActive ?? true
        ]
      );

      json(res, 201, { id: result.rows[0].id });
    } catch (error) {
      if (error?.code === "23505") {
        badRequest(res, "Template with the same name and locale already exists");
        return;
      }
      throw error;
    }
    return;
  }

  const templateByIdMatch = url.pathname.match(/^\/api\/templates\/([0-9a-f\-]+)$/i);
  if (templateByIdMatch && req.method === "PUT") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    const templateId = templateByIdMatch[1];
    if (!isUuid(templateId)) {
      badRequest(res, "templateId must be a UUID");
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      badRequest(res, "Request body must be valid JSON");
      return;
    }

    const variables = normalizeTemplateVariables(payload);

    const result = await pool.query(
      `UPDATE "Templates"
          SET name = COALESCE($2, name),
              body = COALESCE($3, body),
              channel = COALESCE($4, channel),
              locale = COALESCE($5, locale),
              variables = COALESCE($6::jsonb, variables),
              is_active = COALESCE($7, is_active),
              updated_at = NOW()
        WHERE id = $1::uuid`,
      [
        templateId,
        payload.name ? payload.name.trim() : null,
        payload.body || null,
        payload.channel || null,
        payload.locale || null,
        variables.length > 0 ? JSON.stringify(variables) : null,
        typeof payload.isActive === "boolean" ? payload.isActive : null
      ]
    );

    if (result.rowCount === 0) {
      notFound(res);
      return;
    }

    json(res, 200, { updated: true });
    return;
  }

  if (url.pathname === "/api/inbox" && req.method === "GET") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    const status = url.searchParams.get("status");
    if (status && !["new", "draft", "sent", "hold"].includes(status)) {
      badRequest(res, "status must be one of new, draft, sent, hold");
      return;
    }

    const platform = url.searchParams.get("platform");
    if (platform && !requiredPlatformSet.has(platform)) {
      badRequest(res, `platform must be one of ${requiredPlatforms.join(", ")}`);
      return;
    }

    const withClientRunner = routeTestOverrides?.withClient || withClient;
    const items = await withClientRunner((client) => fetchInboxList(client, status, access, platform));
    json(res, 200, { items });
    return;
  }

  const inboxSyncMatch = url.pathname.match(/^\/api\/inbox\/([0-9a-f\-]+)\/sync$/i);
  if (inboxSyncMatch && req.method === "POST") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    const conversationId = inboxSyncMatch[1];
    if (!isUuid(conversationId)) {
      badRequest(res, "conversationId must be a UUID");
      return;
    }

    const withClientRunner = routeTestOverrides?.withClient || withClient;
    const payload = await withClientRunner(async (client) => {
      const adapter = createPostgresQueueAdapter(client, { connectorRegistry });
      const syncResult = await adapter.syncConversationThread({ conversationId });
      const detail = await fetchConversationDetail(client, conversationId, access);
      return detail ? { ...detail, sync: syncResult } : null;
    });

    if (!payload) {
      notFound(res);
      return;
    }

    json(res, 200, payload);
    return;
  }

  const inboxConversationMatch = url.pathname.match(/^\/api\/inbox\/([0-9a-f\-]+)$/i);
  if (inboxConversationMatch && req.method === "GET") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    const conversationId = inboxConversationMatch[1];
    if (!isUuid(conversationId)) {
      badRequest(res, "conversationId must be a UUID");
      return;
    }

    const withClientRunner = routeTestOverrides?.withClient || withClient;
    const payload = await withClientRunner(async (client) => {
      let detail = await fetchConversationDetail(client, conversationId, access);
      if (!detail) {
        return null;
      }

      if (shouldHydrateConversationThread(detail)) {
        try {
          const adapter = createPostgresQueueAdapter(client, { connectorRegistry });
          await adapter.syncConversationThread({ conversationId });
          const refreshed = await fetchConversationDetail(client, conversationId, access);
          if (refreshed) {
            detail = refreshed;
          }
        } catch (error) {
          console.warn("[inbox] opportunistic thread hydration failed", {
            conversationId,
            platform: detail?.conversation?.platform || null,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      return detail;
    });
    if (!payload) {
      notFound(res);
      return;
    }

    json(res, 200, payload);
    return;
  }

  const inboxDraftMatch = url.pathname.match(/^\/api\/inbox\/([0-9a-f\-]+)\/draft$/i);
  if (inboxDraftMatch && req.method === "POST") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    const conversationId = inboxDraftMatch[1];
    if (!isUuid(conversationId)) {
      badRequest(res, "conversationId must be a UUID");
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      badRequest(res, "Request body must be valid JSON");
      return;
    }

    const withClientRunner = routeTestOverrides?.withClient || withClient;
    let result;
    try {
      result = await withClientRunner(async (client) => {
        const detail = await fetchConversationDetail(client, conversationId, access);
        if (!detail) {
          return { error: "not_found" };
        }

        const platformPolicy = await fetchPlatformDispatchAccount(client, detail.conversation.platformAccountId);
        if (!platformPolicy) {
          return { error: "platform_policy_not_found" };
        }
        if (!platformPolicy.isActive) {
          return { error: "platform_inactive" };
        }
        const autoSendEnabled = platformPolicy.sendMode === "auto_send";
        const manualDispatchRequested = payload.dispatchNow !== false;

        const rawBody = typeof payload.body === "string" ? payload.body : null;
        let messageBody = rawBody;
        let templateId = null;
        let template = null;
        if (payload.templateId) {
          if (!isUuid(payload.templateId)) {
            return { error: "template_id_invalid" };
          }
          template = detail.templates.find((item) => item.id === payload.templateId);
          if (!template) {
            return { error: "template_not_found" };
          }
          templateId = template.id;
          const context = {
            ...detail.templateContext,
            ...(payload.variables && typeof payload.variables === "object" ? payload.variables : {})
          };

          // If the UI provides a body (even when templateId is selected), prefer the user's body.
          // When body matches the template body exactly, treat it as "send this template" and render it.
          const bodySource =
            typeof rawBody === "string" && rawBody.trim().length > 0
              ? (rawBody === template.body ? template.body : rawBody)
              : template.body;

          messageBody = renderTemplate(bodySource, context);
        }

        if (typeof messageBody !== "string" || messageBody.trim().length < 1) {
          return { error: "body_required" };
        }

        const guardrailReviewReasons = collectGuardrailReviewReasons(payload.metadata);
        const requiresAdminReview = guardrailReviewReasons.length > 0;
        const shouldDispatch = (manualDispatchRequested || autoSendEnabled) && !requiresAdminReview;
        const status = shouldDispatch ? "sent" : "draft";
        let delivery = null;

        if (shouldDispatch) {
          if (!detail.conversation.externalThreadId) {
            return { error: "external_thread_required" };
          }

          const dispatchOutboundMessage = routeTestOverrides?.dispatchOutboundMessage
            || ((dispatchPayload) =>
              connectorRegistry.sendMessageForAccount({
                account: {
                  id: platformPolicy.id,
                  platform: platformPolicy.platform,
                  credentials: platformPolicy.credentials
                },
                outbound: {
                  externalThreadId: dispatchPayload.externalThreadId,
                  body: dispatchPayload.body
                }
              }));

          try {
            delivery = await dispatchOutboundMessage({
              platformAccountId: platformPolicy.id,
              platform: platformPolicy.platform,
              externalThreadId: detail.conversation.externalThreadId,
              body: messageBody,
              metadata: payload.metadata || {}
            });
          } catch (error) {
            return {
              error: "platform_dispatch_failed",
              message: error instanceof Error ? error.message : String(error)
            };
          }
        }

        const metadata = {
          ...(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}),
          reviewStatus: status,
          reviewRequired: requiresAdminReview,
          dispatchRequested: manualDispatchRequested,
          ...(guardrailReviewReasons.length > 0 ? { guardrailReviewReasons } : {}),
          ...(templateId ? { templateId } : {}),
          ...(delivery ? { delivery } : {})
        };

        const inserted = await client.query(
          `INSERT INTO "Messages" (
             conversation_id,
             sender_type,
             sender_agent_id,
             external_message_id,
             direction,
             channel,
             body,
             metadata,
             sent_at
           ) VALUES ($1::uuid, 'agent', $2::uuid, $3, 'outbound', 'in_app', $4, $5::jsonb, NOW())
            RETURNING id`,
          [conversationId, detail.conversation.assignedAgentId || null, delivery?.externalMessageId || null, messageBody, JSON.stringify(metadata)]
        );

        await client.query(
          `UPDATE "Conversations"
              SET last_message_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1::uuid`,
          [conversationId]
        );

        await recordAuditLog(client, {
          actorType: access.role === roles.admin ? "admin" : "agent",
          actorId: access.session.user.id,
          entityType: "message",
          entityId: inserted.rows[0].id,
          action: shouldDispatch ? "inbox_manual_reply_dispatched" : "inbox_draft_saved",
          details: {
            conversationId,
            templateId,
            autoSendEnabled,
            manualDispatchRequested,
            platformPolicy,
            requiresAdminReview,
            guardrailReviewReasons,
            reviewStatus: status,
            externalThreadId: detail.conversation.externalThreadId || null,
            delivery
          }
        });

        return {
          id: inserted.rows[0].id,
          status,
          dispatched: shouldDispatch,
          delivery,
          autoSendEnabled,
          effectiveSendMode: platformPolicy.sendMode,
          requiresAdminReview,
          guardrailReviewReasons
        };
      });
    } catch (error) {
      await withClientRunner((client) =>
        recordAuditLog(client, {
          actorType: access.role === roles.admin ? "admin" : "agent",
          actorId: access.session.user.id,
          entityType: "conversation",
          entityId: conversationId,
          action: "inbox_draft_error",
          details: {
            error: error instanceof Error ? error.message : String(error)
          }
        })
      );
      throw error;
    }

    if (result.error === "not_found") {
      notFound(res);
      return;
    }
    if (result.error === "template_id_invalid") {
      badRequest(res, "templateId must be a UUID");
      return;
    }
    if (result.error === "template_not_found") {
      badRequest(res, "templateId not found for this conversation");
      return;
    }
    if (result.error === "body_required") {
      badRequest(res, "body is required when template does not render content");
      return;
    }
    if (result.error === "platform_policy_not_found") {
      badRequest(res, "platform policy not found for this conversation");
      return;
    }
    if (result.error === "platform_inactive") {
      json(res, 409, {
        error: "platform_inactive",
        message: "platform is disabled for outbound sends"
      });
      return;
    }
    if (result.error === "external_thread_required") {
      json(res, 409, {
        error: "platform_thread_missing",
        message: "conversation is missing external thread id for dispatch"
      });
      return;
    }
    if (result.error === "platform_dispatch_failed") {
      json(res, 502, {
        error: "platform_dispatch_failed",
        message: result.message || "failed to dispatch outbound message"
      });
      return;
    }

    json(res, 201, result);
    return;
  }

  const conversationWorkflowMatch = url.pathname.match(/^\/api\/conversations\/([0-9a-f\-]+)\/workflow-state$/i);
  if (conversationWorkflowMatch && req.method === "POST") {
    const access = await requireRole(req, res, [roles.agent, roles.admin]);
    if (!access) {
      return;
    }

    const conversationId = conversationWorkflowMatch[1];
    if (!isUuid(conversationId)) {
      badRequest(res, "conversationId must be a UUID");
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      badRequest(res, "Request body must be valid JSON");
      return;
    }

    const withClientRunner = routeTestOverrides?.withClient || withClient;
    const transitionRunner = routeTestOverrides?.transitionConversationWorkflow || transitionConversationWorkflow;
    const result = await withClientRunner((client) => transitionRunner(client, conversationId, payload || {}, access));

    if (result?.error === "not_found") {
      notFound(res);
      return;
    }
    if (result?.error === "forbidden") {
      json(res, 403, { error: "forbidden", message: "agents may only update their own assigned conversation workflows" });
      return;
    }
    if (result?.error === "validation_error") {
      badRequest(res, "Invalid workflow transition payload", result.details || null);
      return;
    }
    if (result?.error === "invalid_transition") {
      json(res, 409, {
        error: "invalid_transition",
        message: result.message || "workflow transition is not allowed"
      });
      return;
    }

    json(res, 200, result);
    return;
  }

  const approveMessageMatch = url.pathname.match(/^\/api\/inbox\/messages\/([0-9a-f\-]+)\/approve$/i);
  if (approveMessageMatch && req.method === "POST") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    const messageId = approveMessageMatch[1];
    if (!isUuid(messageId)) {
      badRequest(res, "messageId must be a UUID");
      return;
    }

    let result;
    try {
      result = await withClient(async (client) => {
        const updated = await client.query(
          `UPDATE "Messages"
              SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{reviewStatus}', '"sent"'::jsonb, true),
                  sent_at = NOW()
            WHERE id = $1::uuid
              AND direction = 'outbound'
          RETURNING id`,
          [messageId]
        );

        if (updated.rowCount > 0) {
          await recordAuditLog(client, {
            actorType: "admin",
            actorId: access.session.user.id,
            entityType: "message",
            entityId: messageId,
            action: "inbox_message_approved",
            details: {
              reviewStatus: "sent"
            }
          });
        }

        return updated;
      });
    } catch (error) {
      await withClient((client) =>
        recordAuditLog(client, {
          actorType: "admin",
          actorId: access.session.user.id,
          entityType: "message",
          entityId: messageId,
          action: "inbox_message_error",
          details: {
            operation: "approve",
            error: error instanceof Error ? error.message : String(error)
          }
        })
      );
      throw error;
    }

    if (result.rowCount === 0) {
      notFound(res);
      return;
    }

    json(res, 200, { updated: true, id: messageId, status: "sent" });
    return;
  }

  const rejectMessageMatch = url.pathname.match(/^\/api\/inbox\/messages\/([0-9a-f\-]+)\/reject$/i);
  if (rejectMessageMatch && req.method === "POST") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    const messageId = rejectMessageMatch[1];
    if (!isUuid(messageId)) {
      badRequest(res, "messageId must be a UUID");
      return;
    }

    let result;
    try {
      result = await withClient(async (client) => {
        const updated = await client.query(
          `UPDATE "Messages"
              SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{reviewStatus}', '"hold"'::jsonb, true)
            WHERE id = $1::uuid
              AND direction = 'outbound'
          RETURNING id`,
          [messageId]
        );

        if (updated.rowCount > 0) {
          await recordAuditLog(client, {
            actorType: "admin",
            actorId: access.session.user.id,
            entityType: "message",
            entityId: messageId,
            action: "inbox_message_rejected",
            details: {
              reviewStatus: "hold"
            }
          });
        }

        return updated;
      });
    } catch (error) {
      await withClient((client) =>
        recordAuditLog(client, {
          actorType: "admin",
          actorId: access.session.user.id,
          entityType: "message",
          entityId: messageId,
          action: "inbox_message_error",
          details: {
            operation: "reject",
            error: error instanceof Error ? error.message : String(error)
          }
        })
      );
      throw error;
    }

    if (result.rowCount === 0) {
      notFound(res);
      return;
    }

    json(res, 200, { updated: true, id: messageId, status: "hold" });
    return;
  }

  if (url.pathname === "/api/units" && req.method === "GET") {
    const access = await requireRole(req, res, [roles.agent, roles.admin]);
    if (!access) {
      return;
    }

    const items = await withClient((client) => fetchUnits(client));
    json(res, 200, { items });
    return;
  }

  if (url.pathname === "/api/units" && req.method === "POST") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      badRequest(res, "Request body must be valid JSON");
      return;
    }

    const errors = validateUnitPayload(payload);
    if (errors.length > 0) {
      badRequest(res, "Invalid unit payload", errors);
      return;
    }

    try {
      const result = await pool.query(
        `INSERT INTO "Units" (
           external_id,
           property_name,
           unit_number,
           address_line1,
           city,
           state,
           postal_code,
           bedrooms,
           bathrooms,
           square_feet,
           is_active
         ) VALUES (
           $1,
           $2,
           $3,
           $4,
           $5,
           $6,
           $7,
           $8,
           $9,
           $10,
           $11
         ) RETURNING id`,
        [
          payload.externalId || null,
          payload.propertyName.trim(),
          payload.unitNumber.trim(),
          payload.addressLine1 || null,
          payload.city || null,
          payload.state || null,
          payload.postalCode || null,
          payload.bedrooms ?? null,
          payload.bathrooms ?? null,
          payload.squareFeet ?? null,
          payload.isActive ?? true
        ]
      );

      json(res, 201, { id: result.rows[0].id });
    } catch (error) {
      if (error?.code === "23505") {
        badRequest(res, "Unit already exists for property_name + unit_number");
        return;
      }
      throw error;
    }
    return;
  }

  const unitMatch = url.pathname.match(/^\/api\/units\/([0-9a-f\-]+)$/i);
  if (unitMatch) {
    const unitId = unitMatch[1];
    if (!isUuid(unitId)) {
      badRequest(res, "unitId must be a UUID");
      return;
    }

    if (req.method === "GET") {
      const access = await requireRole(req, res, [roles.agent, roles.admin]);
      if (!access) {
        return;
      }

      const rows = await withClient(async (client) => {
        const items = await fetchUnits(client);
        return items.filter((item) => item.id === unitId);
      });

      if (rows.length === 0) {
        notFound(res);
        return;
      }
      json(res, 200, rows[0]);
      return;
    }

    if (req.method === "PUT") {
      const access = await requireRole(req, res, [roles.admin]);
      if (!access) {
        return;
      }

      let payload;
      try {
        payload = await readJsonBody(req);
      } catch {
        badRequest(res, "Request body must be valid JSON");
        return;
      }

      const errors = validateUnitPayload(payload, { partial: true });
      if (errors.length > 0) {
        badRequest(res, "Invalid unit payload", errors);
        return;
      }

      const result = await pool.query(
        `UPDATE "Units"
            SET external_id = COALESCE($2, external_id),
                property_name = COALESCE($3, property_name),
                unit_number = COALESCE($4, unit_number),
                address_line1 = COALESCE($5, address_line1),
                city = COALESCE($6, city),
                state = COALESCE($7, state),
                postal_code = COALESCE($8, postal_code),
                bedrooms = COALESCE($9, bedrooms),
                bathrooms = COALESCE($10, bathrooms),
                square_feet = COALESCE($11, square_feet),
                is_active = COALESCE($12, is_active),
                updated_at = NOW()
          WHERE id = $1::uuid`,
        [
          unitId,
          payload.externalId !== undefined ? payload.externalId : null,
          payload.propertyName !== undefined ? payload.propertyName.trim() : null,
          payload.unitNumber !== undefined ? payload.unitNumber.trim() : null,
          payload.addressLine1 !== undefined ? payload.addressLine1 : null,
          payload.city !== undefined ? payload.city : null,
          payload.state !== undefined ? payload.state : null,
          payload.postalCode !== undefined ? payload.postalCode : null,
          payload.bedrooms !== undefined ? payload.bedrooms : null,
          payload.bathrooms !== undefined ? payload.bathrooms : null,
          payload.squareFeet !== undefined ? payload.squareFeet : null,
          payload.isActive !== undefined ? payload.isActive : null
        ]
      );

      if (result.rowCount === 0) {
        notFound(res);
        return;
      }

      json(res, 200, { updated: true });
      return;
    }

    if (req.method === "DELETE") {
      const access = await requireRole(req, res, [roles.admin]);
      if (!access) {
        return;
      }

      const result = await pool.query(`DELETE FROM "Units" WHERE id = $1::uuid`, [unitId]);
      if (result.rowCount === 0) {
        notFound(res);
        return;
      }

      json(res, 200, { deleted: true });
      return;
    }
  }

  const assignMatch = url.pathname.match(/^\/api\/units\/([0-9a-f\-]+)\/assignment$/i);
  if (assignMatch && req.method === "PUT") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    const unitId = assignMatch[1];
    if (!isUuid(unitId)) {
      badRequest(res, "unitId must be a UUID");
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      badRequest(res, "Request body must be valid JSON");
      return;
    }

    if (payload.agentId !== null && !isUuid(payload.agentId)) {
      badRequest(res, "agentId must be a UUID or null");
      return;
    }

    const response = await withClient(async (client) => {
      const unitCheck = await client.query(`SELECT id FROM "Units" WHERE id = $1::uuid`, [unitId]);
      if (unitCheck.rowCount === 0) {
        return { error: "unit_not_found" };
      }

      await client.query("BEGIN");
      try {
        if (payload.agentId) {
          const agentCheck = await client.query(`SELECT id FROM "Agents" WHERE id = $1::uuid`, [payload.agentId]);
          if (agentCheck.rowCount === 0) {
            await client.query("ROLLBACK");
            return { error: "agent_not_found" };
          }

          await client.query(
            `UPDATE "UnitAgentAssignments"
                SET assignment_mode = 'passive',
                    updated_at = NOW()
              WHERE unit_id = $1::uuid
                AND assignment_mode = 'active'
                AND agent_id <> $2::uuid`,
            [unitId, payload.agentId]
          );

          await client.query(
            `INSERT INTO "UnitAgentAssignments" (unit_id, agent_id, assignment_mode, priority)
             VALUES ($1::uuid, $2::uuid, 'active', 1)
             ON CONFLICT (unit_id, agent_id)
             DO UPDATE SET assignment_mode = 'active', priority = 1, updated_at = NOW()`,
            [unitId, payload.agentId]
          );
        } else {
          await client.query(
            `UPDATE "UnitAgentAssignments"
                SET assignment_mode = 'passive',
                    updated_at = NOW()
              WHERE unit_id = $1::uuid
                AND assignment_mode = 'active'`,
            [unitId]
          );
        }

        await client.query("COMMIT");

        return {
          ok: true,
          assignedAgentId: payload.agentId || null
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });

    if (response.error === "unit_not_found") {
      notFound(res);
      return;
    }
    if (response.error === "agent_not_found") {
      badRequest(res, "agentId does not exist");
      return;
    }

    json(res, 200, response);
    return;
  }

  const unitAgentsMatch = url.pathname.match(/^\/api\/units\/([0-9a-f\-]+)\/agents$/i);
  if (unitAgentsMatch) {
    const unitId = unitAgentsMatch[1];
    if (!isUuid(unitId)) {
      badRequest(res, "unitId must be a UUID");
      return;
    }

    if (req.method === "GET") {
      const access = await requireRole(req, res, [roles.agent, roles.admin]);
      if (!access) {
        return;
      }

      const items = await withClient((client) => fetchUnitAgentAssignments(client, unitId));
      json(res, 200, { items });
      return;
    }

    if (req.method === "PUT") {
      const access = await requireRole(req, res, [roles.admin]);
      if (!access) {
        return;
      }

      let payload;
      try {
        payload = await readJsonBody(req);
      } catch {
        badRequest(res, "Request body must be valid JSON");
        return;
      }

      const errors = validateUnitAgentAssignmentPayload(payload);
      if (errors.length > 0) {
        badRequest(res, "Invalid unit-agent assignment payload", errors);
        return;
      }

      let response;
      const withClientRunner = routeTestOverrides?.withClient || withClient;
      try {
        response = await withClientRunner((client) => upsertUnitAgentAssignment(client, unitId, payload));
      } catch (error) {
        if (error?.code === "23505") {
          badRequest(res, "priority already in use for active unit assignments");
          return;
        }
        throw error;
      }

      if (response.error === "unit_not_found") {
        notFound(res);
        return;
      }
      if (response.error === "agent_not_found") {
        badRequest(res, "agentId does not exist");
        return;
      }

      const items = await withClientRunner((client) => fetchUnitAgentAssignments(client, unitId));
      json(res, 200, { updated: true, items });
      return;
    }
  }

  const unitAgentByIdMatch = url.pathname.match(/^\/api\/units\/([0-9a-f\-]+)\/agents\/([0-9a-f\-]+)$/i);
  if (unitAgentByIdMatch && req.method === "DELETE") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    const unitId = unitAgentByIdMatch[1];
    const agentId = unitAgentByIdMatch[2];
    if (!isUuid(unitId) || !isUuid(agentId)) {
      badRequest(res, "unitId and agentId must be UUIDs");
      return;
    }

    const result = await pool.query(
      `DELETE FROM "UnitAgentAssignments"
        WHERE unit_id = $1::uuid
          AND agent_id = $2::uuid`,
      [unitId, agentId]
    );

    if (result.rowCount === 0) {
      notFound(res);
      return;
    }

    json(res, 200, { deleted: true });
    return;
  }

  const unitAgentCandidatesMatch = url.pathname.match(/^\/api\/units\/([0-9a-f\-]+)\/agent-slot-candidates$/i);
  if (unitAgentCandidatesMatch && req.method === "GET") {
    const access = await requireRole(req, res, [roles.agent, roles.admin]);
    if (!access) {
      return;
    }

    const unitId = unitAgentCandidatesMatch[1];
    if (!isUuid(unitId)) {
      badRequest(res, "unitId must be a UUID");
      return;
    }

    const fromDate = url.searchParams.get("fromDate");
    const toDate = url.searchParams.get("toDate");
    const timezone = url.searchParams.get("timezone");
    const includePassive = url.searchParams.get("includePassive") === "true";

    if (fromDate && !isDateString(fromDate)) {
      badRequest(res, "fromDate must be YYYY-MM-DD");
      return;
    }
    if (toDate && !isDateString(toDate)) {
      badRequest(res, "toDate must be YYYY-MM-DD");
      return;
    }
    if (timezone && !assertTimezone(timezone)) {
      badRequest(res, "timezone must be a valid IANA timezone");
      return;
    }

    const fetchCandidates = routeTestOverrides?.fetchUnitAgentSlotCandidates || fetchUnitAgentSlotCandidates;
    const withClientRunner = routeTestOverrides?.withClient || withClient;
    const items = await withClientRunner((client) => fetchCandidates(client, unitId, { fromDate, toDate, timezone, includePassive }));
    json(res, 200, { items });
    return;
  }

  if (url.pathname === "/api/showing-appointments" && req.method === "GET") {
    const access = await requireRole(req, res, [roles.agent, roles.admin]);
    if (!access) {
      return;
    }

    const status = url.searchParams.get("status");
    const unitId = url.searchParams.get("unitId");
    const fromDate = url.searchParams.get("fromDate");
    const toDate = url.searchParams.get("toDate");
    const timezone = url.searchParams.get("timezone");
    const agentIdParam = url.searchParams.get("agentId");

    if (status && !showingAppointmentStatuses.has(status)) {
      badRequest(res, "status must be one of pending, confirmed, reschedule_requested, cancelled, completed, no_show");
      return;
    }
    if (unitId && !isUuid(unitId)) {
      badRequest(res, "unitId must be a UUID");
      return;
    }
    if (fromDate && !isDateString(fromDate)) {
      badRequest(res, "fromDate must be YYYY-MM-DD");
      return;
    }
    if (toDate && !isDateString(toDate)) {
      badRequest(res, "toDate must be YYYY-MM-DD");
      return;
    }
    if (timezone && !assertTimezone(timezone)) {
      badRequest(res, "timezone must be a valid IANA timezone");
      return;
    }
    if (agentIdParam && !isUuid(agentIdParam)) {
      badRequest(res, "agentId must be a UUID");
      return;
    }

    let agentId = agentIdParam || null;
    if (access.role === roles.agent) {
      agentId = enforceAgentSelfScope(res, access, agentIdParam || null);
      if (!agentId) {
        return;
      }
    }

    const withClientRunner = routeTestOverrides?.withClient || withClient;
    const fetchShowingAppointmentsRunner = routeTestOverrides?.fetchShowingAppointments || fetchShowingAppointments;
    const items = await withClientRunner((client) =>
      fetchShowingAppointmentsRunner(client, {
        agentId,
        status,
        unitId,
        fromDate,
        toDate,
        timezone
      })
    );

    json(res, 200, { items });
    return;
  }

  if (url.pathname === "/api/showing-appointments/book" && req.method === "POST") {
    const access = await requireRole(req, res, [roles.agent, roles.admin]);
    if (!access) {
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      badRequest(res, "Request body must be valid JSON");
      return;
    }

    const errors = validateShowingBookingPayload(payload);
    if (errors.length > 0) {
      badRequest(res, "Invalid showing booking payload", errors);
      return;
    }

    if (access.role === roles.agent) {
      const scopedAgentId = enforceAgentSelfScope(res, access, payload.agentId);
      if (!scopedAgentId) {
        return;
      }
      payload.agentId = scopedAgentId;
    }

    const withClientRunner = routeTestOverrides?.withClient || withClient;
    const createShowingAppointmentRunner = routeTestOverrides?.createShowingAppointment || createShowingAppointment;
    const resolveBookingIdempotencyRunner = routeTestOverrides?.resolveShowingBookingIdempotency || resolveShowingBookingIdempotency;
    const fetchCandidates = routeTestOverrides?.fetchUnitAgentSlotCandidates || fetchUnitAgentSlotCandidates;
    const recordAuditLogRunner = routeTestOverrides?.recordAuditLog || recordAuditLog;

    const writeBookingAuditLog = async (action, details = {}) => {
      try {
        await withClientRunner((client) => {
          if (recordAuditLogRunner === recordAuditLog && typeof client?.query !== "function") {
            return null;
          }

          return recordAuditLogRunner(client, {
            actorType: access.role === roles.admin ? "admin" : "agent",
            actorId: access.session.user.id,
            entityType: "showing_appointment",
            entityId: String(details.appointmentId || payload.idempotencyKey),
            action,
            details: {
              idempotencyKey: payload.idempotencyKey,
              platformAccountId: payload.platformAccountId,
              conversationId: payload.conversationId || null,
              unitId: payload.unitId,
              listingId: payload.listingId || null,
              agentId: payload.agentId,
              startsAt: payload.startsAt,
              endsAt: payload.endsAt,
              timezone: payload.timezone,
              requestedStatus: payload.status || "confirmed",
              ...details
            }
          });
        });
      } catch (loggingError) {
        console.error("showing_booking_audit_log_failed", loggingError);
      }
    };

    let bookingResult;
    try {
      bookingResult = await withClientRunner((client) => {
        if (resolveBookingIdempotencyRunner === resolveShowingBookingIdempotency && typeof client?.query !== "function") {
          return null;
        }

        return resolveBookingIdempotencyRunner(client, payload);
      });

      if (!bookingResult) {
        const slotSelection = await withClientRunner((client) => validateBookingSlotSelection(client, payload, fetchCandidates));
        if (!slotSelection.ok) {
          await writeBookingAuditLog("showing_booking_slot_unavailable", {
            rejectionReason: "assignment_availability_conflict",
            alternativesCount: slotSelection.alternatives.length
          });
          json(res, 409, {
            error: "slot_unavailable",
            message: "Selected slot is not available for this agent assignment and availability window",
            alternatives: slotSelection.alternatives,
            adminReviewRequired: true
          });
          return;
        }

        bookingResult = await withClientRunner((client) => createShowingAppointmentRunner(client, payload));
      }
    } catch (error) {
      if (handleShowingConflictError(error)) {
        const date = payload.startsAt.slice(0, 10);
        const alternatives = await withClientRunner((client) =>
          fetchCandidates(client, payload.unitId, {
            fromDate: date,
            toDate: date,
            timezone: payload.timezone,
            includePassive: true
          })
        );

        await writeBookingAuditLog("showing_booking_conflict", {
          conflictType: "agent_time_overlap",
          alternativesCount: alternatives.length
        });

        json(res, 409, {
          error: "booking_conflict",
          message: "Agent already has a booking for the selected time range",
          alternatives,
          adminReviewRequired: true
        });
        return;
      }
      await writeBookingAuditLog("showing_booking_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }

    if (bookingResult?.error === "idempotency_payload_mismatch") {
      await writeBookingAuditLog("showing_booking_idempotency_conflict", {
        appointmentId: bookingResult.appointment?.id || null
      });
      json(res, 409, {
        error: "idempotency_conflict",
        message: "idempotencyKey was already used with different booking payload",
        existingAppointment: bookingResult.appointment,
        adminReviewRequired: true
      });
      return;
    }

    const statusCode = bookingResult?.idempotentReplay ? 200 : 201;
    await writeBookingAuditLog(bookingResult?.idempotentReplay ? "showing_booking_replayed" : "showing_booking_created", {
      appointmentId: bookingResult?.appointment?.id || null,
      appointmentStatus: bookingResult?.appointment?.status || null,
      idempotentReplay: Boolean(bookingResult?.idempotentReplay)
    });
    json(res, statusCode, {
      appointment: bookingResult.appointment,
      idempotentReplay: Boolean(bookingResult?.idempotentReplay)
    });
    return;
  }

  if (url.pathname === "/api/listings" && req.method === "GET") {
    const access = await requireRole(req, res, [roles.agent, roles.admin]);
    if (!access) {
      return;
    }

    const unitId = url.searchParams.get("unitId");
    if (unitId && !isUuid(unitId)) {
      badRequest(res, "unitId must be a UUID");
      return;
    }

    const includeInactive = url.searchParams.get("includeInactive") === "true";
    const onlyActivePlatform = !(includeInactive && access.role === roles.admin);

    const withClientRunner = routeTestOverrides?.withClient || withClient;
    const fetchListingsRunner = routeTestOverrides?.fetchListings || fetchListings;
    const items = await withClientRunner((client) => fetchListingsRunner(client, unitId, { onlyActivePlatform }));
    json(res, 200, { items });
    return;
  }

  if (url.pathname === "/api/listings/sync" && req.method === "POST") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    const platform = url.searchParams.get("platform");
    if (platform && !requiredPlatformSet.has(platform)) {
      badRequest(res, `platform must be one of ${requiredPlatforms.join(", ")}`);
      return;
    }

    const withClientRunner = routeTestOverrides?.withClient || withClient;
    const listingSyncPlatforms = process.env.LEASE_BOT_SYNC_LISTINGS_PLATFORMS
      ? process.env.LEASE_BOT_SYNC_LISTINGS_PLATFORMS.split(",").map((value) => value.trim()).filter(Boolean)
      : ["spareroom"];
    const result = await withClientRunner(async (client) => {
      const adapter = createPostgresQueueAdapter(client, { connectorRegistry });
      return adapter.syncPlatformListings({ platforms: platform ? [platform] : listingSyncPlatforms });
    });

    json(res, 200, result);
    return;
  }

  if (url.pathname === "/api/listings" && req.method === "POST") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      badRequest(res, "Request body must be valid JSON");
      return;
    }

    const errors = validateListingPayload(payload);
    if (errors.length > 0) {
      badRequest(res, "Invalid listing payload", errors);
      return;
    }

    const metadata = {
      ...(payload.metadata || {})
    };
    if (payload.assignedAgentId) {
      metadata.assignedAgentId = payload.assignedAgentId;
    }

    const result = await pool.query(
      `INSERT INTO "Listings" (
         unit_id,
         platform_account_id,
         listing_external_id,
         status,
         rent_cents,
         currency_code,
         available_on,
         metadata
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::date, $8::jsonb)
       RETURNING id`,
      [
        payload.unitId,
        payload.platformAccountId,
        payload.listingExternalId || null,
        payload.status || "active",
        payload.rentCents,
        payload.currencyCode || "USD",
        payload.availableOn || null,
        metadata
      ]
    );

    json(res, 201, { id: result.rows[0].id });
    return;
  }

  const listingMatch = url.pathname.match(/^\/api\/listings\/([0-9a-f\-]+)$/i);
  if (listingMatch) {
    const listingId = listingMatch[1];
    if (!isUuid(listingId)) {
      badRequest(res, "listingId must be a UUID");
      return;
    }

    if (req.method === "GET") {
      const access = await requireRole(req, res, [roles.agent, roles.admin]);
      if (!access) {
        return;
      }

      const result = await pool.query(
        `SELECT l.id,
                l.unit_id,
                l.platform_account_id,
                l.listing_external_id,
                l.status,
                l.rent_cents,
                l.currency_code,
                l.available_on,
                l.metadata,
                pa.is_active AS platform_is_active,
                pa.send_mode AS platform_send_mode,
                pa.integration_mode AS platform_integration_mode,
                l.created_at,
                l.updated_at
           FROM "Listings" l
           JOIN "PlatformAccounts" pa ON pa.id = l.platform_account_id
          WHERE l.id = $1::uuid`,
        [listingId]
      );
      if (result.rowCount === 0) {
        notFound(res);
        return;
      }

      const row = result.rows[0];
      json(res, 200, {
        id: row.id,
        unitId: row.unit_id,
        platformAccountId: row.platform_account_id,
        listingExternalId: row.listing_external_id,
        status: row.status,
        rentCents: row.rent_cents,
        currencyCode: row.currency_code,
        availableOn: row.available_on,
        metadata: row.metadata || {},
        assignedAgentId: row.metadata?.assignedAgentId || null,
        platformPolicy: {
          isActive: row.platform_is_active,
          integrationMode: row.platform_integration_mode,
          sendMode: row.platform_send_mode || globalDefaultSendMode,
          sendModeOverride: row.platform_send_mode,
          globalDefaultSendMode
        },
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
      return;
    }

    if (req.method === "PUT") {
      const access = await requireRole(req, res, [roles.admin]);
      if (!access) {
        return;
      }

      let payload;
      try {
        payload = await readJsonBody(req);
      } catch {
        badRequest(res, "Request body must be valid JSON");
        return;
      }

      const errors = validateListingPayload(payload, { partial: true });
      if (errors.length > 0) {
        badRequest(res, "Invalid listing payload", errors);
        return;
      }

      const currentResult = await pool.query(`SELECT metadata FROM "Listings" WHERE id = $1::uuid`, [listingId]);
      if (currentResult.rowCount === 0) {
        notFound(res);
        return;
      }

      const metadata = {
        ...(currentResult.rows[0].metadata || {}),
        ...(payload.metadata || {})
      };
      if (payload.assignedAgentId === null) {
        delete metadata.assignedAgentId;
      } else if (payload.assignedAgentId) {
        metadata.assignedAgentId = payload.assignedAgentId;
      }

      await pool.query(
        `UPDATE "Listings"
            SET unit_id = COALESCE($2::uuid, unit_id),
                platform_account_id = COALESCE($3::uuid, platform_account_id),
                listing_external_id = COALESCE($4, listing_external_id),
                status = COALESCE($5, status),
                rent_cents = COALESCE($6, rent_cents),
                currency_code = COALESCE($7, currency_code),
                available_on = COALESCE($8::date, available_on),
                metadata = $9::jsonb,
                updated_at = NOW()
          WHERE id = $1::uuid`,
        [
          listingId,
          payload.unitId || null,
          payload.platformAccountId || null,
          payload.listingExternalId !== undefined ? payload.listingExternalId : null,
          payload.status || null,
          payload.rentCents || null,
          payload.currencyCode || null,
          payload.availableOn || null,
          metadata
        ]
      );

      json(res, 200, { updated: true });
      return;
    }

    if (req.method === "DELETE") {
      const access = await requireRole(req, res, [roles.admin]);
      if (!access) {
        return;
      }

      const result = await pool.query(`DELETE FROM "Listings" WHERE id = $1::uuid`, [listingId]);
      if (result.rowCount === 0) {
        notFound(res);
        return;
      }

      json(res, 200, { deleted: true });
      return;
    }
  }

  const availabilityListMatch = url.pathname.match(/^\/api\/units\/([0-9a-f\-]+)\/availability$/i);
  if (availabilityListMatch && req.method === "GET") {
    const access = await requireRole(req, res, [roles.agent, roles.admin]);
    if (!access) {
      return;
    }

    const unitId = availabilityListMatch[1];
    if (!isUuid(unitId)) {
      badRequest(res, "unitId must be a UUID");
      return;
    }

    const fromDate = url.searchParams.get("fromDate");
    const toDate = url.searchParams.get("toDate");
    const timezone = url.searchParams.get("timezone");

    if (fromDate && !isDateString(fromDate)) {
      badRequest(res, "fromDate must be YYYY-MM-DD");
      return;
    }
    if (toDate && !isDateString(toDate)) {
      badRequest(res, "toDate must be YYYY-MM-DD");
      return;
    }
    if (timezone && !assertTimezone(timezone)) {
      badRequest(res, "timezone must be a valid IANA timezone");
      return;
    }

    const items = await withClient((client) => fetchAvailability(client, unitId, { fromDate, toDate, timezone }));
    json(res, 200, { items });
    return;
  }

  const weeklyRulesMatch = url.pathname.match(/^\/api\/units\/([0-9a-f\-]+)\/availability\/weekly-rules$/i);
  if (weeklyRulesMatch) {
    const unitId = weeklyRulesMatch[1];
    if (!isUuid(unitId)) {
      badRequest(res, "unitId must be a UUID");
      return;
    }

    if (req.method === "GET") {
      const access = await requireRole(req, res, [roles.agent, roles.admin]);
      if (!access) {
        return;
      }

      const items = await withClient((client) => fetchWeeklyRules(client, unitId));
      json(res, 200, { items });
      return;
    }

    if (req.method === "POST") {
      const access = await requireRole(req, res, [roles.admin]);
      if (!access) {
        return;
      }

      let payload;
      try {
        payload = await readJsonBody(req);
      } catch {
        badRequest(res, "Request body must be valid JSON");
        return;
      }

      const errors = validateWeeklyRulePayload(payload);
      if (errors.length > 0) {
        badRequest(res, "Invalid weekly recurring payload", errors);
        return;
      }

      let result;
      try {
        result = await withClient((client) => upsertWeeklyRule(client, unitId, payload));
      } catch (error) {
        if (handleLocalTimeValidationError(res, error)) {
          return;
        }
        throw error;
      }

      json(res, 201, result);
      return;
    }
  }

  const weeklyRuleByIdMatch = url.pathname.match(/^\/api\/units\/([0-9a-f\-]+)\/availability\/weekly-rules\/([0-9a-f\-]+)$/i);
  if (weeklyRuleByIdMatch) {
    const unitId = weeklyRuleByIdMatch[1];
    const ruleId = weeklyRuleByIdMatch[2];

    if (!isUuid(unitId) || !isUuid(ruleId)) {
      badRequest(res, "unitId and ruleId must be UUIDs");
      return;
    }

    if (req.method === "PUT") {
      const access = await requireRole(req, res, [roles.admin]);
      if (!access) {
        return;
      }

      let payload;
      try {
        payload = await readJsonBody(req);
      } catch {
        badRequest(res, "Request body must be valid JSON");
        return;
      }

      const errors = validateWeeklyRulePayload(payload);
      if (errors.length > 0) {
        badRequest(res, "Invalid weekly recurring payload", errors);
        return;
      }

      let result;
      try {
        result = await withClient((client) => upsertWeeklyRule(client, unitId, payload, ruleId));
      } catch (error) {
        if (handleLocalTimeValidationError(res, error)) {
          return;
        }
        throw error;
      }

      json(res, 200, result);
      return;
    }

    if (req.method === "DELETE") {
      const access = await requireRole(req, res, [roles.admin]);
      if (!access) {
        return;
      }

      const result = await pool.query(
        `DELETE FROM "AvailabilitySlots"
          WHERE unit_id = $1::uuid
            AND source = 'weekly_recurring'
            AND notes LIKE $2`,
        [unitId, `rule:${ruleId}%`]
      );

      json(res, 200, { deletedSlots: result.rowCount });
      return;
    }
  }

  const dailyOverrideMatch = url.pathname.match(/^\/api\/units\/([0-9a-f\-]+)\/availability\/daily-overrides$/i);
  if (dailyOverrideMatch && req.method === "POST") {
    const access = await requireRole(req, res, [roles.admin]);
    if (!access) {
      return;
    }

    const unitId = dailyOverrideMatch[1];
    if (!isUuid(unitId)) {
      badRequest(res, "unitId must be a UUID");
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      badRequest(res, "Request body must be valid JSON");
      return;
    }

    const errors = validateDailyOverridePayload(payload);
    if (errors.length > 0) {
      badRequest(res, "Invalid daily override payload", errors);
      return;
    }

    let startsAt;
    let endsAt;
    try {
      startsAt = zonedTimeToUtc(payload.date, payload.startTime, payload.timezone);
      endsAt = zonedTimeToUtc(payload.date, payload.endTime, payload.timezone);
    } catch (error) {
      if (handleLocalTimeValidationError(res, error)) {
        return;
      }
      throw error;
    }

    const result = await pool.query(
      `INSERT INTO "AvailabilitySlots" (
         unit_id,
         listing_id,
         starts_at,
         ends_at,
         timezone,
         status,
         source,
         notes
       ) VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz, $5, $6, 'daily_override', $7)
       RETURNING id`,
      [
        unitId,
        payload.listingId || null,
        startsAt.toISOString(),
        endsAt.toISOString(),
        payload.timezone,
        payload.status || "open",
        payload.notes || null
      ]
    );

    json(res, 201, { id: result.rows[0].id });
    return;
  }

  const availabilityByIdMatch = url.pathname.match(/^\/api\/availability\/([0-9a-f\-]+)$/i);
  if (availabilityByIdMatch) {
    const slotId = availabilityByIdMatch[1];
    if (!isUuid(slotId)) {
      badRequest(res, "slotId must be a UUID");
      return;
    }

    if (req.method === "PUT") {
      const access = await requireRole(req, res, [roles.admin]);
      if (!access) {
        return;
      }

      let payload;
      try {
        payload = await readJsonBody(req);
      } catch {
        badRequest(res, "Request body must be valid JSON");
        return;
      }

      const isWeekly = payload.source === "weekly_recurring";
      const errors = isWeekly ? validateWeeklyRulePayload(payload) : validateDailyOverridePayload(payload);
      if (errors.length > 0) {
        badRequest(res, "Invalid availability payload", errors);
        return;
      }

      let startsAt;
      let endsAt;
      try {
        startsAt = isWeekly
          ? zonedTimeToUtc(payload.fromDate || payload.date, payload.startTime, payload.timezone)
          : zonedTimeToUtc(payload.date, payload.startTime, payload.timezone);
        endsAt = isWeekly
          ? zonedTimeToUtc(payload.fromDate || payload.date, payload.endTime, payload.timezone)
          : zonedTimeToUtc(payload.date, payload.endTime, payload.timezone);
      } catch (error) {
        if (handleLocalTimeValidationError(res, error)) {
          return;
        }
        throw error;
      }

      const result = await pool.query(
        `UPDATE "AvailabilitySlots"
            SET listing_id = COALESCE($2::uuid, listing_id),
                starts_at = $3::timestamptz,
                ends_at = $4::timestamptz,
                timezone = $5,
                status = COALESCE($6, status),
                notes = COALESCE($7, notes)
          WHERE id = $1::uuid`,
        [
          slotId,
          payload.listingId || null,
          startsAt.toISOString(),
          endsAt.toISOString(),
          payload.timezone,
          payload.status || null,
          payload.notes || null
        ]
      );

      if (result.rowCount === 0) {
        notFound(res);
        return;
      }

      json(res, 200, { updated: true });
      return;
    }

    if (req.method === "DELETE") {
      const access = await requireRole(req, res, [roles.admin]);
      if (!access) {
        return;
      }

      const result = await pool.query(`DELETE FROM "AvailabilitySlots" WHERE id = $1::uuid`, [slotId]);
      if (result.rowCount === 0) {
        notFound(res);
        return;
      }

      json(res, 200, { deleted: true });
      return;
    }
  }

  const agentAvailabilityListMatch = url.pathname.match(/^\/api\/agents\/([0-9a-f\-]+)\/availability$/i);
  if (agentAvailabilityListMatch && req.method === "GET") {
    const access = await requireRole(req, res, [roles.agent, roles.admin]);
    if (!access) {
      return;
    }

    const agentId = agentAvailabilityListMatch[1];
    if (!isUuid(agentId)) {
      badRequest(res, "agentId must be a UUID");
      return;
    }
    const scopedAgentId = enforceAgentSelfScope(res, access, agentId);
    if (!scopedAgentId) {
      return;
    }

    const fromDate = url.searchParams.get("fromDate");
    const toDate = url.searchParams.get("toDate");
    const timezone = url.searchParams.get("timezone");

    if (fromDate && !isDateString(fromDate)) {
      badRequest(res, "fromDate must be YYYY-MM-DD");
      return;
    }
    if (toDate && !isDateString(toDate)) {
      badRequest(res, "toDate must be YYYY-MM-DD");
      return;
    }
    if (timezone && !assertTimezone(timezone)) {
      badRequest(res, "timezone must be a valid IANA timezone");
      return;
    }

    const items = await withClient((client) => fetchAgentAvailability(client, scopedAgentId, { fromDate, toDate, timezone }));
    json(res, 200, { items });
    return;
  }

  const agentWeeklyRulesMatch = url.pathname.match(/^\/api\/agents\/([0-9a-f\-]+)\/availability\/weekly-rules$/i);
  if (agentWeeklyRulesMatch) {
    const agentId = agentWeeklyRulesMatch[1];
    if (!isUuid(agentId)) {
      badRequest(res, "agentId must be a UUID");
      return;
    }

    if (req.method === "GET") {
      const access = await requireRole(req, res, [roles.agent, roles.admin]);
      if (!access) {
        return;
      }
      const scopedAgentId = enforceAgentSelfScope(res, access, agentId);
      if (!scopedAgentId) {
        return;
      }
      const items = await withClient((client) => fetchAgentWeeklyRules(client, scopedAgentId));
      json(res, 200, { items });
      return;
    }

    if (req.method === "POST") {
      const access = await requireRole(req, res, [roles.agent, roles.admin]);
      if (!access) {
        return;
      }
      const scopedAgentId = enforceAgentSelfScope(res, access, agentId);
      if (!scopedAgentId) {
        return;
      }

      let payload;
      try {
        payload = await readJsonBody(req);
      } catch {
        badRequest(res, "Request body must be valid JSON");
        return;
      }

      const errors = validateAgentWeeklyAvailabilityPayload(payload);
      if (errors.length > 0) {
        badRequest(res, "Invalid agent weekly recurring payload", errors);
        return;
      }

      let result;
      try {
        result = await withClient((client) => upsertAgentWeeklyRule(client, scopedAgentId, payload));
      } catch (error) {
        if (handleLocalTimeValidationError(res, error)) {
          return;
        }
        if (handleAvailabilityConflictError(res, error, "Conflicting agent weekly availability")) {
          return;
        }
        throw error;
      }

      json(res, 201, result);
      return;
    }
  }

  const agentWeeklyRuleByIdMatch = url.pathname.match(/^\/api\/agents\/([0-9a-f\-]+)\/availability\/weekly-rules\/([0-9a-f\-]+)$/i);
  if (agentWeeklyRuleByIdMatch) {
    const agentId = agentWeeklyRuleByIdMatch[1];
    const ruleId = agentWeeklyRuleByIdMatch[2];

    if (!isUuid(agentId) || !isUuid(ruleId)) {
      badRequest(res, "agentId and ruleId must be UUIDs");
      return;
    }

    if (req.method === "PUT") {
      const access = await requireRole(req, res, [roles.agent, roles.admin]);
      if (!access) {
        return;
      }
      const scopedAgentId = enforceAgentSelfScope(res, access, agentId);
      if (!scopedAgentId) {
        return;
      }

      let payload;
      try {
        payload = await readJsonBody(req);
      } catch {
        badRequest(res, "Request body must be valid JSON");
        return;
      }

      const errors = validateAgentWeeklyAvailabilityPayload(payload);
      if (errors.length > 0) {
        badRequest(res, "Invalid agent weekly recurring payload", errors);
        return;
      }

      let result;
      try {
        result = await withClient((client) => upsertAgentWeeklyRule(client, scopedAgentId, payload, ruleId));
      } catch (error) {
        if (handleLocalTimeValidationError(res, error)) {
          return;
        }
        if (handleAvailabilityConflictError(res, error, "Conflicting agent weekly availability")) {
          return;
        }
        throw error;
      }

      json(res, 200, result);
      return;
    }

    if (req.method === "DELETE") {
      const access = await requireRole(req, res, [roles.agent, roles.admin]);
      if (!access) {
        return;
      }
      const scopedAgentId = enforceAgentSelfScope(res, access, agentId);
      if (!scopedAgentId) {
        return;
      }

      const result = await pool.query(
        `DELETE FROM "AgentAvailabilitySlots"
          WHERE agent_id = $1::uuid
            AND source = 'weekly_recurring'
            AND notes LIKE $2`,
        [scopedAgentId, `rule:${ruleId}%`]
      );

      json(res, 200, { deletedSlots: result.rowCount });
      return;
    }
  }

  const agentDailyOverrideMatch = url.pathname.match(/^\/api\/agents\/([0-9a-f\-]+)\/availability\/daily-overrides$/i);
  if (agentDailyOverrideMatch && req.method === "POST") {
    const access = await requireRole(req, res, [roles.agent, roles.admin]);
    if (!access) {
      return;
    }

    const agentId = agentDailyOverrideMatch[1];
    if (!isUuid(agentId)) {
      badRequest(res, "agentId must be a UUID");
      return;
    }
    const scopedAgentId = enforceAgentSelfScope(res, access, agentId);
    if (!scopedAgentId) {
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      badRequest(res, "Request body must be valid JSON");
      return;
    }

    const errors = validateAgentDailyOverridePayload(payload);
    if (errors.length > 0) {
      badRequest(res, "Invalid agent daily override payload", errors);
      return;
    }

    let startsAt;
    let endsAt;
    try {
      startsAt = zonedTimeToUtc(payload.date, payload.startTime, payload.timezone);
      endsAt = zonedTimeToUtc(payload.date, payload.endTime, payload.timezone);
    } catch (error) {
      if (handleLocalTimeValidationError(res, error)) {
        return;
      }
      throw error;
    }

    let result;
    try {
      result = await pool.query(
        `INSERT INTO "AgentAvailabilitySlots" (
           agent_id,
           starts_at,
           ends_at,
           timezone,
           status,
           source,
           notes
         ) VALUES ($1::uuid, $2::timestamptz, $3::timestamptz, $4, $5, 'daily_override', $6)
         RETURNING id`,
        [
          scopedAgentId,
          startsAt.toISOString(),
          endsAt.toISOString(),
          payload.timezone,
          payload.status || "available",
          payload.notes || null
        ]
      );
    } catch (error) {
      if (handleAvailabilityConflictError(res, error, "Conflicting agent daily override")) {
        return;
      }
      throw error;
    }

    json(res, 201, { id: result.rows[0].id });
    return;
  }

  const agentAvailabilityByIdMatch = url.pathname.match(/^\/api\/agent-availability\/([0-9a-f\-]+)$/i);
  if (agentAvailabilityByIdMatch) {
    const slotId = agentAvailabilityByIdMatch[1];
    if (!isUuid(slotId)) {
      badRequest(res, "slotId must be a UUID");
      return;
    }

    if (req.method === "PUT") {
      const access = await requireRole(req, res, [roles.agent, roles.admin]);
      if (!access) {
        return;
      }
      if (access.role === roles.agent) {
        const ownerAgentId = await withClient((client) => fetchAgentAvailabilitySlotOwner(client, slotId));
        if (!ownerAgentId) {
          notFound(res);
          return;
        }
        const scopedAgentId = enforceAgentSelfScope(res, access, ownerAgentId);
        if (!scopedAgentId) {
          return;
        }
      }

      let payload;
      try {
        payload = await readJsonBody(req);
      } catch {
        badRequest(res, "Request body must be valid JSON");
        return;
      }

      const isWeekly = payload.source === "weekly_recurring";
      const errors = isWeekly ? validateAgentWeeklyAvailabilityPayload(payload) : validateAgentDailyOverridePayload(payload);
      if (errors.length > 0) {
        badRequest(res, "Invalid agent availability payload", errors);
        return;
      }

      let startsAt;
      let endsAt;
      try {
        startsAt = isWeekly
          ? zonedTimeToUtc(payload.fromDate || payload.date, payload.startTime, payload.timezone)
          : zonedTimeToUtc(payload.date, payload.startTime, payload.timezone);
        endsAt = isWeekly
          ? zonedTimeToUtc(payload.fromDate || payload.date, payload.endTime, payload.timezone)
          : zonedTimeToUtc(payload.date, payload.endTime, payload.timezone);
      } catch (error) {
        if (handleLocalTimeValidationError(res, error)) {
          return;
        }
        throw error;
      }

      let result;
      try {
        result = await pool.query(
          `UPDATE "AgentAvailabilitySlots"
              SET starts_at = $2::timestamptz,
                  ends_at = $3::timestamptz,
                  timezone = $4,
                  status = COALESCE($5, status),
                  notes = COALESCE($6, notes)
            WHERE id = $1::uuid`,
          [
            slotId,
            startsAt.toISOString(),
            endsAt.toISOString(),
            payload.timezone,
            payload.status || null,
            payload.notes || null
          ]
        );
      } catch (error) {
        if (handleAvailabilityConflictError(res, error, "Conflicting agent availability update")) {
          return;
        }
        throw error;
      }

      if (result.rowCount === 0) {
        notFound(res);
        return;
      }

      json(res, 200, { updated: true });
      return;
    }

    if (req.method === "DELETE") {
      const access = await requireRole(req, res, [roles.agent, roles.admin]);
      if (!access) {
        return;
      }
      if (access.role === roles.agent) {
        const ownerAgentId = await withClient((client) => fetchAgentAvailabilitySlotOwner(client, slotId));
        if (!ownerAgentId) {
          notFound(res);
          return;
        }
        const scopedAgentId = enforceAgentSelfScope(res, access, ownerAgentId);
        if (!scopedAgentId) {
          return;
        }
      }

      const result = await pool.query(`DELETE FROM "AgentAvailabilitySlots" WHERE id = $1::uuid`, [slotId]);
      if (result.rowCount === 0) {
        notFound(res);
        return;
      }

      json(res, 200, { deleted: true });
      return;
    }
  }

  notFound(res);
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (!allowPublicSignup && url.pathname.startsWith("/api/auth/sign-up")) {
    json(res, 403, {
      error: "registration_disabled",
      message: "Self-registration is disabled. Ask an admin for an invite."
    });
    return;
  }

  if (url.pathname.startsWith("/api/auth")) {
    authHandler(req, res);
    return;
  }

  if (req.url === "/health" && req.method === "GET") {
    json(res, 200, {
      status: "ok",
      service: "api",
      timestamp: new Date().toISOString()
    });
    return;
  }

  try {
    await routeApi(req, res, url);
  } catch (error) {
    console.error("api_error", error);
    try {
      await withClient((client) =>
        recordAuditLog(client, {
          actorType: "system",
          entityType: "request",
          entityId: `${req.method || "UNKNOWN"} ${url.pathname}`,
          action: "api_error",
          details: {
            method: req.method,
            path: url.pathname,
            query: Object.fromEntries(url.searchParams.entries()),
            error: error instanceof Error ? error.message : String(error)
          }
        })
      );
    } catch (loggingError) {
      console.error("api_error_audit_log_failed", loggingError);
    }
    json(res, 500, {
      error: "internal_error",
      message: "Unexpected server error"
    });
  }
});

if (process.env.NODE_ENV !== "test") {
  const bootstrapTasks = [];
  const listingSyncEnabled = process.env.LEASE_BOT_SYNC_LISTINGS_ON_START === "1";
  const listingSyncPlatforms = process.env.LEASE_BOT_SYNC_LISTINGS_PLATFORMS
    ? process.env.LEASE_BOT_SYNC_LISTINGS_PLATFORMS.split(",").map((value) => value.trim()).filter(Boolean)
    : ["spareroom"];
  const listingSyncIntervalMs = Number(process.env.LEASE_BOT_SYNC_LISTINGS_INTERVAL_MS || 180000);
  let listingSyncInFlight = false;

  const runListingSync = async (trigger) => {
    try {
      const result = await withClient(async (client) => {
        const adapter = createPostgresQueueAdapter(client, { connectorRegistry });
        return adapter.syncPlatformListings({ platforms: listingSyncPlatforms });
      });
      console.log("[bootstrap] platform listings synced", {
        trigger,
        platforms: listingSyncPlatforms,
        scanned: result?.scanned ?? null,
        upsertedUnits: result?.upsertedUnits ?? null,
        upsertedListings: result?.upsertedListings ?? null
      });
    } catch (error) {
      console.warn("[bootstrap] failed syncing platform listings", {
        trigger,
        platforms: listingSyncPlatforms,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const platformBootstrapEnabled = process.env.LEASE_BOT_BOOTSTRAP_PLATFORM_ACCOUNTS !== "0";
  if (platformBootstrapEnabled) {
    bootstrapTasks.push(
      ensureRequiredPlatformAccounts(pool, { env: process.env, logger: console }).catch((error) => {
        console.warn("[bootstrap] failed ensuring required platform accounts", {
          error: error instanceof Error ? error.message : String(error)
        });
      })
    );
  }

  bootstrapTasks.push(
    ensureDevTestData(pool, { env: process.env, logger: console }).catch((error) => {
      console.warn("[bootstrap] failed ensuring dev test data", {
        error: error instanceof Error ? error.message : String(error)
      });
    })
  );

  bootstrapTasks.push(
    ensureDevAdminUser(pool, auth, { env: process.env, logger: console }).catch((error) => {
      console.warn("[bootstrap] failed ensuring dev admin", {
        error: error instanceof Error ? error.message : String(error)
      });
    })
  );

  if (listingSyncEnabled) {
    bootstrapTasks.push(runListingSync("startup"));
  }

  Promise.allSettled(bootstrapTasks).finally(() => {
    server.listen(port, host, () => {
      console.log(`api listening on http://${host}:${port}`);
    });

    if (listingSyncEnabled && Number.isFinite(listingSyncIntervalMs) && listingSyncIntervalMs > 0) {
      const timer = setInterval(async () => {
        if (listingSyncInFlight) {
          return;
        }
        listingSyncInFlight = true;
        try {
          await runListingSync("interval");
        } finally {
          listingSyncInFlight = false;
        }
      }, listingSyncIntervalMs);

      if (typeof timer.unref === "function") {
        timer.unref();
      }

      console.log("[bootstrap] listing sync interval enabled", {
        platforms: listingSyncPlatforms,
        intervalMs: listingSyncIntervalMs
      });
    }
  });
}

export function setRouteTestOverrides(overrides = {}) {
  routeTestOverrides = {
    ...(routeTestOverrides || {}),
    ...overrides
  };
}

export function resetRouteTestOverrides() {
  routeTestOverrides = null;
}

export const __testables = {
  fetchUnitAgentSlotCandidates,
  fetchPlatformHealthSnapshot,
  collectGuardrailReviewReasons
};

export { server };
