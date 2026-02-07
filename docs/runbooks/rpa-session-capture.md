# RPA Session Capture (Playwright storageState)

Most target platforms use anti-bot layers (Cloudflare / captcha) that often block fully headless login.
The most reliable workflow is to log in once manually in a persistent browser profile and reuse the
captured Playwright `storageState` in the worker.

This project supports session-based auth via `credentials.sessionRef` (or `credentials.storageStateRef`)
on `PlatformAccounts`. The referenced env var may contain either:

- A file path to a JSON storageState file, or
- A JSON storageState blob, or
- A `base64:<...>` encoded JSON storageState blob

If a platform stores auth state outside cookies/localStorage (for example in IndexedDB),
`storageState` may not keep you logged in. In that case, configure a persistent profile directory
via `credentials.userDataDirRef` instead.

## Capture with `playwright-cli`

Example for SpareRoom:

```bash
playwright-cli -s=spareroom open https://www.spareroom.com/roommate/logon.pl --headed --persistent --profile=/tmp/lease-bot-spareroom
# Log in manually in the opened browser window.
# Important: After login, open the inbox URL and confirm you see real threads (not a "log in or register" prompt).
playwright-cli -s=spareroom state-save /tmp/spareroom-auth.json
playwright-cli -s=spareroom close
```

Set env:

```bash
export SPAREROOM_RPA_SESSION=/tmp/spareroom-auth.json
```

Ensure your platform account credentials reference it:

```json
{ "sessionRef": "env:SPAREROOM_RPA_SESSION" }
```

## Alternative: persistent profile (userDataDir)

If `storageState` does not work reliably for a platform, use the same persistent profile directory you logged in with:

```bash
export SPAREROOM_RPA_PROFILE=/tmp/lease-bot-spareroom
```

And set platform account credentials:

```json
{ "userDataDirRef": "env:SPAREROOM_RPA_PROFILE" }
```

## Run the worker with Playwright runtime

```bash
export LEASE_BOT_RPA_RUNTIME=playwright
# Optional: many platforms block fully headless browsing
# export LEASE_BOT_RPA_HEADLESS=0
npm run start:worker
```

## Debug artifacts (optional)

When `LEASE_BOT_RPA_DEBUG=1`, failed runs will write artifacts under `LEASE_BOT_RPA_DEBUG_DIR`
(default `.playwright/rpa-debug`):

- `*.png` screenshot
- `*.html` captured page HTML
- `*.json` run metadata (platform, action, account id, attempt, URL)
