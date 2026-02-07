# RPA Session Capture (Playwright storageState)

Most target platforms use anti-bot layers (Cloudflare / captcha) that often block fully headless login.
The most reliable workflow is to log in once manually in a persistent browser profile and reuse the
captured Playwright `storageState` in the worker.

This project supports session-based auth via `credentials.sessionRef` (or `credentials.storageStateRef`)
on `PlatformAccounts`. The referenced env var may contain either:

- A file path to a JSON storageState file, or
- A JSON storageState blob, or
- A `base64:<...>` encoded JSON storageState blob

## Capture with `playwright-cli`

Example for SpareRoom:

```bash
playwright-cli -s=spareroom open https://www.spareroom.com/roommate/logon.pl --headed --persistent --profile=/tmp/lease-bot-spareroom
# Log in manually in the opened browser window.
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

## Run the worker with Playwright runtime

```bash
export LEASE_BOT_RPA_RUNTIME=playwright
npm run start:worker
```

## Debug artifacts (optional)

When `LEASE_BOT_RPA_DEBUG=1`, failed runs will write artifacts under `LEASE_BOT_RPA_DEBUG_DIR`
(default `.playwright/rpa-debug`):

- `*.png` screenshot
- `*.html` captured page HTML
- `*.json` run metadata (platform, action, account id, attempt, URL)

