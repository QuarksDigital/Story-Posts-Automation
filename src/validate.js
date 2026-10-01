// Deterministic validation. Everything that can be checked with code is
// checked with code; nothing here calls an AI model.
import fs from "node:fs";
import sharp from "sharp";
import { LIMITS, POST_TEMPLATES, STORY_TEMPLATES } from "./content.js";

const STOP = new Set("a an the and or of to for in on at your you our we is are be with how why what that this it its from by as do not no".split(" "));
const tokens = (s) => new Set((s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w)));

export function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Emoji + pictographs + dingbats + variation selectors
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;
const HAS_EMOJI = new RegExp(EMOJI.source, "u"); // non-global: safe with .test()
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|in|io|co|org|net|ai|app|dev|me|xyz|info|biz|shop|store|site)(?:\/[^\s)]*)?/gi;
const MONEY = /(?:₹|rs\.?\s?\d|inr\s?\d|\$\s?\d|usd\s?\d|\d+\s?(?:rupees|lakh|crore|k\/month))/gi;
const OFFER = /\b(?:\d+\s?%\s?off|discount|coupon|promo code|limited[- ]time|free (?:trial|consultation|audit|website|quote)|offer ends|book now and get)\b/gi;
const STAT = /(?:\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?x\b|\b\d+\s?(?:times|percent)\b)/gi;

/** Every user-visible string in the generated content, with a label for messages. */
function visibleStrings(c) {
  const s = [
    ["topic", c.topic],
    ["hook", c.hook],
    ["post.eyebrow", c.post?.eyebrow],
    ["post.headline", c.post?.headline],
    ["post.subtext", c.post?.subtext],
    ["post.myth", c.post?.myth],
    ["post.fact", c.post?.fact],
    ["caption", c.caption],
    ["cta", c.cta],
    ["story.text", c.story?.text],
    ["story.subtext", c.story?.subtext],
    ["story.cta", c.story?.cta],
  ];
  (c.post?.points || []).forEach((p, i) => s.push([`post.points[${i}]`, p]));
  return s.filter(([, v]) => typeof v === "string" && v.length);
}

function mapStrings(c, fn) {
  const out = structuredClone(c);
  for (const k of ["topic", "angle", "hook", "caption", "cta", "visual_concept"]) if (typeof out[k] === "string") out[k] = fn(out[k]);
  for (const k of ["eyebrow", "headline", "subtext", "myth", "fact"]) if (typeof out.post?.[k] === "string") out.post[k] = fn(out.post[k]);
  if (out.post?.points) out.post.points = out.post.points.map(fn);
  for (const k of ["text", "subtext", "cta"]) if (typeof out.story?.[k] === "string") out.story[k] = fn(out.story[k]);
  return out;
}

/**
 * Auto-fixes what is safe to fix, then reports hard errors (trigger one AI
 * retry, then fallback) and warnings (shown in review, do not block).
 */
export function validateContent(input, biz, { history = [], allowedTemplates = POST_TEMPLATES, avoid = [] } = {}) {
  const { profile, strategy } = biz;
  const rules = profile.content_rules || {};
  const cap = strategy.caption || {};
  const errors = [];
  const warnings = [];
  const fixes = [];

  // ---- safe deterministic fixes ----
  let c = mapStrings(input, (s) => {
    let v = s.replace(/\r\n/g, "\n");
    if (!rules.use_em_dash && /[—–]/.test(v)) {
      v = v.replace(/\s*[—–]\s*/g, " - ");
      fixes.push("replaced em/en dashes");
    }
    if (!rules.use_emojis && HAS_EMOJI.test(v)) {
      v = v.replace(EMOJI, "").replace(/ {2,}/g, " ");
      fixes.push("removed emojis");
    }
    // exact business-name spelling
    const name = profile.business_name;
    if (name) v = v.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), name);
    return v.split("\n").map((l) => l.trimEnd()).join("\n").trim();
  });

  // hashtags: strip '#', lowercase, alnum only, dedupe, clamp, top up from pool
  const min = cap.hashtags_min ?? 3;
  const max = cap.hashtags_max ?? 8;
  let tags = [...new Set([...(cap.always_include_hashtags || []), ...(c.hashtags || [])].map((h) => norm(h)).filter(Boolean))];
  if (tags.length > max) (tags = tags.slice(0, max)), fixes.push(`trimmed hashtags to ${max}`);
  for (const p of cap.hashtag_pool || []) {
    if (tags.length >= min) break;
    if (!tags.includes(p)) tags.push(p);
  }
  c.hashtags = tags;
  if (/(^|\s)#[a-z0-9_]+/i.test(c.caption)) {
    c.caption = c.caption.replace(/(^|\s)#[a-z0-9_]+/gi, "").replace(/\n{3,}/g, "\n\n").trim();
    fixes.push("moved inline hashtags out of caption body");
  }

  // ---- required fields ----
  for (const [label, v] of [["topic", c.topic], ["post.headline", c.post?.headline], ["caption", c.caption], ["story.text", c.story?.text]]) {
    if (!v || !String(v).trim()) errors.push(`${label} is empty`);
  }

  // ---- templates and references to profile data ----
  const t = c.post?.template;
  if (!POST_TEMPLATES.includes(t)) errors.push(`unknown post template "${t}"`);
  else if (!allowedTemplates.includes(t)) errors.push(`template "${t}" is not allowed for pillar "${c.content_pillar}"; use one of ${allowedTemplates.join(", ")}`);
  if (!STORY_TEMPLATES.includes(c.story?.template)) errors.push(`unknown story template "${c.story?.template}"`);
  if (t === "service_spotlight" && !profile.services?.some((s) => s.id === c.post.service_id)) errors.push(`service_id "${c.post.service_id}" is not a listed service`);
  if (t === "case_study" && !profile.case_studies?.some((s) => s.id === c.post.case_id)) errors.push(`case_id "${c.post.case_id}" is not a listed case study`);
  if (t === "testimonial" && !profile.testimonials?.[c.post.testimonial_index]) errors.push("testimonial_index does not point at a listed testimonial");
  if (t === "list" && (c.post.points?.length ?? 0) < 2) errors.push("list template needs at least 2 points");
  if (t === "myth_fact" && (!c.post.myth || !c.post.fact)) errors.push("myth_fact template needs both myth and fact");

  // ---- lengths ----
  const lim = (label, v, n) => v && v.length > n && errors.push(`${label} is ${v.length} chars (max ${n})`);
  lim("post.eyebrow", c.post?.eyebrow, LIMITS.eyebrow);
  lim("post.headline", c.post?.headline, LIMITS.headline);
  lim("post.subtext", c.post?.subtext, LIMITS.subtext);
  lim("post.myth", c.post?.myth, LIMITS.myth);
  lim("post.fact", c.post?.fact, LIMITS.fact);
  (c.post?.points || []).forEach((p, i) => lim(`post.points[${i}]`, p, LIMITS.point));
  if ((c.post?.points?.length ?? 0) > LIMITS.points_max) errors.push(`too many points (max ${LIMITS.points_max})`);
  lim("story.text", c.story?.text, LIMITS.story_text);
  lim("story.subtext", c.story?.subtext, LIMITS.story_subtext);
  lim("story.cta", c.story?.cta, LIMITS.story_cta);
  const capMax = cap.max_chars || 900;
  if (c.caption.length > capMax) errors.push(`caption is ${c.caption.length} chars (max ${capMax})`);
  if (c.caption.length + c.hashtags.join(" #").length + 4 > 2200) errors.push("caption + hashtags exceed Instagram's 2200 char limit");

  // ---- fabricated business information ----
  const phoneDigits = (profile.phone || "").replace(/\D/g, "");
  const allowedEmails = [profile.email, ...(profile.allowed_emails || [])].filter(Boolean).map((e) => e.toLowerCase());
  const allowedUrls = [...(profile.allowed_urls || []), profile.website].filter(Boolean).map((u) => u.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, ""));
  const allowedMoney = (profile.prices || []).map((p) => String(p.text ?? p).toLowerCase());
  const allowedOffers = (profile.offers || []).map((o) => String(o.text ?? o).toLowerCase());
  const facts = [...(profile.verified_facts || []), ...(profile.case_studies || []).flatMap((cs) => cs.verified_results || [])].join(" ").toLowerCase();

  for (const [label, text] of visibleStrings(c)) {
    for (const m of text.match(EMAIL) || []) if (!allowedEmails.includes(m.toLowerCase())) errors.push(`${label}: email "${m}" is not in the business profile`);
    const withoutEmails = text.replace(EMAIL, " ");
    for (const m of withoutEmails.match(URL) || []) {
      const u = m.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
      if (!allowedUrls.some((a) => u === a || u.startsWith(a + "/") || a.startsWith(u))) errors.push(`${label}: URL "${m}" is not in the business profile`);
    }
    for (const m of text.match(PHONE) || []) {
      const d = m.replace(/\D/g, "");
      if (/^\d{4}-\d{2}-\d{2}$/.test(m.trim())) continue; // a date, not a phone
      if (d.length >= 8 && (!phoneDigits || !(phoneDigits.endsWith(d) || d.endsWith(phoneDigits)))) errors.push(`${label}: phone number "${m.trim()}" is not in the business profile`);
    }
    for (const m of text.match(MONEY) || []) if (!allowedMoney.some((p) => p.includes(m.toLowerCase().trim()))) errors.push(`${label}: price "${m.trim()}" is not in the business profile`);
    for (const m of text.match(OFFER) || []) if (!allowedOffers.some((o) => o.includes(m.toLowerCase()))) errors.push(`${label}: offer wording "${m}" but no matching offer exists in the profile`);
    if (!rules.allow_statistics) for (const m of text.match(STAT) || []) if (!facts.includes(m.toLowerCase())) errors.push(`${label}: statistic "${m}" is not a verified fact`);
    for (const p of profile.banned_phrases || []) if (text.toLowerCase().includes(p.toLowerCase())) errors.push(`${label}: banned phrase "${p}"`);
  }

  // ---- repetition against recent history ----
  for (const h of history) {
    if (h.topic && similarity(c.topic, h.topic) >= 0.6) errors.push(`topic too similar to ${h.date} "${h.topic}"`);
    if (h.hook && similarity(c.hook, h.hook) >= 0.7) errors.push(`hook too similar to ${h.date} "${h.hook}"`);
    if (h.headline && similarity(c.post.headline, h.headline) >= 0.7) errors.push(`headline too similar to ${h.date} "${h.headline}"`);
    if (h.story_text && similarity(c.story.text, h.story_text) >= 0.8) errors.push(`story text repeats ${h.date}`);
  }
  for (const a of avoid) if (similarity(c.topic, a) >= 0.6) errors.push(`topic is too close to rejected/replaced topic "${a}"`);
  const recentCtas = history.slice(0, 7).map((h) => norm(h.cta));
  if (c.cta && recentCtas.includes(norm(c.cta))) warnings.push(`CTA "${c.cta}" was used in the last 7 days`);
  const recentTemplates = history.slice(0, 2).map((h) => h.template);
  if (recentTemplates.length === 2 && recentTemplates.every((x) => x === t)) warnings.push(`template "${t}" used 3 days in a row`);

  return { ok: errors.length === 0, content: c, errors: [...new Set(errors)], warnings, fixes: [...new Set(fixes)] };
}

export const SIZES = { post: { width: 1080, height: 1350 }, story: { width: 1080, height: 1920 } };

/** Technical checks Instagram cares about: JPEG, exact size, < 8 MB, readable. */
export async function validateImage(file, type) {
  const errors = [];
  if (!file || !fs.existsSync(file)) return { ok: false, errors: [`image file missing: ${file}`] };
  const bytes = fs.statSync(file).size;
  if (bytes > 8 * 1024 * 1024) errors.push(`image is ${(bytes / 1e6).toFixed(1)} MB (max 8 MB)`);
  const meta = await sharp(file).metadata();
  if (meta.format !== "jpeg") errors.push(`image format is ${meta.format}, Instagram needs JPEG`);
  const want = SIZES[type];
  if (meta.width !== want.width || meta.height !== want.height) errors.push(`image is ${meta.width}x${meta.height}, expected ${want.width}x${want.height}`);
  return { ok: errors.length === 0, errors, bytes, width: meta.width, height: meta.height };
}
