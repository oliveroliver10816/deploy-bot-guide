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
