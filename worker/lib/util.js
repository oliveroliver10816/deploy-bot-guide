/** Bytes -> base64, chunked so a multi-MB file does not blow the argument limit. */
export function toBase64(bytes) {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

export function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const nowIso = () => new Date().toISOString();

export function humanSize(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/**
 * Reject anything that could escape the repo or produce a path GitHub will not
 * accept. Returns the cleaned relative path.
 */
export function safeJoin(dir, name) {
  const d = String(dir || "").replace(/^\/+|\/+$/g, "");
  const n = String(name || "").trim();
  if (!n) throw new Error("That file has no name.");
  if (n.includes("/") || n.includes("\\")) throw new Error("File names cannot contain slashes.");
  if (n === "." || n === "..") throw new Error("Invalid file name.");
  const joined = d ? `${d}/${n}` : n;
  if (joined.split("/").some((seg) => seg === "..")) throw new Error("Invalid path.");
  if (joined.length > 400) throw new Error("That path is too long.");
  return joined;
}

export const parentDir = (dir) => {
  const parts = String(dir || "").split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
};
