BEGIN;

ALTER TABLE "Conversations"
  ADD COLUMN IF NOT EXISTS external_thread_label TEXT,
  ADD COLUMN IF NOT EXISTS external_thread_message_count INTEGER,
  ADD COLUMN IF NOT EXISTS external_inbox_sort_rank INTEGER;

-- Used for platform-specific inbox ordering (e.g., SpareRoom sorts by most recent inbound message).
CREATE INDEX IF NOT EXISTS idx_conversations_external_inbox_sort_rank
  ON "Conversations" (platform_account_id, external_inbox_sort_rank ASC);

COMMIT;

