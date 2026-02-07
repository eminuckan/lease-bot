# Execution Plan - Excel Is Modelinden Production Otomasyona Gecis

## Epic
- ID: `lease-bot-xtg`
- Title: Excel Is Modelini Production Otomasyona Tasima
- PRD: `docs/prd/excel-is-modeli-otomasyon-ve-production-readiness.md`

## Scope
- Excel is modelini (ucret/payroll haric) uygulamaya birebir tasimak: lead -> showing -> follow-up -> outcome.
- 5 zorunlu platformda browser otomasyonu ile ingest + outbound akisini production seviyesine cikarmak.
- AI otomasyonu + human_required handoff + agent dashboard manuel dispatch akisini uc uca tamamlamak.

## Constraints
- Monorepo ve mevcut mimari korunacak (`apps/api`, `apps/worker`, `apps/web`, `packages/*`).
- Better Auth + RBAC korunacak.
- Secretlar env-ref/secret manager modelinde kalacak.
- Rollout defaultu `draft_only`; canary ile kontrollu `auto_send`.

## Track Plan ve Beads Gorevleri

### Track 1 - Workflow Domain
- Task: `lease-bot-xtg.2` (Workflow domain state model)
- Requirement refs: R5, R7, R8, R11, R12, R27
- Kabul:
  - API/DB state transition kurallari dogrulanir.
  - `no_reply` state yeni inbound ile stale kalmadan guncellenir.

### Track 2 - Platform Runtime (RPA)
- Task: `lease-bot-xtg.3` (RPA runner and five platform adapters)
- Requirement refs: R1, R2, R3, R4, R19
- Kabul:
  - 5 platform ingest+outbound contract testleri yesil.
  - Captcha/session/retry/circuit olaylari gozlemlenebilir.

### Track 3 - Worker Orchestration
- Task: `lease-bot-xtg.6` (Worker orchestration and idempotent dispatch)
- Requirement refs: R4, R20, R21, R22
- Dependencies: `lease-bot-xtg.2`, `lease-bot-xtg.3`
- Kabul:
  - Worker ingest->decision->dispatch zincirini tek modelde isletir.
  - Coklu workerda duplicate send engellenir.

### Track 4 - AI Outcome Routing
- Task: `lease-bot-xtg.5` (AI outcome routing and human_required decisions)
- Requirement refs: R6, R7, R14, R15, R17
- Dependencies: `lease-bot-xtg.2`, `lease-bot-xtg.6`
- Kabul:
  - Outcome seti testli siniflandirilir.
  - `human_required` durumlari agent aksiyonuna yonlenir.

### Track 5 - Showing Scheduling and Lifecycle
- Task: `lease-bot-xtg.4` (Showing slot engine and lifecycle APIs)
- Requirement refs: R9, R10, R11, R27
- Dependencies: `lease-bot-xtg.2`
- Kabul:
  - Slot secimi assignment + availability kesisimi ile yapilir.
  - Lifecycle API durumlari uc uca dogrulanir.

### Track 6 - Agent Workboard and Human Handoff UX
- Task: `lease-bot-xtg.7` (Agent dashboard handoff and workboard UX)
- Requirement refs: R16, R23, R24, R25, R26, R27
- Dependencies: `lease-bot-xtg.4`, `lease-bot-xtg.5`, `lease-bot-xtg.6`
- Kabul:
  - Agent dashboarddan manuel cevap platforma dispatch edilir.
  - Agent scope izolasyonu server-side garanti edilir.

### Track 7 - Observability, E2E, Rollout
- Task: `lease-bot-xtg.1` (Observability, E2E gates, and rollout hardening)
- Requirement refs: R18, R28, R29, R30
- Dependencies: `lease-bot-xtg.3`, `lease-bot-xtg.4`, `lease-bot-xtg.5`, `lease-bot-xtg.6`, `lease-bot-xtg.7`
- Kabul:
  - Kritik e2e paketleri release gate'te %100 pass.
  - Shadow -> canary -> full rollout + rollback runbook uygulanabilir olur.

## Milestones
- M1: Domain + RPA foundation (Track 1-2)
- M2: Worker + AI routing + showing lifecycle (Track 3-5)
- M3: Agent UX + hardening + rollout gates (Track 6-7)

## Release Readiness Gates
- 5 platform health ve contract kapsami tam.
- Duplicate outbound send = 0.
- Human-required handoff akisi dogrulanmis.
- E2E suite release gate'te yesil.
- Rollout ve rollback runbooklari tamam ve testli.
