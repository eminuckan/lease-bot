CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS "UnitAgentAssignments" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id UUID NOT NULL REFERENCES "Units"(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES "Agents"(id) ON DELETE CASCADE,
  assignment_mode TEXT NOT NULL DEFAULT 'active',
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (unit_id, agent_id),
  CHECK (assignment_mode IN ('active', 'passive')),
  CHECK (priority >= 1 AND priority <= 1000)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_unit_agent_assignments_active_priority
  ON "UnitAgentAssignments" (unit_id, priority)
  WHERE assignment_mode = 'active';

CREATE INDEX IF NOT EXISTS idx_unit_agent_assignments_unit_id
  ON "UnitAgentAssignments" (unit_id, assignment_mode, priority ASC);

CREATE INDEX IF NOT EXISTS idx_unit_agent_assignments_agent_id
  ON "UnitAgentAssignments" (agent_id, assignment_mode, priority ASC);

CREATE TABLE IF NOT EXISTS "AgentAvailabilitySlots" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES "Agents"(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  source TEXT NOT NULL DEFAULT 'manual',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at),
  CHECK (status IN ('available', 'unavailable'))
);

CREATE INDEX IF NOT EXISTS idx_agent_availability_slots_agent_id
  ON "AgentAvailabilitySlots" (agent_id, starts_at ASC);

CREATE INDEX IF NOT EXISTS idx_agent_availability_slots_status
  ON "AgentAvailabilitySlots" (status, starts_at ASC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'agent_availability_no_overlap'
  ) THEN
    ALTER TABLE "AgentAvailabilitySlots"
      ADD CONSTRAINT agent_availability_no_overlap
      EXCLUDE USING GIST (
        agent_id WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
      )
      WHERE (status = 'available');
  END IF;
END
$$;

INSERT INTO "UnitAgentAssignments" (unit_id, agent_id, assignment_mode, priority)
SELECT DISTINCT
  l.unit_id,
  (l.metadata->>'assignedAgentId')::uuid,
  'active',
  100
FROM "Listings" l
WHERE l.metadata ? 'assignedAgentId'
  AND jsonb_typeof(l.metadata->'assignedAgentId') = 'string'
  AND (l.metadata->>'assignedAgentId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
ON CONFLICT (unit_id, agent_id) DO UPDATE
SET assignment_mode = 'active',
    priority = LEAST("UnitAgentAssignments".priority, EXCLUDED.priority),
    updated_at = NOW();
