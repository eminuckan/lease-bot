# Release Checklist (Production Staged Rollout)

Use this checklist for every production rollout candidate.

## Context7 references used

- Library ID: `/github/docs`
  - Key guidance: gate merge/release with required status checks and keep branch up-to-date with base.
- Library ID: `/kubernetes/website`
  - Key guidance: track rollout progress with `kubectl rollout status`; rollback with `kubectl rollout undo` (or `--to-revision=<n>`).

## Pre-merge gates

- [ ] API tests pass: `npm run test -w @lease-bot/api`
- [ ] Worker tests pass: `npm run test -w @lease-bot/worker`
- [ ] Web smoke passes: `npm run smoke -w @lease-bot/web`
- [ ] Platform integration/e2e passes: `node --test apps/api/test/platform-contract-e2e.test.js apps/worker/test/platform-contract-e2e.test.js`
- [ ] Release critical e2e packages pass 100%: `node --test apps/api/test/platform-contract-e2e.test.js apps/worker/test/platform-contract-e2e.test.js apps/api/test/showing-booking.test.js apps/api/test/platform-policy-routes.test.js apps/worker/test/worker.test.js`
- [ ] Evidence logs updated in `docs/qa/evidence/`
- [ ] CI run metadata copied from `ci-run-metadata` workflow artifact into `docs/qa/evidence/ci-run-metadata.md`
- [ ] `.env` variable set audited against `.env.example`

## Observability/audit visibility gate (R28)

- [ ] Authenticated `/api/admin/observability` snapshot (`Cookie: ${ADMIN_OBSERVABILITY_COOKIE}`) includes `signals.auditByPlatform`, `signals.auditByAgent`, and `signals.auditByConversation` for current release window.
- [ ] Canary window has no unexplained spikes in `platform_dispatch_error`, `platform_dispatch_dlq`, `ai_reply_error`, or `showing_booking_failed` entries.
- [ ] Observability aggregate action set includes lifecycle and manual-reply critical actions (`workflow_state_transitioned`, `inbox_manual_reply_dispatched`) in platform/agent/conversation slices.
- [ ] `signals.auditByPlatform` includes expected active platforms and no unexpected `unknown` concentration.
- [ ] `signals.auditByAgent` aligns with assigned canary cohort agents and expected admin intervention volume.
- [ ] `signals.auditByConversation` top entries are reviewed for repeat-failure loops before promoting rollout.

## Required platform parity gate (R13)

- [ ] `requiredPlatforms` contract includes exactly: `spareroom`, `roomies`, `leasebreak`, `renthop`, `furnishedfinder`.
- [ ] Missing platform list (`missingPlatforms`) is empty for release candidate accounts.
- [ ] Each required platform passes at least one ingest and one outbound contract assertion in CI.

## Mobile-first verification gate (R17)

- [ ] Smoke run covers 320/375/430 viewport widths and tablet/desktop baselines.
- [ ] No uncaught runtime errors during login and route transitions.
- [ ] Inbox and scheduling lists enforce pagination caps and summary-count parity in smoke assertions.
- [ ] Mobile critical lists assert direct card-list fallback (no table rendering in mobile layouts).
- [ ] Route transitions, payload budget, and list render settle checks meet R17 smoke proxy budgets.
- [ ] Touch targets and sticky actions remain usable on phone-sized viewports.

## Scheduling flow verification gate (R9)

- [ ] Admin flow validates assignment and showing surfaces without runtime failures.
- [ ] Agent flow validates showing list and timeline rendering.
- [ ] Scheduling filters (status, unit, date range) return expected results.
- [ ] Empty-state behavior is explicit (no-data list and timeline messages).

## Staged rollout plan (R30)

1. Shadow stage (0% user impact)

- [ ] Deploy API and worker with platform connectors enabled in shadow mode only.
- [ ] Confirm all required checks are green in CI and no new critical runtime errors are observed.
- [ ] Validate platform health snapshots and ingest logs for all 5 required platforms.
- [ ] Capture baseline observability snapshot (`windowHours=24`) and store release note with top audit dimensions.

2. Canary stage (small controlled slice)

- [ ] Enable canary traffic for a small account cohort.
- [ ] Re-run smoke + platform integration/e2e checks against canary build.
- [ ] Monitor audit/observability counters for failure spikes by platform.
- [ ] Re-check observability snapshot (`windowHours=2`) and confirm no spike trend in critical error actions.

3. Full stage (100% rollout)

- [ ] Promote to full traffic only if shadow + canary checks stay green.
- [ ] Monitor rollout progress until complete:

```bash
kubectl rollout status deployment/lease-bot-api --timeout 10m
kubectl rollout status deployment/lease-bot-worker --timeout 10m
```

- [ ] Monitor metrics and logs for at least one worker poll interval window after full promotion.
- [ ] Confirm post-promotion observability snapshot (`windowHours=1`) remains within canary error envelope.

## Rollback guidance

Trigger rollback on any of the following:

- Any required CI gate fails (API, worker, web smoke, platform integration/e2e).
- `missingPlatforms` becomes non-empty for required platforms.
- Canary shows repeated platform dispatch failures, circuit-open fail-fast events, or elevated DLQ volume.
- Mobile-first smoke or scheduling checks fail in release environment.
- Elevated runtime errors in web/API/worker after rollout.
- Observability snapshot shows sustained 2x+ increase from shadow baseline in any critical error action for two consecutive checks.

Rollback commands:

```bash
kubectl rollout undo deployment/lease-bot-api
kubectl rollout undo deployment/lease-bot-worker
# Optional revision-targeted rollback:
kubectl rollout undo deployment/lease-bot-api --to-revision=<n>
kubectl rollout undo deployment/lease-bot-worker --to-revision=<n>
```

Post-rollback requirements:

1. Re-run critical checks.
2. Capture incident notes and failed gate details.
3. Patch forward only after root cause is documented.

## Acceptance mapping

- R18: release candidate proves authenticated admin visibility for `isActive`, `sendMode`, `integrationMode`, `health`, and `error` platform fields.
- R28: rollout promotion decisions require platform/agent/conversation audit visibility checks.
- R29: release is blocked unless critical e2e packages pass 100% in CI gate.
- R30: rollout follows shadow -> canary -> full stages with explicit rollback triggers and commands.
