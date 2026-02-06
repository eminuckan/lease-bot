# Release Checklist (Mobile-First + Scheduling)

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
- [ ] Evidence logs updated in `docs/qa/evidence/`
- [ ] CI run metadata copied from `ci-run-metadata` workflow artifact into `docs/qa/evidence/ci-run-metadata.md`
- [ ] `.env` variable set audited against `.env.example`

## Mobile-first verification gate (R17, R18)

- [ ] Smoke run covers 320/375/430 viewport widths and tablet/desktop baselines.
- [ ] No uncaught runtime errors during login and route transitions.
- [ ] Inbox and scheduling lists enforce pagination caps and summary-count parity in smoke assertions.
- [ ] Mobile critical lists assert direct card-list fallback (no table rendering in mobile layouts).
- [ ] Route transitions, payload budget, and list render settle checks meet R18 smoke proxy budgets.
- [ ] Touch targets and sticky actions remain usable on phone-sized viewports.

## Scheduling flow verification gate (R9)

- [ ] Admin flow validates assignment and showing surfaces without runtime failures.
- [ ] Agent flow validates showing list and timeline rendering.
- [ ] Scheduling filters (status, unit, date range) return expected results.
- [ ] Empty-state behavior is explicit (no-data list and timeline messages).

## Rollout plan

1. Deploy API and worker to staging/prod candidate.
2. Run smoke checks immediately after deployment.
3. Monitor rollout progress until complete:

```bash
kubectl rollout status deployment/lease-bot-api --timeout 10m
kubectl rollout status deployment/lease-bot-worker --timeout 10m
```

4. Monitor metrics and logs for at least one worker poll interval window.

## Rollback guidance

Trigger rollback on any of the following:

- CI critical-path gate fails post-merge.
- Mobile-first smoke or scheduling checks fail in release environment.
- Elevated runtime errors in web/API/worker after rollout.

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

- R9: release is blocked unless API/worker/web critical checks are green.
- R10: release requires env audit aligned with `.env.example` and runbook.
- R17: mobile-first verification is a hard gate before go-live.
- R18: mobile fallback, bounded list render, and performance proxy budgets are validated by smoke assertions.
