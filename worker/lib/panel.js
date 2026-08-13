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
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
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

/** Everything worth explaining later. Stored ISO UTC; the panel renders IST. */
async function logAction(env, actor, action, target, detail, ok = 1) {
  try {
    await q(env, `INSERT INTO audit_log (at, actor, action, target, detail, ok) VALUES (?,?,?,?,?,?)`,
      nowIso(), actor || "system", action, target || null, detail ? String(detail).slice(0, 400) : null, ok).run();
  } catch { /* logging must never break the action it is recording */ }
}

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

export async function ensurePanelSchema(env) {
  if (panelSchemaReady.has(env.DB)) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS panel_users (username TEXT PRIMARY KEY, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, expires TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, n INTEGER NOT NULL, first_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, who TEXT NOT NULL, file_name TEXT NOT NULL, mode TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS batch_targets (batch_id TEXT NOT NULL, repo_id INTEGER NOT NULL, app_id INTEGER, path TEXT, status TEXT, detail TEXT, commit_sha TEXT, prev_blob_sha TEXT, new_blob_sha TEXT, build_id TEXT, build_url TEXT, finished_at TEXT, PRIMARY KEY (batch_id, repo_id))`,
    `CREATE INDEX IF NOT EXISTS bt_pending ON batch_targets (status)`,
    `CREATE TABLE IF NOT EXISTS combos (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT, github_conn_id INTEGER NOT NULL, heroku_conn_id INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE (github_conn_id, heroku_conn_id))`,
    `CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, ok INTEGER DEFAULT 1)`,
    `CREATE INDEX IF NOT EXISTS audit_recent ON audit_log (id DESC)`,
  ];
  for (const s of stmts) await env.DB.prepare(s).run();

  // repos predates the panel; add the display fields it needs.
  const info = await env.DB.prepare(`PRAGMA table_info(repos)`).all();
  const have = new Set((info.results || []).map((c) => c.name));
  if (!have.has("url")) await env.DB.prepare(`ALTER TABLE repos ADD COLUMN url TEXT`).run();
  if (!have.has("dir")) await env.DB.prepare(`ALTER TABLE repos ADD COLUMN dir TEXT DEFAULT ''`).run();
  const ainfo = await env.DB.prepare(`PRAGMA table_info(apps)`).all();
  if (!(ainfo.results || []).some((c) => c.name === "combo_id")) {
    await env.DB.prepare(`ALTER TABLE apps ADD COLUMN combo_id INTEGER`).run();
  }
  const binfo = await env.DB.prepare(`PRAGMA table_info(batches)`).all();
  if (!(binfo.results || []).some((c) => c.name === "last_poll")) {
    await env.DB.prepare(`ALTER TABLE batches ADD COLUMN last_poll TEXT`).run();
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
 * Deploy one site. Commit first, then start the Heroku build.
 *
 * Build source order matters for privacy: try the signed codeload URL so the
 * repo contents go GitHub -> Heroku directly, and only fall back to pulling the
 * archive through this Worker if that fails (the signed link is short-lived).
 */
async function deployOne(env, batchId, site, bytes, fileName, mode, who) {
  const setT = (fields, ...vals) =>
    q(env, `UPDATE batch_targets SET ${fields} WHERE batch_id=? AND repo_id=?`, ...vals, batchId, site.id).run();

  try {
    const path = safeJoin(site.dir || "", fileName);
    const prev = await GH.getFileSha(site.gh_token, site.owner, site.name, site.branch, path, fetch);

    if (mode === "new" && prev) throw new Error(`${path} already exists here.`);
    if (mode === "replace" && !prev) throw new Error(`${path} does not exist yet, so there is nothing to replace.`);

    const commit = await GH.putFile(site.gh_token, {
      owner: site.owner, repo: site.name, branch: site.branch, path,
      contentB64: toBase64(bytes),
      message: `${prev ? "Update" : "Add"} ${path} (panel, ${who})`,
      sha: prev || undefined,
    }, fetch);

    await setT("path=?, commit_sha=?, prev_blob_sha=?, new_blob_sha=?, status='building'",
      path, commit.commitSha, prev, commit.blobSha);

    const app = await appRow(env, site.id);
    if (!app) {
      await setT("status='no_app', detail=?, finished_at=?", "Committed. No Heroku app linked.", nowIso());
      return;
    }

    const build = await startBuild(env, site, app, commit.commitSha);
    await setT("build_id=?, build_url=?, status=?", build.id, app.web_url || null,
      build.status === "failed" ? "failed" : "building");
  } catch (e) {
    await setT("status='failed', detail=?, finished_at=?", String(e.message || e).slice(0, 400), nowIso());
  }
}

async function startBuild(env, site, app, version) {
  const url = await GH.tarballUrl(site.gh_token, site.owner, site.name, site.branch, fetch);
  if (url) {
    try {
      return await HK.createBuild(app.hk_token, app.heroku_name, url, version, fetch);
    } catch {
      /* signed link may have expired or been refused; fall through to upload */
    }
  }
  const tar = await GH.tarball(site.gh_token, site.owner, site.name, site.branch, 40 * 1024 * 1024, fetch);
  return HK.deploy(app.hk_token, app.heroku_name, tar, version, fetch);
}

export async function runBatch(env, batchId, siteIds, bytes, fileName, mode, who) {
  for (const id of siteIds) {
    const site = await siteRow(env, id);
    if (!site) continue;
    await deployOne(env, batchId, site, bytes, fileName, mode, who);
  }
  const c = await q(env,
    `SELECT SUM(status='failed') AS failed, COUNT(*) AS n FROM batch_targets WHERE batch_id=?`, batchId).first();
  await logAction(env, who, "sent a file", fileName,
    `${c?.n || 0} app(s), ${c?.failed || 0} failed`, (c?.failed || 0) === 0 ? 1 : 0);
}

const REFRESH_EVERY_MS = 4000;

/** Poll Heroku for one batch's in-flight builds, at most once every few seconds. */
async function refreshBatch(env, batchId) {
  const b = await q(env, `SELECT last_poll FROM batches WHERE id=?`, batchId).first();
  if (!b) return;
  if (b.last_poll && Date.now() - Number(b.last_poll) < REFRESH_EVERY_MS) return;
  await q(env, `UPDATE batches SET last_poll=? WHERE id=?`, String(Date.now()), batchId).run();

  const rows = (await q(env,
    `SELECT t.*, a.heroku_name, c.token AS hk_token
     FROM batch_targets t JOIN apps a ON a.id=t.app_id JOIN connections c ON c.id=a.connection_id
     WHERE t.batch_id=? AND t.status='building' AND t.build_id IS NOT NULL LIMIT 10`, batchId).all()).results || [];
  for (const t of rows) {
    try {
      const bd = await HK.getBuild(t.hk_token, t.heroku_name, t.build_id, fetch);
      if (bd.status === "pending") continue;
      if (bd.status === "succeeded") {
        await q(env, `UPDATE batch_targets SET status='live', detail=NULL, finished_at=? WHERE batch_id=? AND repo_id=?`,
          nowIso(), batchId, t.repo_id).run();
      } else {
        const tail = await HK.buildLogTail(bd.output_stream_url, 8, fetch);
        await q(env, `UPDATE batch_targets SET status='failed', detail=?, finished_at=? WHERE batch_id=? AND repo_id=?`,
          (tail || "Build failed.").slice(-500), nowIso(), batchId, t.repo_id).run();
      }
    } catch { /* the cron is the backstop */ }
  }
}

/** Called by cron: advance any build still running. */
export async function pollPanelBuilds(env) {
  const rows = (await q(env,
    `SELECT t.*, a.heroku_name, a.web_url, c.token AS hk_token
     FROM batch_targets t JOIN apps a ON a.id=t.app_id JOIN connections c ON c.id=a.connection_id
     WHERE t.status='building' AND t.build_id IS NOT NULL LIMIT 25`).all()).results || [];

  for (const t of rows) {
    try {
      const b = await HK.getBuild(t.hk_token, t.heroku_name, t.build_id, fetch);
      if (b.status === "pending") continue;
      if (b.status === "succeeded") {
        await q(env, `UPDATE batch_targets SET status='live', detail=NULL, finished_at=? WHERE batch_id=? AND repo_id=?`,
          nowIso(), t.batch_id, t.repo_id).run();
      } else {
        const tail = await HK.buildLogTail(b.output_stream_url, 8, fetch);
        await q(env, `UPDATE batch_targets SET status='failed', detail=?, finished_at=? WHERE batch_id=? AND repo_id=?`,
          (tail || "Build failed.").slice(-500), nowIso(), t.batch_id, t.repo_id).run();
      }
    } catch (e) {
      await q(env, `UPDATE batch_targets SET status='failed', detail=?, finished_at=? WHERE batch_id=? AND repo_id=?`,
        String(e.message || e).slice(0, 300), nowIso(), t.batch_id, t.repo_id).run();
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
export async function refreshCombos(env, actor) {
  const combos = (await q(env,
    `SELECT c.id, c.label,
            g.id AS gid, g.token AS gtok, g.account AS gacct,
            h.id AS hid, h.token AS htok, h.account AS hacct
     FROM combos c
     JOIN connections g ON g.id = c.github_conn_id
     JOIN connections h ON h.id = c.heroku_conn_id`).all()).results || [];

  const summary = { apps: 0, repos: 0, linked: 0, errors: [] };

  for (const c of combos) {
    let apps = [], repos = [];
    try { apps = await HK.listApps(c.htok, fetch); }
    catch (e) { summary.errors.push(`Heroku ${c.hacct}: ${e.message}`); }
    try { repos = await GH.listRepos(c.gtok, fetch); }
    catch (e) { summary.errors.push(`GitHub ${c.gacct}: ${e.message}`); }
    summary.repos += repos.length;

    // repos first, so an app can be matched to one straight away
    for (const r of repos) {
      const existing = await q(env, `SELECT id FROM repos WHERE owner=? AND name=?`, r.owner, r.name).first();
      if (!existing) {
        let label = r.name;
        if (await q(env, `SELECT id FROM repos WHERE label=?`, label).first()) label = r.full_name;
        await q(env,
          `INSERT INTO repos (label, owner, name, branch, connection_id, created_at, url, dir)
           VALUES (?,?,?,?,?,?,?,?)`,
          label, r.owner, r.name, r.branch, c.gid, nowIso(), "", "").run();
      }
    }

    for (const a of apps) {
      summary.apps++;
      const known = await q(env, `SELECT id, repo_id FROM apps WHERE connection_id=? AND heroku_name=?`,
        c.hid, a.name).first();
      if (known) {
        await q(env, `UPDATE apps SET web_url=?, combo_id=? WHERE id=?`, a.web_url || null, c.id, known.id).run();
        if (!known.repo_id) {
          const match = await matchRepo(env, c.gid, a.name);
          if (match) { await q(env, `UPDATE apps SET repo_id=? WHERE id=?`, match.id, known.id).run(); summary.linked++; }
        }
        continue;
      }
      const match = await matchRepo(env, c.gid, a.name);
      let label = a.name;
      if (await q(env, `SELECT id FROM apps WHERE label=?`, label).first()) label = `${a.name} (${c.hacct})`;
      await q(env,
        `INSERT INTO apps (label, heroku_name, connection_id, repo_id, web_url, created_at, combo_id)
         VALUES (?,?,?,?,?,?,?)`,
        label, a.name, c.hid, match ? match.id : null, a.web_url || null, nowIso(), c.id).run();
      if (match) summary.linked++;
    }
  }
  await logAction(env, actor, "refreshed accounts", null,
    `${summary.apps} app(s), ${summary.repos} repo(s), ${summary.linked} auto-linked`);
  return summary;
}

/** Match a Heroku app to a repo on the same account by name, loosely. */
async function matchRepo(env, githubConnId, appName) {
  const rows = (await q(env, `SELECT id, name FROM repos WHERE connection_id=?`, githubConnId).all()).results || [];
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
    const rawApps = (await q(env,
      `SELECT a.id, a.label, a.heroku_name, a.web_url, a.repo_id, a.combo_id,
              r.owner AS owner, r.name AS repo, r.branch AS branch, COALESCE(r.dir,'') AS dir,
              hc.account AS heroku_account
       FROM apps a
       LEFT JOIN repos r ON r.id = a.repo_id
       LEFT JOIN connections hc ON hc.id = a.connection_id
       ORDER BY a.label`).all()).results || [];

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
      account: a.heroku_account || "",
    }));

    const accounts = { github: [], heroku: [] };
    for (const c of (await q(env, `SELECT id, kind, account FROM connections ORDER BY kind`).all()).results || []) {
      const entry = { id: c.id, account: c.account };
      if (c.kind === "github") entry.login = c.account; else entry.email = c.account;
      accounts[c.kind]?.push(entry);
    }

    const combos = (await q(env,
      `SELECT c.id, c.label, g.account AS github, h.account AS heroku,
              c.github_conn_id, c.heroku_conn_id,
              (SELECT COUNT(*) FROM apps a WHERE a.combo_id = c.id) AS apps
       FROM combos c
       JOIN connections g ON g.id = c.github_conn_id
       JOIN connections h ON h.id = c.heroku_conn_id
       ORDER BY c.id`).all()).results || [];

    const recent = (await q(env,
      `SELECT b.id, b.created_at AS at, b.who, b.file_name AS file,
              (SELECT COUNT(*) FROM batch_targets t WHERE t.batch_id=b.id) AS sites,
              (SELECT COUNT(*) FROM batch_targets t WHERE t.batch_id=b.id AND t.status IN ('live','no_app')) AS ok,
              (SELECT COUNT(*) FROM batch_targets t WHERE t.batch_id=b.id AND t.status='failed') AS failed
       FROM batches b ORDER BY b.created_at DESC LIMIT 15`).all()).results || [];

    const users = ((await q(env, `SELECT username, role FROM panel_users ORDER BY role, username`).all()).results || [])
      .map((u) => ({ username: u.username, role: outRole(u.role) }));

    const unlinked = sites.filter((x) => !x.linked).length;
    return json(env, request, {
      sites, apps: sites, accounts, combos, users, recent,
      needs: { unlinked, no_combo: combos.length === 0 },
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
        if (/UNIQUE/i.test(String(e))) return err(env, request, "Those two accounts are already paired.");
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
  if (route === "refresh" && request.method === "POST") {
    const summary = await refreshCombos(env, me.username);
    return json(env, request, summary);
  }

  // ---- activity log -------------------------------------------------------
  if (route === "logs") {
    const rows = (await q(env,
      `SELECT at, actor, action, target, detail, ok FROM audit_log ORDER BY id DESC LIMIT 200`).all()).results || [];
    return json(env, request, { entries: rows });
  }

  // ---- deploy -------------------------------------------------------------
  if (route === "deploy" && request.method === "POST") {
    let form;
    try { form = await request.formData(); } catch { return err(env, request, "Upload was not readable."); }
    const file = form.get("file");
    if (!file || typeof file === "string") return err(env, request, "No file was attached.");
    let siteIds;
    try { siteIds = JSON.parse(String(form.get("sites") || "[]")).map(Number).filter(Boolean); }
    catch { return err(env, request, "Could not read which sites you picked."); }
    if (!siteIds.length) return err(env, request, "Pick at least one site.");
    if (siteIds.length > MAX_SITES_PER_BATCH) {
      return err(env, request, `Up to ${MAX_SITES_PER_BATCH} sites at once. You picked ${siteIds.length}.`);
    }
    const mode = ["auto", "replace", "new"].includes(String(form.get("mode"))) ? String(form.get("mode")) : "auto";
    const bytes = new Uint8Array(await file.arrayBuffer());
    const fileName = (file.name || "file").split("/").pop();

    const batchId = randomToken().slice(0, 16);
    await q(env, `INSERT INTO batches (id, who, file_name, mode, created_at) VALUES (?,?,?,?,?)`,
      batchId, me.username, fileName, mode, nowIso()).run();

    // The ids coming from the panel are HEROKU APP ids. Resolve each to the
    // repo it deploys from; an app with no repo cannot receive a file, and says so.
    const targets = [];
    const repoIds = [];
    for (const id of siteIds) {
      const app = await q(env,
        `SELECT a.id, a.label, a.heroku_name, a.repo_id FROM apps a WHERE a.id=?`, id).first();
      if (!app) continue;
      if (!app.repo_id) {
        await q(env, `INSERT INTO batch_targets (batch_id, repo_id, app_id, status, detail, finished_at)
                      VALUES (?,?,?,'failed',?,?)`,
          batchId, -app.id, app.id,
          "This app has no repository linked yet — link one in Settings, then try again.", nowIso()).run();
        targets.push({ site_id: String(app.id), label: app.heroku_name, status: "failed" });
        continue;
      }
      if (repoIds.includes(app.repo_id)) {
        await q(env, `INSERT INTO batch_targets (batch_id, repo_id, app_id, status, detail, finished_at)
                      VALUES (?,?,?,'skipped',?,?)`,
          batchId, -app.id, app.id,
          "Another selected app already deploys from the same repository.", nowIso()).run();
        targets.push({ site_id: String(app.id), label: app.heroku_name, status: "skipped" });
        continue;
      }
      repoIds.push(app.repo_id);
      await q(env, `INSERT INTO batch_targets (batch_id, repo_id, app_id, status) VALUES (?,?,?,'committing')`,
        batchId, app.repo_id, app.id).run();
      targets.push({ site_id: String(app.id), label: app.heroku_name, status: "committing" });
    }
    if (!repoIds.length && !targets.length) return err(env, request, "None of those apps could be found.");

    await logAction(env, me.username, "started a deploy", fileName,
      `${targets.length} app(s): ${targets.map((t) => t.label).join(", ")}`);

    // Answer immediately; the browser polls /api/batch/{id}.
    ctx.waitUntil(runBatch(env, batchId, repoIds, bytes, fileName, mode, me.username));
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
    const done = targets.every((r) => ["live", "failed", "no_app", "skipped"].includes(r.status));
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
      const tok = String(b.token || "").trim();
      if (!tok) return err(env, request, "No token given.");
      let account;
      try {
        account = kind === "github" ? await GH.verifyToken(tok, fetch) : await HK.verifyToken(tok, fetch);
      } catch (e) { return err(env, request, String(e.message || e)); }
      await q(env,
        `INSERT INTO connections (kind, label, token, account, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT (kind, label) DO UPDATE SET token=excluded.token, account=excluded.account`,
        kind, account, tok, account, nowIso()).run();
      await logAction(env, me.username, `connected a ${kind === "github" ? "GitHub" : "Heroku"} key`, account, null);
      // If this is the first pair of accounts, pair them and pull everything at once.
      const gs = (await q(env, `SELECT id FROM connections WHERE kind='github'`).all()).results || [];
      const hs = (await q(env, `SELECT id FROM connections WHERE kind='heroku'`).all()).results || [];
      let discovered = null;
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
    if (request.method === "DELETE" && seg[2]) {
      await q(env, `DELETE FROM connections WHERE id=?`, Number(seg[2])).run();
      return json(env, request, { ok: true });
    }
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
        out.push({ conn_id: c.id, account: c.account, error: String(e.message || e) });
      }
    }
    // The UI reads d.repos / d.apps; keep `items` too so either shape works.
    const shaped = out.map((o) => (o.name && !o.repo ? { ...o, repo: o.name } : o));
    return json(env, request, { items: shaped, repos: shaped, apps: shaped });
  }

  // ---- sites --------------------------------------------------------------
  if (route === "site") {
    if (request.method === "POST") {
      const b = await body();
      if (!b.owner || !b.repo) return err(env, request, "Pick a repository.");
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
      await q(env, `UPDATE apps SET repo_id=NULL WHERE repo_id=?`, Number(seg[2])).run();
      await q(env, `DELETE FROM repos WHERE id=?`, Number(seg[2])).run();
      return json(env, request, { ok: true });
    }
  }

  // ---- create / link ------------------------------------------------------
  if (route === "repo" && seg[2] === "create" && request.method === "POST") {
    const b = await body();
    const c = await soleConn(env, "github", b.conn_id);
    if (!c) return err(env, request, "Connect a GitHub account first.");
    try {
      const r = await GH.createRepo(c.token, String(b.name || "").trim(), b.private !== false, fetch);
      return json(env, request, r);
    } catch (e) { return err(env, request, String(e.message || e)); }
  }

  if (route === "app" && seg[2] === "create" && request.method === "POST") {
    const b = await body();
    const c = await soleConn(env, "heroku", b.conn_id);
    if (!c) return err(env, request, "Connect a Heroku account first.");
    try {
      const a = await HK.createApp(c.token, String(b.name || "").trim() || undefined, b.region || undefined, fetch);
      return json(env, request, a);
    } catch (e) { return err(env, request, String(e.message || e)); }
  }

  if (route === "link" && request.method === "POST") {
    const b = await body();
    // New shape: link a Heroku APP to the repo it deploys from.
    if (b.app_id !== undefined) {
      const app = await q(env, `SELECT id, heroku_name FROM apps WHERE id=?`, Number(b.app_id)).first();
      if (!app) return err(env, request, "That app is not in the list.");
      const repoId = b.repo_id ? Number(b.repo_id) : null;
      if (repoId) {
        const r = await q(env, `SELECT id, name FROM repos WHERE id=?`, repoId).first();
        if (!r) return err(env, request, "That repository is not in the list.");
        await q(env, `UPDATE apps SET repo_id=? WHERE id=?`, repoId, app.id).run();
        await logAction(env, me.username, "linked an app", app.heroku_name, `to ${r.name}`);
      } else {
        await q(env, `UPDATE apps SET repo_id=NULL WHERE id=?`, app.id).run();
        await logAction(env, me.username, "unlinked an app", app.heroku_name, null);
      }
      return json(env, request, { ok: true });
    }

    // Older shape kept working: link by repo id + heroku app name.
    const siteId = Number(b.site_id);
    const herokuName = b.heroku_name || b.app || null;
    if (!herokuName) {
      await q(env, `UPDATE apps SET repo_id=NULL WHERE repo_id=?`, siteId).run();
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

  // ---- repositories available to link ------------------------------------
  if (route === "repos") {
    const rows = (await q(env,
      `SELECT r.id, r.label, r.owner, r.name, r.branch, COALESCE(r.dir,'') AS dir, c.account
       FROM repos r LEFT JOIN connections c ON c.id = r.connection_id ORDER BY r.name`).all()).results || [];
    return json(env, request, { repos: rows.map((r) => ({ ...r, id: String(r.id) })) });
  }

  // ---- per-app settings (target folder, branch) ---------------------------
  if (route === "app" && seg[2] && seg[2] !== "create" && request.method === "PATCH") {
    const b = await body();
    const app = await q(env, `SELECT id, repo_id, heroku_name FROM apps WHERE id=?`, Number(seg[2])).first();
    if (!app) return err(env, request, "That app is not in the list.");
    if (!app.repo_id) return err(env, request, "Link a repository to this app first.");
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
    await q(env, `DELETE FROM sessions WHERE username=? AND token<>?`, me.username, me.token).run();
    return json(env, request, { ok: true });
  }

  return err(env, request, "Unknown request.", 404);
}

async function undoBatch(env, batchId, oldTargets, who) {
  for (const t of oldTargets) {
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
      await setT("build_id=?, build_url=?, status='building'", build.id, app.web_url || null);
    } catch (e) {
      await setT("status='failed', detail=?, finished_at=?", String(e.message || e).slice(0, 400), nowIso());
    }
  }
}
