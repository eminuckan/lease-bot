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

async function waitForEnter(prompt) {
  if (process.stdin.isTTY) {
    process.stdout.write(prompt);
    await new Promise((resolve) => process.stdin.once("data", resolve));
    return true;
  }
  return false;
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

    await waitForEnter("Press Enter here once login is complete to close the browser...\n");
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error("[rpa-login] failed", error);
  process.exitCode = 1;
});
