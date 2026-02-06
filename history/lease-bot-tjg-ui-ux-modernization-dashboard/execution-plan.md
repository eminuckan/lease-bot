# Execution Plan - UI/UX Modernization Dashboard

## Epic
- ID: lease-bot-tjg
- Title: UI/UX Modernization - Shadcn Dashboard Production Readiness
- PRD: docs/prd/ui-ux-modernization-dashboard.md

## Scope
- Modernize login + app shell + admin/agent panels with shadcn-first, minimal, neutral UI language.
- Add persistent dark mode, Sonner toast feedback, switch patterns, and date/calendar UX improvements.
- Add a simple monthly availability calendar for agent planning.
- Preserve existing route/auth/domain behavior and keep smoke-critical workflow stable.

## Constraints
- Keep React 18 + Vite + TanStack Router architecture unchanged.
- No backend/API contract changes.
- Mobile-first quality target for 320-430 widths.

## Work graph (dependency order)
1. lease-bot-tjg.5 Foundation: tokenized neutral design system + theme core
2. lease-bot-tjg.2 Layout + navigation shell and login modernization (depends on .5)
3. lease-bot-tjg.7 Interaction feedback: Sonner toast + switch patterns (depends on .2)
4. lease-bot-tjg.6 Date UX migration to shadcn date picker/calendar (depends on .2)
5. lease-bot-tjg.4 Agent monthly availability calendar with unit/agent filters (depends on .6)
6. lease-bot-tjg.3 Admin/agent panel UI polish and consistency pass (depends on .7 and .4)
7. lease-bot-tjg.1 QA alignment: smoke selectors + build verification (depends on .3)

## Acceptance checkpoints by track
- Foundation (.5): neutral tokens + typography/spacing scale active in light/dark.
- Layout/Login (.2): role-based navigation and auth flows preserved with improved hierarchy.
- Toast/Switch (.7): critical success/error actions emit toast and policy toggles use switch semantics.
- Date UX (.6): date filters use shadcn picker and preserve API query compatibility.
- Calendar (.4): monthly view reflects availability state and filter context.
- Polish (.3): consistent empty/loading/error states across critical panels.
- QA (.1): `npm run build -w @lease-bot/web` and `npm run smoke -w @lease-bot/web` both pass.

## Risks and mitigations
- Smoke selector churn: preserve stable test IDs and update only required selectors.
- Theme flicker: hydrate theme before full UI paint.
- Calendar complexity: keep first version intentionally lightweight and composable.
- UX regressions: keep behavior logic in context untouched and validate panel-by-panel.
