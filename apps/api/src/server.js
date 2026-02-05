import http from "node:http";
import { randomUUID } from "node:crypto";
import { toNodeHandler } from "better-auth/node";
import { Pool } from "pg";

import { getAuth, hasAnyRole, normalizeRole, roles } from "@lease-bot/auth";
import { LocalTimeValidationError, formatInTimezone, zonedTimeToUtc } from "./availability-timezone.js";
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

const allowedOrigins = new Set(
  (process.env.BETTER_AUTH_TRUSTED_ORIGINS || process.env.WEB_BASE_URL || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

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

function badRequest(res, message, details = null) {
  json(res, 400, {
    error: "validation_error",
    message,
    details
  });
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
     VALUES ($1, $2::uuid, $3, $4, $5, $6::jsonb)`,
    [actorType, actorId, entityType, String(entityId), action, JSON.stringify(details)]
  );
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
            assignment.assigned_agent_id
       FROM "Units" u
       LEFT JOIN LATERAL (
         SELECT l.metadata->>'assignedAgentId' AS assigned_agent_id
           FROM "Listings" l
          WHERE l.unit_id = u.id
          ORDER BY l.updated_at DESC
          LIMIT 1
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
    assignedAgentId: row.assigned_agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

async function fetchListings(client, unitId = null) {
  const result = await client.query(
    `SELECT l.id,
            l.unit_id,
            l.platform_account_id,
            l.listing_external_id,
            l.status,
            l.rent_cents,
            l.currency_code,
            l.available_on,
            l.metadata,
            l.created_at,
            l.updated_at
       FROM "Listings" l
      WHERE ($1::uuid IS NULL OR l.unit_id = $1::uuid)
      ORDER BY l.updated_at DESC`,
    [unitId]
  );

  return result.rows.map((row) => ({
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

function handleLocalTimeValidationError(res, error) {
  if (!(error instanceof LocalTimeValidationError)) {
    return false;
  }

  badRequest(res, "Invalid local time for timezone transition", [
    `${error.details.date} ${error.details.time} is not a valid local time in ${error.details.timezone}`
  ]);
  return true;
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

async function fetchInboxList(client, statusFilter = null) {
  const result = await client.query(
    `SELECT c.id,
            c.platform_account_id,
            c.listing_id,
            c.assigned_agent_id,
            c.external_thread_id,
            c.lead_name,
            c.lead_contact,
            c.status AS conversation_status,
            c.last_message_at,
            c.updated_at,
            u.property_name,
            u.unit_number,
            latest.body AS latest_body,
            latest.direction AS latest_direction,
            latest.metadata AS latest_metadata,
            COALESCE(counts.new_count, 0) AS new_count,
            COALESCE(counts.draft_count, 0) AS draft_count,
            COALESCE(counts.hold_count, 0) AS hold_count,
            COALESCE(counts.sent_count, 0) AS sent_count
       FROM "Conversations" c
       LEFT JOIN "Listings" l ON l.id = c.listing_id
       LEFT JOIN "Units" u ON u.id = l.unit_id
       LEFT JOIN LATERAL (
         SELECT m.body, m.direction, m.metadata
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
      ORDER BY c.last_message_at DESC NULLS LAST, c.updated_at DESC`
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
      listingId: row.listing_id,
      assignedAgentId: row.assigned_agent_id,
      externalThreadId: row.external_thread_id,
      leadName: row.lead_name,
      leadContact: row.lead_contact || {},
      conversationStatus: row.conversation_status,
      messageStatus: summarizeConversationStatus(counts),
      counts,
      unit: row.property_name && row.unit_number ? `${row.property_name} ${row.unit_number}` : null,
      latestMessage: row.latest_body,
      latestDirection: row.latest_direction,
      latestStatus: normalizeMessageStatus(row.latest_direction, row.latest_metadata || {}),
      lastMessageAt: row.last_message_at,
      updatedAt: row.updated_at
    };
  });

  if (!statusFilter) {
    return items;
  }
  return items.filter((item) => item.messageStatus === statusFilter);
}

async function fetchConversationDetail(client, conversationId) {
  const conversationResult = await client.query(
    `SELECT c.id,
            c.platform_account_id,
            c.listing_id,
            c.assigned_agent_id,
            c.external_thread_id,
            c.lead_name,
            c.lead_contact,
            c.status,
            c.last_message_at,
            c.updated_at,
            u.property_name,
            u.unit_number,
            u.id AS unit_id
       FROM "Conversations" c
       LEFT JOIN "Listings" l ON l.id = c.listing_id
       LEFT JOIN "Units" u ON u.id = l.unit_id
      WHERE c.id = $1::uuid
      LIMIT 1`,
    [conversationId]
  );

  if (conversationResult.rowCount === 0) {
    return null;
  }

  const conversation = conversationResult.rows[0];

  const messagesResult = await client.query(
    `SELECT id,
            conversation_id,
            sender_type,
            sender_agent_id,
            direction,
            body,
            metadata,
            sent_at,
            created_at
       FROM "Messages"
      WHERE conversation_id = $1::uuid
      ORDER BY sent_at ASC, created_at ASC`,
    [conversationId]
  );

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

  let nextSlot = null;
  if (conversation.unit_id) {
    const slotResult = await client.query(
      `SELECT starts_at, ends_at, timezone
         FROM "AvailabilitySlots"
        WHERE unit_id = $1::uuid
          AND status = 'open'
          AND starts_at >= NOW()
        ORDER BY starts_at ASC
        LIMIT 1`,
      [conversation.unit_id]
    );

    if (slotResult.rowCount > 0) {
      const slot = slotResult.rows[0];
      const timezone = slot.timezone || "UTC";
      nextSlot = `${formatInTimezone(slot.starts_at, timezone)} - ${formatInTimezone(slot.ends_at, timezone)} ${timezone}`;
    }
  }

  const templateContext = {
    unit: conversation.property_name && conversation.unit_number ? `${conversation.property_name} ${conversation.unit_number}` : "",
    slot: nextSlot || ""
  };

  return {
    conversation: {
      id: conversation.id,
      platformAccountId: conversation.platform_account_id,
      listingId: conversation.listing_id,
      assignedAgentId: conversation.assigned_agent_id,
      externalThreadId: conversation.external_thread_id,
      leadName: conversation.lead_name,
      leadContact: conversation.lead_contact || {},
      status: conversation.status,
      unit: templateContext.unit,
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

    const withClientRunner = routeTestOverrides?.withClient || withClient;
    const fetchObservabilitySnapshotRunner = routeTestOverrides?.fetchObservabilitySnapshot || fetchObservabilitySnapshot;

    const snapshot = await withClientRunner((client) =>
      fetchObservabilitySnapshotRunner(client, {
        windowHours,
        auditLimit,
        errorLimit
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
    const access = await requireRole(req, res, [roles.agent, roles.admin]);
    if (!access) {
      return;
    }

    const status = url.searchParams.get("status");
    if (status && !["new", "draft", "sent", "hold"].includes(status)) {
      badRequest(res, "status must be one of new, draft, sent, hold");
      return;
    }

    const items = await withClient((client) => fetchInboxList(client, status));
    json(res, 200, { items });
    return;
  }

  const inboxConversationMatch = url.pathname.match(/^\/api\/inbox\/([0-9a-f\-]+)$/i);
  if (inboxConversationMatch && req.method === "GET") {
    const access = await requireRole(req, res, [roles.agent, roles.admin]);
    if (!access) {
      return;
    }

    const conversationId = inboxConversationMatch[1];
    if (!isUuid(conversationId)) {
      badRequest(res, "conversationId must be a UUID");
      return;
    }

    const payload = await withClient((client) => fetchConversationDetail(client, conversationId));
    if (!payload) {
      notFound(res);
      return;
    }

    json(res, 200, payload);
    return;
  }

  const inboxDraftMatch = url.pathname.match(/^\/api\/inbox\/([0-9a-f\-]+)\/draft$/i);
  if (inboxDraftMatch && req.method === "POST") {
    const access = await requireRole(req, res, [roles.agent, roles.admin]);
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

    let result;
    try {
      result = await withClient(async (client) => {
        const detail = await fetchConversationDetail(client, conversationId);
        if (!detail) {
          return { error: "not_found" };
        }

        const rule = await fetchAutoSendRule(client, detail.conversation.platformAccountId);
        const autoSendEnabled = Boolean(rule?.enabled);

        let messageBody = payload.body;
        let templateId = null;
        if (payload.templateId) {
          if (!isUuid(payload.templateId)) {
            return { error: "template_id_invalid" };
          }
          const template = detail.templates.find((item) => item.id === payload.templateId);
          if (!template) {
            return { error: "template_not_found" };
          }
          templateId = template.id;
          const context = {
            ...detail.templateContext,
            ...(payload.variables && typeof payload.variables === "object" ? payload.variables : {})
          };
          messageBody = renderTemplate(template.body, context);
        }

        if (typeof messageBody !== "string" || messageBody.trim().length < 1) {
          return { error: "body_required" };
        }

        const status = autoSendEnabled ? "sent" : "draft";
        const metadata = {
          ...(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}),
          reviewStatus: status,
          ...(templateId ? { templateId } : {})
        };

        const inserted = await client.query(
          `INSERT INTO "Messages" (
             conversation_id,
             sender_type,
             sender_agent_id,
             direction,
             channel,
             body,
             metadata,
             sent_at
           ) VALUES ($1::uuid, 'agent', $2::uuid, 'outbound', 'in_app', $3, $4::jsonb, NOW())
           RETURNING id`,
          [conversationId, detail.conversation.assignedAgentId, messageBody, JSON.stringify(metadata)]
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
          action: status === "sent" ? "inbox_draft_sent" : "inbox_draft_saved",
          details: {
            conversationId,
            templateId,
            autoSendEnabled,
            reviewStatus: status
          }
        });

        return {
          id: inserted.rows[0].id,
          status,
          autoSendEnabled
        };
      });
    } catch (error) {
      await withClient((client) =>
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

    json(res, 201, result);
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

    if (payload.listingId !== undefined && payload.listingId !== null && !isUuid(payload.listingId)) {
      badRequest(res, "listingId must be a UUID when provided");
      return;
    }

    const response = await withClient(async (client) => {
      if (payload.agentId) {
        const agent = await client.query(`SELECT id FROM "Agents" WHERE id = $1::uuid`, [payload.agentId]);
        if (agent.rowCount === 0) {
          return { error: "agent_not_found" };
        }
      }

      const listing = await client.query(
        payload.listingId
          ? `SELECT id FROM "Listings" WHERE id = $1::uuid AND unit_id = $2::uuid LIMIT 1`
          : `SELECT id FROM "Listings" WHERE unit_id = $1::uuid ORDER BY updated_at DESC LIMIT 1`,
        payload.listingId ? [payload.listingId, unitId] : [unitId]
      );

      if (listing.rowCount === 0) {
        return { error: "listing_not_found" };
      }

      if (payload.agentId) {
        await client.query(
          `UPDATE "Listings"
              SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{assignedAgentId}', to_jsonb($2::text), true),
                  updated_at = NOW()
            WHERE id = $1::uuid`,
          [listing.rows[0].id, payload.agentId]
        );
      } else {
        await client.query(
          `UPDATE "Listings"
              SET metadata = COALESCE(metadata, '{}'::jsonb) - 'assignedAgentId',
                  updated_at = NOW()
            WHERE id = $1::uuid`,
          [listing.rows[0].id]
        );
      }

      return {
        ok: true,
        listingId: listing.rows[0].id,
        assignedAgentId: payload.agentId || null
      };
    });

    if (response.error === "agent_not_found") {
      badRequest(res, "agentId does not exist");
      return;
    }
    if (response.error === "listing_not_found") {
      badRequest(res, "No listing found for this unit. Create a listing first.");
      return;
    }

    json(res, 200, response);
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

    const items = await withClient((client) => fetchListings(client, unitId));
    json(res, 200, { items });
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
        `SELECT id, unit_id, platform_account_id, listing_external_id, status, rent_cents, currency_code, available_on, metadata, created_at, updated_at
           FROM "Listings"
          WHERE id = $1::uuid`,
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
  server.listen(port, host, () => {
    console.log(`api listening on http://${host}:${port}`);
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

export { server };
