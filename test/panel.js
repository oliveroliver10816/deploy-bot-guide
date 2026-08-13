/**
 * Panel API tests. Drives the real Worker fetch handler over /api/* against a
 * real SQLite database and a mock network. No live credentials anywhere.
 */
import worker from "../worker/worker.js";
import { createUser } from "../worker/lib/panel.js";
import { makeDB, makeNet, makeCtx } from "./harness.js";

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

  const combo = await call(h, "POST", "/api/combo", { token: m, json: {
    github_conn_id: st.accounts.github[1].id, heroku_conn_id: st.accounts.heroku[0].id } });
  ok(combo.status === 200, "a new pair can be made explicitly");
  const st2 = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(st2.combos.length === 2, "both pairs exist side by side", String(st2.combos.length));

  const dupe = await call(h, "POST", "/api/combo", { token: m, json: {
    github_conn_id: st.accounts.github[1].id, heroku_conn_id: st.accounts.heroku[0].id } });
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

console.log("\n── an app with no repository ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  const r = await call(h, "POST", "/api/deploy", { token: m, form: upload("index.html", "x", [byName["app-two"].id]) });
  const st = await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  ok(st.body.targets[0].status === "failed", "an unlinked app fails rather than silently doing nothing");
  ok(/no repository linked/i.test(st.body.targets[0].detail || ""), "and says exactly what to do",
     st.body.targets[0].detail || "");
  ok(st.body.targets[0].label === "app-two", "the failure is labelled with the app name");
}

console.log("\n── two apps sharing one repository ──");
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
  ok(/same repository/i.test(skipped[0].detail || ""), "and the reason is stated");
}

console.log("\n── repository files ──");
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
  ok(nolink.status === 400 && /Link a repository/i.test(nolink.body.error), "an app with no repo explains itself");
}

console.log("\n── the deploy screen warns BEFORE you open Files ──");
{
  const h = newEnv();
  const { m, byName } = await setup(h);
  // straight after connecting keys, with nothing else touched
  const st = (await call(h, "GET", "/api/state", { token: m })).body;
  const linked = st.sites.filter((x) => x.linked);
  ok(linked.length >= 1, "there is a linked app to judge", String(linked.length));
  ok(linked.every((x) => x.buildpack === null),
     "a linked app reports buildpack null on the DEPLOY screen, without opening Files first",
     JSON.stringify(linked.map((x) => [x.label, x.buildpack])));
  const unlinked = st.sites.filter((x) => !x.linked);
  ok(unlinked.every((x) => x.buildpack === undefined),
     "an app with no repo is not judged at all", JSON.stringify(unlinked.map((x) => x.buildpack)));

  // once it can build, the deploy screen stops warning
  h.state.gitTree = [{ path: "index.php", type: "blob", size: 36, sha: "x" }];
  await call(h, "POST", "/api/refresh", { token: m, json: {} });
  const st2 = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(st2.sites.filter((x) => x.linked).every((x) => x.buildpack === "php"),
     "and reports php once it can build", JSON.stringify(st2.sites.map((x) => x.buildpack)));
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

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
