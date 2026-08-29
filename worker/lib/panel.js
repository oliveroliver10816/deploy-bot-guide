/**
 * Web panel API — the browser front end for the same engine the Telegram bot uses.
 *
 * Everything sensitive stays here: the GitHub and Heroku tokens live in D1 and are
 * never sent to the browser. The page on the customer's own domain is pure markup;
 * downloading every file from it yields nothing usable.
 */

import * as GH from "./github.js";
import * as HK from "./heroku.js";
import { toBase64, fromBase64, nowIso, safeJoin } from "./util.js";

const PBKDF2_ITERS = 100000; // Cloudflare Workers refuse more than this
const SESSION_HOURS = 12;
const MAX_SITES_PER_BATCH = 10; // keeps one request under the subrequest ceiling
// The log page reads at most this many rows; `total` tells the UI there is more.
const LOG_LIMIT = 200;

// ------------------------------------------------------------------ helpers

const q = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);

export function corsHeaders(env, request) {
  const allowed = String(env.PANEL_ORIGIN || "https://ail.com.de")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get("Origin") || "";
  const ok = allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0],
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    // X-D1-Bookmark carries read-replica consistency; without it in BOTH lists the
    // browser silently drops the header and every read falls back to the primary.
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-D1-Bookmark",
    "Access-Control-Expose-Headers": "X-D1-Bookmark",
    // Cache the preflight for a day so actions do not pay a handshake each time.
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (env, request, obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env, request) },
  });

const err = (env, request, message, status = 400) => json(env, request, { error: message }, status);

/**
 * Turn a GitHub failure into something the person reading it can act on.
 *
 * A 403 "Resource not accessible by personal access token" cost a real upload:
 * it reached the panel as a bare 500, which told him to "try again in a moment"
 * — advice that can never work, because the token will refuse every retry.
 */
/**
 * Is this failure the SERVICE being broken, rather than anything about us?
 *
 * ⚠️ Learned the hard way on 2026-08-17: GitHub was down for hours, every write
 * came back `HTTP 503 No server is currently available to service your request`,
 * and — because there was no branch for it — the panel showed that verbatim.
 * GitHub was ALSO answering 404 intermittently, which hit the 404 branch and
 * told the VA "the repo was renamed or deleted, or the key you connected cannot
 * see it". She went and deleted the keys. Nothing was wrong with the keys.
 *
 * 502/503/504 and 5xx generally are theirs; a transport failure (no response at
 * all) is theirs or the network's. Neither is ever a reason to touch a key.
 */
function isOutage(raw) {
  return /HTTP 50[0234]/.test(raw) || /HTTP 5\d\d/.test(raw) ||
         /No server is currently available/i.test(raw) ||
         /\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/i.test(raw) ||
         /Network connection lost|fetch failed|socket hang up|timed out/i.test(raw);
}

/** The sentence for an outage. `who` is "GitHub" or "Heroku". */
function outageMessage(who, what, statusLine) {
  return `${who} is having problems right now, so ${what} could not be done. ` +
         `**This is not your key and nothing was lost** — ${who} refused the request itself. ` +
         (statusLine ? `${statusLine} ` : "") +
         `Wait a few minutes and try again. Do not delete or replace a key over this.`;
}

function ghMessage(e, repo) {
  const raw = String((e && e.message) || e);
  const where = typeof repo === "string" ? repo : repo ? `${repo.owner}/${repo.name}` : "that repo";
  if (isOutage(raw)) {
    return outageMessage("GitHub", `the change to ${where}`, null);
  }
  if (/Resource not accessible by personal access token/i.test(raw) || /HTTP 403/.test(raw)) {
    return `The GitHub key for ${where} is not allowed to write to it. Give that key ` +
           `"Contents: Read and write" for it — a fine-grained token must also list the repo ` +
           `itself under "Repository access". Then connect it again.`;
  }
  if (/HTTP 404/.test(raw)) {
    // ⚠️ This sentence used to lead with "the key cannot see it" and, during
    // GitHub's outage, that is what made someone delete working keys. A 404 is
    // ALSO what a struggling GitHub returns, so the harmless explanation goes
    // first and the key is the last suspect, never the first.
    return `GitHub answered "not found" for ${where}. If GitHub is having trouble right now ` +
           `(check status.github.com) this happens even when everything here is fine — try again in ` +
           `a few minutes first. If it keeps happening: the repo was renamed or deleted, or the key ` +
           `cannot see it — press "Refresh from Heroku" and check the pairing. Do not delete a key ` +
           `to fix a 404.`;
  }
  if (/HTTP 401/.test(raw)) {
    return `The GitHub key for ${where} has expired or been revoked. Connect a new one under ` +
           `Accounts & keys.`;
  }
  if (/HTTP 409/.test(raw)) {
    return `${where} changed while this was being written. Open Files again and re-apply the change.`;
  }
  if (/HTTP 422/.test(raw)) {
    return `GitHub refused the change to ${where}: ${raw.replace(/^.*HTTP 422\)?:?\s*/, "")}`;
  }
  return raw;
}

/**
 * The same job for Heroku. An expired API key is by far the most common cause
 * and reads as a bare 401 unless somebody says what a 401 means here.
 */
function hkMessage(e, account) {
  const raw = String((e && e.message) || e);
  const who = account ? `the Heroku key for ${account}` : "the Heroku key";
  if (isOutage(raw)) {
    return outageMessage("Heroku", "that request", null);
  }
  if (/HTTP 401/.test(raw)) {
    return `${who} has expired or been revoked. Heroku API keys created with ` +
           `"heroku authorizations:create" do expire. Make a new one and connect it under ` +
           `Accounts & keys.`;
  }
  if (/HTTP 403/.test(raw)) {
    return `${who} is not allowed to do that. Use a key made on the account that owns the app.`;
  }
  if (/HTTP 404/.test(raw)) {
    return `Heroku says that app no longer exists on this account. Press "Refresh from Heroku".`;
  }
  if (/HTTP 429/.test(raw)) {
    return `Heroku is rate limiting us. Wait a minute and try again — nothing was lost.`;
  }
  return raw;
}

/**
 * Deleting a repo is refused with 403 unless the token carries
 * `administration=write` — GitHub says so itself in its
 * `x-accepted-github-permissions` header on that endpoint. ghMessage()'s 403
 * branch names Contents, which is the right advice for every OTHER call and
 * exactly the wrong advice here, so the delete path gets its own translation.
 */
function ghDeleteMessage(e, full) {
  const raw = String((e && e.message) || e);
  if (/HTTP 403/.test(raw) || /Resource not accessible by personal access token/i.test(raw) || /Must have admin rights/i.test(raw)) {
    return `The GitHub key for ${full} is not allowed to delete repos. Deleting one needs ` +
           `"Administration: Read and write" on the token (GitHub's own answer names administration=write) — ` +
           `the Contents permission alone is not enough. Grant it on the token, then try again. ` +
           `Nothing was deleted.`;
  }
  if (/HTTP 404/.test(raw)) {
    return `GitHub cannot find ${full} — it may already be deleted or renamed, or the key cannot see it. ` +
           `Press "Refresh from Heroku" to re-read the list. Nothing was changed here.`;
  }
  return ghMessage(e, full);
}

/**
 * One name has to work as BOTH a GitHub repo and a Heroku app, so the
 * tighter of the two rules wins — Heroku's. GitHub also accepts dots and
 * underscores; a name that only works on one side produces exactly the
 * half-made site this feature exists to prevent, so it is refused up front,
 * before anything at all is created.
 */
function siteNameProblem(name) {
  if (!name) return "Give the site a name first.";
  if (name.length < 3) return "A site name needs at least 3 characters.";
  if (name.length > 30) return `Heroku app names stop at 30 characters — that one is ${name.length}.`;
  if (!/^[a-z]/.test(name)) return "A site name has to start with a letter.";
  if (!/[a-z0-9]$/.test(name)) return "A site name has to end with a letter or a number.";
  if (!/^[a-z0-9-]+$/.test(name)) {
    return "Use only lower-case letters, numbers and hyphens — no spaces, capitals, dots or underscores.";
  }
  return null;
}

/**
 * A name to offer when Heroku says one is taken. Only a SUGGESTION: Heroku
 * hands out names first-come across every account on earth, so the only way to
 * learn that a name is free is to try to create it. Never tell him it is free.
 */
function suggestSiteName(name) {
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(2)))
    .map((n) => n.toString(16).padStart(2, "0")).join("");
  const base = String(name).slice(0, 30 - suffix.length - 1).replace(/-+$/, "");
  return `${base}-${suffix}`;
}

/**
 * Creating a repo is refused with 403 unless the token carries
 * `administration=write` — the same permission the delete path needs, and the
 * same reason ghMessage's Contents advice would be wrong here.
 */
function ghCreateMessage(e, name, account) {
  const raw = String((e && e.message) || e);
  if (/already have a repo called/i.test(raw)) {
    return `${account || "That GitHub account"} already has a repo called ${name}. ` +
           `Pick another name. Nothing was created.`;
  }
  if (/Administration/i.test(raw) || /HTTP 403/.test(raw) ||
      /Resource not accessible by personal access token/i.test(raw)) {
    return `The GitHub key for ${account || "that account"} is not allowed to make new repos. ` +
           `Creating one needs "Administration: Read and write" on the token, set to All repositories. ` +
           `Grant it, then try again. Nothing was created.`;
  }
  return `${raw} Nothing was created.`;
}

/** The holding page a brand-new site serves until real files replace it. */
function holdingPage(name) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>
body{font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;
     min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e8ecf3}
main{max-width:32rem;padding:2rem;text-align:center}
h1{font-size:1.5rem;margin:0 0 .5rem}
p{margin:0;color:#9aa6b8}
</style>
</head>
<body>
<main>
  <h1>${name}</h1>
  <p>This site is set up and building. Send its files from the panel and they replace this page.</p>
</main>
</body>
</html>
`;
}

/**
 * Ask the vendor's own status page whether it is broken.
 *
 * Both are public and need no key (verified 2026-08-17):
 *   GitHub  https://www.githubstatus.com/api/v2/status.json  -> {status:{indicator,description}}
 *   Heroku  https://status.heroku.com/api/v4/current-status   -> {status:[{system,status}],incidents:[]}
 *
 * Best effort only, on a short timeout: this runs while something has ALREADY
 * failed, so it must never add a failure of its own or make the person wait.
 * A null answer means "we could not ask", which is said as such — never assumed
 * to mean "everything is fine".
 */
async function vendorStatus(kind, f = fetch) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 5000) : null;
  // Some status pages sit behind a CDN that answers a bare programmatic request
  // differently — send an ordinary Accept and a name, the way a browser would.
  const opts = { headers: { Accept: "application/json", "User-Agent": "gitku-panel/1.0" },
                 ...(ctl ? { signal: ctl.signal } : {}) };
  const who = kind === "github" ? "GitHub" : "Heroku";
  try {
    if (kind === "github") {
      const r = await f("https://www.githubstatus.com/api/v2/status.json", opts);
      if (!r.ok) return { who, unknown: true, why: `status page answered HTTP ${r.status}` };
      const b = await r.json();
      const ind = b && b.status && b.status.indicator;   // none | minor | major | critical
      const desc = (b && b.status && b.status.description) || "";
      if (!ind) return { who, unknown: true, why: "status page answered in an unexpected shape" };
      return { who: "GitHub", ok: ind === "none", indicator: ind, description: desc,
               page: "https://www.githubstatus.com" };
    }
    const r = await f("https://status.heroku.com/api/v4/current-status", opts);
    if (!r.ok) return { who, unknown: true, why: `status page answered HTTP ${r.status}` };
    const b = await r.json();
    const rows = (b && b.status) || [];
    if (!rows.length) return { who, unknown: true, why: "status page listed no systems" };
    const bad = rows.filter((x) => x && x.status && x.status !== "green");
    return { who: "Heroku", ok: bad.length === 0, indicator: bad.length ? "major" : "none",
             description: bad.length ? bad.map((x) => `${x.system}: ${x.status}`).join(", ")
                                     : "All systems green",
             page: "https://status.heroku.com" };
  } catch (e) {
    // Could not ask. The reason is carried, because "we could not check" and
    // "everything is fine" must never look the same.
    return { who, unknown: true, why: String((e && (e.name || e.message)) || e).slice(0, 80) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The last line of defence for a vendor failure nobody translated.
 *
 * ⚠️ 2026-08-17: the Worker's outer catch returned `String(e.message)` raw with a
 * 500, which is how "Could not store ap-kit.js (HTTP 503): No server is
 * currently available to service your request" ended up on his VA's screen for
 * hours — and why she went looking for something to fix, and found the keys.
 * Every route that talks to GitHub or Heroku now passes through here, whether it
 * remembered to catch or not.
 *
 * The vendor is guessed from the wording, because that is all an escaped error
 * carries. When it cannot be told, both are named rather than the wrong one.
 */
export async function explainVendorError(e, f = fetch) {
  const raw = String((e && e.message) || e);
  if (!isOutage(raw)) return { message: raw, outage: false, status: 500 };
  const looksGitHub = /repo|branch|commit|blob|tree|store |GitHub|codeload/i.test(raw);
  const looksHeroku = /Heroku|app |build|source|dyno|slug/i.test(raw);
  const kind = looksGitHub && !looksHeroku ? "github" : (looksHeroku && !looksGitHub ? "heroku" : null);
  const who = kind === "github" ? "GitHub" : kind === "heroku" ? "Heroku" : "GitHub or Heroku";
  const st = kind ? await vendorStatus(kind, f) : null;
  return {
    message: outageMessage(who, "that request", kind ? statusLine(st, who) : null),
    outage: true, who, status: 503,
  };
}

/** One line quoting the status page, for the end of an outage sentence. */
function statusLine(st, who) {
  if (!st || st.unknown) {
    return `(${who}'s status page could not be reached from here either` +
           `${st && st.why ? ` — ${st.why}` : ""}, which usually means the same thing.)`;
  }
  if (st.ok) {
    return `(${who}'s status page says "${st.description}", so this may be a brief blip or a problem ` +
           `only on this account — try again before changing anything.)`;
  }
  return `(${who}'s own status page confirms it: "${st.description}" — ${st.page}.)`;
}

async function pbkdf2(password, saltBytes) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITERS, hash: "SHA-256" }, key, 256
  );
  return toBase64(new Uint8Array(bits));
}

/** Length-independent, value-constant comparison. */
function sameSecret(a, b) {
  const A = new TextEncoder().encode(String(a));
  const B = new TextEncoder().encode(String(b));
  let diff = A.length ^ B.length;
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) diff |= (A[i] ?? 0) ^ (B[i] ?? 0);
  return diff === 0;
}

/**
 * Everything worth explaining later. Stored ISO UTC; the panel renders IST.
 *
 * `kind` separates the two questions the client asked: 'person' is somebody
 * pressing something, 'panel' is work this backend did on its own (a build
 * started, the cron moved a batch on, a refresh auto-linked an app). `error`
 * carries WHY a row failed, in the same words we would show on screen — a row
 * with ok=0 and an empty error is a bug, not a record.
 */
async function logAction(env, actor, action, target, detail, ok = 1, extra = {}) {
  const kind = extra.kind === "panel" ? "panel" : "person";
  const error = extra.error ? String(extra.error).slice(0, 600) : null;
  try {
    await retryAfterMigration(env, () =>
      q(env, `INSERT INTO audit_log (at, actor, action, target, detail, ok, kind, error, ref)
              VALUES (?,?,?,?,?,?,?,?,?)`,
        nowIso(), actor || "system", action, target || null,
        detail ? String(detail).slice(0, 400) : null,
        ok ? 1 : 0, kind, error, extra.ref ? String(extra.ref).slice(0, 200) : null).run());
  } catch { /* logging must never break the action it is recording */ }
}

/** The panel's own work: nobody pressed anything, so the actor is the panel. */
const logPanel = (env, action, target, detail, extra = {}) =>
  logAction(env, extra.actor || "panel", action, target, detail,
    extra.ok === undefined ? 1 : extra.ok, { ...extra, kind: "panel" });

/** A human action that failed. `error` is the sentence we also show on screen. */
const logFail = (env, actor, action, target, error, extra = {}) =>
  logAction(env, actor, action, target, extra.detail || null, 0, { ...extra, error });

/** The database stores 'master'; every API response says 'owner'. One name outside. */
const outRole = (r) => (r === "master" || r === "owner" ? "owner" : "va");

const randomToken = () =>
  toBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, "").slice(0, 40);

export async function createUser(env, username, password, role) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt);
  await q(env,
    `INSERT INTO panel_users (username, pass_hash, salt, role, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT (username) DO UPDATE SET pass_hash=excluded.pass_hash, salt=excluded.salt, role=excluded.role`,
    username, hash, toBase64(salt), role, nowIso()
  ).run();
}

async function auth(env, request) {
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return null;
  const s = await q(env, `SELECT * FROM sessions WHERE token=?`, token).first();
  if (!s) return null;
  if (Date.parse(s.expires) < Date.now()) {
    await q(env, `DELETE FROM sessions WHERE token=?`, token).run();
    return null;
  }
  return s;
}

// ------------------------------------------------------------------ schema

// Once per isolate, not once per request. This was costing ~7 D1 round trips
// on EVERY api call — the whole reason login felt slow.
const panelSchemaReady = new WeakSet();

/**
 * Every column this build needs that an older database will not have.
 *
 * The live database HAS ROWS. So: each entry is added only after PRAGMA
 * table_info says it is absent, no column is ever dropped or retyped, and
 * nothing here rewrites a value that is already set. Running the whole list
 * twice is a no-op the second time — that is the property the tests lock.
 *
 * SQLite cannot ADD COLUMN ... NOT NULL without a constant default, so the
 * backfills below are separate UPDATEs guarded by `IS NULL`.
 */
const MIGRATIONS = [
  // The activity log has to explain the panel's own work and every failure.
  { table: "audit_log", column: "kind", ddl: `ALTER TABLE audit_log ADD COLUMN kind TEXT`,
    backfill: `UPDATE audit_log SET kind='person' WHERE kind IS NULL` },
  { table: "audit_log", column: "error", ddl: `ALTER TABLE audit_log ADD COLUMN error TEXT` },
  { table: "audit_log", column: "ref", ddl: `ALTER TABLE audit_log ADD COLUMN ref TEXT` },
  // Newest-first ordering needs something to sort by that is not the label.
  // Rows that predate the column get the time the migration ran: that is not
  // when they were really created, and it is the only honest thing available —
  // they keep their id order underneath, which IS their true creation order.
  { table: "apps", column: "created_at", ddl: `ALTER TABLE apps ADD COLUMN created_at TEXT` },
  { table: "repos", column: "created_at", ddl: `ALTER TABLE repos ADD COLUMN created_at TEXT` },
  // A build that Heroku stops answering about needs a clock of its own.
  { table: "batch_targets", column: "started_at", ddl: `ALTER TABLE batch_targets ADD COLUMN started_at TEXT` },
  // Which commit the stored buildpack was worked out from. If the branch has not
  // moved since, the whole file listing can be skipped — that is what makes a
  // refresh fast, because nothing usually changed between two of them.
  { table: "apps", column: "buildpack_sha", ddl: `ALTER TABLE apps ADD COLUMN buildpack_sha TEXT` },
  // v18: a note on each key — "which client is on this one", in his own words.
  { table: "connections", column: "note", ddl: `ALTER TABLE connections ADD COLUMN note TEXT` },
  // v18: a site can be marked as not in use, so a deploy does not go to it by
  // accident. 0 = in use; it is a MARK, never a lock — the row still deploys if
  // it is ticked deliberately.
  { table: "apps", column: "paused", ddl: `ALTER TABLE apps ADD COLUMN paused INTEGER DEFAULT 0`,
    backfill: `UPDATE apps SET paused=0 WHERE paused IS NULL` },
  // v20: a note ON THE APP — what this site is, who it is for, what is going on
  // with it — written on the Apps screen and shown under the app's name on the
  // Deploy screen, in the colour he picked, because that is where it is needed.
  { table: "apps", column: "note", ddl: `ALTER TABLE apps ADD COLUMN note TEXT` },
  { table: "apps", column: "note_color", ddl: `ALTER TABLE apps ADD COLUMN note_color TEXT` },
  // v24: when Heroku last released this app. NULL = it has never been released,
  // which is why a linked-but-never-deployed app serves Heroku's welcome page.
  { table: "apps", column: "released_at", ddl: `ALTER TABLE apps ADD COLUMN released_at TEXT` },
  // v25: the commit this app was last built from. The panel compares it with the
  // repo's HEAD and builds the app itself when they differ — which is what makes
  // "I changed the repo" reach every app on it without anyone pressing anything.
  { table: "apps", column: "built_sha", ddl: `ALTER TABLE apps ADD COLUMN built_sha TEXT` },
  // v29: the vendors' OWN dates, so "Created on" and "Last updated" mean what a
  // person expects rather than "when Gitku first noticed this".
  // 🛑 NEVER rename these to created_at. runMigrations (below) back-fills any new
  // column literally called `created_at` with the time the migration ran — which
  // would then be printed on screen as a creation date. One rename = one lie.
  { table: "apps",  column: "heroku_created_at", ddl: `ALTER TABLE apps ADD COLUMN heroku_created_at TEXT` },
  { table: "repos", column: "gh_created_at",     ddl: `ALTER TABLE repos ADD COLUMN gh_created_at TEXT` },
  { table: "repos", column: "pushed_at",         ddl: `ALTER TABLE repos ADD COLUMN pushed_at TEXT` },
];

/**
 * The colours a note may take. NAMES, not hex: the panel maps each one to a
 * value per theme, so a note stays readable in dark and light. Anything else
 * becomes "default", which is the ordinary text colour.
 */
const NOTE_COLORS = ["default", "red", "amber", "green", "blue", "violet"];
const noteColor = (v) => (NOTE_COLORS.includes(String(v || "")) ? String(v) : "default");

const EXTRA_INDEXES = [
  `CREATE INDEX IF NOT EXISTS audit_kind ON audit_log (kind, id DESC)`,
  `CREATE INDEX IF NOT EXISTS audit_bad  ON audit_log (ok, id DESC)`,
];

async function columnsOf(env, table) {
  try {
    const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    const names = (info.results || []).map((c) => c.name);
    // PRAGMA table_info on a table that does not exist returns an EMPTY result,
    // not an error — and a table with no columns cannot exist. Treating empty
    // as "not there" stops us running ALTER against a missing table, which is
    // the one way this could throw on a database that simply has not been
    // created yet. ensurePanelSchema creates it; we skip and let it.
    return names.length ? new Set(names) : null;
  } catch { return null; }
}

/**
 * Add anything missing. Safe to run on a live database, and safe to run again.
 * Returns the list of changes actually applied — empty on every later run.
 */
export async function runMigrations(env) {
  const applied = [];
  const cache = new Map();
  for (const m of MIGRATIONS) {
    if (!cache.has(m.table)) cache.set(m.table, await columnsOf(env, m.table));
    const have = cache.get(m.table);
    if (!have || have.has(m.column)) continue;
    await env.DB.prepare(m.ddl).run();
    have.add(m.column);
    applied.push(`${m.table}.${m.column}`);
  }
  // Backfills run every time but only touch NULLs, so they cost nothing once
  // done and they repair a row inserted between the ALTER and the UPDATE.
  const now = nowIso();
  for (const m of MIGRATIONS) {
    const have = cache.get(m.table);
    if (!have || !have.has(m.column)) continue;
    if (m.backfill) { try { await env.DB.prepare(m.backfill).run(); } catch { /* ignore */ } }
    if (m.column === "created_at") {
      try {
        await q(env, `UPDATE ${m.table} SET created_at=? WHERE created_at IS NULL OR created_at=''`, now).run();
      } catch { /* ignore */ }
    }
  }
  for (const sql of EXTRA_INDEXES) { try { await env.DB.prepare(sql).run(); } catch { /* ignore */ } }
  return applied;
}

// Re-entrancy guard: applyMigrations logs, logging can trigger a migration.
const migrating = new WeakSet();

/** Migrate and, if anything actually changed, say so in the log as panel work. */
export async function applyMigrations(env) {
  if (migrating.has(env.DB)) return [];
  migrating.add(env.DB);
  try {
    const applied = await runMigrations(env);
    if (applied.length) {
      await logPanel(env, "brought the database up to date", null,
        `added ${applied.join(", ")}`, { ref: "schema" });
    }
    return applied;
  } finally { migrating.delete(env.DB); }
}

/**
 * Run a query; if it fails only because this database has not been migrated
 * yet, migrate and run it once more.
 *
 * The request path deliberately does NO schema work — traffic is low enough
 * that almost every request lands on a cold isolate, so a per-request PRAGMA
 * costs a full hop to Frankfurt for nothing. This costs nothing in the steady
 * state and still means the first request after a deploy repairs itself
 * instead of 500ing until the cron next fires.
 */
async function retryAfterMigration(env, fn) {
  try { return await fn(); }
  catch (e) {
    const why = String((e && e.message) || e);
    if (!/no such column|no such table/i.test(why)) throw e;
    // 🛑 A MISSING TABLE IS NOT A MISSING COLUMN. runMigrations only ever runs
    // ALTER TABLE ... ADD COLUMN; a brand-new table is created by
    // ensurePanelSchema, which the request path deliberately never calls (that
    // was the round-2 speed fix). So the first deploy that added a new table
    // 500'd every /api/state until the cron happened to fire — measured on the
    // live panel when `tags` shipped. Create the tables here, on the error path
    // only, so the request that needs them is the request that gets them.
    if (/no such table/i.test(why)) {
      try { await ensurePanelSchema(env, true); } catch { /* fall through */ }
    }
    await runMigrations(env);
    return fn();
  }
}

// v31 — turn every note that already exists into a tag, once.
//
// His 21 notes were only 7 distinct strings: `17/8 - 6 . về 🟢` was typed on five
// apps by hand, `🗡️BOCA - 1 🟡🗡️` on four. Deduplicated by (label, colour) so the
// same words never become two tags.
//
// 🛑 The notes themselves are NOT deleted. `apps.note` keeps its value; this only
// adds. If the tags ever had to be undone, every original is still in place.
async function migrateNotesToTags(env) {
  const done = await q(env, `SELECT COUNT(*) AS n FROM tags`).first();
  if (Number(done?.n || 0) > 0) return 0;          // already carried across
  const rows = (await q(env,
    `SELECT id, note, note_color FROM apps WHERE note IS NOT NULL AND note <> ''`).all()).results || [];
  if (!rows.length) return 0;
  const at = nowIso();
  const seen = new Map();                          // "label\u0000color" -> tag id
  let made = 0;
  for (const r of rows) {
    const label = String(r.note).trim();
    const color = noteColor(r.note_color);
    if (!label) continue;
    const key = `${label}\u0000${color}`;
    let id = seen.get(key);
    if (id === undefined) {
      await q(env, `INSERT OR IGNORE INTO tags (label, color, created_at) VALUES (?,?,?)`,
        label, color, at).run();
      const got = await q(env, `SELECT id FROM tags WHERE label=? AND color IS ?`, label, color).first();
      id = got ? got.id : null;
      seen.set(key, id);
      if (id) made++;
    }
    if (id) await q(env, `INSERT OR IGNORE INTO app_tags (app_id, tag_id) VALUES (?,?)`, r.id, id).run();
  }
  await logPanel(env, "turned notes into tags", `${made} tag(s)`,
    `from ${rows.length} note(s) — the notes themselves were left exactly as they were`);
  return made;
}

export async function ensurePanelSchema(env, force) {
  // `force` exists so a test can make the one-time passes run again on the same
  // database; nothing in the product ever passes it.
  if (!force && panelSchemaReady.has(env.DB)) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS panel_users (username TEXT PRIMARY KEY, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, expires TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, n INTEGER NOT NULL, first_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, who TEXT NOT NULL, file_name TEXT NOT NULL, mode TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS batch_targets (batch_id TEXT NOT NULL, repo_id INTEGER NOT NULL, app_id INTEGER, path TEXT, status TEXT, detail TEXT, commit_sha TEXT, prev_blob_sha TEXT, new_blob_sha TEXT, build_id TEXT, build_url TEXT, finished_at TEXT, PRIMARY KEY (batch_id, repo_id))`,
    `CREATE INDEX IF NOT EXISTS bt_pending ON batch_targets (status)`,
    `CREATE TABLE IF NOT EXISTS combos (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT, github_conn_id INTEGER NOT NULL, heroku_conn_id INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE (github_conn_id, heroku_conn_id))`,
    `CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, ok INTEGER DEFAULT 1, kind TEXT DEFAULT 'person', error TEXT, ref TEXT)`,
    `CREATE INDEX IF NOT EXISTS audit_recent ON audit_log (id DESC)`,
    // v29: when each file last changed, recorded by the panel itself
    `CREATE TABLE IF NOT EXISTS file_times (repo_id INTEGER NOT NULL, path TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (repo_id, path))`,
    // v31: tags — one label, written once, clicked onto any app
    `CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, color TEXT, created_at TEXT NOT NULL, UNIQUE (label, color))`,
    `CREATE TABLE IF NOT EXISTS app_tags (app_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (app_id, tag_id))`,
    `CREATE INDEX IF NOT EXISTS app_tags_tag ON app_tags (tag_id)`,
  ];
  for (const s of stmts) await env.DB.prepare(s).run();

  // repos predates the panel; add the display fields it needs.
  const info = await env.DB.prepare(`PRAGMA table_info(repos)`).all();
  const have = new Set((info.results || []).map((c) => c.name));
  if (!have.has("url")) await env.DB.prepare(`ALTER TABLE repos ADD COLUMN url TEXT`).run();
  if (!have.has("dir")) await env.DB.prepare(`ALTER TABLE repos ADD COLUMN dir TEXT DEFAULT ''`).run();
  const ainfo = await env.DB.prepare(`PRAGMA table_info(apps)`).all();
  const acols = new Set((ainfo.results || []).map((c) => c.name));
  if (!acols.has("combo_id")) await env.DB.prepare(`ALTER TABLE apps ADD COLUMN combo_id INTEGER`).run();
  if (!acols.has("buildpack")) await env.DB.prepare(`ALTER TABLE apps ADD COLUMN buildpack TEXT`).run();
  const tinfo = await env.DB.prepare(`PRAGMA table_info(batch_targets)`).all();
  if (!(tinfo.results || []).some((c) => c.name === "files_json")) {
    await env.DB.prepare(`ALTER TABLE batch_targets ADD COLUMN files_json TEXT`).run();
  }
  const binfo = await env.DB.prepare(`PRAGMA table_info(batches)`).all();
  if (!(binfo.results || []).some((c) => c.name === "last_poll")) {
    await env.DB.prepare(`ALTER TABLE batches ADD COLUMN last_poll TEXT`).run();
  }
  // Everything newer lives in one guarded, re-runnable list.
  //
  // Wrapped because this runs on the CRON. A migration that cannot apply is
  // serious, but it must not take the whole tick down with it — pollPanelBuilds
  // runs straight after, and stopping that would leave every in-flight deploy
  // stuck on "building" with nobody to move it on. The failure is recorded
  // instead, where somebody can read it.
  try {
    await applyMigrations(env);
  } catch (e) {
    await logPanel(env, "could not bring the database up to date", null, null,
      { ok: 0, ref: "schema", error: String((e && e.message) || e) });
  }
  // one-time, guarded by "are there any tags yet" — never re-runs
  // ⚠ It must not break boot — but a silent catch means a migration that never
  //   runs looks exactly like a migration that ran and found nothing. Say so.
  try { await migrateNotesToTags(env); }
  catch (e) {
    try {
      await logPanel(env, "could not turn notes into tags", null,
        "the notes are untouched; this can be run again", 
        { ok: 0, error: String((e && e.message) || e).slice(0, 300) });
    } catch { /* logging must not break boot either */ }
  }
  panelSchemaReady.add(env.DB);
}

// ------------------------------------------------------------- deploy engine

/** When only one account of a kind is connected, the UI need not name it. */
async function soleConn(env, kind, given) {
  if (given) {
    const c = await q(env, `SELECT * FROM connections WHERE id=?`, Number(given)).first();
    if (c) return c;
  }
  const rows = (await q(env, `SELECT * FROM connections WHERE kind=? ORDER BY id`, kind).all()).results || [];
  return rows.length === 1 ? rows[0] : null;
}

async function siteRow(env, id) {
  return q(env,
    `SELECT r.*, c.token AS gh_token FROM repos r JOIN connections c ON c.id=r.connection_id WHERE r.id=?`, id
  ).first();
}

async function appRow(env, repoId) {
  return q(env,
    `SELECT a.*, c.token AS hk_token FROM apps a JOIN connections c ON c.id=a.connection_id WHERE a.repo_id=?`, repoId
  ).first();
}

/**
 * One app in exactly the shape `/api/state.sites[]` uses, so link and unlink
 * can hand back the row that changed and the page can replace it without
 * re-reading the whole screen.
 */
async function appState(env, appId) {
  const a = await retryAfterMigration(env, () => q(env,
    `SELECT a.id, a.label, a.heroku_name, a.web_url, a.repo_id, a.combo_id, a.buildpack,
            a.created_at AS created_at, COALESCE(a.paused,0) AS paused, a.note, a.note_color,
            a.released_at, a.heroku_created_at,
            r.owner AS owner, r.name AS repo, r.branch AS branch, COALESCE(r.dir,'') AS dir,
            r.created_at AS repo_created_at, r.gh_created_at AS repo_gh_created_at,
            r.pushed_at AS repo_pushed_at, hc.account AS heroku_account
     FROM apps a
     LEFT JOIN repos r ON r.id = a.repo_id
     LEFT JOIN connections hc ON hc.id = a.connection_id
     WHERE a.id=?`, appId).first());
  if (!a) return null;
  return {
    id: String(a.id),
    label: a.heroku_name,
    url: a.web_url || "",
    app: a.heroku_name,
    app_url: a.web_url || "",
    owner: a.owner || "",
    repo: a.repo || "",
    branch: a.branch || "main",
    dir: a.dir || "",
    linked: !!a.repo_id,
    buildpack: a.buildpack ? a.buildpack : null,
    buildpack_checked: a.repo_id ? a.buildpack !== null && a.buildpack !== undefined : false,
    account: a.heroku_account || "",
    paused: a.paused ? 1 : 0,
    note: a.note || "",
    note_color: noteColor(a.note_color),
    released: !!a.released_at,
    created_at: a.created_at || null,
    repo_created_at: a.repo_created_at || null,
    // v29 — the VENDORS' dates, so "Created on"/"Last updated" mean what a person
    // expects. `created_at` above stays: it is when Gitku first saw the app, and
    // it is still the ordering fallback and the "new" mark.
    heroku_created_at: a.heroku_created_at || null,
    released_at: a.released_at || null,
    repo_gh_created_at: a.repo_gh_created_at || null,
    repo_pushed_at: a.repo_pushed_at || null,
    // v31: this row is swapped straight into the page after a tag change, so it
    // has to carry the tags or the chip would vanish until the next full read
    tags: ((await q(env, `SELECT tag_id FROM app_tags WHERE app_id=?`, a.id).all()).results || [])
      .map((r) => Number(r.tag_id)),
  };
}

/**
 * Deploy one site. Commit first, then start the Heroku build.
 *
 * Build source order matters for privacy: try the signed codeload URL so the
 * repo contents go GitHub -> Heroku directly, and only fall back to pulling the
 * archive through this Worker if that fails (the signed link is short-lived).
 */
async function deployOne(env, batchId, site, files, mode, who, appId) {
  const setT = (fields, ...vals) =>
    q(env, `UPDATE batch_targets SET ${fields} WHERE batch_id=? AND repo_id=?`, ...vals, batchId, site.id).run();

  try {
    // Every selected file and folder lands in ONE commit per app. Sending them
    // one at a time would make a folder of 20 files 20 commits and 20 builds.
    const base = String(site.dir || "").replace(/^\/+|\/+$/g, "");
    const prepared = [];
    for (const f of files) {
      const rel = String(f.rel || f.name).replace(/^\/+/, "");
      if (rel.split("/").some((seg) => seg === ".." || seg === "")) {
        throw new Error(`Invalid path in the upload: ${rel}`);
      }
      const path = base ? `${base}/${rel}` : rel;
      if (path.length > 400) throw new Error(`That path is too long: ${path}`);
      prepared.push({ path, contentB64: toBase64(f.bytes) });
    }

    // mode still applies, judged on the first file so the messages stay plain
    const first = prepared[0];
    const prev = await GH.getFileSha(site.gh_token, site.owner, site.name, site.branch, first.path, fetch);
    if (mode === "new" && prev) throw new Error(`${first.path} already exists here.`);
    if (mode === "replace" && !prev) throw new Error(`${first.path} does not exist yet, so there is nothing to replace.`);

    const label = prepared.length === 1
      ? `${prev ? "Update" : "Add"} ${first.path}`
      : `Update ${prepared.length} files`;

    const res = await GH.commitChanges(site.gh_token, {
      owner: site.owner, repo: site.name, branch: site.branch,
      message: `${label} (panel, ${who})`, files: prepared,
    }, fetch);

    // Record EVERY path, not a human label: undo used to treat the label
    // "2 files" as a real path and commit a file with that name.
    const paths = prepared.map((f) => f.path);
    await setT("path=?, files_json=?, commit_sha=?, prev_blob_sha=?, status='building'",
      prepared.length === 1 ? first.path : `${prepared.length} files`,
      JSON.stringify(paths.map((pp, i) => ({ path: pp, prev: i === 0 ? prev : undefined }))),
      res.commitSha, prev);
    // v29: same stamp the File Manager writes, so a Deploy upload and a
    // File Manager save answer "when did this change?" identically.
    await stampFileTimes(env, site.id, paths);

    const app = appId
      ? await q(env, `SELECT a.*, c.token AS hk_token FROM apps a
                      JOIN connections c ON c.id=a.connection_id WHERE a.id=?`, appId).first()
      : await appRow(env, site.id);
    if (!app) {
      await setT("status='no_app', detail=?, finished_at=?", "Committed. No Heroku app linked.", nowIso());
      await logPanel(env, "committed with nowhere to deploy", `${site.owner}/${site.name}`,
        `${paths.length} file(s); no Heroku app is linked to this repo`,
        { actor: who, ref: batchId });
      return;
    }
    const build = await startBuild(env, site, app, res.commitSha);
    await setT("build_id=?, build_url=?, started_at=?, status=?", build.id, app.web_url || null,
      nowIso(), build.status === "failed" ? "failed" : "building");
    await logPanel(env, "started a build", app.heroku_name,
      `commit ${String(res.commitSha).slice(0, 7)} · build ${build.id}`,
      { actor: who, ref: batchId, ok: build.status === "failed" ? 0 : 1,
        error: build.status === "failed" ? "Heroku reported the build as failed the moment it was created." : null });
  } catch (e) {
    // Say what to DO about it. The raw text was
    // "Could not store s.js (HTTP 403): Resource not accessible by personal
    // access token", which names no repo and no remedy.
    const why = ghMessage(e, site).slice(0, 400);
    await setT("status='failed', detail=?, finished_at=?", why, nowIso());
    await logPanel(env, "could not deploy", `${site.owner}/${site.name}`, null,
      { actor: who, ref: batchId, ok: 0, error: why });
  }
}

// v29 — WHEN A FILE LAST CHANGED, from OUR OWN records.
//
// His point, and he is right: "we also have data when we uploaded using GITKU,
// why don't you use that? because we're doing 99% of our tasks from GITKU".
// Every panel upload writes a `batch_targets` row carrying `files_json` (every
// path that write touched) and a finish time. So a per-file date costs ZERO
// calls to GitHub.
//
// ⚠️ GitHub itself cannot supply this cheaply: a git tree carries no dates at
// all, and `GET /commits?path=` is one request PER FILE (two, if you want the
// first commit) against a hard 50-subrequest ceiling per Worker invocation.
// That is why this reads our own table instead — and why a file we have never
// written stays BLANK rather than borrowing the repo's date.
// Every write the panel makes stamps the paths it touched. Called from the
// File Manager save/upload/rename path AND from a Deploy batch, so both routes
// answer the same question the same way.
// ⚠ NEVER cut a string in the middle of a surrogate pair. The note picker fills
// these with non-BMP emoji (a game item is TWO UTF-16 units), and a plain
// slice() through one stores a lone surrogate that renders for ever after as a
// replacement character. Back off one unit when the cut lands mid-pair.
function cutText(v, max) {
  const t = String(v == null ? "" : v);
  if (t.length <= max) return t;
  const c = t.charCodeAt(max - 1);
  return t.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
}

async function stampFileTimes(env, repoId, paths) {
  const list = [...new Set((paths || []).filter((p) => typeof p === "string" && p))];
  if (!repoId || !list.length) return 0;
  const at = nowIso();
  try {
    // Chunked: D1 batches are cheap but not free, and an upload can be 200 files.
    for (let i = 0; i < list.length; i += 50) {
      await env.DB.batch(list.slice(i, i + 50).map((p) => env.DB.prepare(
        `INSERT INTO file_times (repo_id, path, at) VALUES (?,?,?)
         ON CONFLICT (repo_id, path) DO UPDATE SET at=excluded.at`).bind(repoId, p, at)));
    }
  } catch { return 0; }        // a display date must never fail a real write
  return list.length;
}

async function fileTimesForRepo(env, repoId) {
  const rows = (await q(env,
    `SELECT files_json, COALESCE(finished_at, started_at) AS at
       FROM batch_targets
      WHERE repo_id=? AND files_json IS NOT NULL AND COALESCE(finished_at, started_at) IS NOT NULL
      ORDER BY COALESCE(finished_at, started_at) ASC`, repoId).all()).results || [];
  // ⚠ Object.create(null): a repo may legitimately contain a file called
  // `constructor` or `__proto__`, and a bare {} answers those from the prototype
  // — the stamp comparison below would then compare a date to a function.
  const out = Object.create(null);
  for (const r of rows) {
    let list;
    try { list = JSON.parse(r.files_json); } catch { continue; }
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      const p = typeof f === "string" ? f : (f && f.path);
      if (!p) continue;
      // rows are ascending, so the last write for a path wins
      out[p] = r.at;
    }
  }
  // The dedicated table wins where it has an answer: it is written by every
  // panel write, whereas the batch rows only exist for Deploy-screen uploads
  // and the oldest of them predate `files_json` entirely.
  const stamps = (await q(env, `SELECT path, at FROM file_times WHERE repo_id=?`, repoId).all()).results || [];
  for (const st of stamps) {
    const cur = Object.prototype.hasOwnProperty.call(out, st.path) ? out[st.path] : null;
    if (!cur || String(st.at) > String(cur)) out[st.path] = st.at;
  }
  return { ...out };            // a plain object for JSON.stringify
}

// A stamp must not outlive the file it described: a path deleted here and later
// re-created by a direct git push would otherwise show a date, and a tooltip
// saying Gitku wrote it, for a file Gitku never wrote.
async function dropFileTimes(env, repoId, paths) {
  const list = [...new Set((paths || []).filter(Boolean))];
  if (!repoId || !list.length) return;
  try {
    for (let i = 0; i < list.length; i += 50) {
      await env.DB.batch(list.slice(i, i + 50).map((p) => env.DB.prepare(
        `DELETE FROM file_times WHERE repo_id=? AND (path=? OR path LIKE ?)`)
        .bind(repoId, p, p + "/%")));
    }
  } catch { /* a display date must never fail a real delete */ }
}

async function startBuild(env, site, app, version) {
  // Remember the commit BEFORE the build is asked for: if Heroku accepts it and
  // we crash a line later, the worst case is one missed rebuild, not a loop
  // that rebuilds the same commit every five minutes for ever.
  if (app && app.id && version) {
    try { await q(env, `UPDATE apps SET built_sha=? WHERE id=?`, String(version), app.id).run(); }
    catch { /* the build matters more than the bookkeeping */ }
  }
  // Pin the archive to the COMMIT we just made, never to the branch. GitHub
  // caches branch archives, so a branch tarball fetched immediately after a push
  // can still be the previous snapshot — which silently deploys the old files
  // and looks like the panel did nothing. A per-commit archive cannot be stale.
  const ref = version || site.branch;
  const url = await GH.tarballUrl(site.gh_token, site.owner, site.name, ref, fetch);
  if (url) {
    try {
      return await HK.createBuild(app.hk_token, app.heroku_name, url, version, fetch);
    } catch {
      /* signed link may have expired or been refused; fall through to upload */
    }
  }
  const tar = await GH.tarball(site.gh_token, site.owner, site.name, ref, 40 * 1024 * 1024, fetch);
  return HK.deploy(app.hk_token, app.heroku_name, tar, version, fetch);
}

// v27: build EVERY app on one repo, in ONE request, without spending a
// subrequest per app on the same archive.
//
// ⚠️ A Worker invocation has a hard ceiling on outbound calls, and we have
// already hit it once ("Too many subrequests by single Worker invocation")
// when a cron tick tried 22 apps. The archive is IDENTICAL for every app on a
// repo, so it is fetched ONCE and handed to each build: cost is 1 + 1 + N, not
// 1 + 2N. The cap below is the honest ceiling for one call; anything past it is
// reported rather than silently dropped.
export const MAX_APPS_PER_BUILD_CALL = 10;

export async function buildRepoApps(env, site, apps, head) {
  const results = [];
  let url = null, tar = null;
  try { url = await GH.tarballUrl(site.gh_token, site.owner, site.name, head, fetch); } catch { url = null; }
  for (const app of apps) {
    // Record the commit BEFORE asking for the build, exactly as startBuild does:
    // a crash after Heroku accepted it must not become a rebuild loop.
    try { await q(env, `UPDATE apps SET built_sha=? WHERE id=?`, String(head), app.id).run(); }
    catch { /* the build matters more than the bookkeeping */ }
    try {
      let build = null;
      if (url) {
        try { build = await HK.createBuild(app.hk_token, app.heroku_name, url, head, fetch); }
        catch { build = null; }        // signed link expired or refused — fall through
      }
      if (!build) {
        if (!tar) tar = await GH.tarball(site.gh_token, site.owner, site.name, head, 40 * 1024 * 1024, fetch);
        build = await HK.deploy(app.hk_token, app.heroku_name, tar, head, fetch);
      }
      results.push({ app: app.heroku_name, id: app.id, ok: true, build_id: build.id, status: build.status });
    } catch (e) {
      // Put the commit back or this app is never retried by the cron.
      try { await q(env, `UPDATE apps SET built_sha=? WHERE id=?`, app.built_sha || null, app.id).run(); } catch {}
      results.push({ app: app.heroku_name, id: app.id, ok: false, error: hkMessage(e, app.hk_account) });
    }
  }
  return results;
}

export async function runBatch(env, batchId, siteIds, files, fileName, mode, who, appIds) {
  for (let i = 0; i < siteIds.length; i++) {
    const site = await siteRow(env, siteIds[i]);
    if (!site) continue;
    // Build the app the user actually ticked. Looking it up from the repo
    // returned whichever app was created first, so with two apps on one repo
    // the wrong site got rebuilt and the ticked one was reported Live.
    await deployOne(env, batchId, site, files, mode, who, appIds && appIds[i]);
  }
  const c = await q(env,
    `SELECT SUM(status='failed') AS failed, COUNT(*) AS n FROM batch_targets WHERE batch_id=?`, batchId).first();
  const failed = Number(c?.failed || 0), n = Number(c?.n || 0);
  await logAction(env, who, "sent a file", fileName, `${n} app(s), ${failed} failed`,
    failed === 0 ? 1 : 0,
    { ref: batchId,
      error: failed
        ? `${failed} of ${n} app(s) did not deploy. The reason for each one is on the deploy screen and in the rows above.`
        : null });
}

const REFRESH_EVERY_MS = 4000;

/**
 * How long a target may sit in "building" before the panel stops pretending it
 * knows. A Heroku build that has not answered in twenty minutes is not building
 * — either it finished and we cannot see it, or the key that could ask has gone.
 */
const GIVE_UP_AFTER_MS = 20 * 60 * 1000;

const TERMINAL = ["live", "failed", "no_app", "skipped", "unknown"];

/** When this target's build was handed to Heroku. */
const startedMs = (t) => {
  const at = t.started_at || t.batch_created_at;
  const ms = at ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Advance ONE in-flight target. Shared by the on-read refresh and the cron so
 * they can never drift apart.
 *
 * A poll that throws is NOT a failed build — the commit is in GitHub and the
 * build may well be running. It leaves the target building, records why in
 * `detail`, and only the clock above can end it. Reporting a network blip as a
 * failed deploy is a lie that sends someone hunting a build that succeeded.
 */
async function advanceTarget(env, t) {
  const set = (fields, ...vals) =>
    q(env, `UPDATE batch_targets SET ${fields} WHERE batch_id=? AND repo_id=?`,
      ...vals, t.batch_id, t.repo_id).run();

  const giveUp = async (why) => {
    await set("status='unknown', detail=?, finished_at=?", why.slice(0, 500), nowIso());
    await logPanel(env, "gave up waiting for a build", t.heroku_name, null,
      { ref: t.batch_id, ok: 0, error: why });
  };

  let b;
  try {
    b = await HK.getBuild(t.hk_token, t.heroku_name, t.build_id, fetch);
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 300);
    const began = startedMs(t);
    if (began !== null && Date.now() - began > GIVE_UP_AFTER_MS) {
      return giveUp(
        `Heroku stopped answering about this build (${why}). The file IS committed to the ` +
        `repo. Open the app's Activity tab on dashboard.heroku.com/apps/${t.heroku_name}/activity ` +
        `to see whether the build finished.`);
    }
    // Still inside the window: say what is happening, keep waiting.
    //
    // Only when the answer CHANGES. The browser polls this batch every couple of
    // seconds while a deploy is on screen, so during a Heroku outage an
    // unconditional log line here would write the same row fifteen times a
    // minute and bury everything else that mattered that day.
    const detail = `Waiting for Heroku — its last answer was: ${why}`;
    if (t.detail !== detail) {
      await set("detail=?", detail);
      await logPanel(env, "could not read a build status", t.heroku_name, "still waiting",
        { ref: t.batch_id, ok: 0, error: why });
    }
    return;
  }

  if (b.status === "pending") {
    const began = startedMs(t);
    if (began !== null && Date.now() - began > GIVE_UP_AFTER_MS) {
      return giveUp(
        `This build has been pending for over 20 minutes and Heroku has not finished it. ` +
        `The file IS committed to the repo. Open the app's Activity tab on ` +
        `dashboard.heroku.com/apps/${t.heroku_name}/activity to see what it did.`);
    }
    return;
  }

  if (b.status === "succeeded") {
    const at = nowIso();
    await set("status='live', detail=NULL, finished_at=?", at);
    // 🛑 `released_at` is what the Apps screen prints under "Last updated". Its
    // only writers were the manual Refresh and a cron pass guarded
    // `released_at IS NULL` — so once every app had a value, a deploy made
    // through this very panel never moved it and the column silently froze on
    // the date of the last Refresh. A build Heroku reports as succeeded IS a
    // release; record it here, on the path that knows.
    // (v28's own lesson, in this file: a derived value needs an owner on EVERY
    // path that can change it.)
    if (t.app_id) {
      try { await q(env, `UPDATE apps SET released_at=? WHERE id=?`, at, t.app_id).run(); } catch {}
    }
    await logPanel(env, "a build finished", t.heroku_name, "live", { ref: t.batch_id });
    return;
  }

  const tail = await HK.buildLogTail(b.output_stream_url, 8, fetch);
  const why = (tail || "Build failed.").slice(-500);
  await set("status='failed', detail=?, finished_at=?", why, nowIso());
  await logPanel(env, "a build finished", t.heroku_name, "failed",
    { ref: t.batch_id, ok: 0, error: why });
}

/** Poll Heroku for one batch's in-flight builds, at most once every few seconds. */
async function refreshBatch(env, batchId) {
  const b = await q(env, `SELECT last_poll FROM batches WHERE id=?`, batchId).first();
  if (!b) return;
  if (b.last_poll && Date.now() - Number(b.last_poll) < REFRESH_EVERY_MS) return;
  await q(env, `UPDATE batches SET last_poll=? WHERE id=?`, String(Date.now()), batchId).run();

  const rows = (await retryAfterMigration(env, () => q(env,
    `SELECT t.*, a.heroku_name, c.token AS hk_token, b.created_at AS batch_created_at
     FROM batch_targets t JOIN apps a ON a.id=t.app_id JOIN connections c ON c.id=a.connection_id
     JOIN batches b ON b.id=t.batch_id
     WHERE t.batch_id=? AND t.status='building' AND t.build_id IS NOT NULL LIMIT 10`, batchId).all())).results || [];
  for (const t of rows) {
    try { await advanceTarget(env, t); } catch { /* the cron is the backstop */ }
  }
}

/** Called by cron: advance any build still running. */
/**
 * ⭐ AUTOMATIC. Every cron tick, each linked app is compared with its repo: if
 * the repo's HEAD is not the commit the app last built, the panel builds it.
 *
 * This is what makes "I changed the repo" reach every app fed by it without
 * anybody pressing anything — including a change made on GitHub itself, an app
 * linked to a repo that already has content, and an app that was built once
 * before the repo had anything in it (the case that had ten of his apps
 * serving nothing while the panel said they were fine).
 *
 * Cheap on purpose: ONE HEAD read per repo per tick, shared by every app on it,
 * and the commit is written before the build is asked for, so a repo that has
 * not moved costs one small call and nothing else.
 */
async function autoBuildChangedRepos(env) {
  const rows = (await retryAfterMigration(env, () => q(env,
    `SELECT a.id, a.heroku_name, a.built_sha, a.repo_id, c.token AS hk_token,
            r.owner, r.name, r.branch, gc.token AS gh_token
     FROM apps a
     JOIN repos r ON r.id = a.repo_id
     JOIN connections c  ON c.id = a.connection_id
     JOIN connections gc ON gc.id = r.connection_id
     ORDER BY a.repo_id, a.id`).all())).results || [];
  if (!rows.length) return { checked: 0, built: 0 };

  const heads = new Map();          // repo_id -> HEAD sha, one read per repo
  let built = 0;
  // ⚠️ MEASURED IN PRODUCTION: a Worker invocation may only make so many
  // outbound requests, and a first tick that tried to build 22 apps hit
  // "Too many subrequests by single Worker invocation" on the last three.
  // Six builds a tick is well inside it, and the rest go on the next tick five
  // minutes later — nothing is dropped, it just takes a few more minutes.
  const MAX_PER_TICK = 6;
  for (const app of rows) {
    if (built >= MAX_PER_TICK) break;
    let head = heads.get(app.repo_id);
    if (head === undefined) {
      try {
        head = await GH.headSha(app.gh_token, app.owner, app.name, app.branch || "main", fetch);
      } catch (e) {
        head = null;                // GitHub down or the key cannot see it: skip quietly this tick
      }
      heads.set(app.repo_id, head);
    }
    if (!head || String(app.built_sha || "") === String(head)) continue;
    const first = !app.built_sha;
    try {
      const bd = await startBuild(env, { owner: app.owner, name: app.name, branch: app.branch,
                                         gh_token: app.gh_token }, app, head);
      built++;
      await logPanel(env, first ? "built an app for the first time" : "rebuilt an app after its repo changed",
        app.heroku_name,
        `${app.owner}/${app.name} at ${String(head).slice(0, 7)} · build ${bd.id}`,
        { ref: app.heroku_name });
    } catch (e) {
      // 🛑 The commit was written BEFORE the build was asked for, so a failure
      // here would leave the app marked as built and it would never be tried
      // again. Put it back, and the next tick picks it up.
      try { await q(env, `UPDATE apps SET built_sha=? WHERE id=?`, app.built_sha || null, app.id).run(); }
      catch { /* nothing better to do */ }
      await logPanel(env, "could not rebuild an app after its repo changed", app.heroku_name,
        `${app.owner}/${app.name} at ${String(head).slice(0, 7)} — it will be tried again`,
        { ok: 0, ref: app.heroku_name, error: hkMessage(e, null) });
    }
  }
  return { checked: rows.length, built };
}

// 🛑 THE "never built" MARK WENT STALE AND LIED.
// `apps.released_at` was written ONLY by "Refresh accounts". So an app the panel
// itself had just built kept its "Never deployed" line — five of his apps were
// serving their repo perfectly while the panel called them never built. Nothing
// in the build path ever put the answer back.
//
// This fills it in on the tick, and it costs NOTHING while every app is
// released: one list per Heroku account, and only for accounts that still hold
// an app with no recorded release.
async function refreshReleaseMarks(env) {
  const pending = (await retryAfterMigration(env, () => q(env,
    `SELECT DISTINCT a.connection_id, c.token AS hk_token
     FROM apps a JOIN connections c ON c.id = a.connection_id
     WHERE a.released_at IS NULL AND c.kind='heroku'`).all())).results || [];
  let filled = 0;
  for (const acct of pending.slice(0, 6)) {
    let apps;
    try { apps = await HK.listApps(acct.hk_token, fetch); }
    catch { continue; }                       // Heroku down: try again next tick
    for (const a of apps) {
      if (!a.released_at) continue;
      const r = await q(env,
        `UPDATE apps SET released_at=? WHERE connection_id=? AND heroku_name=? AND released_at IS NULL`,
        a.released_at, acct.connection_id, a.name).run();
      if (r && r.meta && r.meta.changes) filled += r.meta.changes;
    }
  }
  if (filled) {
    await logPanel(env, "recorded a first release", `${filled} app(s)`,
      "they had been built but were still marked as never deployed");
  }
  return filled;
}

export async function pollPanelBuilds(env) {
  // The automatic pass runs first: a repo that moved should reach its apps on
  // the same tick, not the next one.
  try { await autoBuildChangedRepos(env); } catch { /* never let it stop the poller */ }
  try { await refreshReleaseMarks(env); } catch { /* never let it stop the poller */ }

  const rows = (await retryAfterMigration(env, () => q(env,
    `SELECT t.*, a.heroku_name, a.web_url, c.token AS hk_token, b.created_at AS batch_created_at
     FROM batch_targets t JOIN apps a ON a.id=t.app_id JOIN connections c ON c.id=a.connection_id
     JOIN batches b ON b.id=t.batch_id
     WHERE t.status='building' AND t.build_id IS NOT NULL LIMIT 25`).all())).results || [];

  for (const t of rows) {
    try {
      await advanceTarget(env, t);
    } catch (e) {
      // advanceTarget already swallows a poll failure; reaching here means the
      // database itself refused, which must not spin forever on the next tick.
      const why = String((e && e.message) || e).slice(0, 300);
      await logPanel(env, "could not update a build", t.heroku_name, null,
        { ref: t.batch_id, ok: 0, error: why });
    }
  }
}

/**
 * Pull every Heroku app and GitHub repo for each combo and store them.
 *
 * This is the change Bob asked for: the deploy list is his REAL Heroku apps,
 * discovered automatically the moment a pair of keys is connected — not
 * websites typed in by hand. An app whose name matches a repo is linked
 * automatically; anything ambiguous is left for one click in Settings.
 */
export async function refreshCombos(env, actor, comboId, opts) {
  // 🛑 `skipBuildpack` exists because of a ceiling I walked into.
  // A Worker invocation may make ~50 outbound calls. The buildpack pass reads a
  // branch HEAD for EVERY linked app — up to 40 more calls — which is fine when
  // a person presses Refresh and it is the only thing happening. Once discovery
  // also ran on the cron tick, alongside the build poller, every tick blew the
  // ceiling: 394 "Too many subrequests" lines in three hours. The automatic
  // pass only needs to notice NEW apps and repos; what Heroku will build with
  // them can wait for a real Refresh.
  const skipBuildpack = !!(opts && opts.skipBuildpack);
  // v12: an optional third argument narrows the refresh to ONE pair, so the
  // panel can ask for every pair in parallel and paint each answer as it
  // lands. With no comboId the behaviour is exactly what it always was.
  const one = comboId !== undefined && comboId !== null;
  // 🛑 LEFT JOIN, NOT JOIN.
  // A pairing whose GitHub key has been deleted still has a working Heroku key —
  // and an inner join dropped the whole row, so that account was never asked for
  // its apps and they simply vanished from the panel. Measured on his live data:
  // one account held SEVEN apps on Heroku and showed ONE, because its GitHub half
  // (key #3) was removed during the 17 Aug outage and the pairing row survived
  // pointing at nothing. Read the pair, then work with whichever halves are
  // actually there.
  const comboSql =
    `SELECT c.id, c.label,
            g.id AS gid, g.token AS gtok, g.account AS gacct,
            h.id AS hid, h.token AS htok, h.account AS hacct
     FROM combos c
     LEFT JOIN connections g ON g.id = c.github_conn_id
     LEFT JOIN connections h ON h.id = c.heroku_conn_id` + (one ? ` WHERE c.id=?` : ``);
  const combos = (await (one ? q(env, comboSql, comboId) : q(env, comboSql)).all()).results || [];

  // ⚠ And a key that is in NO pairing at all was never read either. A key you
  // connected should show what it holds; pairing is what links the two sides,
  // not what makes an account exist. (Another of his accounts sat unpaired with
  // four stale apps for the same reason.)
  if (!one) {
    const loose = (await q(env,
      `SELECT id, kind, token, account FROM connections
        WHERE (kind='github' AND id NOT IN (SELECT github_conn_id FROM combos))
           OR (kind='heroku' AND id NOT IN (SELECT heroku_conn_id FROM combos))`).all()).results || [];
    for (const k of loose) {
      combos.push(k.kind === "heroku"
        ? { id: null, label: null, gid: null, gtok: null, gacct: null,
            hid: k.id, htok: k.token, hacct: k.account }
        : { id: null, label: null, gid: k.id, gtok: k.token, gacct: k.account,
            hid: null, htok: null, hacct: null });
    }
  }

  const summary = { apps: 0, repos: 0, linked: 0, errors: [], skipped: 0, checked: 0 };

  // Ask every account at once. These are independent networks — one pair waiting
  // for another to answer was pure queueing, and it is most of why a refresh with
  // three pairs felt slow. The database writes below stay in order, so nothing
  // races over a label or an auto-link.
  const fetched = await Promise.all(combos.map(async (c) => {
    const [apps, repos] = await Promise.all([
      c.htok ? HK.listApps(c.htok, fetch).catch((e) => ({ __err: e })) : [],
      c.gtok ? GH.listRepos(c.gtok, fetch).catch((e) => ({ __err: e })) : [],
    ]);
    return { c, apps, repos };
  }));

  for (const got of fetched) {
    const c = got.c;
    let apps = got.apps, repos = got.repos;
    // A half-dead pairing is a real problem with a real fix — say so plainly
    // rather than quietly returning fewer apps than the account holds.
    if (c.id && (!c.gtok || !c.htok)) {
      const missing = !c.gtok ? "GitHub" : "Heroku";
      const alive = !c.gtok ? c.hacct : c.gacct;
      summary.errors.push(
        `The ${missing} key in the pairing with ${alive} has been removed — connect it again under Accounts & keys.`);
      await logPanel(env, "a pairing is missing a key", alive || `pairing ${c.id}`,
        `its ${missing} key is gone; the other half was still read`,
        { actor, ok: 0, ref: alive || undefined,
          error: `Connect a ${missing} key for this pairing again — until then it can list apps but not deploy.` });
    }
    if (apps && apps.__err) {
      const e = apps.__err; apps = [];
      summary.errors.push(`Heroku ${c.hacct}: ${e.message}`);
      // An expired or revoked key looks exactly like this. Saying so here is
      // the difference between "the refresh did nothing" and knowing why.
      await logPanel(env, "could not read a Heroku account", c.hacct, null,
        { actor, ok: 0, ref: c.hacct,
          error: hkMessage(e, c.hacct) });
    }
    if (repos && repos.__err) {
      const e = repos.__err; repos = [];
      summary.errors.push(`GitHub ${c.gacct}: ${e.message}`);
      await logPanel(env, "could not read a GitHub account", c.gacct, null,
        { actor, ok: 0, ref: c.gacct, error: ghMessage(e, `the ${c.gacct} account`) });
    }
    summary.repos += repos.length;

    // repos first, so an app can be matched to one straight away
    // Read what is already stored ONCE, rather than two lookups per repo.
    // With five accounts' worth of repos that was dozens of separate hops
    // to a database in another region, every one of them waiting for the last.
    // ⚡ CEILING FIX (29 Aug): these were four separate awaits per account, and
    // matchRepo added one more per unlinked app. At nine accounts a single cron
    // tick crossed Cloudflare's ~50-subrequest ceiling and simply stopped — the
    // accounts read LAST never got their apps, which is exactly what happened to
    // the unpaired hildalyons key. A D1 batch is ONE subrequest for all four.
    const [reposRes, knownAppsRes, labelsRes, connReposRes] = await env.DB.batch([
      env.DB.prepare(`SELECT id, owner, name, label FROM repos`),
      env.DB.prepare(`SELECT id, heroku_name, repo_id FROM apps WHERE connection_id=?`).bind(c.hid ?? -1),
      env.DB.prepare(`SELECT label FROM apps`),
      env.DB.prepare(`SELECT id, name FROM repos WHERE connection_id=?`).bind(c.gid ?? -1),
    ]);
    const knownRepos = reposRes.results || [];
    const byOwnerName = new Map(knownRepos.map((r) => [`${r.owner}/${r.name}`, r.id]));
    const usedLabels = new Set(knownRepos.map((r) => r.label));
    const inserts = [];
    let newRepos = 0;
    for (const r of repos) {
      const key = `${r.owner}/${r.name}`;
      // 🛑 A KNOWN repo used to be skipped outright, so anything read from GitHub
      // was written once at discovery and never moved again. A column headed
      // "Last updated" that froze on the day we first saw the repo would be a
      // lie told with a straight face — worse than showing nothing. Update it.
      if (byOwnerName.has(key)) {
        inserts.push(env.DB.prepare(
          `UPDATE repos SET gh_created_at=COALESCE(?, gh_created_at), pushed_at=COALESCE(?, pushed_at)
           WHERE id=?`).bind(r.created_at || null, r.pushed_at || null, byOwnerName.get(key)));
        continue;
      }
      const label = usedLabels.has(r.name) ? r.full_name : r.name;
      newRepos++;
      byOwnerName.set(key, null);
      usedLabels.add(label);
      inserts.push(env.DB.prepare(
        `INSERT INTO repos (label, owner, name, branch, connection_id, created_at, url, dir, gh_created_at, pushed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(label, r.owner, r.name, r.branch, c.gid, nowIso(), "", "",
              r.created_at || null, r.pushed_at || null));
    }
    // One round trip for the whole account instead of one per repo.
    if (inserts.length) await env.DB.batch(inserts);

    // ⚡ MEASURED: this loop was the slowest thing in the product. It did a
    // SELECT and then an UPDATE for EVERY app, one after another, and the
    // database is in another region — so 55 apps meant ~110 Atlantic crossings
    // in a row. A refresh took 14.4 seconds. Read what is already stored ONCE
    // per account, then send the writes as ONE batch, exactly as the repo loop
    // above already does.
    const knownApps = new Map((knownAppsRes.results || []).map((r) => [r.heroku_name, r]));
    const usedAppLabels = new Set((labelsRes.results || []).map((r) => r.label));
    // matchRepo() was a database call PER APP. Same rows, read once above.
    // ⚠ Only re-read when this account actually GAINED a repo: a repo inserted
    // a moment ago is not in the batch above, and an app must still be able to
    // link to it on the same pass. Steady state inserts nothing and pays nothing.
    const connRepos = newRepos
      ? ((await q(env, `SELECT id, name FROM repos WHERE connection_id=?`, c.gid ?? -1).all()).results || [])
      : (connReposRes.results || []);
    const appWrites = [];
    const linkedNow = [];          // {name, repo} — logged after the batch lands
    for (const a of apps) {
      summary.apps++;
      const known = knownApps.get(a.name);
      if (known) {
        appWrites.push(env.DB.prepare(
          `UPDATE apps SET web_url=?, combo_id=?, released_at=?,
                  heroku_created_at=COALESCE(?, heroku_created_at) WHERE id=?`)
          .bind(a.web_url || null, c.id, a.released_at || null, a.created_at || null, known.id));
        if (!known.repo_id) {
          const match = matchRepoIn(connRepos, a.name);
          if (match) {
            appWrites.push(env.DB.prepare(`UPDATE apps SET repo_id=? WHERE id=?`).bind(match.id, known.id));
            summary.linked++;
            linkedNow.push({ name: a.name, repo: match.name });
          }
        }
        continue;
      }
      const match = matchRepoIn(connRepos, a.name);
      // the label is unique across the table, so a clash has to be settled here
      // rather than by asking the database once per app
      const label = usedAppLabels.has(a.name) ? `${a.name} (${c.hacct})` : a.name;
      usedAppLabels.add(label);
      appWrites.push(env.DB.prepare(
        `INSERT INTO apps (label, heroku_name, connection_id, repo_id, web_url, created_at, combo_id,
                           released_at, heroku_created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(label, a.name, c.hid, match ? match.id : null, a.web_url || null, nowIso(), c.id,
              a.released_at || null, a.created_at || null));
      if (match) { summary.linked++; linkedNow.push({ name: a.name, repo: match.name }); }
    }
    if (appWrites.length) await env.DB.batch(appWrites);
    for (const l of linkedNow) {
      await logPanel(env, "linked an app by itself", l.name, `to ${l.repo}, matched by name`,
        { actor, ref: l.name });
    }
  }
  // Detect the buildpack for every linked app, so the deploy screen can warn
  // about "No default language could be detected" BEFORE he tries to deploy.
  //
  // This used to be the slowest part of a refresh by a wide margin: reading a
  // repo's file list costs three GitHub calls and downloads every path in
  // it, and that ran for every linked app, every time, in turn. Two changes:
  // ask all the branches at once, and only read the file list of a repo
  // whose branch has actually moved since we last looked.
  // A one-pair refresh judges only that pair's apps — checking every other
  // pair's repos here would make N parallel one-pair calls each redo
  // the whole fleet's buildpack work N times over.
  const appsSql =
    `SELECT id, repo_id, heroku_name, buildpack, buildpack_sha
       FROM apps WHERE repo_id IS NOT NULL` + (one ? ` AND combo_id=?` : ``) + ` LIMIT 40`;
  const linkedApps = skipBuildpack ? []
    : (await (one ? q(env, appsSql, comboId) : q(env, appsSql)).all()).results || [];

  // ⚡ Same problem, smaller: siteRow() per app was up to 40 more round trips
  // in a row. Every app on the same repo wants the same row, so read the whole
  // set once and look each one up in memory.
  const repoIds = [...new Set(linkedApps.map((la) => la.repo_id).filter(Boolean))];
  const repoById = new Map();
  if (repoIds.length) {
    const rows = (await q(env,
      `SELECT r.*, c.token AS gh_token FROM repos r
         LEFT JOIN connections c ON c.id = r.connection_id
        WHERE r.id IN (${repoIds.map(() => "?").join(",")})`, ...repoIds).all()).results || [];
    for (const r of rows) repoById.set(r.id, r);
  }
  const withRepo = [];
  for (const la of linkedApps) {
    const repo = repoById.get(la.repo_id);
    // ⚠ `gh_token` must exist. siteRow() inner-joined connections, so a repo
    // whose key has been removed returned NOTHING and was skipped; the LEFT
    // JOIN above returns it with a null token, and calling GitHub with null
    // would turn a missing key into a confusing vendor error.
    if (repo && repo.gh_token) withRepo.push({ la, repo });
  }

  const heads = await Promise.all(withRepo.map(({ repo }) =>
    GH.headSha(repo.gh_token, repo.owner, repo.name, repo.branch, fetch)
      .catch(() => null)));   // unreadable branch: fall through and look properly

  await Promise.all(withRepo.map(async ({ la, repo }, i) => {
    const head = heads[i];
    if (head && la.buildpack_sha === head && la.buildpack !== null) {
      summary.skipped++;
      return;                 // nothing has changed here since we last looked
    }
    summary.checked++;
    await recordBuildpack(env, la.id, repo, actor, la, head);
  }));

  // A one-pair refresh names the pair it touched, so the log stays readable
  // when the panel fans a refresh out over several pairs at once.
  await logAction(env, actor, "refreshed accounts",
    one ? String((combos[0] && combos[0].label) || `pair ${comboId}`) : null,
    `${summary.apps} app(s), ${summary.repos} repo(s), ${summary.linked} auto-linked`,
    summary.errors.length ? 0 : 1,
    { ref: "refresh", error: summary.errors.length ? summary.errors.join(" · ").slice(0, 600) : null });
  return summary;
}

/**
 * Remember what Heroku will detect, so the deploy screen can warn up front.
 *
 * Logged only when the answer CHANGES. Detection runs for every linked app on
 * every refresh; writing a row each time would bury the deploys under forty
 * identical lines, while a change ("this app can no longer build") is exactly
 * the thing worth knowing.
 */
async function recordBuildpack(env, appId, repo, actor, known, headSha) {
  // `known` lets a caller that has already read the row pass it in. The refresh
  // walks up to 40 apps; re-reading each one here would be 40 extra hops to a
  // database in another region for a value the caller already has.
  const before = known || await q(env, `SELECT heroku_name, buildpack FROM apps WHERE id=?`, appId).first();
  try {
    const t = await GH.treeOf(repo.gh_token, repo.owner, repo.name, repo.branch, fetch);
    const bp = GH.buildpackFor(t.entries.filter((e) => e.type === "blob").map((e) => e.path));
    // '' means "we looked and Heroku will find nothing"; NULL still means "not
    // looked at yet". Conflating them made a brand-new app look broken.
    const stored = bp === null ? "" : bp;
    // Remember WHICH commit this answer came from, so the next refresh can skip
    // the whole file listing while the branch stays where it is.
    await q(env, `UPDATE apps SET buildpack=?, buildpack_sha=? WHERE id=?`,
      stored, headSha || t.commitSha || null, appId).run();
    if (before && before.buildpack !== stored) {
      await logPanel(env, "checked what Heroku will build", before.heroku_name,
        bp ? `detected ${bp}` : "nothing detected — Heroku cannot build this repo as it stands",
        { actor, ref: `${repo.owner}/${repo.name}`, ok: bp ? 1 : 0,
          error: bp ? null
            : `No buildpack matches ${repo.owner}/${repo.name}, so a deploy will fail with ` +
              `"No default language could be detected". Use "Make it deployable" on the app.` });
    }
    return bp;
  } catch (e) {
    await logPanel(env, "could not check what Heroku will build",
      before ? before.heroku_name : String(appId), null,
      { actor, ok: 0, ref: `${repo.owner}/${repo.name}`, error: ghMessage(e, repo) });
    return undefined;
  }
}

/** Match a Heroku app to a repo on the same account by name, loosely. */
async function matchRepo(env, githubConnId, appName) {
  const rows = (await q(env, `SELECT id, name FROM repos WHERE connection_id=?`, githubConnId).all()).results || [];
  return matchRepoIn(rows, appName);
}

/** The same match, against rows already in memory — no database call. */
function matchRepoIn(rows, appName) {
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(appName);
  let hit = rows.find((r) => norm(r.name) === target);
  if (hit) return hit;
  // Heroku often appends a random suffix, e.g. myapp-1a2b3c4d5e6f
  const trimmed = target.replace(/[0-9a-f]{6,12}$/, "");
  if (trimmed.length >= 4) {
    hit = rows.find((r) => norm(r.name) === trimmed);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------- the router

export async function handlePanel(env, request, ctx, path) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(env, request) });
  }

  const url = new URL(request.url);
  const seg = path.split("/").filter(Boolean); // ["api", ...]
  const route = seg[1] || "";
  const body = async () => {
    try { return await request.json(); } catch { return {}; }
  };

  // ---- login (unauthenticated, rate limited) ------------------------------
  if (route === "login" && request.method === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const att = await q(env, `SELECT * FROM login_attempts WHERE ip=?`, ip).first();
    if (att && att.n >= 10 && Date.now() - Date.parse(att.first_at) < 15 * 60 * 1000) {
      await logFail(env, "unknown", "sign-in blocked", null,
        `Too many wrong passwords from ${ip}. Sign-in is refused from that address for 15 minutes, ` +
        `even with the right password.`, { ref: ip });
      return err(env, request, "Too many attempts. Wait 15 minutes.", 429);
    }

    const b = await body();
    const u = await q(env, `SELECT * FROM panel_users WHERE username=?`, String(b.username || "")).first();
    let good = false;
    if (u) {
      const hash = await pbkdf2(String(b.password || ""), fromBase64(u.salt));
      good = sameSecret(hash, u.pass_hash);
    }
    if (!good) {
      await q(env,
        `INSERT INTO login_attempts (ip, n, first_at) VALUES (?,1,?)
         ON CONFLICT (ip) DO UPDATE SET n = CASE WHEN ? - CAST(strftime('%s', first_at) AS INTEGER)*1000 > 900000 THEN 1 ELSE n+1 END`,
        ip, nowIso(), Date.now()).run();
      // Never the password, and never a hint about which half was wrong.
      await logFail(env, String(b.username || "").slice(0, 60) || "unknown", "sign-in refused", null,
        u ? "Wrong password." : "No account with that username.", { ref: ip });
      return err(env, request, "Wrong username or password.", 401);
    }
    await q(env, `DELETE FROM login_attempts WHERE ip=?`, ip).run();

    const token = randomToken();
    const expires = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
    await q(env, `INSERT INTO sessions (token, username, role, expires, created_at) VALUES (?,?,?,?,?)`,
      token, u.username, u.role, expires, nowIso()).run();
    await logAction(env, u.username, "signed in", null, null);
    return json(env, request, { session: token, role: outRole(u.role), username: u.username, expires });
  }

  // ---- everything else needs a session ------------------------------------
  const me = await auth(env, request);
  if (!me) return err(env, request, "Not signed in.", 401);
  // Bob's instruction: the VA does the work, so she may connect keys, pair
  // accounts, link apps and deploy. The single carve-out is managing people —
  // otherwise she could remove the owner's own account.
  const master = outRole(me.role) === "owner";
  const needMaster = () => err(env, request, "Only the owner can manage people.", 403);

  if (route === "logout") {
    await q(env, `DELETE FROM sessions WHERE token=?`, me.token).run();
    return json(env, request, { ok: true });
  }
  if (route === "me") return json(env, request, { username: me.username, role: outRole(me.role) });

  // ---- one call that paints the whole screen ------------------------------
  if (route === "state") {
    // Deploy targets are the Heroku APPS themselves, discovered from his
    // account — not hand-registered domains. Each carries the repo it deploys
    // from, or a flag saying it still needs one.
    // ONE round trip, not five. The database is in another region, so each
    // sequential query was costing a full network hop on every screen paint.
    // NEWEST FIRST, everywhere. These used to be ORDER BY label / name / id
    // ascending, which buried a just-added app somewhere in the middle of an
    // alphabetical list — the one place nobody looks after adding something.
    // created_at is the truth where we have it; the id breaks ties and covers
    // rows that predate the column (they were inserted in id order anyway).
    const [appsR, connsR, tagsR, appTagsR, combosR, recentR, usersR] = await retryAfterMigration(env, () => env.DB.batch([
      env.DB.prepare(
        `SELECT a.id, a.label, a.heroku_name, a.web_url, a.repo_id, a.combo_id, a.buildpack,
                a.created_at AS created_at,
                r.owner AS owner, r.name AS repo, r.branch AS branch, COALESCE(r.dir,'') AS dir,
                r.created_at AS repo_created_at,
                r.gh_created_at AS repo_gh_created_at, r.pushed_at AS repo_pushed_at,
                COALESCE(a.paused,0) AS paused, a.note AS note, a.note_color AS note_color,
                a.released_at AS released_at, a.heroku_created_at AS heroku_created_at,
                hc.account AS heroku_account
         FROM apps a
         LEFT JOIN repos r ON r.id = a.repo_id
         LEFT JOIN connections hc ON hc.id = a.connection_id
         ORDER BY COALESCE(a.created_at,'') DESC, a.id DESC`),
      env.DB.prepare(
        `SELECT id, kind, account, created_at, note FROM connections
         ORDER BY COALESCE(created_at,'') DESC, id DESC`),
      // v31: every tag, and which apps carry it. Two small reads, one round trip.
      env.DB.prepare(
        `SELECT t.id, t.label, t.color, t.created_at,
                (SELECT COUNT(*) FROM app_tags x WHERE x.tag_id=t.id) AS uses
         FROM tags t ORDER BY t.label COLLATE NOCASE`),
      env.DB.prepare(`SELECT app_id, tag_id FROM app_tags`),
      env.DB.prepare(
        // 🛑 LEFT JOIN. An inner join made a pairing whose key had been removed
        // VANISH from the screen entirely — so the one thing that needed
        // attention was the one thing he could not see. It is listed now, with
        // the missing side reading null, and the panel says it is broken.
        `SELECT c.id, c.label, c.created_at, g.account AS github, h.account AS heroku,
                c.github_conn_id, c.heroku_conn_id,
                (SELECT COUNT(*) FROM apps a WHERE a.combo_id = c.id) AS apps
         FROM combos c
         LEFT JOIN connections g ON g.id = c.github_conn_id
         LEFT JOIN connections h ON h.id = c.heroku_conn_id
         ORDER BY COALESCE(c.created_at,'') DESC, c.id DESC`),
      env.DB.prepare(
        // `where` names the apps the file actually went to. Without it the
        // activity list showed only a batch id, which reads as gibberish.
        `SELECT b.id, b.created_at AS at, b.who, b.file_name AS file,
                (SELECT COUNT(*) FROM batch_targets t WHERE t.batch_id=b.id) AS sites,
                (SELECT COUNT(*) FROM batch_targets t WHERE t.batch_id=b.id AND t.status IN ('live','no_app')) AS ok,
                (SELECT COUNT(*) FROM batch_targets t WHERE t.batch_id=b.id AND t.status='failed') AS failed,
                (SELECT group_concat(COALESCE(a.heroku_name, r2.label), ', ')
                   FROM batch_targets t
                   LEFT JOIN apps  a  ON a.id  = t.app_id
                   LEFT JOIN repos r2 ON r2.id = t.repo_id
                  WHERE t.batch_id = b.id) AS targets
         FROM batches b ORDER BY b.created_at DESC LIMIT 15`),
      env.DB.prepare(`SELECT username, role FROM panel_users ORDER BY role, username`),
    ]));

    /* ⚠ BUILT BEFORE THE MAP THAT USES IT. `const` is not hoisted like `var`:
       declaring this after `sites` put it in a temporal dead zone and every app
       would have thrown on `tagsByApp.get`. The same trap cost a whole feature
       in v29 — see the note on twSet(). */
    const tagsByApp = new Map();
    for (const r of (appTagsR.results || [])) {
      const k = Number(r.app_id);
      if (!tagsByApp.has(k)) tagsByApp.set(k, []);
      tagsByApp.get(k).push(Number(r.tag_id));
    }
    const rawApps = appsR.results || [];
    const sites = rawApps.map((a) => ({
      id: String(a.id),
      label: a.heroku_name,
      url: a.web_url || "",
      app: a.heroku_name,
      app_url: a.web_url || "",
      owner: a.owner || "",
      repo: a.repo || "",
      branch: a.branch || "main",
      dir: a.dir || "",
      linked: !!a.repo_id,
      // buildpack: the name, or null. buildpack_checked says whether we have
      // actually looked — the panel must only warn when checked AND nothing found.
      buildpack: a.buildpack ? a.buildpack : null,
      buildpack_checked: a.repo_id ? a.buildpack !== null && a.buildpack !== undefined : false,
      account: a.heroku_account || "",
      // v18: marked as not in use. A MARK, not a lock. (v20: no longer shown —
      // his note replaced it — but kept so nothing silently loses a value.)
      paused: a.paused ? 1 : 0,
      note: a.note || "",
      note_color: noteColor(a.note_color),
      // false = Heroku has never released this app, so its address shows
      // Heroku's welcome page no matter what is in the repo
      released: !!a.released_at,
      // When this app was first seen. The list is already newest-first; this is
      // here so the UI can say "added just now" and offer another sort order.
      created_at: a.created_at || null,
      repo_created_at: a.repo_created_at || null,
      // v29 — the vendors' own dates. `created_at` above is when GITKU first saw
      // the app; these two are Heroku's and GitHub's, which is what a person
      // means by "Created on" and "Last updated".
      heroku_created_at: a.heroku_created_at || null,
      released_at: a.released_at || null,
      repo_gh_created_at: a.repo_gh_created_at || null,
      repo_pushed_at: a.repo_pushed_at || null,
      tags: tagsByApp.get(Number(a.id)) || [],
    }));

    const tags = (tagsR.results || []).map((t) => ({
      id: String(t.id), label: t.label, color: noteColor(t.color),
      created_at: t.created_at || null, uses: Number(t.uses || 0),
    }));
    const accounts = { github: [], heroku: [] };
    for (const c of connsR.results || []) {
      const entry = { id: c.id, account: c.account, created_at: c.created_at || null,
                      note: c.note || "" };
      if (c.kind === "github") entry.login = c.account; else entry.email = c.account;
      accounts[c.kind]?.push(entry);
    }

    const combos = (combosR.results || []).map((c) => ({
      ...c, created_at: c.created_at || null,
      // which half is gone, so the screen can say it plainly instead of the
      // pairing simply not being there
      missing: !c.github ? "github" : (!c.heroku ? "heroku" : null),
    }));
    const recent = recentR.results || [];
    const users = (usersR.results || []).map((u) => ({ username: u.username, role: outRole(u.role) }));

    const unlinked = sites.filter((x) => !x.linked).length;
    const paused = sites.filter((x) => x.paused).length;
    return json(env, request, {
      sites, apps: sites, accounts, combos, users, recent, tags,
      needs: { unlinked, paused, no_combo: combos.length === 0 },
      me: { username: me.username, role: outRole(me.role) },
    });
  }

  // ---- combos: one GitHub account paired with one Heroku account ----------
  if (route === "combo") {
    if (request.method === "POST") {
      const b = await body();
      const g = Number(b.github_conn_id), h = Number(b.heroku_conn_id);
      if (!g || !h) return err(env, request, "Pick one GitHub account and one Heroku account.");
      const gc = await q(env, `SELECT account FROM connections WHERE id=? AND kind='github'`, g).first();
      const hc = await q(env, `SELECT account FROM connections WHERE id=? AND kind='heroku'`, h).first();
      if (!gc || !hc) return err(env, request, "That account is not connected.");
      try {
        await q(env, `INSERT INTO combos (label, github_conn_id, heroku_conn_id, created_at) VALUES (?,?,?,?)`,
          String(b.label || `${gc.account} + ${hc.account}`), g, h, nowIso()).run();
      } catch (e) {
        if (/UNIQUE/i.test(String(e))) {
          const why = "Those two accounts are already paired.";
          await logFail(env, me.username, "could not pair accounts", `${gc.account} + ${hc.account}`, why);
          return err(env, request, why);
        }
        throw e;
      }
      await logAction(env, me.username, "paired accounts", `${gc.account} + ${hc.account}`, null);
      const summary = await refreshCombos(env, me.username);
      return json(env, request, { ok: true, discovered: summary });
    }
    if (request.method === "DELETE" && seg[2]) {
      await q(env, `DELETE FROM combos WHERE id=?`, Number(seg[2])).run();
      await logAction(env, me.username, "removed a pairing", seg[2], null);
      return json(env, request, { ok: true });
    }
  }

  // ---- pull apps and repos again -----------------------------------------
  // v12: an optional {combo_id} narrows the refresh to one pair and returns
  // the same summary shape for it, so the browser can refresh every pair in
  // parallel and paint each answer as it arrives. No combo_id = everything,
  // exactly as before.
  if (route === "refresh" && request.method === "POST") {
    const b = await body();
    if (b && b.combo_id !== undefined && b.combo_id !== null && b.combo_id !== "") {
      const id = Number(b.combo_id);
      if (!Number.isFinite(id)) return err(env, request, "That pair id makes no sense.", 400);
      const c = await q(env, `SELECT id FROM combos WHERE id=?`, id).first();
      if (!c) return err(env, request, "That pair is no longer there — refresh the page and try again.", 404);
      const summary = await refreshCombos(env, me.username, id);
      return json(env, request, summary);
    }
    const summary = await refreshCombos(env, me.username);
    return json(env, request, summary);
  }

  // ---- activity log -------------------------------------------------------
  // Shows three things now: what a person did, what the panel did on its own,
  // and — for either — why it failed. The old response shape is a subset of
  // this one, so a page written against the previous version still works.
  if (route === "logs") {
    const where = [], args = [];
    const kind = String(url.searchParams.get("kind") || "").toLowerCase();
    if (kind === "person" || kind === "panel") {
      // Rows written before the column existed are person actions by definition.
      where.push(kind === "person" ? `COALESCE(kind,'person')='person'` : `kind='panel'`);
    }
    const onlyErrors = String(url.searchParams.get("only") || "").toLowerCase() === "errors";
    if (onlyErrors) where.push(`ok=0`);
    const term = String(url.searchParams.get("q") || "").trim().slice(0, 100);
    if (term) {
      // Everything a person would type: who, what, which app, and the reason.
      // instr() on one concatenated haystack rather than six LIKEs: LIKE would
      // need an ESCAPE clause to stop a literal % or _ in a search behaving as
      // a wildcard, and one placeholder is easier to keep honest than six.
      where.push(
        `instr(lower(actor || ' ' || action || ' ' || COALESCE(target,'') || ' ' ||
                     COALESCE(detail,'') || ' ' || COALESCE(error,'') || ' ' ||
                     COALESCE(ref,'')), lower(?)) > 0`);
      args.push(term);
    }
    const sql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const bound = (s) => (args.length ? s.bind(...args) : s);
    const [rowsR, countR] = await retryAfterMigration(env, () => env.DB.batch([
      bound(env.DB.prepare(
        `SELECT id, at, actor, action, target, detail, ok, COALESCE(kind,'person') AS kind, error, ref
         FROM audit_log${sql} ORDER BY id DESC LIMIT ${LOG_LIMIT}`)),
      bound(env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log${sql}`)),
    ]));
    const entries = (rowsR.results || []).map((r) => ({ ...r, ok: r.ok ? 1 : 0 }));
    const total = Number((countR.results || [])[0]?.n || entries.length);
    return json(env, request, {
      entries,
      total,                       // how many match the filter in all
      shown: entries.length,       // how many came back, capped at `limit`
      limit: LOG_LIMIT,
      truncated: total > entries.length,
      filter: { kind: kind === "person" || kind === "panel" ? kind : null,
                only: onlyErrors ? "errors" : null, q: term || null },
    });
  }

  // ---- deploy -------------------------------------------------------------
  if (route === "deploy" && request.method === "POST") {
    // A deploy that is refused before it starts leaves no batch to look at, so
    // the log is the only place the reason can survive.
    const refuse = async (why, status = 400) => {
      await logFail(env, me.username, "could not start a deploy", null, why);
      return err(env, request, why, status);
    };

    let form;
    try { form = await request.formData(); } catch { return refuse("Upload was not readable."); }

    // Many files and whole folders at once. The browser sends every File under
    // the same field; `paths` carries each one's path relative to what he
    // dropped, so a folder keeps its shape.
    const blobs = form.getAll("file").filter((f) => f && typeof f !== "string");
    if (!blobs.length) return refuse("No files were attached.");
    let rels = [];
    try { rels = JSON.parse(String(form.get("paths") || "[]")); } catch { rels = []; }

    let siteIds;
    try { siteIds = JSON.parse(String(form.get("sites") || "[]")).map(Number).filter(Boolean); }
    catch { return refuse("Could not read which apps you picked."); }
    if (!siteIds.length) return refuse("Pick at least one app.");
    if (siteIds.length > MAX_SITES_PER_BATCH) {
      return refuse(`Up to ${MAX_SITES_PER_BATCH} apps at once. You picked ${siteIds.length}.`);
    }
    const mode = ["auto", "replace", "new"].includes(String(form.get("mode"))) ? String(form.get("mode")) : "auto";

    if (blobs.length > 200) return refuse(`That is ${blobs.length} files. Send up to 200 at a time.`);
    const files = [];
    let total = 0;
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      const bytes = new Uint8Array(await b.arrayBuffer());
      total += bytes.length;
      if (total > 30 * 1024 * 1024) {
        return refuse("That is more than 30 MB in one go. Send it in smaller batches.");
      }
      const name = String(b.name || `file-${i + 1}`).split("/").pop();
      files.push({ bytes, name, rel: String(rels[i] || name) });
    }
    const fileName = files.length === 1 ? files[0].name : `${files.length} files`;

    const batchId = randomToken().slice(0, 16);
    await q(env, `INSERT INTO batches (id, who, file_name, mode, created_at) VALUES (?,?,?,?,?)`,
      batchId, me.username, fileName, mode, nowIso()).run();

    // The ids coming from the panel are HEROKU APP ids. Resolve each to the
    // repo it deploys from; an app with no repo cannot receive a file, and says so.
    const targets = [];
    const repoIds = [];
    const appIdsForRepos = [];
    for (const id of siteIds) {
      const app = await q(env,
        `SELECT a.id, a.label, a.heroku_name, a.repo_id FROM apps a WHERE a.id=?`, id).first();
      if (!app) continue;
      if (!app.repo_id) {
        await q(env, `INSERT INTO batch_targets (batch_id, repo_id, app_id, status, detail, finished_at)
                      VALUES (?,?,?,'failed',?,?)`,
          batchId, -app.id, app.id,
          "This app has no repo linked yet — pick one on its card, then try again.", nowIso()).run();
        targets.push({ site_id: String(app.id), label: app.heroku_name, status: "failed" });
        continue;
      }
      if (repoIds.includes(app.repo_id)) {
        await q(env, `INSERT INTO batch_targets (batch_id, repo_id, app_id, status, detail, finished_at)
                      VALUES (?,?,?,'skipped',?,?)`,
          batchId, -app.id, app.id,
          "Another selected app already deploys from the same repo.", nowIso()).run();
        targets.push({ site_id: String(app.id), label: app.heroku_name, status: "skipped" });
        continue;
      }
      repoIds.push(app.repo_id);
      appIdsForRepos.push(app.id);
      await q(env, `INSERT INTO batch_targets (batch_id, repo_id, app_id, status) VALUES (?,?,?,'committing')`,
        batchId, app.repo_id, app.id).run();
      targets.push({ site_id: String(app.id), label: app.heroku_name, status: "committing" });
    }
    if (!repoIds.length && !targets.length) return refuse("None of those apps could be found.");

    await logAction(env, me.username, "started a deploy", fileName,
      `${targets.length} app(s): ${targets.map((t) => t.label).join(", ")}`, 1, { ref: batchId });

    // Answer immediately; the browser polls /api/batch/{id}.
    ctx.waitUntil(runBatch(env, batchId, repoIds, files, fileName, mode, me.username, appIdsForRepos));
    return json(env, request, { batch: batchId, targets });
  }

  if (route === "batch" && seg[2]) {
    // Refresh from Heroku on the read, throttled. This is why a finished build
    // shows up in a second or two instead of waiting for the next cron tick,
    // and it is what lets the cron drop to every 5 minutes.
    await refreshBatch(env, seg[2]);
    const rows = (await q(env,
      `SELECT COALESCE(t.app_id, t.repo_id) AS site_id,
              COALESCE(a.heroku_name, r.label) AS label,
              COALESCE(a.web_url, r.url) AS url,
              t.status, t.detail, t.path, t.build_url
       FROM batch_targets t
       LEFT JOIN repos r ON r.id = t.repo_id
       LEFT JOIN apps  a ON a.id = t.app_id
       WHERE t.batch_id=? ORDER BY label`, seg[2]).all()).results || [];
    const targets = rows.map((r) => ({ ...r, site_id: String(r.site_id) }));
    // 'unknown' is terminal too — it is what a target becomes when Heroku has
    // stopped answering, so the browser must stop polling for it as well.
    const done = targets.every((r) => TERMINAL.includes(r.status));
    const undone = (await q(env, `SELECT mode FROM batches WHERE id=?`, seg[2]).first())?.mode === "undo";
    return json(env, request, { batch: seg[2], done, undone, targets });
  }

  if (route === "undo" && seg[2] && request.method === "POST") {
    const rows = (await q(env, `SELECT * FROM batch_targets WHERE batch_id=?`, seg[2]).all()).results || [];
    if (!rows.length) return err(env, request, "That deploy is no longer in the log.", 404);
    const newBatch = randomToken().slice(0, 16);
    const src = await q(env, `SELECT file_name FROM batches WHERE id=?`, seg[2]).first();
    await q(env, `INSERT INTO batches (id, who, file_name, mode, created_at) VALUES (?,?,?,?,?)`,
      newBatch, me.username, `undo of ${src?.file_name || seg[2]}`, "undo", nowIso()).run();
    for (const t of rows) {
      await q(env, `INSERT INTO batch_targets (batch_id, repo_id, app_id, status) VALUES (?,?,?,'committing')`,
        newBatch, t.repo_id, t.app_id).run();
    }
    await logAction(env, me.username, "undid a deploy", src?.file_name || seg[2], `${rows.length} app(s)`);
    ctx.waitUntil(undoBatch(env, newBatch, rows, me.username));
    return json(env, request, { batch: newBatch });
  }

  // ---- credentials --------------------------------------------------------
  if (route === "token") {
    if (request.method === "POST") {
      const b = await body();
      const kind = b.kind === "heroku" ? "heroku" : "github";
      const who = kind === "github" ? "GitHub" : "Heroku";
      const tok = String(b.token || "").trim();
      if (!tok) return err(env, request, "No token given.");

      // Replacing the key on an account we already hold. The row is UPDATED, so
      // its id survives and every repo, app, link, folder and branch that points
      // at it survives with it — which is the whole point of having this button.
      const replacing = b.replace_id
        ? await q(env, `SELECT id, kind, account, note FROM connections WHERE id=?`, Number(b.replace_id)).first()
        : null;
      if (b.replace_id && !replacing) return err(env, request, "That account is not connected here any more.", 404);
      if (replacing && replacing.kind !== kind) {
        return err(env, request, `That is a ${replacing.kind === "github" ? "GitHub" : "Heroku"} account — ` +
                                 `paste a ${replacing.kind === "github" ? "GitHub" : "Heroku"} key for it.`, 400);
      }

      let account;
      try {
        account = kind === "github" ? await GH.verifyToken(tok, fetch) : await HK.verifyToken(tok, fetch);
      } catch (e) {
        const raw = String((e && e.message) || e);
        let why;
        if (isOutage(raw)) {
          // 2026-08-17: this exact path refused a GOOD key for hours because
          // verifying one calls the service that was down. Never let that read
          // as "your key is bad".
          const st = await vendorStatus(kind, fetch);
          why = `${who} is down or struggling right now, so this key could not be checked — ` +
                `nothing is wrong with the key itself and nothing here was changed. ` +
                `${statusLine(st, who)} ` +
                (replacing
                  ? `The key already on ${replacing.account} is untouched and still working. `
                  : ``) +
                `Try again in a few minutes.`;
        } else {
          why = kind === "github" ? ghMessage(e, "that account") : hkMessage(e, null);
        }
        await logFail(env, me.username, `could not connect a ${who} key`, replacing ? replacing.account : null,
          why, { ref: kind });
        return err(env, request, why, isOutage(raw) ? 503 : 400);
      }

      if (replacing) {
        // ⚠️ The trap this closes: without the check, a token belonging to a
        // DIFFERENT account inserts a second connection while the first one keeps
        // owning every app and repo — so the panel looks fixed and nothing works.
        if (String(account) !== String(replacing.account)) {
          const why = `That key belongs to ${account}, but you are replacing the key for ` +
                      `${replacing.account}. Nothing was changed. Paste a key made on ` +
                      `${replacing.account} — or connect ${account} as a new account instead, which ` +
                      `leaves ${replacing.account} alone.`;
          await logFail(env, me.username, `could not replace a ${who} key`, replacing.account, why, { ref: kind });
          return err(env, request, why, 409);
        }
        const kept = kind === "github"
          ? await q(env, `SELECT COUNT(*) AS n FROM repos WHERE connection_id=?`, replacing.id).first()
          : await q(env, `SELECT COUNT(*) AS n FROM apps  WHERE connection_id=?`, replacing.id).first();
        await q(env, `UPDATE connections SET token=? WHERE id=?`, tok, replacing.id).run();
        const n = (kept && kept.n) || 0;
        const noun = kind === "github" ? "repo" : "app";
        await logAction(env, me.username, `replaced a ${who} key`, account,
          `same account — ${n} ${noun}${n === 1 ? "" : "s"} kept, nothing re-linked`, 1, { ref: kind });
        return json(env, request, {
          account, kind, replaced: true, kept: n, kept_kind: noun,
          message: `New key saved for ${account}. Your ${n} ${noun}${n === 1 ? "" : "s"} ` +
                   `${n === 1 ? "is" : "are"} untouched — nothing needs re-linking.`,
        });
      }
      await q(env,
        `INSERT INTO connections (kind, label, token, account, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT (kind, label) DO UPDATE SET token=excluded.token, account=excluded.account`,
        kind, account, tok, account, nowIso()).run();
      await logAction(env, me.username, `connected a ${kind === "github" ? "GitHub" : "Heroku"} key`, account, null);

      // 🛑 v32 — A REPLACED KEY MUST HEAL THE PAIRING IT BELONGED TO.
      // Removing a key deletes the connection row; the pairing that used it
      // survives pointing at an id that no longer exists. Connecting a new key
      // makes a NEW row with a NEW id, so the pairing stays broken and the
      // account can list its apps but never link them to a repo. He hit this
      // three times: the panel said "connect it again", he did, and nothing
      // healed. Re-point the dead half here — but ONLY when there is exactly one
      // candidate on each side, so this can never guess wrong.
      const fresh = await q(env, `SELECT id FROM connections WHERE kind=? AND account=?`, kind, account).first();
      const col = kind === "github" ? "github_conn_id" : "heroku_conn_id";
      const other = kind === "github" ? "heroku_conn_id" : "github_conn_id";
      const orphaned = (await q(env,
        `SELECT k.id FROM combos k
          WHERE k.${col} NOT IN (SELECT id FROM connections)
            AND k.${other} IN (SELECT id FROM connections)`).all()).results || [];
      // The key just connected must not already belong to a pairing — otherwise
      // attaching it here would silently move it off the pairing it is in.
      // (An earlier version also demanded it be the ONLY unpaired key of its
      // kind; that never fires on a real panel, where several accounts sit
      // unpaired quite legitimately.)
      const freshPaired = fresh && (await q(env,
        `SELECT COUNT(*) AS n FROM combos WHERE ${col}=?`, fresh.id).first());
      if (fresh && orphaned.length === 1 && Number(freshPaired?.n || 0) === 0) {
        await q(env, `UPDATE combos SET ${col}=? WHERE id=?`, fresh.id, orphaned[0].id).run();
        await logAction(env, me.username, "repaired a pairing", account,
          "it was pointing at the key that had been removed", 1);
      } else if (orphaned.length > 1) {
        // More than one broken pairing — say so rather than pick one.
        await logPanel(env, "more than one pairing is missing a key", account,
          `${orphaned.length} pairings need a key; pair this one by hand under Accounts & keys`,
          { actor: me.username, ok: 0,
            error: "Several pairings are missing a key, so this one was not attached automatically." });
      }

      // ⚠ And PULL, so what the key can see appears without anyone knowing to
      // press Refresh. Connecting a key and seeing nothing change is the whole
      // reason this looked broken.
      const gs = (await q(env, `SELECT id FROM connections WHERE kind='github'`).all()).results || [];
      const hs = (await q(env, `SELECT id FROM connections WHERE kind='heroku'`).all()).results || [];
      let discovered = null;
      if (gs.length > 1 || hs.length > 1) {
        try { discovered = await refreshCombos(env, me.username); } catch { /* the key is stored either way */ }
      }
      if (gs.length === 1 && hs.length === 1) {
        const have = await q(env, `SELECT id FROM combos WHERE github_conn_id=? AND heroku_conn_id=?`,
          gs[0].id, hs[0].id).first();
        if (!have) {
          await q(env, `INSERT INTO combos (label, github_conn_id, heroku_conn_id, created_at) VALUES (?,?,?,?)`,
            "Default pair", gs[0].id, hs[0].id, nowIso()).run();
          await logAction(env, me.username, "paired accounts", "first GitHub + Heroku", "paired automatically");
        }
        discovered = await refreshCombos(env, me.username);
      }
      return json(env, request, { account, kind, discovered });
    }
    // A note on a key: "which client is on this one". Free text, his words.
    if (request.method === "PATCH" && seg[2]) {
      const b = await body();
      const c = await q(env, `SELECT id, kind, account FROM connections WHERE id=?`, Number(seg[2])).first();
      if (!c) return err(env, request, "That account is not connected here any more.", 404);
      if (!("note" in b)) return json(env, request, { ok: true });
      const note = cutText(b.note, 500);
      await q(env, `UPDATE connections SET note=? WHERE id=?`, note, c.id).run();
      await logAction(env, me.username, note ? "wrote a note on a key" : "cleared the note on a key",
        c.account, note ? note.slice(0, 120) : null, 1, { ref: c.kind });
      return json(env, request, { ok: true, note });
    }

    // ---- removing a key -------------------------------------------------
    // 🛑 This CASCADES: `repos.connection_id` and `apps.connection_id` are
    // ON DELETE CASCADE, so removing a key silently takes every app and repo row
    // on that account with it — their links, folders and branches included.
    // On 2026-08-17 that happened during GitHub's outage and nobody was told, and
    // the route did not even write a log line. Now it counts first, needs the
    // account name typed, and says what went.
    if (request.method === "DELETE" && seg[2]) {
      const b = await body();
      const c = await q(env, `SELECT id, kind, account FROM connections WHERE id=?`, Number(seg[2])).first();
      if (!c) return err(env, request, "That account is not connected here any more.", 404);
      const who = c.kind === "github" ? "GitHub" : "Heroku";
      const repos = (await q(env, `SELECT COUNT(*) AS n FROM repos WHERE connection_id=?`, c.id).first())?.n || 0;
      const apps = (await q(env, `SELECT COUNT(*) AS n FROM apps WHERE connection_id=?`, c.id).first())?.n || 0;
      const cost = [apps ? `${apps} app${apps === 1 ? "" : "s"}` : null,
                    repos ? `${repos} repo${repos === 1 ? "" : "s"}` : null].filter(Boolean).join(" and ");

      if (String(b.confirm || "") !== String(c.account)) {
        const why = cost
          ? `Removing the ${who} key for ${c.account} also removes ${cost} from this panel, with their ` +
            `links, folders and branches — nothing is deleted at ${who} itself, but you would have to ` +
            `link them again. If a key stopped working, use "Replace key" instead: it keeps all of that. ` +
            `To remove it anyway, type the account name exactly: ${c.account}. Nothing was removed.`
          : `To remove the ${who} key for ${c.account}, type the account name exactly: ${c.account}. ` +
            `Nothing was removed.`;
        await logFail(env, me.username, `refused to remove a ${who} key`, c.account, why, { ref: c.kind });
        return json(env, request, { error: why, account: c.account, apps, repos, needs_confirm: true }, 409);
      }

      await q(env, `DELETE FROM connections WHERE id=?`, c.id).run();
      // Belt and braces: if this D1 ever runs without foreign keys enforced, the
      // rows would be left pointing at an account that no longer exists.
      await q(env, `DELETE FROM repos WHERE connection_id=?`, c.id).run();
      await q(env, `DELETE FROM apps  WHERE connection_id=?`, c.id).run();
      await logAction(env, me.username, `removed a ${who} key`, c.account,
        cost ? `${cost} removed from the panel with it — nothing deleted at ${who}`
             : `nothing else was using it`, 1, { ref: c.kind });
      return json(env, request, { ok: true, account: c.account, apps, repos });
    }
  }

  // ---- is the problem us, or is GitHub/Heroku down right now? -------------
  // Reads the vendors' own public status pages. No key, no account, and it never
  // fails loudly: an unreachable status page is reported as "could not ask".
  if (route === "status") {
    const [gh, hk] = await Promise.all([vendorStatus("github", fetch), vendorStatus("heroku", fetch)]);
    // `unknown` is never counted as down — and never as fine either.
    const down = (x) => !!(x && !x.unknown && x.ok === false);
    return json(env, request, {
      github: gh || { who: "GitHub", unknown: true, why: "no answer" },
      heroku: hk || { who: "Heroku", unknown: true, why: "no answer" },
      any_down: down(gh) || down(hk),
    });
  }

  // ---- discovery ----------------------------------------------------------
  if (route === "discover" && seg[2]) {
    const kind = seg[2] === "apps" ? "heroku" : "github";
    const conns = (await q(env, `SELECT id, token, account FROM connections WHERE kind=?`, kind).all()).results || [];
    const out = [];
    for (const c of conns) {
      try {
        if (kind === "github") {
          const taken = new Set(((await q(env, `SELECT owner, name FROM repos`).all()).results || [])
            .map((r) => `${r.owner}/${r.name}`));
          for (const r of await GH.listRepos(c.token, fetch)) {
            if (!taken.has(r.full_name)) out.push({ conn_id: c.id, account: c.account, ...r });
          }
        } else {
          const taken = new Set(((await q(env, `SELECT heroku_name FROM apps WHERE connection_id=?`, c.id).all()).results || [])
            .map((a) => a.heroku_name));
          for (const a of await HK.listApps(c.token, fetch)) {
            if (!taken.has(a.name)) out.push({ conn_id: c.id, account: c.account, ...a });
          }
        }
      } catch (e) {
        out.push({ conn_id: c.id, account: c.account,
                   error: kind === "github" ? ghMessage(e, "that account") : hkMessage(e, c.account) });
      }
    }
    // The UI reads d.repos / d.apps; keep `items` too so either shape works.
    const shaped = out.map((o) => (o.name && !o.repo ? { ...o, repo: o.name } : o));
    return json(env, request, { items: shaped, repos: shaped, apps: shaped });
  }

  // ---- one name, one click: repo + app + link + ready to publish ----
  //
  // Making a site by hand is four jobs across two screens, and both halves have
  // to agree on one name. This does all four in order and reports EVERY step,
  // because the interesting outcomes here are the partial ones.
  //
  // ⚠️ A Heroku app name is unique across every Heroku user on earth, not just
  // this account, so an ordinary word is very often already taken by a stranger
  // — and that refusal arrives AFTER the repo exists. The reply therefore
  // carries the half-state by name, plus `use_repo_id` so the same route can
  // finish the job without making a second repo.
  if (route === "site" && seg[2] === "new" && request.method === "POST") {
    const b = await body();
    const name = String(b.name || "").trim().toLowerCase();
    const steps = [];
    const addStep = (key, label, ok, detail, error) =>
      steps.push({ key, label, ok, detail: detail || null, error: error || null });

    const bad = siteNameProblem(name);
    if (bad) return err(env, request, bad, 400);

    const hc = await soleConn(env, "heroku", b.heroku_conn_id);
    if (!hc) {
      const n = ((await q(env, `SELECT id FROM connections WHERE kind='heroku'`).all()).results || []).length;
      return err(env, request, n
        ? "Say which Heroku account the new site should live in."
        : "Connect a Heroku account first, under Accounts & keys.");
    }

    // Resuming a half-made site: the repo already exists, so it is used
    // as it is and GitHub is not touched again.
    let repoRow = null, repoFull = "", gc = null;
    if (b.use_repo_id) {
      repoRow = await q(env,
        `SELECT r.id, r.owner, r.name, r.branch, c.account, c.token AS gh_token
         FROM repos r LEFT JOIN connections c ON c.id = r.connection_id WHERE r.id=?`,
        Number(b.use_repo_id)).first();
      if (!repoRow) return err(env, request, "That repo is no longer in the list — start the site again.", 404);
      repoFull = `${repoRow.owner}/${repoRow.name}`;
      addStep("repo", "Repo", true, `${repoFull} — already made, kept as it is`);
    } else {
      gc = await soleConn(env, "github", b.github_conn_id);
      if (!gc) {
        const n = ((await q(env, `SELECT id FROM connections WHERE kind='github'`).all()).results || []).length;
        return err(env, request, n
          ? "Say which GitHub account the new repo should live in."
          : "Connect a GitHub account first, under Accounts & keys.");
      }
      const clashRepo = await q(env,
        `SELECT owner, name FROM repos WHERE connection_id=? AND lower(name)=?`, gc.id, name).first();
      if (clashRepo) {
        return err(env, request,
          `This panel already has a repo called ${clashRepo.owner}/${clashRepo.name}. ` +
          `Pick another name. Nothing was created.`, 409);
      }
    }
    const clashApp = await q(env,
      `SELECT heroku_name FROM apps WHERE connection_id=? AND lower(heroku_name)=?`, hc.id, name).first();
    if (clashApp) {
      return err(env, request,
        `This panel already has an app called ${clashApp.heroku_name} on ${hc.account || "that Heroku account"}. ` +
        `Pick another name. Nothing was created.`, 409);
    }

    // ---- 1. the repo -------------------------------------------------
    if (!repoRow) {
      let made;
      try {
        made = await GH.createRepo(gc.token, name, true, fetch);
      } catch (e) {
        const why = ghCreateMessage(e, name, gc.account);
        addStep("repo", "Repo", false, null, why);
        await logFail(env, me.username, "could not make a new site", name, why);
        return json(env, request, { ok: false, error: why, steps, made_nothing: true }, 502);
      }
      repoFull = made.full_name;
      try {
        const ins = await q(env,
          `INSERT INTO repos (label, owner, name, branch, connection_id, created_at, url, dir)
           VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
          repoFull, made.owner, made.repo, made.branch || "main", gc.id, nowIso(), "", "").first();
        repoRow = { id: ins.id, owner: made.owner, name: made.repo,
                    branch: made.branch || "main", account: gc.account, gh_token: gc.token };
      } catch (e) {
        // The real repo EXISTS now; only our row failed. Saying "could not
        // create it" here would be a lie that leaves an untracked repo.
        const why = `${repoFull} was created on GitHub, but this panel could not add it to its own list ` +
                    `(${String(e.message || e)}). It is safe on GitHub — add it here with "Refresh from Heroku", ` +
                    `or delete it on GitHub if you do not want it. No Heroku app was created.`;
        addStep("repo", "Repo", false, null, why);
        await logFail(env, me.username, "could not make a new site", name, why, { ref: repoFull });
        return json(env, request, { ok: false, error: why, steps, orphan_repo: repoFull }, 502);
      }
      addStep("repo", "Repo", true, `${repoFull} — private`);
      await logAction(env, me.username, "created a repo", repoFull,
        `on ${gc.account || "GitHub"} — for the new site ${name}`, 1, { ref: repoFull });
    }

    // ---- 2. the Heroku app -------------------------------------------------
    let app;
    try {
      app = await HK.createApp(hc.token, name, b.region || undefined, fetch);
    } catch (e) {
      const raw = String((e && e.message) || e);
      const taken = /already taken/i.test(raw);
      const why = taken
        ? `Heroku already has an app called ${name}, and app names are shared with every Heroku user in the ` +
          `world — so ordinary names are often taken by a stranger's app. ${repoFull} WAS created and is ` +
          `still there; nothing was deleted. Finish this site with another name, or undo it.`
        : `${hkMessage(e, hc.account)} ${repoFull} WAS created and is still there; nothing was deleted.`;
      addStep("app", "Heroku app", false, null, why);
      await logFail(env, me.username, "could not make a new site", name, why, { ref: repoFull });
      return json(env, request, {
        ok: false, error: why, steps,
        partial: { stage: "app", repo_id: String(repoRow.id), repo: repoFull, name },
        suggestion: taken ? suggestSiteName(name) : null,
      }, taken ? 409 : 502);
    }

    let appId;
    try {
      const insA = await q(env,
        `INSERT INTO apps (label, heroku_name, connection_id, repo_id, web_url, created_at)
         VALUES (?,?,?,?,?,?) RETURNING id`,
        app.name, app.name, hc.id, repoRow.id, app.web_url || null, nowIso()).first();
      appId = insA.id;
    } catch (e) {
      const why = `The app ${app.name} WAS created on Heroku (${hc.account || "your account"}) and the repo ` +
                  `${repoFull} WAS created on GitHub, but this panel could not add the app to its own list ` +
                  `(${String(e.message || e)}). Both real things exist — press "Refresh from Heroku" to pull ` +
                  `the app in, then link it to ${repoFull}.`;
      addStep("app", "Heroku app", false, null, why);
      await logFail(env, me.username, "could not make a new site", name, why, { ref: repoFull });
      return json(env, request, { ok: false, error: why, steps, orphan_app: app.name, orphan_repo: repoFull }, 502);
    }
    addStep("app", "Heroku app", true, `${app.name} on ${hc.account || "Heroku"}`);
    await logAction(env, me.username, "created a Heroku app", app.name,
      `on ${hc.account || "Heroku"} — for the new site ${name}`, 1, { ref: app.name });

    // ---- 3. linked (they were joined at creation, so this cannot fail) ------
    addStep("link", "Linked together", true, `${app.name} takes its files from ${repoFull}`);
    await logAction(env, me.username, "linked an app", app.name, `to ${repoFull}`, 1, { ref: app.name });

    // ---- 4. ready to publish ----------------------------------------------
    // A repo of plain .html files matches no buildpack, so the FIRST
    // deploy of a brand-new static site fails with "No default language could
    // be detected" unless index.php is there. Default ON for exactly that.
    // ⚠️ OPT-IN, never assumed. This used to default to ON, so making a site
    // wrote two files into a brand-new repo without being asked — his repo, his
    // call. Nothing is written unless the box was ticked.
    if (b.deployable !== true) {
      addStep("ready", "Ready to publish", null, "not asked for — no files were added to the repo");
    } else {
      try {
        await GH.commitChanges(repoRow.gh_token, {
          owner: repoRow.owner, repo: repoRow.name, branch: repoRow.branch || "main",
          message: `Add a holding page and index.php so Heroku can build this site (panel, ${me.username})`,
          files: [
            { path: "index.html", contentB64: toBase64(new TextEncoder().encode(holdingPage(name))) },
            { path: "index.php", contentB64: toBase64(new TextEncoder().encode('<?php include_once("index.html"); ?>')) },
          ],
        }, fetch);
        addStep("ready", "Ready to publish", true, "index.php and a holding page added — Heroku builds it as PHP");
        await logAction(env, me.username, "made a site deployable", app.name,
          "added index.php and a holding page", 1, { ref: repoFull });
        await recordBuildpack(env, appId, repoRow, me.username);
      } catch (e) {
        const why = `${ghMessage(e, repoFull)} The site itself is made and linked — only the file that makes ` +
                    `Heroku able to build it is missing. Use "Make it deployable" on the app, or send your ` +
                    `own files, before the first deploy.`;
        addStep("ready", "Ready to publish", false, null, why);
        await logFail(env, me.username, "could not make the new site deployable", app.name, why, { ref: repoFull });
      }
    }

    const readyStep = steps.find((s) => s.key === "ready");
    await logAction(env, me.username, "made a new site", name,
      `${repoFull} + ${app.name} on ${hc.account || "Heroku"}` +
      (readyStep && readyStep.ok ? " — ready to publish" : ""), 1, { ref: app.name });

    return json(env, request, {
      ok: true, name, steps,
      repo: { id: String(repoRow.id), full_name: repoFull, owner: repoRow.owner,
              name: repoRow.name, branch: repoRow.branch || "main", account: repoRow.account || "" },
      app: { id: String(appId), name: app.name, web_url: app.web_url || "", account: hc.account || "" },
      site: await appState(env, appId),
    });
  }

  // ---- delete a whole site: the Heroku app AND the repo behind it ----
  //
  // The single heaviest thing in the panel, and the only one with no undo of
  // any kind: it ends a client's website and every version of its files at
  // once. Owner-only, the exact app name has to be typed, and `destroy:true`
  // has to be asked for deliberately. Heroku goes FIRST on purpose — if GitHub
  // then refuses, what is left is an unused private repo (harmless),
  // where the other order would leave a live site nobody can update.
  if (route === "site" && seg[2] === "pair" && seg[3] && request.method === "DELETE") {
    if (!master) {
      return err(env, request,
        "Only the owner can delete a whole site. Everything else in this panel is open to you.", 403);
    }
    const b = await body();
    const app = await q(env,
      `SELECT a.id, a.heroku_name, a.repo_id, c.account AS hk_account, c.token AS hk_token
       FROM apps a LEFT JOIN connections c ON c.id = a.connection_id WHERE a.id=?`, Number(seg[3])).first();
    if (!app) return err(env, request, "That app is not in the list.", 404);
    if (!app.repo_id) {
      return err(env, request,
        `${app.heroku_name} has no repo linked, so there is no pair to delete. ` +
        `Use "Delete on Heroku" on its row to delete just the app.`, 409);
    }
    const repo = await q(env,
      `SELECT r.id, r.owner, r.name, c.account AS gh_account, c.token AS gh_token
       FROM repos r LEFT JOIN connections c ON c.id = r.connection_id WHERE r.id=?`, app.repo_id).first();
    if (!repo) return err(env, request, "That repo is not in the list any more.", 404);
    const full = `${repo.owner}/${repo.name}`;
    const both = `${app.heroku_name} + ${full}`;

    if (b.destroy !== true) {
      return err(env, request,
        "Deleting a whole site has to be asked for deliberately. Nothing was deleted.", 400);
    }
    if (String(b.confirm || "") !== String(app.heroku_name)) {
      const why = `The name you typed does not match. To delete this whole site — the app and its files — ` +
                  `type the app's exact name: ${app.heroku_name}. Nothing was deleted.`;
      await logFail(env, me.username, "refused to delete a whole site", both, why);
      return err(env, request, why, 400);
    }
    // Both halves need a working key BEFORE anything is destroyed, or the
    // design itself guarantees a half-deleted site.
    const missing = [];
    if (!app.hk_token) missing.push(`the Heroku account holding ${app.heroku_name}`);
    if (!repo.gh_token) missing.push(`the GitHub account holding ${full}`);
    if (missing.length) {
      const why = `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not connected here, so the ` +
                  `panel cannot delete the whole site. Nothing was deleted.`;
      await logFail(env, me.username, "could not delete a whole site", both, why);
      return err(env, request, why, 409);
    }

    try {
      await HK.deleteApp(app.hk_token, app.heroku_name, fetch);
    } catch (e) {
      const why = `${hkMessage(e, app.hk_account)} Nothing was deleted — ${full} is untouched.`;
      await logFail(env, me.username, "could not delete a whole site", both, why);
      return err(env, request, why, 502);
    }
    await q(env, `DELETE FROM apps WHERE id=?`, app.id).run();

    let repoGone = true, repoWhy = null;
    try {
      await GH.deleteRepo(repo.gh_token, repo.owner, repo.name, fetch);
    } catch (e) {
      repoGone = false;
      repoWhy = ghDeleteMessage(e, full);
    }
    if (repoGone) {
      await q(env, `UPDATE apps SET repo_id=NULL, buildpack=NULL WHERE repo_id=?`, repo.id).run();
      await q(env, `DELETE FROM repos WHERE id=?`, repo.id).run();
      await logAction(env, me.username, "deleted a whole site", both,
        `app ${app.heroku_name} on ${app.hk_account || "Heroku"} and repo ${full} on ` +
        `${repo.gh_account || "GitHub"} — permanent; every file and all history are gone`);
      return json(env, request, {
        ok: true,
        destroyed: { app: app.heroku_name, repo: full },
        accounts: { heroku: app.hk_account || "", github: repo.gh_account || "" },
      });
    }
    // Half done, and that half-state is REAL — reporting it as a plain failure
    // would leave him believing the app is still up.
    const why = `The app ${app.heroku_name} is deleted on Heroku (${app.hk_account || "Heroku"}) and cannot come ` +
                `back. The repo ${full} is STILL THERE on ${repo.gh_account || "GitHub"} — it was not ` +
                `deleted. ${repoWhy}`;
    await logAction(env, me.username, "deleted a whole site", both,
      `app ${app.heroku_name} deleted; repo ${full} NOT deleted`, 0, { error: why });
    return json(env, request, {
      ok: false, half: true, error: why,
      destroyed: { app: app.heroku_name }, kept: { repo: full, repo_id: String(repo.id) },
    }, 502);
  }

  // ---- sites --------------------------------------------------------------
  if (route === "site") {
    if (request.method === "POST") {
      const b = await body();
      if (!b.owner || !b.repo) return err(env, request, "Pick a repo.");
      const conn = await soleConn(env, "github", b.conn_id);
      if (!conn) return err(env, request, "Say which GitHub account this repo belongs to.");
      const label = String(b.label || b.url || b.repo).trim();
      try {
        const r = await q(env,
          `INSERT INTO repos (label, owner, name, branch, connection_id, created_at, url, dir)
           VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
          label, b.owner, b.repo, b.branch || "main", conn.id, nowIso(),
          String(b.url || ""), String(b.dir || "").replace(/^\/+|\/+$/g, "")).first();
        return json(env, request, { id: r.id });
      } catch (e) {
        return err(env, request, /UNIQUE/i.test(String(e)) ? "That site is already on the list." : String(e.message || e));
      }
    }
    if (request.method === "PATCH" && seg[2]) {
      const b = await body();
      const sets = [], vals = [];
      for (const k of ["label", "url", "dir", "branch"]) {
        if (k in b) {
          sets.push(`${k}=?`);
          vals.push(k === "dir" ? String(b[k] || "").replace(/^\/+|\/+$/g, "") : String(b[k] || ""));
        }
      }
      if (!sets.length) return json(env, request, { ok: true });
      await q(env, `UPDATE repos SET ${sets.join(", ")} WHERE id=?`, ...vals, Number(seg[2])).run();
      return json(env, request, { ok: true });
    }
    if (request.method === "DELETE" && seg[2]) {
      // A non-numeric id here is a mistyped route (/api/site/pair with no app
      // id, say). Deleting on Number("pair") would touch nothing and answer
      // "ok", which reads as "it worked" — the worst possible reply.
      const sid = Number(seg[2]);
      if (!Number.isFinite(sid)) return err(env, request, "That is not a repo id.", 400);
      await q(env, `UPDATE apps SET repo_id=NULL WHERE repo_id=?`, sid).run();
      await q(env, `DELETE FROM repos WHERE id=?`, sid).run();
      return json(env, request, { ok: true });
    }
  }

  // ---- create / link ------------------------------------------------------
  if (route === "repo" && seg[2] === "create" && request.method === "POST") {
    const b = await body();
    const c = await soleConn(env, "github", b.conn_id);
    if (!c) {
      const n = ((await q(env, `SELECT id FROM connections WHERE kind='github'`).all()).results || []).length;
      return err(env, request, n
        ? "Choose which GitHub account to create it in."
        : "Connect a GitHub account first.");
    }
    try {
      const r = await GH.createRepo(c.token, String(b.name || "").trim(), b.private !== false, fetch);
      await logAction(env, me.username, "created a repo", r.full_name, `on ${c.account}`);
      return json(env, request, { ...r, account: c.account, private: b.private !== false });
    } catch (e) {
      const why = isOutage(String(e.message || e))
        ? ghMessage(e, "that account")
        : ghCreateMessage(e, String(b.name || "").trim(), c.account);
      await logFail(env, me.username, "could not create a repo", String(b.name || "").trim(), why);
      return err(env, request, why);
    }
  }

  // ---- delete a repo: forget it here, or destroy it on GitHub -------
  // Destroying a repo erases every file and the whole history, and
  // GitHub cannot restore it for us. So the destructive form demands
  // {confirm:"owner/name"} typed exactly, refuses while an app still deploys
  // from it (naming the apps) unless {even_though_linked:true} answers that
  // second question deliberately, and needs administration=write on the token.
  if (route === "repo" && seg[2] && seg[2] !== "create" && request.method === "DELETE") {
    const b = await body();
    const repo = await q(env,
      `SELECT r.id, r.owner, r.name, c.account, c.token AS gh_token
       FROM repos r LEFT JOIN connections c ON c.id = r.connection_id WHERE r.id=?`, Number(seg[2])).first();
    if (!repo) return err(env, request, "That repo is not in the list.", 404);
    const full = `${repo.owner}/${repo.name}`;
    const linked = (await q(env, `SELECT heroku_name FROM apps WHERE repo_id=?`, repo.id).all()).results || [];
    const linkedNames = linked.map((a) => a.heroku_name);

    if (b.destroy === true) {
      if (String(b.confirm || "") !== full) {
        const why = `The name you typed does not match. To delete this repo for good, ` +
                    `type it exactly as owner/name: ${full}. Nothing was deleted.`;
        await logFail(env, me.username, "refused to delete a repo", full, why);
        return err(env, request, why, 400);
      }
      if (linkedNames.length && b.even_though_linked !== true) {
        const why = (linkedNames.length === 1
          ? `The app ${linkedNames[0]} still deploys from ${full}. `
          : `${linkedNames.length} apps still deploy from ${full}: ${linkedNames.join(", ")}. `) +
          `Deleting it would pull the files out from under ${linkedNames.length === 1 ? "a live app" : "live apps"}. ` +
          `Unlink ${linkedNames.length === 1 ? "it" : "them"} first — or answer the extra question to delete it anyway. Nothing was deleted.`;
        await logFail(env, me.username, "refused to delete a repo", full, why);
        return json(env, request, { error: why, linked_apps: linkedNames }, 409);
      }
      if (!repo.gh_token) {
        const why = `The GitHub account holding ${full} is not connected here, so the panel cannot delete it. Nothing was deleted.`;
        await logFail(env, me.username, "could not delete a repo", full, why);
        return err(env, request, why, 409);
      }
      try {
        await GH.deleteRepo(repo.gh_token, repo.owner, repo.name, fetch);
      } catch (e) {
        const why = ghDeleteMessage(e, full);
        await logFail(env, me.username, "could not delete a repo", full, why);
        return err(env, request, why, 502);
      }
      // The real thing is gone; now the local row, and every app that pointed
      // at it ends up cleanly unlinked so the re-pair dropdown appears at once.
      await q(env, `UPDATE apps SET repo_id=NULL, buildpack=NULL WHERE repo_id=?`, repo.id).run();
      await q(env, `DELETE FROM repos WHERE id=?`, repo.id).run();
      await logAction(env, me.username, "deleted a repo", full,
        `on ${repo.account || "GitHub"} — permanent; every file and all history are gone` +
        (linkedNames.length ? `; ${linkedNames.length} app(s) unlinked: ${linkedNames.join(", ")}` : ""));
      return json(env, request, { ok: true, destroyed: full, account: repo.account || "", unlinked: linkedNames });
    }

    // Local only: same effect as DELETE /api/site/{id} — GitHub is untouched.
    await q(env, `UPDATE apps SET repo_id=NULL, buildpack=NULL WHERE repo_id=?`, repo.id).run();
    await q(env, `DELETE FROM repos WHERE id=?`, repo.id).run();
    await logAction(env, me.username, "stopped managing a repo", full,
      "removed from this panel only — the repo itself still exists on GitHub" +
      (linkedNames.length ? `; ${linkedNames.length} app(s) unlinked: ${linkedNames.join(", ")}` : ""));
    return json(env, request, { ok: true, destroyed: null, removed: full, unlinked: linkedNames });
  }

  if (route === "app" && seg[2] === "create" && request.method === "POST") {
    const b = await body();
    const c = await soleConn(env, "heroku", b.conn_id);
    if (!c) {
      const n = ((await q(env, `SELECT id FROM connections WHERE kind='heroku'`).all()).results || []).length;
      return err(env, request, n
        ? "Choose which Heroku account to create it in."
        : "Connect a Heroku account first.");
    }
    try {
      const a = await HK.createApp(c.token, String(b.name || "").trim() || undefined, b.region || undefined, fetch);
      await logAction(env, me.username, "created a Heroku app", a.name, `on ${c.account}`);
      return json(env, request, { ...a, account: c.account });
    } catch (e) {
      const why = hkMessage(e, c.account);
      await logFail(env, me.username, "could not create a Heroku app", String(b.name || "").trim(), why);
      return err(env, request, why);
    }
  }

  // ---- undo a pairing: "if by mistake we bind wrong app to wrong repo" ------
  // Breaks the association ONLY. The repo and the Heroku app are both
  // left exactly as they are; nothing is deleted anywhere.
  if (route === "unlink" && request.method === "POST") {
    const b = await body();
    const app = await q(env, `SELECT id, heroku_name, repo_id FROM apps WHERE id=?`, Number(b.app_id)).first();
    if (!app) return err(env, request, "That app is not in the list.");
    if (!app.repo_id) {
      // Not an error worth a red screen: the outcome he wanted is already true.
      return json(env, request, { ok: true, already: true, app: await appState(env, app.id) });
    }
    const was = await q(env, `SELECT owner, name FROM repos WHERE id=?`, app.repo_id).first();
    const wasName = was ? `${was.owner}/${was.name}` : `repo #${app.repo_id}`;
    // The cached buildpack described the OLD repo. Leaving it would make
    // the deploy screen judge this app by a repo it no longer points at.
    await q(env, `UPDATE apps SET repo_id=NULL, buildpack=NULL WHERE id=?`, app.id).run();
    await logAction(env, me.username, "unlinked an app", app.heroku_name, `was ${wasName}`,
      1, { ref: app.heroku_name });
    return json(env, request, { ok: true, was: wasName, app: await appState(env, app.id) });
  }

  if (route === "link" && request.method === "POST") {
    const b = await body();
    // New shape: link a Heroku APP to the repo it deploys from.
    if (b.app_id !== undefined) {
      const app = await q(env, `SELECT id, heroku_name, repo_id FROM apps WHERE id=?`, Number(b.app_id)).first();
      if (!app) return err(env, request, "That app is not in the list.");
      const repoId = b.repo_id ? Number(b.repo_id) : null;
      // What it pointed at before, so a re-link can say what it replaced.
      const prev = app.repo_id
        ? await q(env, `SELECT owner, name FROM repos WHERE id=?`, app.repo_id).first()
        : null;
      const prevName = prev ? `${prev.owner}/${prev.name}` : null;
      if (repoId) {
        const r = await q(env, `SELECT id, owner, name FROM repos WHERE id=?`, repoId).first();
        if (!r) {
          await logFail(env, me.username, "could not link an app", app.heroku_name,
            "That repo is not in the list. Press \"Refresh from Heroku\" and try again.",
            { ref: app.heroku_name });
          return err(env, request, "That repo is not in the list.");
        }
        const newName = `${r.owner}/${r.name}`;
        // Re-linking is allowed — a wrong pairing has to be fixable in place —
        // and the log has to say what it displaced or the old link is lost.
        const replaced = app.repo_id && app.repo_id !== repoId;
        await q(env, `UPDATE apps SET repo_id=? WHERE id=?`, repoId, app.id).run();
        const linkedRepo = await siteRow(env, repoId);
        if (linkedRepo) await recordBuildpack(env, app.id, linkedRepo, me.username);
        await logAction(env, me.username, replaced ? "re-linked an app" : "linked an app",
          app.heroku_name, replaced ? `was ${prevName} -> ${newName}` : `to ${newName}`,
          1, { ref: app.heroku_name });
        return json(env, request, { ok: true, replaced: replaced ? prevName : null, app: await appState(env, app.id) });
      }
      // repo_id: null through /api/link still unlinks — the panel has always
      // called it that way, so it keeps working and now logs the same detail.
      await q(env, `UPDATE apps SET repo_id=NULL, buildpack=NULL WHERE id=?`, app.id).run();
      await logAction(env, me.username, "unlinked an app", app.heroku_name,
        prevName ? `was ${prevName}` : null, 1, { ref: app.heroku_name });
      return json(env, request, { ok: true, was: prevName, app: await appState(env, app.id) });
    }

    // Older shape kept working: link by repo id + heroku app name.
    const siteId = Number(b.site_id);
    const herokuName = b.heroku_name || b.app || null;
    if (!herokuName) {
      const was = await q(env, `SELECT owner, name FROM repos WHERE id=?`, siteId).first();
      const freed = (await q(env, `SELECT heroku_name FROM apps WHERE repo_id=?`, siteId).all()).results || [];
      await q(env, `UPDATE apps SET repo_id=NULL, buildpack=NULL WHERE repo_id=?`, siteId).run();
      for (const a of freed) {
        await logAction(env, me.username, "unlinked an app", a.heroku_name,
          was ? `was ${was.owner}/${was.name}` : null, 1, { ref: a.heroku_name });
      }
      return json(env, request, { ok: true, linked: null });
    }
    const conn = await soleConn(env, "heroku", b.app_conn_id);
    if (!conn) return err(env, request, "Connect a Heroku account first.");
    let web = b.web_url || null;
    if (!web) {
      try { web = (await HK.listApps(conn.token, fetch)).find((a) => a.name === herokuName)?.web_url || null; }
      catch { /* not fatal */ }
    }
    await q(env, `UPDATE apps SET repo_id=NULL WHERE repo_id=?`, siteId).run();
    await q(env,
      `INSERT INTO apps (label, heroku_name, connection_id, repo_id, web_url, created_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT (connection_id, heroku_name) DO UPDATE SET repo_id=excluded.repo_id, web_url=excluded.web_url`,
      String(herokuName), String(herokuName), conn.id, siteId, web, nowIso()).run();
    await logAction(env, me.username, "linked an app", herokuName, `site #${siteId}`);
    return json(env, request, { ok: true, linked: herokuName });
  }

  // ---- files inside an app's repo -----------------------------------
  // Everything here works on the APP id, because that is what the panel shows.
  if (route === "files") {
    const appId = Number(seg[2] || (await body()).app_id || url.searchParams.get("app"));
    const app = await q(env,
      `SELECT a.id, a.heroku_name, a.repo_id FROM apps a WHERE a.id=?`, appId).first();
    if (!app) return err(env, request, "That app is not in the list.");
    if (!app.repo_id) return err(env, request, "Link a repo to this app first.");
    const repo = await siteRow(env, app.repo_id);

    // GET  /api/files/{appId}            -> whole tree + which buildpack Heroku will find
    if (request.method === "GET") {
      let t;
      // Every GitHub failure here becomes a sentence about GitHub, not a raw
      // "(HTTP 404)" that reads like the repo or the key is broken.
      try {
        t = await GH.treeOf(repo.gh_token, repo.owner, repo.name, repo.branch, fetch);
      } catch (e) {
        return err(env, request, ghMessage(e, repo), isOutage(String(e.message || e)) ? 503 : 502);
      }
      const paths = t.entries.filter((e) => e.type === "blob").map((e) => e.path);
      // One extra D1 read, no extra vendor call. Paths we have never written
      // are simply absent — the screen shows nothing rather than a borrowed date.
      let times = {};
      try { times = await fileTimesForRepo(env, app.repo_id); } catch { times = {}; }
      return json(env, request, {
        app: app.heroku_name,
        repo: `${repo.owner}/${repo.name}`,
        branch: repo.branch,
        truncated: t.truncated,
        entries: t.entries,
        buildpack: GH.buildpackFor(paths),
        file_times: times,
        repo_commit_at: t.commitAt || null,
      });
    }

    // POST /api/files/{appId}
    //   {message, files:[{path,contentB64}], remove:[path|folder],
    //    rename:[{from,to}], overwrite:bool}
    // Everything in one request lands in ONE commit and starts ONE build. A
    // rename must never become a delete plus an add, because half of that pair
    // can succeed on its own and leave the repo missing a file.
    if (request.method === "POST") {
      const b = await body();
      const files = Array.isArray(b.files) ? b.files : [];
      let remove = Array.isArray(b.remove) ? b.remove : [];
      const renames = Array.isArray(b.rename) ? b.rename : [];
      const overwrite = b.overwrite === true;

      for (const fl of files) {
        const clean = String(fl.path || "").replace(/^\/+/, "");
        if (!clean || clean.split("/").some((x) => x === ".." || x === "")) {
          return err(env, request, `Invalid path: ${fl.path}`);
        }
        fl.path = clean;
      }

      // The tree is needed to expand a folder — for a delete AND for a rename,
      // because a folder is not a thing in git: it is the paths beneath it.
      let tree = null, blobs = [], byPath = new Map();
      if (remove.length || renames.length) {
        tree = await GH.treeOf(repo.gh_token, repo.owner, repo.name, repo.branch, fetch);
        for (const e of tree.entries) if (e.type === "blob") byPath.set(e.path, e);
        blobs = [...byPath.keys()];
      }

      if (remove.length) {
        const expanded = new Set();
        for (const raw of remove) {
          const path = String(raw).replace(/^\/+|\/+$/g, "");
          if (!path) continue;
          if (byPath.has(path)) expanded.add(path);
          for (const bp of blobs) if (bp.startsWith(path + "/")) expanded.add(bp);
        }
        remove = [...expanded];
        if (!remove.length && !files.length && !renames.length) {
          return err(env, request, "Nothing there to remove.");
        }
      }

      // ---- renames: files and whole folders, expanded server-side ----------
      const moved = [];                       // {path, sha, mode} at the NEW path
      const movedFrom = new Set();            // old paths, to be dropped
      const claimed = new Set(files.map((f) => f.path)); // paths this request writes
      const cleanPath = (v) => String(v == null ? "" : v).replace(/^\/+|\/+$/g, "");
      const pairs = [];
      for (const raw of renames) {
        const from = cleanPath(raw && raw.from), to = cleanPath(raw && raw.to);
        if (!from || !to) return err(env, request, "A rename needs both the old name and the new one.");
        for (const [which, p] of [["old", from], ["new", to]]) {
          if (p.split("/").some((seg) => seg === ".." || seg === "" || seg === ".")) {
            return err(env, request, `Invalid ${which} path: ${p}`);
          }
          if (p.length > 400) return err(env, request, `That path is too long: ${p}`);
        }
        if (from === to) continue;            // nothing to do, and not an error
        // Moving a folder inside itself would expand forever.
        if (to.startsWith(from + "/")) {
          return err(env, request, `Cannot move ${from} into itself (${to}).`);
        }
        pairs.push({ from, to });
      }

      for (const { from, to } of pairs) {
        const single = byPath.get(from);
        const beneath = blobs.filter((p) => p.startsWith(from + "/"));
        if (!single && !beneath.length) {
          return err(env, request, `There is nothing called ${from} in this repo to rename.`);
        }
        // Git cannot hold a file and a folder at the same path, and the clash
        // check below only sees blobs — so a name that is occupied by the OTHER
        // kind has to be caught here or GitHub answers with a bare 422.
        if (single && blobs.some((p) => p.startsWith(to + "/"))) {
          return err(env, request,
            `${to} is a folder in this repo, so a file cannot take that name. ` +
            `Pick another name, or move it to ${to}/${to.split("/").pop()}.`, 409);
        }
        if (!single && byPath.has(to)) {
          return err(env, request,
            `${to} is a file in this repo, so a folder cannot take that name. ` +
            `Rename or delete that file first.`, 409);
        }
        // A file rename moves one blob; a folder rename moves every blob under
        // it, keeping the shape below the folder exactly as it was.
        const moves = single
          ? [[from, to]]
          : beneath.map((p) => [p, to + p.slice(from.length)]);
        for (const [src, dst] of moves) {
          const existing = byPath.get(dst);
          const clash = (existing && !movedFrom.has(dst) && !remove.includes(dst)) || claimed.has(dst);
          if (clash && !overwrite) {
            // Written for the person reading it, not for whoever calls the API.
            // "Send overwrite:true" is an instruction a VA cannot act on; the
            // panel turns this 409 into its own Replace / Cancel prompt.
            return err(env, request,
              `There is already something called ${dst} here. Renaming onto it would ` +
              `replace it. Choose a different name, or confirm the replacement.`, 409);
          }
          const e = byPath.get(src);
          moved.push({ path: dst, sha: e.sha, mode: e.mode || "100644" });
          movedFrom.add(src);
          claimed.add(dst);
        }
      }

      // Anything a move or an upload is about to write must NOT also be deleted
      // in the same tree — that is what makes swapping two names work.
      const written = new Set([...moved.map((m) => m.path), ...files.map((f) => f.path)]);
      const removeFinal = [...new Set([...remove, ...movedFrom])].filter((p) => !written.has(p));

      // Say so here rather than letting GitHub's "Nothing to commit." surface
      // as a 409, which reads like a conflict with somebody else's change.
      if (!files.length && !removeFinal.length && !moved.length) {
        return err(env, request, "There is nothing to change in that request.");
      }

      const total = files.reduce((n, fl) => n + (fl.contentB64 || "").length, 0);
      if (total > 30 * 1024 * 1024) return err(env, request, "That is more than 30 MB in one go. Send it in smaller batches.");

      const parts = [];
      if (files.length) parts.push(files.length === 1 ? `Update ${files[0].path}` : `Update ${files.length} file(s)`);
      if (pairs.length) parts.push(pairs.length === 1 ? `Rename ${pairs[0].from} to ${pairs[0].to}` : `Rename ${pairs.length} paths`);
      if (removeFinal.length) parts.push(`Remove ${removeFinal.length} file(s)`);
      const msg = String(b.message || "").trim() || parts.join(", ") || "Update files";

      // GitHub refusing us is not "the server had a problem". Without this the
      // exception reached the top-level handler as a bare 500 and the real
      // reason — the token cannot write here — was never shown to anyone.
      let res;
      try {
        res = await GH.commitChanges(repo.gh_token, {
          owner: repo.owner, repo: repo.name, branch: repo.branch,
          message: `${msg} (panel, ${me.username})`, files, remove: removeFinal, blobs: moved,
        }, fetch);
      } catch (e) {
        const why = ghMessage(e, repo);
        await logAction(env, me.username, "could not write files", app.heroku_name,
          String(e.message || e).slice(0, 200), 0, { ref: `${repo.owner}/${repo.name}`, error: why });
        return err(env, request, why, 409);
      }
      // v29: record WHEN each of these paths changed, so the File Manager can
      // show "Last updated" without a single extra call to GitHub. Written
      // paths and the new name of anything moved; deletions are not stamped
      // (there is no file left to date).
      await stampFileTimes(env, repo.id, [
        ...files.map((f) => f.path),
        ...moved.map((mv) => mv.path),
      ]);
      // and forget the paths that no longer exist — anything removed, plus the
      // OLD name of anything renamed
      await dropFileTimes(env, repo.id, [...removeFinal, ...movedFrom]);
      const action = pairs.length && !files.length && !removeFinal.length
        ? (moved.length > 1 ? "renamed a folder" : "renamed a file")
        : files.length ? "changed files" : "deleted files";
      await logAction(env, me.username, action, app.heroku_name,
        `${res.changed} written, ${moved.length} moved, ${res.removed} removed`,
        1, { ref: `${repo.owner}/${repo.name}` });
      const bp = await recordBuildpack(env, app.id, repo, me.username);

      // Committing is not publishing. Everything done here used to stop at the
      // repo, so the live site kept serving the old build while the panel said
      // "Saved".
      //
      // ⭐ AND it rebuilt exactly ONE app — the one whose File Manager happened
      // to be open. A repo can feed several apps, and a file in it is the same
      // file for all of them: the others kept serving the old build with no
      // sign anything had happened. Every app fed by THIS repo is rebuilt, and
      // nothing else is touched.
      let build = null;
      const builds = [];
      if (b.publish !== false) {
        const fed = (await q(env,
          `SELECT a.*, c.token AS hk_token FROM apps a JOIN connections c ON c.id=a.connection_id
           WHERE a.repo_id=? ORDER BY a.id`, repo.id).all()).results || [];
        for (const full of fed) {
          try {
            const bd = await startBuild(env, repo, full, res.commitSha);
            builds.push({ app: full.heroku_name, id: bd.id, status: bd.status });
            await logPanel(env, "rebuilt after a file change", full.heroku_name,
              `build ${bd.id}${fed.length > 1 ? ` · one of ${fed.length} apps fed by ${repo.owner}/${repo.name}` : ""}`,
              { actor: me.username, ref: `${repo.owner}/${repo.name}` });
          } catch (e) {
            const why = hkMessage(e, full.heroku_name);
            builds.push({ app: full.heroku_name, error: String(e.message || e).slice(0, 200) });
            // The commit landed and that live site did NOT change. Saying only
            // "Saved" here is the exact failure v4 was built to stop.
            await logPanel(env, "could not rebuild after a file change", full.heroku_name,
              "the change IS committed, but this app was not rebuilt",
              { actor: me.username, ok: 0, ref: `${repo.owner}/${repo.name}`, error: why });
          }
        }
        // kept for the older callers that read a single `build`
        build = builds.find((x) => String(x.app) === String(app.heroku_name)) || builds[0] || null;
      }
      return json(env, request, { ok: true, ...res, renamed: moved.length, buildpack: bp,
                                  build, builds, apps: builds.map((x) => x.app) });
    }
  }

  // ---- one file's contents ------------------------------------------------
  if (route === "file" && request.method === "GET") {
    const appId = Number(url.searchParams.get("app"));
    const path = url.searchParams.get("path") || "";
    const app = await q(env, `SELECT repo_id FROM apps WHERE id=?`, appId).first();
    if (!app?.repo_id) return err(env, request, "That app has no repo linked.");
    const repo = await siteRow(env, app.repo_id);
    try {
      const r = await GH.readFile(repo.gh_token, repo.owner, repo.name, repo.branch, path, fetch);
      return json(env, request, r);
    } catch (e) { return err(env, request, ghMessage(e, repo)); }
  }

  // ---- v31: TAGS ----------------------------------------------------------
  //
  // A tag is written ONCE and then clicked onto any app. His notes were already
  // tags in practice — the same seven strings retyped across 21 apps — so the
  // whole point is that nothing is typed twice.
  //
  // ⚠️ The colour is stored as a NAME (default|red|amber|green|blue|violet) and
  // mapped per theme, exactly like the note colour was: a hex from a hand-made
  // request can never reach the page.
  const TAG_MAX = 60;      // long enough for every note he already had

  if (route === "tag" && !seg[2] && request.method === "POST") {
    const b = await body();
    const label = cutText(b.label, TAG_MAX).trim();
    const color = noteColor(b.color);
    if (!label) return err(env, request, "A tag needs some words on it.");
    const dup = await q(env, `SELECT id FROM tags WHERE label=? AND color IS ?`, label, color).first();
    if (dup) {
      return json(env, request, { ok: true, id: String(dup.id), label, color, already: true,
        message: `You already have that tag.` });
    }
    await q(env, `INSERT INTO tags (label, color, created_at) VALUES (?,?,?)`, label, color, nowIso()).run();
    const made = await q(env, `SELECT id FROM tags WHERE label=? AND color IS ?`, label, color).first();
    await logAction(env, me.username, "made a tag", label, `colour ${color}`, 1);
    return json(env, request, { ok: true, id: String(made.id), label, color,
      message: `Tag “${label}” is ready — click it onto any app.` });
  }

  if (route === "tag" && seg[2] && request.method === "PATCH") {
    const b = await body();
    const tag = await q(env, `SELECT id, label, color FROM tags WHERE id=?`, Number(seg[2])).first();
    if (!tag) return err(env, request, "That tag is not here any more.", 404);
    const label = b.label === undefined ? tag.label : cutText(b.label, TAG_MAX).trim();
    const color = b.color === undefined ? tag.color : noteColor(b.color);
    if (!label) return err(env, request, "A tag needs some words on it.");
    const clash = await q(env, `SELECT id FROM tags WHERE label=? AND color IS ? AND id<>?`,
      label, color, tag.id).first();
    if (clash) return err(env, request, `You already have a tag that says “${label}” in that colour.`, 409);
    await q(env, `UPDATE tags SET label=?, color=? WHERE id=?`, label, color, tag.id).run();
    await logAction(env, me.username, "changed a tag", label,
      tag.label === label ? `colour ${color}` : `was “${tag.label}”`, 1);
    return json(env, request, { ok: true, id: String(tag.id), label, color });
  }

  // Deleting a tag takes it off every app it is on — so it SAYS how many first,
  // in the reply, and the panel puts that number in the question it asks.
  if (route === "tag" && seg[2] && request.method === "DELETE") {
    const tag = await q(env, `SELECT id, label FROM tags WHERE id=?`, Number(seg[2])).first();
    if (!tag) return err(env, request, "That tag is not here any more.", 404);
    const c = await q(env, `SELECT COUNT(*) AS n FROM app_tags WHERE tag_id=?`, tag.id).first();
    const uses = Number(c?.n || 0);
    await q(env, `DELETE FROM app_tags WHERE tag_id=?`, tag.id).run();
    await q(env, `DELETE FROM tags WHERE id=?`, tag.id).run();
    await logAction(env, me.username, "deleted a tag", tag.label,
      uses ? `it was on ${uses} app(s)` : "it was not on any app", 1);
    return json(env, request, { ok: true, uses,
      message: uses
        ? `Tag “${tag.label}” deleted, and taken off ${uses} app${uses === 1 ? "" : "s"}.`
        : `Tag “${tag.label}” deleted.` });
  }

  // Put a tag on an app / take it off. One press each — that is the whole ask.
  if (route === "app" && seg[2] && seg[3] === "tag" &&
      (request.method === "POST" || request.method === "DELETE")) {
    const app = await q(env, `SELECT id, heroku_name FROM apps WHERE id=?`, Number(seg[2])).first();
    if (!app) return err(env, request, "That app is not in the list.", 404);
    const b = request.method === "POST" ? await body() : {};
    const tagId = Number(seg[4] || b.tag_id);
    const tag = await q(env, `SELECT id, label FROM tags WHERE id=?`, tagId).first();
    if (!tag) return err(env, request, "That tag is not here any more.", 404);
    if (request.method === "POST") {
      await q(env, `INSERT OR IGNORE INTO app_tags (app_id, tag_id) VALUES (?,?)`, app.id, tag.id).run();
      await logAction(env, me.username, "tagged an app", app.heroku_name, tag.label, 1,
        { ref: app.heroku_name });
    } else {
      await q(env, `DELETE FROM app_tags WHERE app_id=? AND tag_id=?`, app.id, tag.id).run();
      await logAction(env, me.username, "took a tag off an app", app.heroku_name, tag.label, 1,
        { ref: app.heroku_name });
    }
    const site = await appState(env, app.id);
    return json(env, request, { ok: true, app: site, tag: { id: String(tag.id), label: tag.label } });
  }

  // ---- build an app from its repo, with no upload -------------------------
  //
  // ⚠️ THE GAP THIS CLOSES: linking an app to a repo is a RECORD, not a deploy.
  // Linking a second app to a repo another app already uses leaves the new one
  // with no code at all — Heroku answers its own "Welcome to your new app!"
  // page with a 502, which reads exactly like a broken site. There was no way
  // to say "just build this one from what is already in the repo" without
  // uploading a file, so the only cure was a fake upload.
  // v27: ONE press builds every app on a repo. He was clicking Build on each
  // app in turn; with four apps on a repo that is four presses for one change.
  // The panel's own "build all" button fans out one of THESE per repo rather
  // than one giant call, so each Worker invocation stays well inside its
  // outbound-call ceiling and progress can be shown repo by repo.
  if (route === "build" && seg[2] === "repo" && seg[3] && request.method === "POST") {
    const repoId = Number(seg[3]);
    if (!Number.isFinite(repoId)) return err(env, request, "That repo is not in the list.", 404);
    const site = await siteRow(env, repoId);
    if (!site) return err(env, request, "That repo is not in the list any more.", 404);
    const full = `${site.owner}/${site.name}`;
    const all = (await q(env,
      `SELECT a.id, a.heroku_name, a.web_url, a.built_sha, c.token AS hk_token, c.account AS hk_account
       FROM apps a LEFT JOIN connections c ON c.id = a.connection_id
       WHERE a.repo_id=? ORDER BY a.heroku_name`, repoId).all()).results || [];
    if (!all.length) {
      return err(env, request,
        `No app takes its files from ${full} yet, so there is nothing to build. Link one to it first.`, 409);
    }
    // An app whose Heroku account is not connected here cannot be built — say
    // which ones and build the rest, rather than refusing the whole press.
    const usable = all.filter((a) => a.hk_token);
    const noKey = all.filter((a) => !a.hk_token).map((a) => a.heroku_name);
    const apps = usable.slice(0, MAX_APPS_PER_BUILD_CALL);
    const overflow = usable.slice(MAX_APPS_PER_BUILD_CALL).map((a) => a.heroku_name);
    if (!apps.length) {
      return err(env, request,
        `The Heroku account holding ${noKey.join(", ")} is not connected here, so the panel cannot build ${noKey.length === 1 ? "it" : "them"}.`, 409);
    }

    let head;
    try {
      head = await GH.headSha(site.gh_token, site.owner, site.name, site.branch, fetch);
    } catch (e) {
      const why = ghMessage(e, site);
      await logFail(env, me.username, "could not build a repo's apps", full, why, { ref: full });
      return err(env, request, why, isOutage(String(e.message || e)) ? 503 : 502);
    }

    const results = await buildRepoApps(env, site, apps, head);
    const started = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    for (const r of started) {
      await logAction(env, me.username, "started a build", r.app,
        `from ${full} at ${String(head).slice(0, 7)} — one of ${apps.length} app(s) on this repo, no files changed`,
        1, { ref: r.app });
    }
    for (const r of failed) {
      await logFail(env, me.username, "could not build an app", r.app, r.error, { ref: full });
    }
    const bits = [];
    if (started.length) {
      bits.push(`Building ${started.length} app${started.length === 1 ? "" : "s"} from ${full}: ${started.map((r) => r.app).join(", ")}.`);
    }
    if (failed.length) bits.push(`${failed.length} could not start — ${failed.map((r) => r.app + ": " + r.error).join(" | ")}`);
    if (noKey.length) bits.push(`Skipped ${noKey.join(", ")} — that Heroku account is not connected here.`);
    if (overflow.length) bits.push(`Skipped ${overflow.join(", ")} for now — press Build again to do the rest (${MAX_APPS_PER_BUILD_CALL} per press).`);
    if (started.length) bits.push("It takes a minute or two each.");
    return json(env, request, {
      ok: started.length > 0, repo: full, commit: head,
      results, started: started.length, failed: failed.length,
      skipped: noKey.concat(overflow),
      message: bits.join(" "),
      // A non-2xx must carry `error` — that is the field the panel reads when a
      // call fails, and a message it cannot see is the same as no message.
      ...(started.length ? {} : { error: bits.join(" ") }),
    }, started.length ? 200 : 502);
  }

  if (route === "build" && seg[2] && request.method === "POST") {
    const app = await q(env,
      `SELECT a.id, a.heroku_name, a.repo_id, a.web_url, c.token AS hk_token, c.account AS hk_account
       FROM apps a LEFT JOIN connections c ON c.id = a.connection_id WHERE a.id=?`, Number(seg[2])).first();
    if (!app) return err(env, request, "That app is not in the list.", 404);
    if (!app.repo_id) return err(env, request, "Link a repo to this app first — there is nothing to build from.");
    if (!app.hk_token) {
      return err(env, request,
        `The Heroku account holding ${app.heroku_name} is not connected here, so the panel cannot build it.`, 409);
    }
    const site = await siteRow(env, app.repo_id);
    if (!site) return err(env, request, "That repo is not in the list any more.", 404);
    const full = `${site.owner}/${site.name}`;

    let head;
    try {
      head = await GH.headSha(site.gh_token, site.owner, site.name, site.branch, fetch);
    } catch (e) {
      const why = ghMessage(e, site);
      await logFail(env, me.username, "could not build an app", app.heroku_name, why, { ref: full });
      return err(env, request, why, isOutage(String(e.message || e)) ? 503 : 502);
    }
    let build;
    try {
      build = await startBuild(env, site, { ...app, hk_token: app.hk_token }, head);
    } catch (e) {
      const why = hkMessage(e, app.hk_account);
      await logFail(env, me.username, "could not build an app", app.heroku_name, why, { ref: full });
      return err(env, request, why, isOutage(String(e.message || e)) ? 503 : 502);
    }
    await logAction(env, me.username, "started a build", app.heroku_name,
      `from ${full} at ${String(head).slice(0, 7)} — no files changed`, 1, { ref: app.heroku_name });
    return json(env, request, {
      ok: true, app: app.heroku_name, repo: full, commit: head,
      build_id: build.id, status: build.status,
      url: app.web_url || "",
      message: `Building ${app.heroku_name} from ${full}. It takes a minute or two; reload its address after that.`,
    });
  }

  // ---- make a static site deployable --------------------------------------
  // Heroku detects PHP on composer.json OR index.php (verified against the
  // buildpack's own detect script). A repo of plain .html files matches nothing,
  // which is the "No default language could be detected" failure.
  if (route === "makedeployable" && request.method === "POST") {
    const b = await body();
    const app = await q(env, `SELECT id, heroku_name, repo_id FROM apps WHERE id=?`, Number(b.app_id)).first();
    if (!app?.repo_id) return err(env, request, "That app has no repo linked.");
    const repo = await siteRow(env, app.repo_id);
    const t = await GH.treeOf(repo.gh_token, repo.owner, repo.name, repo.branch, fetch);
    const paths = t.entries.filter((e) => e.type === "blob").map((e) => e.path);
    const found = GH.buildpackFor(paths);
    if (found) {
      await recordBuildpack(env, app.id, repo, me.username);
      return json(env, request, { ok: true, already: found });
    }
    if (!paths.includes("index.html")) {
      const why = "There is no index.html at the top of this repo, so there is nothing to serve.";
      await logFail(env, me.username, "could not make a site deployable", app.heroku_name, why,
        { ref: `${repo.owner}/${repo.name}` });
      return err(env, request, why);
    }
    const php = '<?php include_once("index.html"); ?>';
    await GH.commitChanges(repo.gh_token, {
      owner: repo.owner, repo: repo.name, branch: repo.branch,
      message: `Add index.php so Heroku can serve this site (panel, ${me.username})`,
      files: [{ path: "index.php", contentB64: toBase64(new TextEncoder().encode(php)) }],
    }, fetch);
    await logAction(env, me.username, "made a site deployable", app.heroku_name, "added index.php",
      1, { ref: `${repo.owner}/${repo.name}` });
    await recordBuildpack(env, app.id, repo, me.username);
    return json(env, request, { ok: true, added: "index.php" });
  }

  // ---- repos available to link ------------------------------------
  if (route === "repos") {
    // Newest first here too: the repo he just created is the one he is
    // looking for, and alphabetical order hid it.
    const rows = (await retryAfterMigration(env, () => q(env,
      `SELECT r.id, r.label, r.owner, r.name, r.branch, COALESCE(r.dir,'') AS dir,
              r.created_at, r.gh_created_at, r.pushed_at, c.account
       FROM repos r LEFT JOIN connections c ON c.id = r.connection_id
       ORDER BY COALESCE(r.created_at,'') DESC, r.id DESC`).all())).results || [];
    return json(env, request, {
      repos: rows.map((r) => ({
        ...r, id: String(r.id),
        created_at: r.created_at || null,
        // v29 — GitHub's own dates. `created_at` stays as "when Gitku first saw
        // it" and remains the ordering fallback; these two are what the screen
        // shows under "Created on" and "Last updated".
        gh_created_at: r.gh_created_at || null,
        pushed_at: r.pushed_at || null,
      })),
    });
  }

  // ---- delete an app: forget it here, or destroy it on Heroku for real ----
  // Two different things behind one route, split by {destroy:true}:
  //   without it — the LOCAL row goes and Heroku is never touched (safe);
  //   with it    — DELETE /apps/{name}: the app, its config, its add-ons and
  //                its address are gone and nobody can bring them back.
  // The destructive form additionally demands {confirm:"<exact heroku name>"},
  // so a stale page, a mis-click or a wrong row can never destroy anything.
  if (route === "app" && seg[2] && seg[2] !== "create" && request.method === "DELETE") {
    const b = await body();
    const app = await q(env,
      `SELECT a.id, a.heroku_name, c.account, c.token AS hk_token
       FROM apps a LEFT JOIN connections c ON c.id = a.connection_id WHERE a.id=?`, Number(seg[2])).first();
    if (!app) return err(env, request, "That app is not in the list.", 404);

    if (b.destroy === true) {
      if (String(b.confirm || "") !== String(app.heroku_name)) {
        const why = `The name you typed does not match. To delete this Heroku app for good, ` +
                    `type its exact name: ${app.heroku_name}. Nothing was deleted.`;
        await logFail(env, me.username, "refused to delete a Heroku app", app.heroku_name, why);
        return err(env, request, why, 400);
      }
      if (!app.hk_token) {
        const why = `The Heroku account holding ${app.heroku_name} is not connected here, so the panel cannot delete it. Nothing was deleted.`;
        await logFail(env, me.username, "could not delete a Heroku app", app.heroku_name, why);
        return err(env, request, why, 409);
      }
      try {
        await HK.deleteApp(app.hk_token, app.heroku_name, fetch);
      } catch (e) {
        const why = hkMessage(e, app.account);
        await logFail(env, me.username, "could not delete a Heroku app", app.heroku_name, why);
        return err(env, request, why, 502);
      }
      await q(env, `DELETE FROM apps WHERE id=?`, app.id).run();
      await logAction(env, me.username, "deleted a Heroku app", app.heroku_name,
        `on ${app.account || "Heroku"} — permanent; the app, its settings and its address cannot be brought back`);
      return json(env, request, { ok: true, destroyed: app.heroku_name, account: app.account || "" });
    }

    // Local only: the panel forgets the app; Heroku is not touched at all.
    await q(env, `DELETE FROM apps WHERE id=?`, app.id).run();
    await logAction(env, me.username, "stopped managing an app", app.heroku_name,
      "removed from this panel only — the app itself still exists on Heroku");
    return json(env, request, { ok: true, destroyed: null, removed: app.heroku_name });
  }

  // ---- per-app settings (target folder, branch, in-use mark) --------------
  if (route === "app" && seg[2] && seg[2] !== "create" && request.method === "PATCH") {
    const b = await body();
    const app = await q(env,
      `SELECT id, repo_id, heroku_name, COALESCE(paused,0) AS paused, note, note_color FROM apps WHERE id=?`,
      Number(seg[2])).first();
    if (!app) return err(env, request, "That app is not in the list.");

    // The in-use mark is answered FIRST and needs no repo: an app with nothing
    // linked is exactly the kind you want to mark as not in use.
    if ("paused" in b) {
      const want = b.paused === true || b.paused === 1 || b.paused === "1" ? 1 : 0;
      if (want !== app.paused) {
        await q(env, `UPDATE apps SET paused=? WHERE id=?`, want, app.id).run();
        await logAction(env, me.username, want ? "marked a site as not in use" : "marked a site as in use",
          app.heroku_name, want ? "it stays off \"Select all\" until you switch it back" : null,
          1, { ref: app.heroku_name });
      }
      if (!("dir" in b) && !("branch" in b)) {
        return json(env, request, { ok: true, paused: want, app: await appState(env, app.id) });
      }
    }
    // The note needs no repo either — an app with nothing linked is exactly the
    // one you want to leave yourself a note about.
    if ("note" in b || "note_color" in b) {
      const note = cutText(b.note, 300);
      const color = noteColor(b.note_color);
      await q(env, `UPDATE apps SET note=?, note_color=? WHERE id=?`, note, color, app.id).run();
      await logAction(env, me.username, note ? "wrote a note on an app" : "cleared the note on an app",
        app.heroku_name, note ? cutText(note, 160) : null, 1, { ref: app.heroku_name });
      if (!("dir" in b) && !("branch" in b)) {
        return json(env, request, { ok: true, note, note_color: color, app: await appState(env, app.id) });
      }
    }
    if (!app.repo_id) return err(env, request, "Link a repo to this app first.");
    const sets = [], vals = [];
    if ("dir" in b) { sets.push("dir=?"); vals.push(String(b.dir || "").replace(/^\/+|\/+$/g, "")); }
    if ("branch" in b) { sets.push("branch=?"); vals.push(String(b.branch || "main")); }
    if (sets.length) {
      await q(env, `UPDATE repos SET ${sets.join(", ")} WHERE id=?`, ...vals, app.repo_id).run();
      await logAction(env, me.username, "changed app settings", app.heroku_name, JSON.stringify(b).slice(0, 200));
    }
    return json(env, request, { ok: true });
  }

  // ---- users --------------------------------------------------------------
  if (route === "user") {
    if (!master) return needMaster();
    if (request.method === "POST") {
      const b = await body();
      const u = String(b.username || "").trim();
      const p = String(b.password || "");
      if (u.length < 3 || p.length < 8) return err(env, request, "Username needs 3+ characters and password 8+.");
      const role = (b.role === "master" || b.role === "owner") ? "master" : "va";
      const clash = await q(env, `SELECT username FROM panel_users WHERE username=?`, u).first();
      if (clash) {
        const why = `There is already someone called ${u}. Pick another name — adding again would reset their password.`;
        await logFail(env, me.username, "could not add a person", u, why);
        return err(env, request, why, 409);
      }
      await createUser(env, u, p, role);
      await logAction(env, me.username, "added a person", u, role === "master" ? "owner" : "VA");
      return json(env, request, { ok: true });
    }
    if (request.method === "DELETE" && seg[2]) {
      const target = decodeURIComponent(seg[2]);
      if (target === me.username) return err(env, request, "You cannot remove the account you are signed in with.");
      const masters = await q(env, `SELECT COUNT(*) AS n FROM panel_users WHERE role='master'`).first();
      const victim = await q(env, `SELECT role FROM panel_users WHERE username=?`, target).first();
      if (victim?.role === "master" && masters.n <= 1) return err(env, request, "That is the only master account.");
      await q(env, `DELETE FROM panel_users WHERE username=?`, target).run();
      await q(env, `DELETE FROM sessions WHERE username=?`, target).run();
      // Adding a person was recorded and removing one was not, which is the
      // wrong way round: removal is the change someone would want to explain.
      await logAction(env, me.username, "removed a person", target,
        `was ${outRole(victim?.role) || "unknown"}; signed out everywhere`);
      return json(env, request, { ok: true });
    }
  }

  if (route === "password" && request.method === "POST") {
    const b = await body();
    const u = await q(env, `SELECT * FROM panel_users WHERE username=?`, me.username).first();
    const given = String(b.old ?? b.current ?? "");
    const wanted = String(b.new ?? b.next ?? "");
    const old = await pbkdf2(given, fromBase64(u.salt));
    if (!sameSecret(old, u.pass_hash)) return err(env, request, "Current password is wrong.", 403);
    if (wanted.length < 8) return err(env, request, "New password needs 8+ characters.");
    await createUser(env, me.username, wanted, u.role);
    const gone = await q(env, `SELECT COUNT(*) AS n FROM sessions WHERE username=? AND token<>?`,
      me.username, me.token).first();
    await q(env, `DELETE FROM sessions WHERE username=? AND token<>?`, me.username, me.token).run();
    // Nobody could see that a password had changed — including the owner, for an
    // account holding write access to every repo.
    await logAction(env, me.username, "changed their password", me.username,
      (gone?.n ? `signed out ${gone.n} other session(s)` : "no other sessions were open"));
    return json(env, request, { ok: true });
  }

  return err(env, request, "Unknown request.", 404);
}

async function undoBatch(env, batchId, oldTargets, who) {
  for (const t of oldTargets) {
    // Multi-file updates cannot be reversed file-by-file from a single
    // prev_blob_sha, so they are refused rather than corrupting the repo.
    let recorded = null;
    try { recorded = t.files_json ? JSON.parse(t.files_json) : null; } catch { recorded = null; }
    if (recorded && recorded.length > 1) {
      await q(env, `UPDATE batch_targets SET status='skipped', detail=?, finished_at=? WHERE batch_id=? AND repo_id=?`,
        `This update carried ${recorded.length} files. Undo restores one file at a time — open Files and put back the ones you need.`,
        nowIso(), batchId, t.repo_id).run();
      continue;
    }
    const site = await siteRow(env, t.repo_id);
    const setT = (fields, ...vals) =>
      q(env, `UPDATE batch_targets SET ${fields} WHERE batch_id=? AND repo_id=?`, ...vals, batchId, t.repo_id).run();
    if (!site || !t.path || t.status === "failed") {
      await setT("status='skipped', detail=?, finished_at=?", "Nothing to undo here.", nowIso());
      continue;
    }
    try {
      const current = await GH.getFileSha(site.gh_token, site.owner, site.name, site.branch, t.path, fetch);
      let commitSha;
      if (t.prev_blob_sha) {
        const b64 = await GH.getBlob(site.gh_token, site.owner, site.name, t.prev_blob_sha, fetch);
        commitSha = (await GH.putFile(site.gh_token, {
          owner: site.owner, repo: site.name, branch: site.branch, path: t.path,
          contentB64: b64, message: `Revert ${t.path} (panel, ${who})`, sha: current || undefined,
        }, fetch)).commitSha;
      } else {
        if (!current) { await setT("status='skipped', detail=?, finished_at=?", "Already removed.", nowIso()); continue; }
        commitSha = (await GH.deleteFile(site.gh_token, {
          owner: site.owner, repo: site.name, branch: site.branch, path: t.path,
          message: `Remove ${t.path} (undo, panel, ${who})`, sha: current,
        }, fetch)).commitSha;
      }
      await setT("path=?, commit_sha=?, status='building'", t.path, commitSha);

      const app = await appRow(env, site.id);
      if (!app) { await setT("status='no_app', detail=?, finished_at=?", "Reverted. No Heroku app linked.", nowIso()); continue; }
      const build = await startBuild(env, site, app, commitSha);
      // started_at anchors the give-up clock for an undo exactly as it does
      // for a deploy — an undo that hangs is worse than a deploy that hangs.
      await setT("build_id=?, build_url=?, started_at=?, status='building'",
        build.id, app.web_url || null, nowIso());
      await logPanel(env, "started a build", app.heroku_name,
        `undo of ${t.path} · build ${build.id}`, { actor: who, ref: batchId });
    } catch (e) {
      const why = ghMessage(e, site).slice(0, 400);
      await setT("status='failed', detail=?, finished_at=?", why, nowIso());
      await logPanel(env, "could not undo", `${site.owner}/${site.name}`, t.path,
        { actor: who, ref: batchId, ok: 0, error: why });
    }
  }
}
