BEGIN;

ALTER TABLE "AuditLogs"
  ALTER COLUMN actor_id TYPE TEXT
  USING actor_id::text;

COMMIT;

