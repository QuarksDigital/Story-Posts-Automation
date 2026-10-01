// End-to-end daily pipeline with the mock LLM and dry-run publishing,
// driven by a simulated clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sandbox, ist, goodContent } from "./helpers.js";

const { strategyFile } = sandbox({ strategy: { approval_mode: false } });
const jobs = await import("../src/jobs.js");
const db = await import("../src/db.js");
const { setNow } = await import("../src/time.js");
const { mockProvider } = await import("../src/llm/mock.js");
const { addDays } = await import("../src/time.js");

const at = async (date, hhmm, fn = jobs.tick) => {
  setNow(ist(date, hhmm));
  return fn();
};
const llmCalls = () => db.getDb().prepare("SELECT COUNT(*) n FROM llm_usage").get().n;

test("14 days: one post + one story published per day, no repeated topics, AI called at most twice a day", async () => {
  const start = "2026-10-05"; // a Monday
  for (let d = 0; d < 14; d++) {
    const date = addDays(start, d);
    const before = llmCalls();
    await at(date, "07:00"); // before generate_at: nothing should happen
    assert.equal(db.getItemFor(1, date, "post"), undefined, `${date}: generated too early`);
    await at(date, "07:45");
    await at(date, "08:30"); // extra ticks must not trigger extra AI calls
    await at(date, "09:05");
    await at(date, "19:05");
    const calls = llmCalls() - before;
    assert.ok(calls >= 1 && calls <= 2, `${date}: ${calls} AI calls`);
    for (const t of ["post", "story"]) {
      const i = db.getItemFor(1, date, t);
      assert.equal(i.status, "published", `${date} ${t}: ${i.status} ${i.error ?? ""}`);
    }
  }
  const posts = db.listItems({ limit: 100 }).filter((i) => i.content_type === "post");
  assert.equal(posts.length, 14);
  const topics = posts.map((p) => p.topic);
  assert.equal(new Set(topics).size, 14, "no topic repeated within 14 days");
  // the mock topic bank is smaller than 14 days for some pillars, so the fallback library must have kicked in
  assert.ok(posts.some((p) => p.source === "fallback"), "fallback path exercised");
  const pillars = new Set(posts.map((p) => p.content_pillar));
  assert.ok(pillars.size >= 6, `pillars rotate by weekday (${[...pillars].join(", ")})`);
});

test("invalid AI output is retried once with the validator's feedback", async () => {
  const date = "2026-11-02";
  const seen = [];
  let n = 0;
  mockProvider.override = (req) => {
    seen.push(req.user);
    n++;
    const data = n === 1 ? goodContent({ topic: "Retry test topic one", caption: "Call +91 99999 88888 now" }) : goodContent({ topic: "Retry test topic one" });
    return { data, model: "mock", inputTokens: 10, outputTokens: 10 };
  };
  let r;
  try {
    r = await at(date, "07:45", () => jobs.planDay("quarks"));
  } finally {
    mockProvider.override = null;
  }
  assert.equal(r.source, "ai");
  assert.equal(n, 2);
  assert.match(seen[1], /failed validation[\s\S]*phone number/);
});

test("AI failing twice falls back to the evergreen library", async () => {
  const date = "2026-11-03";
  mockProvider.override = () => {
    throw new Error("API down");
  };
  let r;
  try {
    r = await at(date, "07:45", () => jobs.planDay("quarks"));
  } finally {
    mockProvider.override = null;
  }
  assert.equal(r.source, "fallback");
  assert.ok(db.recentEvents({ level: "error" }).some((e) => /API down/.test(e.message)));
});

test("pause, skip and the 'automation_enabled' switch stop generation", async () => {
  jobs.setPaused("quarks", true);
  assert.match((await at("2026-11-04", "07:45", () => jobs.planDay("quarks"))).skipped, /paused/);
  jobs.setPaused("quarks", false);

  jobs.skipDay("quarks", "2026-11-05");
  assert.match((await at("2026-11-05", "07:45", () => jobs.planDay("quarks"))).skipped, /skipped/);

  const s = JSON.parse(fs.readFileSync(strategyFile, "utf8"));
  fs.writeFileSync(strategyFile, JSON.stringify({ ...s, automation_enabled: false }));
  assert.match((await at("2026-11-06", "07:45", () => jobs.planDay("quarks"))).skipped, /automation_enabled/);
  fs.writeFileSync(strategyFile, JSON.stringify(s));
});

test("approval mode: nothing publishes until approved; unapproved content is marked missed after the window", async () => {
  const s = JSON.parse(fs.readFileSync(strategyFile, "utf8"));
  fs.writeFileSync(strategyFile, JSON.stringify({ ...s, approval_mode: true }));
  const date = "2026-11-09";
  await at(date, "07:45");
  const post = db.getItemFor(1, date, "post");
  const story = db.getItemFor(1, date, "story");
  assert.equal(post.status, "pending_approval");

  await at(date, "09:05");
  assert.equal(db.getItem(post.id).status, "pending_approval", "not published without approval");

  await jobs.approve(post.id);
  await at(date, "09:10");
  assert.equal(db.getItem(post.id).status, "published");

  await at(date, "23:59"); // story slot 19:00 + 6h window not yet over
  assert.equal(db.getItem(story.id).status, "pending_approval");
  await at(addDays(date, 1), "01:05");
  assert.equal(db.getItem(story.id).status, "missed");
  fs.writeFileSync(strategyFile, JSON.stringify(s));
});

test("regenerate makes a new version; manual edits re-render with no AI call", async () => {
  const date = "2026-11-11";
  await at(date, "07:45");
  const post = db.getItemFor(1, date, "post");
  const before = llmCalls();
  await jobs.editItem(post.id, { caption: "Edited by the owner.", fields: { headline: "Owner headline" } });
  assert.equal(llmCalls(), before, "edit must not call the AI");
  const edited = db.getItem(post.id);
  assert.equal(edited.caption, "Edited by the owner.");
  assert.equal(edited.fields.headline, "Owner headline");
  assert.notEqual(edited.creative_path, post.creative_path, "re-rendered");
  assert.ok(!fs.existsSync(post.creative_path), "old render removed");

  await jobs.regenerate(post.id);
  const regen = db.getItem(post.id);
  assert.notEqual(regen.topic, post.topic);
  assert.equal(llmCalls() >= before + 1, true);
});

test("published items cannot be edited, rejected or regenerated", async () => {
  const pub = db.listItems({ statuses: ["published"], limit: 1 })[0];
  assert.match(await jobs.reject(pub.id), /already published/);
  assert.match(await jobs.regenerate(pub.id), /already published/);
  await assert.rejects(jobs.editItem(pub.id, { caption: "x" }), /already published/);
});

test("monitor reports missing content and failures once per day", async () => {
  const date = "2026-11-20";
  jobs.skipDay("quarks", "2026-11-19"); // keep the previous days quiet
  setNow(ist(date, "10:00"));
  const r1 = await jobs.monitor("quarks");
  assert.ok(r1.issues.some((x) => /No post was generated/.test(x)));
  assert.ok(r1.notified > 0);
  const r2 = await jobs.monitor("quarks");
  assert.equal(r2.notified, 0, "same issue not re-sent the same day");
});

test("cleanup removes old draft files but keeps rows", async () => {
  setNow(ist("2027-01-30", "12:00"));
  const r = await jobs.cleanup("quarks");
  assert.ok(r.removed > 0);
  const stale = db.listItems({ limit: 500 }).filter((i) => i.status !== "published" && i.date < "2027-01-16" && i.creative_path);
  assert.equal(stale.length, 0);
  assert.ok(db.listItems({ limit: 500 }).length > 20, "rows kept for history");
});
