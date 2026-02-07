# Critical Path QA Gates (R18, R28, R29, R30)

This document defines the release-blocking quality gates for API, worker, web, and critical e2e paths.

## Context7 references used

- Library ID: `/microsoft/playwright`
  - Key guidance: prefer web-first assertions that auto-wait (`toBeVisible`-style behavior) and avoid timeout-driven checks.
  - Key guidance: use resilient signals (URL change, visible state, locator counts) instead of fixed sleeps to prevent flaky smoke evidence.

- Library ID: `/googlechrome/web-vitals`
  - Key guidance: use measurable responsiveness thresholds as guardrails (for example INP thresholds `[200, 500]` ms) and track interaction timing parts.
  - Key guidance: use timing values as performance proxies for release gates when full synthetic/lab profiling is not part of smoke.

- Library ID: `/github/docs`
  - Key guidance: protect release branches with required status checks and require all checks to pass before merge.
  - Key guidance: optionally require branches to be up to date before merge so checks run against the latest base branch.
  - Key guidance: use workflow path filters (`push`/`pull_request` + `paths`) so CI runs only for relevant file changes.
  - Key guidance: persist run evidence with `actions/upload-artifact` so release records can link to real run outputs.

- Library ID: `/websites/nodejs_latest-v20_x`
  - Key guidance: run targeted suites with `node --test <file...>` when a workflow needs explicit test-file scope.
  - Key guidance: use `node:test` subtests to keep platform-level scenarios isolated but still aggregated in one suite.

- Library ID: `/kubernetes/website`
  - Key guidance: use rollout status to verify deployment progress and keep rollback commands ready (`kubectl rollout undo`) as part of release runbooks.

## CI gate policy

- Branch protection must require all checks in this section to pass before merge.
- Checks run in fail-fast order so a broken upstream layer blocks release early.
- If any critical check fails, release is blocked until rerun is green and failure cause is documented.

## Required checks

1. API integration and route tests

```bash
npm run test -w @lease-bot/api
```

2. Worker pipeline tests (includes AI-provider selection behavior)

```bash
npm run test -w @lease-bot/worker
```

3. Web smoke test (login, role routing, mobile-first viewports, scheduling filters)

```bash
npm run smoke -w @lease-bot/web
```

Smoke assertions are release-blocking for:

- R17 list caps and bounded rendering (inbox <=20 rows, showings lists <=12 rows, summary-count parity).
- Explicit mobile card-list fallback checks for critical lists (inbox, weekly rules, availability, agent appointments).
- Performance proxies: login/admin->agent route transition duration, list render settle duration, and main JS payload budget.

4. Platform integration/e2e contract suite (all 5 required platforms)

```bash
node --test apps/api/test/platform-contract-e2e.test.js apps/worker/test/platform-contract-e2e.test.js
```

Platform suite assertions are release-blocking for:

- Required platform coverage parity: `spareroom`, `roomies`, `leasebreak`, `renthop`, `furnishedfinder`.
- At least one ingest and one outbound contract assertion per required platform.
- API contract parity for `requiredPlatforms` and `missingPlatforms` fields.

5. Release critical e2e package gate (platform + human handoff + lifecycle)

```bash
node --test apps/api/test/platform-contract-e2e.test.js apps/worker/test/platform-contract-e2e.test.js apps/api/test/showing-booking.test.js apps/api/test/platform-policy-routes.test.js apps/worker/test/worker.test.js
```

Release critical e2e assertions are release-blocking for:

- Human handoff routing (`human_required`) remains deterministic and suppresses unintended auto-send paths.
- Showing lifecycle transitions (workflow + showing states via admin/agent routes) keep terminal-state locks and preserve API contract behavior.
- Platform contract assertions and handoff/lifecycle assertions all pass in the same release gate run (100% package pass requirement).

## Evidence artifact paths

- `docs/qa/evidence/api-tests.log`
- `docs/qa/evidence/worker-tests.log`
- `docs/qa/evidence/web-smoke.log`
- `docs/qa/evidence/platform-integration-e2e.log`
- `docs/qa/evidence/release-critical-e2e.log`
- `docs/qa/evidence/ci-run-metadata.md`

## CI metadata evidence process

The `Critical Path Gates` workflow uploads a `ci-run-metadata` artifact for each run. This artifact includes run ID, URL, SHA, branch, and per-check job status sourced from the actual GitHub Actions execution.

1. Open the workflow run in GitHub Actions for the release candidate commit.
2. Download artifacts: `api-tests-log`, `worker-tests-log`, `web-smoke-log`, `platform-integration-e2e-log`, `release-critical-e2e-log`, and `ci-run-metadata`.
3. Copy the metadata artifact contents into `docs/qa/evidence/ci-run-metadata.md` and keep the run URL and status fields unchanged.
4. Keep this file aligned with release candidate evidence when branch protection gates are evaluated.

## Acceptance mapping

- R18: admin platform visibility remains release-blocking with explicit checks for `isActive`/`sendMode`/`integrationMode` and health/error visibility from authenticated admin routes/tests.
- R28: observability gate consumes platform/agent/conversation audit dimensions for rollout decisions.
- R29: CI requires all critical e2e packages (platform + handoff + lifecycle) to pass in release gate.
- R30: these gates are hard-linked to staged rollout and rollback decisions in `docs/release/release-checklist.md`.
