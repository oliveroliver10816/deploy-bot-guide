/**
 * Integration tests. Drives the real Worker entry point (fetch/scheduled) with
 * fake Telegram updates against a real SQLite DB and a mock network.
 */
import worker from "../worker/worker.js";
import { makeDB, makeNet, makeCtx, msg, cb } from "./harness.js";

const OWNER = 558755209;
const VA = 999111222;

let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ""}`); }
};

function newEnv(netOpts = {}) {
  const { net, calls, state } = makeNet(netOpts);
  globalThis.fetch = net;
  return {
    env: { DB: makeDB(), TELEGRAM_BOT_TOKEN: "TESTTOKEN", OWNER_ID: String(OWNER), WEBHOOK_SECRET: "s3cret" },
    calls, state,
  };
}

async function feed(env, update, secret = "s3cret") {
  const { ctx, settle } = makeCtx();
  const res = await worker.fetch(
    new Request("https://x/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
      body: JSON.stringify(update),
    }),
    env, ctx
  );
  await settle();
  return res;
}

const sent = (calls) =>
  calls.filter((c) => c.url.endsWith("/sendMessage") || c.url.endsWith("/editMessageText"))
       .map((c) => JSON.parse(c.body).text);
// Match against the text the user actually reads, not the HTML markup around it.
const plain = (t) => String(t).replace(/<[^>]+>/g, "");
const anyText = (calls, re) => sent(calls).some((t) => re.test(plain(t)));
// Button labels are where folder names and undo entries live, not the message body.
const buttons = (calls) =>
  calls.filter((c) => c.body && (JSON.parse(c.body).reply_markup))
       .flatMap((c) => JSON.parse(c.body).reply_markup.inline_keyboard.flat());
const anyButton = (calls, re) => buttons(calls).some((b) => re.test(b.text));

// Walk the whole wiring flow so later tests start from a configured bot.
async function bootstrap(h) {
  const { env, calls } = h;
  await feed(env, msg(OWNER, { text: "/start" }));
  await feed(env, msg(OWNER, { text: "/connect" }));
  await feed(env, cb(OWNER, "cg"));
  await feed(env, msg(OWNER, { text: "ghp_faketoken" }));
  await feed(env, msg(OWNER, { text: "/addrepo" }));
  await feed(env, cb(OWNER, "ac:0"));
  await feed(env, cb(OWNER, "ar:0"));            // bob/site-one
  await feed(env, msg(OWNER, { text: "/connect" }));
  await feed(env, cb(OWNER, "ch"));
  await feed(env, msg(OWNER, { text: "hk_fakekey" }));
  await feed(env, msg(OWNER, { text: "/addapp" }));
  await feed(env, cb(OWNER, "hc:0"));
  await feed(env, cb(OWNER, "ha:0"));            // app-one
  await feed(env, cb(OWNER, "hl:0"));            // link to site-one
  calls.length = 0;
}

console.log("\n── access control ──");
{
  const h = newEnv();
  await feed(h.env, msg(12345, { text: "/start" }));
  ok(anyText(h.calls, /private/i), "unknown user is refused");
  ok(anyText(h.calls, /12345/), "refusal shows their Telegram ID so the owner can add them");

  h.calls.length = 0;
  await feed(h.env, msg(OWNER, { text: "/start" }));
  ok(anyText(h.calls, /owner/i), "configured OWNER_ID is bootstrapped as owner");

  const r = await feed(h.env, msg(OWNER, { text: "/start" }), "wrong-secret");
  ok(r.status === 403, "wrong webhook secret is rejected");
}

console.log("\n── connecting accounts ──");
{
  const h = newEnv();
  await feed(h.env, msg(OWNER, { text: "/start" }));
  await feed(h.env, msg(OWNER, { text: "/connect" }));
  await feed(h.env, cb(OWNER, "cg"));
  h.calls.length = 0;
  await feed(h.env, msg(OWNER, { text: "ghp_faketoken" }));
  ok(h.calls.some((c) => c.url.endsWith("/deleteMessage")), "pasted token message is deleted from the chat");
  ok(anyText(h.calls, /bobaccount/), "GitHub account is verified and named back");
  const row = await h.env.DB.prepare("SELECT * FROM connections WHERE kind='github'").first();
  ok(row && row.token === "ghp_faketoken", "token stored against the account");

  await feed(h.env, msg(OWNER, { text: "/addrepo" }));
  await feed(h.env, cb(OWNER, "ac:0"));
  h.calls.length = 0;
  await feed(h.env, cb(OWNER, "ar:0"));
  const repo = await h.env.DB.prepare("SELECT * FROM repos").first();
  ok(repo && repo.owner === "bob" && repo.name === "site-one", "repo registered with owner/name/branch");

  await feed(h.env, msg(OWNER, { text: "/addrepo" }));
  h.calls.length = 0;
  await feed(h.env, cb(OWNER, "ac:0"));
  ok(!anyText(h.calls, /site-one/), "already-registered repo is not offered twice");
}

console.log("\n── double-build warning ──");
{
  const h = newEnv({ hkAutoDeploy: { "app-one": true } });
  await bootstrap(h);
  ok(true, "wiring completed with auto-deploy present");
  const h2 = newEnv({ hkAutoDeploy: { "app-one": true } });
  await feed(h2.env, msg(OWNER, { text: "/start" }));
  await feed(h2.env, msg(OWNER, { text: "/connect" }));
  await feed(h2.env, cb(OWNER, "cg"));
  await feed(h2.env, msg(OWNER, { text: "ghp_x" }));
  await feed(h2.env, msg(OWNER, { text: "/addrepo" }));
  await feed(h2.env, cb(OWNER, "ac:0"));
  await feed(h2.env, cb(OWNER, "ar:0"));
  await feed(h2.env, msg(OWNER, { text: "/connect" }));
  await feed(h2.env, cb(OWNER, "ch"));
  await feed(h2.env, msg(OWNER, { text: "hk_x" }));
  await feed(h2.env, msg(OWNER, { text: "/addapp" }));
  await feed(h2.env, cb(OWNER, "hc:0"));
  await feed(h2.env, cb(OWNER, "ha:0"));
  h2.calls.length = 0;
  await feed(h2.env, cb(OWNER, "hl:0"));
  ok(anyText(h2.calls, /build twice/i), "warns when the app already auto-deploys from GitHub");
}

console.log("\n── VA deploy flow ──");
{
  const h = newEnv();
  await bootstrap(h);
  await feed(h.env, msg(OWNER, { text: "/adduser" }));
  await feed(h.env, msg(OWNER, { text: String(VA) }));
  const va = await h.env.DB.prepare("SELECT * FROM users WHERE telegram_id=?").bind(VA).first();
  ok(va && va.role === "va", "VA added by ID");

  h.calls.length = 0;
  await feed(h.env, msg(VA, { document: { file_id: "F1", file_name: "index.html", file_size: 1200 } }));
  // one repo registered -> skips the repo picker and goes straight to browsing
  ok(anyButton(h.calls, /^📁 public$/), "single repo skips the picker and shows the tree");

  h.calls.length = 0;
  await feed(h.env, cb(VA, "d:0"));           // into public/
  ok(anyText(h.calls, /index\.html already exists here/i), "warns the file will be replaced");

  h.calls.length = 0;
  await feed(h.env, cb(VA, "k"));             // put it here
  ok(anyText(h.calls, /Replaces the file already there/i), "confirm screen says it replaces");
  ok(anyText(h.calls, /public\/index\.html/), "confirm screen shows the full path");
  ok(anyText(h.calls, /app-one/), "confirm screen names the app that will deploy");

  h.calls.length = 0;
  await feed(h.env, cb(VA, "g"));             // deploy
  const put = h.calls.find((c) => c.method === "PUT" && c.url.includes("/contents/"));
  ok(!!put, "committed via the Contents API");
  const putBody = JSON.parse(put.body);
  ok(putBody.sha === "shaINDEX", "sent the CURRENT blob sha so the replace is not a 422");
  ok(putBody.branch === "main", "committed to the registered branch");
  ok(Buffer.from(putBody.content, "base64").toString() === "<new>new page</new>", "committed the exact bytes the VA sent");

  ok(h.calls.some((c) => c.url === "https://api.heroku.com/sources" && c.method === "POST"), "asked Heroku for an upload slot");
  ok(h.calls.some((c) => c.url.startsWith("https://s3.example/put") && c.method === "PUT"), "uploaded the archive itself");
  ok(h.calls.some((c) => c.url.includes("/builds") && c.method === "POST"), "triggered the build");
  ok(anyText(h.calls, /Building/), "told the VA it is building");

  const d = await h.env.DB.prepare("SELECT * FROM deploys ORDER BY id DESC").first();
  ok(d.prev_blob_sha === "shaINDEX", "recorded the previous blob sha for undo");
  ok(d.build_status === "pending" && d.build_id === "build-123", "deploy row is pending with a build id");

  const owned = h.calls.filter((c) => c.url.endsWith("/sendMessage")).map((c) => JSON.parse(c.body));
  ok(owned.some((m) => m.chat_id === OWNER && /deployed/i.test(m.text)), "owner is notified of the VA's deploy");

  const lp = await h.env.DB.prepare("SELECT dir FROM last_paths WHERE telegram_id=?").bind(VA).first();
  ok(lp.dir === "public", "remembered the folder for next time");
}

console.log("\n── build result reporting ──");
{
  const h = newEnv({ buildStatus: "succeeded" });
  await bootstrap(h);
  await feed(h.env, msg(OWNER, { document: { file_id: "F1", file_name: "index.html", file_size: 1200 } }));
  await feed(h.env, cb(OWNER, "d:0"));
  await feed(h.env, cb(OWNER, "k"));
  await feed(h.env, cb(OWNER, "g"));
  h.calls.length = 0;
  const { ctx, settle } = makeCtx();
  await worker.scheduled({}, h.env, ctx); await settle();
  ok(anyText(h.calls, /Live/), "successful build is reported as live");
  ok(anyText(h.calls, /app-one\.herokuapp\.com/), "live message includes the app URL");
  const d = await h.env.DB.prepare("SELECT build_status FROM deploys ORDER BY id DESC").first();
  ok(d.build_status === "succeeded", "deploy row closed as succeeded");
}
{
  // Heroku's docs contradict themselves: prose says `successful`, JSON says `succeeded`.
  const h = newEnv({ buildStatus: "successful" });
  await bootstrap(h);
  await feed(h.env, msg(OWNER, { document: { file_id: "F1", file_name: "index.html", file_size: 12 } }));
  await feed(h.env, cb(OWNER, "d:0")); await feed(h.env, cb(OWNER, "k")); await feed(h.env, cb(OWNER, "g"));
  h.calls.length = 0;
  const { ctx, settle } = makeCtx();
  await worker.scheduled({}, h.env, ctx); await settle();
  ok(anyText(h.calls, /Live/), "'successful' is treated as green, not as a failure");
}
{
  const h = newEnv({ buildStatus: "failed" });
  await bootstrap(h);
  await feed(h.env, msg(OWNER, { document: { file_id: "F1", file_name: "index.html", file_size: 12 } }));
  await feed(h.env, cb(OWNER, "d:0")); await feed(h.env, cb(OWNER, "k")); await feed(h.env, cb(OWNER, "g"));
  h.calls.length = 0;
  const { ctx, settle } = makeCtx();
  await worker.scheduled({}, h.env, ctx); await settle();
  ok(anyText(h.calls, /Build failed/), "failed build is reported as failed");
  ok(anyText(h.calls, /some compiler error/), "failure includes the tail of the build log");
  ok(anyText(h.calls, /committed but the app did NOT update/), "distinguishes committed-but-not-deployed");
}

console.log("\n── undo ──");
{
  const h = newEnv({ buildStatus: "succeeded" });
  await bootstrap(h);
  await feed(h.env, msg(VA, { text: "/start" }));
  await feed(h.env, msg(OWNER, { text: "/adduser" }));
  await feed(h.env, msg(OWNER, { text: String(VA) }));
  await feed(h.env, msg(VA, { document: { file_id: "F1", file_name: "index.html", file_size: 12 } }));
  await feed(h.env, cb(VA, "d:0")); await feed(h.env, cb(VA, "k")); await feed(h.env, cb(VA, "g"));

  h.calls.length = 0;
  await feed(h.env, msg(VA, { text: "/undo" }));
  ok(anyButton(h.calls, /public\/index\.html/), "undo lists the last change");
  await feed(h.env, cb(VA, "un:0"));
  h.calls.length = 0;
  await feed(h.env, cb(VA, "uy"));
  const put = h.calls.filter((c) => c.method === "PUT" && c.url.includes("/contents/")).pop();
  ok(!!put, "undo commits a restore");
  ok(Buffer.from(JSON.parse(put.body).content, "base64").toString() === "<old>old page</old>",
     "undo restores the exact previous bytes");
  ok(anyText(h.calls, /Undone/), "undo confirms");
  ok(h.calls.some((c) => c.url.includes("/builds") && c.method === "POST"), "undo redeploys");
}
{
  // Undoing a file that did NOT exist before must remove it, not restore nothing.
  const h = newEnv({ buildStatus: "succeeded" });
  await bootstrap(h);
  await feed(h.env, msg(OWNER, { document: { file_id: "F1", file_name: "brand-new.html", file_size: 12 } }));
  await feed(h.env, cb(OWNER, "d:0")); await feed(h.env, cb(OWNER, "k")); await feed(h.env, cb(OWNER, "g"));
  const d = await h.env.DB.prepare("SELECT prev_blob_sha FROM deploys ORDER BY id DESC").first();
  ok(d.prev_blob_sha === null, "new file records no previous sha");

  // Make the file resolvable so the undo can find its current sha.
  h.state.ghTree["public"].push({ type: "file", name: "brand-new.html", sha: "shaNEWFILE", size: 12 });
  await feed(h.env, msg(OWNER, { text: "/undo" }));
  await feed(h.env, cb(OWNER, "un:0"));
  h.calls.length = 0;
  await feed(h.env, cb(OWNER, "uy"));
  ok(h.calls.some((c) => c.method === "DELETE" && c.url.includes("/contents/")), "undo of a new file deletes it");
  ok(anyText(h.calls, /File removed/), "says the file was removed");
}

console.log("\n── guards ──");
{
  const h = newEnv();
  await bootstrap(h);

  h.calls.length = 0;
  await feed(h.env, msg(OWNER, { photo: [{ file_id: "P1" }] }));
  ok(anyText(h.calls, /compressed photo/i), "a photo is refused with the fix (send as File)");

  h.calls.length = 0;
  await feed(h.env, msg(OWNER, { document: { file_id: "F9", file_name: "big.zip", file_size: 25 * 1024 * 1024 } }));
  ok(anyText(h.calls, /20 MB/), "over-20MB upload is refused with the reason");

  // A VA must not be able to rewire the bot.
  await feed(h.env, msg(OWNER, { text: "/adduser" }));
  await feed(h.env, msg(OWNER, { text: String(VA) }));
  h.calls.length = 0;
  await feed(h.env, msg(VA, { text: "/connect" }));
  ok(!anyText(h.calls, /Which kind/), "VA cannot open /connect");
  h.calls.length = 0;
  await feed(h.env, msg(VA, { text: "/addrepo" }));
  ok(!anyText(h.calls, /Which GitHub account/), "VA cannot open /addrepo");

  h.calls.length = 0;
  await feed(h.env, msg(VA, { text: "/status" }));
  ok(!anyText(h.calls, /Accounts/), "VA status view hides accounts and people");
}

console.log("\n── callback_data budget ──");
{
  // Telegram hard-caps callback_data at 64 bytes; anything longer is silently
  // dropped by the client, so every button we ever emit must fit.
  const h = newEnv({
    ghTree: {
      "": [{ type: "dir", name: "a-very-long-directory-name-that-goes-on-and-on-forever-and-ever-yes" }],
      "a-very-long-directory-name-that-goes-on-and-on-forever-and-ever-yes": [{ type: "file", name: "x.html", sha: "s1", size: 1 }],
    },
  });
  await bootstrap(h);
  await feed(h.env, msg(OWNER, { document: { file_id: "F1", file_name: "deep.html", file_size: 12 } }));
  const kb = buttons(h.calls);
  ok(kb.length > 0, "buttons were emitted");
  const over = kb.filter((b) => Buffer.byteLength(b.callback_data, "utf8") > 64);
  ok(over.length === 0, "every callback_data is within 64 bytes",
     over.map((b) => b.callback_data).join(", "));
}

console.log("\n── path safety ──");
{
  const { safeJoin } = await import("../worker/lib/util.js");
  const bad = (d, n) => { try { safeJoin(d, n); return false; } catch { return true; } };
  ok(bad("public", "../../etc/passwd"), "rejects traversal in the file name");
  ok(bad("public", "a/b.html"), "rejects a slash in the file name");
  ok(bad("", ""), "rejects an empty name");
  ok(safeJoin("public/css", "app.css") === "public/css/app.css", "joins a normal path");
  ok(safeJoin("", "index.html") === "index.html", "joins at the repo root");
  ok(safeJoin("/public/", "a.html") === "public/a.html", "normalises stray slashes");
}

console.log("\n── heroku status normalisation ──");
{
  const HK = await import("../worker/lib/heroku.js");
  ok(HK.normalizeStatus("succeeded") === "succeeded", "succeeded → succeeded");
  ok(HK.normalizeStatus("successful") === "succeeded", "successful → succeeded (doc contradiction)");
  ok(HK.normalizeStatus("failed") === "failed", "failed → failed");
  ok(HK.normalizeStatus("pending") === "pending", "pending → pending");
  ok(HK.normalizeStatus(undefined) === "pending", "unknown → pending, never a false green");
}

console.log("\n── no-app repo ──");
{
  const h = newEnv();
  await feed(h.env, msg(OWNER, { text: "/start" }));
  await feed(h.env, msg(OWNER, { text: "/connect" }));
  await feed(h.env, cb(OWNER, "cg"));
  await feed(h.env, msg(OWNER, { text: "ghp_x" }));
  await feed(h.env, msg(OWNER, { text: "/addrepo" }));
  await feed(h.env, cb(OWNER, "ac:0"));
  await feed(h.env, cb(OWNER, "ar:0"));
  h.calls.length = 0;
  await feed(h.env, msg(OWNER, { document: { file_id: "F1", file_name: "index.html", file_size: 12 } }));
  await feed(h.env, cb(OWNER, "d:0")); await feed(h.env, cb(OWNER, "k"));
  ok(anyText(h.calls, /No Heroku app linked/), "confirm warns when no app is linked");
  h.calls.length = 0;
  await feed(h.env, cb(OWNER, "g"));
  ok(anyText(h.calls, /Committed/), "still commits with no app");
  ok(!h.calls.some((c) => c.url.includes("/builds")), "does not attempt a build with no app");
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
