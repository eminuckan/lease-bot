# lease-bot

Open-source leasing inbox automation for property teams.

`lease-bot` ingests inbound rental messages, classifies intent, applies approval and guardrail rules, and generates draft or auto-sent responses using reusable templates.

## What it includes

- Multi-app monorepo (`web`, `api`, `worker`) with npm workspaces
- Postgres data model, migrations, and seed scripts
- Better Auth login + RBAC (`admin`, `agent`)
- Inbox + conversation workflows with template-driven replies
- Availability management (weekly recurring + daily overrides)
- AI triage pipeline with follow-up handling and unsubscribe guardrails
- Platform connector abstraction (API and RPA modes) with retry/backoff
- Audit and observability endpoints plus admin dashboard view

## Repository structure

- `apps/web`: React SPA (Vite)
- `apps/api`: HTTP API (auth, inbox, admin endpoints)
- `apps/worker`: queue/automation worker
- `packages/db`: DB migrations, seed, and shared DB utilities
- `packages/auth`: Better Auth integration helpers
- `packages/ai`: intent + eligibility + guardrail pipeline logic
- `packages/integrations`: platform connectors and retry helpers

## Requirements

- Node.js 20+
- npm 10+
- PostgreSQL 15+ (or compatible)
- Docker (optional, for local Postgres)

## Quick start

```bash
npm install
cp .env.example .env
```

### Start Postgres with Docker Compose (recommended)

```bash
docker compose up -d postgres
```

Optional DB UI:

```bash
docker compose --profile tools up -d adminer
```

Run migrations and seed data:

```bash
npm run migrate -w @lease-bot/db
npm run seed -w @lease-bot/db
```

Run apps in separate terminals:

```bash
npm run dev:web
npm run dev:api
npm run dev:worker
```

## Core scripts

```bash
# all workspaces
npm run build

# workspace tests
npm run test -w @lease-bot/api
npm run test -w @lease-bot/worker
```

## Environment

Copy `.env.example` to `.env` and adjust values for your environment.
DB scripts (`npm run migrate -w @lease-bot/db` and `npm run seed -w @lease-bot/db`) load the root `.env` automatically via Node `--env-file`.
API and worker scripts also load root `.env` automatically. Set `BETTER_AUTH_SECRET` to a non-default random value before running `npm run dev:api`.

Connector credentials use env references so secrets stay outside committed JSON. For credential fields in platform accounts, both `env:VAR_NAME` and `VAR_NAME` reference forms are supported (for example `apiKeyRef: "env:LEASEBREAK_API_KEY"` or `apiKeyRef: "LEASEBREAK_API_KEY"`). Keep actual values only in `.env` or deployment secret stores; do not commit live credentials.

AI decision provider toggles:

- `AI_DECISION_PROVIDER`: `heuristic` (default) or `gemini`
- `AI_GEMINI_MODEL`: optional Gemini model override (default `gemini-2.5-flash`)
- `GOOGLE_GENERATIVE_AI_API_KEY`: required when `AI_DECISION_PROVIDER=gemini`

Set `AI_DECISION_PROVIDER=heuristic` in local/test environments when no Gemini API key is configured.

Common variables:

- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `VITE_API_BASE_URL`
- `WORKER_POLL_INTERVAL_MS`

Docker Compose variables:

- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_PORT`
- `ADMINER_PORT`

## Important endpoints

- `GET /health`
- `GET /api/admin/observability`

Observability supports:

- `windowHours` (default `24`, max `168`)
- `auditLimit` (default `50`)
- `errorLimit` (default `25`)

## Project status

This project is active and evolving. API shapes and internal module boundaries may still change before `v1.0`.

## Contributing

Issues and pull requests are welcome.

Suggested flow:

1. Fork the repository
2. Create a feature branch
3. Add tests for behavior changes
4. Open a pull request with context and validation steps

## Security

If you discover a security issue, please open a private security advisory on GitHub instead of a public issue.

## License

MIT - see `LICENSE`.
