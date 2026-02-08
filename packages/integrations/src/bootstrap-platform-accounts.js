const DEFAULT_REQUIRED_PLATFORM_ACCOUNTS = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    platform: "leasebreak",
    accountName: "Default Leasebreak",
    accountExternalId: "lb_001",
    envPrefix: "LEASEBREAK",
    preferredAuth: "session"
  },
  {
    id: "12111111-1111-1111-1111-111111111111",
    platform: "spareroom",
    accountName: "Default SpareRoom",
    accountExternalId: "sr_001",
    envPrefix: "SPAREROOM",
    // SpareRoom often fails to reuse storageState; prefer a persistent profile directory.
    preferredAuth: "profile"
  },
  {
    id: "13111111-1111-1111-1111-111111111111",
    platform: "roomies",
    accountName: "Default Roomies",
    accountExternalId: "rm_001",
    envPrefix: "ROOMIES",
    preferredAuth: "session"
  },
  {
    id: "14111111-1111-1111-1111-111111111111",
    platform: "renthop",
    accountName: "Default RentHop",
    accountExternalId: "rh_001",
    envPrefix: "RENTHOP",
    preferredAuth: "session"
  },
  {
    id: "15111111-1111-1111-1111-111111111111",
    platform: "furnishedfinder",
    accountName: "Default FurnishedFinder",
    accountExternalId: "ff_001",
    envPrefix: "FURNISHEDFINDER",
    preferredAuth: "session"
  }
];

function buildDefaultCredentials(definition, env) {
  const profileVar = `${definition.envPrefix}_RPA_PROFILE`;
  const sessionVar = `${definition.envPrefix}_RPA_SESSION`;

  const hasProfile = typeof env?.[profileVar] === "string" && env[profileVar].trim().length > 0;
  const hasSession = typeof env?.[sessionVar] === "string" && env[sessionVar].trim().length > 0;

  if (hasProfile) {
    return {
      credentials: { userDataDirRef: `env:${profileVar}` },
      isActive: true,
      authMode: "profile",
      authEnvVar: profileVar
    };
  }

  if (hasSession) {
    return {
      credentials: { sessionRef: `env:${sessionVar}` },
      isActive: true,
      authMode: "session",
      authEnvVar: sessionVar
    };
  }

  if (definition.preferredAuth === "profile") {
    return {
      credentials: { userDataDirRef: `env:${profileVar}` },
      isActive: false,
      authMode: "profile",
      authEnvVar: profileVar
    };
  }

  return {
    credentials: { sessionRef: `env:${sessionVar}` },
    isActive: false,
    authMode: "session",
    authEnvVar: sessionVar
  };
}

export async function ensureRequiredPlatformAccounts(db, options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const sendMode = options.sendMode || "draft_only";
  const integrationMode = options.integrationMode || "rpa";
  const results = [];

  let created = 0;
  for (const account of DEFAULT_REQUIRED_PLATFORM_ACCOUNTS) {
    const { credentials, isActive, authMode, authEnvVar } = buildDefaultCredentials(account, env);

    try {
      // If the default record already exists, keep it aligned with env-provided auth.
      // This avoids manual SQL edits when switching from sessionRef to userDataDirRef.
      const updateResult = await db.query(
        `UPDATE "PlatformAccounts"
            SET credentials = COALESCE(credentials, '{}'::jsonb) || $1::jsonb,
                is_active = CASE WHEN $2::boolean THEN TRUE ELSE is_active END,
                updated_at = NOW()
          WHERE platform = $3
            AND account_external_id = $4`,
        [JSON.stringify(credentials), isActive, account.platform, account.accountExternalId]
      );
      const updated = updateResult.rowCount > 0;

      const insertResult = await db.query(
        `INSERT INTO "PlatformAccounts" (
           id,
           platform,
           account_name,
           account_external_id,
           credentials,
           is_active,
           send_mode,
           integration_mode
         )
         SELECT
           $1::uuid,
           $2,
           $3,
           $4,
           $5::jsonb,
           $6::boolean,
           $7,
           $8
         WHERE NOT EXISTS (
           SELECT 1
             FROM "PlatformAccounts"
            WHERE platform = $2
            LIMIT 1
         )
         ON CONFLICT DO NOTHING`,
        [
          account.id,
          account.platform,
          account.accountName,
          account.accountExternalId,
          JSON.stringify(credentials),
          isActive,
          sendMode,
          integrationMode
        ]
      );

      const inserted = insertResult.rowCount > 0;
      if (inserted) {
        created += 1;
      }

      results.push({
        platform: account.platform,
        inserted,
        updated,
        isActive,
        authMode,
        authEnvVar
      });
    } catch (error) {
      // DB not migrated yet.
      if (error && typeof error === "object" && "code" in error && error.code === "42P01") {
        logger.warn?.("[bootstrap] PlatformAccounts table missing; skipping platform account bootstrap (run migrations first)", {
          error: error instanceof Error ? error.message : String(error)
        });
        return { created: 0, results: [], skipped: true, reason: "missing_schema" };
      }
      throw error;
    }
  }

  if (created > 0) {
    logger.info?.("[bootstrap] ensured required platform accounts", { created, total: results.length });
  }

  return {
    created,
    results
  };
}

export { DEFAULT_REQUIRED_PLATFORM_ACCOUNTS };
