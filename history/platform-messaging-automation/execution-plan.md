# Execution Plan: platform-messaging-automation

Epic: lease-bot-kmd
Generated: 2026-02-05T17:35:05.605Z

## Tracks

| Track | Agent | Beads (in order) | File Scope |
| --- | --- | --- | --- |
| 1 | TODO | lease-bot-kmd.1 -> lease-bot-kmd.3 | apps/api/**, packages/db/**, packages/auth/** |
| 2 | TODO | lease-bot-kmd.4 -> lease-bot-kmd.5 | apps/web/**, packages/ui/** |
| 3 | TODO | lease-bot-kmd.6 -> lease-bot-kmd.8 | apps/worker/**, packages/ai/**, packages/integrations/** |
| 4 | TODO | lease-bot-kmd.7 | apps/api/**, apps/worker/**, infra/**, docs/** |

## Track Details

### Track 1: <Agent> - Backend foundation

File scope:
apps/api/**, packages/db/**, packages/auth/**

Beads:
1. lease-bot-kmd.1: Bootstrap monorepo + runtime skeleton
2. lease-bot-kmd.2: Data model + migrations
3. lease-bot-kmd.3: Auth + RBAC (Better Auth)

### Track 2: <Agent> - Core UI

File scope:
apps/web/**, packages/ui/**

Beads:
1. lease-bot-kmd.4: Unit/Listing/Availability management
2. lease-bot-kmd.5: Inbox + templates + approval flow

### Track 3: <Agent> - Automation + integrations

File scope:
apps/worker/**, packages/ai/**, packages/integrations/**

Beads:
1. lease-bot-kmd.6: AI triage + reply pipeline
2. lease-bot-kmd.8: Platform connectors (API/RPA)

### Track 4: <Agent> - Observability

File scope:
apps/api/**, apps/worker/**, infra/**, docs/**

Beads:
1. lease-bot-kmd.7: Observability + audit

## Cross-Track Dependencies

- Track 2 depends on Track 1 (auth + schema).
- Track 3 depends on Tracks 1-2 (data + inbox/templates).
- Track 4 depends on Tracks 1 and 3 (schema + pipeline events).

## Key Learnings

- Internal tool; SSR yok; React SPA + TanStack Router.
- Hosting: single server + Postgres.
- Entegrasyon: API varsa API, yoksa RPA.
- Auth: Better Auth (provider configurable).
- AI: Vercel AI SDK ile triage + auto-send/draft karar.

