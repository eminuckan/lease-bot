# Production Operations Runbook

This runbook captures required runtime configuration for AI/provider/platform integration and day-2 operation checks.

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
- `AI_DECISION_PROVIDER` (`heuristic` or `gemini`)
- `AI_GEMINI_MODEL`
- `GOOGLE_GENERATIVE_AI_API_KEY` (required when provider is `gemini`)

### Platform connector credentials (R10)

- `SPAREROOM_USERNAME`, `SPAREROOM_PASSWORD`
- `ROOMIES_EMAIL`, `ROOMIES_PASSWORD`
- `LEASEBREAK_API_KEY`
- `RENTHOP_ACCESS_TOKEN`
- `FURNISHEDFINDER_USERNAME`, `FURNISHEDFINDER_PASSWORD`

Use `env:VAR_NAME` refs in platform account credential fields so secret values stay outside JSON payloads.

## Operational preflight before release

1. Confirm all required env vars are present in the deploy target.
2. Confirm `AI_DECISION_PROVIDER` matches rollout intent (`heuristic` for safe baseline, `gemini` for AI rollout).
3. Confirm CI evidence logs exist under `docs/qa/evidence/` from the current candidate.
4. Confirm mobile-first smoke coverage and scheduling flow checks passed (`npm run smoke -w @lease-bot/web`).

## Incident triage quick steps

1. Check API health endpoint and deployment status.
2. Check worker logs for provider selection and queue processing errors.
3. If scheduling or assignment failures appear, rerun API and worker test suites in release branch.
4. If release regression is confirmed, follow rollback flow in `docs/release/release-checklist.md`.

## Acceptance mapping

- R10: env and runbook guidance include AI/provider/platform variables and secret-handling rules.
- R9: runbook requires green API/worker/web gates and evidence artifacts before release.
