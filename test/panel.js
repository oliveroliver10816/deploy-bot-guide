/**
 * Panel API tests. Drives the real Worker fetch handler over /api/* against a
 * real SQLite database and a mock network. No live credentials anywhere.
 */
import worker from "../worker/worker.js";
import { createUser, runMigrations } from "../worker/lib/panel.js";
import { makeDB, makeSessionDB, makeNet, makeCtx } from "./harness.js";

const ORIGIN = "https://ail.com.de";

let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ""}`); }
};

function newEnv(netOpts = {}) {
  const { net, calls, state } = makeNet(netOpts);
  globalThis.fetch = net;
  return {
    env: { DB: makeDB(), PANEL_ORIGIN: ORIGIN, TELEGRAM_BOT_TOKEN: "T", OWNER_ID: "1", WEBHOOK_SECRET: "s" },
    calls, state,
  };
}

async function call(h, method, path, { token, json, form, origin = ORIGIN } = {}) {
  const headers = { Origin: origin };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
  if (form) body = form;
  const { ctx, settle } = makeCtx();
  const res = await worker.fetch(
    new Request(`https://w${path}`, { method, headers, body }), h.env, ctx
  );
  await settle();
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed, headers: res.headers };
}

/**
 * Wire a panel the way the owner actually does now: create the two accounts,
 * paste one GitHub key and one Heroku key. Everything else — pairing the two,
 * pulling his Heroku apps and GitHub repos, and matching them by name — is
 * supposed to happen on its own.
 */
async function setup(h) {
  await call(h, "GET", "/api/state");
  await createUser(h.env, "master1", "masterpass1", "master");
  await createUser(h.env, "va1", "vapassword1", "va");
  const m = (await call(h, "POST", "/api/login", { json: { username: "master1", password: "masterpass1" } })).body.session;
  await call(h, "POST", "/api/token", { token: m, json: { kind: "github", token: "ghp_x" } });
  await call(h, "POST", "/api/token", { token: m, json: { kind: "heroku", token: "hk_x" } });
  const st = (await call(h, "GET", "/api/state", { token: m })).body;
  const byName = Object.fromEntries((st.sites || []).map((x) => [x.label, x]));
  const v = (await call(h, "POST", "/api/login", { json: { username: "va1", password: "vapassword1" } })).body.session;
  return { m, v, st, byName };
}

/** Link a repo to an app and give it a folder, so it can receive a file. */
async function ready(h, m, byName, appName, repoName = "site-one", dir = "public") {
  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  const repo = repos.find((r) => r.name === repoName);
  await call(h, "POST", "/api/link", { token: m, json: { app_id: byName[appName].id, repo_id: repo.id } });
  await call(h, "PATCH", `/api/app/${byName[appName].id}`, { token: m, json: { dir } });
  return byName[appName].id;
}

/** One file, or many: pass [{name, content, rel}] as `name`. */
const upload = (name, content, sites, mode = "auto") => {
  const f = new FormData();
  const items = Array.isArray(name) ? name : [{ name, content }];
  const rels = [];
  for (const it of items) {
    f.append("file", new File([it.content ?? ""], it.name));
    rels.push(it.rel || it.name);
  }
  f.append("paths", JSON.stringify(rels));
  f.append("sites", JSON.stringify(sites));
  f.append("mode", mode);
  return f;
};

console.log("\n── auth ──");
{
  const h = newEnv();
  await call(h, "GET", "/api/state");
  await createUser(h.env, "master1", "masterpass1", "master");

  let r = await call(h, "POST", "/api/login", { json: { username: "master1", password: "wrong" } });
  ok(r.status === 401, "wrong password is rejected");
  ok(!r.body.session, "no session handed out on failure");

  r = await call(h, "POST", "/api/login", { json: { username: "nobody", password: "x" } });
  ok(r.status === 401, "unknown user is rejected");

  r = await call(h, "POST", "/api/login", { json: { username: "master1", password: "masterpass1" } });
  ok(r.status === 200 && !!r.body.session, "correct password returns a session");
  ok(r.body.role === "owner", "role comes back with the session, using the outward name");

  const t = r.body.session;
  ok((await call(h, "GET", "/api/state")).status === 401, "no token = 401");
  ok((await call(h, "GET", "/api/state", { token: "garbage" })).status === 401, "bad token = 401");
  ok((await call(h, "GET", "/api/state", { token: t })).status === 200, "good token works");

  await call(h, "POST", "/api/logout", { token: t });
  ok((await call(h, "GET", "/api/state", { token: t })).status === 401, "logout kills the session");

  // password hash must not be recoverable from the API
  const row = await h.env.DB.prepare("SELECT pass_hash, salt FROM panel_users WHERE username='master1'").first();
  ok(row.pass_hash !== "masterpass1" && row.pass_hash.length > 20, "password is stored hashed, not in the clear");
  ok(!!row.salt, "each password has a salt");
}

console.log("\n── brute force ──");
{
  const h = newEnv();
  await call(h, "GET", "/api/state");
  await createUser(h.env, "master1", "masterpass1", "master");
  let last;
  for (let i = 0; i < 12; i++) {
    last = await call(h, "POST", "/api/login", { json: { username: "master1", password: "nope" } });
  }
  ok(last.status === 429, "repeated failures get rate limited");
  const good = await call(h, "POST", "/api/login", { json: { username: "master1", password: "masterpass1" } });
  ok(good.status === 429, "lockout applies even to the correct password");
}

console.log("\n── CORS ──");
{
  const h = newEnv();
  const pre = await call(h, "OPTIONS", "/api/login");
  ok(pre.status === 204, "preflight answered");
  ok(pre.headers.get("Access-Control-Allow-Origin") === ORIGIN, "allows the panel origin");
  ok(pre.headers.get("Access-Control-Max-Age") === "86400", "preflight cached 24h so actions cost no extra handshake");
  const other = await call(h, "OPTIONS", "/api/login", { origin: "https://evil.example" });
  ok(other.headers.get("Access-Control-Allow-Origin") !== "https://evil.example", "another origin is not echoed back");
}

console.log("\n── roles: the VA runs the panel ──");
{
  const h = newEnv();
  const { m, v } = await setup(h);
  ok((await call(h, "GET", "/api/state", { token: v })).status === 200, "VA can read state");

  // Bob's instruction: minimal involvement from him, so the VA may do the work.
  for (const [method, path, json] of [
    ["POST", "/api/token", { kind: "github", token: "ghp_x" }],
    ["GET", "/api/discover/repos", undefined],
    ["POST", "/api/refresh", {}],
  ]) {
    const r = await call(h, method, path, { token: v, json });
    ok(r.status === 200, `VA may ${method} ${path}`, `got ${r.status}`);
  }

  // ...except adding or removing people, which could remove the owner himself.
  const u1 = await call(h, "POST", "/api/user", { token: v, json: { username: "eve", password: "password123", role: "master" } });
  ok(u1.status === 403, "VA cannot add people");
  const u2 = await call(h, "DELETE", "/api/user/master1", { token: v });
  ok(u2.status === 403, "VA cannot remove people");

  // Tokens must never be readable through the API, by anyone.
  const st = JSON.stringify((await call(h, "GET", "/api/state", { token: m })).body);
  ok(!st.includes("ghp_x") && !st.includes("hk_x"), "API never returns the stored GitHub/Heroku tokens");

  const me = (await call(h, "GET", "/api/me", { token: m })).body;
  ok(me.role === "owner", "the owner is reported as owner, not as a VA");
  const users = (await call(h, "GET", "/api/state", { token: m })).body.users;
  ok(users.find((u) => u.username === "master1").role === "owner",
     "the People list shows the owner as owner");
  ok(users.find((u) => u.username === "va1").role === "va", "and the VA as va");
}

console.log("\n── auto-discovery from the keys alone ──");
{
  const h = newEnv();
  const { m, st, byName } = await setup(h);
  ok(st.sites.length === 3, "every Heroku app is pulled in automatically", `got ${st.sites.length}`);
  ok(!!byName["app-one"] && !!byName["site-one"], "apps are listed by their Heroku name");
  ok(byName["site-one"].linked === true, "an app whose name matches a repo is linked automatically");
  ok(byName["app-one"].linked === false, "an app with no matching repo is flagged as needing one");
  ok(st.needs.unlinked === 2, "the panel reports how many still need a repo", String(st.needs.unlinked));
  ok(st.combos.length === 1, "the first GitHub + Heroku keys are paired automatically");
  ok(st.combos[0].apps === 3, "the pairing knows how many apps it brought in", String(st.combos[0].apps));
  ok(byName["site-one"].url.includes("herokuapp.com"), "the Heroku URL is used, not an invented domain");

  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  ok(repos.length === 2, "repos are pulled too, ready to link", String(repos.length));

  // linking the rest is one call per app
  const lk = await call(h, "POST", "/api/link", { token: m, json: { app_id: byName["app-one"].id, repo_id: repos.find(r => r.name === "site-two").id } });
  ok(lk.status === 200, "an app can be linked to a repo");
  const after = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(after.sites.find((x) => x.label === "app-one").linked === true, "the link shows up straight away");
  ok(after.needs.unlinked === 1, "the outstanding count drops");
}

console.log("\n── several account pairs at once ──");
{
  const h = newEnv();
  const { m } = await setup(h);
  // a second pair of accounts, added later
  h.state.ghUser = "second-gh";
  const r1 = await call(h, "POST", "/api/token", { token: m, json: { kind: "github", token: "ghp_second" } });
  ok(r1.status === 200, "a second GitHub account can be connected");
  const st = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(st.accounts.github.length === 2, "both GitHub accounts are kept", String(st.accounts.github.length));
  ok(st.combos.length === 1, "a second account does not silently re-pair the first");
  // Pick by NAME, never by index: the lists are newest-first now, so position
  // is not identity. An index here would have silently tested the wrong account.
  const second = st.accounts.github.find((a) => a.account === "second-gh");
  ok(!!second, "the newly connected account is in the list");

  const combo = await call(h, "POST", "/api/combo", { token: m, json: {
    github_conn_id: second.id, heroku_conn_id: st.accounts.heroku[0].id } });
  ok(combo.status === 200, "a new pair can be made explicitly", JSON.stringify(combo.body));
  const st2 = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(st2.combos.length === 2, "both pairs exist side by side", String(st2.combos.length));

  const dupe = await call(h, "POST", "/api/combo", { token: m, json: {
    github_conn_id: second.id, heroku_conn_id: st.accounts.heroku[0].id } });
  ok(dupe.status === 400 && /already paired/i.test(dupe.body.error), "the same pair cannot be made twice");
}

console.log("\n── deploy fan-out ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  // link the two unlinked apps so all three can receive a file
  await call(h, "POST", "/api/link", { token: m, json: { app_id: byName["app-one"].id, repo_id: repos.find(r => r.name === "site-two").id } });
  // give each linked repo a target folder
  await call(h, "PATCH", `/api/app/${byName["site-one"].id}`, { token: m, json: { dir: "public" } });
  await call(h, "PATCH", `/api/app/${byName["app-one"].id}`, { token: m, json: { dir: "public" } });

  h.calls.length = 0;
  const r = await call(h, "POST", "/api/deploy", { token: m,
    form: upload("index.html", "<new>new page</new>", [byName["site-one"].id, byName["app-one"].id]) });
  ok(r.status === 200 && !!r.body.batch, "deploy returns a batch id immediately");
  ok(r.body.targets.length === 2, "both apps are queued", JSON.stringify(r.body.targets));

  const commits = h.calls.filter((c) => c.method === "POST" && c.url.endsWith("/git/commits"));
  ok(commits.length === 2, "one commit per selected app", `saw ${commits.length}`);
  const blobs = h.state.blobsWritten.slice(-2);
  ok(blobs.every((b) => Buffer.from(b.content, "base64").toString() === "<new>new page</new>"),
     "the same exact bytes went to every app's repo");
  const trees = h.state.treesWritten.slice(-2);
  ok(trees.every((t) => t.tree.every((e) => e.path === "public/index.html")),
     "each used its own configured folder", JSON.stringify(trees.map((t) => t.tree.map((e) => e.path))));

  const st = await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  ok(st.body.targets.every((t) => ["building", "live", "no_app"].includes(t.status)),
     "targets move past committing", JSON.stringify(st.body.targets.map(t => t.status)));
  ok(st.body.targets.every((t) => typeof t.site_id === "string"), "batch site_id is a string");
  ok(st.body.targets.map((t) => t.label).sort().join(",") === "app-one,site-one",
     "results are labelled by Heroku app name", st.body.targets.map(t => t.label).join(","));

  const build = h.calls.find((c) => c.url.includes("/builds") && c.method === "POST");
  ok(!!build && JSON.parse(build.body).source_blob.url.includes("codeload.github.com"),
     "Heroku gets the signed GitHub URL, so repo contents never transit the Worker");

  // GitHub caches BRANCH archives, so a branch tarball taken right after a push
  // can be the previous snapshot. The archive must be pinned to the new commit.
  const tarReq = h.calls.find((c) => c.url.includes("/tarball/"));
  ok(!!tarReq && tarReq.url.endsWith("/tarball/commitNEW"),
     "the build archive is pinned to the commit just made, not to the branch",
     tarReq ? tarReq.url : "no tarball request");
}

console.log("\n── many files and folders at once ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  const a1 = await ready(h, m, byName, "site-one", "site-one");
  h.state.blobsWritten.length = 0; h.state.commitsWritten.length = 0; h.state.treesWritten.length = 0;

  const r = await call(h, "POST", "/api/deploy", { token: m, form: upload([
    { name: "index.html", content: "<h1>home</h1>" },
    { name: "style.css",  content: "body{}", rel: "assets/style.css" },
    { name: "app.js",     content: "//js",   rel: "assets/js/app.js" },
  ], null, [a1]) });
  ok(r.status === 200, "several files and a folder can be sent together", JSON.stringify(r.body).slice(0, 120));
  ok(h.state.commitsWritten.length === 1, "as ONE commit, not one per file", String(h.state.commitsWritten.length));
  ok(h.state.blobsWritten.length === 3, "every file is stored", String(h.state.blobsWritten.length));
  const paths = h.state.treesWritten[0].tree.map((x) => x.path).sort();
  ok(paths.join(",") === "public/assets/js/app.js,public/assets/style.css,public/index.html",
     "the folder structure is kept under the app's target folder", paths.join(","));

  const builds = h.calls.filter((c) => c.url.includes("/builds") && c.method === "POST");
  ok(builds.length === 1, "and it triggers a single build", String(builds.length));

  const st = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(/3 files/.test(st.recent[0].file), "the activity list says how many files went", String(st.recent[0].file));

  const bad = await call(h, "POST", "/api/deploy", { token: m, form: upload([
    { name: "x.html", content: "x", rel: "../../escape.html" }], null, [a1]) });
  const bst = await call(h, "GET", `/api/batch/${bad.body.batch}`, { token: m });
  ok(bst.body.targets[0].status === "failed" && /Invalid path/i.test(bst.body.targets[0].detail || ""),
     "a path that escapes the repo is refused", bst.body.targets[0].detail || "");
}

console.log("\n── an app with no repo ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  const r = await call(h, "POST", "/api/deploy", { token: m, form: upload("index.html", "x", [byName["app-two"].id]) });
  const st = await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  ok(st.body.targets[0].status === "failed", "an unlinked app fails rather than silently doing nothing");
  ok(/no repo linked/i.test(st.body.targets[0].detail || ""), "and says exactly what to do",
     st.body.targets[0].detail || "");
  ok(st.body.targets[0].label === "app-two", "the failure is labelled with the app name");
}

console.log("\n── two apps sharing one repo ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  const one = repos.find((x) => x.name === "site-one").id;
  await call(h, "POST", "/api/link", { token: m, json: { app_id: byName["app-one"].id, repo_id: one } });
  const r = await call(h, "POST", "/api/deploy", { token: m,
    form: upload("index.html", "x", [byName["site-one"].id, byName["app-one"].id]) });
  const st = await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  const skipped = st.body.targets.filter((t) => t.status === "skipped");
  ok(skipped.length === 1, "the second app on the same repo is skipped, not committed twice",
     JSON.stringify(st.body.targets.map(t => [t.label, t.status])));
  ok(/same repo/i.test(skipped[0].detail || ""), "and the reason is stated");
}

console.log("\n── repo files ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  const app = byName["site-one"].id;

  const t = (await call(h, "GET", `/api/files/${app}`, { token: m })).body;
  ok(Array.isArray(t.entries) && t.entries.length === 5, "the whole repo tree is listed", String(t.entries?.length));
  ok(t.entries.some((e) => e.type === "tree" && e.path === "assets"), "folders appear as folders");
  ok(t.buildpack === null, "a repo of plain HTML is reported as having NO buildpack — the exact cause of 'No default language could be detected'");

  // one commit for many files, however many are sent
  h.state.blobsWritten.length = 0; h.state.commitsWritten.length = 0;
  const many = await call(h, "POST", `/api/files/${app}`, { token: m, json: { files: [
    { path: "a.html", contentB64: Buffer.from("<h1>a</h1>").toString("base64") },
    { path: "css/b.css", contentB64: Buffer.from("body{}").toString("base64") },
    { path: "css/img/c.txt", contentB64: Buffer.from("c").toString("base64") },
  ] } });
  ok(many.status === 200 && many.body.changed === 3, "a whole folder of files uploads at once", JSON.stringify(many.body));
  ok(h.state.commitsWritten.length === 1, "as ONE commit, not one per file", String(h.state.commitsWritten.length));
  ok(h.state.blobsWritten.length === 3, "each file is stored");

  // deleting a folder removes every file beneath it
  h.state.treesWritten.length = 0;
  const del = await call(h, "POST", `/api/files/${app}`, { token: m, json: { remove: ["assets"] } });
  ok(del.status === 200 && del.body.removed === 2, "deleting a folder removes every file inside it", JSON.stringify(del.body));
  const nulls = (h.state.treesWritten[0]?.tree || []).filter((x) => x.sha === null).map((x) => x.path).sort();
  ok(nulls.join(",") === "assets/app.css,assets/logo.png", "by path, not by guessing", nulls.join(","));

  const one = await call(h, "POST", `/api/files/${app}`, { token: m, json: { remove: ["index.html"] } });
  ok(one.status === 200 && one.body.removed === 1, "a single file can be deleted too");

  const bad = await call(h, "POST", `/api/files/${app}`, { token: m, json: { files: [
    { path: "../../etc/passwd", contentB64: "eA==" } ] } });
  ok(bad.status === 400 && /Invalid path/i.test(bad.body.error), "a path that escapes the repo is refused");

  const gone = await call(h, "POST", `/api/files/${app}`, { token: m, json: { remove: ["nothing-here"] } });
  ok(gone.status === 400, "removing something that is not there says so");

  const nolink = await call(h, "GET", `/api/files/${byName["app-two"].id}`, { token: m });
  ok(nolink.status === 400 && /Link a repo/i.test(nolink.body.error), "an app with no repo explains itself");
}

console.log("\n── creating things must say WHERE ──");
{
  const h = newEnv();
  const { m } = await setup(h);
  // a second GitHub account, so "which one?" becomes a real question
  h.state.ghUser = "second-gh";
  await call(h, "POST", "/api/token", { token: m, json: { kind: "github", token: "ghp_second" } });
  const st = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(st.accounts.github.length === 2, "two GitHub accounts are connected", String(st.accounts.github.length));

  const blind = await call(h, "POST", "/api/repo/create", { token: m, json: { name: "somewhere" } });
  ok(blind.status === 400 && /which GitHub account/i.test(blind.body.error),
     "creating a repo without saying where is refused, and says so plainly", blind.body.error);

  const second = st.accounts.github.find((a) => a.account === "second-gh");
  const chosen = await call(h, "POST", "/api/repo/create", { token: m,
    json: { name: "clear-repo", conn_id: second.id } });
  ok(chosen.status === 200, "naming the account works");
  ok(chosen.body.account === "second-gh", "and the reply says which account it landed in", JSON.stringify(chosen.body));
  ok(chosen.body.private === true, "repos are created PRIVATE by default", String(chosen.body.private));

  const logs = (await call(h, "GET", "/api/logs", { token: m })).body.entries;
  ok(logs.some((l) => /created a repo/.test(l.action) && /second-gh/.test(l.detail || "")),
     "and the activity log records where it was created");
}

console.log("\n── the deploy screen warns BEFORE you open Files ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  // straight after connecting keys, with nothing else touched
  const st = (await call(h, "GET", "/api/state", { token: m })).body;
  const linked = st.sites.filter((x) => x.linked);
  ok(linked.length >= 1, "there is a linked app to judge", String(linked.length));
  ok(linked.every((x) => x.buildpack === null && x.buildpack_checked === true),
     "a linked app is CHECKED and reports nothing detected, on the deploy screen",
     JSON.stringify(linked.map((x) => [x.label, x.buildpack, x.buildpack_checked])));
  const unlinked = st.sites.filter((x) => !x.linked);
  ok(unlinked.every((x) => x.buildpack_checked === false),
     "an app with no repo is not judged at all", JSON.stringify(unlinked.map((x) => x.buildpack_checked)));

  // a freshly linked app must NOT be accused before anything has looked at it
  await h.env.DB.prepare("UPDATE apps SET buildpack=NULL").run();
  const fresh = (await call(h, "GET", "/api/state", { token: m })).body.sites.filter((x) => x.linked);
  ok(fresh.every((x) => x.buildpack_checked === false),
     "an app that has not been looked at yet is not reported as unbuildable",
     JSON.stringify(fresh.map((x) => [x.label, x.buildpack, x.buildpack_checked])));

  // once it can build, the deploy screen stops warning
  h.state.gitTree = [{ path: "index.php", type: "blob", size: 36, sha: "x" }];
  await call(h, "POST", "/api/refresh", { token: m, json: {} });
  const st2 = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(st2.sites.filter((x) => x.linked).every((x) => x.buildpack === "php"),
     "and reports php once it can build", JSON.stringify(st2.sites.map((x) => x.buildpack)));
}

console.log("\n── changing files must actually publish ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  const app = byName["site-one"].id;
  h.calls.length = 0;
  const r = await call(h, "POST", `/api/files/${app}`, { token: m, json: { files: [
    { path: "index.html", contentB64: Buffer.from("<h1>edited</h1>").toString("base64") } ] } });
  ok(r.status === 200, "the edit commits");
  const builds = h.calls.filter((c) => c.url.includes("/builds") && c.method === "POST");
  ok(builds.length === 1, "and the app is rebuilt, so the live site actually changes", String(builds.length));
  ok(r.body.build && r.body.build.id, "the reply says a build started", JSON.stringify(r.body.build));

  const logs = (await call(h, "GET", "/api/logs", { token: m })).body.entries;
  ok(logs.some((l) => /rebuilt after a file change/.test(l.action)), "and it is recorded");
}

console.log("\n── read replicas: a session must route reads away from the primary ──");
{
  // The database's home region is US-East. Replication only helps if the Worker
  // opens a SESSION; without it every query still crosses to the primary and
  // turning replication on changes nothing at all.
  const sdb = makeSessionDB();
  const h = newEnv();
  h.env.DB = sdb;
  const { m } = await setup(h);

  sdb._sessions.length = 0;
  const r = await call(h, "GET", "/api/state", { token: m });
  ok(r.status === 200, "a read still works through a session");
  ok(sdb._sessions.length > 0, "a session was opened for the read");
  ok(sdb._sessions[0].start === "first-unconstrained",
     "a first read may be served by the nearest replica", String(sdb._sessions[0].start));
  const mark = r.headers.get("X-D1-Bookmark");
  ok(!!mark, "the reply carries a bookmark", String(mark));

  sdb._sessions.length = 0;
  await call(h, "POST", "/api/refresh", { token: m });
  ok(sdb._sessions[0] && sdb._sessions[0].start === "first-primary",
     "but a write goes to the primary", String(sdb._sessions[0] && sdb._sessions[0].start));

  // read-your-writes: the browser sends the bookmark back and the next read
  // starts from it, so it cannot be served something older than its own change
  sdb._sessions.length = 0;
  const { ctx, settle } = makeCtx();
  const res = await worker.fetch(new Request("https://w/api/state", {
    headers: { Origin: ORIGIN, Authorization: `Bearer ${m}`, "X-D1-Bookmark": "bm-42" } }),
    h.env, ctx);
  await settle(); await res.text();
  ok(sdb._sessions[0] && sdb._sessions[0].start === "bm-42",
     "a returning bookmark is honoured, so you always see your own change",
     String(sdb._sessions[0] && sdb._sessions[0].start));

  const cors = res.headers.get("Access-Control-Expose-Headers") || "";
  ok(/X-D1-Bookmark/i.test(cors), "and the browser is allowed to read it", cors);
}

console.log("\n── an older runtime without Sessions must still work ──");
{
  const h = newEnv();             // plain shim: no withSession at all
  const { m } = await setup(h);
  const r = await call(h, "GET", "/api/state", { token: m });
  ok(r.status === 200, "the panel works unchanged where replicas are unavailable");
  ok(!r.headers.get("X-D1-Bookmark"), "and simply sends no bookmark");
}

console.log("\n── a GitHub refusal must say what to do about it ──");
{
  // Real incident: uploading s.js to alaelder returned "The server had a problem
  // (500) — please try again in a moment." The truth was a fine-grained token
  // without Contents:Write, which will refuse every retry forever.
  const h = newEnv({ ghBlobStatus: 403 });
  const { m, byName } = await setup(h);
  const app = byName["site-one"].id;
  const r = await call(h, "POST", `/api/files/${app}`, { token: m, json: { files: [
    { path: "s.js", contentB64: Buffer.from("console.log(1)").toString("base64") } ] } });

  ok(r.status !== 500, "it is not reported as a server fault", String(r.status));
  ok(r.status === 409, "it is a 409, so the panel shows the reason", String(r.status));
  const msg = String((r.body && r.body.error) || "");
  ok(/Contents: Read and write/i.test(msg), "the message names the permission to grant", msg);
  ok(/owner\/site-one|site-one/.test(msg), "and names the repo", msg);
  ok(!/try again in a moment/i.test(msg), "and never tells him to just retry", msg);

  const logs = (await call(h, "GET", "/api/logs", { token: m })).body.entries;
  ok(logs.some((l) => /could not write files/.test(l.action)), "the refusal is recorded");
}

console.log("\n── a refresh must not re-read repos that have not changed ──");
{
  // Reading a repo's file list costs three GitHub calls and downloads
  // every path in it. Doing that for every linked app on every refresh is what
  // made the button slow, and almost every refresh finds nothing has moved.
  const h = newEnv();
  const { m } = await setup(h);

  // setup() already refreshed once, so start from "never looked at these"
  h.env.DB._raw.exec("UPDATE apps SET buildpack_sha=NULL, buildpack=NULL");
  h.calls.length = 0;
  await call(h, "POST", "/api/refresh", { token: m });
  const trees1 = h.calls.filter((c) => /\/git\/trees\//.test(c.url)).length;
  const heads1 = h.calls.filter((c) => /\/git\/ref\/heads\//.test(c.url)).length;
  ok(trees1 > 0, "the first refresh does read the file lists", String(trees1));

  h.calls.length = 0;
  await call(h, "POST", "/api/refresh", { token: m });
  const trees2 = h.calls.filter((c) => /\/git\/trees\//.test(c.url)).length;
  const heads2 = h.calls.filter((c) => /\/git\/ref\/heads\//.test(c.url)).length;
  ok(trees2 === 0, "the second one reads none of them again", `${trees1} -> ${trees2}`);
  ok(heads2 > 0, "it just asks where each branch is now", String(heads2));
  ok(heads2 <= heads1, "and that is one small call per app", `${heads1} -> ${heads2}`);

  // the database work must also collapse: no per-repo lookup storm
  const before = h.env.DB._raw.prepare("SELECT COUNT(*) n FROM repos").get().n;
  await call(h, "POST", "/api/refresh", { token: m });
  const after = h.env.DB._raw.prepare("SELECT COUNT(*) n FROM repos").get().n;
  ok(after === before, "a repeat refresh does not duplicate repos", `${before} -> ${after}`);

  // ...but a repo that HAS moved must still be looked at properly
  h.state.gitRefSha = "commitMOVED";
  h.calls.length = 0;
  await call(h, "POST", "/api/refresh", { token: m });
  const trees3 = h.calls.filter((c) => /\/git\/trees\//.test(c.url)).length;
  ok(trees3 > 0, "a repo that moved is read again", String(trees3));
}

console.log("\n── a refresh can target ONE pair (the progressive refresh) ──");
{
  // v12: the browser fires one /api/refresh per pair, in parallel, and paints
  // each answer as it lands. That only works if {combo_id} genuinely narrows
  // the work to that pair — and leaves the plain call exactly as it was.
  const h = newEnv();
  const { m } = await setup(h);

  // a second pair: a new GitHub account and a new Heroku account, paired
  h.state.ghUser = "second-gh";
  await call(h, "POST", "/api/token", { token: m, json: { kind: "github", token: "ghp_second" } });
  h.state.hkUser = "second-hk@example.com";
  await call(h, "POST", "/api/token", { token: m, json: { kind: "heroku", token: "hk_second" } });
  const st = (await call(h, "GET", "/api/state", { token: m })).body;
  const g2 = st.accounts.github.find((a) => a.account === "second-gh");
  const h2 = st.accounts.heroku.find((a) => a.account === "second-hk@example.com");
  await call(h, "POST", "/api/combo", { token: m, json: { github_conn_id: g2.id, heroku_conn_id: h2.id } });
  const combos = (await call(h, "GET", "/api/state", { token: m })).body.combos;
  ok(combos.length === 2, "two pairs exist side by side", String(combos.length));
  // by conn id, never by position — the list is newest-first
  const second = combos.find((c) => String(c.github_conn_id) === String(g2.id));
  const first = combos.find((c) => String(c.github_conn_id) !== String(g2.id));
  ok(!!second && !!first, "both pairs are identifiable");

  const auths = () => h.calls
    .filter((c) => /api\.github\.com|api\.heroku\.com/.test(c.url))
    .map((c) => String((c.init.headers || {}).Authorization || ""));

  // narrow: only the second pair's keys may touch the network
  h.calls.length = 0;
  const r1 = await call(h, "POST", "/api/refresh", { token: m, json: { combo_id: second.id } });
  ok(r1.status === 200, "a one-pair refresh answers 200", String(r1.status));
  for (const k of ["apps", "repos", "linked", "errors", "skipped", "checked"])
    ok(k in r1.body, `the one-pair summary carries "${k}"`, JSON.stringify(r1.body));
  const a1 = auths();
  ok(a1.some((x) => /ghp_second|hk_second/.test(x)), "the named pair's keys are used", a1.join(", "));
  ok(!a1.some((x) => /ghp_x|hk_x/.test(x)),
     "and the OTHER pair's keys never touch the network", a1.join(", "));

  // the log names the pair, so a fanned-out refresh stays readable
  const logs1 = (await call(h, "GET", "/api/logs", { token: m })).body.entries;
  ok(logs1.some((l) => /refreshed accounts/.test(l.action) && /second-gh/.test(l.target || "")),
     "the log row names which pair was refreshed",
     JSON.stringify(logs1.filter((l) => /refreshed accounts/.test(l.action)).map((l) => l.target)));

  // a pair that is gone answers kindly, not with a blank 500
  const gone = await call(h, "POST", "/api/refresh", { token: m, json: { combo_id: 999999 } });
  ok(gone.status === 404, "a vanished pair is a 404", String(gone.status));
  ok(/no longer there/i.test(String(gone.body && gone.body.error)),
     "and says so in plain words", JSON.stringify(gone.body));
  const junk = await call(h, "POST", "/api/refresh", { token: m, json: { combo_id: "abc" } });
  ok(junk.status === 400, "a nonsense pair id is refused", String(junk.status));

  // no combo_id: everything refreshes, exactly as before
  h.calls.length = 0;
  const all = await call(h, "POST", "/api/refresh", { token: m, json: {} });
  ok(all.status === 200, "the plain refresh still works", String(all.status));
  const a2 = auths();
  ok(a2.some((x) => /ghp_x|hk_x/.test(x)) && a2.some((x) => /ghp_second|hk_second/.test(x)),
     "and still asks every pair", a2.join(", "));
}

console.log("\n── every account change must leave a trace ──");
{
  // He asked whether a new user's activity is tracked. It is — but two changes
  // were completely silent, and they are the two worth explaining afterwards.
  const h = newEnv();
  const { m } = await setup(h);

  await call(h, "POST", "/api/user", { token: m,
    json: { username: "temp-helper", password: "abcd1234", role: "va" } });
  const del = await call(h, "DELETE", "/api/user/temp-helper", { token: m });
  ok(del.status === 200, "a person can be removed", String(del.status));

  const pw = await call(h, "POST", "/api/password", { token: m,
    json: { current: "masterpass1", next: "brandnewpass" } });
  ok(pw.status === 200, "and a password can be changed", JSON.stringify(pw.body));

  const log = (await call(h, "GET", "/api/logs", { token: m })).body.entries;
  const has = (re) => log.some((l) => re.test(l.action));
  ok(has(/added a person/), "adding a person is recorded");
  ok(has(/removed a person/), "removing one is recorded too",
     JSON.stringify(log.map((l) => l.action)));
  ok(has(/changed their password/), "so is a password change",
     JSON.stringify(log.map((l) => l.action)));

  const rm = log.find((l) => /removed a person/.test(l.action));
  ok(rm && rm.target === "temp-helper", "the removal names who was removed", JSON.stringify(rm));
  ok(rm && /va/.test(rm.detail || ""), "and what they were", JSON.stringify(rm && rm.detail));
}

console.log("\n── adding a person must not overwrite one ──");
{
  const h = newEnv();
  const { m } = await setup(h);
  const dupe = await call(h, "POST", "/api/user", { token: m,
    json: { username: "va1", password: "brandnewpass", role: "va" } });
  ok(dupe.status === 409 && /already someone called/i.test(dupe.body.error),
     "re-using a name is refused instead of silently resetting their password", dupe.body.error);
  const still = await call(h, "POST", "/api/login", { json: { username: "va1", password: "vapassword1" } });
  ok(still.status === 200, "and their original password still works");
}

console.log("\n── the Heroku buildpack trap ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  const app = byName["site-one"].id;

  h.state.commitsWritten.length = 0;
  const fix = await call(h, "POST", "/api/makedeployable", { token: m, json: { app_id: app } });
  ok(fix.status === 200 && fix.body.added === "index.php", "one click adds the index.php Heroku needs", JSON.stringify(fix.body));
  const wrote = h.state.blobsWritten.slice(-1)[0];
  ok(Buffer.from(wrote.content, "base64").toString().includes('include_once("index.html")'),
     "and it serves the existing index.html");

  // once a marker exists the buildpack is detected and nothing is added again
  h.state.gitTree = [{ path: "index.php", type: "blob", size: 36, sha: "x" },
                     { path: "index.html", type: "blob", size: 10, sha: "y" }];
  const again = await call(h, "POST", "/api/makedeployable", { token: m, json: { app_id: app } });
  ok(again.body.already === "php", "a repo that already builds is left alone", JSON.stringify(again.body));

  h.state.gitTree = [{ path: "package.json", type: "blob", size: 20, sha: "z" }];
  const t2 = (await call(h, "GET", `/api/files/${app}`, { token: m })).body;
  ok(t2.buildpack === "nodejs", "node projects are recognised");

  h.state.gitTree = [{ path: "notes.txt", type: "blob", size: 5, sha: "q" }];
  const t3 = (await call(h, "POST", "/api/makedeployable", { token: m, json: { app_id: app } }));
  ok(t3.status === 400 && /no index\.html/i.test(t3.body.error), "with no index.html it says so rather than committing junk");
}

console.log("\n── recent activity names where the file went ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  const a1 = await ready(h, m, byName, "site-one", "site-one");
  const a2 = await ready(h, m, byName, "app-one", "site-two");
  await call(h, "POST", "/api/deploy", { token: m, form: upload("home.html", "x", [a1, a2]) });
  const recent = (await call(h, "GET", "/api/state", { token: m })).body.recent;
  ok(recent.length >= 1, "the deploy shows up in recent activity");
  const r = recent[0];
  ok(r.file === "home.html", "the file name is shown", String(r.file));
  ok(typeof r.targets === "string" && r.targets.length > 0,
     "and WHERE it went is included, not just a batch id", JSON.stringify(r.targets));
  ok(r.targets.includes("site-one") && r.targets.includes("app-one"),
     "naming every app it was sent to", String(r.targets));
}

console.log("\n── activity log ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  await call(h, "PATCH", `/api/app/${byName["site-one"].id}`, { token: m, json: { dir: "public" } });
  await call(h, "POST", "/api/deploy", { token: m, form: upload("index.html", "x", [byName["site-one"].id]) });
  const logs = (await call(h, "GET", "/api/logs", { token: m })).body.entries;
  ok(Array.isArray(logs) && logs.length >= 4, "the log records what happened", String(logs.length));
  const actions = logs.map((l) => l.action);
  ok(actions.includes("signed in"), "sign-ins are logged");
  ok(actions.some((a) => /connected a GitHub key/i.test(a)), "connecting a key is logged");
  ok(actions.includes("paired accounts"), "pairing is logged");
  ok(actions.includes("sent a file") || actions.includes("started a deploy"), "deploys are logged");
  ok(logs.every((l) => !!l.actor), "every entry says who did it");
  ok(logs.every((l) => /^\d{4}-\d{2}-\d{2}T.*Z$/.test(l.at)),
     "timestamps are stored as UTC so the panel can render IST", logs[0] && logs[0].at);
  ok(logs[0].at >= logs[logs.length - 1].at, "newest first");
  const va = (await call(h, "POST", "/api/login", { json: { username: "va1", password: "vapassword1" } })).body.session;
  ok((await call(h, "GET", "/api/logs", { token: va })).status === 200, "the VA can read the log too");
}

console.log("\n── build polling ──");
{
  const h = newEnv({ buildStatus: "succeeded" });
  const { m, byName } = await setup(h);
  const s1 = await ready(h, m, byName, "site-one");
  const r = await call(h, "POST", "/api/deploy", { token: m, form: upload("index.html", "x", [s1]) });
  const { ctx, settle } = makeCtx();
  await worker.scheduled({}, h.env, ctx); await settle();
  const st = await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  ok(st.body.targets[0].status === "live", "successful build becomes live");
}
{
  const h = newEnv({ buildStatus: "failed" });
  const { m, byName } = await setup(h);
  const s1 = await ready(h, m, byName, "site-one");
  const r = await call(h, "POST", "/api/deploy", { token: m, form: upload("index.html", "x", [s1]) });
  const { ctx, settle } = makeCtx();
  await worker.scheduled({}, h.env, ctx); await settle();
  const st = await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  ok(st.body.targets[0].status === "failed", "failed build is reported failed");
  ok(/compiler error/.test(st.body.targets[0].detail || ""), "failure carries the build log tail");
}

console.log("\n── on-read build refresh (no cron) ──");
{
  const h = newEnv({ buildStatus: "succeeded" });
  const { m, byName } = await setup(h);
  const s1 = await ready(h, m, byName, "site-one");
  const r = await call(h, "POST", "/api/deploy", { token: m, form: upload("index.html", "x", [s1]) });
  // deliberately do NOT run worker.scheduled — reading the batch must refresh it
  const st = await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  ok(st.body.targets[0].status === "live", "reading the batch pulls live status, without waiting for cron");
  ok(st.body.done === true, "batch closes on the read");
}
{
  const h = newEnv({ buildStatus: "pending" });
  const { m, byName } = await setup(h);
  const s1 = await ready(h, m, byName, "site-one");
  const r = await call(h, "POST", "/api/deploy", { token: m, form: upload("index.html", "x", [s1]) });
  h.calls.length = 0;
  await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  const first = h.calls.filter((c) => c.url.includes("/builds/")).length;
  await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  const total = h.calls.filter((c) => c.url.includes("/builds/")).length;
  ok(first === 1, "first read polls Heroku once");
  ok(total === 1, "rapid re-reads are throttled, so fast UI polling cannot hammer Heroku", `saw ${total}`);
}

console.log("\n── undo a batch ──");
{
  const h = newEnv({ buildStatus: "succeeded" });
  const { m, byName } = await setup(h);
  const s1 = await ready(h, m, byName, "site-one", "site-one");
  const s2 = await ready(h, m, byName, "app-one", "site-two");
  const r = await call(h, "POST", "/api/deploy", { token: m, form: upload("index.html", "<new>new page</new>", [s1, s2]) });
  h.calls.length = 0;
  const u = await call(h, "POST", `/api/undo/${r.body.batch}`, { token: m });
  ok(u.status === 200 && u.body.batch !== r.body.batch, "undo starts its own batch");
  const puts = h.calls.filter((c) => c.method === "PUT" && c.url.includes("/contents/"));
  ok(puts.length === 2, "undo touches every site in the batch, not just one", `saw ${puts.length}`);
  ok(puts.every((p) => Buffer.from(JSON.parse(p.body).content, "base64").toString() === "<old>old page</old>"),
     "undo restores the exact previous bytes everywhere");
  const st = await call(h, "GET", `/api/batch/${u.body.batch}`, { token: m });
  ok(st.body.targets.length === 2, "undo batch reports per-site status too");
}

console.log("\n── limits ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  const id = await ready(h, m, byName, "site-one");

  const patched = await call(h, "PATCH", `/api/app/${id}`, { token: m, json: { dir: "/dist/" } });
  ok(patched.status === 200, "an app's target folder can be changed");
  const s2 = (await call(h, "GET", "/api/state", { token: m })).body.sites.find((x) => x.id === id);
  ok(s2.dir === "dist", "leading and trailing slashes are stripped from the folder");

  const noRepo = await call(h, "PATCH", `/api/app/${byName["app-two"].id}`, { token: m, json: { dir: "x" } });
  ok(noRepo.status === 400, "setting a folder on an app with no repo is refused with a reason");

  const many = await call(h, "POST", "/api/deploy", { token: m, form: upload("a.html", "x", Array.from({length: 11}, (_, i) => String(i + 1))) });
  ok(many.status === 400 && /10 apps at once/.test(many.body.error), "batch size is capped with a clear message");

  const none = await call(h, "POST", "/api/deploy", { token: m, form: upload("a.html", "x", []) });
  ok(none.status === 400 && /at least one/i.test(none.body.error), "deploying to nothing is refused");
}

console.log("\n── token handling ──");
{
  const h = newEnv();
  const { m } = await setup(h);
  const bad = await call(h, "POST", "/api/token", { token: m, json: { kind: "github", token: "" } });
  ok(bad.status === 400, "empty token refused");

  // a token the provider rejects must not be stored
  h.state.ghRepos = [];
  const before = (await call(h, "GET", "/api/state", { token: m })).body.accounts.github.length;
  ok(before === 1, "one github account stored from setup");

  const disc = await call(h, "GET", "/api/discover/repos", { token: m });
  ok(disc.status === 200 && Array.isArray(disc.body.items), "discover returns a list");
  ok(Array.isArray(disc.body.repos), "discover also exposes .repos, which is what the page reads");
  ok(disc.body.items.every((i) => i.repo || i.error), "each repo carries a .repo field for the page");
  ok(!disc.body.items.some((i) => i.full_name === "bob/site-one"), "already-registered repos are filtered out");
}

console.log("\n── password change ──");
{
  const h = newEnv();
  const { m } = await setup(h);
  let r = await call(h, "POST", "/api/password", { token: m, json: { old: "wrong", new: "brandnewpass" } });
  ok(r.status === 403, "wrong current password refused");
  r = await call(h, "POST", "/api/password", { token: m, json: { old: "masterpass1", new: "short" } });
  ok(r.status === 400, "too-short new password refused");
  r = await call(h, "POST", "/api/password", { token: m, json: { old: "masterpass1", new: "brandnewpass" } });
  ok(r.status === 200, "password changed");
  ok((await call(h, "POST", "/api/login", { json: { username: "master1", password: "brandnewpass" } })).status === 200,
     "new password works");
  ok((await call(h, "GET", "/api/state", { token: m })).status === 200, "the session that changed it stays valid");
}

console.log("\n── user management ──");
{
  const h = newEnv();
  const { m } = await setup(h);
  ok((await call(h, "DELETE", "/api/user/master1", { token: m })).status === 400, "cannot delete the account you are using");
  ok((await call(h, "POST", "/api/user", { token: m, json: { username: "ab", password: "longenough1", role: "va" } })).status === 400,
     "username minimum enforced");
  ok((await call(h, "POST", "/api/user", { token: m, json: { username: "va2", password: "short", role: "va" } })).status === 400,
     "password minimum enforced");
  ok((await call(h, "POST", "/api/user", { token: m, json: { username: "va2", password: "longenough1", role: "va" } })).status === 200,
     "VA can be added");
  ok((await call(h, "DELETE", "/api/user/va2", { token: m })).status === 200, "VA can be removed");
}

/* =======================================================================
   v10 — the log explains the BACKEND too, unlink, rename, newest first,
   and a deploy that can no longer hang for ever.
   ======================================================================= */

const logsOf = async (h, m, qs = "") => (await call(h, "GET", `/api/logs${qs}`, { token: m })).body;

console.log("\n── the log shows what the PANEL does, not only what a person does ──");
{
  const h = newEnv({ buildStatus: "succeeded" });
  const { m, byName } = await setup(h);
  const s1 = await ready(h, m, byName, "site-one", "site-one");
  await call(h, "POST", "/api/deploy", { token: m, form: upload("index.html", "x", [s1]) });
  const { ctx, settle } = makeCtx();
  await worker.scheduled({}, h.env, ctx); await settle();

  const all = await logsOf(h, m);
  const panel = all.entries.filter((l) => l.kind === "panel");
  const person = all.entries.filter((l) => l.kind === "person");
  ok(panel.length > 0, "the panel's own work is written down", String(panel.length));
  ok(person.length > 0, "and so is the human's", String(person.length));
  ok(all.entries.every((l) => l.kind === "panel" || l.kind === "person"),
     "every row says which of the two it is");

  const acts = panel.map((l) => l.action);
  ok(acts.includes("started a build"), "a build starting is backend work", acts.join(" | "));
  ok(acts.includes("a build finished"), "so is a build finishing", acts.join(" | "));
  ok((panel.find((l) => l.action === "a build finished") || {}).detail === "live",
     "and the outcome is recorded with it");
  ok(acts.includes("linked an app by itself"),
     "auto-linking during a refresh is backend work too", acts.join(" | "));
  ok(acts.includes("checked what Heroku will build"),
     "and so is buildpack detection", acts.join(" | "));
  ok(panel.every((l) => !!l.actor), "a backend row still says who or what did it");
  ok(person.some((l) => l.action === "signed in"), "the old person-actions are unchanged");

  // Nothing new may break a page written against the old response.
  const e0 = all.entries[0] || {};
  for (const k of ["at", "actor", "action", "target", "detail", "ok"]) {
    ok(k in e0, `the old '${k}' field is still there`);
  }
  ok(Array.isArray(all.entries), "the response is still {entries:[...]}");
  ok(typeof all.total === "number" && all.total >= all.entries.length,
     "and now says how many there are in total", String(all.total));
  ok(all.limit === 200, "the 200-row cap is stated", String(all.limit));
}

console.log("\n── every failure is recorded WITH the reason ──");
{
  // A GitHub key that cannot write. The reason must survive into the log, not
  // just onto the screen — this is the alaelder 500, one layer deeper.
  const h = newEnv({ ghBlobStatus: 403 });
  const { m, byName } = await setup(h);
  const app = byName["site-one"].id;
  await call(h, "POST", `/api/files/${app}`, { token: m, json: { files: [
    { path: "s.js", contentB64: Buffer.from("x").toString("base64") } ] } });

  const bad = (await logsOf(h, m, "?only=errors")).entries;
  const gh = bad.find((l) => /could not write files/.test(l.action)) || {};
  ok(!!gh.action, "the refusal is in the log", bad.map((l) => l.action).join(" | "));
  ok(gh.ok === 0, "marked as a failure", String(gh.ok));
  ok(/Contents: Read and write/i.test(gh.error || ""),
     "and the error says what to grant, not just what broke", gh.error || "");
  ok(!/try again in a moment/i.test(gh.error || ""), "never advice that cannot work");
  ok(gh.kind === "person", "a human pressed it, so it is a person row", gh.kind);
  ok(bad.every((l) => l.ok === 0), "?only=errors returns exactly the failures",
     JSON.stringify(bad.map((l) => [l.action, l.ok])));
  ok(bad.every((l) => !!l.error), "and every one of them carries a reason");
}
{
  // A Heroku build that fails. Nobody pressed anything: this is backend work.
  const h = newEnv({ buildStatus: "failed" });
  const { m, byName } = await setup(h);
  const s1 = await ready(h, m, byName, "site-one");
  await call(h, "POST", "/api/deploy", { token: m, form: upload("index.html", "x", [s1]) });
  const { ctx, settle } = makeCtx();
  await worker.scheduled({}, h.env, ctx); await settle();

  const bad = (await logsOf(h, m, "?only=errors")).entries;
  const build = bad.find((l) => l.action === "a build finished") || {};
  ok(!!build.action, "a failed build lands in the log", bad.map((l) => l.action).join(" | "));
  ok(build.kind === "panel", "as backend work", String(build.kind));
  ok(build.ok === 0, "marked as a failure", String(build.ok));
  ok(/compiler error/.test(build.error || ""),
     "carrying the tail of the build log, so the cause is readable", String(build.error));
  ok(!!build.ref, "and the batch it belongs to", String(build.ref));
  ok(bad.every((l) => l.ok === 0), "?only=errors still returns only failures");
}
{
  // A wrong password is a human error and must be explainable afterwards.
  const h = newEnv();
  const { m } = await setup(h);
  await call(h, "POST", "/api/login", { json: { username: "va1", password: "nope" } });
  const bad = (await logsOf(h, m, "?only=errors")).entries;
  const miss = bad.find((l) => l.action === "sign-in refused") || {};
  ok(miss.ok === 0, "a refused sign-in is recorded", bad.map((l) => l.action).join(" | "));
  ok(/Wrong password/i.test(miss.error || ""), "with why", String(miss.error));
  const dump = JSON.stringify(bad);
  ok(!dump.includes("nope"), "and never the password that was tried");
}

console.log("\n── reading the log: filters ──");
{
  const h = newEnv({ buildStatus: "succeeded" });
  const { m, byName } = await setup(h);
  const s1 = await ready(h, m, byName, "site-one", "site-one");
  await call(h, "POST", "/api/deploy", { token: m, form: upload("index.html", "x", [s1]) });
  const { ctx, settle } = makeCtx();
  await worker.scheduled({}, h.env, ctx); await settle();
  await call(h, "POST", "/api/login", { json: { username: "va1", password: "wrong" } });

  const all = await logsOf(h, m);
  const onlyPanel = await logsOf(h, m, "?kind=panel");
  const onlyPerson = await logsOf(h, m, "?kind=person");
  ok(onlyPanel.entries.every((l) => l.kind === "panel"), "?kind=panel returns backend rows only");
  ok(onlyPerson.entries.every((l) => l.kind === "person"), "?kind=person returns human rows only");
  ok(onlyPanel.entries.length + onlyPerson.entries.length === all.entries.length,
     "and the two together are the whole log",
     `${onlyPanel.entries.length}+${onlyPerson.entries.length} vs ${all.entries.length}`);
  ok(onlyPanel.total === onlyPanel.entries.length, "the total follows the filter");

  const errs = await logsOf(h, m, "?only=errors");
  ok(errs.entries.length > 0 && errs.entries.every((l) => l.ok === 0),
     "?only=errors returns exactly the failures", String(errs.entries.length));
  ok(errs.total === errs.entries.length, "counted under the same filter");

  const q1 = await logsOf(h, m, "?q=site-one");
  ok(q1.entries.length > 0, "?q= finds rows by app name", String(q1.entries.length));
  ok(q1.entries.every((l) => JSON.stringify(l).toLowerCase().includes("site-one")),
     "and only matching ones");
  const q2 = await logsOf(h, m, "?q=zzz-nothing-like-this");
  ok(q2.entries.length === 0 && q2.total === 0, "a search with no hits says so plainly");

  const both = await logsOf(h, m, "?kind=panel&only=errors");
  ok(both.entries.every((l) => l.kind === "panel" && l.ok === 0), "filters combine");

  const va = (await call(h, "POST", "/api/login", { json: { username: "va1", password: "vapassword1" } })).body.session;
  ok((await call(h, "GET", "/api/logs?only=errors", { token: va })).status === 200,
     "the VA can read the filtered log too");
}

console.log("\n── unbind an app from the wrong repo ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  const one = repos.find((r) => r.name === "site-one");
  const two = repos.find((r) => r.name === "site-two");
  const app = byName["app-one"].id;

  await call(h, "POST", "/api/link", { token: m, json: { app_id: app, repo_id: one.id } });
  let st = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(st.sites.find((x) => x.id === app).linked === true, "the app is linked to start with");

  // linking it again, somewhere else, must be allowed AND say what it replaced
  const relink = await call(h, "POST", "/api/link", { token: m, json: { app_id: app, repo_id: two.id } });
  ok(relink.status === 200, "an already-linked app can be pointed somewhere else");
  ok(relink.body.replaced === "bob/site-one", "the reply says what it replaced", JSON.stringify(relink.body.replaced));
  let logs = (await logsOf(h, m)).entries;
  const re = logs.find((l) => l.action === "re-linked an app") || {};
  ok(!!re.action, "and it is logged as a RE-link, not a plain link",
     logs.map((l) => l.action).join(" | "));
  ok(re.detail === "was bob/site-one -> bob/site-two", "naming both repos", String(re.detail));

  // Give the repo something Heroku can actually build, so the cached
  // judgement is a real value and clearing it is a real change. With an empty
  // buildpack the next assertion would pass whether or not anything happened.
  h.state.gitTree = [{ path: "package.json", type: "blob", size: 20, sha: "pj" }];
  await call(h, "POST", "/api/link", { token: m, json: { app_id: app, repo_id: two.id } });
  const beforeUnlink = (await call(h, "GET", "/api/state", { token: m })).body
    .sites.find((x) => x.id === app);
  ok(beforeUnlink.buildpack === "nodejs" && beforeUnlink.buildpack_checked === true,
     "the app is judged against the repo it points at", JSON.stringify(beforeUnlink.buildpack));

  const un = await call(h, "POST", "/api/unlink", { token: m, json: { app_id: app } });
  ok(un.status === 200, "an app can be unbound");
  ok(un.body.was === "bob/site-two", "the reply names what it used to point at", JSON.stringify(un.body.was));
  ok(un.body.app && un.body.app.linked === false, "and returns the app's new state",
     JSON.stringify(un.body.app));
  ok(un.body.app && un.body.app.repo === "" && un.body.app.owner === "", "with no repo on it");
  ok(un.body.app && un.body.app.buildpack === null && un.body.app.buildpack_checked === false,
     "and no leftover judgement from the repo it left", JSON.stringify(un.body.app));
  const stored = h.env.DB._raw.prepare(`SELECT buildpack FROM apps WHERE id=?`).get(Number(app));
  ok(stored.buildpack === null,
     "the cached buildpack is really cleared, not merely hidden by the missing link",
     JSON.stringify(stored));

  st = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(st.sites.find((x) => x.id === app).linked === false, "the link really is gone");
  ok(st.needs.unlinked === 2, "the outstanding count goes back up", String(st.needs.unlinked));

  logs = (await logsOf(h, m)).entries;
  const ul = logs.find((l) => l.action === "unlinked an app") || {};
  ok(/was bob\/site-two/.test(ul.detail || ""),
     "the unlink is logged with the repo it used to point at", ul && ul.detail);

  // NOTHING may be deleted — this only breaks the association
  const after = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  ok(after.length === repos.length, "no repo was deleted", `${after.length} vs ${repos.length}`);
  ok(st.sites.length === 3, "and no Heroku app was deleted", String(st.sites.length));

  const again = await call(h, "POST", "/api/unlink", { token: m, json: { app_id: app } });
  ok(again.status === 200 && again.body.already === true,
     "unbinding something already unbound is not an error", JSON.stringify(again.body));
  const nope = await call(h, "POST", "/api/unlink", { token: m, json: { app_id: 99999 } });
  ok(nope.status === 400, "unbinding an app that is not in the list says so");
}

console.log("\n── rename a file, and rename a whole folder ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  const app = byName["site-one"].id;
  // Never index straight into the last write: when a change does not happen at
  // all, the assertions below must FAIL and say so, not throw and hide the rest.
  const treeOfLastCommit = () => (h.state.treesWritten[h.state.treesWritten.length - 1] || {}).tree || [];
  const reset = () => {
    h.state.treesWritten.length = 0; h.state.commitsWritten.length = 0;
    h.state.blobsWritten.length = 0; h.calls.length = 0;
  };

  reset();
  const one = await call(h, "POST", `/api/files/${app}`, { token: m,
    json: { rename: [{ from: "index.html", to: "home.html" }] } });
  ok(one.status === 200, "a file can be renamed", JSON.stringify(one.body));
  ok(one.body.renamed === 1, "the reply counts what moved", String(one.body.renamed));
  let tree = treeOfLastCommit();
  const moved = tree.find((e) => e.path === "home.html") || null;
  ok(!!moved && moved.sha === "b2", "the SAME blob lands at the new path — the bytes are not re-uploaded",
     JSON.stringify(moved));
  ok(h.state.blobsWritten.length === 0, "so nothing was uploaded at all", String(h.state.blobsWritten.length));
  ok(tree.some((e) => e.path === "index.html" && e.sha === null), "and the old path is dropped");
  ok(h.state.commitsWritten.length === 1, "ONE commit", String(h.state.commitsWritten.length));
  ok(h.calls.filter((c) => c.url.includes("/builds") && c.method === "POST").length === 1,
     "and ONE build");

  reset();
  const folder = await call(h, "POST", `/api/files/${app}`, { token: m,
    json: { rename: [{ from: "assets", to: "static" }] } });
  ok(folder.status === 200, "a folder can be renamed", JSON.stringify(folder.body));
  tree = treeOfLastCommit();
  const added = tree.filter((e) => e.sha !== null).map((e) => e.path).sort();
  const dropped = tree.filter((e) => e.sha === null).map((e) => e.path).sort();
  ok(added.join(",") === "static/app.css,static/logo.png",
     "every file beneath it moves, expanded on the server", added.join(","));
  ok(dropped.join(",") === "assets/app.css,assets/logo.png", "and every old path goes", dropped.join(","));
  ok(h.state.commitsWritten.length === 1, "still ONE commit for the whole folder",
     String(h.state.commitsWritten.length));
  ok(h.calls.filter((c) => c.url.includes("/builds") && c.method === "POST").length === 1,
     "and still ONE build");

  const clash = await call(h, "POST", `/api/files/${app}`, { token: m,
    json: { rename: [{ from: "README.md", to: "index.html" }] } });
  ok(clash.status === 409, "renaming onto a file that exists is refused", String(clash.status));
  ok(/index\.html/.test(clash.body.error || ""),
     "and the message names the clash", clash.body.error);
  // Written for the VA who sees it, so it must NOT tell her to send a flag.
  ok(/replace/i.test(clash.body.error || ""),
     "and says a replacement is what would happen", clash.body.error);
  ok(!/overwrite:true|send .*true/i.test(clash.body.error || ""),
     "without naming an API flag she cannot send", clash.body.error);

  reset();
  const forced = await call(h, "POST", `/api/files/${app}`, { token: m,
    json: { rename: [{ from: "README.md", to: "index.html" }], overwrite: true } });
  ok(forced.status === 200, "overwrite:true goes ahead", JSON.stringify(forced.body));
  ok((treeOfLastCommit().find((e) => e.path === "index.html") || {}).sha === "b1",
     "and the moved file wins");

  for (const [why, r] of [
    ["a path that escapes the repo", { from: "../etc/passwd", to: "x" }],
    ["an escape in the destination", { from: "index.html", to: "../x.html" }],
    ["an empty segment", { from: "index.html", to: "a//b.html" }],
    ["a missing destination", { from: "index.html", to: "" }],
    ["a folder moved inside itself", { from: "assets", to: "assets/inner" }],
  ]) {
    const bad = await call(h, "POST", `/api/files/${app}`, { token: m, json: { rename: [r] } });
    ok(bad.status === 400, `${why} is refused`, `${bad.status} ${bad.body && bad.body.error}`);
  }

  // Git cannot hold a file and a folder at the same path. The clash check sees
  // only blobs, so these two have to be caught on purpose.
  const overFolder = await call(h, "POST", `/api/files/${app}`, { token: m,
    json: { rename: [{ from: "index.html", to: "assets" }], overwrite: true } });
  ok(overFolder.status === 409 && /is a folder/i.test(overFolder.body.error || ""),
     "a file cannot take the name of an existing folder, even with overwrite",
     `${overFolder.status} ${overFolder.body && overFolder.body.error}`);
  const overFile = await call(h, "POST", `/api/files/${app}`, { token: m,
    json: { rename: [{ from: "assets", to: "index.html" }], overwrite: true } });
  ok(overFile.status === 409 && /is a file/i.test(overFile.body.error || ""),
     "and a folder cannot take the name of an existing file",
     `${overFile.status} ${overFile.body && overFile.body.error}`);

  const gone = await call(h, "POST", `/api/files/${app}`, { token: m,
    json: { rename: [{ from: "not-here.txt", to: "x.txt" }] } });
  ok(gone.status === 400 && /nothing called not-here\.txt/i.test(gone.body.error || ""),
     "renaming something that is not there says so", gone.body.error);

  // rename + upload + delete, all in the SAME commit
  reset();
  const mixed = await call(h, "POST", `/api/files/${app}`, { token: m, json: {
    rename: [{ from: "assets", to: "static" }],
    files: [{ path: "new.txt", contentB64: Buffer.from("hi").toString("base64") }],
    remove: ["README.md"],
  } });
  ok(mixed.status === 200, "a rename, an upload and a delete can travel together",
     JSON.stringify(mixed.body));
  ok(h.state.commitsWritten.length === 1, "as ONE commit", String(h.state.commitsWritten.length));
  ok(h.calls.filter((c) => c.url.includes("/builds") && c.method === "POST").length === 1,
     "and ONE build — never a delete-then-add pair that can half-apply");
  tree = treeOfLastCommit();
  const paths = Object.fromEntries(tree.map((e) => [e.path, e.sha]));
  ok(paths["static/app.css"] === "b3" && paths["static/logo.png"] === "b4", "the folder moved");
  ok(paths["new.txt"] && paths["new.txt"] !== null, "the new file is there");
  ok(paths["README.md"] === null && paths["assets/app.css"] === null, "the deletions are there");

  // swapping two names must not delete either of them
  reset();
  const swap = await call(h, "POST", `/api/files/${app}`, { token: m, json: {
    rename: [{ from: "README.md", to: "index.html" }, { from: "index.html", to: "README.md" }],
    overwrite: true,
  } });
  ok(swap.status === 200, "two files can swap names in one commit", JSON.stringify(swap.body));
  const sw = Object.fromEntries(treeOfLastCommit().map((e) => [e.path, e.sha]));
  ok(sw["index.html"] === "b1" && sw["README.md"] === "b2",
     "each ends up holding the other's bytes", JSON.stringify(sw));
  ok(!Object.values(sw).includes(null), "and neither is left deleted", JSON.stringify(sw));

  const logs = (await logsOf(h, m)).entries;
  ok(logs.some((l) => /renamed a/.test(l.action)), "a rename is recorded in the log",
     logs.map((l) => l.action).join(" | "));
}
{
  // An executable or a symlink must not quietly become a plain file.
  const h = newEnv({ gitTree: [
    { path: "run.sh", type: "blob", size: 12, sha: "bx", mode: "100755" },
    { path: "index.html", type: "blob", size: 8, sha: "by", mode: "100644" },
  ] });
  const { m, byName } = await setup(h);
  h.state.treesWritten.length = 0;
  await call(h, "POST", `/api/files/${byName["site-one"].id}`, { token: m,
    json: { rename: [{ from: "run.sh", to: "bin/run.sh" }] } });
  const e = ((h.state.treesWritten[0] || {}).tree || []).find((x) => x.path === "bin/run.sh");
  ok(e && e.mode === "100755", "a rename keeps the file's mode", JSON.stringify(e));
}

console.log("\n── newest first, everywhere ──");
{
  const h = newEnv();
  const { m } = await setup(h);
  h.state.ghUser = "second-gh";
  await call(h, "POST", "/api/token", { token: m, json: { kind: "github", token: "ghp_second" } });
  const s0 = (await call(h, "GET", "/api/state", { token: m })).body;
  await call(h, "POST", "/api/combo", { token: m, json: {
    github_conn_id: s0.accounts.github.find((a) => a.account === "second-gh").id,
    heroku_conn_id: s0.accounts.heroku[0].id } });

  const st = (await call(h, "GET", "/api/state", { token: m })).body;
  // Heroku returns app-one, app-two, site-one in that order, so site-one is newest.
  ok(st.sites[0].app === "site-one", "APPS: the most recently added is on top",
     st.sites.map((x) => x.app).join(","));
  ok(st.accounts.github[0].account === "second-gh",
     "ACCOUNTS: the key just connected is on top", st.accounts.github.map((a) => a.account).join(","));
  ok(st.combos.length === 2 && st.combos[0].id > st.combos[1].id,
     "PAIRS: the pair just made is on top", st.combos.map((c) => c.id).join(","));
  ok(st.sites.every((x) => "created_at" in x), "every app carries when it was added");
  ok(st.accounts.github.every((a) => "created_at" in a), "so does every account");
  ok(st.combos.every((c) => "created_at" in c), "and every pair");
  ok(st.sites[0].created_at >= st.sites[st.sites.length - 1].created_at,
     "and the order really does follow that date",
     st.sites.map((x) => x.created_at).join(" | "));

  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  // GitHub returns site-one then site-two, so site-two is the newer row.
  ok(repos[0].name === "site-two", "REPOSITORIES: newest on top too",
     repos.map((r) => r.name).join(","));
  ok(repos.every((r) => "created_at" in r), "and each says when it arrived");

  // Adding one more must put it at the very top, not somewhere alphabetical.
  await call(h, "POST", "/api/site", { token: m, json: {
    owner: "bob", repo: "aaa-brand-new", label: "aaa-brand-new",
    conn_id: st.accounts.github.find((a) => a.account === "bobaccount").id } });
  const after = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  ok(after[0].name === "aaa-brand-new",
     "a repo added just now is first, even though its name sorts first alphabetically too",
     after.map((r) => r.name).join(","));
}

console.log("\n── a deploy cannot hang for ever ──");
{
  // Heroku answers "pending" and never finishes.
  const h = newEnv({ buildStatus: "pending" });
  const { m, byName } = await setup(h);
  const s1 = await ready(h, m, byName, "site-one");
  const r = await call(h, "POST", "/api/deploy", { token: m, form: upload("index.html", "x", [s1]) });

  let st = await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  ok(st.body.targets[0].status === "building", "it is building to begin with");
  ok(st.body.done === false, "and the batch is not finished");

  // 25 minutes later, with Heroku still saying nothing useful
  h.env.DB._raw.prepare(
    `UPDATE batch_targets SET started_at=? WHERE batch_id=?`
  ).run(new Date(Date.now() - 25 * 60 * 1000).toISOString(), r.body.batch);
  const { ctx, settle } = makeCtx();
  await worker.scheduled({}, h.env, ctx); await settle();

  st = await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  ok(st.body.targets[0].status === "unknown",
     "after 20 minutes it stops claiming to know", st.body.targets[0].status);
  ok(st.body.done === true, "and the batch is closed, so the page stops polling for ever");
  const detail = st.body.targets[0].detail || "";
  ok(/20 minutes/.test(detail), "the reason says how long it waited", detail);
  ok(/committed/i.test(detail), "and that the file IS in the repo", detail);
  ok(/activity/i.test(detail) && /heroku/i.test(detail),
     "and points at the app's own activity page", detail);

  const logs = (await logsOf(h, m, "?only=errors")).entries;
  const gave = logs.find((l) => l.action === "gave up waiting for a build") || {};
  ok(!!gave.action, "giving up is recorded", logs.map((l) => l.action).join(" | "));
  ok(gave.kind === "panel", "as backend work — nobody pressed anything", String(gave.kind));
  ok(gave.ok === 0 && /activity/i.test(gave.error || ""),
     "with the same explanation in the log", String(gave.error));
}
{
  // A target that predates the started_at column has no start time of its own.
  // The batch's own created_at is the fallback, and it has to work — otherwise
  // every deploy already in flight during the upgrade would hang for ever.
  const h = newEnv({ buildStatus: "pending" });
  const { m, byName } = await setup(h);
  const s1 = await ready(h, m, byName, "site-one");
  const r = await call(h, "POST", "/api/deploy", { token: m, form: upload("index.html", "x", [s1]) });
  h.env.DB._raw.prepare(`UPDATE batch_targets SET started_at=NULL WHERE batch_id=?`).run(r.body.batch);
  h.env.DB._raw.prepare(`UPDATE batches SET created_at=? WHERE id=?`)
    .run(new Date(Date.now() - 25 * 60 * 1000).toISOString(), r.body.batch);
  const { ctx, settle } = makeCtx();
  await worker.scheduled({}, h.env, ctx); await settle();
  const st = await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  ok(st.body.targets[0].status === "unknown",
     "a target with no start time of its own is timed from its batch",
     st.body.targets[0].status);
}
{
  // Heroku refuses to answer at all. That is NOT a failed deploy.
  const h = newEnv({ buildReadStatus: 401 });
  const { m, byName } = await setup(h);
  const s1 = await ready(h, m, byName, "site-one");
  const r = await call(h, "POST", "/api/deploy", { token: m, form: upload("index.html", "x", [s1]) });
  const c1 = makeCtx();
  await worker.scheduled({}, h.env, c1.ctx); await c1.settle();

  let st = await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  ok(st.body.targets[0].status === "building",
     "a poll that fails does NOT report the deploy as failed", st.body.targets[0].status);
  ok(/Waiting for Heroku/i.test(st.body.targets[0].detail || ""),
     "it says what is happening instead", st.body.targets[0].detail);
  const mid = (await logsOf(h, m, "?only=errors")).entries;
  ok(mid.some((l) => l.action === "could not read a build status" && l.kind === "panel"),
     "and the failed poll is in the log as backend work",
     mid.map((l) => l.action).join(" | "));

  // The page polls this batch every couple of seconds while it is on screen.
  // The same unchanged failure must not be written down again and again, or a
  // Heroku outage buries the whole day's log under one repeated line.
  const countPollRows = async () =>
    (await logsOf(h, m, "?q=could not read a build status")).entries
      .filter((l) => l.action === "could not read a build status").length;
  const n1 = await countPollRows();
  for (let i = 0; i < 5; i++) {
    h.env.DB._raw.prepare(`UPDATE batches SET last_poll=NULL WHERE id=?`).run(r.body.batch);
    await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  }
  const n2 = await countPollRows();
  ok(n2 === n1, "the same unchanged failure is not logged over and over", `${n1} -> ${n2}`);

  h.env.DB._raw.prepare(`UPDATE batch_targets SET started_at=? WHERE batch_id=?`)
    .run(new Date(Date.now() - 25 * 60 * 1000).toISOString(), r.body.batch);
  const c2 = makeCtx();
  await worker.scheduled({}, h.env, c2.ctx); await c2.settle();
  st = await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  ok(st.body.targets[0].status === "unknown",
     "but after 20 minutes of silence it becomes unknown", st.body.targets[0].status);
  ok(/stopped answering/i.test(st.body.targets[0].detail || ""),
     "and says Heroku stopped answering", st.body.targets[0].detail);
}

console.log("\n── the migration runs on a live database, twice, safely ──");
{
  const h = newEnv();
  const raw = h.env.DB._raw;

  // Turn this into the database as it exists TODAY, with rows in it.
  raw.exec(`DROP INDEX IF EXISTS audit_kind; DROP INDEX IF EXISTS audit_bad;`);
  for (const sql of [
    `ALTER TABLE audit_log DROP COLUMN kind`,
    `ALTER TABLE audit_log DROP COLUMN error`,
    `ALTER TABLE audit_log DROP COLUMN ref`,
    `ALTER TABLE batch_targets DROP COLUMN started_at`,
    `ALTER TABLE apps DROP COLUMN created_at`,
    `ALTER TABLE repos DROP COLUMN created_at`,
  ]) raw.exec(sql);

  raw.prepare(`INSERT INTO audit_log (at, actor, action, target, detail, ok) VALUES (?,?,?,?,?,?)`)
     .run("2026-08-01T10:00:00.000Z", "owner-login", "signed in", null, null, 1);
  raw.prepare(`INSERT INTO connections (kind,label,token,account,created_at) VALUES ('github','g','t','g','2026-08-01T09:00:00.000Z')`).run();
  raw.prepare(`INSERT INTO repos (label,owner,name,branch,connection_id) VALUES ('old','bob','old-repo','main',1)`).run();
  raw.prepare(`INSERT INTO apps (label,heroku_name,connection_id,repo_id) VALUES ('old-app','old-app',1,1)`).run();

  const first = await runMigrations(h.env);
  ok(first.length === 6, "the first run adds every missing column", first.join(","));
  // Re-running must not merely be a no-op — it must not THROW either. An
  // unguarded ALTER raises "duplicate column name" and would take the Worker
  // down on every cron tick from then on.
  const rerun = async (n) => {
    try { return { applied: await runMigrations(h.env) }; }
    catch (e) { return { threw: String((e && e.message) || e) }; }
  };
  const second = await rerun();
  ok(!second.threw, "running it again does not throw", second.threw || "");
  ok(second.applied && second.applied.length === 0, "and changes nothing at all",
     second.applied ? second.applied.join(",") : "");
  const third = await rerun();
  ok(!third.threw && third.applied.length === 0, "and a third time is still nothing",
     third.threw || third.applied.join(","));

  const cols = (t) => new Set(raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
  ok(["kind", "error", "ref"].every((c) => cols("audit_log").has(c)), "audit_log has the new columns");
  ok(cols("batch_targets").has("started_at"), "batch_targets can time its builds");
  ok(cols("apps").has("created_at") && cols("repos").has("created_at"), "apps and repos can be sorted by age");

  const kept = raw.prepare(`SELECT * FROM audit_log WHERE at='2026-08-01T10:00:00.000Z'`).get();
  ok(!!kept, "the row that was already there is still there");
  ok(kept.actor === "owner-login" && kept.action === "signed in" && kept.ok === 1,
     "with every original value untouched", JSON.stringify(kept));
  ok(kept.kind === "person", "and a sensible value in the new column", kept.kind);
  ok(kept.error === null && kept.ref === null, "the columns it never had are empty, not invented");

  const repo = raw.prepare(`SELECT * FROM repos WHERE name='old-repo'`).get();
  ok(!!repo && repo.owner === "bob", "the existing repo survived");
  ok(!!repo.created_at, "and was given a date so it can be sorted", String(repo.created_at));
  const app = raw.prepare(`SELECT * FROM apps WHERE heroku_name='old-app'`).get();
  ok(!!app && !!app.created_at, "so was the existing app");

  // ...and the API works on it afterwards
  await createUser(h.env, "m2", "masterpass1", "master");
  const t = (await call(h, "POST", "/api/login", { json: { username: "m2", password: "masterpass1" } })).body.session;
  const logs = await logsOf(h, t);
  ok(logs.entries.some((l) => l.action === "signed in" && l.actor === "owner-login"),
     "the old row reads back through the API");
  ok((await call(h, "GET", "/api/state", { token: t })).status === 200, "and the panel still paints");
}
{
  // The request path does no schema work, so an un-migrated database must
  // repair itself on the first call rather than 500 until the cron fires.
  const h = newEnv();
  await createUser(h.env, "m3", "masterpass1", "master");
  const t = (await call(h, "POST", "/api/login", { json: { username: "m3", password: "masterpass1" } })).body.session;
  const raw = h.env.DB._raw;
  raw.exec(`DROP INDEX IF EXISTS audit_kind; DROP INDEX IF EXISTS audit_bad;`);
  raw.exec(`ALTER TABLE audit_log DROP COLUMN kind`);
  raw.exec(`ALTER TABLE audit_log DROP COLUMN error`);
  raw.exec(`ALTER TABLE audit_log DROP COLUMN ref`);

  const r = await call(h, "GET", "/api/logs", { token: t });
  ok(r.status === 200, "a request against an un-migrated database still answers", String(r.status));
  ok((r.body.entries || []).length > 0 && r.body.entries.every((l) => l.kind === "person"),
     "and the rows come back readable", JSON.stringify(r.body).slice(0, 120));
  ok(new Set(raw.prepare(`PRAGMA table_info(audit_log)`).all().map((c) => c.name)).has("kind"),
     "having brought the schema up to date on the way");
}

console.log("\n── v14: deleting an app — locally, or for real on Heroku ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  const id = byName["app-one"].id;

  // local removal: the row goes, Heroku is never touched, and the log says so
  const local = await call(h, "DELETE", `/api/app/${id}`, { token: m, json: {} });
  ok(local.status === 200 && local.body.destroyed === null, "without destroy, the removal is local only");
  ok(h.state.appsDeleted.length === 0, "and no DELETE ever reached Heroku");
  const st1 = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(!st1.sites.some((s) => s.label === "app-one"), "the app is gone from the panel");
  const l1 = await logsOf(h, m);
  ok(l1.entries.some((l) => l.action === "stopped managing an app" && l.target === "app-one"),
     "logged as 'stopped managing an app', not as a deletion");

  // destroy with the WRONG typed name: refused, nothing deleted anywhere
  const id2 = byName["app-two"].id;
  const wrong = await call(h, "DELETE", `/api/app/${id2}`, { token: m, json: { destroy: true, confirm: "app-tw0" } });
  ok(wrong.status === 400 && /does not match/.test(wrong.body.error), "a wrong typed name is refused");
  ok(/app-two/.test(wrong.body.error), "and the refusal names the exact name to type");
  ok(h.state.appsDeleted.length === 0, "nothing was deleted on Heroku");
  ok((await call(h, "GET", "/api/state", { token: m })).body.sites.some((s) => s.label === "app-two"),
     "and the app is still in the panel");
  const lw = await logsOf(h, m);
  ok(lw.entries.some((l) => l.action === "refused to delete a Heroku app" && l.ok === 0),
     "the refusal is in the log with ok=0");

  // destroy with no confirm at all: same refusal
  const noc = await call(h, "DELETE", `/api/app/${id2}`, { token: m, json: { destroy: true } });
  ok(noc.status === 400 && h.state.appsDeleted.length === 0, "destroy without a confirm deletes NOTHING");

  // destroy with the exact name: Heroku is called, the row goes, logged loudly
  const real = await call(h, "DELETE", `/api/app/${id2}`, { token: m, json: { destroy: true, confirm: "app-two" } });
  ok(real.status === 200 && real.body.destroyed === "app-two", "the exact name destroys the app");
  ok(h.state.appsDeleted.length === 1 && h.state.appsDeleted[0] === "app-two", "Heroku received exactly one DELETE");
  ok(!(await call(h, "GET", "/api/state", { token: m })).body.sites.some((s) => s.label === "app-two"),
     "and the local row is cleared");
  const l2 = await logsOf(h, m);
  const drow = l2.entries.find((l) => l.action === "deleted a Heroku app");
  ok(!!drow && drow.target === "app-two" && /permanent/.test(drow.detail || ""),
     "logged as 'deleted a Heroku app', named, marked permanent");
}
{
  // Heroku refusing the deletion: the reason surfaces and the row is KEPT.
  const h = newEnv({ hkDeleteStatus: 403 });
  const { m, byName } = await setup(h);
  const r = await call(h, "DELETE", `/api/app/${byName["app-one"].id}`,
    { token: m, json: { destroy: true, confirm: "app-one" } });
  ok(r.status !== 200 && /not allowed|key/.test(r.body.error || ""), "a refused deletion reads as a sentence", r.body.error);
  ok((await call(h, "GET", "/api/state", { token: m })).body.sites.some((s) => s.label === "app-one"),
     "and the app stays in the panel — nothing half-done");
  const lg = await logsOf(h, m);
  ok(lg.entries.some((l) => l.action === "could not delete a Heroku app" && l.ok === 0 && l.error),
     "the failure is logged with ok=0 and a readable reason");
}

console.log("\n── v14: deleting a repo — every guard in the chain ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  const one = repos.find((r) => r.name === "site-one");   // linked to the app "site-one"
  const two = repos.find((r) => r.name === "site-two");   // linked to nothing

  // wrong typed name: refused before anything else is even considered
  const wrong = await call(h, "DELETE", `/api/repo/${one.id}`,
    { token: m, json: { destroy: true, confirm: "bob/site-one " } });
  ok(wrong.status === 400 && /does not match/.test(wrong.body.error), "a wrong typed name is refused");
  ok(/bob\/site-one/.test(wrong.body.error), "naming the exact owner/name to type");
  ok(h.state.reposDeleted.length === 0, "nothing was deleted on GitHub");

  // right name, but an app still deploys from it: refused, naming the app
  const linkedRefusal = await call(h, "DELETE", `/api/repo/${one.id}`,
    { token: m, json: { destroy: true, confirm: "bob/site-one" } });
  ok(linkedRefusal.status === 409, "a repo a live app deploys from is refused", String(linkedRefusal.status));
  ok(/site-one/.test(linkedRefusal.body.error) && (linkedRefusal.body.linked_apps || []).includes("site-one"),
     "and the refusal names the app(s) still using it", linkedRefusal.body.error);
  ok(h.state.reposDeleted.length === 0, "still nothing deleted on GitHub");

  // the deliberate second answer: even_though_linked:true goes through
  const anyway = await call(h, "DELETE", `/api/repo/${one.id}`,
    { token: m, json: { destroy: true, confirm: "bob/site-one", even_though_linked: true } });
  ok(anyway.status === 200 && anyway.body.destroyed === "bob/site-one", "even_though_linked destroys it");
  ok(h.state.reposDeleted.length === 1 && h.state.reposDeleted[0] === "bob/site-one", "GitHub received exactly one DELETE");
  ok((anyway.body.unlinked || []).includes("site-one"), "the reply says which apps were unlinked");
  const st = (await call(h, "GET", "/api/state", { token: m })).body;
  const orphan = st.sites.find((s) => s.label === "site-one");
  ok(!!orphan && orphan.linked === false && orphan.repo === "", "the app is cleanly unlinked, not half-pointing");
  const lg = await logsOf(h, m);
  const row = lg.entries.find((l) => l.action === "deleted a repo");
  ok(!!row && row.target === "bob/site-one" && /permanent/.test(row.detail || "") && /site-one/.test(row.detail || ""),
     "logged loudly: named, permanent, and the unlinked app(s) listed");

  // local-only removal of the unused repo: GitHub untouched, logged differently
  const local = await call(h, "DELETE", `/api/repo/${two.id}`, { token: m, json: {} });
  ok(local.status === 200 && local.body.destroyed === null, "without destroy, removal is local only");
  ok(h.state.reposDeleted.length === 1, "no second DELETE reached GitHub");
  const lg2 = await logsOf(h, m);
  ok(lg2.entries.some((l) => l.action === "stopped managing a repo" && l.target === "bob/site-two"),
     "logged as 'stopped managing a repo'");
  const reposAfter = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  ok(!reposAfter.some((r) => r.name === "site-two"), "and the row is gone from the panel");
}
{
  // A token without administration=write: GitHub answers 403; the message must
  // name the Administration permission (ghMessage's Contents advice is wrong here).
  const h = newEnv({ ghRepoDeleteStatus: 403 });
  const { m } = await setup(h);
  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  const two = repos.find((r) => r.name === "site-two");
  const r = await call(h, "DELETE", `/api/repo/${two.id}`,
    { token: m, json: { destroy: true, confirm: "bob/site-two" } });
  ok(r.status === 502, "the GitHub refusal is passed on, not swallowed", String(r.status));
  ok(/Administration: Read and write/.test(r.body.error || ""), "naming the Administration permission", r.body.error);
  ok(/administration=write/.test(r.body.error || ""), "and GitHub's own permission name");
  ok(!/Contents: Read and write/.test(r.body.error || ""), "without the wrong (Contents) advice");
  ok((await call(h, "GET", "/api/repos", { token: m })).body.repos.some((x) => x.name === "site-two"),
     "the local row is kept — the real thing was not deleted");
  const lg = await logsOf(h, m);
  ok(lg.entries.some((l) => l.action === "could not delete a repo" && l.ok === 0 &&
       /Administration/.test(l.error || "")), "the failure is logged with the same reason");
}
{
  // The old row-removal route must keep working exactly as before.
  const h = newEnv();
  const { m } = await setup(h);
  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  const two = repos.find((r) => r.name === "site-two");
  const r = await call(h, "DELETE", `/api/site/${two.id}`, { token: m });
  ok(r.status === 200, "DELETE /api/site/{id} still answers");
  ok(h.state.reposDeleted.length === 0 && h.state.appsDeleted.length === 0, "and still touches nothing real");
  ok(!(await call(h, "GET", "/api/repos", { token: m })).body.repos.some((x) => x.name === "site-two"),
     "while removing the local row as it always did");
}

console.log("\n── v15: one name, one click, a whole site ──");
{
  // The happy path, end to end: repo, app, link, and the one file that
  // makes a static site buildable at all.
  const h = newEnv();
  const { m } = await setup(h);
  const r = await call(h, "POST", "/api/site/new", { token: m, json: { name: "new-shop" } });
  ok(r.status === 200 && r.body.ok === true, "one call makes the whole site", JSON.stringify(r.body).slice(0, 200));
  const byKey = Object.fromEntries((r.body.steps || []).map((s) => [s.key, s]));
  ok((r.body.steps || []).length === 4, "four steps come back, not one silent tick");
  ok(byKey.repo?.ok && /bobaccount\/new-shop/.test(byKey.repo.detail || ""), "step 1 names the repo it made");
  ok(byKey.app?.ok && /new-shop/.test(byKey.app.detail || ""), "step 2 names the Heroku app");
  ok(byKey.link?.ok, "step 3 says they are linked");
  ok(byKey.ready?.ok === null && /no files were added/.test(byKey.ready.detail || ""),
     "step 4 did NOT touch the repo — starter files are opt-in", JSON.stringify(byKey.ready));

  ok(h.state.reposCreated.length === 1 && h.state.reposCreated[0].name === "new-shop",
     "exactly one repo was created on GitHub");
  ok(h.state.reposCreated[0].private === true, "and it is private");
  ok(h.state.appsCreated.length === 1 && h.state.appsCreated[0].name === "new-shop",
     "exactly one app was created on Heroku");
  ok(h.state.blobsWritten.length === 0 && h.state.commitsWritten.length === 0,
     "NOTHING was written into the new repo — it is his repo, his call",
     `${h.state.blobsWritten.length} blobs, ${h.state.commitsWritten.length} commits`);

  const st = (await call(h, "GET", "/api/state", { token: m })).body;
  const made = (st.sites || []).find((s) => s.app === "new-shop");
  ok(!!made && made.linked === true && made.repo === "new-shop", "the panel shows it, already linked");
  ok(/new-shop-1a2b3c4d5e6f/.test(made.url || ""),
     "its address is READ from Heroku, never guessed from the name", made.url);
  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  ok(repos.some((x) => x.name === "new-shop"), "and the repo is in the list");

  const lg = await logsOf(h, m);
  for (const a of ["created a repo", "created a Heroku app", "linked an app", "made a new site"]) {
    ok(lg.entries.some((l) => l.action === a && /new-shop/.test(`${l.target} ${l.detail}`)),
       `the log reads as what happened: "${a}"`);
  }
}
{
  // Validation happens BEFORE anything is created — the whole point is that a
  // name which only works on one of the two services never gets half-made.
  const h = newEnv();
  const { m } = await setup(h);
  const cases = [
    ["", "empty"], ["ab", "too short"], ["My Site", "capitals and a space"],
    ["9lives", "starts with a digit"], ["ends-", "ends with a hyphen"],
    ["under_score", "an underscore GitHub allows and Heroku does not"],
    ["a".repeat(31), "over 30 characters"],
  ];
  for (const [name, why] of cases) {
    const r = await call(h, "POST", "/api/site/new", { token: m, json: { name } });
    ok(r.status === 400 && !!r.body.error, `refused: ${why}`, `${r.status} ${JSON.stringify(r.body)}`);
  }
  ok(h.state.reposCreated.length === 0 && h.state.appsCreated.length === 0,
     "and not one of them touched GitHub or Heroku");
}
{
  // The failure that will actually happen: Heroku app names are global, so a
  // stranger owns the name — AFTER our repo exists.
  const h = newEnv({ hkAppCreateStatus: 422, hkAppCreateMessage: "Name is already taken" });
  const { m } = await setup(h);
  const r = await call(h, "POST", "/api/site/new", { token: m, json: { name: "taken-name" } });
  ok(r.status === 409, "a taken Heroku name is its own answer, not a 500", String(r.status));
  ok(/shared with every Heroku user/i.test(r.body.error || ""), "it explains WHY an ordinary name is taken");
  ok(/WAS created and is still there/i.test(r.body.error || ""), "and says plainly that the repo exists");
  ok(!!r.body.partial && r.body.partial.stage === "app" && !!r.body.partial.repo_id,
     "the half-state is handed back, not hidden");
  ok(/^taken-name-[0-9a-f]{4}$/.test(r.body.suggestion || "") && r.body.suggestion.length <= 30,
     "with a free-looking alternative to try", r.body.suggestion);
  const steps = Object.fromEntries((r.body.steps || []).map((s) => [s.key, s]));
  ok(steps.repo?.ok === true && steps.app?.ok === false, "the steps show one done, one failed");
  ok(h.state.reposDeleted.length === 0, "nothing was rolled back behind his back");
  ok((await call(h, "GET", "/api/repos", { token: m })).body.repos.some((x) => x.name === "taken-name"),
     "the repo stays in the panel so it can be finished or deleted");
  const lg = await logsOf(h, m);
  ok(lg.entries.some((l) => l.action === "could not make a new site" && l.ok === 0), "the failure is logged with its reason");

  // Finish the job: same route, a new name, the SAME repo.
  h.state.hkAppCreateStatus = 201;
  const fin = await call(h, "POST", "/api/site/new",
    { token: m, json: { name: "taken-name-9f3c", use_repo_id: r.body.partial.repo_id } });
  ok(fin.status === 200 && fin.body.ok === true, "finishing it works", JSON.stringify(fin.body).slice(0, 160));
  ok(h.state.reposCreated.length === 1, "and does NOT make a second repo");
  ok(fin.body.repo.id === r.body.partial.repo_id, "it links the app to the one already made");
  const st = (await call(h, "GET", "/api/state", { token: m })).body;
  const site = (st.sites || []).find((s) => s.app === "taken-name-9f3c");
  ok(!!site && site.repo === "taken-name", "so the app and the existing repo are paired");
}
{
  // A token without administration=write. GitHub refuses first, so Heroku must
  // never be called at all.
  const h = newEnv({ ghRepoCreateStatus: 403 });
  const { m } = await setup(h);
  const r = await call(h, "POST", "/api/site/new", { token: m, json: { name: "no-permission" } });
  ok(r.status === 502, "GitHub's refusal is passed on", String(r.status));
  ok(/Administration: Read and write/.test(r.body.error || ""), "naming the permission that is missing", r.body.error);
  ok(/Nothing was created/.test(r.body.error || ""), "and saying nothing was created");
  ok(h.state.appsCreated.length === 0, "Heroku was never touched");
}
{
  // Names already in the panel are caught locally, before either service.
  const h = newEnv();
  const { m } = await setup(h);
  const dup = await call(h, "POST", "/api/site/new", { token: m, json: { name: "site-one" } });
  ok(dup.status === 409 && /already has a repo/.test(dup.body.error || ""),
     "a repo name already here is refused", JSON.stringify(dup.body).slice(0, 140));
  const dupApp = await call(h, "POST", "/api/site/new", { token: m, json: { name: "app-one" } });
  ok(dupApp.status === 409 && /already has an app/.test(dupApp.body.error || ""), "so is an app name already here");
  ok(h.state.reposCreated.length === 0 && h.state.appsCreated.length === 0,
     "neither one created anything first");
}
{
  // Opting out of the buildable file, and the failure of that step alone.
  const h = newEnv();
  const { m } = await setup(h);
  const r = await call(h, "POST", "/api/site/new", { token: m, json: { name: "bare-site" } });
  const ready = (r.body.steps || []).find((s) => s.key === "ready");
  ok(r.body.ok === true && ready && ready.ok === null, "without the flag, that step is skipped and says so");
  ok(h.state.blobsWritten.length === 0, "and nothing at all was committed");
  const r1b = await call(h, "POST", "/api/site/new", { token: m, json: { name: "kitted-site", deployable: true } });
  const ready1b = (r1b.body.steps || []).find((s) => s.key === "ready");
  ok(ready1b && ready1b.ok === true && /index\.php/.test(ready1b.detail || ""),
     "ticking it DOES add the starter files", JSON.stringify(ready1b));
  ok(h.state.blobsWritten.length === 2 && h.state.commitsWritten.length === 1,
     "the holding page and index.php go up in ONE commit, when asked for",
     `${h.state.blobsWritten.length} blobs`);

  const h2 = newEnv({ ghBlobStatus: 403 });
  const { m: m2 } = await setup(h2);
  const r2 = await call(h2, "POST", "/api/site/new", { token: m2, json: { name: "half-ready", deployable: true } });
  const ready2 = (r2.body.steps || []).find((s) => s.key === "ready");
  ok(r2.status === 200 && r2.body.ok === true, "a failed last step does not fail the site — it exists");
  ok(ready2 && ready2.ok === false && /Make it deployable/.test(ready2.error || ""),
     "but that step is reported failed, with what to do", ready2 && ready2.error);
  const st2 = (await call(h2, "GET", "/api/state", { token: m2 })).body;
  ok((st2.sites || []).some((s) => s.app === "half-ready" && s.linked), "the app and repo are still linked");
}
{
  // Making a site is not destructive, so the VA may do it.
  const h = newEnv();
  const { v } = await setup(h);
  const r = await call(h, "POST", "/api/site/new", { token: v, json: { name: "va-made-this" } });
  ok(r.status === 200 && r.body.ok === true, "a VA can make a new site", String(r.status));
}

console.log("\n── v15: deleting a whole site — the one action with no undo ──");
{
  const h = newEnv();
  const { m, v, byName } = await setup(h);
  const appId = await ready(h, m, byName, "app-one", "site-one");

  const va = await call(h, "DELETE", `/api/site/pair/${appId}`,
    { token: v, json: { destroy: true, confirm: "app-one" } });
  ok(va.status === 403 && /Only the owner/.test(va.body.error || ""), "a VA cannot delete a whole site");
  ok(h.state.appsDeleted.length === 0 && h.state.reposDeleted.length === 0, "and her attempt deleted nothing");

  const noFlag = await call(h, "DELETE", `/api/site/pair/${appId}`, { token: m, json: { confirm: "app-one" } });
  ok(noFlag.status === 400, "it must be asked for deliberately (destroy:true)");

  const wrong = await call(h, "DELETE", `/api/site/pair/${appId}`,
    { token: m, json: { destroy: true, confirm: "app-two" } });
  ok(wrong.status === 400 && /Nothing was deleted/.test(wrong.body.error || ""), "a wrong name is refused");
  ok(h.state.appsDeleted.length === 0 && h.state.reposDeleted.length === 0,
     "and a wrong name deletes NOTHING — checked against what was actually called");
  const stillThere = (await call(h, "GET", "/api/state", { token: m })).body;
  ok((stillThere.sites || []).some((s) => s.app === "app-one"), "the app is still in the panel");
  ok((await call(h, "GET", "/api/repos", { token: m })).body.repos.some((x) => x.name === "site-one"),
     "so is the repo");
  const lgW = await logsOf(h, m);
  ok(lgW.entries.some((l) => l.action === "refused to delete a whole site" && l.ok === 0), "the refusal is on the record");

  const gone = await call(h, "DELETE", `/api/site/pair/${appId}`,
    { token: m, json: { destroy: true, confirm: "app-one" } });
  ok(gone.status === 200 && gone.body.ok === true, "the right name deletes both halves", JSON.stringify(gone.body).slice(0, 160));
  ok(gone.body.destroyed.app === "app-one" && gone.body.destroyed.repo === "bob/site-one",
     "and the reply names both things by name");
  ok(h.state.appsDeleted.includes("app-one"), "Heroku really was called");
  ok(h.state.reposDeleted.includes("bob/site-one"), "GitHub really was called");
  const after = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(!(after.sites || []).some((s) => s.app === "app-one"), "the app row is gone");
  ok(!(await call(h, "GET", "/api/repos", { token: m })).body.repos.some((x) => x.name === "site-one"),
     "the repo row is gone");
  const lg = await logsOf(h, m);
  const row = lg.entries.find((l) => l.action === "deleted a whole site" && l.ok === 1);
  ok(!!row && /app-one/.test(row.target || "") && /site-one/.test(row.target || ""), "logged as its own action, naming both");
  ok(!!row && /permanent/.test(row.detail || ""), "and saying it is permanent");
}
{
  // Heroku goes first on purpose. If GitHub then refuses, the app IS gone and
  // saying otherwise would be the worst kind of lie.
  const h = newEnv({ ghRepoDeleteStatus: 403 });
  const { m, byName } = await setup(h);
  const appId = await ready(h, m, byName, "app-one", "site-one");
  const r = await call(h, "DELETE", `/api/site/pair/${appId}`,
    { token: m, json: { destroy: true, confirm: "app-one" } });
  ok(r.status === 502 && r.body.half === true, "a half-done deletion answers as half-done", String(r.status));
  ok(/is deleted on Heroku/.test(r.body.error || "") && /STILL THERE/.test(r.body.error || ""),
     "the sentence says which half went and which stayed", r.body.error);
  ok(/Administration: Read and write/.test(r.body.error || ""), "and why GitHub refused");
  ok(h.state.appsDeleted.includes("app-one") && h.state.reposDeleted.length === 0, "which matches what was really called");
  ok((await call(h, "GET", "/api/repos", { token: m })).body.repos.some((x) => x.name === "site-one"),
     "the repo row is KEPT, because the repo is still there");
  const lg = await logsOf(h, m);
  ok(lg.entries.some((l) => l.action === "deleted a whole site" && l.ok === 0 && /NOT deleted/.test(l.detail || "")),
     "and the log records the half-state, not a success");
}
{
  // An app with nothing linked has no pair, and is pointed at the right control.
  const h = newEnv();
  const { m, byName } = await setup(h);
  const r = await call(h, "DELETE", `/api/site/pair/${byName["app-two"].id}`,
    { token: m, json: { destroy: true, confirm: "app-two" } });
  ok(r.status === 409 && /no repo linked/.test(r.body.error || ""), "no repo, no pair", r.body.error);
  ok(h.state.appsDeleted.length === 0, "and nothing was deleted on the way to saying so");

  // A mistyped route must never answer "ok" while deleting nothing.
  const bad = await call(h, "DELETE", "/api/site/pair", { token: m, json: { destroy: true } });
  ok(bad.status === 400 && !bad.body.ok, "DELETE /api/site/pair with no app id is an error, not a silent ok",
     `${bad.status} ${JSON.stringify(bad.body)}`);
}


console.log("\n── v18: replacing a key keeps everything it owns ──");
{
  const h = newEnv();
  const { m } = await setup(h);
  const st0 = (await call(h, "GET", "/api/state", { token: m })).body;
  const gh = st0.accounts.github[0], hkAcc = st0.accounts.heroku[0];
  const reposBefore = (await call(h, "GET", "/api/repos", { token: m })).body.repos.length;
  const appsBefore = st0.sites.length;

  const r = await call(h, "POST", "/api/token",
    { token: m, json: { kind: "github", token: "ghp_NEW", replace_id: gh.id } });
  ok(r.status === 200 && r.body.replaced === true, "a key can be replaced in place", JSON.stringify(r.body));
  ok(r.body.kept === reposBefore && /untouched/.test(r.body.message || ""),
     "and it says how many repos it kept", JSON.stringify(r.body));
  const st1 = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(st1.accounts.github.length === 1 && String(st1.accounts.github[0].id) === String(gh.id),
     "the account row is the SAME row — nothing was re-created", JSON.stringify(st1.accounts.github));
  ok(st1.sites.length === appsBefore, "every app is still there");
  ok((await call(h, "GET", "/api/repos", { token: m })).body.repos.length === reposBefore, "so is every repo");
  ok(st1.sites.filter((x) => x.linked).length === st0.sites.filter((x) => x.linked).length,
     "and the links between them survived");
  const lg = await logsOf(h, m);
  ok(lg.entries.some((l) => l.action === "replaced a GitHub key" && /kept/.test(l.detail || "")),
     "the log says it was a replacement, not a new key");
  // the new token is the one actually used from now on
  const mark = h.calls.length;
  await call(h, "POST", "/api/refresh", { token: m, json: {} });
  const after = h.calls.slice(mark)
    .filter((c) => c.url.startsWith("https://api.github.com") && c.init.headers)
    .map((c) => String(c.init.headers.Authorization || ""));
  ok(after.length > 0 && after.every((a) => a.includes("ghp_NEW")),
     "and every GitHub call after it carries the NEW token", JSON.stringify(after.slice(0, 3)));

  // a Heroku key replaces the same way, and counts apps rather than repos
  const r2 = await call(h, "POST", "/api/token",
    { token: m, json: { kind: "heroku", token: "hk_NEW", replace_id: hkAcc.id } });
  ok(r2.status === 200 && r2.body.kept_kind === "app", "a Heroku key replaces the same way", JSON.stringify(r2.body));
}
{
  // The trap: a token for a DIFFERENT account would otherwise add a second key
  // while the first one keeps owning every app and repo — so the panel looks
  // fixed and nothing works.
  const h = newEnv();
  const { m } = await setup(h);
  const before = (await call(h, "GET", "/api/state", { token: m })).body.accounts.github[0];
  const reposBefore = (await call(h, "GET", "/api/repos", { token: m })).body.repos.length;
  h.state.ghUser = "someone-else";          // the pasted key belongs to another account
  const r = await call(h, "POST", "/api/token",
    { token: m, json: { kind: "github", token: "ghp_OTHER", replace_id: before.id } });
  ok(r.status === 409, "a key from another account is refused", String(r.status));
  ok(/belongs to someone-else/.test(r.body.error || "") && new RegExp(before.account).test(r.body.error || ""),
     "naming both accounts", r.body.error);
  ok(/Nothing was changed/.test(r.body.error || ""), "and saying nothing changed");
  ok(/connect someone-else as a new account/.test(r.body.error || ""),
     "offering the thing he probably meant instead");
  const st = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(st.accounts.github.length === 1 && st.accounts.github[0].account === before.account,
     "no second key was added and the first is unchanged", JSON.stringify(st.accounts.github));
  ok((await call(h, "GET", "/api/repos", { token: m })).body.repos.length === reposBefore,
     "and its repos are all still there");
  const lg = await logsOf(h, m);
  ok(lg.entries.some((l) => l.action === "could not replace a GitHub key" && l.ok === 0), "the refusal is logged");
}
{
  // The 15:15 moment on 2026-08-17: verifying a key calls GitHub, GitHub was
  // down, and the panel refused a perfectly good key.
  const h = newEnv({ ghStatusIndicator: "major", ghStatusDescription: "Git Operations degraded" });
  const { m } = await setup(h);
  const acc = (await call(h, "GET", "/api/state", { token: m })).body.accounts.github[0];
  h.state.ghVerifyStatus = 503;             // GitHub goes down AFTER the key was connected
  const r = await call(h, "POST", "/api/token",
    { token: m, json: { kind: "github", token: "ghp_FINE", replace_id: acc.id } });
  ok(r.status === 503, "an outage answers 503, not 'bad key'", String(r.status));
  ok(/nothing is wrong with the key itself/i.test(r.body.error || ""), "and says so in those words", r.body.error);
  ok(/still working/i.test(r.body.error || ""), "and that the existing key still works");
  ok(/Git Operations degraded/.test(r.body.error || ""),
     "quoting GitHub's own status page", r.body.error);
  const lg = await logsOf(h, m);
  ok(lg.entries.some((l) => l.action === "could not connect a GitHub key" && l.ok === 0),
     "the attempt is logged as a failure, with the reason");
}

console.log("\n── v18: removing a key says what it takes with it ──");
{
  const h = newEnv();
  const { m } = await setup(h);
  const st0 = (await call(h, "GET", "/api/state", { token: m })).body;
  const gh = st0.accounts.github[0];
  const repos0 = (await call(h, "GET", "/api/repos", { token: m })).body.repos.length;

  const no = await call(h, "DELETE", `/api/token/${gh.id}`, { token: m, json: {} });
  ok(no.status === 409 && no.body.needs_confirm === true, "removing a key asks first", String(no.status));
  ok(no.body.repos === repos0 && /also removes/.test(no.body.error || ""),
     "and says exactly what would go with it", JSON.stringify(no.body).slice(0, 200));
  ok(/Replace key/.test(no.body.error || ""), "pointing at Replace key as the thing you probably want");
  ok((await call(h, "GET", "/api/repos", { token: m })).body.repos.length === repos0, "nothing was removed");

  const wrong = await call(h, "DELETE", `/api/token/${gh.id}`, { token: m, json: { confirm: "not-the-name" } });
  ok(wrong.status === 409, "a wrong name is refused too");
  ok((await call(h, "GET", "/api/state", { token: m })).body.accounts.github.length === 1, "the key is still there");

  const yes = await call(h, "DELETE", `/api/token/${gh.id}`, { token: m, json: { confirm: gh.account } });
  ok(yes.status === 200 && yes.body.repos === repos0, "the exact name removes it, and reports the cost",
     JSON.stringify(yes.body));
  ok((await call(h, "GET", "/api/repos", { token: m })).body.repos.length === 0,
     "the repos on that account went with it, as the database always did");
  const lg = await logsOf(h, m);
  const row = lg.entries.find((l) => l.action === "removed a GitHub key");
  ok(!!row && new RegExp(gh.account).test(row.target || ""), "and it is LOGGED — this used to leave no trace");
  ok(!!row && /nothing deleted at GitHub/.test(row.detail || ""), "saying nothing was deleted at GitHub itself");
}

console.log("\n── v18: a note on each key, and the in-use mark on a site ──");
{
  const h = newEnv();
  const { m, v, byName } = await setup(h);
  const gh = (await call(h, "GET", "/api/state", { token: m })).body.accounts.github[0];
  ok(gh.note === "", "a key starts with no note");
  const r = await call(h, "PATCH", `/api/token/${gh.id}`,
    { token: m, json: { note: "client: Northgate — VA uses this one" } });
  ok(r.status === 200, "a note can be written");
  const st = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(st.accounts.github[0].note === "client: Northgate — VA uses this one", "and it comes back with the account",
     st.accounts.github[0].note);
  const lg = await logsOf(h, m);
  ok(lg.entries.some((l) => l.action === "wrote a note on a key" && l.target === gh.account), "and it is logged");
  await call(h, "PATCH", `/api/token/${gh.id}`, { token: m, json: { note: "" } });
  ok((await call(h, "GET", "/api/state", { token: m })).body.accounts.github[0].note === "",
     "and it can be cleared");
  const va = await call(h, "PATCH", `/api/token/${gh.id}`, { token: v, json: { note: "va wrote this" } });
  ok(va.status === 200, "the VA may write notes too — it is not a destructive action");

  // the in-use mark
  const app = byName["app-two"];      // deliberately an app with NO repo linked
  const p = await call(h, "PATCH", `/api/app/${app.id}`, { token: m, json: { paused: true } });
  ok(p.status === 200 && p.body.paused === 1, "a site can be marked not-in-use even with no repo linked",
     JSON.stringify(p.body));
  const st2 = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(st2.sites.find((x) => x.id === String(app.id)).paused === 1, "the mark comes back in the state");
  ok(st2.needs.paused === 1, "and the screen is told how many are marked");
  const lg2 = await logsOf(h, m);
  ok(lg2.entries.some((l) => l.action === "marked a site as not in use" && l.target === "app-two"), "logged plainly");
  const u = await call(h, "PATCH", `/api/app/${app.id}`, { token: m, json: { paused: false } });
  ok(u.status === 200 && u.body.paused === 0, "and it switches back");
  ok((await logsOf(h, m)).entries.some((l) => l.action === "marked a site as in use"), "which is logged too");
  // marking must not disturb the folder/branch settings
  const linked = await ready(h, m, byName, "app-one", "site-one", "public");
  await call(h, "PATCH", `/api/app/${linked}`, { token: m, json: { paused: true } });
  const st3 = (await call(h, "GET", "/api/state", { token: m })).body.sites.find((x) => x.id === String(linked));
  ok(st3.dir === "public" && st3.branch === "main" && st3.paused === 1,
     "marking a site leaves its folder and branch alone", JSON.stringify(st3));
}

console.log("\n── v18: an outage is never reported as a key problem ──");
{
  // GitHub's real answer on 2026-08-17: 503 with its own sentence.
  const h = newEnv({ ghBlobStatus: 503 });
  const { m, byName } = await setup(h);
  const appId = await ready(h, m, byName, "app-one", "site-one");
  const r = await call(h, "POST", "/api/deploy", { token: m, form: upload("x.html", "<p>x</p>", [appId]) });
  const batch = r.body.batch;
  let b = null;
  for (let i = 0; i < 8; i++) {
    b = (await call(h, "GET", `/api/batch/${batch}`, { token: m })).body;
    if ((b.targets || []).every((t) => ["live", "failed", "skipped", "no_app", "unknown"].includes(t.status))) break;
  }
  const t = (b.targets || [])[0] || {};
  ok(/having problems right now/i.test(t.detail || ""), "a 503 reads as the service being down", t.detail);
  ok(/not your key/i.test(t.detail || ""), "and says it is not your key");
  ok(!/expired|revoked|not allowed/i.test(t.detail || ""), "and never blames the key", t.detail);
  ok(!/No server is currently available/.test(t.detail || ""),
     "GitHub's own raw sentence is not what he reads", t.detail);
}
{
  // The 404 that caused the damage, through the real route: GitHub answering 404
  // for a branch that exists. It may still be a genuine 404, so both causes are
  // kept — but the harmless one comes first and the key comes last.
  const h = newEnv({ ghRefStatus: 404 });
  const { m, byName } = await setup(h);
  const appId = await ready(h, m, byName, "app-one", "site-one");
  const e = (await call(h, "GET", `/api/files/${appId}`, { token: m })).body.error || "";
  ok(/GitHub answered "not found"/.test(e), "the 404 is translated, not raw", e);
  ok(/having trouble right now/.test(e), "and offers the outage explanation first", e);
  ok(/Do not delete a key/.test(e), "telling him not to delete a key over it");
  ok(e.indexOf("cannot see it") > e.indexOf("try again in"),
     "so the key is the LAST suspect, not the first", e);
}

console.log("\n── v18: the panel can say whether GitHub or Heroku is down ──");
{
  const h = newEnv({ ghStatusIndicator: "major", ghStatusDescription: "Git Operations degraded",
                     hkStatusRows: [{ system: "Apps", status: "green" }] });
  const { m } = await setup(h);
  const r = await call(h, "GET", "/api/status", { token: m });
  ok(r.status === 200 && r.body.any_down === true, "it reads the vendors' own status pages", JSON.stringify(r.body));
  ok(r.body.github.ok === false && /degraded/i.test(r.body.github.description || ""), "GitHub's answer is passed on");
  ok(r.body.heroku.ok === true, "and Heroku's, separately");
}
{
  // An unreachable status page must never be reported as "all fine".
  const h = newEnv({ ghStatusFail: true, hkStatusFail: true });
  const { m } = await setup(h);
  const r = await call(h, "GET", "/api/status", { token: m });
  ok(r.body.github.unknown === true && r.body.heroku.unknown === true,
     "a status page we cannot reach is 'unknown', not 'ok'", JSON.stringify(r.body));
  ok(r.body.any_down === false, "and it does not claim an outage it cannot see");
}


console.log("\n── v20: a note on an app, in a colour, read on the Deploy screen ──");
{
  const h = newEnv();
  const { m, v, byName } = await setup(h);
  const app = byName["app-two"];                 // deliberately one with NO repo linked
  const st0 = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(st0.sites.every((x) => x.note === "" && x.note_color === "default"),
     "every app starts with an empty note and the plain colour");

  const r = await call(h, "PATCH", `/api/app/${app.id}`,
    { token: m, json: { note: "Client pays late — check before deploying", note_color: "red" } });
  ok(r.status === 200 && r.body.note_color === "red", "a note can be written on an app with no repo linked",
     JSON.stringify(r.body).slice(0, 140));
  const st1 = (await call(h, "GET", "/api/state", { token: m })).body;
  const one = st1.sites.find((x) => x.id === String(app.id));
  ok(one.note === "Client pays late — check before deploying" && one.note_color === "red",
     "and it comes back with the app, colour and all", JSON.stringify(one).slice(0, 160));
  const lg = await logsOf(h, m);
  ok(lg.entries.some((l) => l.action === "wrote a note on an app" && l.target === "app-two"), "and it is logged");

  // a colour that is not one of ours can never reach the screen
  await call(h, "PATCH", `/api/app/${app.id}`, { token: m, json: { note: "x", note_color: "javascript:alert(1)" } });
  const bad = (await call(h, "GET", "/api/state", { token: m })).body.sites.find((x) => x.id === String(app.id));
  ok(bad.note_color === "default", "an unknown colour falls back to plain — the panel maps NAMES, not values",
     bad.note_color);

  // clearing it
  await call(h, "PATCH", `/api/app/${app.id}`, { token: m, json: { note: "" } });
  const cleared = (await call(h, "GET", "/api/state", { token: m })).body.sites.find((x) => x.id === String(app.id));
  ok(cleared.note === "", "a note can be cleared");
  ok((await logsOf(h, m)).entries.some((l) => l.action === "cleared the note on an app"), "which is logged too");

  // the VA writes notes: it is not destructive, and she is the one who knows
  const va = await call(h, "PATCH", `/api/app/${app.id}`, { token: v, json: { note: "waiting on the client" } });
  ok(va.status === 200, "the VA can write a note");

  // and a note never disturbs the deploy settings
  const linked = await ready(h, m, byName, "app-one", "site-one", "public");
  await call(h, "PATCH", `/api/app/${linked}`, { token: m, json: { note: "live site", note_color: "green" } });
  const keep = (await call(h, "GET", "/api/state", { token: m })).body.sites.find((x) => x.id === String(linked));
  ok(keep.dir === "public" && keep.branch === "main" && keep.linked === true && keep.note_color === "green",
     "writing a note leaves the folder, branch and link alone", JSON.stringify(keep).slice(0, 200));
  const long = "x".repeat(400);
  await call(h, "PATCH", `/api/app/${linked}`, { token: m, json: { note: long } });
  const cut = (await call(h, "GET", "/api/state", { token: m })).body.sites.find((x) => x.id === String(linked));
  ok(cut.note.length === 300, "a very long note is cut to 300 characters rather than refused", String(cut.note.length));
}


console.log("\n── v24: a linked app that has never been deployed ──");
{
  // Linking is a record, not a deploy. A second app pointed at a repo another
  // app already uses has NO code of its own until something builds it.
  const h = newEnv();
  const { m, byName } = await setup(h);
  const appId = await ready(h, m, byName, "app-two", "site-one");
  const st = (await call(h, "GET", "/api/state", { token: m })).body;
  const one = st.sites.find((x) => x.id === String(appId));
  ok("released" in one, "the panel knows whether Heroku ever released an app");

  const r = await call(h, "POST", `/api/build/${appId}`, { token: m, json: {} });
  ok(r.status === 200 && r.body.ok === true, "an app can be built from its repo with no upload at all",
     JSON.stringify(r.body).slice(0, 160));
  ok(r.body.repo === "bob/site-one" && !!r.body.build_id, "the reply names the repo and the build");
  ok(/takes a minute/.test(r.body.message || ""), "and says what to expect");
  const built = h.calls.filter((c) => /\/apps\/app-two\/builds$/.test(c.url) && c.method === "POST");
  ok(built.length === 1, "exactly one build was asked for", String(built.length));
  ok(h.state.blobsWritten.length === 0 && h.state.commitsWritten.length === 0,
     "and NOTHING was committed — the repo is untouched",
     `${h.state.blobsWritten.length} blobs`);
  const lg = await logsOf(h, m);
  ok(lg.entries.some((l) => l.action === "started a build" && l.target === "app-two" &&
       /no files changed/.test(l.detail || "")), "the log says a build ran with no file change");
}
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  const r = await call(h, "POST", `/api/build/${byName["app-two"].id}`, { token: m, json: {} });
  ok(r.status === 400 && /Link a repo/.test(r.body.error || ""),
     "an app with no repo says what to do instead", JSON.stringify(r.body).slice(0, 120));
  const gone = await call(h, "POST", "/api/build/999999", { token: m, json: {} });
  ok(gone.status === 404, "and an app that is not here is a plain 404");
}
{
  // GitHub down while asking for the commit: never reported as the app's fault
  const h = newEnv({ ghRefStatus: 503 });
  const { m, byName } = await setup(h);
  const appId = await ready(h, m, byName, "app-one", "site-one");
  const r = await call(h, "POST", `/api/build/${appId}`, { token: m, json: {} });
  ok(r.status === 503 && /having problems/i.test(r.body.error || ""),
     "an outage answers as an outage", JSON.stringify(r.body).slice(0, 140));
}


console.log("\n── v24: one repo, several apps — a file change reaches them all ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  // two apps, one repo — exactly his 4-apps-to-1-repo shape, in miniature
  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  const repo = repos.find((r) => r.name === "site-one");
  for (const app of ["app-one", "app-two"]) {
    await call(h, "POST", "/api/link", { token: m, json: { app_id: byName[app].id, repo_id: repo.id } });
  }
  const st = (await call(h, "GET", "/api/state", { token: m })).body;
  // NB: the harness also has an app literally called "site-one", which the
  // refresh auto-links to the repo of the same name — so three share it.
  const sharing = st.sites.filter((x) => x.linked && x.repo === "site-one").map((x) => x.app).sort();
  ok(sharing.join(",") === "app-one,app-two,site-one", "several apps really do share one repo", String(sharing));

  const before = h.calls.filter((c) => /\/builds$/.test(c.url) && c.method === "POST").length;
  const r = await call(h, "POST", `/api/files/${byName["app-one"].id}`,
    { token: m, json: { files: [{ path: "index.html", contentB64: Buffer.from("<p>new</p>").toString("base64") }] } });
  ok(r.status === 200 && r.body.ok === true, "a file written from ONE app's File Manager saves");
  ok(Array.isArray(r.body.apps) && r.body.apps.slice().sort().join(",") === "app-one,app-two,site-one",
     "and the reply names EVERY app it rebuilt", JSON.stringify(r.body.apps));
  const built = h.calls.filter((c) => /\/builds$/.test(c.url) && c.method === "POST").length - before;
  ok(built === 3, "one build was started per app", String(built));
  const urls = h.calls.filter((c) => /\/builds$/.test(c.url) && c.method === "POST").map((c) => c.url);
  ok(urls.some((u) => u.includes("/apps/app-one/")) && urls.some((u) => u.includes("/apps/app-two/")),
     "and they are the right two apps", String(urls.slice(-2)));
  const lg = await logsOf(h, m);
  ok(lg.entries.filter((l) => l.action === "rebuilt after a file change").length >= 2,
     "the log records a rebuild for each");
  ok(lg.entries.some((l) => /one of 3 apps fed by/.test(l.detail || "")),
     "saying it was one of several fed by that repo");
}
{
  // and NOTHING outside that repo is touched
  const h = newEnv();
  const { m, byName } = await setup(h);
  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  await call(h, "POST", "/api/link",
    { token: m, json: { app_id: byName["app-one"].id, repo_id: repos.find((r) => r.name === "site-one").id } });
  await call(h, "POST", "/api/link",
    { token: m, json: { app_id: byName["app-two"].id, repo_id: repos.find((r) => r.name === "site-two").id } });
  const before = h.calls.filter((c) => /\/builds$/.test(c.url) && c.method === "POST").length;
  const r = await call(h, "POST", `/api/files/${byName["app-one"].id}`,
    { token: m, json: { files: [{ path: "index.html", contentB64: Buffer.from("<p>x</p>").toString("base64") }] } });
  const built = h.calls.filter((c) => /\/builds$/.test(c.url) && c.method === "POST").length - before;
  ok(built === 2 && r.body.apps.slice().sort().join(",") === "app-one,site-one",
     "only the apps on THAT repo are rebuilt — app-two, on another repo, is left alone",
     JSON.stringify(r.body.apps));
}


console.log("\n── v29: Created on / Last updated carry the VENDORS\' dates ──");
{
  const h = newEnv();
  const { m } = await setup(h);
  const st = (await call(h, "GET", "/api/state", { token: m })).body;
  const one = st.sites.find((x) => x.app === "app-one");
  const two = st.sites.find((x) => x.app === "app-two");
  ok(one.heroku_created_at === "2020-01-02T03:04:05Z",
     "an app carries HEROKU's creation date, not ours", String(one.heroku_created_at));
  ok(one.created_at && one.created_at !== one.heroku_created_at,
     "and our own 'when Gitku first saw it' is kept separately, not overwritten",
     `${one.created_at} vs ${one.heroku_created_at}`);
  ok(one.released_at === "2026-08-18T10:00:00Z",
     "and the release date is a DATE, not just the boolean", String(one.released_at));
  ok(two.heroku_created_at === null && two.released_at === null,
     "an app Heroku gave no dates for reads NULL — never a borrowed value",
     `${two.heroku_created_at}/${two.released_at}`);

  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  const r1 = repos.find((r) => r.name === "site-one");
  const r2 = repos.find((r) => r.name === "site-two");
  ok(r1.gh_created_at === "2021-03-04T09:00:00Z" && r1.pushed_at === "2026-08-19T11:22:33Z",
     "a repo carries GitHub's created_at and pushed_at", JSON.stringify([r1.gh_created_at, r1.pushed_at]));
  ok(r2.gh_created_at === null && r2.pushed_at === null,
     "and a repo GitHub gave no dates for reads NULL", JSON.stringify([r2.gh_created_at, r2.pushed_at]));
}
{
  // 🛑 THE ONE THAT MATTERS: a known repo must be UPDATED on every refresh.
  // It used to be skipped, so anything read from GitHub froze on the day we
  // first saw it — a "Last updated" column that never moves is a lie.
  const h = newEnv();
  const { m } = await setup(h);
  const before = (await call(h, "GET", "/api/repos", { token: m })).body.repos
    .find((r) => r.name === "site-one");
  ok(before.pushed_at === "2026-08-19T11:22:33Z", "first refresh recorded the push date");
  h.state.ghRepos = h.state.ghRepos.map((r) =>
    r.name === "site-one" ? { ...r, pushed_at: "2026-08-21T18:00:00Z" } : r);
  await call(h, "POST", "/api/refresh", { token: m, json: {} });
  const after = (await call(h, "GET", "/api/repos", { token: m })).body.repos
    .find((r) => r.name === "site-one");
  ok(after.pushed_at === "2026-08-21T18:00:00Z",
     "and a LATER refresh moves it — the date is never frozen at discovery",
     String(after.pushed_at));
  ok(after.id === before.id, "without making a second row for the same repo",
     `${before.id} -> ${after.id}`);
}
{
  // per-file dates come from OUR OWN upload history, never from GitHub
  const h = newEnv();
  const { m, byName } = await setup(h);
  const appId = await ready(h, m, byName, "app-one", "site-one");
  const ghBefore = h.calls.length;
  const r = await call(h, "GET", `/api/files/${appId}`, { token: m });
  ok(r.status === 200 && r.body.file_times && typeof r.body.file_times === "object",
     "the file list carries a per-file time map", JSON.stringify(r.body.file_times || null));
  ok(Object.keys(r.body.file_times).length === 0,
     "empty before anything has been uploaded through the panel — not guessed",
     JSON.stringify(r.body.file_times));
  ok(r.body.repo_commit_at === "2026-08-21T07:08:09Z",
     "and the branch's last commit date, which GitHub already sent us",
     String(r.body.repo_commit_at));
  const perFileCalls = h.calls.slice(ghBefore).filter((c) => /\/commits\?/.test(c.url)).length;
  ok(perFileCalls === 0,
     "and NOT ONE per-file commit request was made — that would blow the subrequest ceiling",
     String(perFileCalls));

  await call(h, "POST", `/api/files/${appId}`,
    { token: m, json: { files: [{ path: "public/index.html", contentB64: Buffer.from("<p>hi</p>").toString("base64") }] } });
  const after = await call(h, "GET", `/api/files/${appId}`, { token: m });
  ok(!!after.body.file_times["public/index.html"],
     "after a save through the panel, that exact path has a time",
     JSON.stringify(after.body.file_times));
  ok(after.body.file_times["README.md"] === undefined,
     "and a file the panel never wrote stays absent — it does not borrow the repo's date",
     JSON.stringify(after.body.file_times));
}

{
  // ⚠ The Deploy-screen half of the per-file dates, and the historic
  // batch_targets limb, had NO test: deleting the stamp from deployOne left the
  // suite green. Both are covered here.
  const h = newEnv();
  const { m, byName } = await setup(h);
  const appId = await ready(h, m, byName, "app-one", "site-one");
  const dep = await call(h, "POST", "/api/deploy",
    { token: m, form: upload("deployed.html", "<p>d</p>", [appId]) });
  ok(dep.status === 200 && !!dep.body.batch, "a Deploy-screen upload is accepted",
     JSON.stringify(dep.body).slice(0, 140));
  const files = await call(h, "GET", `/api/files/${appId}`, { token: m });
  const keys = Object.keys(files.body.file_times || {});
  ok(keys.some((k) => k.endsWith("deployed.html")),
     "and the path it wrote carries a date afterwards", JSON.stringify(keys));
}
{
  // a delete must take the date with it, or a path re-created outside Gitku
  // would show a date, and a tooltip claiming Gitku wrote it
  const h = newEnv();
  const { m, byName } = await setup(h);
  const appId = await ready(h, m, byName, "app-one", "site-one");
  // a path that really is in the repo, so the removal has something to remove
  await call(h, "POST", `/api/files/${appId}`,
    { token: m, json: { files: [{ path: "README.md", contentB64: Buffer.from("x").toString("base64") }] } });
  let r = await call(h, "GET", `/api/files/${appId}`, { token: m });
  ok(!!r.body.file_times["README.md"], "a written file has a date");
  const del = await call(h, "POST", `/api/files/${appId}`,
    { token: m, json: { message: "Delete README.md", remove: ["README.md"] } });
  ok(del.status === 200, "the delete is accepted", JSON.stringify(del.body).slice(0, 160));
  r = await call(h, "GET", `/api/files/${appId}`, { token: m });
  ok(r.body.file_times["README.md"] === undefined,
     "and deleting it takes the date away too", JSON.stringify(r.body.file_times));
}
{
  // an emoji must never be cut in half on its way into the database
  const h = newEnv();
  const { m, byName } = await setup(h);
  const id = byName["app-one"].id;
  const long = "x".repeat(299) + "\u2694\uFE0F";     // the cut lands inside the pair
  const r = await call(h, "PATCH", `/api/app/${id}`, { token: m, json: { note: long } });
  ok(r.status === 200, "a long note with an emoji saves");
  const st = (await call(h, "GET", "/api/state", { token: m })).body;
  const note = st.sites.find((x) => String(x.id) === String(id)).note;
  ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(note),
     "and no half of a surrogate pair is stored", JSON.stringify(note.slice(-4)));
}

console.log("\n── v32: a broken pairing must not hide an account\'s apps ──");
{
  // 🛑 HIS REPORT: "This email's Heroku has 7 apps but only 1 is visible."
  // The pairing's GitHub key had been deleted; the refresh read pairs with an
  // INNER JOIN, so the whole pair — including a perfectly good Heroku key —
  // was skipped and those apps were never pulled.
  const h = newEnv();
  const { m } = await setup(h);
  const st0 = (await call(h, "GET", "/api/state", { token: m })).body;
  const before = st0.sites.length;
  ok(before > 0, "the pair works to begin with", String(before));

  // delete the GitHub key, exactly as a person can from Accounts & keys
  const gh = st0.accounts.github[0];
  await call(h, "DELETE", `/api/token/${gh.id}`, { token: m, json: { confirm: gh.login || gh.account } });

  // its apps are gone from the panel with it (the cascade), which is the state
  // he was actually looking at
  const r = await call(h, "POST", "/api/refresh", { token: m, json: {} });
  ok(r.status === 200, "a refresh still runs with a half-dead pairing",
     JSON.stringify(r.body).slice(0, 160));
  const st1 = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(st1.sites.length > 0,
     "and the Heroku half's apps ARE pulled — not silently skipped",
     `${st1.sites.length} app(s)`);
  const said = (r.body.errors || []).join(" ");
  ok(/GitHub key/i.test(said) && /Accounts & keys/i.test(said),
     "and it says which key is missing and where to fix it", said.slice(0, 160));
}
{
  // a key in NO pairing at all was never read either
  const h = newEnv();
  const { m } = await setup(h);
  const st0 = (await call(h, "GET", "/api/state", { token: m })).body;
  const combo = (st0.combos || [])[0];
  if (combo) await call(h, "DELETE", `/api/combo/${combo.id}`, { token: m });
  const r = await call(h, "POST", "/api/refresh", { token: m, json: {} });
  ok(r.status === 200 && Number(r.body.apps || 0) > 0,
     "an unpaired Heroku key still reports its apps",
     JSON.stringify(r.body).slice(0, 140));
}

{
  // 🛑 HIS REPORT, THIRD TIME: remove a key, connect it again, and nothing heals.
  // The pairing keeps pointing at the id of the key that was deleted, so the
  // account can list its apps but never link one to a repo.
  //
  // ⚠️ TWO accounts of each kind, deliberately. With only one of each, the old
  // "first pair" shortcut makes a brand-new pairing and the bug is invisible —
  // which is exactly how the first version of this test passed with the fix
  // switched off. His real panel has eight.
  const h = newEnv({
    ghUserByToken: { ghp_second: "secondaccount" },
    hkUserByToken: { hk_second: "second@example.com" },
  });
  const { m } = await setup(h);
  await call(h, "POST", "/api/token", { token: m, json: { kind: "github", token: "ghp_second" } });
  await call(h, "POST", "/api/token", { token: m, json: { kind: "heroku", token: "hk_second" } });

  const st0 = (await call(h, "GET", "/api/state", { token: m })).body;
  ok((st0.accounts.github || []).length === 2, "two GitHub keys, so the one-pair shortcut cannot fire",
     String((st0.accounts.github || []).length));
  const gh = (st0.accounts.github || []).find((x) => (x.login || x.account) === "bobaccount");
  const comboBefore = (st0.combos || []).length;

  await call(h, "DELETE", `/api/token/${gh.id}`, { token: m, json: { confirm: gh.login || gh.account } });
  const mid = (await call(h, "GET", "/api/state", { token: m })).body;
  const liveMid = new Set((mid.accounts.github || []).map((x) => String(x.id)));
  const brokenMid = (mid.combos || []).filter((k) => !liveMid.has(String(k.github_conn_id)));
  ok(brokenMid.length === 1,
     "deleting the key leaves a pairing pointing at nothing — the state he was in",
     JSON.stringify((mid.combos || []).map((k) => k.github_conn_id)));

  // connect it again, exactly as a person would
  const re = await call(h, "POST", "/api/token",
    { token: m, json: { kind: "github", token: "ghp_reconnected" } });
  ok(re.status === 200, "the key connects again", JSON.stringify(re.body).slice(0, 120));

  const st1 = (await call(h, "GET", "/api/state", { token: m })).body;
  const live = new Set((st1.accounts.github || []).map((x) => String(x.id)));
  const broken = (st1.combos || []).filter((k) => !live.has(String(k.github_conn_id)));
  ok(broken.length === 0,
     "and the pairing now points at the NEW key, not the deleted one",
     JSON.stringify((st1.combos || []).map((k) => k.github_conn_id)));
  ok((st1.combos || []).length === comboBefore,
     "without making a second pairing", `${comboBefore} -> ${(st1.combos || []).length}`);
  const lg = await logsOf(h, m);
  ok(lg.entries.some((l) => l.action === "repaired a pairing"),
     "and it says it repaired it, rather than healing silently");
}

{
  // 🛑 The automatic pass must stay cheap. Adding it to the cron blew the
  // 50-outbound-call ceiling on every tick — 394 failures in three hours —
  // because it also ran the buildpack pass, which reads a branch HEAD per app.
  const h = newEnv();
  const { m, byName } = await setup(h);
  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  for (const app of ["app-one", "app-two"]) {
    await call(h, "POST", "/api/link",
      { token: m, json: { app_id: byName[app].id, repo_id: repos.find((r) => r.name === "site-one").id } });
  }
  const mod = await import("../worker/lib/panel.js");

  h.calls.length = 0;
  await mod.refreshCombos(h.env, "panel");
  const full = h.calls.filter((c) => /api\.github\.com|api\.heroku\.com/.test(c.url)).length;

  h.calls.length = 0;
  await mod.refreshCombos(h.env, "panel", undefined, { skipBuildpack: true });
  const cheap = h.calls.filter((c) => /api\.github\.com|api\.heroku\.com/.test(c.url)).length;

  ok(cheap < full, "the automatic pass makes FEWER vendor calls than a person's Refresh",
     `${cheap} vs ${full}`);
  ok(!h.calls.some((c) => /\/git\/ref\/heads\//.test(c.url)),
     "and reads no branch HEADs at all — that is the part that blew the ceiling",
     String(h.calls.filter((c) => /\/git\/ref\//.test(c.url)).length));
  ok(cheap <= 20, "so a tick stays well inside the 50-call ceiling", String(cheap));
}

console.log("\n── v31: tags — written once, clicked onto any app ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  const one = byName["app-one"].id, two = byName["app-two"].id;

  const mk = await call(h, "POST", "/api/tag", { token: m, json: { label: "Client site", color: "amber" } });
  ok(mk.status === 200 && mk.body.id, "a tag can be made", JSON.stringify(mk.body).slice(0, 120));
  const tid = mk.body.id;

  const again = await call(h, "POST", "/api/tag", { token: m, json: { label: "Client site", color: "amber" } });
  ok(again.body.already === true && again.body.id === tid,
     "and the same words in the same colour never become a second tag", JSON.stringify(again.body));

  const put = await call(h, "POST", `/api/app/${one}/tag`, { token: m, json: { tag_id: tid } });
  ok(put.status === 200 && (put.body.app.tags || []).map(String).includes(String(tid)),
     "one press puts it on an app", JSON.stringify(put.body.app.tags));
  await call(h, "POST", `/api/app/${two}/tag`, { token: m, json: { tag_id: tid } });

  let st = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(Array.isArray(st.tags) && st.tags.length === 1, "the tag list comes with the state",
     JSON.stringify(st.tags));
  ok(String(st.tags[0].uses) === "2", "and says how many apps carry it", String(st.tags[0].uses));
  ok(st.sites.filter((x) => (x.tags || []).map(String).includes(String(tid))).length === 2,
     "both apps carry it");

  const off = await call(h, "DELETE", `/api/app/${one}/tag/${tid}`, { token: m });
  ok(off.status === 200 && !(off.body.app.tags || []).map(String).includes(String(tid)),
     "one press takes it off again", JSON.stringify(off.body.app.tags));
  st = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(String(st.tags[0].uses) === "1", "and only that app loses it", String(st.tags[0].uses));

  const ren = await call(h, "PATCH", `/api/tag/${tid}`, { token: m, json: { label: "Client work" } });
  ok(ren.status === 200 && ren.body.label === "Client work", "a tag can be renamed everywhere at once");
  st = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(st.tags[0].label === "Client work" && st.tags[0].color === "amber",
     "the rename keeps the colour", JSON.stringify(st.tags[0]));

  // 🛑 `DELETE /api/app/{id}/tag/{tagId}` also matches the route that DELETES AN
  // APP. In the offline demo it really did remove the app. Lock the order here.
  const stillThere = (await call(h, "GET", "/api/state", { token: m })).body
    .sites.some((x) => String(x.id) === String(one));
  ok(stillThere, "taking a tag off an app does NOT delete the app");

  const del = await call(h, "DELETE", `/api/tag/${tid}`, { token: m });
  ok(del.status === 200 && del.body.uses === 1,
     "deleting a tag SAYS how many apps it was on", JSON.stringify(del.body));
  st = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(st.tags.length === 0 && st.sites.every((x) => !(x.tags || []).length),
     "and it is gone from the list and from every app");
}
{
  // 🛑 A NEW TABLE MUST HEAL ITSELF ON THE REQUEST THAT NEEDS IT.
  // When `tags` first shipped, every /api/state 500'd on the LIVE panel until
  // the cron happened to fire: the request path creates no tables by design,
  // and runMigrations only adds COLUMNS. Dropping the tables reproduces it.
  const h = newEnv();
  const { m } = await setup(h);
  await h.env.DB.prepare("DROP TABLE IF EXISTS app_tags").run();
  await h.env.DB.prepare("DROP TABLE IF EXISTS tags").run();
  const healed = await call(h, "GET", "/api/state", { token: m });
  ok(healed.status === 200 && Array.isArray(healed.body.tags),
     "a missing table is created by the request that needs it, not by luck",
     `${healed.status} ${JSON.stringify(healed.body).slice(0, 140)}`);
}
{
  // 🛑 the migration: his notes become tags, deduplicated, and the notes STAY
  const h = newEnv();
  const { m, byName } = await setup(h);
  const ids = ["app-one", "app-two", "site-one"].map((n) => byName[n].id);
  for (const id of ids.slice(0, 2)) {
    await call(h, "PATCH", `/api/app/${id}`, { token: m, json: { note: "17/8 - 6 . về", note_color: "green" } });
  }
  await call(h, "PATCH", `/api/app/${ids[2]}`, { token: m, json: { note: "BOCA - 1", note_color: "green" } });
  // The one-time pass is guarded by "are there any tags yet". Clear the table and
  // make the worker forget it has run, so the real migration executes here.
  await h.env.DB.prepare("DELETE FROM tags").run();
  await h.env.DB.prepare("DELETE FROM app_tags").run();
  const mod = await import("../worker/lib/panel.js");
  await mod.ensurePanelSchema(h.env, true);
  const st = (await call(h, "GET", "/api/state", { token: m })).body;
  const labels = (st.tags || []).map((t) => t.label).sort();
  ok(labels.length === 2, "two different notes become two tags, not three",
     JSON.stringify(labels));
  ok(labels.join("|") === "17/8 - 6 . về|BOCA - 1", "with his exact words", JSON.stringify(labels));
  const shared = st.tags.find((t) => t.label === "17/8 - 6 . về");
  ok(String(shared.uses) === "2", "and the one written twice is ONE tag on two apps", String(shared.uses));
  ok(st.sites.filter((x) => x.note).length === 3,
     "🛑 and every original note is still there, untouched",
     String(st.sites.filter((x) => x.note).length));
}

console.log("\n── v27: one press builds every app on a repo ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  const repo = repos.find((r) => r.name === "site-one");
  for (const app of ["app-one", "app-two"]) {
    await call(h, "POST", "/api/link", { token: m, json: { app_id: byName[app].id, repo_id: repo.id } });
  }
  const before = h.calls.filter((c) => /\/builds$/.test(c.url) && c.method === "POST").length;
  const r = await call(h, "POST", `/api/build/repo/${repo.id}`, { token: m, json: {} });
  ok(r.status === 200 && r.body.ok === true, "a repo builds all of its apps in one press",
     JSON.stringify(r.body).slice(0, 200));
  const names = (r.body.results || []).map((x) => x.app).sort().join(",");
  ok(names === "app-one,app-two,site-one", "and the reply names every one", names);
  ok(r.body.started === 3 && r.body.failed === 0, "all three started", `${r.body.started}/${r.body.failed}`);
  const built = h.calls.filter((c) => /\/builds$/.test(c.url) && c.method === "POST").length - before;
  ok(built === 3, "one Heroku build per app", String(built));
  ok(h.state.blobsWritten.length === 0 && h.state.commitsWritten.length === 0,
     "and NOTHING was committed — no repo was touched", `${h.state.blobsWritten.length} blobs`);
  // ⭐ the whole point of the helper: the archive is fetched ONCE, not once per app
  const arch = h.calls.filter((c) => /tarball/.test(c.url)).length;
  ok(arch === 1, "the archive is read ONCE for all three apps, not once each", String(arch));
  const lg = await logsOf(h, m);
  ok(lg.entries.filter((l) => l.action === "started a build").length >= 3, "each build is logged");
  ok(lg.entries.some((l) => /one of 3 app\(s\) on this repo/.test(l.detail || "")),
     "and the line says it was one of several on that repo");
}
{
  // a repo nothing points at, and a repo that is not here at all
  const h = newEnv();
  const { m } = await setup(h);
  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  const spare = repos.find((r) => r.name === "site-two");
  const r = await call(h, "POST", `/api/build/repo/${spare.id}`, { token: m, json: {} });
  ok(r.status === 409 && /No app takes its files from/.test(r.body.error || ""),
     "a repo with no app says so instead of pretending to build", JSON.stringify(r.body).slice(0, 140));
  const gone = await call(h, "POST", "/api/build/repo/999999", { token: m, json: {} });
  ok(gone.status === 404, "a repo that is not here is a plain 404");
  const junk = await call(h, "POST", "/api/build/repo/abc", { token: m, json: {} });
  ok(junk.status === 404, "and so is a nonsense id", String(junk.status));
}
{
  // ⚠️ the single-app route must still work — /api/build/repo/N also matches
  // "build" + a first segment, and a shadowed route is a silent wrong answer
  const h = newEnv();
  const { m, byName } = await setup(h);
  const appId = await ready(h, m, byName, "app-one", "site-one");
  const r = await call(h, "POST", `/api/build/${appId}`, { token: m, json: {} });
  ok(r.status === 200 && r.body.app === "app-one",
     "the single-app build route is not shadowed by the repo one", JSON.stringify(r.body).slice(0, 120));
}
{
  // GitHub down while reading the commit
  const h = newEnv({ ghRefStatus: 503 });
  const { m, byName } = await setup(h);
  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  const repo = repos.find((r) => r.name === "site-one");
  await call(h, "POST", "/api/link", { token: m, json: { app_id: byName["app-one"].id, repo_id: repo.id } });
  const r = await call(h, "POST", `/api/build/repo/${repo.id}`, { token: m, json: {} });
  ok(r.status === 503 && /having problems/i.test(r.body.error || ""),
     "an outage answers as an outage, not as a broken repo", JSON.stringify(r.body).slice(0, 140));
}
{
  // Heroku refuses one app: the others must still start, and the reply must
  // carry `error` as well as `message` when NOTHING started
  const h = newEnv({ hkBuildStatus: 503 });
  const { m, byName } = await setup(h);
  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  const repo = repos.find((r) => r.name === "site-one");
  await call(h, "POST", "/api/link", { token: m, json: { app_id: byName["app-one"].id, repo_id: repo.id } });
  const r = await call(h, "POST", `/api/build/repo/${repo.id}`, { token: m, json: {} });
  ok(r.status === 502 && !!r.body.error,
     "when none of them start, the failure carries an error the panel can show",
     JSON.stringify(r.body).slice(0, 160));
  ok(r.body.ok === false && r.body.failed >= 1, "and it is honest about the count",
     `${r.body.ok}/${r.body.failed}`);
  // and the commit must NOT be recorded, or the cron never retries them
  const st = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(Array.isArray(st.sites), "state still reads after a failed build sweep");
}

console.log("\n── v25: the panel rebuilds an app when its repo moves, by itself ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  const repo = repos.find((r) => r.name === "site-one");
  for (const app of ["app-one", "app-two"]) {
    await call(h, "POST", "/api/link", { token: m, json: { app_id: byName[app].id, repo_id: repo.id } });
  }
  const { pollPanelBuilds } = await import("../worker/lib/panel.js");

  // First tick: nothing has ever been built, so every linked app is built once.
  let before = h.calls.filter((c) => /\/builds$/.test(c.url) && c.method === "POST").length;
  await pollPanelBuilds(h.env);
  const first = h.calls.filter((c) => /\/builds$/.test(c.url) && c.method === "POST").length - before;
  ok(first >= 2, "the first tick builds the apps that had never been built", String(first));
  const lg = await logsOf(h, m);
  ok(lg.entries.some((l) => l.action === "built an app for the first time"), "and says exactly that");

  // Second tick: the repo has NOT moved, so nothing is built. This is the one
  // that matters — a loop here would rebuild every app every five minutes.
  before = h.calls.filter((c) => /\/builds$/.test(c.url) && c.method === "POST").length;
  await pollPanelBuilds(h.env);
  const idle = h.calls.filter((c) => /\/builds$/.test(c.url) && c.method === "POST").length - before;
  ok(idle === 0, "an unchanged repo costs NOTHING on the next tick", String(idle));

  // The repo moves — as it would from a File Manager save, or a push on GitHub.
  h.state.gitRefSha = "commitMOVED";
  before = h.calls.filter((c) => /\/builds$/.test(c.url) && c.method === "POST").length;
  await pollPanelBuilds(h.env);
  const after = h.calls.filter((c) => /\/builds$/.test(c.url) && c.method === "POST").length - before;
  ok(after >= 2, "when the repo moves, EVERY app on it is rebuilt with no one pressing anything",
     String(after));
  const lg2 = await logsOf(h, m);
  ok(lg2.entries.some((l) => l.action === "rebuilt an app after its repo changed" &&
       /commitM/.test(l.detail || "")), "the log names the commit it rebuilt from");
  // measured across ONE tick: three apps share one repo, so one read, not three
  const mark = h.calls.length;
  h.state.gitRefSha = "commitMOVED2";
  await pollPanelBuilds(h.env);
  const heads = h.calls.slice(mark).filter((c) => /\/git\/ref\/heads\//.test(c.url)).length;
  const builtNow = h.calls.slice(mark).filter((c) => /\/builds$/.test(c.url) && c.method === "POST").length;
  ok(heads === 1 && builtNow >= 2,
     "one HEAD read per repo per tick, however many apps hang off it",
     `${heads} reads for ${builtNow} builds`);
}
{
  // GitHub unreachable: the tick must do nothing at all, quietly.
  const h = newEnv({ ghRefStatus: 503 });
  const { m, byName } = await setup(h);
  await ready(h, m, byName, "app-one", "site-one");
  const { pollPanelBuilds } = await import("../worker/lib/panel.js");
  const before = h.calls.filter((c) => /\/builds$/.test(c.url) && c.method === "POST").length;
  await pollPanelBuilds(h.env);
  ok(h.calls.filter((c) => /\/builds$/.test(c.url) && c.method === "POST").length === before,
     "GitHub being down builds nothing and breaks nothing");
}


{
  // A build that fails must NOT be recorded as done, or it is never retried.
  const h = newEnv({ hkDeleteStatus: 200 });
  const { m, byName } = await setup(h);
  await ready(h, m, byName, "app-one", "site-one");
  const { pollPanelBuilds } = await import("../worker/lib/panel.js");
  h.state.hkBuildStatus = 500;      // Heroku refuses the build
  await pollPanelBuilds(h.env);
  const lg = await logsOf(h, m);
  ok(lg.entries.some((l) => l.action === "could not rebuild an app after its repo changed" &&
       /tried again/.test(l.detail || "")), "a failed build says it will be tried again");
  h.state.hkBuildStatus = 201;      // Heroku recovers
  const before = h.calls.filter((c) => /\/builds$/.test(c.url) && c.method === "POST").length;
  await pollPanelBuilds(h.env);
  ok(h.calls.filter((c) => /\/builds$/.test(c.url) && c.method === "POST").length > before,
     "and the next tick really does try it again — the failure was not recorded as done");
}

console.log("\n── v35: the diary reads the day back, and keeps only his words ──");
{
  const h = newEnv();
  const { m, v, byName } = await setup(h);
  // do a few real things so the day has facts of its own
  const repos = (await call(h, "GET", "/api/repos", { token: m })).body.repos;
  const repo = repos.find((r) => r.name === "site-one");
  await call(h, "POST", "/api/link", { token: m, json: { app_id: byName["app-one"].id, repo_id: repo.id } });
  await call(h, "POST", `/api/build/repo/${repo.id}`, { token: m, json: {} });

  const d0 = (await call(h, "GET", "/api/diary", { token: m })).body;
  ok(d0.ok === true && /^\d{4}-\d{2}-\d{2}$/.test(d0.day), "it opens on today by itself", d0.day);
  ok(d0.summary && d0.summary.total > 0, "and the day already has facts, with nothing typed in",
     JSON.stringify(d0.summary));
  ok(d0.summary.builds >= 1, "the builds it counts are the builds that happened", String(d0.summary.builds));
  ok(Array.isArray(d0.touched) && d0.touched.length > 0,
     "the things touched that day are offered to pick from", JSON.stringify(d0.touched).slice(0, 160));
  ok(d0.notes.length === 0, "and no notes until someone writes one");

  const app = d0.touched[0];
  ok((await call(h, "POST", "/api/diary", { token: m,
       json: { note: "moved the pricing block", ref_kind: "app", ref_label: app.ref } })).status === 200,
     "a note saves against one of them");
  ok((await call(h, "POST", "/api/diary", { token: m, json: { note: "  " } })).status >= 400,
     "an empty note is refused, not stored blank");

  const d1 = (await call(h, "GET", "/api/diary", { token: m })).body;
  ok(d1.notes.length === 1 && d1.notes[0].note === "moved the pricing block",
     "it reads back on that day", JSON.stringify(d1.notes));
  ok(d1.notes[0].ref_label === app.ref, "still naming what it was about", d1.notes[0].ref_label);
  ok(d1.notes[0].actor === "master1", "and who wrote it", d1.notes[0].actor);

  // 🛑 the point of storing the LABEL: he deletes apps every day
  await call(h, "DELETE", `/api/app/${byName["app-one"].id}`, { token: m, json: { name: "app-one" } });
  const d2 = (await call(h, "GET", "/api/diary", { token: m })).body;
  ok(d2.notes.length === 1 && d2.notes[0].ref_label === app.ref,
     "a note about a DELETED app is still readable", JSON.stringify(d2.notes[0] || {}));

  // an old day is empty rather than wrong
  const old = (await call(h, "GET", "/api/diary?day=2020-01-01", { token: m })).body;
  ok(old.day === "2020-01-01" && old.notes.length === 0 && !old.summary.total,
     "a day with nothing on it says nothing, and does not borrow today's", JSON.stringify(old.summary));
  const bad = (await call(h, "GET", "/api/diary?day=not-a-day", { token: m })).body;
  ok(bad.day === d0.day, "a nonsense day falls back to today rather than erroring", bad.day);

  ok(Array.isArray(d1.days) && d1.days.some((x) => x.day === d0.day),
     "the picker lists the days that have something on them", JSON.stringify(d1.days).slice(0, 120));

  const id = d1.notes[0].id;
  ok((await call(h, "DELETE", `/api/diary/${id}`, { token: v })).status === 403,
     "a VA cannot delete someone else's note");
  ok((await call(h, "DELETE", `/api/diary/${id}`, { token: m })).status === 200,
     "the person who wrote it can");
  ok((await call(h, "GET", "/api/diary", { token: m })).body.notes.length === 0, "and it is gone");
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
