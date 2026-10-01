// Each test file runs in its own process: set env, then dynamic-import src/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Copies the real config into a temp dir, applies strategy overrides, points env at it. */
export function sandbox({ strategy = {}, profile = {}, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "igauto-"));
  fs.cpSync(path.join(ROOT, "config"), path.join(dir, "config"), { recursive: true });
  const bdir = path.join(dir, "config", "businesses", "quarks");
  const sfile = path.join(bdir, "strategy.json");
  const pfile = path.join(bdir, "business.json");
  fs.writeFileSync(sfile, JSON.stringify({ ...JSON.parse(fs.readFileSync(sfile, "utf8")), ...strategy }, null, 2));
  fs.writeFileSync(pfile, JSON.stringify({ ...JSON.parse(fs.readFileSync(pfile, "utf8")), ...profile }, null, 2));
  Object.assign(process.env, {
    CONFIG_DIR: path.join(dir, "config"),
    DATA_DIR: path.join(dir, "data"),
    LLM_PROVIDER: "mock",
    PUBLISH_MODE: "dry-run",
    QUIET_LOGS: "1",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
    ADMIN_TOKEN: "",
    IG_POLL_INTERVAL_MS: "5",
    IG_RETRY_DELAY_MS: "5",
    ...env,
  });
  return { dir, strategyFile: sfile, profileFile: pfile };
}

/** "2026-10-05" + "09:05" IST -> ISO UTC */
export const ist = (date, hhmm) => new Date(`${date}T${hhmm}:00+05:30`).toISOString();

/** A valid content object matching ContentSchema. */
export function goodContent(over = {}) {
  const base = {
    content_pillar: "Educational",
    topic: "Three checks before you redesign your website",
    angle: "Checklist",
    hook: "Before you redesign, check these three things.",
    visual_concept: "list card",
    post: { template: "list", eyebrow: "WEBSITE CHECK", headline: "Check these before a redesign", subtext: "", points: ["Where visitors drop off", "What people search to find you", "Which pages bring enquiries"], service_id: "", case_id: "", testimonial_index: -1, myth: "", fact: "" },
    caption: "Before you redesign, check these three things.\n\nA new look will not fix a page nobody can find.\n\nSave this for your next review.",
    hashtags: ["webdesign", "smallbusiness", "seo"],
    cta: "Save this for your next review",
    story: { template: "story_tip", text: "Look at your analytics before you redesign.", subtext: "", cta: "" },
  };
  return structuredClone({ ...base, ...over, post: { ...base.post, ...(over.post || {}) }, story: { ...base.story, ...(over.story || {}) } });
}
