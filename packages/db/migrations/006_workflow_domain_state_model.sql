BEGIN;

ALTER TABLE "Conversations"
  ADD COLUMN IF NOT EXISTS workflow_state TEXT NOT NULL DEFAULT 'lead',
  ADD COLUMN IF NOT EXISTS workflow_outcome TEXT,
  ADD COLUMN IF NOT EXISTS showing_state TEXT,
  ADD COLUMN IF NOT EXISTS follow_up_stage TEXT,
  ADD COLUMN IF NOT EXISTS follow_up_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS follow_up_owner_agent_id UUID REFERENCES "Agents"(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS follow_up_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS workflow_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'conversations_workflow_state_chk'
  ) THEN
    ALTER TABLE "Conversations"
      ADD CONSTRAINT conversations_workflow_state_chk
      CHECK (workflow_state IN ('lead', 'showing', 'follow_up_1', 'follow_up_2', 'outcome'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'conversations_workflow_outcome_chk'
  ) THEN
    ALTER TABLE "Conversations"
      ADD CONSTRAINT conversations_workflow_outcome_chk
      CHECK (
        workflow_outcome IS NULL
        OR workflow_outcome IN (
          'not_interested',
          'wants_reschedule',
          'no_reply',
          'showing_confirmed',
          'general_question',
          'human_required',
          'no_show',
          'completed'
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'conversations_showing_state_chk'
  ) THEN
    ALTER TABLE "Conversations"
      ADD CONSTRAINT conversations_showing_state_chk
      CHECK (
        showing_state IS NULL
        OR showing_state IN ('pending', 'confirmed', 'reschedule_requested', 'cancelled', 'completed', 'no_show')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'conversations_follow_up_stage_chk'
  ) THEN
    ALTER TABLE "Conversations"
      ADD CONSTRAINT conversations_follow_up_stage_chk
      CHECK (follow_up_stage IS NULL OR follow_up_stage IN ('follow_up_1', 'follow_up_2'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'conversations_follow_up_status_chk'
  ) THEN
    ALTER TABLE "Conversations"
      ADD CONSTRAINT conversations_follow_up_status_chk
      CHECK (follow_up_status IN ('pending', 'completed', 'cancelled'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'conversations_outcome_requires_outcome_state_chk'
  ) THEN
    ALTER TABLE "Conversations"
      ADD CONSTRAINT conversations_outcome_requires_outcome_state_chk
      CHECK (
        workflow_outcome IS NULL
        OR workflow_state = 'outcome'
        OR (workflow_outcome = 'showing_confirmed' AND workflow_state = 'showing')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'conversations_follow_up_stage_consistency_chk'
  ) THEN
    ALTER TABLE "Conversations"
      ADD CONSTRAINT conversations_follow_up_stage_consistency_chk
      CHECK (
        (workflow_state = 'follow_up_1' AND follow_up_stage = 'follow_up_1')
        OR (workflow_state = 'follow_up_2' AND follow_up_stage = 'follow_up_2')
        OR (workflow_state NOT IN ('follow_up_1', 'follow_up_2'))
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'conversations_follow_up_fields_chk'
  ) THEN
    ALTER TABLE "Conversations"
      ADD CONSTRAINT conversations_follow_up_fields_chk
      CHECK (
        follow_up_stage IS NULL
        OR (follow_up_due_at IS NOT NULL AND follow_up_owner_agent_id IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversations_workflow_state
  ON "Conversations" (workflow_state, workflow_updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_workflow_outcome
  ON "Conversations" (workflow_outcome, workflow_updated_at DESC);

DO $$
DECLARE
  status_constraint_name TEXT;
BEGIN
  SELECT c.conname
    INTO status_constraint_name
    FROM pg_constraint c
   WHERE c.conrelid = '"ShowingAppointments"'::regclass
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%status%pending%confirmed%cancelled%completed%'
   LIMIT 1;

  IF status_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "ShowingAppointments" DROP CONSTRAINT %I', status_constraint_name);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'showing_appointments_status_chk_v2'
       AND conrelid = '"ShowingAppointments"'::regclass
  ) THEN
    ALTER TABLE "ShowingAppointments"
      ADD CONSTRAINT showing_appointments_status_chk_v2
      CHECK (status IN ('pending', 'confirmed', 'reschedule_requested', 'cancelled', 'completed', 'no_show'));
  END IF;
END $$;

ALTER TABLE "ShowingAppointments"
  DROP CONSTRAINT IF EXISTS showing_appointments_no_double_booked_agent;

ALTER TABLE "ShowingAppointments"
  ADD CONSTRAINT showing_appointments_no_double_booked_agent
  EXCLUDE USING GIST (
    agent_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
  WHERE (status IN ('pending', 'confirmed', 'reschedule_requested'));

CREATE OR REPLACE FUNCTION workflow_validate_conversation_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.workflow_state <> OLD.workflow_state THEN
    IF NOT (
      (OLD.workflow_state = 'lead' AND NEW.workflow_state IN ('lead', 'showing', 'follow_up_1', 'outcome'))
      OR (OLD.workflow_state = 'showing' AND NEW.workflow_state IN ('showing', 'follow_up_1', 'outcome'))
      OR (OLD.workflow_state = 'follow_up_1' AND NEW.workflow_state IN ('follow_up_1', 'follow_up_2', 'outcome'))
      OR (OLD.workflow_state = 'follow_up_2' AND NEW.workflow_state IN ('follow_up_2', 'outcome'))
      OR (OLD.workflow_state = 'outcome' AND NEW.workflow_state IN ('outcome', 'lead'))
    ) THEN
      RAISE EXCEPTION 'Invalid workflow_state transition from % to %', OLD.workflow_state, NEW.workflow_state
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF NEW.showing_state IS DISTINCT FROM OLD.showing_state THEN
    IF NOT (
      OLD.showing_state IS NULL
      OR (OLD.showing_state = 'pending' AND NEW.showing_state IN ('pending', 'confirmed', 'reschedule_requested', 'cancelled', 'no_show'))
      OR (OLD.showing_state = 'confirmed' AND NEW.showing_state IN ('confirmed', 'reschedule_requested', 'cancelled', 'completed', 'no_show'))
      OR (OLD.showing_state = 'reschedule_requested' AND NEW.showing_state IN ('reschedule_requested', 'pending', 'confirmed', 'cancelled', 'no_show'))
      OR (OLD.showing_state = 'cancelled' AND NEW.showing_state = 'cancelled')
      OR (OLD.showing_state = 'completed' AND NEW.showing_state = 'completed')
      OR (OLD.showing_state = 'no_show' AND NEW.showing_state = 'no_show')
    ) THEN
      RAISE EXCEPTION 'Invalid showing_state transition from % to %', OLD.showing_state, NEW.showing_state
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF NEW.follow_up_stage IS DISTINCT FROM OLD.follow_up_stage THEN
    IF NOT (
      (OLD.follow_up_stage IS NULL AND NEW.follow_up_stage IN (NULL, 'follow_up_1'))
      OR (OLD.follow_up_stage = 'follow_up_1' AND NEW.follow_up_stage IN ('follow_up_1', 'follow_up_2'))
      OR (OLD.follow_up_stage = 'follow_up_2' AND NEW.follow_up_stage = 'follow_up_2')
      OR (NEW.workflow_state = 'outcome' AND NEW.follow_up_stage IS NULL)
    ) THEN
      RAISE EXCEPTION 'Invalid follow_up_stage transition from % to %', OLD.follow_up_stage, NEW.follow_up_stage
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF NEW.workflow_state IS DISTINCT FROM OLD.workflow_state
     OR NEW.workflow_outcome IS DISTINCT FROM OLD.workflow_outcome
     OR NEW.showing_state IS DISTINCT FROM OLD.showing_state
     OR NEW.follow_up_stage IS DISTINCT FROM OLD.follow_up_stage
     OR NEW.follow_up_due_at IS DISTINCT FROM OLD.follow_up_due_at
     OR NEW.follow_up_owner_agent_id IS DISTINCT FROM OLD.follow_up_owner_agent_id
     OR NEW.follow_up_status IS DISTINCT FROM OLD.follow_up_status THEN
    NEW.workflow_updated_at = NOW();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversations_workflow_transition_guard ON "Conversations";

CREATE TRIGGER conversations_workflow_transition_guard
BEFORE UPDATE OF workflow_state, workflow_outcome, showing_state, follow_up_stage, follow_up_due_at, follow_up_owner_agent_id, follow_up_status
ON "Conversations"
FOR EACH ROW
EXECUTE FUNCTION workflow_validate_conversation_transition();

CREATE OR REPLACE FUNCTION workflow_recover_no_reply_on_inbound()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  previous_outcome TEXT;
BEGIN
  IF NEW.direction <> 'inbound' THEN
    RETURN NEW;
  END IF;

  SELECT workflow_outcome
    INTO previous_outcome
    FROM "Conversations"
   WHERE id = NEW.conversation_id
   FOR UPDATE;

  IF previous_outcome = 'no_reply' THEN
    UPDATE "Conversations"
       SET workflow_state = 'lead',
           workflow_outcome = NULL,
           updated_at = NOW(),
           workflow_updated_at = NOW()
     WHERE id = NEW.conversation_id;

    INSERT INTO "AuditLogs" (actor_type, entity_type, entity_id, action, details)
    VALUES (
      'system',
      'conversation',
      NEW.conversation_id::text,
      'workflow_no_reply_recovered',
      jsonb_build_object(
        'conversationId', NEW.conversation_id,
        'messageId', NEW.id,
        'trigger', 'inbound_message'
      )
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_workflow_no_reply_recovery ON "Messages";

CREATE TRIGGER messages_workflow_no_reply_recovery
AFTER INSERT ON "Messages"
FOR EACH ROW
EXECUTE FUNCTION workflow_recover_no_reply_on_inbound();

COMMIT;
