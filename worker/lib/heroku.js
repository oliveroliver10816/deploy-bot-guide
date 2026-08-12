/**
 * Heroku Platform API helpers.
 *
 * Deploy route is source-blob, not the GitHub integration:
 *   1. POST /sources                -> a signed put_url + get_url pair (valid 1 h)
 *   2. PUT  put_url  <tarball>      -> upload the repo archive ourselves
 *   3. POST /apps/{app}/builds      -> build from get_url
 *
 * Why not hand Heroku the GitHub tarball URL directly: Heroku's own docs only
 * demonstrate that for PUBLIC repos and never send an Authorization header, so
 * a private repo would 404 at build time. Uploading the archive ourselves works
 * identically for public and private, which keeps one code path for both.
 */

const API = "https://api.heroku.com";
const ACCEPT = "application/vnd.heroku+json; version=3";

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: ACCEPT,
    "Content-Type": "application/json",
  };
}

async function hk(token, path, init = {}, f = fetch) {
  const res = await f(`${API}${path}`, { ...init, headers: { ...headers(token), ...(init.headers || {}) } });
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 300) }; }
  }
  return { ok: res.ok, status: res.status, body };
}

export async function verifyToken(token, f = fetch) {
  const r = await hk(token, "/account", {}, f);
  if (!r.ok) throw new Error(`Heroku rejected that key (HTTP ${r.status}): ${r.body?.message || ""}`);
  return r.body.email;
}

export async function listApps(token, f = fetch) {
  const r = await hk(token, "/apps", {}, f);
  if (!r.ok) throw new Error(`Could not list Heroku apps (HTTP ${r.status}): ${r.body?.message || ""}`);
  return (Array.isArray(r.body) ? r.body : []).map((a) => ({
    name: a.name,
    web_url: a.web_url,
  }));
}

/**
 * Whether this app already auto-deploys from GitHub. If it does and we also
 * trigger a build, every push produces two builds racing each other — so the
 * caller warns instead of silently double-deploying.
 */
export async function githubAutoDeploy(token, app, f = fetch) {
  const r = await hk(token, `/apps/${encodeURIComponent(app)}/github`, {}, f);
  if (!r.ok) return null; // 404 = no integration, which is the normal case
  return r.body?.auto_deploy ? r.body : null;
}

async function createSource(token, app, f = fetch) {
  // Account-level /sources is current; the app-scoped form is deprecated but
  // still live on older stacks, so fall back rather than fail.
  let r = await hk(token, "/sources", { method: "POST" }, f);
  if (!r.ok) r = await hk(token, `/apps/${encodeURIComponent(app)}/sources`, { method: "POST" }, f);
  if (!r.ok) throw new Error(`Heroku would not issue an upload slot (HTTP ${r.status}): ${r.body?.message || ""}`);
  const sb = r.body?.source_blob;
  if (!sb?.put_url || !sb?.get_url) throw new Error("Heroku returned an upload slot with no URLs.");
  return sb;
}

/**
 * Upload the archive to the signed URL.
 * No Content-Type header on purpose: the signature does not cover one, and
 * Heroku's own instructions strip it explicitly.
 */
async function uploadSource(put_url, bytes, f = fetch) {
  const res = await f(put_url, { method: "PUT", body: bytes });
  if (!res.ok) throw new Error(`Upload to Heroku storage failed (HTTP ${res.status}).`);
}

export async function createBuild(token, app, get_url, version, f = fetch) {
  const r = await hk(token, `/apps/${encodeURIComponent(app)}/builds`, {
    method: "POST",
    body: JSON.stringify({ source_blob: { url: get_url, version } }),
  }, f);
  if (!r.ok) throw new Error(`Heroku refused the build (HTTP ${r.status}): ${r.body?.message || ""}`);
  return { id: r.body.id, status: normalizeStatus(r.body.status), output_stream_url: r.body.output_stream_url };
}

/** Full deploy: source slot -> upload -> build. */
export async function deploy(token, app, tarBytes, version, f = fetch) {
  const sb = await createSource(token, app, f);
  await uploadSource(sb.put_url, tarBytes, f);
  return createBuild(token, app, sb.get_url, version, f);
}

/**
 * Heroku's docs disagree with themselves here: the prose lists `successful`
 * while the JSON sample shows `succeeded`. Accept both so a green build is
 * never reported as failed.
 */
export function normalizeStatus(s) {
  if (s === "succeeded" || s === "successful" || s === "success") return "succeeded";
  if (s === "failed" || s === "error") return "failed";
  return "pending";
}

export async function getBuild(token, app, buildId, f = fetch) {
  const r = await hk(token, `/apps/${encodeURIComponent(app)}/builds/${buildId}`, {}, f);
  if (!r.ok) throw new Error(`Could not read build status (HTTP ${r.status}): ${r.body?.message || ""}`);
  return {
    id: r.body.id,
    status: normalizeStatus(r.body.status),
    output_stream_url: r.body.output_stream_url,
  };
}

/** Last few lines of the build log, for reporting a failure usefully. */
export async function buildLogTail(url, lines = 12, f = fetch) {
  if (!url) return "";
  try {
    const res = await f(url);
    if (!res.ok) return "";
    const text = await res.text();
    return text.trim().split("\n").slice(-lines).join("\n").slice(-1200);
  } catch {
    return "";
  }
}
