/**
 * Test harness: runs the REAL worker code against a real SQLite database and a
 * mock network. Nothing here talks to Telegram, GitHub or Heroku.
 */
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------- D1 shim ---
// Mirrors the subset of the D1 API the worker uses: prepare().bind().first()/all()/run().
export function makeDB() {
  const db = new DatabaseSync(":memory:");
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
  return { prepare: (sql) => wrap(sql), _raw: db };
}

// ------------------------------------------------------------ fetch mock ---
export function makeNet(opts = {}) {
  const calls = [];
  const state = {
    // Shaped exactly as the GitHub API returns them, so the mapping in
    // listRepos() is genuinely exercised rather than bypassed.
    ghRepos: opts.ghRepos ?? [
      { owner: { login: "bob" }, name: "site-one", full_name: "bob/site-one", default_branch: "main", private: true, permissions: { push: true } },
      { owner: { login: "bob" }, name: "site-two", full_name: "bob/site-two", default_branch: "main", private: false, permissions: { push: true } },
    ],
    // path -> {sha, type}
    ghTree: opts.ghTree ?? {
      "": [{ type: "dir", name: "public" }, { type: "file", name: "README.md", sha: "shaREADME", size: 10 }],
      public: [{ type: "dir", name: "css" }, { type: "file", name: "index.html", sha: "shaINDEX", size: 120 }],
      "public/css": [{ type: "file", name: "app.css", sha: "shaCSS", size: 40 }],
    },
    blobs: opts.blobs ?? { shaINDEX: Buffer.from("<old>old page</old>").toString("base64") },
    hkApps: opts.hkApps ?? [{ name: "app-one", web_url: "https://app-one.herokuapp.com/" }, { name: "app-two", web_url: "https://app-two.herokuapp.com/" }],
    hkAutoDeploy: opts.hkAutoDeploy ?? {},
    buildStatus: opts.buildStatus ?? "pending",
    buildLog: opts.buildLog ?? "-----> Build failed\nsome compiler error\n",
    ghPutStatus: opts.ghPutStatus ?? 200,
    tarballBytes: opts.tarballBytes ?? 4096,
    uploadFileBytes: opts.uploadFileBytes ?? Buffer.from("<new>new page</new>"),
  };

  const J = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

  async function net(url, init = {}) {
    const u = typeof url === "string" ? url : url.url;
    const method = (init.method || "GET").toUpperCase();
    calls.push({ url: u, method, init, body: init.body });

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

      if (p === "/user") return J({ login: "bobaccount" });
      if (p === "/user/repos") return J(state.ghRepos);

      let m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/?(.*)$/);
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
      if (p === "/account") return J({ email: "bob@example.com" });
      if (p === "/apps" && method === "GET") return J(state.hkApps);
      if (p === "/sources" && method === "POST")
        return J({ source_blob: { put_url: "https://s3.example/put?sig=1", get_url: "https://s3.example/get?sig=1" } });

      let m = p.match(/^\/apps\/([^/]+)\/github$/);
      if (m) {
        const a = state.hkAutoDeploy[m[1]];
        return a ? J({ auto_deploy: true, branch: "main" }) : J({ message: "not found" }, 404);
      }
      m = p.match(/^\/apps\/([^/]+)\/builds$/);
      if (m && method === "POST")
        return J({ id: "build-123", status: "pending", output_stream_url: "https://build.log/stream" });
      m = p.match(/^\/apps\/([^/]+)\/builds\/(.+)$/);
      if (m)
        return J({ id: m[2], status: state.buildStatus, output_stream_url: "https://build.log/stream" });
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
