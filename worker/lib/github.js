/**
 * GitHub REST helpers — no git binary, no clone. A single-file commit is one
 * PUT to the Contents API, which is why this whole system can live in a Worker.
 */

const API = "https://api.github.com";
const UA = "deploy-bot";

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": UA,
  };
}

async function gh(token, path, init = {}, f = fetch) {
  const res = await f(`${API}${path}`, { ...init, headers: { ...headers(token), ...(init.headers || {}) } });
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 300) }; }
  }
  return { ok: res.ok, status: res.status, body };
}

export async function verifyToken(token, f = fetch) {
  const r = await gh(token, "/user", {}, f);
  if (!r.ok) throw new Error(`GitHub rejected that token (HTTP ${r.status}): ${r.body?.message || ""}`);
  return r.body.login;
}

/** Repos the token can push to, newest activity first. */
export async function listRepos(token, f = fetch) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const r = await gh(token, `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`, {}, f);
    if (!r.ok) throw new Error(`Could not list repos (HTTP ${r.status}): ${r.body?.message || ""}`);
    const items = Array.isArray(r.body) ? r.body : [];
    out.push(...items.filter((x) => x.permissions?.push !== false));
    if (items.length < 100) break;
  }
  return out.map((x) => ({
    owner: x.owner.login,
    name: x.name,
    full_name: x.full_name,
    branch: x.default_branch || "main",
    private: !!x.private,
    // Both arrive in this same response and were being discarded.
    // ⚠️ pushed_at, NOT updated_at: updated_at moves when a description or a
    // star changes, so it does not mean "the files changed".
    created_at: x.created_at || null,
    pushed_at: x.pushed_at || null,
  }));
}

/**
 * One directory listing. Returns {dirs, files}. Used to let the VA walk the
 * repo with buttons instead of typing a path.
 */
export async function listDir(token, owner, repo, ref, dir, f = fetch) {
  const p = dir ? `/${encodeURI(dir)}` : "";
  const r = await gh(token, `/repos/${owner}/${repo}/contents${p}?ref=${encodeURIComponent(ref)}`, {}, f);
  if (r.status === 404) return { dirs: [], files: [], missing: true };
  if (!r.ok) throw new Error(`Could not read ${dir || "/"} (HTTP ${r.status}): ${r.body?.message || ""}`);
  const items = Array.isArray(r.body) ? r.body : [];
  return {
    dirs: items.filter((i) => i.type === "dir").map((i) => i.name).sort(),
    files: items.filter((i) => i.type === "file").map((i) => ({ name: i.name, sha: i.sha, size: i.size })).sort((a, b) => a.name.localeCompare(b.name)),
    missing: false,
  };
}

/** Blob sha of a file, or null when it does not exist yet. */
export async function getFileSha(token, owner, repo, ref, path, f = fetch) {
  const r = await gh(token, `/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`, {}, f);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Could not check ${path} (HTTP ${r.status}): ${r.body?.message || ""}`);
  if (Array.isArray(r.body)) throw new Error(`${path} is a folder, not a file.`);
  return r.body.sha || null;
}

/** Raw bytes of a file at a blob sha — used by /undo to restore exact content. */
export async function getBlob(token, owner, repo, sha, f = fetch) {
  const r = await gh(token, `/repos/${owner}/${repo}/git/blobs/${sha}`, {}, f);
  if (!r.ok) throw new Error(`Could not fetch previous version (HTTP ${r.status}): ${r.body?.message || ""}`);
  return r.body.content.replace(/\s/g, ""); // already base64
}

/**
 * Create or replace a single file.
 * `sha` must be the CURRENT blob sha when replacing; omitting it on an existing
 * file is a 422, and a stale one is a 409.
 */
export async function putFile(token, { owner, repo, branch, path, contentB64, message, sha }, f = fetch) {
  const body = { message, content: contentB64, branch };
  if (sha) body.sha = sha;
  const r = await gh(token, `/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  }, f);
  if (r.status === 409) throw new Error("That file changed in GitHub while this upload was in progress. Send it again.");
  if (!r.ok) throw new Error(`Commit failed (HTTP ${r.status}): ${r.body?.message || ""}`);
  return { commitSha: r.body.commit?.sha, blobSha: r.body.content?.sha };
}

export async function deleteFile(token, { owner, repo, branch, path, message, sha }, f = fetch) {
  const r = await gh(token, `/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
    method: "DELETE",
    body: JSON.stringify({ message, branch, sha }),
  }, f);
  if (!r.ok) throw new Error(`Delete failed (HTTP ${r.status}): ${r.body?.message || ""}`);
  return { commitSha: r.body.commit?.sha };
}

/**
 * Download the repo as a tarball.
 *
 * The tarball endpoint 302s to a short-lived signed codeload URL. We must NOT
 * forward the Authorization header to that host: signed URLs reject an extra
 * auth header, so following the redirect automatically can fail. Hence manual.
 */
/**
 * The signed codeload URL for the repo archive, WITHOUT downloading it.
 *
 * This is the privacy path: handing this URL to Heroku means the repo contents
 * travel GitHub -> Heroku directly and never pass through this Worker. GitHub
 * signs it for private repos too.
 *
 * ⚠️ Private-repo archive links expire after ~5 minutes and Heroku queues
 * builds, so the caller MUST keep the upload path as a fallback.
 */
export async function tarballUrl(token, owner, repo, ref, f = fetch) {
  const res = await f(`${API}/repos/${owner}/${repo}/tarball/${encodeURIComponent(ref)}`, {
    headers: headers(token),
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    if (loc) return loc;
  }
  return null; // caller falls back to uploading the archive itself
}

export async function tarball(token, owner, repo, ref, maxBytes, f = fetch) {
  const first = await f(`${API}/repos/${owner}/${repo}/tarball/${encodeURIComponent(ref)}`, {
    headers: headers(token),
    redirect: "manual",
  });

  let res = first;
  if (first.status >= 300 && first.status < 400) {
    const loc = first.headers.get("location");
    if (!loc) throw new Error("GitHub returned a redirect with no location for the tarball.");
    res = await f(loc); // deliberately unauthenticated: the URL is already signed
  }
  if (!res.ok) throw new Error(`Could not download the repo archive (HTTP ${res.status}).`);

  const declared = Number(res.headers.get("content-length") || 0);
  if (declared && declared > maxBytes) {
    throw new Error(`Repo archive is ${(declared / 1048576).toFixed(1)} MB, over the ${(maxBytes / 1048576) | 0} MB limit for automatic deploys.`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new Error(`Repo archive is ${(buf.byteLength / 1048576).toFixed(1)} MB, over the ${(maxBytes / 1048576) | 0} MB limit for automatic deploys.`);
  }
  return buf;
}

/** Create a repository on the token's account. Needs Administration: write. */
export async function createRepo(token, name, isPrivate = true, f = fetch) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
    throw new Error("Repo names may only use letters, numbers, dots, hyphens and underscores.");
  }
  const r = await gh(token, "/user/repos", {
    method: "POST",
    body: JSON.stringify({ name, private: isPrivate, auto_init: true }),
  }, f);
  if (!r.ok) {
    const m = r.body?.errors?.[0]?.message || r.body?.message || "";
    if (/already exists/i.test(m)) throw new Error(`You already have a repo called ${name}.`);
    if (r.status === 403) throw new Error("That token cannot create repos — it needs Administration: Read and write, scoped to All repositories.");
    throw new Error(`Could not create the repo (HTTP ${r.status}): ${m}`);
  }
  return { owner: r.body.owner.login, repo: r.body.name, full_name: r.body.full_name, branch: r.body.default_branch || "main" };
}

/**
 * Delete a repository — PERMANENT. Every file and the entire history are gone;
 * GitHub cannot restore a deleted private repository for us.
 *
 * Needs `administration=write` on the token — measured from GitHub's own
 * `x-accepted-github-permissions` response header on this endpoint. A token
 * with only `contents=write` gets a 403 here, so the caller must translate
 * that into a sentence naming the Administration permission, not Contents.
 */
export async function deleteRepo(token, owner, repo, f = fetch) {
  const r = await gh(token, `/repos/${owner}/${repo}`, { method: "DELETE" }, f);
  if (r.status === 204) return true;
  if (!r.ok) throw new Error(`Could not delete the repository (HTTP ${r.status}): ${r.body?.message || ""}`);
  return true;
}

// ---------------------------------------------------------------- git data API
// One commit for many changes. The Contents API can only touch a single file per
// call, which makes a folder upload N commits and a folder delete impossible.

/** Full recursive tree at a ref, so a folder's contents can be found. */
/**
 * The branch's latest commit id, in ONE call.
 *
 * treeOf costs three calls (ref, commit, tree) and downloads every path in the
 * repository. Almost every refresh finds nothing has changed, so asking this
 * first and comparing turns three calls plus a full file listing into one small
 * one for each unchanged app.
 */
export async function headSha(token, owner, repo, branch, f = fetch) {
  const ref = await gh(token, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, {}, f);
  if (!ref.ok) throw new Error(`Could not read the branch (HTTP ${ref.status}): ${ref.body?.message || ""}`);
  return ref.body.object.sha;
}

export async function treeOf(token, owner, repo, branch, f = fetch) {
  const ref = await gh(token, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, {}, f);
  if (!ref.ok) throw new Error(`Could not read the branch (HTTP ${ref.status}): ${ref.body?.message || ""}`);
  const commitSha = ref.body.object.sha;
  const commit = await gh(token, `/repos/${owner}/${repo}/git/commits/${commitSha}`, {}, f);
  if (!commit.ok) throw new Error(`Could not read the last commit (HTTP ${commit.status}).`);
  const treeSha = commit.body.tree.sha;
  const tree = await gh(token, `/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`, {}, f);
  if (!tree.ok) throw new Error(`Could not read the file list (HTTP ${tree.status}).`);
  return {
    commitSha, treeSha,
    // The commit object is ALREADY fetched above and its date was being thrown
    // away. This is the branch's last commit — true of the repo, and NOT true of
    // any individual file in it, so the panel labels it "last commit".
    commitAt: commit.body.committer?.date || commit.body.author?.date || null,
    truncated: !!tree.body.truncated,
    // `mode` is carried so a rename can move a blob without changing its bits:
    // an executable (100755) or a symlink (120000) silently becoming 100644
    // would be a real, invisible corruption of the repository.
    entries: (tree.body.tree || []).map((e) => ({
      path: e.path, type: e.type, size: e.size || 0, sha: e.sha, mode: e.mode || "100644",
    })),
  };
}

/**
 * Apply many additions, moves and deletions as ONE commit.
 *
 * `files`  : [{path, contentB64}]      content we are uploading now
 * `blobs`  : [{path, sha, mode}]       content that ALREADY exists in the repo,
 *                                      placed at a new path — this is how a
 *                                      rename moves bytes without re-uploading
 *                                      them, and how a folder rename stays one
 *                                      commit however many files it holds.
 * `remove` : [path, ...]               already expanded to individual blobs
 *
 * Paths are collapsed through a Map so the same path can never appear twice in
 * one tree (GitHub's behaviour for a duplicate path is undefined). Precedence is
 * deliberate — a delete beats a move, and freshly uploaded content beats both —
 * which is what makes a swap (a -> b and b -> a in one request) come out right.
 */
export async function commitChanges(
  token, { owner, repo, branch, message, files = [], remove = [], blobs = [] }, f = fetch
) {
  if (!files.length && !remove.length && !blobs.length) throw new Error("Nothing to commit.");
  const base = await treeOf(token, owner, repo, branch, f);

  const byPath = new Map();
  for (const b of blobs) {
    byPath.set(b.path, { path: b.path, mode: b.mode || "100644", type: "blob", sha: b.sha });
  }
  // A null sha removes the path from the new tree.
  for (const path of remove) byPath.set(path, { path, mode: "100644", type: "blob", sha: null });
  for (const file of files) {
    const blob = await gh(token, `/repos/${owner}/${repo}/git/blobs`, {
      method: "POST", body: JSON.stringify({ content: file.contentB64, encoding: "base64" }),
    }, f);
    if (!blob.ok) throw new Error(`Could not store ${file.path} (HTTP ${blob.status}): ${blob.body?.message || ""}`);
    byPath.set(file.path, { path: file.path, mode: "100644", type: "blob", sha: blob.body.sha });
  }
  const tree = [...byPath.values()];

  const newTree = await gh(token, `/repos/${owner}/${repo}/git/trees`, {
    method: "POST", body: JSON.stringify({ base_tree: base.treeSha, tree }),
  }, f);
  if (!newTree.ok) throw new Error(`Could not build the change (HTTP ${newTree.status}): ${newTree.body?.message || ""}`);

  const commit = await gh(token, `/repos/${owner}/${repo}/git/commits`, {
    method: "POST", body: JSON.stringify({ message, tree: newTree.body.sha, parents: [base.commitSha] }),
  }, f);
  if (!commit.ok) throw new Error(`Could not create the commit (HTTP ${commit.status}): ${commit.body?.message || ""}`);

  const upd = await gh(token, `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH", body: JSON.stringify({ sha: commit.body.sha }),
  }, f);
  if (!upd.ok) throw new Error(`Could not update the branch (HTTP ${upd.status}): ${upd.body?.message || ""}`);
  return { commitSha: commit.body.sha, changed: files.length, removed: remove.length, moved: blobs.length };
}

/** File contents as base64, by path. */
export async function readFile(token, owner, repo, branch, path, f = fetch) {
  const r = await gh(token, `/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`, {}, f);
  if (r.status === 404) throw new Error("That file is not in the repository.");
  if (!r.ok) throw new Error(`Could not open the file (HTTP ${r.status}): ${r.body?.message || ""}`);
  if (Array.isArray(r.body)) throw new Error("That is a folder, not a file.");
  return { contentB64: (r.body.content || "").replace(/\s/g, ""), sha: r.body.sha, size: r.body.size };
}

/**
 * Which buildpack Heroku will detect, if any.
 * Verified against heroku-buildpack-php/bin/detect: PHP is detected on
 * composer.json OR index.php. A repo of plain .html files matches nothing and
 * the build fails with "No default language could be detected".
 */
export function buildpackFor(paths) {
  const has = (p) => paths.includes(p);
  if (has("composer.json") || has("index.php")) return "php";
  if (has("package.json")) return "nodejs";
  if (has("requirements.txt") || has("Pipfile") || has("setup.py")) return "python";
  if (has("Gemfile")) return "ruby";
  if (has("go.mod")) return "go";
  if (has("pom.xml") || has("build.gradle")) return "java";
  if (has("Cargo.toml")) return "rust";
  if (has("static.json")) return "static";
  return null;
}
