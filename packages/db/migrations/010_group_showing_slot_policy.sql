CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "ShowingAppointments"
  DROP CONSTRAINT IF EXISTS showing_appointments_no_double_booked_agent;

-- Allow group showings for the same unit/listing/time while still preventing
-- one agent from being booked into overlapping slots for different units.
ALTER TABLE "ShowingAppointments"
  ADD CONSTRAINT showing_appointments_no_double_booked_agent
  EXCLUDE USING GIST (
    agent_id WITH =,
    unit_id WITH <>,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
  WHERE (status IN ('pending', 'confirmed', 'reschedule_requested'));
