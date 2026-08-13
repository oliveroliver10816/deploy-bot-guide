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


## Round 2 (2026-08-12 evening) — speed, KB, quota

**Speed.** Bob said login felt slow. Measured: health 75 ms vs `/api/state` 230–445 ms. Cause was
**mine**: `ensurePanelSchema` ran 6 CREATE TABLE + a PRAGMA on EVERY request. Caching it per isolate
barely helped — traffic is low enough that nearly every request lands on a **cold isolate**, so any
in-memory cache is useless. Fix: **no DDL on the request path at all**; `schema.sql` (now including
the panel tables) is applied at deploy time and the cron re-asserts it. `/api/state` → **~130 ms**,
login → **~200 ms**. The rest of login is PBKDF2 100k, which is deliberate.
⚠️ D1 lives in **EEUR (FRA)**; every query crosses to Frankfurt. That is the remaining floor and
the main argument for moving the database if he ever wants it faster from India.

**Quota.** Measured, not guessed, via the CF GraphQL API: **27,764 of 100,000 req/day** on the
Osanix account; `ai-film-bridge` is 25,692 of that and `deploy-bot` only 683. No risk today, but the
limit is **per account**, so: cron cut from `* * * * *` to `*/5`, and `/api/batch` now refreshes
build status **on read, throttled to once per 4 s** — which also makes results appear in ~1 s
instead of up to 60 s. Tests lock both the refresh and the throttle.

**Knowledge base.** Lives INSIDE the panel behind the same login (Help button, both roles), with 8
screenshots embedded as **WebP data URIs** — so there is no second page to secure, no image URL
anyone can fetch unauthenticated, and zero extra backend requests. Page 60 KB → 234 KB.
Built by `panel/kb.py`, which is idempotent via `KB:*:START/END` markers.
⚠️ **The demo data used to name Bob's other brands** (jetterix, glpure, ozem-plus, neurovitol,
wego6, and a persona GitHub login). This file sits on a CLIENT's server — all 54 references were
replaced with neutral names. Re-check after any design regeneration.

### Bugs found and fixed this round
- ⭐ `kb.py`'s first idempotency regex matched a **CSS comment** and swallowed the whole `<script>`
  block (228 KB → 59 KB). Restored from git; removal is now marker-bounded. Never anchor a
  destructive regex on a comment that also appears in another context.
- ⭐ `show()` did `$('#'+id).hidden=...` for a fixed list; one missing element threw and killed
  `boot()`, leaving a blank page with no clue why. Now skips absent screens.
- ⭐ Adding the Help button pushed the header to **491 px on a 390 px phone**. Header now wraps and
  drops the role chip under 470 px. Caught by an automated overflow check, not by looking.
- The KB screenshot pass captured the **"Offline preview" note**; the login shot is now taken with
  it hidden and cropped to the card.
- ⚠️ `loading="lazy"` images below the fold report `naturalWidth===0` and look "broken" to a test.
  `test/browser/kbtest.py` now scrolls the page before asserting.

Browser suites kept in **`test/browser/`** (smoke, settings/VA roles, KB, overflow, screenshots).
Node suites: **76 panel + 69 bot**.


## v2 REDESIGN (2026-08-12 late) — v1 was REJECTED

Bob rejected v1 outright: *"THE DESIGN IS COMPLETELY SHITTY"*, *"WHY IS IT ONLY CENTER OF THE
SCREEN? … i have 34inch monitor … MAKE IT FULL WIDTH"*, *"the color scheme is so crap"*,
*"the menu bar has 4 'help' menus"*, *"make only 1 KB which has different chapters"*.
Only the typography survived. **He was right on every point.**

**My defects that caused it:**
- ⭐ `kb.py` injected the Help button into its OWN source file with `replace(...,1)` and no cleanup.
  Run four times → **four Help buttons with duplicate ids, shipped**. Fix: all transformation now
  happens in `panel/build.sh` on a **copy in dist/**; the source keeps `<!--KB_SCREENSHOT:name-->`
  placeholders and is never written to, and the build **exits non-zero on any duplicate id**.
  Memory [[never-inject-into-your-own-source-file]].
- ⭐ The v1 layout was a centred column. I never tested above 1280px. `test/browser/wide.py` now
  measures width AND height usage at 3440/1680/1280/390 and **fails under 90% width or 75% height**.
  Memory [[bob-ui-must-be-full-width-premium]].

**v2:** Fable 5, 3 directions → judged → final. Winner **"controlroom"** (33/40): left rail, full-bleed
grid, no `max-width` on any wrap, sites reflow to 5–8 columns at 3440. Dark premium palette, amber
accent, tokenised (`--sp-*`, `--fs-*`, `--el-*`), 21 inline SVG symbols, **no emoji**. ONE knowledge
base: numbered chapters + reading pane + on-this-page/screenshot rail, one entry point.
⚠️ The judge caught the "cockpit" direction repeating v1's exact crime (`max-width:1600px` with no
`margin-inline:auto` = a block hugging the left edge of a 3440 screen) — worth keeping that check.

**Integration bugs found only by running the built ZIP against the LIVE backend from the real
origin** (local HTTPS + `--host-resolver-rules=MAP ail.com.de 127.0.0.1`):
- ⭐ **The API says `role:"master"`, the UI checked for `"owner"`** → the owner was shown the VA
  view: no Settings, only 4 of 7 chapters, "VA" in the corner. Normalised in one place (`normRole`).
- ⭐ A 401 from `/api/login` hit the global session-expiry handler, so a **wrong password said
  "Your session ended"**. Now excluded, like v1 had it.
- Vertical dead space: full width but everything crammed in the top 270px of a 1440px screen. Added
  a tokenised vertical-fill block; panels now claim the viewport and scroll internally.

**Suites:** node 76 panel + 69 bot · `test/browser/` = `wide.py` (responsive), `v2.py` (structure,
KB, settings, deploy, VA role), `shots.py` (KB screenshots).
⚠️ Playwright notes: click the **label**, not a `.vh` checkbox; `wait_for_function`'s raf polling did
not advance the page's own timers — poll with `wait_for_timeout` loops; `loading="lazy"` images read
as broken until scrolled; a scratch file named `bisect.py` shadows the stdlib and breaks any script
that imports `random`/`http.server`.

## Database moved to the US (2026-08-12)
Bob asked for the database "on the Hetzner USA server". 🛑 **D1 is a Cloudflare product and cannot
run on his box — and that box is the client's, which we must never touch.** Did the equivalent:
new D1 **`deploy_bot_us`** (`7e5e842c-55a8-46c3-9c4b-9872be787f34`) in **ENAM**; schema applied, both
logins re-seeded, deployed. **Old `deploy_bot` (EEUR) left in place, untouched.**
⚠️ **Measured from this European box: ENAM 555 ms vs EEUR 130 ms.** D1 latency tracks where the
*person* is, not where the static site is hosted — the Hetzner box never touches the database. If he
and the VA work from India, **APAC** would beat both; it is a 5-minute rebuild.
⚠️ `seed.py` had the database name **hardcoded** and silently wrote the users to the OLD database
after the move. It now reads the name from `wrangler.json`.


## v3 (2026-08-13) — apps, pairs, log. Design ACCEPTED.

Bob on v2: *"THE PANEL NOW LOOKS REALLY AWESOME !! NO WORDS FOR THIS DESIGN AND STRUCTURE"* —
so v3 EXTENDS that design, never replaces it. Eight changes he listed:

⭐ **The model changed: deploy targets are his real HEROKU APPS, discovered automatically.**
There are no .com domains — he tests on `herokuapp.com`. Connecting the first GitHub key and the
first Heroku key now **pairs them and pulls everything by itself**: every Heroku app, every repo,
and an automatic name match between them (including Heroku's random `-1a2b3c4d5e6f` suffix).
`/api/state.sites` IS the app list. An app with no repo is shown with **no checkbox at all** (not a
disabled one), carries a "Choose a repository" button, and select-all skips it.

⭐ **Combos.** `combos` pairs ONE GitHub account with ONE Heroku account; many pairs coexist, so many
accounts of each kind are supported. Deploy resolves app → repo; two apps on the same repo in one
batch = the second is **skipped with a reason**, never committed twice.

⭐ **The VA runs the panel.** His words: *"VA MUST ALSO BE ABLE TO ADD KEYS… I just want VA to work
on it."* Keys, pairs, linking, refresh, deploy, undo and the log are all open to her. The **only**
owner-only surface is People — otherwise she could remove his own account. One `needMaster()` left
in `panel.js`; that is deliberate.

⭐ **Activity log** — `audit_log` records sign-ins, key connections, pairings, links, deploys, undos,
people changes. Stored ISO UTC, rendered **Asia/Kolkata** with a "Time (IST)" column.
Verified live: a 00:54 UTC row renders "13 Aug 2026, 6:24 am".

**Role naming settled:** the database still stores `master`; **every API response says `owner`**
(`outRole()`). The UI contains **zero** `'master'` literals. This is what caused "shows me as VA in
People" — the header had been normalised but the People list had not.

### Defects found by review/tests this round (all fixed)
- ⭐ `grid-template-columns:1fr` at the phone breakpoint overflowed a 390px screen by 14px:
  **bare `1fr` is `minmax(auto,1fr)` and `auto` will not shrink below min-content.** Use
  `minmax(0,1fr)`. Two more instances of the same pattern remain in non-overflowing contexts.
- The log trusted the API's ordering; it now sorts explicitly (day headings would repeat otherwise).
- The "Time (IST)" header was `aria-hidden` and `display:none` under 700px — invisible to a phone
  and to a screen reader. Now collapses instead of disappearing.
- Cards titled by `s.label`; hardened to `s.app||s.label` so a domain in `label` can never put a
  .com back on a card — the exact shape of the earlier rejection.
- KB did not document *Change your password*; added.

**Tests:** node **100 panel + 69 bot**. `test/browser/` = `wide.py` (100% width AND height at
3440/1680/1280/390), `v2.py`, `v3.py` (apps, unlinked-app rules, pairs, equal-height cards, roles,
IST log, VA boundary), `shots.py`.
⚠️ Two v3 test assertions were wrong, not the product: an unlinked app has **no checkbox** rather
than a disabled one, and the People tab is `hidden` rather than absent. Verify behaviour before
"fixing" code.

⚠️ Heroku app creation still needs a **verified** account; he is on the $5 Eco plan, which qualifies.


## Delivery rules (Bob, 2026-08-13)
- **Every build is numbered.** `panel/VERSION` holds the number; `build.sh` names the archive
  `deploy-panel-v<N>.zip`, stamps `<!-- deploy panel v<N> -->` as line 2 of index.html so an
  uploaded page can still be identified, and prints the next number to bump to.
  **v4 is built and staged; v1–v3 shipped under the unnumbered name.**
- **The download link goes at the END of every reply**, not only mid-message.


## v4 (2026-08-13) — file manager, editor, buildpack fix, speed

**Answered his Heroku failure.** `parusmetals` failed with *"No default language could be detected"*
because the repo held only `index.html`. Verified against the buildpack's OWN detect script
(`heroku-buildpack-php/bin/detect`): **PHP is detected on `composer.json` OR `index.php`** — nothing
else matches a folder of HTML. `POST /api/makedeployable` adds a one-line `index.php` that includes
the existing `index.html`, and refuses when a marker already exists.

⭐⭐ **REAL BUG FOUND, mine: deploys could build a STALE snapshot.** His app served an empty page —
`/home.html` 404'd on Heroku while the repo had it. Cause: we handed Heroku a **branch** archive URL
immediately after committing, and **GitHub caches branch archives**. Now pinned to the commit SHA
we just created (`/tarball/<sha>`), which cannot be stale. Test locks it.

**File manager** — `GET/POST /api/files/{appId}`, `GET /api/file`. Built on the **Git Data API**
(blobs → tree → commit → ref) so a folder upload is ONE commit and a folder delete is possible at
all; the Contents API can only touch one file per call. Deleting a folder expands to every blob
beneath it, server-side. 30 MB per batch. Path traversal refused.
UI: tree + editor with syntax highlighting (lazy — nothing runs before a file is opened), New file /
New folder / Upload files / Upload folder (`webkitdirectory`) / Rename / Delete / Save, images
preview instead of opening, >300 KB opens as plain text.

**Speed.** Page **316 KB → 123 KB**: the ~200 KB of KB screenshots now live in `kb-shots.js`, fetched
only when the guide is first opened. `/api/state` batched into **one** D1 round trip (`env.DB.batch`)
— 5 queries now cost what 1 did. Measured: health ~70 ms, one query ~180 ms, `/api/state` ~270 ms
from Europe. ⚠️ The floor is the hop to D1 in **ENAM**; if he and the VA work from India, **APAC**
would roughly halve it. Still unanswered — ask before moving.

**Also:** app URLs are click-to-copy; recent activity now names the destination app
(`recent[].targets` via `group_concat`) instead of showing only a batch id.

### Traps hit this round
- ⭐ `build.sh` injected the loader at the **first `</body>`** — which is inside the offline mock's
  sample HTML string, so it closed the real `<script>` and broke the whole page. Use the **last**.
  Same lesson as [[never-inject-into-your-own-source-file]]: never anchor on text that occurs twice.
- ⭐ A `white-space:nowrap` line in the activity list had a huge min-content and pushed the layout
  past the viewport at three widths. `min-width:0` alone does **not** stop an auto-sized grid track —
  let it wrap. Related: [[css-grid-1fr-wont-shrink]].
- v4's own MOCK_API called an undefined `copy()` helper, so offline preview could not sign in.
- Three v4 test failures were the TESTS, not the product: the rail nav opens Files with no app
  chosen (must click the app card's chip), the tree starts collapsed, and an unlinked app has no
  checkbox at all.

**Tests:** node **122 panel + 69 bot**; browser `wide.py`, `v2.py`, `v3.py`, `shots.py`.
**Shipped as `deploy-panel-v4.zip`** (release `panel-v4`); `panel/VERSION` bumped to 5.


## v5 (2026-08-13) — four defects the adversarial review caught in v4

v4 shipped before its review agent finished. The review then failed 4 checks, all real:

- 🛑 **DATA LOSS.** Unsaved editor text was silently discarded by Rename / Upload / New file /
  New folder / Make-it-deployable, because `renderFilePane` remounts from the last *fetched* copy
  and never read `#edTa.value` back — and `dirty` stayed true afterwards, so the panel warned about
  changes that no longer existed and Save would have written the stale copy. Fixed with
  `fvSyncEditor()`, called at the top of `renderFiles()` and before Rename commits.
- ⭐ **The Deploy-card buildpack warning never fired on a fresh sign-in** — `S.bp` was only filled by
  `fvLoadTree`, so an app whose Files view had never been opened showed nothing. That is exactly the
  path Bob took. Fixed properly at the source: `apps.buildpack` is cached in D1, filled during
  `refreshCombos`, on link, after any file write and after makedeployable, and **returned by
  `/api/state`**. Test asserts a linked app reports `buildpack:null` straight after connecting keys.
- **The app picker was reachable only once per session** (`S.fv` cleared only on sign-out). Added a
  **Change app** control.
- **Editor speed on his own 86 KB file:** 320 ms to open, 24,576 spans, 161 ms hitch per pause.
  Plain-text guard 300 KB → **120 KB**, debounce 120 ms → **250 ms**, plus a **Colour off** switch
  (his own words: *"IF EDITOR WILL MAKE THE PANEL SLOW, THEN WE DON'T NEED IT"*).

⚠️ **Lesson: do not publish before the review agent returns.** The build was correct, tested and
live-verified — and still had a data-loss bug that only an adversarial pass found. `test/browser/v5.py`
now reproduces each of the four.

**Tests:** node **126 panel + 69 bot**; browser `wide.py`, `v3.py`, `v4check`, `v5.py`.
**Shipped `deploy-panel-v5.zip`** (release `panel-v5`); `panel/VERSION` → 6.


## v6 (2026-08-13) — drag-drop, multi-file/folder deploys, copy, animation

His four asks, all shipped and **reviewed BEFORE publishing this time**.

- **Copy.** He reported it not working; it worked in a controlled browser, so rather than argue I made
  **both the app NAME and the URL** copyable, on the Deploy cards and in the Files header, with an
  always-visible icon (it had been hover-only, which is why he never saw it), a `copied` state on the
  control itself, an `execCommand` fallback, and — if both are refused — the text is **selected** with
  a message saying to press Ctrl+C. Verified: clicking never ticks the card or opens Files.
- **Drag and drop anywhere** on the Deploy view (proven by dropping on the left rail), plus onto the
  Files tree/pane which uploads into the folder being browsed. **Folders walk recursively** through
  `webkitGetAsEntry` including Chrome's ~100-entry `readEntries` batching. A missed drop is
  `preventDefault`ed so the browser never navigates away.
- ⭐ **Many files AND whole folders in ONE update** — the "bummer". `/api/deploy` now takes repeated
  `file` parts plus a `paths` array in the same order; the server writes them as **one commit and one
  build per app** via the Git Data API. Staged list is removable with per-file destination paths, a
  total, and a Clear. Caps 200 files / 30 MB, refused **all-or-nothing** so a set is never half-staged.
- **Animation by Fable:** press, waiting (`aria-busy` + spinner), status cross-fades, arrival of new
  rows, drop overlay. Collapsed under `prefers-reduced-motion`, **nothing on the sign-in first paint**,
  and **zero running animations once idle** (verified over 577 rAF frames).

The review PASSED with no blocking problems and four cosmetic notes, all then fixed: the staged list
did not animate in, the subtitle still said "the file" (singular), a same-path replacement happened
silently (now announced), and the Sending dot kept pulsing under reduced motion.

**Tests:** node **133 panel + 69 bot**; browser `wide.py`, `v3.py`, `v4.py`, `v5.py`, `v6.py`.
**Shipped `deploy-panel-v6.zip`** (release `panel-v6`); `panel/VERSION` → 7.
⚠️ First paint measured: FCP 64 ms, 0 sub-resources, 0 long tasks.
