import fs from "node:fs";
import path from "node:path";
import process from "node:process";

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

async function main() {
  const platform = process.argv[2];
  if (!platform) {
    console.error("Usage: node scripts/rpa-unlock.mjs <platform>");
    console.error("Platforms: spareroom, roomies, leasebreak, renthop, furnishedfinder");
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

  const lockFiles = ["SingletonLock", "SingletonCookie", "SingletonSocket"].map((name) => path.join(profileDir, name));

  let removed = 0;
  for (const file of lockFiles) {
    try {
      fs.rmSync(file, { force: true });
      removed += 1;
      console.log(`[rpa-unlock] removed ${file}`);
    } catch (error) {
      console.warn(`[rpa-unlock] failed removing ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (removed === 0) {
    console.log(`[rpa-unlock] nothing to remove in ${profileDir}`);
  } else {
    console.log(`[rpa-unlock] done (profileDir=${profileDir})`);
  }
}

main().catch((error) => {
  console.error("[rpa-unlock] failed", error);
  process.exitCode = 1;
});

