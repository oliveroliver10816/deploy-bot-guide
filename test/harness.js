/**
 * Test harness: runs the REAL worker code against a real SQLite database and a
 * mock network. Nothing here talks to Telegram, GitHub or Heroku.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The same DDL the real deploy applies, so tests never rely on the request
 *  path creating tables (it deliberately no longer does). */
const SCHEMA_SQL = readFileSync(join(HERE, "..", "worker", "schema.sql"), "utf8");

// ---------------------------------------------------------------- D1 shim ---
// Mirrors the subset of the D1 API the worker uses: prepare().bind().first()/all()/run().
export function makeDB() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => {
      const r = db.prepare(sql).get(...args);
      return r === undefined ? null : r;
    },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => {
      db.prepare(sql).run(...args);
      return { success: true };
    },
  });
  const base = {
    prepare: (sql) => wrap(sql),
    // D1 sends a batch in one round trip; the shim just runs them in order.
    batch: async (stmts) => Promise.all(stmts.map((st) => st.all())),
    _raw: db,
  };
  return base;
}

/**
 * The same shim plus D1's Sessions API, which is what actually routes a read to
 * a nearby replica. Records how each session was started so a test can prove a
 * write goes to the primary and a read does not.
 */
export function makeSessionDB() {
  const base = makeDB();
  const sessions = [];
  let counter = 0;
  base.withSession = (start) => {
    const rec = { start, bookmark: `bm-${++counter}` };
    sessions.push(rec);
    return {
      prepare: base.prepare,
      batch: base.batch,
      getBookmark: () => rec.bookmark,
    };
  };
  base._sessions = sessions;
  return base;
}

// ------------------------------------------------------------ fetch mock ---
export function makeNet(opts = {}) {
  const calls = [];
  const state = {
    // Shaped exactly as the GitHub API returns them, so the mapping in
    // listRepos() is genuinely exercised rather than bypassed.
    // ⚠️ EVERY ROW CARRIES A DISTINCT DATE, and one row deliberately carries
    // NONE. Without that, an assertion about a date column passes whether or not
    // the value was ever read — and "site-two" is what exercises the empty state.
    ghRepos: opts.ghRepos ?? [
      { owner: { login: "bob" }, name: "site-one", full_name: "bob/site-one", default_branch: "main", private: true, permissions: { push: true },
        created_at: "2021-03-04T09:00:00Z", pushed_at: "2026-08-19T11:22:33Z" },
      { owner: { login: "bob" }, name: "site-two", full_name: "bob/site-two", default_branch: "main", private: false, permissions: { push: true } },
    ],
    // path -> {sha, type}
    ghTree: opts.ghTree ?? {
      "": [{ type: "dir", name: "public" }, { type: "file", name: "README.md", sha: "shaREADME", size: 10 }],
      public: [{ type: "dir", name: "css" }, { type: "file", name: "index.html", sha: "shaINDEX", size: 120 }],
      "public/css": [{ type: "file", name: "app.css", sha: "shaCSS", size: 40 }],
    },
    blobs: opts.blobs ?? { shaINDEX: Buffer.from("<old>old page</old>").toString("base64") },
    // "site-one" deliberately matches a repo name so auto-linking is exercised;
    // the other two do not, so the "needs a repo" path is exercised too.
    hkApps: opts.hkApps ?? [
      // distinct dates per row, and app-two carries none — same reason as ghRepos
      { name: "app-one", web_url: "https://app-one.herokuapp.com/",
        created_at: "2020-01-02T03:04:05Z", released_at: "2026-08-18T10:00:00Z" },
      { name: "app-two", web_url: "https://app-two.herokuapp.com/" },
      { name: "site-one", web_url: "https://site-one-1a2b3c4d5e6f.herokuapp.com/",
        created_at: "2022-06-07T08:09:10Z", released_at: "2026-08-20T20:20:20Z" },
    ],
    hkAutoDeploy: opts.hkAutoDeploy ?? {},
    buildStatus: opts.buildStatus ?? "pending",
    // Heroku refusing to answer about a build at all — an expired key, a 5xx,
    // a network blip. Distinct from a build that answers "failed".
    buildReadStatus: opts.buildReadStatus ?? 200,
    buildLog: opts.buildLog ?? "-----> Build failed\nsome compiler error\n",
    ghUser: opts.ghUser ?? "bobaccount",
    ghUserByToken: opts.ghUserByToken ?? {},
    // a static site: index.html only, which is exactly what Heroku cannot build
    gitTree: opts.gitTree ?? [
      { path: "README.md", type: "blob", size: 13, sha: "b1" },
      { path: "index.html", type: "blob", size: 8600, sha: "b2" },
      { path: "assets", type: "tree", sha: "t1" },
      { path: "assets/app.css", type: "blob", size: 400, sha: "b3" },
      { path: "assets/logo.png", type: "blob", size: 900, sha: "b4" },
    ],
    blobsWritten: [], treesWritten: [], commitsWritten: [], reposCreated: [], appsCreated: [],
    // real destruction — recorded so a test can prove it happened, or prove it did NOT
    appsDeleted: [], reposDeleted: [],
    hkDeleteStatus: opts.hkDeleteStatus ?? 200,
    ghRepoDeleteStatus: opts.ghRepoDeleteStatus ?? 204,
    // creation, refused the two ways it is actually refused in the wild:
    // GitHub 403 (token without administration=write) and Heroku 422 on a name
    // some stranger already owns
    ghRepoCreateStatus: opts.ghRepoCreateStatus ?? 201,
    ghRepoCreateMessage: opts.ghRepoCreateMessage ?? "Resource not accessible by personal access token",
    hkAppCreateStatus: opts.hkAppCreateStatus ?? 201,
    hkAppCreateMessage: opts.hkAppCreateMessage ?? "Name is already taken",
    // the vendors' own status pages
    ghStatusIndicator: opts.ghStatusIndicator ?? "none",
    ghStatusDescription: opts.ghStatusDescription ?? "All Systems Operational",
    ghStatusFail: opts.ghStatusFail ?? false,
    hkStatusRows: opts.hkStatusRows ?? [{ system: "Apps", status: "green" },
                                        { system: "Data", status: "green" },
                                        { system: "Tools", status: "green" }],
    hkStatusFail: opts.hkStatusFail ?? false,
    // GitHub's own answer during the 2026-08-17 outage
    ghVerifyStatus: opts.ghVerifyStatus ?? 200,
    // GitHub answering 404 for a branch that really exists — which it did,
    // intermittently, during the same outage
    ghRefStatus: opts.ghRefStatus ?? 200,
    hkBuildStatus: opts.hkBuildStatus ?? 201,
    hkUser: opts.hkUser ?? "bob@example.com",
    hkUserByToken: opts.hkUserByToken ?? {},
    ghPutStatus: opts.ghPutStatus ?? 200,
    gitRefSha: opts.gitRefSha ?? "commitHEAD",
    ghBlobStatus: opts.ghBlobStatus ?? 201,
    tarballBytes: opts.tarballBytes ?? 4096,
    uploadFileBytes: opts.uploadFileBytes ?? Buffer.from("<new>new page</new>"),
  };

  const J = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

  async function net(url, init = {}) {
    const u = typeof url === "string" ? url : url.url;
    const method = (init.method || "GET").toUpperCase();
    calls.push({ url: u, method, init, body: init.body });

    // ---------------- vendor status pages ----------------
    // Public, keyless, and only ever read after something has already failed.
    if (u.includes("githubstatus.com")) {
      if (state.ghStatusFail) return new Response("nope", { status: 500 });
      return J({ page: { name: "GitHub" },
                 status: { indicator: state.ghStatusIndicator,
                           description: state.ghStatusDescription } });
    }
    if (u.includes("status.heroku.com")) {
      if (state.hkStatusFail) return new Response("nope", { status: 500 });
      return J({ status: state.hkStatusRows, incidents: [] });
    }

    // ---------------- Telegram ----------------
    if (u.includes("api.telegram.org")) {
      if (u.includes("/file/bot")) {
        return new Response(state.uploadFileBytes, { status: 200 });
      }
      const m = u.split("/").pop();
      if (m === "getFile") return J({ ok: true, result: { file_path: "documents/file_1.html" } });
      if (m === "sendMessage") return J({ ok: true, result: { message_id: 1000 + calls.length } });
      return J({ ok: true, result: true });
    }

    // ---------------- GitHub ----------------
    if (u.startsWith("https://api.github.com")) {
      const p = new URL(u).pathname;

      if (p === "/user") {
        // During GitHub's outage this is what verifying a key actually hit: a
        // 503 with GitHub's own sentence, which made the panel refuse a good key.
        if (state.ghVerifyStatus !== 200) {
          return J({ message: "No server is currently available to service your request." },
                   state.ghVerifyStatus);
        }
        // v32: the login can depend on the TOKEN, so a test can connect a
        // SECOND, distinct GitHub account — which is the only way to exercise
        // anything that behaves differently once more than one pair exists.
        const authed = (init.headers && (init.headers.Authorization || init.headers.authorization)) || "";
        const alt = state.ghUserByToken && Object.keys(state.ghUserByToken)
          .find((t) => authed.includes(t));
        return J({ login: alt ? state.ghUserByToken[alt] : (state.ghUser || "bobaccount") });
      }
      if (p === "/user/repos" && method === "POST") {
        const b = JSON.parse(init.body || "{}");
        if (state.ghRepoCreateStatus !== 201) {
          // GitHub reports a name clash inside `errors[]`, not `message`.
          return J(/already exists/i.test(state.ghRepoCreateMessage)
            ? { message: "Repository creation failed.", errors: [{ message: state.ghRepoCreateMessage }] }
            : { message: state.ghRepoCreateMessage }, state.ghRepoCreateStatus);
        }
        state.reposCreated.push(b);
        return J({ name: b.name, full_name: `${state.ghUser || "bobaccount"}/${b.name}`,
                   owner: { login: state.ghUser || "bobaccount" }, private: !!b.private,
                   default_branch: "main" }, 201);
      }
      if (p === "/user/repos") return J(state.ghRepos);

      // DELETE /repos/{owner}/{repo} — destroy the repository. The real API
      // answers 204 with no body on success, and a 403 names the missing
      // permission in x-accepted-github-permissions: administration=write.
      let m = p.match(/^\/repos\/([^/]+)\/([^/]+)$/);
      if (m && method === "DELETE") {
        if (state.ghRepoDeleteStatus !== 204) {
          return new Response(JSON.stringify({ message: "Must have admin rights to Repository." }), {
            status: state.ghRepoDeleteStatus,
            headers: { "Content-Type": "application/json",
                       "x-accepted-github-permissions": "administration=write" },
          });
        }
        state.reposDeleted.push(`${m[1]}/${m[2]}`);
        return new Response(null, { status: 204 });
      }

      m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/?(.*)$/);
      if (m) {
        const sub = decodeURIComponent(m[3] || "");
        if (method === "PUT") {
          if (state.ghPutStatus !== 200) return J({ message: "conflict" }, state.ghPutStatus);
          return J({ commit: { sha: "commitABC" }, content: { sha: "blobNEW" } });
        }
        if (method === "DELETE") return J({ commit: { sha: "commitDEL" } });
        // Directory listing
        if (Object.prototype.hasOwnProperty.call(state.ghTree, sub)) return J(state.ghTree[sub]);
        // Single file lookup
        const dir = sub.includes("/") ? sub.slice(0, sub.lastIndexOf("/")) : "";
        const name = sub.includes("/") ? sub.slice(sub.lastIndexOf("/") + 1) : sub;
        const entry = (state.ghTree[dir] || []).find((e) => e.type === "file" && e.name === name);
        if (entry) return J({ sha: entry.sha, size: entry.size, type: "file" });
        return J({ message: "Not Found" }, 404);
      }

      m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/blobs\/(.+)$/);
      if (m) {
        const c = state.blobs[m[3]];
        if (!c) return J({ message: "Not Found" }, 404);
        return J({ content: c, encoding: "base64" });
      }

      // ---- git data API ----
      if (/^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\//.test(p)) {
        if (state.ghRefStatus !== 200) return J({ message: "Not Found" }, state.ghRefStatus);
        // settable, so a test can make a branch "move" and prove the refresh
        // notices instead of skipping it
        return J({ object: { sha: state.gitRefSha || "commitHEAD" } });
      }
      if (/^\/repos\/[^/]+\/[^/]+\/git\/commits\/[^/]+$/.test(p) && method === "GET") {
        // the committer date is real in GitHub's reply and the panel now shows it
        // as "last commit"; without it here the assertion would pass vacuously
        return J({ tree: { sha: "treeHEAD" }, committer: { date: state.commitAt || "2026-08-21T07:08:09Z" } });
      }
      if (/^\/repos\/[^/]+\/[^/]+\/git\/trees\/[^/?]+/.test(p) && method === "GET") {
        return J({ sha: "treeHEAD", truncated: false, tree: state.gitTree });
      }
      if (/^\/repos\/[^/]+\/[^/]+\/git\/blobs$/.test(p) && method === "POST") {
        // A fine-grained token without Contents:Write refuses exactly here.
        if (state.ghBlobStatus && state.ghBlobStatus !== 201) {
          return J({ message: "Resource not accessible by personal access token" },
                   state.ghBlobStatus);
        }
        state.blobsWritten.push(JSON.parse(init.body));
        return J({ sha: "blob" + state.blobsWritten.length });
      }
      if (/^\/repos\/[^/]+\/[^/]+\/git\/trees$/.test(p) && method === "POST") {
        state.treesWritten.push(JSON.parse(init.body));
        return J({ sha: "treeNEW" });
      }
      if (/^\/repos\/[^/]+\/[^/]+\/git\/commits$/.test(p) && method === "POST") {
        state.commitsWritten.push(JSON.parse(init.body));
        return J({ sha: "commitNEW" });
      }
      if (/^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\//.test(p) && method === "PATCH") {
        return J({ ref: "refs/heads/main" });
      }

      m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/tarball\/(.+)$/);
      if (m) {
        return new Response(null, { status: 302, headers: { location: "https://codeload.github.com/signed/abc" } });
      }
      return J({ message: `unmocked github ${p}` }, 404);
    }

    if (u.startsWith("https://codeload.github.com")) {
      if (init.headers && (init.headers.Authorization || init.headers.authorization)) {
        throw new Error("TEST FAIL: Authorization header forwarded to codeload signed URL");
      }
      return new Response(new Uint8Array(state.tarballBytes), {
        status: 200,
        headers: { "content-length": String(state.tarballBytes) },
      });
    }

    // ---------------- Heroku ----------------
    if (u.startsWith("https://api.heroku.com")) {
      const p = new URL(u).pathname;
      if (p === "/account") {
        const authed = (init.headers && (init.headers.Authorization || init.headers.authorization)) || "";
        const alt = state.hkUserByToken && Object.keys(state.hkUserByToken)
          .find((t) => authed.includes(t));
        return J({ email: alt ? state.hkUserByToken[alt] : (state.hkUser || "bob@example.com") });
      }
      if (p === "/apps" && method === "GET") return J(state.hkApps);
      if (p === "/apps" && method === "POST") {
        const b = JSON.parse(init.body || "{}");
        if (state.hkAppCreateStatus !== 201) {
          return J({ message: state.hkAppCreateMessage }, state.hkAppCreateStatus);
        }
        state.appsCreated.push(b);
        return J({ id: "app-" + (state.appsCreated.length), name: b.name || "auto-name",
                   web_url: `https://${b.name || "auto"}-1a2b3c4d5e6f.herokuapp.com/` }, 201);
      }
      if (p === "/sources" && method === "POST")
        return J({ source_blob: { put_url: "https://s3.example/put?sig=1", get_url: "https://s3.example/get?sig=1" } });

      // DELETE /apps/{name} — destroy the app for real.
      let m = p.match(/^\/apps\/([^/]+)$/);
      if (m && method === "DELETE") {
        if (state.hkDeleteStatus !== 200) return J({ message: "forbidden" }, state.hkDeleteStatus);
        state.appsDeleted.push(m[1]);
        return J({ name: m[1] });
      }

      m = p.match(/^\/apps\/([^/]+)\/github$/);
      if (m) {
        const a = state.hkAutoDeploy[m[1]];
        return a ? J({ auto_deploy: true, branch: "main" }) : J({ message: "not found" }, 404);
      }
      m = p.match(/^\/apps\/([^/]+)\/builds$/);
      if (m && method === "POST") {
        if (state.hkBuildStatus && state.hkBuildStatus !== 201) {
          return J({ message: "Too many subrequests by single Worker invocation." }, state.hkBuildStatus);
        }
        return J({ id: "build-123", status: "pending", output_stream_url: "https://build.log/stream" });
      }
      m = p.match(/^\/apps\/([^/]+)\/builds\/(.+)$/);
      if (m) {
        if (state.buildReadStatus !== 200) {
          return J({ message: "Unauthorized" }, state.buildReadStatus);
        }
        return J({ id: m[2], status: state.buildStatus, output_stream_url: "https://build.log/stream" });
      }
      return J({ message: `unmocked heroku ${p}` }, 404);
    }

    if (u.startsWith("https://s3.example/put")) {
      if (init.headers && (init.headers["Content-Type"] || init.headers["content-type"])) {
        throw new Error("TEST FAIL: Content-Type sent to presigned S3 PUT");
      }
      return new Response("", { status: 200 });
    }
    if (u.startsWith("https://build.log/stream")) return new Response(state.buildLog, { status: 200 });

    return J({ message: `unmocked ${u}` }, 404);
  }

  return { net, calls, state };
}

// --------------------------------------------------------------- driver ----
export function makeCtx() {
  const pending = [];
  return {
    ctx: { waitUntil: (p) => pending.push(p) },
    settle: async () => { while (pending.length) await pending.shift(); },
  };
}

let updateId = 1;
export const msg = (from_id, over = {}) => ({
  update_id: updateId++,
  message: {
    message_id: 500 + updateId,
    chat: { id: from_id },
    from: { id: from_id, first_name: over.first_name || "Tester" },
    ...over,
  },
});
export const cb = (from_id, data, message_id = 1001) => ({
  update_id: updateId++,
  callback_query: {
    id: `cb${updateId}`,
    from: { id: from_id, first_name: "Tester" },
    message: { message_id, chat: { id: from_id } },
    data,
  },
});
