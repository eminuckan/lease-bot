import { execFileSync } from "node:child_process";
import path from "node:path";

import { DEFAULT_REQUIRED_PLATFORM_ACCOUNTS } from "./bootstrap-platform-accounts.js";

const DEFAULT_AGENT_NAME = "Aleyna";
const DEFAULT_AGENT_TIMEZONE = "America/New_York";
const DEFAULT_LISTING_EXTERNAL_ID = "dev_default";
const DEFAULT_UNIT_PROPERTY_NAME = "Test Property";
const DEFAULT_UNIT_NUMBER = "1A";
const DEFAULT_AVAILABILITY_LOOKAHEAD_DAYS = 14;

const DAY_ALIASES = new Map([
  ["wendesday", "wednesday"]
]);

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseCsvEnv(value) {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDay(value) {
  const key = String(value || "").trim().toLowerCase();
  return DAY_ALIASES.get(key) || key;
}

function weekdayKey(date, timezone) {
  const label = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(date);
  return normalizeDay(label);
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDaysUtc(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function zonedTimeToUtc(dateString, timeString, timezone) {
  const [year, month, day] = dateString.split("-").map(Number);
  const [hour, minute] = timeString.split(":").map(Number);

  // Search offsets in 15 minute increments to find instants that match the requested local time.
  const candidates = [];
  for (let offsetMinutes = -12 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const utcMillis = Date.UTC(year, month - 1, day, hour, minute, 0) - offsetMinutes * 60 * 1000;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(utcMillis));
    const bag = {};
    for (const part of parts) {
      if (part.type !== "literal") {
        bag[part.type] = part.value;
      }
    }
    const matched =
      Number(bag.year) === year
      && Number(bag.month) === month
      && Number(bag.day) === day
      && Number(bag.hour) === hour
      && Number(bag.minute) === minute;
    if (matched) {
      candidates.push(utcMillis);
    }
  }

  if (candidates.length === 0) {
    // Fallback: treat as UTC (better than crashing dev bootstrap).
    return new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  }

  candidates.sort((a, b) => a - b);
  return new Date(candidates[0]);
}

function parseTimeToken(raw, { fallbackMeridiem = null } = {}) {
  const token = String(raw || "").trim().toLowerCase();
  if (!token) {
    return null;
  }

  const match = token.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m?|)?$/);
  if (!match) {
    return null;
  }

  const hourRaw = Number(match[1]);
  const minuteRaw = match[2] ? Number(match[2]) : 0;
  if (!Number.isFinite(hourRaw) || !Number.isFinite(minuteRaw)) {
    return null;
  }

  let meridiem = match[3] ? match[3].replace("m", "") : null; // pm/p -> p
  if (!meridiem && fallbackMeridiem) {
    meridiem = fallbackMeridiem;
  }

  let hour = hourRaw;
  if (meridiem === "p") {
    if (hour !== 12) {
      hour += 12;
    }
  } else if (meridiem === "a") {
    if (hour === 12) {
      hour = 0;
    }
  } else {
    // No am/pm: assume 24h when it looks like it, otherwise keep as-is.
    if (hour <= 12 && fallbackMeridiem === "p" && hour !== 12) {
      hour += 12;
    }
  }

  if (hour < 0 || hour > 23 || minuteRaw < 0 || minuteRaw > 59) {
    return null;
  }

  return { hour, minute: minuteRaw, meridiem: meridiem || null };
}

function parseTimeslotWindow(timeslot) {
  const normalized = String(timeslot || "")
    .trim()
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, "");

  if (!normalized) {
    return null;
  }

  if (normalized.includes("notavailable")) {
    return null;
  }

  if (normalized.includes("allday")) {
    return { start: "09:00", end: "21:00" };
  }

  const parts = normalized.split("-");
  if (parts.length < 2) {
    return null;
  }

  const startRaw = parts[0];
  const endRaw = parts.slice(1).join("-"); // tolerate extra dashes
  const start = parseTimeToken(startRaw);
  const end = parseTimeToken(endRaw, { fallbackMeridiem: start?.meridiem });
  if (!start || !end) {
    return null;
  }

  const two = (n) => String(n).padStart(2, "0");
  return {
    start: `${two(start.hour)}:${two(start.minute)}`,
    end: `${two(end.hour)}:${two(end.minute)}`
  };
}

function extractWeeklyAvailabilityFromXlsx(xlsxPath) {
  const script = String.raw`
import json, zipfile, xml.etree.ElementTree as ET
from pathlib import Path

path = Path(${JSON.stringify(xlsxPath)})
if not path.exists():
  print(json.dumps({}))
  raise SystemExit(0)

with zipfile.ZipFile(path) as z:
  shared_xml = z.read('xl/sharedStrings.xml')
  sheet_xml = z.read('xl/worksheets/sheet1.xml')

ns = {'a': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}

shared_root = ET.fromstring(shared_xml)
shared = []
for si in shared_root.findall('a:si', ns):
  texts = []
  for t in si.findall('.//a:t', ns):
    if t.text:
      texts.append(t.text)
  shared.append(''.join(texts))

sheet_root = ET.fromstring(sheet_xml)

def split_ref(ref):
  col=''; row=''
  for ch in ref:
    if ch.isalpha(): col+=ch
    else: row+=ch
  return col, int(row)

rows = {}
for row_el in sheet_root.findall('.//a:sheetData/a:row', ns):
  for c in row_el.findall('a:c', ns):
    ref = c.attrib.get('r')
    if not ref:
      continue
    col, r = split_ref(ref)
    v_el = c.find('a:v', ns)
    if v_el is None or v_el.text is None:
      continue
    v = v_el.text
    if c.attrib.get('t') == 's':
      try:
        v = shared[int(v)]
      except Exception:
        pass
    rows.setdefault(r, {})[col] = v

day_set = {'monday','tuesday','wednesday','wendesday','thursday','friday','saturday','sunday'}
result = {}
for r, data in rows.items():
  day = str(data.get('A','')).strip().lower()
  if day in day_set:
    slot = str(data.get('C','')).strip()
    if slot:
      if day == 'wendesday':
        day = 'wednesday'
      result[day] = slot

print(json.dumps(result))
`;

  try {
    const stdout = execFileSync("python3", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
    const parsed = JSON.parse(String(stdout || "").trim() || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function ensureSchemaReady(db, logger) {
  try {
    await db.query('SELECT 1 FROM "PlatformAccounts" LIMIT 1');
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "42P01") {
      logger.warn?.("[bootstrap] schema missing; skipping dev test bootstrap (run migrations first)", {
        error: formatError(error)
      });
      return false;
    }
    throw error;
  }
}

export async function ensureDevTestData(db, options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;

  if (env.NODE_ENV === "production") {
    return { skipped: true, reason: "production" };
  }

  if (env.LEASE_BOT_DEV_BOOTSTRAP_TEST_DATA === "0") {
    return { skipped: true, reason: "disabled" };
  }

  if (!(await ensureSchemaReady(db, logger))) {
    return { skipped: true, reason: "missing_schema" };
  }

  const spareroomAccount = DEFAULT_REQUIRED_PLATFORM_ACCOUNTS.find((acct) => acct.platform === "spareroom");
  const platformAccountId = spareroomAccount?.id;
  if (!platformAccountId) {
    return { skipped: true, reason: "missing_platform_account_id" };
  }

  const agentName = env.LEASE_BOT_DEV_AGENT_NAME || DEFAULT_AGENT_NAME;
  const agentTimezone = env.LEASE_BOT_DEV_AGENT_TIMEZONE || DEFAULT_AGENT_TIMEZONE;
  const listingExternalId = env.LEASE_BOT_DEV_LISTING_EXTERNAL_ID || DEFAULT_LISTING_EXTERNAL_ID;
  const propertyName = env.LEASE_BOT_DEV_UNIT_PROPERTY_NAME || DEFAULT_UNIT_PROPERTY_NAME;
  const unitNumber = env.LEASE_BOT_DEV_UNIT_NUMBER || DEFAULT_UNIT_NUMBER;
  const lookaheadDays = Number(env.LEASE_BOT_DEV_AVAILABILITY_LOOKAHEAD_DAYS || DEFAULT_AVAILABILITY_LOOKAHEAD_DAYS);

  // Enable auto_send for SpareRoom only when we're in a constrained test mode.
  const leadAllowlist = parseCsvEnv(env.WORKER_AUTOREPLY_ALLOW_LEAD_NAMES);
  const enableRules = leadAllowlist.length > 0;
  if (leadAllowlist.length > 0) {
    await db.query(`UPDATE "PlatformAccounts" SET send_mode = 'auto_send', updated_at = NOW() WHERE id = $1::uuid`, [platformAccountId]);
  }

  // Agent (idempotent by natural key in dev).
  let agentId = null;
  const agentLookup = await db.query(
    `SELECT id
       FROM "Agents"
      WHERE platform_account_id = $1::uuid
        AND full_name = $2
      ORDER BY created_at ASC
      LIMIT 1`,
    [platformAccountId, agentName]
  );
  if (agentLookup.rowCount > 0) {
    agentId = agentLookup.rows[0].id;
    await db.query(`UPDATE "Agents" SET timezone = $1, updated_at = NOW() WHERE id = $2::uuid`, [agentTimezone, agentId]);
  } else {
    const createdAgent = await db.query(
      `INSERT INTO "Agents" (platform_account_id, full_name, timezone)
       VALUES ($1::uuid, $2, $3)
       RETURNING id`,
      [platformAccountId, agentName, agentTimezone]
    );
    agentId = createdAgent.rows?.[0]?.id || null;
  }
  if (!agentId) {
    return { skipped: true, reason: "agent_missing" };
  }

  // Unit (idempotent by natural key).
  let unitId = null;
  const unitLookup = await db.query(`SELECT id FROM "Units" WHERE property_name = $1 AND unit_number = $2 LIMIT 1`, [propertyName, unitNumber]);
  if (unitLookup.rowCount > 0) {
    unitId = unitLookup.rows[0].id;
  } else {
    const createdUnit = await db.query(
      `INSERT INTO "Units" (property_name, unit_number, is_active)
       VALUES ($1, $2, TRUE)
       RETURNING id`,
      [propertyName, unitNumber]
    );
    unitId = createdUnit.rows?.[0]?.id || null;
  }
  if (!unitId) {
    return { skipped: true, reason: "unit_missing" };
  }

  // Listing (idempotent by platform_account_id + listing_external_id).
  let listingId = null;
  const listingLookup = await db.query(
    `SELECT id FROM "Listings" WHERE platform_account_id = $1::uuid AND listing_external_id = $2 LIMIT 1`,
    [platformAccountId, listingExternalId]
  );
  if (listingLookup.rowCount > 0) {
    listingId = listingLookup.rows[0].id;
  } else {
    const createdListing = await db.query(
      `INSERT INTO "Listings" (unit_id, platform_account_id, listing_external_id, status, rent_cents, currency_code, metadata)
       VALUES ($1::uuid, $2::uuid, $3, 'active', 200000, 'USD', '{}'::jsonb)
       RETURNING id`,
      [unitId, platformAccountId, listingExternalId]
    );
    listingId = createdListing.rows?.[0]?.id || null;
  }

  if (!listingId) {
    return { skipped: true, reason: "listing_missing" };
  }

  // Unit-agent assignment (idempotent).
  await db.query(
    `INSERT INTO "UnitAgentAssignments" (unit_id, agent_id, assignment_mode, priority)
     VALUES ($1::uuid, $2::uuid, 'active', 100)
     ON CONFLICT (unit_id, agent_id) DO UPDATE
     SET assignment_mode = EXCLUDED.assignment_mode,
         priority = LEAST("UnitAgentAssignments".priority, EXCLUDED.priority),
         updated_at = NOW()`,
    [unitId, agentId]
  );

  // Availability seeding (dev only, replace previous dev_bootstrap slots).
  await db.query(`DELETE FROM "AvailabilitySlots" WHERE unit_id = $1::uuid AND source = 'dev_bootstrap'`, [unitId]);
  await db.query(`DELETE FROM "AgentAvailabilitySlots" WHERE agent_id = $1::uuid AND source = 'dev_bootstrap'`, [agentId]);

  const xlsxPath = path.resolve(env.LEASE_BOT_DEV_AVAILABILITY_XLSX_PATH || "calendar-aleyna.xlsx");
  const weekly = extractWeeklyAvailabilityFromXlsx(xlsxPath);
  const weeklyFallback = {
    saturday: "2-3pm",
    sunday: "3-4pm"
  };
  const weeklyMap = Object.keys(weekly).length > 0 ? weekly : weeklyFallback;

  const now = new Date();
  const days = Number.isFinite(lookaheadDays) && lookaheadDays > 0 ? Math.min(lookaheadDays, 60) : DEFAULT_AVAILABILITY_LOOKAHEAD_DAYS;

  for (let offset = 0; offset < days; offset += 1) {
    const day = addDaysUtc(now, offset);
    const key = weekdayKey(day, agentTimezone);
    const slotText = weeklyMap[key];
    if (!slotText) {
      continue;
    }

    const window = parseTimeslotWindow(slotText);
    if (!window) {
      continue;
    }

    const dateString = toIsoDate(day);
    const startsAt = zonedTimeToUtc(dateString, window.start, agentTimezone);
    const endsAt = zonedTimeToUtc(dateString, window.end, agentTimezone);

    // Unit open slot covers the whole day so agent availability becomes the constraint.
    const unitStartsAt = zonedTimeToUtc(dateString, "00:00", agentTimezone);
    const unitEndsAt = zonedTimeToUtc(dateString, "23:59", agentTimezone);

    await db.query(
      `INSERT INTO "AvailabilitySlots" (unit_id, listing_id, starts_at, ends_at, timezone, status, source, notes)
       VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz, $5, 'open', 'dev_bootstrap', $6)`,
      [unitId, listingId, unitStartsAt.toISOString(), unitEndsAt.toISOString(), agentTimezone, `seeded:${key}:${slotText}`]
    );

    await db.query(
      `INSERT INTO "AgentAvailabilitySlots" (agent_id, starts_at, ends_at, timezone, status, source, notes)
       VALUES ($1::uuid, $2::timestamptz, $3::timestamptz, $4, 'available', 'dev_bootstrap', $5)`,
      [agentId, startsAt.toISOString(), endsAt.toISOString(), agentTimezone, `seeded:${key}:${slotText}`]
    );
  }

  // Template + rules for SpareRoom. (Idempotent by natural keys / selector used by findRule.)
  const templateName = "dev_showing_times";
  const templateBody = [
    "Hi {{lead_name}},",
    "",
    "Yes, it's available.",
    "",
    "We're having showings at the following times:",
    "{{slot_options_list}}",
    "",
    "Please let us know what works best. We can also do virtual tours.",
    "",
    "Regards,",
    "Maurik"
  ].join("\n");

  const variables = ["lead_name", "slot_options_list", "slot_options_inline", "unit", "unit_number"];

  await db.query(
    `INSERT INTO "Templates" (platform_account_id, name, locale, body, variables, is_active)
     VALUES ($1::uuid, $2, 'en-US', $3, $4::jsonb, TRUE)
     ON CONFLICT (platform_account_id, name, locale) DO UPDATE
     SET body = EXCLUDED.body,
         variables = EXCLUDED.variables,
         is_active = TRUE,
         updated_at = NOW()`,
    [platformAccountId, templateName, templateBody, JSON.stringify(variables)]
  );

  const upsertRule = async (intent) => {
    const existing = await db.query(
      `SELECT id FROM "AutomationRules"
        WHERE platform_account_id = $1::uuid
          AND trigger_type = 'message_received'
          AND action_type = 'send_template'
          AND COALESCE(conditions->>'intent','') = $2
        ORDER BY priority ASC, created_at ASC
        LIMIT 1`,
      [platformAccountId, intent]
    );

    const actionConfig = { template: templateName };
    const conditions = { intent };

    if (existing.rowCount > 0) {
      await db.query(
        `UPDATE "AutomationRules"
            SET name = $1,
                description = $2,
                action_config = $3::jsonb,
                conditions = $4::jsonb,
                is_enabled = $6::boolean,
                updated_at = NOW()
          WHERE id = $5::uuid`,
        [
          `Dev auto-reply (${intent})`,
          "Dev bootstrap rule for safe SpareRoom automation tests (lead allowlist required).",
          JSON.stringify(actionConfig),
          JSON.stringify(conditions),
          existing.rows[0].id,
          enableRules
        ]
      );
      return;
    }

    await db.query(
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
       ) VALUES (
         $1::uuid,
         $2,
         $3,
         'message_received',
         $4::jsonb,
         'send_template',
         $5::jsonb,
         50,
         $6::boolean
       )`,
      [
        platformAccountId,
        `Dev auto-reply (${intent})`,
        "Dev bootstrap rule for safe SpareRoom automation tests (lead allowlist required).",
        JSON.stringify(conditions),
        JSON.stringify(actionConfig),
        enableRules
      ]
    );
  };

  await upsertRule("availability_question");
  await upsertRule("tour_request");

  logger.info?.("[bootstrap] ensured dev test data", {
    platform: "spareroom",
    platformAccountId,
    agentName,
    propertyName,
    unitNumber,
    listingExternalId,
    availabilitySeedSource: "dev_bootstrap"
  });

  return {
    skipped: false,
    platformAccountId,
    agentId,
    unitId,
    listingId
  };
}
