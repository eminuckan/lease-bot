import { roles } from "@lease-bot/auth";

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function looksLikePlaceholder(value) {
  if (typeof value !== "string") {
    return true;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }

  return trimmed.startsWith("replace-with-");
}

export async function ensureDevAdminUser(pool, auth, { env = process.env, logger = console } = {}) {
  if (env.NODE_ENV === "production") {
    return;
  }

  if (env.LEASE_BOT_DEV_BOOTSTRAP_ADMIN !== "1") {
    return;
  }

  const email = env.LEASE_BOT_DEV_ADMIN_EMAIL || "admin@leasebot.com";
  const password = env.LEASE_BOT_DEV_ADMIN_PASSWORD;
  const name = env.LEASE_BOT_DEV_ADMIN_NAME || "Lease Bot Admin";

  if (looksLikePlaceholder(password)) {
    logger.warn("[bootstrap] dev admin bootstrap enabled but LEASE_BOT_DEV_ADMIN_PASSWORD is not set; skipping");
    return;
  }

  if (typeof auth?.api?.signUpEmail !== "function") {
    logger.warn("[bootstrap] auth.api.signUpEmail is unavailable; skipping dev admin bootstrap");
    return;
  }

  let existing = null;
  try {
    const result = await pool.query('SELECT id, role FROM "user" WHERE email = $1 LIMIT 1', [email]);
    existing = result.rows?.[0] || null;
  } catch (error) {
    logger.warn("[bootstrap] failed checking for existing dev admin", { error: formatError(error) });
    return;
  }

  if (!existing) {
    try {
      await auth.api.signUpEmail({
        // better-auth's own test utils call the API this way.
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        body: { email, password, name }
      });
      logger.log("[bootstrap] dev admin created", { email });
    } catch (error) {
      const message = formatError(error);
      if (!/user already exists/i.test(message)) {
        logger.warn("[bootstrap] failed creating dev admin", { error: message });
      }
    }
  }

  try {
    const result = await pool.query(
      'UPDATE "user" SET role = $1, name = $2, "emailVerified" = TRUE, "updatedAt" = NOW() WHERE email = $3',
      [roles.admin, name, email]
    );
    if (result.rowCount > 0) {
      logger.log("[bootstrap] dev admin ensured", { email });
    }
  } catch (error) {
    logger.warn("[bootstrap] failed promoting dev admin role", { error: formatError(error) });
  }
}

