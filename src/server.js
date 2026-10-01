// HTTP API for n8n + a minimal review page + public media for Instagram.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { settings, listBusinesses } from "./config.js";
import * as db from "./db.js";
import * as jobs from "./jobs.js";
import { assembleCaption } from "./content.js";
import { startPolling } from "./telegram.js";

const JOBS = {
  plan: (b, q) => jobs.planDay(b, { date: q.date, force: q.force === true || q.force === "true" }),
  "generate-post": (b, q) => jobs.generateItem(b, "post", { date: q.date }),
  "generate-story": (b, q) => jobs.generateItem(b, "story", { date: q.date }),
  publish: (b) => jobs.publishDue(b),
  monitor: (b) => jobs.monitor(b),
  cleanup: (b) => jobs.cleanup(b),
};

const ITEM_ACTIONS = {
  approve: (id) => jobs.approve(id),
  reject: (id) => jobs.reject(id),
  regenerate: (id) => jobs.regenerate(id),
  "publish-now": (id) => jobs.publishNow(id),
  retry: (id) => jobs.publishNow(id),
  edit: (id, body) =>
    jobs.editItem(id, {
      caption: body.caption,
      hashtags: body.hashtags,
      fields: typeof body.fields === "string" ? JSON.parse(body.fields || "{}") : body.fields,
    }),
};

function authorized(req) {
  if (!settings.adminToken) return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
  const h = req.headers.authorization || "";
  let given = "";
  if (h.startsWith("Bearer ")) given = h.slice(7);
  else if (h.startsWith("Basic ")) given = Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":");
  const a = Buffer.from(given);
  const b = Buffer.from(settings.adminToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return {};
  if ((req.headers["content-type"] || "").includes("application/json")) return JSON.parse(raw);
  return Object.fromEntries(new URLSearchParams(raw));
}

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body, null, 2) : body);
};

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      // Public: Meta's servers download creatives from here. Names are unguessable.
      if (req.method === "GET" && parts[0] === "media" && parts.length === 3) {
        const [, slug, file] = parts;
        if (!/^[a-z0-9_-]+$/i.test(slug) || !/^[\w.-]+\.jpg$/.test(file)) return send(res, 404, { error: "not found" });
        const p = path.join(settings.dataDir, "media", slug, file);
        if (!fs.existsSync(p)) return send(res, 404, { error: "not found" });
        res.writeHead(200, { "content-type": "image/jpeg", "content-length": fs.statSync(p).size, "cache-control": "public, max-age=86400" });
        return fs.createReadStream(p).pipe(res);
      }
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, heartbeat: db.kvGet("heartbeat") || null });

      if (!authorized(req)) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="automation"', "content-type": "text/plain" });
        return res.end("Unauthorized");
      }

      const isForm = (req.headers["content-type"] || "").includes("application/x-www-form-urlencoded");
      const body = req.method === "POST" ? await readBody(req) : {};
      const done = (result) => (isForm ? (res.writeHead(303, { location: `/?msg=${encodeURIComponent(typeof result === "string" ? result : "Done")}` }), res.end()) : send(res, 200, { ok: true, result }));

      if (req.method === "GET" && url.pathname === "/") return send(res, 200, reviewPage(url.searchParams.get("msg")), "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/api/status") return send(res, 200, jobs.status());
      if (req.method === "GET" && url.pathname === "/api/items") {
        return send(res, 200, db.listItems({ since: url.searchParams.get("since") || undefined, limit: Number(url.searchParams.get("limit") || 50) }));
      }

      // POST /api/jobs/:job   body/query: { business?, date?, force? }
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "jobs") {
        const job = parts[2];
        const q = { ...Object.fromEntries(url.searchParams), ...body };
        if (job === "tick") return done(await jobs.exclusive(() => jobs.tick()));
        if (!JOBS[job]) return send(res, 404, { error: `unknown job ${job}` });
        const slugs = q.business ? [q.business] : listBusinesses();
        const out = {};
        for (const s of slugs) out[s] = await jobs.exclusive(() => JOBS[job](s, q));
        return done(out);
      }

      // POST /api/items/:id/:action
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "items" && ITEM_ACTIONS[parts[3]]) {
        return done(await jobs.exclusive(() => ITEM_ACTIONS[parts[3]](Number(parts[2]), body)));
      }

      // POST /api/businesses/:slug/(pause|resume|skip|unskip)
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "businesses") {
        const [, , slug, action] = parts;
        if (!listBusinesses().includes(slug)) return send(res, 404, { error: "unknown business" });
        const date = body.date || url.searchParams.get("date") || undefined;
        const fn = { pause: () => jobs.setPaused(slug, true), resume: () => jobs.setPaused(slug, false), skip: () => jobs.skipDay(slug, date), unskip: () => jobs.unskipDay(slug, date) }[action];
        if (!fn) return send(res, 404, { error: "unknown action" });
        return done(fn());
      }

      return send(res, 404, { error: "not found" });
    } catch (e) {
      db.logEvent({ level: "error", kind: "system", message: `${req.method} ${url.pathname}: ${e.message}` });
      if ((req.headers["content-type"] || "").includes("application/x-www-form-urlencoded")) {
        res.writeHead(303, { location: `/?msg=${encodeURIComponent("Error: " + e.message)}` });
        return res.end();
      }
      return send(res, 500, { ok: false, error: e.message });
    }
  });
}

// ---------------------------------------------------------------- review page

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function reviewPage(msg) {
  const st = jobs.status();
  const btn = (action, label, cls = "") => `<button class="${cls}" formaction="${action}">${label}</button>`;
  const businesses = st.businesses
    .map((b) => {
      const biz = jobs.ctx(b.slug);
      const items = db.listItems({ businessId: biz.id, limit: 30 });
      const cards = items
        .map((i) => {
          const img = i.creative_path ? `/media/${b.slug}/${path.basename(i.creative_path)}` : "";
          const locked = ["published", "publishing"].includes(i.status);
          const notes = (i.validation || []).filter(Boolean);
          return `<article class="card s-${esc(i.status)}">
  <div class="thumb ${i.content_type}">${img ? `<a href="${img}" target="_blank"><img src="${img}" alt="${esc(i.topic)}" loading="lazy"></a>` : "<span>not rendered</span>"}</div>
  <div class="meta">
    <div class="row"><b>${esc(i.content_type.toUpperCase())}</b> · ${esc(i.date)} · <span class="badge">${esc(i.status)}</span>${i.source !== "ai" ? ` <span class="badge alt">${esc(i.source)}</span>` : ""}</div>
    <div class="topic">${esc(i.topic)}</div>
    <div class="small">${esc(i.content_pillar)} · ${esc(i.template)} · slot ${esc(new Date(i.scheduled_at).toLocaleString("en-IN", { timeZone: biz.tz, hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }))}</div>
    ${i.instagram_url ? `<div class="small"><a href="${esc(i.instagram_url)}" target="_blank">View on Instagram</a></div>` : ""}
    ${i.error ? `<div class="err">${esc(i.error)}</div>` : ""}
    ${notes.length ? `<div class="small warn">${notes.map(esc).join("<br>")}</div>` : ""}
    <form method="post">
      ${i.content_type === "post" ? `<label>Caption<textarea name="caption" rows="7" ${locked ? "disabled" : ""}>${esc(i.caption)}</textarea></label>
      <label>Hashtags<input name="hashtags" value="${esc((i.hashtags || []).join(" "))}" ${locked ? "disabled" : ""}></label>` : ""}
      <details><summary>Image text (re-renders, no AI cost)</summary><textarea name="fields" rows="8" ${locked ? "disabled" : ""}>${esc(JSON.stringify(i.fields, null, 2))}</textarea></details>
      ${locked ? "" : `<div class="actions">
        ${btn(`/api/items/${i.id}/edit`, "Save edits")}
        ${["pending_approval", "failed", "rejected", "missed", "skipped"].includes(i.status) && i.creative_path ? btn(`/api/items/${i.id}/approve`, "Approve", "primary") : ""}
        ${btn(`/api/items/${i.id}/reject`, "Reject")}
        ${btn(`/api/items/${i.id}/regenerate`, "Regenerate (1 AI call)")}
        ${i.creative_path ? btn(`/api/items/${i.id}/publish-now`, "Publish now", "danger") : ""}
      </div>`}
    </form>
    ${i.content_type === "post" && locked ? `<pre class="cap">${esc(assembleCaption(i.caption, i.hashtags))}</pre>` : ""}
  </div>
</article>`;
        })
        .join("\n");
      return `<section>
  <header class="bizhead"><h2>${esc(b.slug)}</h2>
    <span class="small">today ${esc(b.today)} · generate ${esc(b.schedule.generate_at)} · post ${esc(b.schedule.post_at)} · story ${esc(b.schedule.story_at)} · approval ${b.approval_mode ? "ON" : "off"} ${b.paused ? "· <b>PAUSED</b>" : ""}</span>
    <form method="post" class="inline">
      ${btn(`/api/jobs/plan?business=${b.slug}`, "Plan today")}
      ${btn(`/api/jobs/plan?business=${b.slug}&force=true`, "Replace today (1 AI call)")}
      ${btn(`/api/businesses/${b.slug}/skip`, "Skip today")}
      ${b.paused ? btn(`/api/businesses/${b.slug}/resume`, "Resume", "primary") : btn(`/api/businesses/${b.slug}/pause`, "Pause automation", "danger")}
    </form>
  </header>
  <div class="grid">${cards || "<p>No content yet.</p>"}</div>
</section>`;
    })
    .join("\n");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Content Review</title>
<style>
:root{--bg:#0b0c0f;--panel:#14161b;--line:#262a31;--text:#f1f0ec;--muted:#9ba2b0;--accent:#3adbff;--danger:#ff6b6b;--warn:#ffcf5c}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--bg:#f1f0ec;--panel:#fff;--line:#dedcd6;--text:#0b0c0f;--muted:#5a5e67;--accent:#0b7ea0;--danger:#c0392b;--warn:#9a6b00}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;padding:16px}
h1{font-size:20px;margin:0 0 4px}h2{margin:0 12px 0 0;font-size:18px}a{color:var(--accent)}
.top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:16px}
.msg{padding:10px 14px;border:1px solid var(--accent);border-radius:8px;margin-bottom:16px;white-space:pre-wrap;overflow-wrap:anywhere}
.small{color:var(--muted);font-size:12px}.warn{color:var(--warn)}.err{color:var(--danger);font-size:12px;margin:4px 0;overflow-wrap:anywhere}
.bizhead{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:20px 0 12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,520px),1fr));gap:14px}
.card{display:flex;gap:14px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;min-width:0}
.thumb{flex:0 0 150px}.thumb img{width:150px;border-radius:8px;display:block}.thumb span{color:var(--muted);font-size:12px}
.meta{flex:1;min-width:0}.row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.topic{font-weight:600;margin:4px 0}
.badge{font-size:11px;padding:2px 8px;border-radius:20px;border:1px solid var(--line)}.badge.alt{border-color:var(--warn);color:var(--warn)}
.s-published .badge{border-color:var(--accent);color:var(--accent)}.s-failed .badge,.s-missed .badge{border-color:var(--danger);color:var(--danger)}
label{display:block;font-size:12px;color:var(--muted);margin-top:8px}
textarea,input{width:100%;background:transparent;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:6px;font:13px/1.4 ui-monospace,Consolas,monospace}
details{margin-top:6px;font-size:12px;color:var(--muted)}
.actions,.inline{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
button{background:transparent;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:6px 10px;cursor:pointer;font-size:12px}
button.primary{border-color:var(--accent);color:var(--accent)}button.danger{border-color:var(--danger);color:var(--danger)}
pre.cap{white-space:pre-wrap;font-size:12px;color:var(--muted)}
@media (max-width:560px){.card{flex-direction:column}.thumb{flex:none}.thumb img{width:100%}}
</style></head><body>
<div class="top"><div><h1>Instagram automation</h1>
<div class="small">publish mode <b>${esc(st.publish_mode)}</b> · LLM ${esc(st.llm.provider)} ${esc(st.llm.model)} · AI cost this month ₹${esc(st.llm_cost_this_month.cost_inr)} (${esc(st.llm_cost_this_month.calls)} calls) · last run ${esc(st.heartbeat || "never")}</div></div>
<form method="post" class="inline">${btn("/api/jobs/tick", "Run scheduler now", "primary")}</form></div>
${msg ? `<div class="msg">${esc(msg)}</div>` : ""}
${businesses}
</body></html>`;
}

// ---------------------------------------------------------------- boot

const telegramHandlers = {
  approve: (id) => jobs.exclusive(() => jobs.approve(id)),
  reject: (id) => jobs.exclusive(() => jobs.reject(id)),
  regenerate: (id) => jobs.exclusive(() => jobs.regenerate(id)),
  async command(cmd, args) {
    const slug = listBusinesses()[0];
    switch (cmd) {
      case "status": {
        const b = jobs.status().businesses.find((x) => x.slug === slug);
        return [`${slug} ${b.paused ? "(PAUSED)" : ""}`, ...b.items.slice(0, 6).map((i) => `#${i.id} ${i.date} ${i.type}: ${i.status} - ${i.topic}`)].join("\n");
      }
      case "skip":
        return jobs.skipDay(slug, args[0]);
      case "pause":
        return jobs.setPaused(slug, true);
      case "resume":
        return jobs.setPaused(slug, false);
      case "approve":
        return jobs.exclusive(() => jobs.approve(Number(args[0])));
      case "retry":
        return jobs.exclusive(() => jobs.publishNow(Number(args[0])));
      default:
        return "Commands: /status, /skip [YYYY-MM-DD], /pause, /resume, /approve <id>, /retry <id>";
    }
  },
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || (settings.adminToken ? "0.0.0.0" : "127.0.0.1");
  createServer().listen(settings.port, host, () => {
    db.logEvent({ kind: "system", message: `Server on http://${host}:${settings.port} (scheduler: ${settings.scheduler}, publish: ${settings.instagram.mode}, llm: ${settings.llm.provider})` });
  });
  if (settings.scheduler === "internal") {
    const run = () => jobs.exclusive(() => jobs.tick()).catch((e) => db.logEvent({ level: "error", kind: "system", message: e.message }));
    setTimeout(run, 3000);
    setInterval(run, settings.tickSeconds * 1000);
  }
  startPolling(telegramHandlers);
}
