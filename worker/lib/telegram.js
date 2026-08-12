/**
 * Telegram Bot API helpers.
 *
 * Everything here takes the bot token explicitly so the module stays testable
 * against a mock fetch with no globals involved.
 */

const API = "https://api.telegram.org";

export async function tg(token, method, body, fetchImpl = fetch) {
  const res = await fetchImpl(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  let out;
  try {
    out = await res.json();
  } catch {
    return { ok: false, description: `non-JSON reply (HTTP ${res.status})` };
  }
  return out;
}

export const send = (token, chat_id, text, extra = {}, f = fetch) =>
  tg(token, "sendMessage", {
    chat_id,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  }, f);

export const edit = (token, chat_id, message_id, text, extra = {}, f = fetch) =>
  tg(token, "editMessageText", {
    chat_id,
    message_id,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  }, f);

export const answerCb = (token, id, text = "", f = fetch) =>
  tg(token, "answerCallbackQuery", { callback_query_id: id, text }, f);

export const deleteMsg = (token, chat_id, message_id, f = fetch) =>
  tg(token, "deleteMessage", { chat_id, message_id }, f);

/**
 * Download a file the user sent. Bot API caps downloads at 20 MB; we surface
 * that as a clear message rather than an opaque failure.
 */
export async function downloadFile(token, file_id, f = fetch) {
  const meta = await tg(token, "getFile", { file_id }, f);
  if (!meta.ok) {
    const d = meta.description || "";
    if (/too big/i.test(d)) {
      throw new Error("That file is over Telegram's 20 MB bot limit. Send a smaller file.");
    }
    throw new Error(`Could not read the file: ${d || "unknown error"}`);
  }
  const res = await f(`${API}/file/bot${token}/${meta.result.file_path}`);
  if (!res.ok) throw new Error(`Could not download the file (HTTP ${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Inline keyboard rows from [{text, data}], `cols` per row. */
export function keyboard(buttons, cols = 2) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += cols) {
    rows.push(
      buttons.slice(i, i + cols).map((b) => ({
        text: b.text,
        callback_data: b.data,
      }))
    );
  }
  return { reply_markup: { inline_keyboard: rows } };
}

/** Escape for Telegram HTML parse_mode. */
export const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
