# deploy-bot — push a file from Telegram → repo updates → Heroku app deploys

**What it is:** A Telegram bot that lets Bob or the VA send a single file, tap which site it
belongs to and where it goes, and have it committed to the right GitHub repo and deployed to
the linked Heroku app — with no GitHub, no Heroku dashboard and no terminal.

**Status (2026-08-12):** BUILT, TESTED (69/69), DEPLOYED and LIVE as a Worker.
🛑 **NOT YET USABLE — blocked on Bob for 4 things** (see *Blocked on Bob* below). Nothing has
been committed to any of his repos and no Heroku app has been deployed. $0 spent.

## Live assets
- **Worker:** `https://deploy-bot.fleet-fefsba.workers.dev` (Cloudflare, **Osanix/Ozalyn account**
  `431aaf5f...`). `/` = health, `POST /webhook` = Telegram. Cron `* * * * *` polls in-flight builds.
- **D1:** `deploy_bot`, id `3882a8d0-eff9-4dea-9d18-1deac3f5c1ca`.
- **Guide (noindex):** https://oliveroliver10816.github.io/deploy-bot-guide/
- **Repo:** `oliveroliver10816/deploy-bot-guide` (Pages from `/docs`).
- **Local secrets:** `/root/.config/deploy-bot/config.json` (600) — webhook secret; bot token is
  added there by `setup.sh`. The webhook secret is ALSO a Worker secret; keep both in sync.

## Bob's answers that set the design (2026-08-12)
1. **No approval gate** — "VA deploys straight to live".
2. **One file at a time** (not ZIPs, not whole-folder pushes).
3. **No Heroku auto-deploy today** — "I deploy manually"; the bot takes over both steps via API.

Because there is no gate, two things were added that he did not ask for and should not be
removed: **`/undo`** (restores the exact previous bytes and redeploys) and an **owner
notification on every deploy someone else makes**. Neither slows the VA down.

## Blocked on Bob
1. **A NEW bot token** from @BotFather. 🛑 Must NOT reuse the `telegram-bridge` bot
   (`8650290859:…`) — that one runs Claude with `--dangerously-skip-permissions`, i.e. a root
   shell, and setting a webhook on it would also break its getUpdates polling if it is ever
   re-enabled. Then run `./setup.sh <token>` — it verifies, stores the secret and sets the webhook.
2. **A GitHub token** — fine-grained, the 2 repos, `Contents: Read and write`. Pasted into the
   bot via `/connect`, not to us.
3. **A Heroku API key** — `heroku authorizations:create` or the dashboard. Same, via `/connect`.
4. **The VA's Telegram numeric ID** — via `/adduser`.

Everything after that is tapping buttons: `/addrepo` lists his repos, `/addapp` lists his apps
and links one to a repo.

⭐ **Ordering problem, solved by `seed.py`:** the normal `/connect` route needs a live bot, and the
bot needs a BotFather token — so the GitHub/Heroku keys could not go in first. `./seed.py github
<tok>` / `./seed.py heroku <tok>` verifies the credential against the real API and writes it
straight into D1; `./seed.py list` shows everything wired. Round-trip tested with a real token
(stored byte-for-byte, then deleted). Omit the token argument to be prompted hidden.
🛑 **Only the BotFather token is truly un-substitutable** — no API can create a Telegram bot.

## Key facts / decisions
- **Cloudflare Worker, not this server.** This box hangs ~daily and a migration is in progress;
  a deploy tool must not live on it. Matches the house pattern (fleetview, ai-visibility-collect).
- **No git binary, no clone.** A one-file commit is a single `PUT /repos/{o}/{r}/contents/{path}`,
  which is the whole reason this fits in a Worker.
- ⭐ **Heroku deploys via `POST /sources` → upload the tarball ourselves → `POST /apps/{app}/builds`.**
  Heroku's docs only show a GitHub tarball URL for **public** repos and never send an auth header,
  so handing it a private-repo URL would 404 at build time. Uploading the archive ourselves is one
  code path for public and private both.
- ⚠️ **Heroku's docs contradict themselves on build status** — prose says `successful`, the JSON
  sample says `succeeded`. `normalizeStatus()` accepts both; unknown → `pending`, never a false
  green. There is a test for this.
- ⚠️ **The GitHub tarball 302s to a signed codeload URL — the Authorization header must NOT be
  forwarded** to it, so the redirect is followed manually. A test fails loudly if that regresses.
- ⚠️ **Telegram caps `callback_data` at 64 bytes**, and repo paths blow through that. Buttons carry
  an INDEX into a per-user option list held in `state.data`. There is a test asserting no button
  ever exceeds 64 bytes.
- ⭐ **Every upload gets a 4-char `sid` stamped into its buttons.** State is one slot per user, so
  without it a VA who sends file B while file A's buttons are still on screen could tap A's
  buttons and deploy **B** to A's path. Stale taps are refused. Found by self-review, not by a
  report — do not remove the guard.
- **Credentials live in D1, one row per account** (`connections`), which is what makes "connect a
  new GitHub / new Heroku" a chat flow rather than a code change. A second account of either kind
  coexists with the first.
- **Token messages are deleted from the chat** immediately after being read (Telegram permits a
  bot to delete incoming messages in private chats).
- **Webhook is authenticated** with Telegram's `secret_token` header; wrong/missing → 403.
- **One app per repo**: linking a second app to a repo moves the link instead of creating two, so
  one file push can never fan out into two deploys.
- **Double-build detection**: `/addapp` probes `GET /apps/{app}/github` and warns if the app
  already auto-deploys from GitHub, because that plus our build = two racing builds.
- `ensureSchema` is cached in a `WeakSet` keyed on the D1 binding — once per isolate, not 8
  round-trips per webhook, while still initialising a fresh DB in tests.
- Limits: 20 MB per file (Telegram's bot-download cap), 40 MB per repo archive (Worker memory —
  a 20 MB upload also costs ~27 MB as base64 during the commit).

## Tests
`node test/run.js` → **69/69**. Runs the REAL worker entry point against `node:sqlite` and a mock
network; flow steps press the actual rendered buttons, so a button/handler mismatch fails the run.
Covers access control, the wiring flow, deploy, build success/failure reporting, undo (both
restore and delete-a-new-file), the superseded-upload guard, path traversal, and the 64-byte budget.

## Dead ends / traps hit
- The first test fixture returned repos in our internal shape instead of GitHub's
  (`owner.login`, `default_branch`), so `listRepos` mapped `undefined` and the insert failed on
  "cannot be bound to SQLite parameter 2". The mock must mirror the real API shape or it tests nothing.
- Test helpers `JSON.parse`d every logged call, including the **binary tarball PUT**. Scope button
  helpers to Telegram message calls only.
- Assertions that check message text will miss anything rendered in a **button label**, and are
  defeated by the `<b>` tags — hence `plain()` and `anyButton()`.
- Immediately after `wrangler deploy`, `/webhook` briefly 404s at some edges (propagation). Re-test
  before believing a routing bug.

## Open / next
- Bob supplies the 4 items above; then a real end-to-end run on one real file.
- Not built (not asked for): ZIP/folder pushes, multi-file batches, staging branches, approval gate.


---

# WEB PANEL (2026-08-12, Bob's redesign) — the primary interface now

Bob's clarification: he wanted a **standalone website** talking straight to GitHub + Heroku,
**nothing to do with Telegram**. Built. The Telegram bot still works and was left running.

## Live
- **Backend:** same Worker, `/api/*` routes — `deploy-bot.fleet-fefsba.workers.dev`
- **Front end:** ONE self-contained `index.html`, uploaded by Bob to **ail.com.de/deploy**
  (his CLIENT's cPanel — 🛑 **we have NO access and must never ask for any; he was emphatic**).
- **Package:** github.com/oliveroliver10816/deploy-bot-guide/releases/download/panel-v1/deploy-panel.zip
  (md5 `76507624fdb6713558342f1b896b5c74`, download re-verified)
- **Logins seeded in live D1:** `adm-lumen67` (master) · `va-cedar17` (va). Changeable in-panel.

## Design
Done by **Fable 5** at Bob's explicit request: 3 independent directions → judged → final build.
Winner **"conversation"** (guided step, 35/40) with the lever/hazard-stripe Deploy grafted from
"workbench". Judge found 10 defects in the winner; the final build fixed them.

## Decisions that matter
- ⭐ **Tokens never reach the browser.** They live in D1; the page is a shell. Verified by a test
  asserting `/api/state` never contains a stored token.
- ⭐ **Privacy fast path:** `GH.tarballUrl()` fetches only the *signed codeload URL* and hands THAT
  to Heroku, so repo contents go GitHub → Heroku and never transit the Worker. Falls back to the
  upload path automatically (signed link expires ~5 min; Heroku queues builds). Tested both ways.
- ⭐ **Rejected Heroku's GitHub integration on privacy grounds** — it takes a classic `repo`-scoped
  OAuth token with read/write on EVERY private repo, permanently. Wrong trade for this client.
- **Site ids are STRINGS** in `/api/state` and `/api/batch`. The UI reads them from DOM datasets
  (always strings) and compares with `===`; numbers silently broke every lookup between ticking a
  box and confirming. There is a test locking this.
- Backend is deliberately **forgiving** about shapes the designer drifted on (`accounts[].login`,
  `discover` returning `.repos`/`.apps`, `link` accepting `{site_id, app}`, password
  `current`/`next`, `conn_id` optional when only one account exists) — cheaper than editing the
  design in a dozen places.
- Auth: PBKDF2-SHA256 **100k** iters (Workers cap), per-user salt, constant-time compare, 12 h
  sessions as Bearer tokens in sessionStorage, login rate-limited 10/15 min per IP.
- CORS locked to `PANEL_ORIGIN` (`https://ail.com.de`), preflight cached 24 h for speed.
- `MAX_SITES_PER_BATCH = 10` — keeps one request under the Worker subrequest ceiling.

## Verified
- `node test/panel.js` → **72/72**; `node test/run.js` → **69/69** (bot still green).
- Browser (Playwright, desktop + phone): no console/page errors, no horizontal overflow, VA cannot
  see Settings, all four settings tabs render.
- **Live end-to-end from the real origin** — served the packaged ZIP over HTTPS with
  `--host-resolver-rules=MAP ail.com.de 127.0.0.1`, so `location.origin` was genuinely
  `https://ail.com.de`: login OK against live D1, wrong password → "Wrong username or password."
  ⚠️ `file://` gives origin `null` and IS blocked by CORS — that is correct behaviour, not a bug.

## Bugs found by actually running it (do not regress)
- ⭐ `startDeploy` called `renderMain()` BEFORE setting `S.poll`, so `renderStep3` saw no poller and
  showed the "lost contact / Check again" state for the entire deploy. Reordered.
- ⭐ The design hardcoded `API.deploy(..., 'replace')`, which would have failed every NEW file.
  Now `'auto'`.
- Null guards added: `openSettings` and `renderMain` bail when `S.data` is not loaded yet.

## Still open
- **No GitHub or Heroku token yet** — by design, Bob enters them in the panel. Until then no real
  commit/deploy has ever run. `seed.py github|heroku <tok>` can also load them server-side.
- The codeload-URL-vs-Heroku-queue timing is **unmeasured against a real build** (fallback covers it).
- Heroku app creation needs a **verified** account (card on file); no free tier.
- Creating repos needs the GitHub token scoped to **All repositories** + Administration: R/W.
