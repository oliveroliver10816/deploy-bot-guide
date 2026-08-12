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

/** Fully wire a panel: users, tokens, two sites, one linked app. */
async function setup(h) {
  await call(h, "GET", "/api/state"); // forces schema creation
  await createUser(h.env, "master1", "masterpass1", "master");
  await createUser(h.env, "va1", "vapassword1", "va");
  const m = (await call(h, "POST", "/api/login", { json: { username: "master1", password: "masterpass1" } })).body.session;
  await call(h, "POST", "/api/token", { token: m, json: { kind: "github", token: "ghp_x" } });
  await call(h, "POST", "/api/token", { token: m, json: { kind: "heroku", token: "hk_x" } });
  const conns = (await call(h, "GET", "/api/state", { token: m })).body.accounts;
  const gh = conns.github[0].id, hk = conns.heroku[0].id;
  const s1 = (await call(h, "POST", "/api/site", { token: m, json: { conn_id: gh, owner: "bob", repo: "site-one", branch: "main", label: "one.com", url: "https://one.com", dir: "public" } })).body.id;
  const s2 = (await call(h, "POST", "/api/site", { token: m, json: { conn_id: gh, owner: "bob", repo: "site-two", branch: "main", label: "two.com", url: "https://two.com", dir: "public" } })).body.id;
  await call(h, "POST", "/api/link", { token: m, json: { site_id: s1, app_conn_id: hk, heroku_name: "app-one" } });
  const v = (await call(h, "POST", "/api/login", { json: { username: "va1", password: "vapassword1" } })).body.session;
  return { m, v, s1, s2, gh, hk };
}

const upload = (name, content, sites, mode = "auto") => {
  const f = new FormData();
  f.append("file", new File([content], name));
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
  ok(r.body.role === "master", "role comes back with the session");

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

console.log("\n── roles ──");
{
  const h = newEnv();
  const { m, v, s1 } = await setup(h);
  ok((await call(h, "GET", "/api/state", { token: v })).status === 200, "VA can read state");
  ok((await call(h, "GET", "/api/state", { token: v })).body.users.length === 0, "VA state hides the user list");
  ok((await call(h, "GET", "/api/state", { token: m })).body.users.length === 2, "master sees users");

  for (const [method, path, json] of [
    ["POST", "/api/token", { kind: "github", token: "x" }],
    ["POST", "/api/site", { conn_id: 1, owner: "a", repo: "b" }],
    ["DELETE", `/api/site/${s1}`, undefined],
    ["POST", "/api/user", { username: "eve", password: "password123", role: "master" }],
    ["POST", "/api/repo/create", { conn_id: 1, name: "x" }],
    ["POST", "/api/app/create", { conn_id: 1, name: "x" }],
    ["GET", "/api/discover/repos", undefined],
  ]) {
    const r = await call(h, method, path, { token: v, json });
    ok(r.status === 403, `VA is refused ${method} ${path}`);
  }

  // The tokens themselves must never be readable through the API.
  const st = JSON.stringify((await call(h, "GET", "/api/state", { token: m })).body);
  ok(!st.includes("ghp_x") && !st.includes("hk_x"), "API never returns the stored GitHub/Heroku tokens");
}

console.log("\n── deploy fan-out ──");
{
  const h = newEnv();
  const { m, s1, s2 } = await setup(h);
  h.calls.length = 0;
  const r = await call(h, "POST", "/api/deploy", { token: m, form: upload("index.html", "<new>new page</new>", [s1, s2]) });
  ok(r.status === 200 && !!r.body.batch, "deploy returns a batch id immediately");
  ok(r.body.targets.length === 2, "both sites are queued");

  const puts = h.calls.filter((c) => c.method === "PUT" && c.url.includes("/contents/"));
  ok(puts.length === 2, "one commit per selected site", `saw ${puts.length}`);
  ok(puts.every((p) => JSON.parse(p.body).content === Buffer.from("<new>new page</new>").toString("base64")),
     "the same exact bytes went to every site");
  ok(puts.every((p) => p.url.includes("public/index.html")), "each site used its own configured folder");

  const st = await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  ok(st.body.targets.every((t) => typeof t.site_id === "string"), "batch site_id is a string, matching /api/state");
  const byLabel = Object.fromEntries(st.body.targets.map((t) => [t.label, t]));
  ok(byLabel["one.com"].status === "building", "linked site moves to building");
  ok(byLabel["two.com"].status === "no_app", "unlinked site reports no_app, not failure");

  // privacy path: the signed codeload URL is handed to Heroku, archive not pulled through us
  const build = h.calls.find((c) => c.url.includes("/builds") && c.method === "POST");
  ok(!!build && JSON.parse(build.body).source_blob.url.includes("codeload.github.com"),
     "Heroku is given the signed GitHub URL, so repo contents never transit the Worker");
  ok(!h.calls.some((c) => c.url.startsWith("https://s3.example/put")), "no archive upload happened on the fast path");
}

console.log("\n── partial failure ──");
{
  const h = newEnv();
  const { m, s1, s2 } = await setup(h);
  // site-two has no such file, so mode=replace must fail there and only there
  h.state.ghTree["public"] = [{ type: "file", name: "index.html", sha: "shaINDEX", size: 10 }];
  const r = await call(h, "POST", "/api/deploy", { token: m, form: upload("missing.html", "x", [s1, s2], "replace") });
  const st = await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  ok(st.body.targets.every((t) => t.status === "failed"), "replace-only mode fails when the file is absent");
  ok(st.body.targets.every((t) => /does not exist/i.test(t.detail || "")), "the reason is stated in plain words");
  ok(st.body.done === true, "batch reports done once every target settled");
}
{
  const h = newEnv();
  const { m, s1 } = await setup(h);
  const r = await call(h, "POST", "/api/deploy", { token: m, form: upload("index.html", "x", [s1], "new") });
  const st = await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  ok(st.body.targets[0].status === "failed" && /already exists/i.test(st.body.targets[0].detail),
     "new-only mode refuses to clobber an existing file");
}

console.log("\n── build polling ──");
{
  const h = newEnv({ buildStatus: "succeeded" });
  const { m, s1 } = await setup(h);
  const r = await call(h, "POST", "/api/deploy", { token: m, form: upload("index.html", "x", [s1]) });
  const { ctx, settle } = makeCtx();
  await worker.scheduled({}, h.env, ctx); await settle();
  const st = await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  ok(st.body.targets[0].status === "live", "successful build becomes live");
}
{
  const h = newEnv({ buildStatus: "failed" });
  const { m, s1 } = await setup(h);
  const r = await call(h, "POST", "/api/deploy", { token: m, form: upload("index.html", "x", [s1]) });
  const { ctx, settle } = makeCtx();
  await worker.scheduled({}, h.env, ctx); await settle();
  const st = await call(h, "GET", `/api/batch/${r.body.batch}`, { token: m });
  ok(st.body.targets[0].status === "failed", "failed build is reported failed");
  ok(/compiler error/.test(st.body.targets[0].detail || ""), "failure carries the build log tail");
}

console.log("\n── undo a batch ──");
{
  const h = newEnv({ buildStatus: "succeeded" });
  const { m, s1, s2 } = await setup(h);
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

console.log("\n── sites and limits ──");
{
  const h = newEnv();
  const { m, gh } = await setup(h);
  const dup = await call(h, "POST", "/api/site", { token: m, json: { conn_id: gh, owner: "bob", repo: "site-one", label: "dup" } });
  ok(dup.status === 400 && /already/i.test(dup.body.error), "the same repo cannot be added twice");

  const patched = await call(h, "PATCH", "/api/site/1", { token: m, json: { dir: "/dist/", label: "renamed.com" } });
  ok(patched.status === 200, "site can be edited");
  const st2 = (await call(h, "GET", "/api/state", { token: m })).body;
  ok(st2.sites.every((x) => typeof x.id === "string"),
     "site ids are strings — the UI reads them from DOM datasets and compares with ===");
  const s = st2.sites.find((x) => x.id === "1");
  ok(s.dir === "dist", "leading and trailing slashes are stripped from the folder");
  ok(s.label === "renamed.com", "label updated");

  const many = await call(h, "POST", "/api/deploy", { token: m, form: upload("a.html", "x", [1,2,3,4,5,6,7,8,9,10,11]) });
  ok(many.status === 400 && /10 sites at once/.test(many.body.error), "batch size is capped with a clear message");

  const none = await call(h, "POST", "/api/deploy", { token: m, form: upload("a.html", "x", []) });
  ok(none.status === 400 && /at least one/i.test(none.body.error), "deploying to no sites is refused");
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
