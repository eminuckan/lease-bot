CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS "PlatformAccounts" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_external_id TEXT NOT NULL,
  credentials JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (platform, account_external_id)
);

CREATE TABLE IF NOT EXISTS "Agents" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_account_id UUID NOT NULL REFERENCES "PlatformAccounts"(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'leasing_agent',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "Units" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id TEXT,
  property_name TEXT NOT NULL,
  unit_number TEXT NOT NULL,
  address_line1 TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  bedrooms INTEGER,
  bathrooms NUMERIC(4,2),
  square_feet INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (property_name, unit_number)
);

CREATE TABLE IF NOT EXISTS "Listings" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id UUID NOT NULL REFERENCES "Units"(id) ON DELETE CASCADE,
  platform_account_id UUID NOT NULL REFERENCES "PlatformAccounts"(id) ON DELETE CASCADE,
  listing_external_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  rent_cents INTEGER NOT NULL,
  currency_code TEXT NOT NULL DEFAULT 'USD',
  available_on DATE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (platform_account_id, listing_external_id)
);

CREATE TABLE IF NOT EXISTS "AvailabilitySlots" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id UUID NOT NULL REFERENCES "Units"(id) ON DELETE CASCADE,
  listing_id UUID REFERENCES "Listings"(id) ON DELETE SET NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  source TEXT NOT NULL DEFAULT 'manual',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS "Conversations" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_account_id UUID NOT NULL REFERENCES "PlatformAccounts"(id) ON DELETE CASCADE,
  listing_id UUID REFERENCES "Listings"(id) ON DELETE SET NULL,
  assigned_agent_id UUID REFERENCES "Agents"(id) ON DELETE SET NULL,
  external_thread_id TEXT NOT NULL,
  lead_name TEXT,
  lead_contact JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open',
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (platform_account_id, external_thread_id)
);

CREATE TABLE IF NOT EXISTS "Messages" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES "Conversations"(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL,
  sender_agent_id UUID REFERENCES "Agents"(id) ON DELETE SET NULL,
  external_message_id TEXT,
  direction TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'in_app',
  body TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conversation_id, external_message_id)
);

CREATE TABLE IF NOT EXISTS "Templates" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_account_id UUID REFERENCES "PlatformAccounts"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'in_app',
  locale TEXT NOT NULL DEFAULT 'en-US',
  body TEXT NOT NULL,
  variables JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (platform_account_id, name, locale)
);

CREATE TABLE IF NOT EXISTS "AutomationRules" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_account_id UUID REFERENCES "PlatformAccounts"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL,
  conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
  action_type TEXT NOT NULL,
  action_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  priority INTEGER NOT NULL DEFAULT 100,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "AuditLogs" (
  id BIGSERIAL PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id UUID,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listings_unit_id ON "Listings" (unit_id);
CREATE INDEX IF NOT EXISTS idx_availability_slots_unit_id ON "AvailabilitySlots" (unit_id);
CREATE INDEX IF NOT EXISTS idx_conversations_listing_id ON "Conversations" (listing_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON "Messages" (conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON "Messages" (sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_templates_platform_account_id ON "Templates" (platform_account_id);
CREATE INDEX IF NOT EXISTS idx_automation_rules_platform_account_id ON "AutomationRules" (platform_account_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON "AuditLogs" (entity_type, entity_id, created_at DESC);
