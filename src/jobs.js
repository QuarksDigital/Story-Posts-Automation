// The daily pipeline. Every job is idempotent: n8n (or the internal ticker)
// can call it as often as it likes and it only acts when something is due.
// AI is called once per day per business (plus once per manual "regenerate").
import fs from "node:fs";
import path from "node:path";
import { loadBusiness, listBusinesses, settings } from "./config.js";
import * as db from "./db.js";
import { generate } from "./llm/index.js";
import { ContentSchema, POST_TEMPLATES, buildPrompt, assembleCaption } from "./content.js";
import { validateContent, validateImage } from "./validate.js";
import { renderCreative, mediaDir, mediaUrl } from "./render/index.js";
import { publishImage, checkAccount, refreshTokenIfDue, credentials } from "./instagram.js";
import { notify, approvalButtons } from "./telegram.js";
import { localDate, localWeekday, zonedTime, addDays, now } from "./time.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = () => now().toISOString();

// One job at a time: scheduler, n8n and the review UI may overlap.
let chain = Promise.resolve();
export function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

export function ctx(slug) {
  const biz = loadBusiness(slug);
  biz.instagramAccountId = credentials(slug).accountId;
  biz.id = db.ensureBusiness(biz);
  biz.tz = biz.strategy.timezone || "Asia/Kolkata";
  biz.today = localDate(now(), biz.tz);
  return biz;
}

const ctxForItem = (item) => ctx(db.businessSlug(item.business_id));

function fmtTime(isoStr, tz) {
  return new Date(isoStr).toLocaleString("en-IN", { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function reviewUrl() {
  return `${settings.publicBaseUrl}/`;
}

function inactiveReason(biz, date) {
  if (biz.strategy.automation_enabled === false) return "automation_enabled is false in strategy.json";
  if (db.kvGet(`paused:${biz.slug}`)) return "automation is paused";
  const skips = [...(biz.strategy.skip_dates || []), ...(db.kvGet(`skip:${biz.slug}`) || [])];
  if (skips.includes(date)) return `${date} is marked as skipped`;
  return null;
}

/** Last N days of content, one row per date, newest first. */
function recentHistory(biz, date) {
  const since = addDays(date, -(biz.strategy.history_days || 30));
  const items = db.listItems({ businessId: biz.id, since, limit: 400 }).filter((i) => i.date < date && i.status !== "rejected");
  const byDate = {};
  for (const i of items) {
    const h = (byDate[i.date] ??= { date: i.date });
    if (i.content_type === "post") Object.assign(h, { pillar: i.content_pillar, topic: i.topic, hook: i.hook, headline: i.fields?.headline, template: i.template, cta: i.cta });
    else h.story_text = i.fields?.text;
  }
  return Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date));
}

function rejectedTopics(biz, date) {
  return db
    .listItems({ businessId: biz.id, since: addDays(date, -30), statuses: ["rejected"], limit: 100 })
    .map((i) => i.topic)
    .filter(Boolean);
}

/** One AI call -> validate -> (one corrected retry) -> fallback library. */
async function createContent(biz, date, extraAvoid = []) {
  const weekday = localWeekday(date);
  const pillar = biz.strategy.weekly_calendar?.[weekday] || Object.keys(biz.strategy.pillars)[0];
  const history = recentHistory(biz, date);
  const avoid = [...new Set([...rejectedTopics(biz, date), ...extraAvoid])];
  let feedback = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const { system, user, allowedTemplates } = buildPrompt({ biz, date, weekday, pillar, history, avoid, feedback });
    try {
      const { data, usage } = await generate({ system, user, schema: ContentSchema, businessId: biz.id, context: { pillar, allowedTemplates, history, avoid } });
      db.logEvent({ businessId: biz.id, kind: "plan", message: `AI attempt ${attempt}: ${usage.inputTokens} in / ${usage.outputTokens} out tokens, $${usage.costUsd.toFixed(4)}` });
      const v = validateContent({ ...data, content_pillar: pillar }, biz, { history, allowedTemplates, avoid });
      if (v.ok) return { content: v.content, source: "ai", warnings: [...v.warnings, ...v.fixes.map((f) => `auto-fixed: ${f}`)] };
      feedback = v.errors;
      db.logEvent({ businessId: biz.id, level: "warn", kind: "validate", message: `AI attempt ${attempt} failed validation`, data: v.errors });
    } catch (e) {
      feedback = [];
      db.logEvent({ businessId: biz.id, level: "error", kind: "plan", message: `AI attempt ${attempt} failed: ${e.message}` });
    }
  }

  // Fallback: curated evergreen content that still passes validation today.
  const ranked = [...biz.fallbacks].sort((a, b) => (b.content_pillar === pillar) - (a.content_pillar === pillar));
  for (const fb of ranked) {
    const v = validateContent(fb, biz, { history, allowedTemplates: POST_TEMPLATES, avoid });
    if (v.ok) return { content: v.content, source: "fallback", warnings: ["AI generation failed twice; used fallback content", ...v.warnings] };
  }
  throw new Error("AI generation failed and every fallback item was used recently. Add more to fallback.json.");
}

function rowsFor(biz, date, { content: c, source, warnings }) {
  const s = biz.strategy.schedule;
  // planning late (e.g. after downtime) should not instantly push slots out of the publish window
  const slot = (hhmm) => new Date(Math.max(zonedTime(date, hhmm, biz.tz).getTime(), now().getTime())).toISOString();
  const common = { business_id: biz.id, date, content_pillar: c.content_pillar, topic: c.topic, angle: c.angle, hook: c.hook, source, validation: warnings, status: "planned" };
  return {
    post: { ...common, content_type: "post", template: c.post.template, fields: c.post, caption: c.caption, hashtags: c.hashtags, cta: c.cta, scheduled_at: slot(s.post_at) },
    story: { ...common, content_type: "story", template: c.story.template, fields: c.story, caption: null, hashtags: [], cta: c.story.cta || null, scheduled_at: slot(s.story_at) },
  };
}

// ---------------------------------------------------------------- jobs

/** Workflow 1: pick pillar, read history, one AI call, save the day's plan. */
export async function planDay(slug, { date, force = false } = {}) {
  const biz = ctx(slug);
  date ??= biz.today;
  const inactive = inactiveReason(biz, date);
  if (inactive) return { skipped: inactive };

  const existing = ["post", "story"].map((t) => db.getItemFor(biz.id, date, t)).filter(Boolean);
  if (existing.length && !force) return { skipped: "already planned", items: existing.map((i) => i.id) };
  const replaceable = existing.filter((i) => !["published", "publishing"].includes(i.status));
  const types = ["post", "story"].filter((t) => !existing.some((i) => i.content_type === t) || replaceable.some((i) => i.content_type === t));
  if (!types.length) return { skipped: "both items already published" };

  const failKey = `plan_failed:${slug}:${date}`;
  if (!force && db.kvGet(failKey)) return { skipped: "generation already failed today; use 'Replace today' to retry manually" };
  let result;
  try {
    result = await createContent(biz, date);
  } catch (e) {
    // Without this guard every scheduler tick would pay for two more AI calls.
    db.kvSet(failKey, iso());
    await notify(`Content generation failed for ${date}.
Reason: ${e.message}
Action required: fix the cause, then use "Replace today" on ${reviewUrl()}`);
    throw e;
  }
  db.kvSet(failKey, null);
  const rows = rowsFor(biz, date, result);
  const ids = [];
  for (const t of types) {
    const old = replaceable.find((i) => i.content_type === t);
    if (old) {
      removeFile(old.creative_path);
      db.deleteItem(old.id);
    }
    ids.push(db.insertItem(rows[t]).id);
  }
  db.logEvent({ businessId: biz.id, kind: "plan", message: `Planned ${date} (${result.source}): ${result.content.topic}` });
  if (result.source === "fallback") await notify(`Content generation fell back to the evergreen library for ${date}.\nTopic: ${result.content.topic}\nAction: check the AI provider / API key.`);
  return { planned: ids, source: result.source, topic: result.content.topic };
}

/** Workflows 2 + 3: render the planned post or story, validate the file, queue it. */
export async function generateItem(slug, type, { date } = {}) {
  const biz = ctx(slug);
  date ??= biz.today;
  const item = db.getItemFor(biz.id, date, type);
  if (!item) return { skipped: "nothing planned" };
  if (item.status !== "planned") return { skipped: `status is ${item.status}` };
  return renderAndQueue(biz, item);
}

async function renderAndQueue(biz, item) {
  try {
    const file = await renderCreative(biz, { template: item.template, fields: item.fields, date: item.date, type: item.content_type });
    const img = await validateImage(file, item.content_type);
    if (!img.ok) throw new Error(img.errors.join("; "));
    if (item.creative_path && item.creative_path !== file) removeFile(item.creative_path);
    const approval = biz.strategy.approval_mode !== false;
    const updated = db.updateItem(item.id, { creative_path: file, status: approval ? "pending_approval" : "approved", error: null, notified_at: null });
    db.logEvent({ businessId: biz.id, itemId: item.id, kind: "render", message: `Rendered ${item.content_type} ${item.date} (${item.template}) -> ${path.basename(file)}` });
    if (approval) await sendPreview(biz, updated);
    return { rendered: item.id, status: updated.status, file };
  } catch (e) {
    db.updateItem(item.id, { status: "failed", error: `render: ${e.message}` });
    db.logEvent({ businessId: biz.id, itemId: item.id, level: "error", kind: "render", message: e.message });
    await notify(`Rendering failed.\n\nType: ${item.content_type.toUpperCase()} (${item.date})\nReason: ${e.message}\nAction required: manual review\n${reviewUrl()}`);
    return { failed: item.id, error: e.message };
  }
}

async function sendPreview(biz, item) {
  const lines = [
    `${item.content_type.toUpperCase()} for ${fmtTime(item.scheduled_at, biz.tz)}${item.source === "fallback" ? " (fallback content)" : ""}`,
    `Pillar: ${item.content_pillar}`,
    `Topic: ${item.topic}`,
  ];
  if (item.content_type === "post") lines.push("", assembleCaption(item.caption, item.hashtags));
  const warn = (item.validation || []).filter((w) => !w.startsWith("auto-fixed"));
  if (warn.length) lines.push("", `Notes: ${warn.join("; ")}`);
  lines.push("", `Review/edit: ${reviewUrl()}`);
  await notify(lines.join("\n"), { photo: item.creative_path, buttons: approvalButtons(item.id) });
}

/** Workflow 4: publish anything approved whose time has come. */
export async function publishDue(slug) {
  const biz = ctx(slug);
  const t = now().getTime();
  if (db.kvGet(`paused:${biz.slug}`) || biz.strategy.automation_enabled === false) return { skipped: "automation paused/disabled" };
  const windowMs = (biz.strategy.schedule.publish_window_hours ?? 6) * 3600_000;
  const results = [];
  const candidates = db.listItems({ businessId: biz.id, since: addDays(biz.today, -2), statuses: ["approved", "pending_approval"] });
  for (const item of candidates.reverse()) {
    const due = Date.parse(item.scheduled_at);
    if (due > t) continue;
    if (t - due > windowMs) {
      db.updateItem(item.id, { status: "missed", error: `not ${item.status === "approved" ? "published" : "approved"} within ${windowMs / 3600_000}h of its slot` });
      await notify(`${item.content_type.toUpperCase()} for ${item.date} missed its slot (${item.status === "pending_approval" ? "never approved" : "not published"}). Content is kept; use "Publish now" in the review page if you still want it.\n${reviewUrl()}`);
      results.push({ missed: item.id });
      continue;
    }
    if (item.status === "pending_approval") {
      if (!item.notified_at) {
        await notify(`${item.content_type.toUpperCase()} for ${item.date} is due but still waiting for approval.`, { buttons: approvalButtons(item.id) });
        db.updateItem(item.id, { notified_at: iso() });
      }
      results.push({ waiting: item.id });
      continue;
    }
    results.push(await publishItem(biz, item));
  }
  return results;
}

/** Publishes one item now, with a small bounded retry. */
export async function publishItem(biz, item) {
  const img = await validateImage(item.creative_path, item.content_type);
  if (!img.ok) {
    db.updateItem(item.id, { status: "failed", error: img.errors.join("; ") });
    await notify(`Instagram publishing failed.\n\nType: ${item.content_type.toUpperCase()}\nReason: ${img.errors.join("; ")}\nAction required: manual review\n${reviewUrl()}`);
    return { failed: item.id, error: img.errors.join("; ") };
  }
  db.updateItem(item.id, { status: "publishing" });
  const caption = item.content_type === "post" ? assembleCaption(item.caption, item.hashtags) : undefined;
  const imageUrl = mediaUrl(biz.slug, item.creative_path);

  if (settings.instagram.mode !== "live") {
    db.updateItem(item.id, { status: "published", published_at: iso(), instagram_media_id: "dry-run", instagram_url: null, error: null });
    db.logEvent({ businessId: biz.id, itemId: item.id, kind: "publish", message: `[dry-run] would publish ${item.content_type} ${imageUrl}` });
    await notify(`[DRY RUN] ${item.content_type.toUpperCase()} for ${item.date} would be published now.\n${imageUrl}`);
    return { published: item.id, dryRun: true, imageUrl };
  }

  const tries = 1 + settings.instagram.publishRetries;
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const r = await publishImage({ slug: biz.slug, type: item.content_type, imageUrl, caption });
      db.updateItem(item.id, {
        status: "published",
        published_at: iso(),
        attempts: item.attempts + attempt,
        instagram_container_id: r.containerId,
        instagram_media_id: r.mediaId,
        instagram_url: r.permalink,
        error: null,
      });
      db.logEvent({ businessId: biz.id, itemId: item.id, kind: "publish", message: `Published ${item.content_type} ${item.date}: ${r.mediaId}` });
      await notify(`Published ${item.content_type} for ${item.date}.${r.permalink ? "\n" + r.permalink : ""}`);
      return { published: item.id, mediaId: r.mediaId, permalink: r.permalink };
    } catch (e) {
      lastErr = e;
      db.logEvent({ businessId: biz.id, itemId: item.id, level: "warn", kind: "publish", message: `Attempt ${attempt}/${tries}: ${e.message}` });
      if (!e.transient || attempt === tries) break;
      await sleep(settings.instagram.retryDelayMs * attempt);
    }
  }
  db.updateItem(item.id, { status: "failed", attempts: item.attempts + tries, error: lastErr.message });
  db.logEvent({ businessId: biz.id, itemId: item.id, level: "error", kind: "publish", message: lastErr.message });
  await notify(`Instagram publishing failed.\n\nType: ${item.content_type.toUpperCase()} (${item.date})\nReason: ${lastErr.message}\nAction required: manual review. The content is saved; retry or download it from ${reviewUrl()}`);
  return { failed: item.id, error: lastErr.message };
}

/** Workflow 5: only notifies when someone needs to act. */
export async function monitor(slug) {
  const biz = ctx(slug);
  const issues = [];
  const s = biz.strategy.schedule;

  const inactive = inactiveReason(biz, biz.today);
  const genDeadline = zonedTime(biz.today, s.generate_at, biz.tz).getTime() + 45 * 60_000;
  if (!inactive && now().getTime() > genDeadline) {
    for (const t of ["post", "story"]) if (!db.getItemFor(biz.id, biz.today, t)) issues.push(`No ${t} was generated for today (${biz.today}). Is the scheduler running?`);
  }

  for (const i of db.listItems({ businessId: biz.id, since: addDays(biz.today, -3), statuses: ["failed"] })) {
    issues.push(`${i.content_type} ${i.date} failed: ${i.error}`);
  }

  const stuck = db.listItems({ businessId: biz.id, since: addDays(biz.today, -3), statuses: ["publishing"] }).filter((i) => now() - Date.parse(i.updated_at) > 30 * 60_000);
  for (const i of stuck) {
    db.updateItem(i.id, { status: "failed", error: "Stuck in 'publishing' (process restarted mid-publish). Check Instagram before retrying to avoid a duplicate." });
    issues.push(`${i.content_type} ${i.date} was interrupted while publishing. Check Instagram before retrying.`);
  }

  if (settings.instagram.mode === "live") {
    const acct = await checkAccount(slug);
    if (!acct.ok) issues.push(`Instagram credentials problem: ${acct.error}`);
    else {
      try {
        const r = await refreshTokenIfDue(slug);
        if (r.refreshed) db.logEvent({ businessId: biz.id, kind: "token", message: `Instagram token refreshed (valid ${r.expires_in_days} days)` });
      } catch (e) {
        issues.push(`Instagram token refresh failed: ${e.message}`);
      }
    }
  }

  const bytes = dirSize(mediaDir(biz.slug));
  if (bytes > 2 * 1024 ** 3) issues.push(`Media folder is ${(bytes / 1024 ** 3).toFixed(1)} GB; lower retention in strategy.json.`);

  // Same issue is reported at most once a day.
  const sentKey = `alerts:${biz.slug}:${biz.today}`;
  const sent = new Set(db.kvGet(sentKey) || []);
  const fresh = issues.filter((x) => !sent.has(x));
  if (fresh.length) {
    await notify(`Action required (${biz.profile.business_name}):\n\n- ${fresh.join("\n- ")}\n\n${reviewUrl()}`);
    db.kvSet(sentKey, [...sent, ...fresh]);
  }
  db.kvSet(`last_monitor:${biz.slug}`, iso());
  return { issues, notified: fresh.length };
}

/** Deletes old drafts/rejected files and very old published files (rows are kept). */
export async function cleanup(slug) {
  const biz = ctx(slug);
  const r = biz.strategy.retention || {};
  const draftCut = addDays(biz.today, -(r.drafts_days ?? 14));
  const pubCut = addDays(biz.today, -(r.published_days ?? 365));
  let removed = 0;
  for (const i of db.listItems({ businessId: biz.id, limit: 100000 })) {
    if (!i.creative_path) continue;
    const old = i.status === "published" ? i.date < pubCut : i.date < draftCut && i.status !== "publishing";
    if (old && removeFile(i.creative_path)) {
      db.updateItem(i.id, { creative_path: null });
      removed++;
    }
  }
  // orphans (e.g. replaced renders) older than a day
  const referenced = new Set(db.listItems({ businessId: biz.id, limit: 100000 }).map((i) => i.creative_path && path.basename(i.creative_path)));
  const dir = mediaDir(biz.slug);
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (!referenced.has(f) && now() - fs.statSync(p).mtimeMs > 86400_000) (fs.rmSync(p), removed++);
  }
  db.kvSet(`last_cleanup:${biz.slug}`, iso());
  return { removed };
}

/** Everything due, for every business. Safe to call every minute. */
export async function tick() {
  const out = {};
  for (const slug of listBusinesses()) {
    const r = {};
    try {
      const biz = ctx(slug);
      if (now() >= zonedTime(biz.today, biz.strategy.schedule.generate_at, biz.tz)) r.plan = await planDay(slug);
      r.post = await generateItem(slug, "post");
      r.story = await generateItem(slug, "story");
      r.publish = await publishDue(slug);
      const lastMon = Date.parse(db.kvGet(`last_monitor:${slug}`) || 0);
      if (now() - lastMon > 3600_000) r.monitor = await monitor(slug);
      const lastClean = Date.parse(db.kvGet(`last_cleanup:${slug}`) || 0);
      if (now() - lastClean > 86400_000) r.cleanup = await cleanup(slug);
    } catch (e) {
      r.error = e.message;
      db.logEvent({ level: "error", kind: "system", message: `tick ${slug}: ${e.message}` });
      const key = `tick_error:${slug}:${e.message}`;
      if (!db.kvGet(key)) (await notify(`Automation error for ${slug}: ${e.message}`), db.kvSet(key, iso()));
    }
    out[slug] = r;
  }
  db.kvSet("heartbeat", iso());
  return out;
}

// ---------------------------------------------------------------- manual control

export async function approve(id) {
  const item = mustGet(id);
  if (!["pending_approval", "failed", "rejected", "missed", "skipped"].includes(item.status)) return `Item ${id} is ${item.status}; nothing to approve.`;
  if (!item.creative_path) throw new Error("No creative rendered yet");
  db.updateItem(id, { status: "approved", error: null, notified_at: null });
  const biz = ctxForItem(item);
  const late = Date.parse(item.scheduled_at) <= now().getTime();
  return `Approved ${item.content_type} for ${item.date}. ${late ? "Publishing on the next run." : `Scheduled for ${fmtTime(item.scheduled_at, biz.tz)}.`}`;
}

export async function reject(id) {
  const item = mustGet(id);
  if (["published", "publishing"].includes(item.status)) return `Item ${id} is already ${item.status}.`;
  db.updateItem(id, { status: "rejected" });
  return `Rejected ${item.content_type} for ${item.date}. Use Regenerate for a new version, or leave it to skip.`;
}

export async function regenerate(id) {
  const item = mustGet(id);
  if (["published", "publishing"].includes(item.status)) return `Item ${id} is already ${item.status}.`;
  const biz = ctxForItem(item);
  const result = await createContent(biz, item.date, [item.topic]);
  const row = rowsFor(biz, item.date, result)[item.content_type];
  const { business_id, date, content_type, scheduled_at, ...patch } = row;
  const updated = db.updateItem(id, { ...patch, attempts: 0, error: null, notified_at: null });
  const r = await renderAndQueue(biz, updated);
  if (r.failed) throw new Error(r.error);
  return `Regenerated ${item.content_type} for ${item.date}: ${result.content.topic}${result.source === "fallback" ? " (fallback)" : ""}`;
}

/** Owner edits (caption/hashtags/template fields). Re-renders when fields change; no AI call. */
export async function editItem(id, { caption, hashtags, fields }) {
  const item = mustGet(id);
  if (["published", "publishing"].includes(item.status)) throw new Error(`Item ${id} is already ${item.status}`);
  const biz = ctxForItem(item);
  const patch = {};
  if (typeof caption === "string") patch.caption = caption.trim();
  if (hashtags) patch.hashtags = (Array.isArray(hashtags) ? hashtags : String(hashtags).split(/[\s,]+/)).map((h) => h.replace(/^#/, "").toLowerCase()).filter(Boolean);
  const fieldsChanged = fields && JSON.stringify({ ...item.fields, ...fields }) !== JSON.stringify(item.fields);
  if (fieldsChanged) patch.fields = { ...item.fields, ...fields };

  // owner text is trusted, but run the same deterministic checks and surface them
  const probe = item.content_type === "post"
    ? { ...item, post: patch.fields || item.fields, story: { template: "story_tip", text: "x" }, caption: patch.caption ?? item.caption, hashtags: patch.hashtags ?? item.hashtags }
    : { ...item, post: { template: "tip", headline: "x" }, story: patch.fields || item.fields, caption: "x", hashtags: [] };
  const v = validateContent(probe, biz, { allowedTemplates: POST_TEMPLATES });
  patch.validation = ["edited manually", ...v.errors.map((e) => `check: ${e}`)];
  patch.source = "manual";

  const updated = db.updateItem(id, patch);
  if (fieldsChanged) {
    const r = await renderAndQueue(biz, { ...updated, status: "planned" });
    if (r.failed) throw new Error(r.error);
  }
  return `Saved changes to ${item.content_type} ${item.date}${v.errors.length ? ` (${v.errors.length} check warnings)` : ""}.`;
}

export async function publishNow(id) {
  const item = mustGet(id);
  if (["published", "publishing"].includes(item.status)) return `Item ${id} is already ${item.status}.`;
  if (!item.creative_path) throw new Error("No creative rendered yet");
  const biz = ctxForItem(item);
  const r = await publishItem(biz, db.updateItem(id, { status: "approved" }));
  return r.published ? `Published ${item.content_type} for ${item.date}${r.dryRun ? " (dry run)" : ""}.` : `Publish failed: ${r.error}`;
}

export function skipDay(slug, date) {
  const biz = ctx(slug);
  date ??= biz.today;
  const key = `skip:${slug}`;
  db.kvSet(key, [...new Set([...(db.kvGet(key) || []), date])]);
  for (const t of ["post", "story"]) {
    const i = db.getItemFor(biz.id, date, t);
    if (i && !["published", "publishing"].includes(i.status)) db.updateItem(i.id, { status: "skipped" });
  }
  return `Skipping ${date} for ${slug}.`;
}

export function unskipDay(slug, date) {
  const key = `skip:${slug}`;
  db.kvSet(key, (db.kvGet(key) || []).filter((d) => d !== date));
  return `${date} is no longer skipped (use Plan to generate content).`;
}

export function setPaused(slug, paused) {
  db.kvSet(`paused:${slug}`, paused);
  return paused ? `Automation paused for ${slug}. Nothing will be generated or published.` : `Automation resumed for ${slug}.`;
}

export function status() {
  const month = now().toISOString().slice(0, 7) + "-01T00:00:00.000Z";
  const usage = db.usageSince(month);
  const businesses = listBusinesses().map((slug) => {
    const biz = ctx(slug);
    return {
      slug,
      today: biz.today,
      paused: Boolean(db.kvGet(`paused:${slug}`)),
      enabled: biz.strategy.automation_enabled !== false,
      approval_mode: biz.strategy.approval_mode !== false,
      schedule: biz.strategy.schedule,
      items: db.listItems({ businessId: biz.id, since: addDays(biz.today, -6) }).map((i) => ({
        id: i.id, date: i.date, type: i.content_type, status: i.status, topic: i.topic, template: i.template, source: i.source,
        scheduled_at: i.scheduled_at, instagram_url: i.instagram_url, error: i.error,
      })),
    };
  });
  return {
    publish_mode: settings.instagram.mode,
    llm: { provider: settings.llm.provider, model: settings.llm.model || (settings.llm.provider === "anthropic" ? "claude-opus-5-5" : "") },
    llm_cost_this_month: { ...usage, cost_inr: Math.round(usage.cost_usd * settings.llm.usdToInr * 100) / 100 },
    heartbeat: db.kvGet("heartbeat") || null,
    businesses,
    recent_errors: db.recentEvents({ level: "error", limit: 10 }),
  };
}

function mustGet(id) {
  const item = db.getItem(Number(id));
  if (!item) throw new Error(`No content item ${id}`);
  return item;
}

function removeFile(p) {
  try {
    if (p && fs.existsSync(p)) {
      fs.rmSync(p);
      return true;
    }
  } catch {
    // best effort
  }
  return false;
}

function dirSize(dir) {
  return fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
}
