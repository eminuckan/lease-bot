BEGIN;

INSERT INTO "PlatformAccounts" (id, platform, account_name, account_external_id, credentials)
VALUES
  (
    '11111111-1111-1111-1111-111111111111',
    'leasebreak',
    'Downtown Leasing Team',
    'lb_001',
    '{"apiKeyRef":"env:LEASEBREAK_API_KEY"}'::jsonb
  )
ON CONFLICT (platform, account_external_id) DO UPDATE SET
  account_name = EXCLUDED.account_name,
  credentials = EXCLUDED.credentials,
  updated_at = NOW();

INSERT INTO "Agents" (id, platform_account_id, full_name, email, phone, timezone)
VALUES
  (
    '22222222-2222-2222-2222-222222222222',
    '11111111-1111-1111-1111-111111111111',
    'Morgan Hale',
    'morgan.hale@example.com',
    '+1-555-0101',
    'America/New_York'
  )
ON CONFLICT (id) DO UPDATE SET
  full_name = EXCLUDED.full_name,
  email = EXCLUDED.email,
  phone = EXCLUDED.phone,
  timezone = EXCLUDED.timezone,
  updated_at = NOW();

INSERT INTO "Units" (id, external_id, property_name, unit_number, address_line1, city, state, postal_code, bedrooms, bathrooms, square_feet)
VALUES
  (
    '33333333-3333-3333-3333-333333333333',
    'unit_ext_1001',
    'Atlas Apartments',
    '4B',
    '101 Main St',
    'Austin',
    'TX',
    '78701',
    2,
    2.00,
    950
  )
ON CONFLICT (property_name, unit_number) DO UPDATE SET
  external_id = EXCLUDED.external_id,
  address_line1 = EXCLUDED.address_line1,
  city = EXCLUDED.city,
  state = EXCLUDED.state,
  postal_code = EXCLUDED.postal_code,
  bedrooms = EXCLUDED.bedrooms,
  bathrooms = EXCLUDED.bathrooms,
  square_feet = EXCLUDED.square_feet,
  updated_at = NOW();

INSERT INTO "Listings" (id, unit_id, platform_account_id, listing_external_id, status, rent_cents, available_on, metadata)
VALUES
  (
    '44444444-4444-4444-4444-444444444444',
    '33333333-3333-3333-3333-333333333333',
    '11111111-1111-1111-1111-111111111111',
    'listing_4b_lb_001',
    'active',
    245000,
    CURRENT_DATE,
    '{"pets":"cats-only"}'::jsonb
  )
ON CONFLICT (platform_account_id, listing_external_id) DO UPDATE SET
  status = EXCLUDED.status,
  rent_cents = EXCLUDED.rent_cents,
  available_on = EXCLUDED.available_on,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

INSERT INTO "AvailabilitySlots" (id, unit_id, listing_id, starts_at, ends_at, timezone, source, notes)
VALUES
  (
    '55555555-5555-5555-5555-555555555555',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    date_trunc('day', NOW()) + INTERVAL '1 day' + INTERVAL '17 hours',
    date_trunc('day', NOW()) + INTERVAL '1 day' + INTERVAL '17 hours 30 minutes',
    'America/Chicago',
    'seed',
    'Initial seeded tour slot'
  )
ON CONFLICT (id) DO UPDATE SET
  starts_at = EXCLUDED.starts_at,
  ends_at = EXCLUDED.ends_at,
  timezone = EXCLUDED.timezone,
  status = 'open',
  notes = EXCLUDED.notes;

INSERT INTO "Conversations" (
  id,
  platform_account_id,
  listing_id,
  assigned_agent_id,
  external_thread_id,
  lead_name,
  lead_contact,
  status,
  last_message_at
)
VALUES
  (
    '66666666-6666-6666-6666-666666666666',
    '11111111-1111-1111-1111-111111111111',
    '44444444-4444-4444-4444-444444444444',
    '22222222-2222-2222-2222-222222222222',
    'thread_lb_001_abc',
    'Jamie Tenant',
    '{"email":"jamie.tenant@example.com"}'::jsonb,
    'open',
    NOW()
  )
ON CONFLICT (platform_account_id, external_thread_id) DO UPDATE SET
  listing_id = EXCLUDED.listing_id,
  assigned_agent_id = EXCLUDED.assigned_agent_id,
  lead_name = EXCLUDED.lead_name,
  lead_contact = EXCLUDED.lead_contact,
  status = EXCLUDED.status,
  last_message_at = EXCLUDED.last_message_at,
  updated_at = NOW();

INSERT INTO "Messages" (
  id,
  conversation_id,
  sender_type,
  sender_agent_id,
  external_message_id,
  direction,
  channel,
  body,
  metadata,
  sent_at
)
VALUES
  (
    '77777777-7777-7777-7777-777777777777',
    '66666666-6666-6666-6666-666666666666',
    'lead',
    NULL,
    'msg_ext_001',
    'inbound',
    'in_app',
    'Hi, can I tour this unit tomorrow?',
    '{"intent":"tour_request"}'::jsonb,
    NOW() - INTERVAL '5 minutes'
  ),
  (
    '88888888-8888-8888-8888-888888888888',
    '66666666-6666-6666-6666-666666666666',
    'agent',
    '22222222-2222-2222-2222-222222222222',
    'msg_ext_002',
    'outbound',
    'in_app',
    'Absolutely. I can offer a 5:00 PM slot.',
    '{"template":"tour_invite_v1"}'::jsonb,
    NOW() - INTERVAL '1 minute'
  )
ON CONFLICT (conversation_id, external_message_id) DO UPDATE SET
  body = EXCLUDED.body,
  metadata = EXCLUDED.metadata,
  sent_at = EXCLUDED.sent_at;

INSERT INTO "Templates" (id, platform_account_id, name, channel, locale, body, variables)
VALUES
  (
    '99999999-9999-9999-9999-999999999999',
    '11111111-1111-1111-1111-111111111111',
    'tour_invite_v1',
    'in_app',
    'en-US',
    'Thanks for your interest in {{unit_number}}. Available tour slots: {{slot_options}}.',
    '["unit_number","slot_options"]'::jsonb
  )
ON CONFLICT (platform_account_id, name, locale) DO UPDATE SET
  body = EXCLUDED.body,
  variables = EXCLUDED.variables,
  updated_at = NOW();

INSERT INTO "AutomationRules" (
  id,
  platform_account_id,
  name,
  description,
  trigger_type,
  conditions,
  action_type,
  action_config,
  priority,
  is_enabled
)
VALUES
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '11111111-1111-1111-1111-111111111111',
    'Auto reply to tour intent',
    'Respond with slot options when inbound message has tour_request intent.',
    'message_received',
    '{"intent":"tour_request"}'::jsonb,
    'send_template',
    '{"template":"tour_invite_v1"}'::jsonb,
    10,
    TRUE
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  trigger_type = EXCLUDED.trigger_type,
  conditions = EXCLUDED.conditions,
  action_type = EXCLUDED.action_type,
  action_config = EXCLUDED.action_config,
  priority = EXCLUDED.priority,
  is_enabled = EXCLUDED.is_enabled,
  updated_at = NOW();

INSERT INTO "AuditLogs" (actor_type, actor_id, entity_type, entity_id, action, details)
VALUES
  (
    'system',
    NULL,
    'migration',
    '001_basic_seed',
    'seed_applied',
    '{"source":"packages/db/seeds/001_basic_seed.sql"}'::jsonb
  );

INSERT INTO "ShowingAppointments" (
  id,
  idempotency_key,
  platform_account_id,
  conversation_id,
  unit_id,
  listing_id,
  agent_id,
  starts_at,
  ends_at,
  timezone,
  status,
  source,
  external_booking_ref,
  notes,
  metadata
)
VALUES
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'seed-booking-thread-lb-001',
    '11111111-1111-1111-1111-111111111111',
    '66666666-6666-6666-6666-666666666666',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    '22222222-2222-2222-2222-222222222222',
    date_trunc('day', NOW()) + INTERVAL '2 day' + INTERVAL '17 hours',
    date_trunc('day', NOW()) + INTERVAL '2 day' + INTERVAL '17 hours 30 minutes',
    'America/Chicago',
    'confirmed',
    'seed',
    'seed-ext-booking-001',
    'Seeded booked showing for agent panel.',
    '{"leadSelection":true}'::jsonb
  )
ON CONFLICT (idempotency_key) DO UPDATE SET
  platform_account_id = EXCLUDED.platform_account_id,
  conversation_id = EXCLUDED.conversation_id,
  unit_id = EXCLUDED.unit_id,
  listing_id = EXCLUDED.listing_id,
  agent_id = EXCLUDED.agent_id,
  starts_at = EXCLUDED.starts_at,
  ends_at = EXCLUDED.ends_at,
  timezone = EXCLUDED.timezone,
  status = EXCLUDED.status,
  source = EXCLUDED.source,
  external_booking_ref = EXCLUDED.external_booking_ref,
  notes = EXCLUDED.notes,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

COMMIT;
