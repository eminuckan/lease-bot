import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { createPlatformAdapterRegistry } from "../packages/integrations/src/platform-adapters.js";

function parseJsonArrayEnv(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function envPrefixForPlatform(platform) {
  switch (platform) {
    case "spareroom":
      return "SPAREROOM";
    case "roomies":
      return "ROOMIES";
    case "leasebreak":
      return "LEASEBREAK";
    case "renthop":
      return "RENTHOP";
    case "furnishedfinder":
      return "FURNISHEDFINDER";
    default:
      return null;
  }
}

function waitForEnterPrompt(prompt) {
  if (!process.stdin.isTTY) {
    return { promise: Promise.resolve(false), cleanup() {} };
  }

  process.stdout.write(prompt);
  let handler;
  const promise = new Promise((resolve) => {
    handler = () => resolve(true);
    process.stdin.once("data", handler);
  });

  return {
    promise,
    cleanup() {
      if (handler) {
        process.stdin.removeListener("data", handler);
      }
    }
  };
}

async function isAuthRequired(page, adapter) {
  // Fast path: explicit auth URL patterns.
  let url = "";
  try {
    url = typeof page?.url === "function" ? page.url() : "";
  } catch {
    url = "";
  }
  for (const pattern of adapter.authRequiredUrlPatterns || []) {
    if (typeof pattern === "string" && pattern.length > 0 && url.includes(pattern)) {
      return true;
    }
  }

  const markers = adapter.authRequiredText || [];
  if (markers.length === 0) {
    return false;
  }

  let text = "";
  try {
    text = await page.evaluate(() => (document.body?.innerText || ""));
  } catch {
    text = "";
  }
  const normalized = String(text || "").toLowerCase();
  return markers.some((marker) => typeof marker === "string" && marker.length > 0 && normalized.includes(marker.toLowerCase()));
}

async function prepareSpareRoomRememberMe(page, adapter) {
  const loginUrl = new URL("/roommate/logon.pl", adapter.baseUrl).toString();
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

  // SpareRoom keeps the "remember_me" flag in a hidden input that's toggled by the checkbox.
  // Some environments show consent overlays; force the check to avoid pointer interception.
  try {
    await page.check("#remember_me_checkbox", { force: true, timeout: 5_000 });
    console.log("[rpa-login] SpareRoom: remember-me enabled");
  } catch {
    // Best-effort; user can still check manually.
    console.warn("[rpa-login] SpareRoom: could not auto-enable remember-me; please tick it manually");
  }
}

async function main() {
  const platform = process.argv[2];
  if (!platform) {
    console.error("Usage: node scripts/rpa-login.mjs <platform>");
    console.error("Platforms: spareroom, roomies, leasebreak, renthop, furnishedfinder");
    process.exitCode = 1;
    return;
  }

  const adapter = createPlatformAdapterRegistry().get(platform);
  if (!adapter) {
    console.error(`Unsupported platform: ${platform}`);
    process.exitCode = 1;
    return;
  }

  const envPrefix = envPrefixForPlatform(platform);
  const profileEnvVar = envPrefix ? `${envPrefix}_RPA_PROFILE` : null;
  const defaultProfileDir = path.resolve(".playwright", "profiles", platform);
  const profileDirValue = profileEnvVar && process.env[profileEnvVar]
    ? String(process.env[profileEnvVar])
    : defaultProfileDir;
  const profileDir = path.resolve(profileDirValue);

  await mkdir(profileDir, { recursive: true });

  const { chromium } = await import("playwright");
  const channel = typeof process.env.LEASE_BOT_RPA_BROWSER_CHANNEL === "string" && process.env.LEASE_BOT_RPA_BROWSER_CHANNEL.trim().length > 0
    ? process.env.LEASE_BOT_RPA_BROWSER_CHANNEL.trim()
    : undefined;
  const chromiumSandbox = process.env.LEASE_BOT_RPA_CHROMIUM_SANDBOX === "0" ? false : undefined;
  const launchArgs = parseJsonArrayEnv(process.env.LEASE_BOT_RPA_LAUNCH_ARGS_JSON);

  const launchOptions = {
    headless: false,
    ...(channel ? { channel } : {}),
    ...(chromiumSandbox === false ? { chromiumSandbox } : {}),
    ...(launchArgs.length > 0 ? { args: launchArgs } : {})
  };

  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, launchOptions);
  } catch (error) {
    if (!channel) {
      throw error;
    }

    console.warn(`[rpa-login] launch failed with channel=${channel}; retrying with Playwright Chromium`);
    const { channel: _ignored, ...launchOptionsNoChannel } = launchOptions;
    context = await chromium.launchPersistentContext(profileDir, launchOptionsNoChannel);
  }

  try {
    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    await page.goto(adapter.inboxUrl, { waitUntil: "domcontentloaded" });

    if (await isAuthRequired(page, adapter)) {
      if (platform === "spareroom") {
        await prepareSpareRoomRememberMe(page, adapter);
      }
    }

    console.log("");
    console.log(`[rpa-login] platform=${platform}`);
    console.log(`[rpa-login] inboxUrl=${adapter.inboxUrl}`);
    console.log(`[rpa-login] profileDir=${profileDir}`);
    if (profileEnvVar) {
      console.log(`[rpa-login] env var: ${profileEnvVar}=${profileDirValue}`);
    }
    console.log("");
    console.log("Log in manually in the opened browser window.");
    console.log("After login, confirm the inbox loads (no 'log in or register' gate).");
    console.log("");

    let interrupted = false;
    let resolveSigint;
    const sigintPromise = new Promise((resolve) => {
      resolveSigint = resolve;
    });

    const handleSigint = () => {
      interrupted = true;
      process.stdout.write("\n[rpa-login] received SIGINT, closing browser...\n");
      resolveSigint?.();
    };

    process.once("SIGINT", handleSigint);
    const enter = waitForEnterPrompt("Press Enter here once login is complete to close the browser...\n");
    await Promise.race([enter.promise, sigintPromise]);
    process.removeListener("SIGINT", handleSigint);
    enter.cleanup();

    if (!interrupted) {
      await page.goto(adapter.inboxUrl, { waitUntil: "domcontentloaded" });
      if (await isAuthRequired(page, adapter)) {
        console.warn("[rpa-login] warning: inbox still looks logged out; worker will report SESSION_EXPIRED");
      } else {
        console.log("[rpa-login] inbox looks logged in; profile should work for worker ingest");
        if (platform === "spareroom") {
          console.log("[rpa-login] note: for headless runs, set LEASE_BOT_RPA_USER_AGENT_SPAREROOM to avoid SpareRoom auth gate");
        }
      }
    }
  } finally {
    // Ensure profile data flushes even when the user hits Ctrl-C.
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("[rpa-login] failed", error);
  process.exitCode = 1;
});
