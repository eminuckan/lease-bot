# Production Operations Runbook

This runbook captures required runtime configuration, observability checks, and staged rollout operations for production.

## Context7 references used

- Library ID: `/github/docs`
  - Key guidance: enforce required status checks to keep release quality gates non-optional.
- Library ID: `/kubernetes/website`
  - Key guidance: monitor rollout with `kubectl rollout status` and prepare revision-aware rollback via `kubectl rollout undo --to-revision`.

## Required environment configuration

Use `.env.example` as the source of truth for variable names. Production values must come from a secrets manager, never from committed files.

### API and auth

- `API_HOST`, `API_PORT`, `API_LOG_LEVEL`, `API_BASE_URL`
- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `BETTER_AUTH_TRUSTED_ORIGINS`
- `WEB_BASE_URL`

### Worker and AI provider

- `WORKER_POLL_INTERVAL_MS`
- `WORKER_QUEUE_BATCH_SIZE`
- `WORKER_TASK`
- `WORKER_RUN_ONCE` (`0` in production long-running mode)
- `LEASE_BOT_RPA_RUNTIME` (**must** be `playwright` in production; startup fails fast otherwise)
- `AI_DECISION_PROVIDER` (`heuristic` or `gemini`)
- `AI_GEMINI_MODEL`
- `GOOGLE_GENERATIVE_AI_API_KEY` (required when provider is `gemini`)

### Platform connector credentials (R10)

- `SPAREROOM_USERNAME`, `SPAREROOM_PASSWORD`
- `ROOMIES_USERNAME`, `ROOMIES_PASSWORD`
- `LEASEBREAK_USERNAME`, `LEASEBREAK_PASSWORD`
- `RENTHOP_USERNAME`, `RENTHOP_PASSWORD`
- `FURNISHEDFINDER_USERNAME`, `FURNISHEDFINDER_PASSWORD`

Use `env:VAR_NAME` refs in platform account credential fields so secret values stay outside JSON payloads.

### Optional: session-based auth (recommended when anti-bot blocks headless login)

For platforms protected by Cloudflare/captcha, it is often more reliable to reuse a captured Playwright
`storageState` instead of attempting automated login in a headless worker.

If `storageState` is not sufficient (auth stored outside cookies/localStorage), configure a persistent
Playwright profile directory via `credentials.userDataDirRef` instead.

Env placeholders:

- `SPAREROOM_RPA_SESSION`
- `ROOMIES_RPA_SESSION`
- `LEASEBREAK_RPA_SESSION`
- `RENTHOP_RPA_SESSION`
- `FURNISHEDFINDER_RPA_SESSION`

Platform account credential shape:

- `{"sessionRef":"env:LEASEBREAK_RPA_SESSION"}`
- `{"userDataDirRef":"env:LEASEBREAK_RPA_PROFILE"}`

Capture workflow:

- See `docs/runbooks/rpa-session-capture.md`

## Operational preflight before release

1. Confirm all required env vars are present in the deploy target.
2. Confirm `AI_DECISION_PROVIDER` matches rollout intent (`heuristic` for safe baseline, `gemini` for AI rollout).
3. Confirm `LEASE_BOT_RPA_RUNTIME=playwright` in production worker deployment values.
4. Confirm CI evidence logs exist under `docs/qa/evidence/` from the current candidate.
5. Confirm mobile-first smoke coverage and scheduling flow checks passed (`npm run smoke -w @lease-bot/web`).
6. Confirm release critical e2e package gate passed in CI metadata (`release-critical-e2e-log`) using:

```bash
node --test apps/api/test/platform-contract-e2e.test.js apps/worker/test/platform-contract-e2e.test.js apps/api/test/showing-booking.test.js apps/api/test/platform-policy-routes.test.js apps/worker/test/worker.test.js
```

7. Confirm ingest linkage auditability exists for candidate traffic sample:

```sql
SELECT action, details->'linkage' AS linkage
  FROM "AuditLogs"
 WHERE action IN ('ingest_conversation_linkage_resolved', 'ingest_conversation_linkage_unresolved')
 ORDER BY created_at DESC
 LIMIT 20;
```

## Observability snapshot checks (R28)

Use the authenticated admin observability endpoint before and during rollout:

```bash
curl -sS \
  -H "Cookie: ${ADMIN_OBSERVABILITY_COOKIE}" \
  "${API_BASE_URL}/api/admin/observability?windowHours=24&auditLimit=50&errorLimit=25&signalLimit=25"
```

`ADMIN_OBSERVABILITY_COOKIE` must be an authenticated Better Auth session cookie captured from an admin login session in the target environment.

Required rollout visibility in the snapshot payload:

- `signals.auditByPlatform`: top critical actions by platform.
- `signals.auditByAgent`: top critical actions by actor/agent.
- `signals.auditByConversation`: top critical actions by conversation.
- Critical action coverage includes lifecycle/manual interventions: `workflow_state_transitioned`, `inbox_manual_reply_dispatched`.
- `signals.platformFailures`: per-stage failure concentration for dispatch/booking/api actions.

Promotion from canary to full requires two consecutive checks with no sustained 2x+ increase in critical error actions compared to shadow baseline.

## Rollout operations (shadow -> canary -> full)

1. Shadow
   - Deploy API and worker with outbound impact isolated to `draft_only` behavior.
   - Verify rollout completion:

```bash
kubectl rollout status deployment/lease-bot-api --timeout 10m
kubectl rollout status deployment/lease-bot-worker --timeout 10m
```

2. Canary
   - Enable canary cohort and rerun smoke + critical e2e gates.
   - Review observability snapshot with `windowHours=2`.

3. Full
   - Promote only after shadow and canary checks are green.
   - Watch rollout status and snapshot (`windowHours=1`) for at least one worker poll interval.

## Rollback conditions and commands (R30)

Rollback immediately when one of the following occurs:

- Any required CI/release gate fails.
- Required platform parity breaks (`missingPlatforms` non-empty).
- Worker startup fails with `MOCK_RUNTIME_FORBIDDEN` (runtime config regression).
- Critical error actions show sustained 2x+ spike vs shadow baseline.
- Human handoff or showing lifecycle checks regress in canary.

Rollback commands:

```bash
kubectl rollout undo deployment/lease-bot-api
kubectl rollout undo deployment/lease-bot-worker
kubectl rollout undo deployment/lease-bot-api --to-revision=<n>
kubectl rollout undo deployment/lease-bot-worker --to-revision=<n>
```

## Rollout and rollback drill evidence (R30)

For each release candidate, run one no-impact drill and capture evidence under `docs/qa/evidence/`.

1. Rollout drill (shadow -> canary simulation)
   - Record start timestamp and candidate SHA.
   - Run rollout status checks and one authenticated observability snapshot (`windowHours=2`).
   - Save command output and snapshot payload to `docs/qa/evidence/rollout-drill-<date>.md`.

2. Rollback drill (revision-targeted simulation)
   - Capture current deployment revisions: `kubectl rollout history deployment/lease-bot-api` and `kubectl rollout history deployment/lease-bot-worker`.
   - Execute rollback command in drill context (`kubectl rollout undo ... --to-revision=<n>`), then verify with `kubectl rollout status`.
   - Save command transcript, chosen revision, and verification output to `docs/qa/evidence/rollback-drill-<date>.md`.

3. Evidence minimums
   - Include operator, environment, command lines, and exit codes.
   - Include one authenticated observability payload excerpt proving platform/agent/conversation visibility.
   - Include explicit pass/fail result and follow-up owner if drill fails.

## Incident triage quick steps

1. Check API health endpoint and deployment status.
2. Check worker logs for provider selection, queue processing errors, and `MOCK_RUNTIME_FORBIDDEN` startup failures.
3. Verify production worker env explicitly sets `LEASE_BOT_RPA_RUNTIME=playwright`.
4. Query latest ingest linkage audit actions to confirm linkage resolution behavior.
5. If scheduling or assignment failures appear, rerun API and worker test suites in release branch.
6. If release regression is confirmed, follow rollback flow in `docs/release/release-checklist.md`.

## Acceptance mapping

- R18: runbook requires authenticated admin platform visibility checks for `isActive`, `sendMode`, `integrationMode`, `health`, and `error` fields.
- R28: runbook operationalizes platform/agent/conversation audit visibility during rollout.
- R29: runbook requires critical e2e package gate evidence before promotion.
- R30: runbook defines staged rollout execution and measurable rollback triggers.
- R5: runbook includes explicit ingest linkage audit verification query.
- R7: runbook enforces production runtime fail-fast guard (`LEASE_BOT_RPA_RUNTIME=playwright`).
- R10: runbook keeps credential-reference requirements for platform connectors.
