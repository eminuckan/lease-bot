CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS "ShowingAppointments" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  platform_account_id UUID NOT NULL REFERENCES "PlatformAccounts"(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES "Conversations"(id) ON DELETE SET NULL,
  unit_id UUID NOT NULL REFERENCES "Units"(id) ON DELETE CASCADE,
  listing_id UUID REFERENCES "Listings"(id) ON DELETE SET NULL,
  agent_id UUID NOT NULL REFERENCES "Agents"(id) ON DELETE RESTRICT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'lead_selection',
  external_booking_ref TEXT,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at),
  CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed'))
);

CREATE INDEX IF NOT EXISTS idx_showing_appointments_agent_time
  ON "ShowingAppointments" (agent_id, starts_at ASC);

CREATE INDEX IF NOT EXISTS idx_showing_appointments_unit_time
  ON "ShowingAppointments" (unit_id, starts_at ASC);

CREATE INDEX IF NOT EXISTS idx_showing_appointments_status
  ON "ShowingAppointments" (status, starts_at ASC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_showing_appointments_external_booking_ref
  ON "ShowingAppointments" (platform_account_id, external_booking_ref)
  WHERE external_booking_ref IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'showing_appointments_no_double_booked_agent'
  ) THEN
    ALTER TABLE "ShowingAppointments"
      ADD CONSTRAINT showing_appointments_no_double_booked_agent
      EXCLUDE USING GIST (
        agent_id WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
      )
      WHERE (status IN ('pending', 'confirmed'));
  END IF;
END
$$;
