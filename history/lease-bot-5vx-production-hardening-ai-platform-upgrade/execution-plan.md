# Execution Plan: production-hardening-ai-platform-upgrade

Epic: lease-bot-5vx
PRD: /home/emin/repos/eminuckan/lease-bot/docs/prd/production-hardening-ai-platform-upgrade.md
Generated: 2026-02-06

## Tracks

| Track | Agent | Beads (in order) | File Scope |
| --- | --- | --- | --- |
| 1 | UI/Frontend | lease-bot-5vx.1 -> lease-bot-5vx.2 | apps/web/** |
| 2 | Scheduling Domain | lease-bot-5vx.3 -> lease-bot-5vx.5 | packages/db/**, apps/api/**, apps/web/** |
| 3 | AI Decisioning | lease-bot-5vx.6 | packages/ai/**, apps/worker/**, apps/api/** |
| 4 | Platform Integrations | lease-bot-5vx.4 | packages/integrations/**, apps/worker/**, packages/db/seeds/** |
| 5 | Ops & Quality | lease-bot-5vx.7 -> lease-bot-5vx.8 | apps/api/**, apps/worker/**, apps/web/**, docs/**, .env.example |

## Track Details

### Track 1: UI/Frontend - Runtime stabilization and mobile-first UI shell

File scope:
apps/web/**

Beads:
1. lease-bot-5vx.1: Stabilize web runtime and build reliability
2. lease-bot-5vx.2: Implement mobile-first shadcn UI and route modularization

Acceptance checks:
- Web app starts and renders without white screen or uncaught runtime errors.
- Core admin/agent screens are usable at 320-430px with mobile-first interaction patterns.

### Track 2: Scheduling Domain - Unit-agent assignment and showing booking

File scope:
packages/db/**, apps/api/**, apps/web/**

Beads:
1. lease-bot-5vx.3: Add unit-agent assignment and agent availability domain
2. lease-bot-5vx.5: Implement showing appointment booking and agent task visibility

Acceptance checks:
- Unit can be assigned to multiple agents and availability queries return valid unit+agent slot candidates.
- Lead slot selection creates conflict-safe appointment and assigned agent can see it in panel.

### Track 3: AI Decisioning - Gemini-based policy-gated automation

File scope:
packages/ai/**, apps/worker/**, apps/api/**

Beads:
1. lease-bot-5vx.6: Upgrade AI decision engine with Gemini via Vercel AI SDK

Acceptance checks:
- Tour/showing intent yields slot-aware response draft/send decision.
- Non-tour/risky/ambiguous messages are escalated to admin with reason codes.

### Track 4: Platform Integrations - Mandatory platform migration

File scope:
packages/integrations/**, apps/worker/**, packages/db/seeds/**

Beads:
1. lease-bot-5vx.4: Migrate platform connectors to mandatory five platforms

Acceptance checks:
- Connector registry supports Spareroom, Roomies, Leasebreak, RentHop, FurnishedFinder.
- Ingest/send contract tests pass with credential resolution and retry behavior.

### Track 5: Ops & Quality - Observability, tests, rollout readiness

File scope:
apps/api/**, apps/worker/**, apps/web/**, docs/**, .env.example

Beads:
1. lease-bot-5vx.7: Expand observability and audit for decision and scheduling flows
2. lease-bot-5vx.8: Production QA, documentation, and rollout hardening

Acceptance checks:
- Observability endpoint and audit logs include AI decisions, escalation reasons, booking lifecycle, and platform failures.
- CI-gated test set passes and release checklist documents mobile-first and scheduling flow verification.

## Cross-Track Dependencies

- Track 1 is foundational for all web-delivered flows.
- Track 2 depends on Track 1 for agent/admin UI surfaces.
- Track 3 depends on Track 2 scheduling data contracts for slot-aware AI output.
- Track 4 depends on Track 1 runtime baseline and runs in parallel with Tracks 2-3.
- Track 5 depends on Tracks 2-4 outputs for full observability and release verification.

## Requirement Coverage

| Requirement | Track | Beads |
| --- | --- | --- |
| R1 | 1 | lease-bot-5vx.1 |
| R2, R3 | 1 | lease-bot-5vx.2 |
| R4, R5, R6, R13 | 3 | lease-bot-5vx.6 |
| R7 | 4 | lease-bot-5vx.4 |
| R8 | 5 | lease-bot-5vx.7 |
| R9, R10 | 5 | lease-bot-5vx.8 |
| R11, R12 | 2 | lease-bot-5vx.3 |
| R14, R15, R16 | 2 | lease-bot-5vx.5 |
| R17, R18 | 1, 5 | lease-bot-5vx.2, lease-bot-5vx.8 |

## Key Learnings

- Mobile-first is mandatory because primary usage is from phones.
- Scheduling correctness is core product value: unit-agent mapping + availability + booking assignment.
- Auto-send remains policy-gated and escalation-first for risky or non-tour messages.
- Platform scope is explicit and non-negotiable: Spareroom, Roomies, Leasebreak, RentHop, FurnishedFinder.
