/**
 * deploy-bot — push a file from Telegram, pick the repo, the linked Heroku app
 * deploys itself.
 *
 * Shape of the thing:
 *   Telegram webhook -> this Worker -> GitHub Contents API (commit one file)
 *                                   -> Heroku source-blob build (deploy)
 *   Cron (every minute) -> poll in-flight builds -> report back into the chat.
 *
 * Deliberate decisions:
 *   * No approval gate. The VA deploys straight to live, as asked. The safety
 *     net is /undo (restores the exact previous bytes and redeploys) plus an
 *     automatic notification to the owner on every deploy someone else makes.
 *   * Credentials live in D1, one row per account, so connecting another GitHub
 *     account or another Heroku account later is a chat flow, not a code change.
 *   * Buttons carry an INDEX, never a path: Telegram caps callback_data at 64
 *     bytes and repo paths routinely exceed that.
 */

import { tg, send, edit, answerCb, deleteMsg, downloadFile, keyboard, esc } from "./lib/telegram.js";
import * as GH from "./lib/github.js";
import * as HK from "./lib/heroku.js";
import { toBase64, nowIso, humanSize, safeJoin, parentDir } from "./lib/util.js";
import { handlePanel, corsHeaders, pollPanelBuilds, ensurePanelSchema, refreshCombos,
         explainVendorError } from "./lib/panel.js";

// Worker memory guard. A 20 MB upload also costs ~27 MB as base64 while committing,
// so the archive ceiling is kept well under the 128 MB isolate limit.
const MAX_TARBALL = 40 * 1024 * 1024;
const MAX_UPLOAD = 20 * 1024 * 1024;  // Telegram bot-download hard cap

// ---------------------------------------------------------------- db helpers

const q = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);

/**
 * Every upload gets a short id that is stamped into its buttons. State is one
 * slot per user, so without this a VA who sends a second file while the first
 * file's buttons are still on screen could tap the OLD buttons and deploy the
 * NEW file to the old path. Codes below are the ones that carry it.
 */
const FLOW_CODES = new Set(["r", "d", "u", "h", "k", "g"]);
const newSid = () => Math.random().toString(36).slice(2, 6);

// Runs once per isolate, not once per update: eight CREATE TABLE round-trips on
// every keystroke would dominate the response time. Keyed to the binding rather
// than a bare flag so a fresh database (tests) is still initialised.
const schemaReady = new WeakSet();
async function ensureSchema(env) {
  if (schemaReady.has(env.DB)) return;
  const stmts = SCHEMA.split(";").map((s) => s.trim()).filter(Boolean);
  for (const s of stmts) await env.DB.prepare(s).run();
  schemaReady.add(env.DB);
}

async function getUser(env, id) {
  return q(env, "SELECT * FROM users WHERE telegram_id=?", id).first();
}

async function ownerId(env) {
  const r = await q(env, "SELECT telegram_id FROM users WHERE role='owner' ORDER BY added_at LIMIT 1").first();
  return r?.telegram_id ?? null;
}

async function setState(env, id, step, data) {
  await q(env,
    `INSERT INTO state (telegram_id, step, data, updated_at) VALUES (?,?,?,?)
     ON CONFLICT (telegram_id) DO UPDATE SET step=excluded.step, data=excluded.data, updated_at=excluded.updated_at`,
    id, step, JSON.stringify(data ?? {}), nowIso()
  ).run();
}

async function getState(env, id) {
  const r = await q(env, "SELECT step, data FROM state WHERE telegram_id=?", id).first();
  if (!r) return { step: null, data: {} };
  let data = {};
  try { data = JSON.parse(r.data || "{}"); } catch { data = {}; }
  return { step: r.step, data };
}

const clearState = (env, id) => setState(env, id, null, {});

async function repoById(env, id) {
  return q(env,
    `SELECT r.*, c.token AS token FROM repos r JOIN connections c ON c.id=r.connection_id WHERE r.id=?`, id
  ).first();
}

async function appForRepo(env, repoId) {
  return q(env,
    `SELECT a.*, c.token AS token FROM apps a JOIN connections c ON c.id=a.connection_id WHERE a.repo_id=?`, repoId
  ).first();
}

// ------------------------------------------------------------------ rendering

const HELP_VA = `<b>How to update a site</b>

1. Send me the file (paperclip → <b>File</b>).
2. Tap which site it belongs to.
3. Tap the folder it goes in, then <b>Put it here</b>.
4. Tap <b>Deploy</b>.

I commit it and deploy the app, then tell you when it is live.

<b>/undo</b> — put the last change back
<b>/status</b> — what I am wired up to
<b>/help</b> — this message

Send images and code as <b>File</b>, not as a photo — photos get compressed and renamed.`;

const HELP_OWNER = `${HELP_VA}

<b>Owner only</b>
/connect — add a GitHub account or a Heroku account
/addrepo — register a repo the bot may push to
/addapp — register a Heroku app and link it to a repo
/adduser — let someone else (your VA) use this bot
/deluser — remove someone
/status — full wiring, connections and users`;

async function wiringText(env, isOwner) {
  const repos = (await q(env, `SELECT r.*, c.label AS conn FROM repos r JOIN connections c ON c.id=r.connection_id ORDER BY r.label`).all()).results || [];
  const apps = (await q(env, `SELECT a.*, r.label AS repo_label FROM apps a LEFT JOIN repos r ON r.id=a.repo_id ORDER BY a.label`).all()).results || [];

  let t = "<b>Wiring</b>\n\n";
  if (!repos.length) t += "No repos registered yet.\n";
  for (const r of repos) {
    const app = apps.find((a) => a.repo_id === r.id);
    t += `📁 <b>${esc(r.label)}</b>\n   <code>${esc(r.owner)}/${esc(r.name)}</code> @ ${esc(r.branch)}\n`;
    t += app ? `   → 🚀 ${esc(app.label)} (<code>${esc(app.heroku_name)}</code>)\n\n` : `   → ⚠️ no Heroku app linked (commit only)\n\n`;
  }
  const orphan = apps.filter((a) => !a.repo_id);
  for (const a of orphan) t += `🚀 <b>${esc(a.label)}</b> — ⚠️ not linked to a repo\n`;

  if (isOwner) {
    const conns = (await q(env, `SELECT kind, label, account FROM connections ORDER BY kind, label`).all()).results || [];
    const users = (await q(env, `SELECT telegram_id, name, role FROM users ORDER BY role, added_at`).all()).results || [];
    t += `\n<b>Accounts</b>\n`;
    t += conns.length ? conns.map((c) => `• ${c.kind === "github" ? "GitHub" : "Heroku"}: ${esc(c.account || c.label)}`).join("\n") : "• none";
    t += `\n\n<b>People</b>\n`;
    t += users.map((u) => `• ${esc(u.name || u.telegram_id)} — ${u.role}${u.role === "owner" ? " 👑" : ""} (<code>${u.telegram_id}</code>)`).join("\n");
  }
  return t;
}

async function renderBrowse(env, token, chatId, msgId, user, st) {
  const repo = await repoById(env, st.data.repo_id);
  const dir = st.data.dir || "";
  const listing = await GH.listDir(repo.token, repo.owner, repo.name, repo.branch, dir, fetch);

  const sid = st.data.sid || "";
  const opts = listing.dirs;
  const buttons = opts.map((d, i) => ({ text: `📁 ${d}`, data: `d:${i}:${sid}` }));

  const nav = [];
  if (dir) nav.push({ text: "⬆️ Up", data: `u::${sid}` }, { text: "🏠 Top", data: `h::${sid}` });

  const clash = listing.files.find((f) => f.name === st.data.file.name);
  const here = `📍 <code>/${esc(dir)}</code>`;
  const text =
    `<b>${esc(st.data.file.name)}</b> → <b>${esc(repo.label)}</b>\n\n` +
    `${here}\n` +
    `${listing.dirs.length} folder(s), ${listing.files.length} file(s) here\n` +
    (clash ? `\n⚠️ <b>${esc(clash.name)}</b> already exists here — it will be replaced.\n` : "") +
    `\nOpen a folder, or put the file in this one.`;

  const rows = keyboard(buttons, 2).reply_markup.inline_keyboard;
  if (nav.length) rows.push(nav.map((b) => ({ text: b.text, callback_data: b.data })));
  rows.push([{ text: "✅ Put it here", callback_data: `k::${sid}` }]);
  rows.push([{ text: "✖️ Cancel", callback_data: "x" }]);

  st.data.opts = opts;
  await setState(env, user.telegram_id, "browse", st.data);

  const payload = { reply_markup: { inline_keyboard: rows } };
  if (msgId) await edit(token, chatId, msgId, text, payload, fetch);
  else {
    const r = await send(token, chatId, text, payload, fetch);
    st.data.msg_id = r?.result?.message_id;
    await setState(env, user.telegram_id, "browse", st.data);
  }
}

// ------------------------------------------------------------- deploy runner

/**
 * Commit the file, then build the linked app. Reports progress by editing one
 * message so the chat stays a single line of truth per deploy.
 */
async function runDeploy(env, token, chatId, msgId, user, st) {
  const repo = await repoById(env, st.data.repo_id);
  const path = safeJoin(st.data.dir, st.data.file.name);

  await edit(token, chatId, msgId, `⏳ Uploading <code>${esc(path)}</code>…`, {}, fetch);

  const bytes = await downloadFile(token, st.data.file.id, fetch);
  const prevSha = await GH.getFileSha(repo.token, repo.owner, repo.name, repo.branch, path, fetch);

  await edit(token, chatId, msgId, `⏳ Committing <code>${esc(path)}</code>…`, {}, fetch);

  const commit = await GH.putFile(repo.token, {
    owner: repo.owner, repo: repo.name, branch: repo.branch, path,
    contentB64: toBase64(bytes),
    message: `${prevSha ? "Update" : "Add"} ${path} (via Telegram, ${user.name || user.telegram_id})`,
    sha: prevSha || undefined,
  }, fetch);

  const app = await appForRepo(env, repo.id);

  const row = await q(env,
    `INSERT INTO deploys (telegram_id, repo_id, app_id, path, file_name, commit_sha, prev_blob_sha,
        new_blob_sha, build_status, chat_id, message_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    user.telegram_id, repo.id, app?.id ?? null, path, st.data.file.name, commit.commitSha,
    prevSha, commit.blobSha, app ? "pending" : "no_app", chatId, msgId, nowIso()
  ).first();

  await q(env,
    `INSERT INTO last_paths (telegram_id, repo_id, dir) VALUES (?,?,?)
     ON CONFLICT (telegram_id, repo_id) DO UPDATE SET dir=excluded.dir`,
    user.telegram_id, repo.id, st.data.dir || ""
  ).run();

  await clearState(env, user.telegram_id);

  const committed =
    `✅ <b>Committed</b>\n` +
    `<code>${esc(path)}</code> → ${esc(repo.label)}\n` +
    `${prevSha ? "Replaced existing file" : "New file"} · ${humanSize(bytes.length)}`;

  if (!app) {
    await edit(token, chatId, msgId,
      `${committed}\n\n⚠️ No Heroku app is linked to this repo, so nothing was deployed.`, {}, fetch);
    await notifyOwner(env, token, user, `committed <code>${esc(path)}</code> to ${esc(repo.label)} (no app linked)`);
    return;
  }

  await edit(token, chatId, msgId, `${committed}\n\n⏳ Deploying <b>${esc(app.label)}</b>…`, {}, fetch);

  try {
    const tar = await GH.tarball(repo.token, repo.owner, repo.name, repo.branch, MAX_TARBALL, fetch);
    const build = await HK.deploy(app.token, app.heroku_name, tar, commit.commitSha, fetch);
    await q(env, `UPDATE deploys SET build_id=?, build_status=? WHERE id=?`, build.id, build.status, row.id).run();
    await edit(token, chatId, msgId,
      `${committed}\n\n⏳ Building <b>${esc(app.label)}</b> — I will tell you when it is live.`, {}, fetch);
  } catch (e) {
    await q(env, `UPDATE deploys SET build_status='error', build_error=?, finished_at=? WHERE id=?`,
      String(e.message || e).slice(0, 500), nowIso(), row.id).run();
    await edit(token, chatId, msgId,
      `${committed}\n\n❌ <b>Deploy failed to start</b>\n${esc(e.message || e)}\n\nThe file IS committed; only the deploy failed.`, {}, fetch);
  }
  await notifyOwner(env, token, user, `deployed <code>${esc(path)}</code> → ${esc(repo.label)} / ${esc(app.label)}`);
}

async function notifyOwner(env, token, actor, what) {
  const oid = await ownerId(env);
  if (!oid || oid === actor.telegram_id) return;
  await send(token, oid, `👤 <b>${esc(actor.name || actor.telegram_id)}</b> ${what}`, {}, fetch);
}

// --------------------------------------------------------------------- undo

async function runUndo(env, token, chatId, msgId, user, deployId) {
  const d = await q(env, `SELECT * FROM deploys WHERE id=?`, deployId).first();
  if (!d) return edit(token, chatId, msgId, "That change is no longer in the log.", {}, fetch);

  const repo = await repoById(env, d.repo_id);
  await edit(token, chatId, msgId, `⏳ Putting <code>${esc(d.path)}</code> back…`, {}, fetch);

  const current = await GH.getFileSha(repo.token, repo.owner, repo.name, repo.branch, d.path, fetch);
  let commitSha;

  if (d.prev_blob_sha) {
    const b64 = await GH.getBlob(repo.token, repo.owner, repo.name, d.prev_blob_sha, fetch);
    const r = await GH.putFile(repo.token, {
      owner: repo.owner, repo: repo.name, branch: repo.branch, path: d.path,
      contentB64: b64,
      message: `Revert ${d.path} (via Telegram, ${user.name || user.telegram_id})`,
      sha: current || undefined,
    }, fetch);
    commitSha = r.commitSha;
  } else {
    // The file did not exist before that deploy, so undoing means removing it.
    if (!current) return edit(token, chatId, msgId, "Already undone — that file is not in the repo.", {}, fetch);
    const r = await GH.deleteFile(repo.token, {
      owner: repo.owner, repo: repo.name, branch: repo.branch, path: d.path,
      message: `Remove ${d.path} (undo, via Telegram, ${user.name || user.telegram_id})`,
      sha: current,
    }, fetch);
    commitSha = r.commitSha;
  }

  const app = await appForRepo(env, repo.id);
  const head = `↩️ <b>Undone</b>\n<code>${esc(d.path)}</code> → ${esc(repo.label)}\n${d.prev_blob_sha ? "Previous version restored" : "File removed (it was new)"}`;

  const row = await q(env,
    `INSERT INTO deploys (telegram_id, repo_id, app_id, path, file_name, commit_sha, prev_blob_sha,
        build_status, chat_id, message_id, is_undo, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,1,?) RETURNING id`,
    user.telegram_id, repo.id, app?.id ?? null, d.path, d.file_name, commitSha,
    d.new_blob_sha, app ? "pending" : "no_app", chatId, msgId, nowIso()
  ).first();

  if (!app) {
    await edit(token, chatId, msgId, `${head}\n\n⚠️ No Heroku app linked, so nothing was redeployed.`, {}, fetch);
  } else {
    try {
      const tar = await GH.tarball(repo.token, repo.owner, repo.name, repo.branch, MAX_TARBALL, fetch);
      const build = await HK.deploy(app.token, app.heroku_name, tar, commitSha, fetch);
      await q(env, `UPDATE deploys SET build_id=?, build_status=? WHERE id=?`, build.id, build.status, row.id).run();
      await edit(token, chatId, msgId, `${head}\n\n⏳ Redeploying <b>${esc(app.label)}</b>…`, {}, fetch);
    } catch (e) {
      await q(env, `UPDATE deploys SET build_status='error', build_error=?, finished_at=? WHERE id=?`,
        String(e.message || e).slice(0, 500), nowIso(), row.id).run();
      await edit(token, chatId, msgId, `${head}\n\n❌ Redeploy failed: ${esc(e.message || e)}`, {}, fetch);
    }
  }
  await clearState(env, user.telegram_id);
  await notifyOwner(env, token, user, `undid <code>${esc(d.path)}</code> on ${esc(repo.label)}`);
}

// ------------------------------------------------------------ message router

async function onMessage(env, token, msg) {
  const chatId = msg.chat.id;
  const from = msg.from;
  const text = (msg.text || "").trim();

  let user = await getUser(env, from.id);

  // Bootstrap: the configured owner is claimed on first contact. If OWNER_ID is
  // unset, the first person to say hello becomes owner (trust on first use).
  if (!user) {
    const anyUser = await q(env, "SELECT COUNT(*) AS n FROM users").first();
    // OWNER_ID may list several ids: Bob has more than one Telegram account and
    // being refused by the bot he owns is the one failure with no way back in.
    const configured = String(env.OWNER_ID || "")
      .split(",").map((s) => Number(s.trim())).filter(Boolean);
    if (configured.includes(from.id) || (!configured.length && anyUser.n === 0)) {
      await q(env, `INSERT INTO users (telegram_id, name, role, added_at) VALUES (?,?,?,?)`,
        from.id, from.first_name || "owner", "owner", nowIso()).run();
      user = await getUser(env, from.id);
      await send(token, chatId, `👑 You are set up as the owner.\n\n${HELP_OWNER}`, {}, fetch);
      return;
    }
    await send(token, chatId,
      `This bot is private.\n\nAsk the owner to add you. Your Telegram ID is <code>${from.id}</code>.`, {}, fetch);
    return;
  }

  const isOwner = user.role === "owner";
  const st = await getState(env, user.telegram_id);

  // ---- a step that is waiting on typed input -------------------------------
  if (st.step === "await_token") {
    await deleteMsg(token, chatId, msg.message_id, fetch); // token must not linger in chat history
    try {
      const kind = st.data.kind;
      const account = kind === "github"
        ? await GH.verifyToken(text, fetch)
        : await HK.verifyToken(text, fetch);
      const label = account;
      await q(env,
        `INSERT INTO connections (kind, label, token, account, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT (kind, label) DO UPDATE SET token=excluded.token, account=excluded.account`,
        kind, label, text, account, nowIso()
      ).run();
      await clearState(env, user.telegram_id);
      await send(token, chatId,
        `✅ Connected ${kind === "github" ? "GitHub" : "Heroku"} account <b>${esc(account)}</b>.\n` +
        `(I deleted your message so the key is not left in the chat.)\n\n` +
        `Next: ${kind === "github" ? "/addrepo" : "/addapp"}`, {}, fetch);
    } catch (e) {
      await send(token, chatId, `❌ ${esc(e.message || e)}\n\nSend the key again, or /cancel.`, {}, fetch);
    }
    return;
  }

  if (st.step === "await_user_id") {
    const id = Number(text.replace(/\D/g, ""));
    if (!id) return send(token, chatId, "That is not a Telegram ID. Send just the number, or /cancel.", {}, fetch);
    await q(env, `INSERT INTO users (telegram_id, name, role, added_at) VALUES (?,?,?,?)
                  ON CONFLICT (telegram_id) DO UPDATE SET role='va'`,
      id, st.data.pending_name || `user ${id}`, "va", nowIso()).run();
    await clearState(env, user.telegram_id);
    return send(token, chatId, `✅ <code>${id}</code> can now use this bot. Tell them to send /start.`, {}, fetch);
  }

  // ---- commands ------------------------------------------------------------
  if (text === "/start" || text === "/help") {
    return send(token, chatId, isOwner ? HELP_OWNER : HELP_VA, {}, fetch);
  }
  if (text === "/cancel") {
    await clearState(env, user.telegram_id);
    return send(token, chatId, "Cancelled.", {}, fetch);
  }
  if (text === "/id") return send(token, chatId, `Your Telegram ID: <code>${from.id}</code>`, {}, fetch);
  if (text === "/status") return send(token, chatId, await wiringText(env, isOwner), {}, fetch);

  if (text === "/undo") {
    const rows = (await q(env,
      `SELECT d.*, r.label AS repo_label FROM deploys d JOIN repos r ON r.id=d.repo_id
       WHERE d.is_undo=0 ORDER BY d.id DESC LIMIT 5`).all()).results || [];
    if (!rows.length) return send(token, chatId, "Nothing to undo yet.", {}, fetch);
    st.data.opts = rows.map((r) => r.id);
    await setState(env, user.telegram_id, "undo", st.data);
    const buttons = rows.map((r, i) => ({ text: `${r.path} → ${r.repo_label}`, data: `un:${i}` }));
    return send(token, chatId, "<b>Which change should I put back?</b>", keyboard(buttons, 1), fetch);
  }

  if (isOwner) {
    if (text === "/connect") {
      return send(token, chatId,
        "<b>Connect an account</b>\n\nWhich kind?",
        keyboard([{ text: "GitHub", data: "cg" }, { text: "Heroku", data: "ch" }], 2), fetch);
    }
    if (text === "/addrepo" || text === "/addapp") {
      const kind = text === "/addrepo" ? "github" : "heroku";
      const conns = (await q(env, `SELECT id, label, account FROM connections WHERE kind=? ORDER BY label`, kind).all()).results || [];
      if (!conns.length) return send(token, chatId, `No ${kind} account connected yet. Run /connect first.`, {}, fetch);
      st.data.opts = conns.map((c) => c.id);
      await setState(env, user.telegram_id, text === "/addrepo" ? "pick_conn_repo" : "pick_conn_app", st.data);
      const buttons = conns.map((c, i) => ({ text: c.account || c.label, data: `${text === "/addrepo" ? "ac" : "hc"}:${i}` }));
      return send(token, chatId, `Which ${kind === "github" ? "GitHub" : "Heroku"} account?`, keyboard(buttons, 1), fetch);
    }
    if (text === "/adduser") {
      await setState(env, user.telegram_id, "await_user_id", {});
      return send(token, chatId,
        "Send me their Telegram ID (just the number).\n\nThey can get it by messaging this bot and reading the reply, or from @userinfobot.", {}, fetch);
    }
    if (text === "/deluser") {
      const users = (await q(env, `SELECT telegram_id, name FROM users WHERE role='va' ORDER BY added_at`).all()).results || [];
      if (!users.length) return send(token, chatId, "No VA users to remove.", {}, fetch);
      st.data.opts = users.map((u) => u.telegram_id);
      await setState(env, user.telegram_id, "deluser", st.data);
      return send(token, chatId, "Remove who?",
        keyboard(users.map((u, i) => ({ text: `${u.name} (${u.telegram_id})`, data: `du:${i}` })), 1), fetch);
    }
  }

  // ---- a file arrived ------------------------------------------------------
  if (msg.document) {
    const doc = msg.document;
    if (doc.file_size > MAX_UPLOAD) {
      return send(token, chatId, `That file is ${humanSize(doc.file_size)}. Telegram caps bot downloads at 20 MB.`, {}, fetch);
    }
    const repos = (await q(env, `SELECT id, label, owner, name FROM repos ORDER BY label`).all()).results || [];
    if (!repos.length) {
      return send(token, chatId, isOwner
        ? "No repos registered yet. Run /connect then /addrepo."
        : "No sites are set up yet — ask the owner.", {}, fetch);
    }

    const data = {
      sid: newSid(),
      file: { id: doc.file_id, name: doc.file_name || "file", size: doc.file_size },
    };

    if (repos.length === 1) {
      const lp = await q(env, `SELECT dir FROM last_paths WHERE telegram_id=? AND repo_id=?`, user.telegram_id, repos[0].id).first();
      data.repo_id = repos[0].id;
      data.dir = lp?.dir || "";
      await setState(env, user.telegram_id, "browse", data);
      return renderBrowse(env, token, chatId, null, user, { step: "browse", data });
    }

    data.opts = repos.map((r) => r.id);
    await setState(env, user.telegram_id, "pick_repo", data);
    return send(token, chatId,
      `<b>${esc(data.file.name)}</b> · ${humanSize(doc.file_size)}\n\nWhich site is this for?`,
      keyboard(repos.map((r, i) => ({ text: r.label, data: `r:${i}:${data.sid}` })), 1), fetch);
  }

  if (msg.photo) {
    return send(token, chatId,
      "That came through as a compressed photo, so I cannot use it.\n\nSend it again with the paperclip → <b>File</b>, which keeps the original name and quality.", {}, fetch);
  }

  return send(token, chatId, isOwner ? HELP_OWNER : HELP_VA, {}, fetch);
}

// ----------------------------------------------------------- callback router

async function onCallback(env, token, cb) {
  const user = await getUser(env, cb.from.id);
  if (!user) return answerCb(token, cb.id, "Not authorised.", fetch);

  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  const st = await getState(env, user.telegram_id);
  const [code, rawIdx, sid] = String(cb.data || "").split(":");
  const idx = Number(rawIdx);
  const opts = st.data.opts || [];
  const isOwner = user.role === "owner";

  await answerCb(token, cb.id, "", fetch);

  // Buttons from a superseded upload must not act on the current one.
  if (FLOW_CODES.has(code) && sid !== (st.data.sid || "")) {
    return edit(token, chatId, msgId,
      "⚠️ These buttons are from an earlier upload, so I ignored them.\n\nSend the file again and use the newest message.", {}, fetch);
  }

  try {
    switch (code) {
      case "x":
        await clearState(env, user.telegram_id);
        return edit(token, chatId, msgId, "Cancelled.", {}, fetch);

      case "r": {
        st.data.repo_id = opts[idx];
        const lp = await q(env, `SELECT dir FROM last_paths WHERE telegram_id=? AND repo_id=?`, user.telegram_id, st.data.repo_id).first();
        st.data.dir = lp?.dir || "";
        return renderBrowse(env, token, chatId, msgId, user, st);
      }
      case "d":
        st.data.dir = st.data.dir ? `${st.data.dir}/${opts[idx]}` : opts[idx];
        return renderBrowse(env, token, chatId, msgId, user, st);
      case "u":
        st.data.dir = parentDir(st.data.dir);
        return renderBrowse(env, token, chatId, msgId, user, st);
      case "h":
        st.data.dir = "";
        return renderBrowse(env, token, chatId, msgId, user, st);

      case "k": {
        const repo = await repoById(env, st.data.repo_id);
        const path = safeJoin(st.data.dir, st.data.file.name);
        const existing = await GH.getFileSha(repo.token, repo.owner, repo.name, repo.branch, path, fetch);
        const app = await appForRepo(env, repo.id);
        await setState(env, user.telegram_id, "confirm", st.data);
        const text =
          `<b>Ready to deploy</b>\n\n` +
          `File: <code>${esc(st.data.file.name)}</code> · ${humanSize(st.data.file.size)}\n` +
          `Site: <b>${esc(repo.label)}</b>\n` +
          `Goes to: <code>${esc(path)}</code>\n` +
          `${existing ? "🔁 Replaces the file already there" : "🆕 New file"}\n` +
          (app ? `Deploys: <b>${esc(app.label)}</b>` : `⚠️ No Heroku app linked — I will commit only`);
        return edit(token, chatId, msgId, text,
          keyboard([{ text: "🚀 Deploy", data: `g::${st.data.sid || ""}` }, { text: "✖️ Cancel", data: "x" }], 2), fetch);
      }

      case "g":
        return runDeploy(env, token, chatId, msgId, user, st);

      case "un":
        st.data.pending_undo = opts[idx];
        await setState(env, user.telegram_id, "undo_confirm", st.data);
        return edit(token, chatId, msgId, "Put that change back and redeploy?",
          keyboard([{ text: "↩️ Yes, undo", data: "uy" }, { text: "✖️ No", data: "x" }], 2), fetch);
      case "uy":
        return runUndo(env, token, chatId, msgId, user, st.data.pending_undo);

      // ---- owner-only wiring ------------------------------------------------
      case "cg":
      case "ch": {
        if (!isOwner) return;
        const kind = code === "cg" ? "github" : "heroku";
        await setState(env, user.telegram_id, "await_token", { kind });
        const how = kind === "github"
          ? `Create one at <b>github.com/settings/tokens</b> → Fine-grained token → pick the repos → Repository permissions → <b>Contents: Read and write</b>.`
          : `Run <code>heroku authorizations:create</code>, or go to <b>dashboard.heroku.com/account</b> → Applications → Authorizations → Create.`;
        return edit(token, chatId, msgId,
          `Paste the ${kind === "github" ? "GitHub token" : "Heroku API key"} as your next message.\n\n${how}\n\n<i>I delete your message the moment I read it.</i>`, {}, fetch);
      }

      case "ac": {
        if (!isOwner) return;
        const conn = await q(env, `SELECT * FROM connections WHERE id=?`, opts[idx]).first();
        await edit(token, chatId, msgId, "⏳ Fetching your repos…", {}, fetch);
        const repos = await GH.listRepos(conn.token, fetch);
        if (!repos.length) return edit(token, chatId, msgId, "That token cannot push to any repo.", {}, fetch);
        const existing = (await q(env, `SELECT owner, name FROM repos`).all()).results || [];
        const fresh = repos.filter((r) => !existing.some((e) => e.owner === r.owner && e.name === r.name));
        if (!fresh.length) return edit(token, chatId, msgId, "Every repo on that account is already registered.", {}, fetch);
        const show = fresh.slice(0, 30);
        st.data.conn_id = conn.id;
        st.data.opts = show;
        await setState(env, user.telegram_id, "pick_repo_add", st.data);
        return edit(token, chatId, msgId,
          `Which repo may the bot push to?${fresh.length > 30 ? `\n\n<i>Showing the 30 most recently pushed of ${fresh.length}.</i>` : ""}`,
          keyboard(show.map((r, i) => ({ text: `${r.private ? "🔒 " : ""}${r.full_name}`, data: `ar:${i}` })), 1), fetch);
      }
      case "ar": {
        if (!isOwner) return;
        const r = opts[idx];
        const clash = await q(env, `SELECT id FROM repos WHERE label=?`, r.name).first();
        const label = clash ? r.full_name : r.name;
        await q(env,
          `INSERT INTO repos (label, owner, name, branch, connection_id, created_at) VALUES (?,?,?,?,?,?)`,
          label, r.owner, r.name, r.branch, st.data.conn_id, nowIso()).run();
        await clearState(env, user.telegram_id);
        return edit(token, chatId, msgId,
          `✅ Registered <b>${esc(label)}</b> (<code>${esc(r.full_name)}</code> @ ${esc(r.branch)}).\n\nNow link its Heroku app with /addapp.`, {}, fetch);
      }

      case "hc": {
        if (!isOwner) return;
        const conn = await q(env, `SELECT * FROM connections WHERE id=?`, opts[idx]).first();
        await edit(token, chatId, msgId, "⏳ Fetching your Heroku apps…", {}, fetch);
        const apps = await HK.listApps(conn.token, fetch);
        if (!apps.length) return edit(token, chatId, msgId, "That account has no apps.", {}, fetch);
        const existing = (await q(env, `SELECT heroku_name FROM apps WHERE connection_id=?`, conn.id).all()).results || [];
        const fresh = apps.filter((a) => !existing.some((e) => e.heroku_name === a.name));
        if (!fresh.length) return edit(token, chatId, msgId, "Every app on that account is already registered.", {}, fetch);
        st.data.conn_id = conn.id;
        st.data.opts = fresh;
        await setState(env, user.telegram_id, "pick_app_add", st.data);
        return edit(token, chatId, msgId, "Which Heroku app?",
          keyboard(fresh.map((a, i) => ({ text: a.name, data: `ha:${i}` })), 1), fetch);
      }
      case "ha": {
        if (!isOwner) return;
        const a = opts[idx];
        const repos = (await q(env, `SELECT id, label FROM repos ORDER BY label`).all()).results || [];
        if (!repos.length) return edit(token, chatId, msgId, "Register a repo first with /addrepo.", {}, fetch);
        st.data.pending_app = a;
        st.data.opts = repos.map((r) => r.id);
        await setState(env, user.telegram_id, "link_app", st.data);
        return edit(token, chatId, msgId,
          `<b>${esc(a.name)}</b> — which repo deploys to it?`,
          keyboard(repos.map((r, i) => ({ text: r.label, data: `hl:${i}` })), 1), fetch);
      }
      case "hl": {
        if (!isOwner) return;
        const a = st.data.pending_app;
        const repoId = opts[idx];
        const conn = await q(env, `SELECT * FROM connections WHERE id=?`, st.data.conn_id).first();
        await q(env, `UPDATE apps SET repo_id=NULL WHERE repo_id=?`, repoId).run(); // one app per repo
        await q(env,
          `INSERT INTO apps (label, heroku_name, connection_id, repo_id, web_url, created_at) VALUES (?,?,?,?,?,?)
           ON CONFLICT (connection_id, heroku_name) DO UPDATE SET repo_id=excluded.repo_id`,
          a.name, a.name, conn.id, repoId, a.web_url || null, nowIso()).run();
        const repo = await q(env, `SELECT label FROM repos WHERE id=?`, repoId).first();

        // A live GitHub auto-deploy plus our build = two builds racing on every push.
        let warn = "";
        const auto = await HK.githubAutoDeploy(conn.token, a.name, fetch);
        if (auto) {
          warn = `\n\n⚠️ <b>${esc(a.name)}</b> also auto-deploys from GitHub. Turn that off in the Heroku dashboard (Deploy → Automatic deploys → Disable), or every change will build twice.`;
        }
        await clearState(env, user.telegram_id);
        return edit(token, chatId, msgId,
          `✅ <b>${esc(repo.label)}</b> → <b>${esc(a.name)}</b>.\n\nSend a file and it will go live.${warn}`, {}, fetch);
      }

      case "du": {
        if (!isOwner) return;
        await q(env, `DELETE FROM users WHERE telegram_id=? AND role='va'`, opts[idx]).run();
        await clearState(env, user.telegram_id);
        return edit(token, chatId, msgId, `✅ Removed <code>${opts[idx]}</code>.`, {}, fetch);
      }
    }
  } catch (e) {
    await clearState(env, user.telegram_id);
    return edit(token, chatId, msgId, `❌ ${esc(e.message || e)}`, {}, fetch);
  }
}

// -------------------------------------------------------------- build poller

async function pollBuilds(env, token) {
  const rows = (await q(env,
    `SELECT d.*, a.heroku_name, a.web_url, c.token AS hk_token, r.label AS repo_label, a.label AS app_label
     FROM deploys d
     JOIN apps a ON a.id=d.app_id
     JOIN connections c ON c.id=a.connection_id
     JOIN repos r ON r.id=d.repo_id
     WHERE d.build_status='pending' AND d.build_id IS NOT NULL
     ORDER BY d.id LIMIT 20`).all()).results || [];

  for (const d of rows) {
    try {
      const b = await HK.getBuild(d.hk_token, d.heroku_name, d.build_id, fetch);
      if (b.status === "pending") {
        // Give up on anything still pending after 30 minutes so it does not poll forever.
        if (Date.now() - Date.parse(d.created_at) > 30 * 60 * 1000) {
          await q(env, `UPDATE deploys SET build_status='error', build_error='timed out after 30 min', finished_at=? WHERE id=?`, nowIso(), d.id).run();
          await edit(token, d.chat_id, d.message_id,
            `⚠️ <b>${esc(d.app_label)}</b> is still building after 30 minutes. Check the Heroku dashboard.`, {}, fetch);
        }
        continue;
      }

      await q(env, `UPDATE deploys SET build_status=?, finished_at=? WHERE id=?`, b.status, nowIso(), d.id).run();

      if (b.status === "succeeded") {
        const url = d.web_url ? `\n${esc(d.web_url)}` : "";
        await edit(token, d.chat_id, d.message_id,
          `✅ <b>Live</b>\n<code>${esc(d.path)}</code> → ${esc(d.repo_label)}\n🚀 ${esc(d.app_label)} deployed${url}`, {}, fetch);
      } else {
        const tail = await HK.buildLogTail(b.output_stream_url, 12, fetch);
        await edit(token, d.chat_id, d.message_id,
          `❌ <b>Build failed</b> — ${esc(d.app_label)}\n<code>${esc(d.path)}</code> is committed but the app did NOT update.\n` +
          (tail ? `\n<pre>${esc(tail)}</pre>` : "") +
          `\nUse /undo to put the file back.`, {}, fetch);
        const oid = await ownerId(env);
        if (oid && oid !== d.telegram_id) {
          await send(token, oid, `❌ Build failed on <b>${esc(d.app_label)}</b> after <code>${esc(d.path)}</code>.`, {}, fetch);
        }
      }
    } catch (e) {
      await q(env, `UPDATE deploys SET build_status='error', build_error=?, finished_at=? WHERE id=?`,
        String(e.message || e).slice(0, 500), nowIso(), d.id).run();
    }
  }
}

// --------------------------------------------------------------------- entry

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" ) {
      return new Response("deploy-bot is running.\n", { headers: { "Content-Type": "text/plain" } });
    }

    // Web panel. Same engine as the bot, different front door.
    if (path === "/api" || path.startsWith("/api/")) {
      // No schema DDL here on purpose. Traffic is low, so nearly every request
      // lands on a COLD isolate and any per-request cache is useless — the DDL
      // was costing ~15 D1 round trips on every call. Tables are created at
      // deploy time and re-asserted by the cron below.
      // Read replication. The database's home region is US-East; with replication
      // on, D1 keeps copies elsewhere and a SESSION is what routes a read to the
      // nearest one. Without withSession() every query still crosses to the
      // primary, so enabling replication alone changes nothing.
      //
      // A write always goes to the primary. Reads start from the bookmark the
      // browser sends back, which is what guarantees you can see what you just
      // saved — "first-unconstrained" only ever applies to a session with no
      // history, where there is nothing of your own to miss.
      let session = null;
      let dbEnv = env;
      if (env.DB && typeof env.DB.withSession === "function") {
        const writing = request.method !== "GET" && request.method !== "OPTIONS";
        const sent = request.headers.get("X-D1-Bookmark");
        const start = writing ? "first-primary" : (sent || "first-unconstrained");
        try {
          session = env.DB.withSession(start);
          dbEnv = new Proxy(env, { get: (t, k) => (k === "DB" ? session : t[k]) });
        } catch { session = null; dbEnv = env; }
      }
      const withBookmark = (res) => {
        if (!session || typeof session.getBookmark !== "function") return res;
        let mark = null;
        try { mark = session.getBookmark(); } catch { mark = null; }
        if (!mark) return res;
        const out = new Response(res.body, res);   // headers on a returned Response are immutable
        out.headers.set("X-D1-Bookmark", mark);
        return out;
      };
      try {
        return withBookmark(await handlePanel(dbEnv, request, ctx, path));
      } catch (e) {
        // Never hand the vendor's raw sentence to the person reading the screen.
        // A 503 from GitHub is not something they can fix, and telling them so in
        // GitHub's words ("No server is currently available...") is what sent a
        // VA to delete working keys on 2026-08-17.
        const x = await explainVendorError(e);
        return withBookmark(new Response(JSON.stringify({ error: x.message, outage: x.outage }), {
          status: x.status,
          headers: { "Content-Type": "application/json", ...corsHeaders(env, request) },
        }));
      }
    }

    if (path === "/webhook" && request.method === "POST") {
      if (env.WEBHOOK_SECRET &&
          request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const token = env.TELEGRAM_BOT_TOKEN;
      if (!token) return new Response("no bot token configured", { status: 500 });

      let update;
      try { update = await request.json(); } catch { return new Response("ok"); }

      // Always 200 fast: Telegram retries on anything else, which would double-deploy.
      ctx.waitUntil((async () => {
        try {
          await ensureSchema(env);
          if (update.message) await onMessage(env, token, update.message);
          else if (update.callback_query) await onCallback(env, token, update.callback_query);
        } catch (e) {
          const chat = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
          if (chat) await send(token, chat, `❌ ${esc(e.message || e)}`, {}, fetch).catch(() => {});
        }
      })());
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureSchema(env);
      await ensurePanelSchema(env);
      if (env.TELEGRAM_BOT_TOKEN) await pollBuilds(env, env.TELEGRAM_BOT_TOKEN);
      await pollPanelBuilds(env);
      // v32: notice NEW apps and repos without anyone pressing anything.
      // He kept reporting "some apps don't show" — every time, they were apps
      // he had just made on Heroku, and Gitku only learned about them when
      // someone happened to press "Refresh from Heroku". Once every half hour
      // is plenty: it costs one list call per account, and a person pressing
      // the button is still instant.
      await maybeDiscover(env);
    })());
  },
};

/**
 * A quiet, throttled account refresh.
 *
 * ⚠️ NOT every tick. The cron runs every 5 minutes and a refresh costs one
 * Heroku list + one GitHub list per account — on his eight accounts that would
 * be ~4,600 vendor calls a day for no reason. Half-hourly is well inside every
 * rate limit (GitHub 5,000/hr and Heroku 4,500/hr, both PER ACCOUNT) and means
 * a new app appears by itself within half an hour.
 */
// ⚠️ MEASURED, not guessed. One discovery costs ONE Heroku list + ONE GitHub
// list per account. Running it on every 5-minute tick is 288 of each per
// account per day, against published limits of 4,500/hr (Heroku) and 5,000/hr
// (GitHub) — PER ACCOUNT. That is 12 calls an hour against a 4,500 ceiling.
// It was throttled to 30 minutes out of caution and the caution was misplaced:
// it meant an app he had just made could sit invisible for half an hour, which
// is exactly the "it doesn't appear for quite some time" he keeps hitting.
const DISCOVER_EVERY_MS = 90 * 1000;   // effectively every tick (cron is */2)
async function maybeDiscover(env) {
  try {
    // create first, then read — reading a table that does not exist yet throws,
    // and the catch below would have swallowed it into "never discover"
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)`).run();
    const row = await env.DB.prepare(
      `SELECT value FROM kv WHERE key='last_discover'`).first().catch(() => null);
    const last = Number(row?.value || 0);
    if (last && Date.now() - last < DISCOVER_EVERY_MS) return;
    await env.DB.prepare(
      `INSERT INTO kv (key,value) VALUES ('last_discover',?)
       ON CONFLICT (key) DO UPDATE SET value=excluded.value`).bind(String(Date.now())).run();
    await refreshCombos(env, "panel", undefined, { skipBuildpack: true });
  } catch { /* discovery is a convenience; it must never break the tick */ }
}

// Schema is inlined so a fresh deploy is self-installing; it mirrors schema.sql.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS connections (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, label TEXT NOT NULL, token TEXT NOT NULL, account TEXT, created_at TEXT NOT NULL, UNIQUE (kind, label));
CREATE TABLE IF NOT EXISTS repos (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, name TEXT NOT NULL, branch TEXT NOT NULL DEFAULT 'main', connection_id INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE (owner, name));
CREATE TABLE IF NOT EXISTS apps (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL UNIQUE, heroku_name TEXT NOT NULL, connection_id INTEGER NOT NULL, repo_id INTEGER, web_url TEXT, created_at TEXT NOT NULL, UNIQUE (connection_id, heroku_name));
CREATE TABLE IF NOT EXISTS users (telegram_id INTEGER PRIMARY KEY, name TEXT, role TEXT NOT NULL, added_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS state (telegram_id INTEGER PRIMARY KEY, step TEXT, data TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS last_paths (telegram_id INTEGER NOT NULL, repo_id INTEGER NOT NULL, dir TEXT NOT NULL, PRIMARY KEY (telegram_id, repo_id));
CREATE TABLE IF NOT EXISTS deploys (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id INTEGER NOT NULL, repo_id INTEGER NOT NULL, app_id INTEGER, path TEXT NOT NULL, file_name TEXT, commit_sha TEXT, prev_blob_sha TEXT, new_blob_sha TEXT, build_id TEXT, build_status TEXT, build_error TEXT, chat_id INTEGER, message_id INTEGER, is_undo INTEGER DEFAULT 0, created_at TEXT NOT NULL, finished_at TEXT);
CREATE INDEX IF NOT EXISTS deploys_pending ON deploys (build_status, created_at);
CREATE INDEX IF NOT EXISTS deploys_recent ON deploys (created_at DESC)
`;
