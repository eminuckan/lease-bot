BEGIN;

ALTER TABLE "PlatformAccounts"
  ADD COLUMN IF NOT EXISTS send_mode TEXT,
  ADD COLUMN IF NOT EXISTS integration_mode TEXT NOT NULL DEFAULT 'rpa';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'platform_accounts_platform_allowed_chk'
  ) THEN
    ALTER TABLE "PlatformAccounts"
      ADD CONSTRAINT platform_accounts_platform_allowed_chk
      CHECK (platform IN ('spareroom', 'roomies', 'leasebreak', 'renthop', 'furnishedfinder'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'platform_accounts_send_mode_chk'
  ) THEN
    ALTER TABLE "PlatformAccounts"
      ADD CONSTRAINT platform_accounts_send_mode_chk
      CHECK (send_mode IS NULL OR send_mode IN ('auto_send', 'draft_only'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'platform_accounts_integration_mode_chk'
  ) THEN
    ALTER TABLE "PlatformAccounts"
      ADD CONSTRAINT platform_accounts_integration_mode_chk
      CHECK (integration_mode = 'rpa');
  END IF;
END $$;

COMMIT;
