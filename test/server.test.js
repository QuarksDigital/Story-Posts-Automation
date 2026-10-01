// HTTP API auth, review page, n8n job endpoints, and Telegram approval buttons
// (against a local fake of the Telegram Bot API).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { sandbox, ist } from "./helpers.js";

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

const tg = { sent: [], updates: [], answered: [] };
const telegram = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const method = req.url.split("/").pop();
  const json = (result) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify({ ok: true, result })));
  if (method === "sendPhoto") {
    const text = raw.toString("latin1");
    tg.sent.push({ method, hasPhoto: text.includes('name="photo"'), buttons: /"callback_data":"a:\d+"/.test(text), caption: text });
    return json({ message_id: 1 });
  }
  const body = raw.length ? JSON.parse(raw.toString()) : {};
  if (method === "sendMessage") return (tg.sent.push({ method, text: body.text }), json({ message_id: 2 }));
  if (method === "answerCallbackQuery") return (tg.answered.push(body), json(true));
  if (method === "getUpdates") {
    const batch = tg.updates.filter((u) => u.update_id >= (body.offset || 0));
    if (!batch.length) await new Promise((r) => setTimeout(r, 50));
    return json(batch);
  }
  return json(true);
});
const tgPort = await listen(telegram);

sandbox({
  env: {
    ADMIN_TOKEN: "s3cret-admin-token",
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_CHAT_ID: "4242",
    TELEGRAM_API_BASE: `http://127.0.0.1:${tgPort}`,
  },
});
const { createServer } = await import("../src/server.js");
const db = await import("../src/db.js");
const jobs = await import("../src/jobs.js");
const { setNow } = await import("../src/time.js");
const { startPolling, stopPolling } = await import("../src/telegram.js");
const engine = createServer();
const port = await listen(engine);
const base = `http://127.0.0.1:${port}`;
after(() => {
  stopPolling();
  engine.close();
  telegram.close();
});

const bearer = { authorization: "Bearer s3cret-admin-token" };
const basic = { authorization: `Basic ${Buffer.from("owner:s3cret-admin-token").toString("base64")}` };

test("health is public; everything else needs the admin token", async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/`)).status, 401);
  assert.equal((await fetch(`${base}/api/status`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await fetch(`${base}/api/jobs/tick`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${base}/api/status`, { headers: bearer })).status, 200);
});

test("n8n-style job calls: plan + generate, and approval previews go to Telegram with buttons", async () => {
  setNow(ist("2026-10-05", "07:45"));
  const r = await (await fetch(`${base}/api/jobs/plan`, { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ business: "quarks" }) })).json();
  assert.equal(r.ok, true);
  assert.equal(r.result.quarks.planned.length, 2);
  for (const job of ["generate-post", "generate-story"]) {
    const g = await (await fetch(`${base}/api/jobs/${job}`, { method: "POST", headers: bearer })).json();
    assert.equal(g.result.quarks.status, "pending_approval");
  }
  const previews = tg.sent.filter((m) => m.method === "sendPhoto");
  assert.equal(previews.length, 2);
  assert.ok(previews.every((p) => p.hasPhoto && p.buttons));
  assert.match(previews[0].caption, /Topic:/);
  // repeated calls are no-ops (n8n can call as often as it likes)
  const again = await (await fetch(`${base}/api/jobs/plan`, { method: "POST", headers: bearer })).json();
  assert.equal(again.result.quarks.skipped, "already planned");
});

test("review page renders items and form actions redirect back", async () => {
  const html = await (await fetch(`${base}/`, { headers: basic })).text();
  assert.match(html, /Instagram automation/);
  assert.match(html, /pending_approval/);
  const story = db.getItemFor(1, "2026-10-05", "story");
  const res = await fetch(`${base}/api/items/${story.id}/approve`, { method: "POST", headers: { ...basic, "content-type": "application/x-www-form-urlencoded" }, body: "", redirect: "manual" });
  assert.equal(res.status, 303);
  assert.match(decodeURIComponent(res.headers.get("location")), /Approved story/);
  assert.equal(db.getItem(story.id).status, "approved");
});

test("editing the caption from the form saves without an AI call", async () => {
  const post = db.getItemFor(1, "2026-10-05", "post");
  const calls = db.getDb().prepare("SELECT COUNT(*) n FROM llm_usage").get().n;
  const body = new URLSearchParams({ caption: "Owner caption.", hashtags: "#webdesign seo", fields: JSON.stringify(post.fields) });
  const res = await fetch(`${base}/api/items/${post.id}/edit`, { method: "POST", headers: { ...basic, "content-type": "application/x-www-form-urlencoded" }, body, redirect: "manual" });
  assert.equal(res.status, 303);
  const after = db.getItem(post.id);
  assert.equal(after.caption, "Owner caption.");
  assert.deepEqual(after.hashtags, ["webdesign", "seo"]);
  assert.equal(db.getDb().prepare("SELECT COUNT(*) n FROM llm_usage").get().n, calls);
});

test("tapping Approve in Telegram approves the post; strangers are ignored", async () => {
  const post = db.getItemFor(1, "2026-10-05", "post");
  tg.updates.push(
    { update_id: 10, callback_query: { id: "cbX", data: `r:${post.id}`, message: { chat: { id: 999 } } } }, // stranger: ignored
    { update_id: 11, callback_query: { id: "cb1", data: `a:${post.id}`, message: { chat: { id: 4242 } } } }
  );
  startPolling({
    approve: (id) => jobs.approve(id),
    reject: (id) => jobs.reject(id),
    regenerate: (id) => jobs.regenerate(id),
    command: async () => "ok",
  });
  // the item flips to approved just before the button tap is acknowledged; wait for both
  for (let i = 0; i < 250 && (db.getItem(post.id).status !== "approved" || !tg.answered.length); i++) await new Promise((r) => setTimeout(r, 20));
  stopPolling();
  assert.equal(db.getItem(post.id).status, "approved");
  assert.deepEqual(tg.answered.map((a) => a.callback_query_id), ["cb1"]);
  assert.equal(db.kvGet("telegram_offset"), 12);
});

test("pause from the API stops publishing", async () => {
  await fetch(`${base}/api/businesses/quarks/pause`, { method: "POST", headers: bearer });
  setNow(ist("2026-10-05", "09:05"));
  const r = await (await fetch(`${base}/api/jobs/publish`, { method: "POST", headers: bearer })).json();
  assert.match(r.result.quarks.skipped, /paused/);
  await fetch(`${base}/api/businesses/quarks/resume`, { method: "POST", headers: bearer });
  const r2 = await (await fetch(`${base}/api/jobs/publish`, { method: "POST", headers: bearer })).json();
  assert.equal(r2.result.quarks[0].published, db.getItemFor(1, "2026-10-05", "post").id);
});
