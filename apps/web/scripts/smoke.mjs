import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const API_PORT = 3011;
const WEB_PORT = 4173;
const previewUrl = `http://127.0.0.1:${WEB_PORT}`;
const require = createRequire(import.meta.url);
const viteBinPath = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");
const VIEWPORTS = [
  { name: "mobile-320", width: 320, height: 720 },
  { name: "mobile-375", width: 375, height: 812 },
  { name: "mobile-430", width: 430, height: 932 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "desktop-1280", width: 1280, height: 900 }
];
const INBOX_TOTAL = 57;
const RULE_TOTAL = 19;
const AVAILABILITY_TOTAL = 31;
const MOBILE_MAX_WIDTH = 430;
const ROUTE_TRANSITION_BUDGET_MS = 1500;
const LIST_RENDER_BUDGET_MS = 1200;
const BUNDLE_JS_MAX_BYTES = 450000;
const DOM_NODE_BUDGET = 700;

function buildAppointments() {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `appointment-${index + 1}`,
    unitId: index % 2 === 0 ? "unit-1" : "unit-2",
    unit: index % 2 === 0 ? "Maple 101" : "Maple 204",
    status: index % 3 === 0 ? "pending" : "confirmed",
    localStart: `2026-03-${String((index % 5) + 1).padStart(2, "0")}T10:00:00`,
    localEnd: `2026-03-${String((index % 5) + 1).padStart(2, "0")}T10:30:00`,
    displayTimezone: "America/Chicago",
    timezone: "America/Chicago",
    startsAt: `2026-03-${String((index % 5) + 1).padStart(2, "0")}T16:00:00.000Z`,
    updatedAt: new Date(Date.UTC(2026, 2, (index % 5) + 1, 15, 0)).toISOString(),
    conversation: {
      leadName: `Lead ${index + 1}`
    }
  }));
}

function buildInboxItems() {
  return Array.from({ length: INBOX_TOTAL }, (_, index) => {
    const itemIndex = index + 1;
    return {
      id: `inbox-${itemIndex}`,
      leadName: `Lead ${itemIndex}`,
      externalThreadId: `thread-${itemIndex}`,
      unit: `Unit ${((index % 4) + 1).toString().padStart(2, "0")}`,
      latestMessage: `Message preview ${itemIndex}`,
      status: index % 4 === 0 ? "new" : "draft"
    };
  });
}

function buildWeeklyRules(unitId) {
  return Array.from({ length: RULE_TOTAL }, (_, index) => ({
    ruleId: `${unitId}-rule-${index + 1}`,
    timezone: "America/New_York",
    occurrences: Array.from({ length: 2 }, (_, occurrenceIndex) => ({
      dayOfWeek: (index + occurrenceIndex) % 7,
      startMinute: 9 * 60,
      endMinute: 11 * 60
    }))
  }));
}

function buildAvailability(unitId) {
  return Array.from({ length: AVAILABILITY_TOTAL }, (_, index) => {
    const day = (index % 28) + 1;
    return {
      id: `${unitId}-slot-${index + 1}`,
      source: "weekly-rule",
      localStart: `2026-02-${String(day).padStart(2, "0")}T10:00:00`,
      localEnd: `2026-02-${String(day).padStart(2, "0")}T10:30:00`,
      timezone: "America/New_York",
      displayTimezone: "America/New_York"
    };
  });
}

const inboxItems = buildInboxItems();
const appointments = buildAppointments();
const platformPolicies = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    platform: "leasebreak",
    accountName: "Leasebreak Main",
    accountExternalId: "lb-main",
    isActive: true,
    integrationMode: "rpa",
    sendMode: "auto_send",
    sendModeOverride: "auto_send",
    globalDefaultSendMode: "draft_only",
    credentials: {},
    createdAt: "2026-02-06T00:00:00.000Z",
    updatedAt: "2026-02-06T00:00:00.000Z"
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    platform: "roomies",
    accountName: "Roomies Main",
    accountExternalId: "roomies-main",
    isActive: false,
    integrationMode: "rpa",
    sendMode: "draft_only",
    sendModeOverride: null,
    globalDefaultSendMode: "draft_only",
    credentials: {},
    createdAt: "2026-02-06T00:00:00.000Z",
    updatedAt: "2026-02-06T00:00:00.000Z"
  }
];
const platformHealth = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    platform: "leasebreak",
    accountName: "Leasebreak Main",
    accountExternalId: "lb-main",
    isActive: true,
    sendMode: "auto_send",
    sendModeOverride: "auto_send",
    globalDefaultSendMode: "draft_only",
    lastSuccessfulIngestAt: "2026-02-06T10:10:00.000Z",
    lastSuccessfulSendAt: "2026-02-06T10:12:00.000Z",
    errorCount24h: 0,
    disableReason: null
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    platform: "roomies",
    accountName: "Roomies Main",
    accountExternalId: "roomies-main",
    isActive: false,
    sendMode: "draft_only",
    sendModeOverride: null,
    globalDefaultSendMode: "draft_only",
    lastSuccessfulIngestAt: "2026-02-05T08:00:00.000Z",
    lastSuccessfulSendAt: "2026-02-05T08:05:00.000Z",
    errorCount24h: 2,
    disableReason: "disabled_by_admin_policy"
  }
];
const conversationDetails = new Map(
  inboxItems.map((item, index) => [
    item.id,
    {
      conversation: {
        id: item.id,
        leadName: item.leadName,
        unit: item.unit
      },
      templateContext: {
        unit: item.unit,
        slot: "10:00 AM"
      },
      templates: [
        {
          id: `template-${item.id}`,
          name: "Showing follow-up",
          body: `Hello ${item.leadName}, are you available for a showing tomorrow?`
        }
      ],
      messages: [
        {
          id: `${item.id}-msg-1`,
          direction: "outbound",
          status: index % 3 === 0 ? "draft" : "sent",
          body: `Automated message ${index + 1}`,
          createdAt: new Date(Date.UTC(2026, 1, 1, 12, index % 60)).toISOString()
        }
      ]
    }
  ])
);

function withCors(req, headers = {}) {
  const origin = req.headers.origin || previewUrl;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    vary: "origin",
    ...headers
  };
}

function sendJson(req, res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, withCors(req, {
    "content-type": "application/json",
    ...headers
  }));
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function hasSessionCookie(req) {
  return String(req.headers.cookie || "").includes("leasebot_session=active");
}

function getCookie(req, name) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function getRoleFromRequest(req) {
  if (!hasSessionCookie(req)) {
    return null;
  }
  const role = getCookie(req, "leasebot_role");
  return role === "admin" ? "admin" : "agent";
}

async function waitForCount(locator, expected, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await locator.count()) === expected) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for locator count ${expected}`);
}

async function waitForMinCount(locator, minimum, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await locator.count()) >= minimum) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for locator minimum count ${minimum}`);
}

function readSummaryCount(summaryText) {
  const match = summaryText.match(/Showing\s+(\d+)\s+of\s+(\d+)/i);
  if (!match) {
    return { rendered: 0, total: 0 };
  }
  return {
    rendered: Number(match[1]),
    total: Number(match[2])
  };
}

function createMockApiServer() {
  return createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", `http://127.0.0.1:${API_PORT}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, withCors(req));
      res.end();
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(req, res, 200, { status: "ok" });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/auth/sign-in/email") {
      const body = await readJsonBody(req);
      if (!body.email || !body.password) {
        sendJson(req, res, 400, { message: "Missing credentials" });
        return;
      }

      const role = body.email.includes("admin") ? "admin" : "agent";

      sendJson(req, res, 200, { ok: true }, {
        "set-cookie": [
          "leasebot_session=active; Path=/; HttpOnly; SameSite=Lax",
          `leasebot_role=${role}; Path=/; HttpOnly; SameSite=Lax`
        ]
      });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/auth/sign-out") {
      sendJson(req, res, 200, { ok: true }, {
        "set-cookie": [
          "leasebot_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
          "leasebot_role=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
        ]
      });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/me") {
      const role = getRoleFromRequest(req);
      if (!role) {
        sendJson(req, res, 200, { user: null });
        return;
      }
      sendJson(req, res, 200, {
        user: {
          id: role === "admin" ? "admin-1" : "agent-1",
          email: role === "admin" ? "admin@example.com" : "agent@example.com",
          role
        }
      });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/agents") {
      sendJson(req, res, 200, {
        items: [
          { id: "agent-1", fullName: "Casey Agent" },
          { id: "agent-2", fullName: "Riley Agent" }
        ]
      });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/units") {
      sendJson(req, res, 200, {
        items: [
          { id: "unit-1", propertyName: "Maple", unitNumber: "101" },
          { id: "unit-2", propertyName: "Maple", unitNumber: "204" }
        ]
      });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/listings") {
      sendJson(req, res, 200, {
        items: [
          { id: "listing-1", unitId: "unit-1", status: "active" },
          { id: "listing-2", unitId: "unit-2", status: "active" }
        ]
      });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/message-automation") {
      sendJson(req, res, 200, {
        platformAccountId: "11111111-1111-1111-1111-111111111111",
        autoSendEnabled: false,
        ruleId: null
      });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/admin/platform-policies") {
      sendJson(req, res, 200, {
        globalDefaultSendMode: "draft_only",
        requiredPlatforms: ["spareroom", "roomies", "leasebreak", "renthop", "furnishedfinder"],
        missingPlatforms: ["spareroom", "renthop", "furnishedfinder"],
        items: platformPolicies
      });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/admin/platform-health") {
      sendJson(req, res, 200, {
        generatedAt: "2026-02-06T10:15:00.000Z",
        items: platformHealth
      });
      return;
    }

    const policyMatch = requestUrl.pathname.match(/^\/api\/admin\/platform-policies\/([0-9a-f\-]+)$/i);
    if (req.method === "PUT" && policyMatch) {
      const policyId = policyMatch[1];
      const payload = await readJsonBody(req);
      const target = platformPolicies.find((item) => item.id === policyId);
      if (!target) {
        sendJson(req, res, 404, { error: "not_found" });
        return;
      }
      if (typeof payload.isActive === "boolean") {
        target.isActive = payload.isActive;
      }
      if (Object.prototype.hasOwnProperty.call(payload, "sendMode")) {
        target.sendModeOverride = payload.sendMode;
        target.sendMode = payload.sendMode || "draft_only";
      }
      target.updatedAt = new Date().toISOString();
      const healthTarget = platformHealth.find((item) => item.id === policyId);
      if (healthTarget) {
        healthTarget.isActive = target.isActive;
        healthTarget.sendModeOverride = target.sendModeOverride;
        healthTarget.sendMode = target.sendMode;
        healthTarget.disableReason = target.isActive ? null : "disabled_by_admin_policy";
      }
      sendJson(req, res, 200, target);
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/inbox") {
      const status = requestUrl.searchParams.get("status");
      const items = status && status !== "all" ? inboxItems.filter((item) => item.status === status) : inboxItems;
      sendJson(req, res, 200, { items });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/showing-appointments") {
      let items = appointments;
      const status = requestUrl.searchParams.get("status");
      const unitId = requestUrl.searchParams.get("unitId");
      const fromDate = requestUrl.searchParams.get("fromDate");
      const toDate = requestUrl.searchParams.get("toDate");
      if (status) {
        items = items.filter((item) => item.status === status);
      }
      if (unitId) {
        items = items.filter((item) => item.unitId === unitId);
      }
      if (fromDate) {
        items = items.filter((item) => item.startsAt.slice(0, 10) >= fromDate);
      }
      if (toDate) {
        items = items.filter((item) => item.startsAt.slice(0, 10) <= toDate);
      }
      sendJson(req, res, 200, { items });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname.startsWith("/api/inbox/")) {
      const conversationId = requestUrl.pathname.split("/")[3];
      sendJson(req, res, 200, conversationDetails.get(conversationId) || {
        conversation: { id: conversationId, leadName: "Unknown", unit: "n/a" },
        templateContext: { unit: "", slot: "" },
        templates: [],
        messages: []
      });
      return;
    }

    const availabilityMatch = requestUrl.pathname.match(/^\/api\/units\/([^/]+)\/availability$/);
    if (req.method === "GET" && availabilityMatch) {
      const [, unitId] = availabilityMatch;
      sendJson(req, res, 200, { items: buildAvailability(unitId) });
      return;
    }

    const weeklyRulesMatch = requestUrl.pathname.match(/^\/api\/units\/([^/]+)\/availability\/weekly-rules$/);
    if (req.method === "GET" && weeklyRulesMatch) {
      const [, unitId] = weeklyRulesMatch;
      sendJson(req, res, 200, { items: buildWeeklyRules(unitId) });
      return;
    }

    sendJson(req, res, 404, { message: `No route for ${req.method} ${requestUrl.pathname}` });
  });
}

async function waitForUrl(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Ignore while server boots.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function runSmoke() {
  const runtimeErrors = [];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();

      page.on("pageerror", (error) => {
        runtimeErrors.push(`[${viewport.name}] uncaught: ${error.message}`);
      });
      page.on("console", (message) => {
        if (message.type() === "error") {
          runtimeErrors.push(`[${viewport.name}] console.error: ${message.text()}`);
        }
      });

      await page.goto(`${previewUrl}/login`, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "Lease Bot Login" }).waitFor();

      await page.getByLabel("Email").fill("admin@example.com");
      await page.getByLabel("Password").fill("password1234");
      const signInStartedAt = Date.now();
      await Promise.all([
        page.waitForURL(`${previewUrl}/admin`),
        page.getByRole("button", { name: "Sign in" }).click()
      ]);

      await page.getByRole("heading", { name: "Admin View" }).waitFor();
      const signInRouteMs = Date.now() - signInStartedAt;
      if (signInRouteMs > ROUTE_TRANSITION_BUDGET_MS) {
        throw new Error(
          `[${viewport.name}] R18 perf failed: login route transition ${signInRouteMs}ms exceeds ${ROUTE_TRANSITION_BUDGET_MS}ms budget`
        );
      }

      const bundleMetrics = await page.evaluate(() => {
        const resources = performance
          .getEntriesByType("resource")
          .filter((entry) => entry.name.includes("/assets/index-") && entry.name.endsWith(".js"))
          .map((entry) => ({
            name: entry.name,
            transferSize: Number(entry.transferSize || 0),
            decodedBodySize: Number(entry.decodedBodySize || 0)
          }));
        const largestJs = resources.sort((left, right) => right.decodedBodySize - left.decodedBodySize)[0] || null;
        return {
          largestJsName: largestJs?.name || null,
          largestJsTransferSize: largestJs?.transferSize || 0,
          largestJsDecodedBodySize: largestJs?.decodedBodySize || 0
        };
      });
      const largestBundleBytes = Math.max(bundleMetrics.largestJsDecodedBodySize, bundleMetrics.largestJsTransferSize);
      if (!bundleMetrics.largestJsName || largestBundleBytes <= 0) {
        throw new Error(`[${viewport.name}] R18 perf failed: could not read main JS payload metrics`);
      }
      if (largestBundleBytes > BUNDLE_JS_MAX_BYTES) {
        throw new Error(
          `[${viewport.name}] R18 perf failed: main JS payload ${largestBundleBytes}B exceeds ${BUNDLE_JS_MAX_BYTES}B budget`
        );
      }

      await page.getByRole("tablist", { name: "Admin panels" }).waitFor();
      await page.getByRole("tab", { name: "Inbox" }).click();
      await page.getByRole("heading", { name: "Inbox list" }).waitFor();
      await page.getByRole("tab", { name: "Assignment" }).click();
      await page.getByRole("heading", { name: "Assignments" }).waitFor();
      await page.getByRole("tab", { name: "Showings" }).click();
      await page.getByRole("heading", { name: "Showings" }).waitFor();
      await page.getByRole("tab", { name: "Platform controls" }).click();
      await page.getByRole("heading", { name: "Platform controls" }).waitFor();

      const inboxRows = page.getByTestId("inbox-row");
      const weeklyRows = page.getByTestId("weekly-rule-row");
      const availabilityRows = page.getByTestId("availability-row");

      const inboxRenderStartedAt = Date.now();
      await page.getByRole("tab", { name: "Inbox" }).click();
      await page.getByTestId("inbox-pagination-summary").waitFor();
      const inboxRenderMs = Date.now() - inboxRenderStartedAt;
      if (inboxRenderMs > LIST_RENDER_BUDGET_MS) {
        throw new Error(
          `[${viewport.name}] R18 perf failed: inbox render ${inboxRenderMs}ms exceeds ${LIST_RENDER_BUDGET_MS}ms budget`
        );
      }
      await waitForMinCount(inboxRows, 1);
      if (await inboxRows.count() > 20) {
        throw new Error(`[${viewport.name}] R18 failed: inbox renders more than 20 rows`);
      }
      const inboxSummaryText = await page.getByTestId("inbox-pagination-summary").innerText();
      const inboxSummary = readSummaryCount(inboxSummaryText);
      if (inboxSummary.rendered > 20 || inboxSummary.rendered !== (await inboxRows.count())) {
        throw new Error(`[${viewport.name}] R18 failed: inbox summary count mismatch or overflow`);
      }

      if (viewport.width <= MOBILE_MAX_WIDTH) {
        await page.getByTestId("inbox-card-list").waitFor();
        const inboxTableCount = await page.locator('[data-testid="inbox-card-list"] table').count();
        if (inboxTableCount > 0) {
          throw new Error(`[${viewport.name}] R18 failed: inbox mobile fallback rendered table instead of cards`);
        }
      }

      const showingsRenderStartedAt = Date.now();
      await page.getByRole("tab", { name: "Showings" }).click();
      await page.getByTestId("weekly-rules-pagination-summary").waitFor();
      await page.getByTestId("availability-pagination-summary").waitFor();
      const showingsRenderMs = Date.now() - showingsRenderStartedAt;
      if (showingsRenderMs > LIST_RENDER_BUDGET_MS) {
        throw new Error(
          `[${viewport.name}] R18 perf failed: showings render ${showingsRenderMs}ms exceeds ${LIST_RENDER_BUDGET_MS}ms budget`
        );
      }
      await waitForMinCount(weeklyRows, 1);
      await waitForMinCount(availabilityRows, 1);
      if (await weeklyRows.count() > 12) {
        throw new Error(`[${viewport.name}] R18 failed: weekly rules render more than 12 rows`);
      }
      if (await availabilityRows.count() > 12) {
        throw new Error(`[${viewport.name}] R18 failed: availability renders more than 12 rows`);
      }
      const weeklySummary = readSummaryCount(await page.getByTestId("weekly-rules-pagination-summary").innerText());
      const availabilitySummary = readSummaryCount(await page.getByTestId("availability-pagination-summary").innerText());
      if (weeklySummary.rendered > 12 || weeklySummary.rendered !== (await weeklyRows.count())) {
        throw new Error(`[${viewport.name}] R18 failed: weekly rules summary count mismatch or overflow`);
      }
      if (availabilitySummary.rendered > 12 || availabilitySummary.rendered !== (await availabilityRows.count())) {
        throw new Error(`[${viewport.name}] R18 failed: availability summary count mismatch or overflow`);
      }

      const adminListDomNodes = await page.evaluate(() => ({
        inbox: document.querySelector('[data-testid="inbox-card-list"]')?.querySelectorAll("*").length || 0,
        weeklyRules: document.querySelector('[data-testid="weekly-rules-card-list"]')?.querySelectorAll("*").length || 0,
        availability: document.querySelector('[data-testid="availability-card-list"]')?.querySelectorAll("*").length || 0
      }));
      if (adminListDomNodes.inbox > DOM_NODE_BUDGET) {
        throw new Error(`[${viewport.name}] R18 perf failed: inbox DOM nodes ${adminListDomNodes.inbox} exceed ${DOM_NODE_BUDGET}`);
      }
      if (adminListDomNodes.weeklyRules > DOM_NODE_BUDGET) {
        throw new Error(
          `[${viewport.name}] R18 perf failed: weekly-rules DOM nodes ${adminListDomNodes.weeklyRules} exceed ${DOM_NODE_BUDGET}`
        );
      }
      if (adminListDomNodes.availability > DOM_NODE_BUDGET) {
        throw new Error(
          `[${viewport.name}] R18 perf failed: availability DOM nodes ${adminListDomNodes.availability} exceed ${DOM_NODE_BUDGET}`
        );
      }

      if (viewport.width <= MOBILE_MAX_WIDTH) {
        await page.getByTestId("weekly-rules-card-list").waitFor();
        await page.getByTestId("availability-card-list").waitFor();
        const weeklyRulesTableCount = await page.locator('[data-testid="weekly-rules-card-list"] table').count();
        const availabilityTableCount = await page.locator('[data-testid="availability-card-list"] table').count();
        if (weeklyRulesTableCount > 0 || availabilityTableCount > 0) {
          throw new Error(`[${viewport.name}] R18 failed: showings mobile fallback rendered table instead of cards`);
        }
      }

      const agentRouteStartedAt = Date.now();
      await page.getByRole("button", { name: "Agent area" }).click();
      await page.getByRole("heading", { name: "Agent View" }).waitFor();
      const adminToAgentRouteMs = Date.now() - agentRouteStartedAt;
      if (adminToAgentRouteMs > ROUTE_TRANSITION_BUDGET_MS) {
        throw new Error(
          `[${viewport.name}] R18 perf failed: admin->agent route transition ${adminToAgentRouteMs}ms exceeds ${ROUTE_TRANSITION_BUDGET_MS}ms budget`
        );
      }
      await page.getByRole("heading", { name: "Inbox list" }).waitFor();
      await page.getByRole("heading", { name: "My showings" }).waitFor();

      const appointmentRows = page.getByTestId("agent-appointment-row");
      const timelineDays = page.getByTestId("agent-appointment-day");

      if ((await appointmentRows.count()) !== 8) {
        throw new Error(`[${viewport.name}] R15 failed: expected 8 initial agent appointments`);
      }
      if ((await timelineDays.count()) !== 5) {
        throw new Error(`[${viewport.name}] R15 failed: expected 5 timeline day buckets before filters`);
      }

      const agentListDomNodes = await page.evaluate(
        () => document.querySelector('[data-testid="agent-appointments-card-list"]')?.querySelectorAll("*").length || 0
      );
      if (agentListDomNodes > DOM_NODE_BUDGET) {
        throw new Error(`[${viewport.name}] R18 perf failed: agent appointment DOM nodes ${agentListDomNodes} exceed ${DOM_NODE_BUDGET}`);
      }

      if (viewport.width <= MOBILE_MAX_WIDTH) {
        await page.getByTestId("agent-appointments-card-list").waitFor();
        const agentTableCount = await page.locator('[data-testid="agent-appointments-card-list"] table').count();
        if (agentTableCount > 0) {
          throw new Error(`[${viewport.name}] R18 failed: agent mobile fallback rendered table instead of cards`);
        }
      }

      await page.getByLabel("Status").selectOption("pending");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await waitForCount(appointmentRows, 3);
      await waitForCount(timelineDays, 3);

      await page.getByLabel("Unit").selectOption("unit-2");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await waitForCount(appointmentRows, 1);
      await waitForCount(timelineDays, 1);

      await page.getByLabel("From date").fill("2026-03-05");
      await page.getByLabel("From date").press("Enter");
      await page.getByLabel("To date").fill("2026-03-05");
      await page.getByLabel("To date").press("Enter");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await waitForCount(appointmentRows, 0);
      await waitForCount(timelineDays, 0);
      await page.getByText("No appointments for selected filters.").waitFor();
      await page.getByText("Timeline empty.").waitFor();

      console.log(
        `[${viewport.name}] R18 perf-proxy route(login=${signInRouteMs}ms,adminToAgent=${adminToAgentRouteMs}ms) ` +
          `render(inbox=${inboxRenderMs}ms,showings=${showingsRenderMs}ms) payload(mainJs=${largestBundleBytes}B)`
      );

      await context.close();
    }

    await delay(250);
    if (runtimeErrors.length > 0) {
      throw new Error(`Runtime errors detected:\n${runtimeErrors.join("\n")}`);
    }

    console.log(
      "Smoke passed: multi-viewport auth/panel checks with explicit R18 mobile card fallback and performance proxy assertions."
    );
  } finally {
    await browser.close();
  }
}

async function main() {
  const apiServer = createMockApiServer();
  apiServer.listen(API_PORT, "127.0.0.1");
  await once(apiServer, "listening");

  const preview = spawn(
    process.execPath,
    [viteBinPath, "preview", "--host", "127.0.0.1", "--port", String(WEB_PORT), "--strictPort"],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        WEB_PORT: String(WEB_PORT)
      }
    }
  );

  try {
    await waitForUrl(`${previewUrl}/login`);
    await runSmoke();
  } finally {
    preview.kill("SIGTERM");
    await once(preview, "exit").catch(() => undefined);
    await new Promise((resolve, reject) => {
      apiServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
