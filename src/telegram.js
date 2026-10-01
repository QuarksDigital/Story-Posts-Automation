// Telegram: free notifications + one-tap approval. Uses long polling
// (getUpdates), so it works on a laptop with no public URL or webhook.
import fs from "node:fs";
import path from "node:path";
import { settings } from "./config.js";
import { kvGet, kvSet, logEvent } from "./db.js";

const enabled = () => Boolean(settings.telegram.token && settings.telegram.chatId);
const api = (method) => `${settings.telegram.apiBase}/bot${settings.telegram.token}/${method}`;

async function call(method, payload, isForm = false) {
  const res = await fetch(api(method), {
    method: "POST",
    ...(isForm ? { body: payload } : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(method === "getUpdates" ? 40_000 : 30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description || res.status}`);
  return json.result;
}

export async function notify(text, { photo, buttons } = {}) {
  if (!enabled()) {
    if (process.env.QUIET_LOGS !== "1") console.log(`[telegram disabled] ${text.split("\n")[0]}`);
    return false;
  }
  const reply_markup = buttons ? { inline_keyboard: buttons } : undefined;
  try {
    if (photo && fs.existsSync(photo)) {
      const form = new FormData();
      form.append("chat_id", settings.telegram.chatId);
      form.append("caption", text.slice(0, 1024)); // Telegram photo-caption limit
      form.append("photo", new Blob([fs.readFileSync(photo)], { type: "image/jpeg" }), path.basename(photo));
      if (reply_markup) form.append("reply_markup", JSON.stringify(reply_markup));
      await call("sendPhoto", form, true);
    } else {
      await call("sendMessage", { chat_id: settings.telegram.chatId, text: text.slice(0, 4096), reply_markup, disable_web_page_preview: true });
    }
    return true;
  } catch (e) {
    logEvent({ level: "warn", kind: "notify", message: e.message });
    return false;
  }
}

export const approvalButtons = (id) => [
  [
    { text: "Approve", callback_data: `a:${id}` },
    { text: "Reject", callback_data: `r:${id}` },
    { text: "Regenerate", callback_data: `g:${id}` },
  ],
];

let polling = false;

/**
 * Long-poll loop. `handlers` = { approve(id), reject(id), regenerate(id), command(name, args) }
 * each returning a short reply string.
 */
export async function startPolling(handlers) {
  if (!enabled() || !settings.telegram.polling || polling) return;
  polling = true;
  logEvent({ kind: "system", message: "Telegram polling started" });
  while (polling) {
    try {
      const offset = kvGet("telegram_offset") ?? 0;
      const updates = await call("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
      for (const u of updates) {
        kvSet("telegram_offset", u.update_id + 1);
        await handleUpdate(u, handlers);
      }
    } catch (e) {
      logEvent({ level: "warn", kind: "notify", message: `Telegram poll: ${e.message}` });
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

export function stopPolling() {
  polling = false;
}

async function handleUpdate(u, handlers) {
  const chatId = String(u.callback_query?.message?.chat?.id ?? u.message?.chat?.id ?? "");
  if (chatId !== String(settings.telegram.chatId)) return; // ignore strangers

  if (u.callback_query) {
    const [action, id] = (u.callback_query.data || "").split(":");
    const fn = { a: handlers.approve, r: handlers.reject, g: handlers.regenerate }[action];
    let reply = "Unknown action";
    try {
      if (fn) reply = await fn(Number(id));
    } catch (e) {
      reply = `Failed: ${e.message}`;
    }
    await call("answerCallbackQuery", { callback_query_id: u.callback_query.id, text: reply.slice(0, 190) }).catch(() => {});
    await notify(reply);
    return;
  }

  const text = (u.message?.text || "").trim();
  if (text.startsWith("/")) {
    const [cmd, ...args] = text.slice(1).split(/\s+/);
    let reply;
    try {
      reply = await handlers.command(cmd.split("@")[0], args);
    } catch (e) {
      reply = `Failed: ${e.message}`;
    }
    await notify(reply);
  }
}
