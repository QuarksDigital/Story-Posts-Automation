// Live-mode publishing against a local fake of the Instagram Graph API that
// behaves like Meta's: it downloads image_url from our media server, checks it,
// reports IN_PROGRESS then FINISHED, and can inject errors.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import sharp from "sharp";
import { sandbox, ist } from "./helpers.js";

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const freePort = async () => {
  const s = http.createServer();
  const p = await listen(s);
  await new Promise((r) => s.close(r));
  return p;
};

const calls = [];
const fake = { failMedia: null, tokens: new Set(["TEST_TOKEN"]), statusPolls: {} };
const graph = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let body = "";
  for await (const c of req) body += c;
  const p = Object.fromEntries(new URLSearchParams(req.method === "GET" ? url.search : body));
  calls.push({ method: req.method, path: url.pathname, params: p });
  const json = (code, obj) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(obj)));

  if (url.pathname === "/refresh_access_token") {
    fake.tokens.add("NEW_TOKEN");
    return json(200, { access_token: "NEW_TOKEN", token_type: "bearer", expires_in: 5184000 });
  }
  if (!fake.tokens.has(p.access_token)) return json(400, { error: { message: "Error validating access token", type: "OAuthException", code: 190 } });
  const [, version, a, b] = url.pathname.split("/");
  assert.equal(version, "v23.0");

  if (req.method === "POST" && b === "media") {
    if (fake.failMedia) {
      const f = fake.failMedia;
      fake.failMedia = f.times > 1 ? { ...f, times: f.times - 1 } : null;
      return json(f.status, { error: { message: f.message, code: f.code } });
    }
    // Meta fetches the image itself: it must be public, JPEG, right size.
    const img = await fetch(p.image_url);
    if (!img.ok) return json(400, { error: { message: `Media download failed (${img.status})`, code: 9004, error_subcode: 2207052 } });
    assert.equal(img.headers.get("content-type"), "image/jpeg");
    const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
    if (p.media_type === "STORIES") {
      assert.equal(meta.height, 1920);
      assert.equal(p.caption, undefined, "stories carry no caption");
    } else {
      assert.equal(meta.height, 1350);
      assert.ok(p.caption?.includes("#"), "post caption includes hashtags");
    }
    const id = `container_${calls.length}`;
    fake.statusPolls[id] = 0;
    return json(200, { id });
  }
  if (req.method === "GET" && a?.startsWith("container_")) {
    const n = fake.statusPolls[a]++;
    return json(200, { id: a, status_code: n === 0 ? "IN_PROGRESS" : "FINISHED" });
  }
  if (req.method === "POST" && b === "media_publish") return json(200, { id: `media_${p.creation_id}` });
  if (req.method === "GET" && a?.startsWith("media_")) return json(200, { id: a, permalink: `https://www.instagram.com/p/${a}/` });
  if (req.method === "GET" && b === "content_publishing_limit") return json(200, { data: [{ quota_usage: 2, config: { quota_total: 100 } }] });
  if (req.method === "GET" && a === "1784") return json(200, { id: "1784", username: "quarksdigital" });
  return json(404, { error: { message: "unknown route", code: 100 } });
});

const graphPort = await listen(graph);
const enginePort = await freePort();
sandbox({
  env: {
    PUBLISH_MODE: "live",
    GRAPH_API_BASE: `http://127.0.0.1:${graphPort}`,
    GRAPH_API_VERSION: "v23.0",
    INSTAGRAM_ACCOUNT_ID: "1784",
    META_ACCESS_TOKEN: "TEST_TOKEN",
    PUBLIC_BASE_URL: `http://127.0.0.1:${enginePort}`,
    IG_PUBLISH_RETRIES: "2",
  },
  strategy: { approval_mode: false },
});
const { createServer } = await import("../src/server.js");
const jobs = await import("../src/jobs.js");
const db = await import("../src/db.js");
const { setNow } = await import("../src/time.js");
const { checkAccount, refreshTokenIfDue, credentials } = await import("../src/instagram.js");
const engine = createServer();
await new Promise((r) => engine.listen(enginePort, "127.0.0.1", r));
after(() => {
  engine.close();
  graph.close();
});

const date = "2026-10-05";
test("publishes the feed post: container -> poll -> media_publish -> permalink", async () => {
  setNow(ist(date, "07:45"));
  await jobs.tick();
  setNow(ist(date, "09:05"));
  await jobs.publishDue("quarks");
  const post = db.getItemFor(1, date, "post");
  assert.equal(post.status, "published", post.error);
  assert.match(post.instagram_media_id, /^media_container_/);
  assert.match(post.instagram_url, /^https:\/\/www\.instagram\.com\/p\//);
  assert.ok(calls.some((c) => c.path.endsWith("/media_publish")));
  assert.ok(calls.filter((c) => c.path.startsWith("/v23.0/container_")).length >= 2, "polled container status");
});

test("publishes the story with media_type=STORIES", async () => {
  setNow(ist(date, "19:05"));
  await jobs.publishDue("quarks");
  const story = db.getItemFor(1, date, "story");
  assert.equal(story.status, "published", story.error);
  assert.ok(calls.some((c) => c.params.media_type === "STORIES"));
});

test("transient Graph errors are retried and then succeed", async () => {
  const d = "2026-10-06";
  setNow(ist(d, "07:45"));
  await jobs.tick();
  fake.failMedia = { status: 500, code: 2, message: "Service temporarily unavailable", times: 2 };
  setNow(ist(d, "09:05"));
  await jobs.publishDue("quarks");
  const post = db.getItemFor(1, d, "post");
  assert.equal(post.status, "published", post.error);
  assert.equal(post.attempts, 3);
});

test("permanent errors are not retried; content is kept for manual publishing", async () => {
  const d = "2026-10-07";
  setNow(ist(d, "07:45"));
  await jobs.tick();
  fake.failMedia = { status: 400, code: 100, message: "Invalid parameter", times: 1 };
  const before = calls.filter((c) => c.path.endsWith("/media")).length;
  setNow(ist(d, "09:05"));
  await jobs.publishDue("quarks");
  const post = db.getItemFor(1, d, "post");
  assert.equal(post.status, "failed");
  assert.match(post.error, /Invalid parameter/);
  assert.equal(calls.filter((c) => c.path.endsWith("/media")).length - before, 1, "no retry on permanent error");
  assert.ok(post.creative_path && post.caption, "content kept");

  // owner retries manually from the review page / Telegram
  assert.match(await jobs.publishNow(post.id), /Published/);
  assert.equal(db.getItem(post.id).status, "published");
});

test("an expired token fails cleanly and the monitor reports it", async () => {
  fake.tokens.delete("TEST_TOKEN");
  const acct = await checkAccount("quarks");
  assert.equal(acct.ok, false);
  assert.match(acct.error, /access token/);
  setNow(ist("2026-10-07", "20:00"));
  const m = await jobs.monitor("quarks");
  assert.ok(m.issues.some((i) => /credentials problem/.test(i)));
  fake.tokens.add("TEST_TOKEN");
});

test("token refresh stores the new token and later calls use it", async () => {
  const { settings } = await import("../src/config.js");
  settings.instagram.tokenRefresh = "on"; // the fake host is not graph.instagram.com
  const r = await refreshTokenIfDue("quarks", { force: true });
  assert.equal(r.refreshed, true);
  assert.equal(r.expires_in_days, 60);
  assert.equal(credentials("quarks").token, "NEW_TOKEN");
  fake.tokens.delete("TEST_TOKEN"); // old token now invalid; only NEW_TOKEN works
  const acct = await checkAccount("quarks");
  assert.equal(acct.ok, true, acct.error);
  assert.equal(acct.username, "quarksdigital");
  assert.deepEqual(await refreshTokenIfDue("quarks"), { skipped: "refreshed recently" });
});

test("media URLs are public JPEGs but unguessable; traversal is blocked", async () => {
  const post = db.getItemFor(1, date, "post");
  const name = post.creative_path.split(/[\\/]/).pop();
  assert.match(name, /^2026-10-05-post-[0-9a-f]{10}\.jpg$/);
  const ok = await fetch(`http://127.0.0.1:${enginePort}/media/quarks/${name}`);
  assert.equal(ok.status, 200);
  const bad = await fetch(`http://127.0.0.1:${enginePort}/media/quarks/..%2F..%2Fautomation.db`);
  assert.equal(bad.status, 404);
});
