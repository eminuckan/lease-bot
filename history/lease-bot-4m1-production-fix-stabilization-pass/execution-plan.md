# Execution Plan - Production Fix Stabilization Pass

## Epic
- ID: `lease-bot-4m1`
- Title: Production Fix Stabilization Pass
- PRD: `docs/prd/production-fix-stabilization-pass.md`

## Scope
- Release blocker kalan P0/P1 aciklarini kapatmak.
- API test + web smoke + release-critical gate'leri yesile almak.
- Worker slot source, AI workflow persist, ingest linkage ve runtime safety noktalarini production-ready hale getirmek.

## Track Plan ve Beads Gorevleri

### Track 1 - API Test Stabilization
- Task: `lease-bot-4m1.1`
- Requirement refs: R1, R9
- Kabul:
  - API test paketi 0 fail.
  - Workflow testleri deterministic calisir.

### Track 2 - Smoke Contract Alignment
- Task: `lease-bot-4m1.2`
- Requirement refs: R2, R9
- Kabul:
  - Web smoke pass.
  - Smoke assert'leri mevcut UI contract'i ile uyumlu.

### Track 3 - Worker Slot Source Consistency
- Task: `lease-bot-4m1.3`
- Requirement refs: R3, R9
- Dependency: `lease-bot-4m1.1`
- Kabul:
  - Slot context assignment+availability kesisiminden gelir.
  - Escalation/alternatif davranisi korunur.

### Track 4 - AI Outcome Workflow Persistence
- Task: `lease-bot-4m1.4`
- Requirement refs: R4, R8
- Dependency: `lease-bot-4m1.1`
- Kabul:
  - Outcome kararlar workflow state'e kalici yazilir.
  - no_reply recovery auditli calisir.

### Track 5 - Ingest Linkage + Runtime Safety
- Task: `lease-bot-4m1.5`
- Requirement refs: R5, R7, R10
- Dependencies: `lease-bot-4m1.2`, `lease-bot-4m1.3`, `lease-bot-4m1.4`
- Kabul:
  - Ingest baglam eslesmesi korunur/auditlenir.
  - Production env'de mock runtime fail-fast engellenir.

## Milestones
- M1: Gate recovery (Track 1-2)
- M2: Domain/scheduling consistency (Track 3-4)
- M3: Runtime hardening + release readiness (Track 5)

## Final Release Gates
- `npm run test -w @lease-bot/api` pass.
- `npm run test -w @lease-bot/worker` pass.
- `npm run test -w @lease-bot/web` pass.
- `npm run smoke -w @lease-bot/web` pass.
- Integration contract tests pass.
