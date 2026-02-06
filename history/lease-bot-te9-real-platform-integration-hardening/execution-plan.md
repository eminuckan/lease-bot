# Execution Plan: real-platform-integration-hardening

Epic: lease-bot-te9
PRD: /home/emin/repos/eminuckan/lease-bot/docs/prd/real-platform-integration-hardening.md
Generated: 2026-02-06

## Tracks

| Track | Agent | Beads (in order) | File Scope |
| --- | --- | --- | --- |
| 1 | API/DB | lease-bot-te9.1 | packages/db/migrations/**, packages/db/seeds/**, apps/api/src/server.js |
| 2 | Integrations/Worker | lease-bot-te9.2 | packages/integrations/src/**, apps/worker/src/** |
| 3 | Worker Reliability | lease-bot-te9.3 | apps/worker/src/**, packages/integrations/src/**, apps/api/src/observability.js |
| 4 | Admin UI/API | lease-bot-te9.4 | apps/web/src/routes/admin-route.jsx, apps/web/src/features/**, apps/web/src/state/lease-bot-context.jsx, apps/api/src/server.js |
| 5 | QA/Release | lease-bot-te9.5 | apps/api/test/**, apps/worker/test/**, apps/web/scripts/smoke.mjs, .github/workflows/critical-gates.yml, docs/** |

## Track Details

### Track 1: API/DB - Platform policy modeli ve API kontratlari

File scope:
packages/db/migrations/**, packages/db/seeds/**, apps/api/src/server.js

Beads:
1. lease-bot-te9.1: Platform policy modeli ve API kontratlari

Acceptance checks:
- Admin API uzerinden platform bazli `is_active` ve `send_mode` degerleri okunup guncellenir.
- Worker tarafi pasif platform hesaplari icin ingest/send cikarmadan akisi atlar.

### Track 2: Integrations/Worker - Bes platform icin RPA connector implementasyonu

File scope:
packages/integrations/src/**, apps/worker/src/**

Beads:
1. lease-bot-te9.2: Bes platform icin RPA connector implementasyonu

Acceptance checks:
- Her platform (spareroom/roomies/leasebreak/renthop/furnishedfinder) icin ingest + outbound contract testleri gecer.
- RPA anti-bot dayaniklilik adimlari (rate limit, jitter, session refresh) uygulanir ve testlenir.

### Track 3: Worker Reliability - Dispatch guvenilirligi, idempotency ve DLQ

File scope:
apps/worker/src/**, packages/integrations/src/**, apps/api/src/observability.js

Beads:
1. lease-bot-te9.3: Dispatch guvenilirligi, idempotency ve DLQ

Acceptance checks:
- Ayni dispatch anahtariyla tekrar tetiklenen outbound islerde duplicate send olusmaz.
- Retry limiti dolan platform hatalari DLQ/escalation ve audit metriklerine platform+stage bilgisiyle yazilir.

### Track 4: Admin UI/API - platform ac-kapa ve auto_send-draft_only

File scope:
apps/web/src/routes/admin-route.jsx, apps/web/src/features/**, apps/web/src/state/lease-bot-context.jsx, apps/api/src/server.js

Beads:
1. lease-bot-te9.4: Admin UI: platform ac-kapa ve auto_send-draft_only

Acceptance checks:
- Admin panelde platform bazli ac/kapa degisiklikleri kayit edilir ve worker davranisina yansir.
- `auto_send` acikken policy uygun mesaj sent, `draft_only` modunda her zaman draft uretilir.

### Track 5: QA/Release - E2E, CI gate ve staged rollout hardening

File scope:
apps/api/test/**, apps/worker/test/**, apps/web/scripts/smoke.mjs, .github/workflows/critical-gates.yml, docs/**

Beads:
1. lease-bot-te9.5: E2E, CI gate ve staged rollout hardening

Acceptance checks:
- CI pipeline API + worker + web smoke + platform e2e/contract gate adimlari yesil olmadan merge/release vermez.
- Runbook ve checklist dosyalari shadow -> canary -> full rollout ve rollback tetiklerini acik tanimlar.

## Cross-Track Dependencies

- lease-bot-te9.2 depends on lease-bot-te9.1
- lease-bot-te9.3 depends on lease-bot-te9.1 and lease-bot-te9.2
- lease-bot-te9.4 depends on lease-bot-te9.1
- lease-bot-te9.5 depends on lease-bot-te9.2, lease-bot-te9.3, lease-bot-te9.4

## Requirement Coverage

| Requirement | Track | Beads |
| --- | --- | --- |
| R1, R2 | 1, 2 | lease-bot-te9.1, lease-bot-te9.2 |
| R3 | 1 | lease-bot-te9.1 |
| R4, R5, R6 | 1, 4 | lease-bot-te9.1, lease-bot-te9.4 |
| R7, R8 | 2, 3 | lease-bot-te9.2, lease-bot-te9.3 |
| R9 | 1, 2 | lease-bot-te9.1, lease-bot-te9.2 |
| R10, R11 | 3, 4 | lease-bot-te9.3, lease-bot-te9.4 |
| R12 | 3, 4 | lease-bot-te9.3, lease-bot-te9.4 |
| R13, R14, R15 | 5 | lease-bot-te9.5 |
| R16 | 2 | lease-bot-te9.2 |

## Key Learnings

- Bu feature icin platformlarin tamami RPA-only entegrasyon olarak planlandi.
- Kritik urun kontrolu admin panelindeki iki policy: platform aktiflik ve send_mode (`auto_send`/`draft_only`).
- Production basarisi icin en kritik teknik eksen dispatch idempotency + anti-bot dayaniklilik + release gate disiplinidir.
