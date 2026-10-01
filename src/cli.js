// Command line for local testing and manual control.
//   npm run cli -- <command> [--business quarks] [--date YYYY-MM-DD] [--now ISO] [--force]
import { listBusinesses, loadBusiness } from "./config.js";
import * as jobs from "./jobs.js";
import { setNow } from "./time.js";
import { renderCreative } from "./render/index.js";
import { checkAccount, refreshTokenIfDue } from "./instagram.js";
import { notify } from "./telegram.js";
import { closeDb, getDb } from "./db.js";
import { settings } from "./config.js";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const positional = [];
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    const k = argv[i].slice(2);
    flags[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  } else positional.push(argv[i]);
}
if (flags.now) setNow(flags.now);
const business = flags.business || listBusinesses()[0];

const SAMPLES = {
  tip: { eyebrow: "WEBSITE CHECK", headline: "Write your homepage for a stranger", subtext: "If someone who has never heard of you cannot tell what you do in one line, rewrite it." },
  list: { eyebrow: "EDUCATIONAL", headline: "5 website mistakes that cost you customers", points: ["No clear headline about what you do", "Contact details buried in the footer", "Slow pages on mobile data", "No single next step for the visitor", "Stock photos instead of your real work"] },
  service_spotlight: { eyebrow: "SERVICE", service_id: "automation", headline: "Stop copying data between spreadsheets", subtext: "Lead routing, CRM sync and reports that run themselves.", points: [] },
  question: { eyebrow: "YOUR TURN", headline: "Which weekly task would you hand to software first?", subtext: "Tell us in the comments." },
  insight: { eyebrow: "INDUSTRY INSIGHT", headline: "Good products lose to worse products with better distribution.", subtext: "Design how you get found at the same time as what you build." },
  myth_fact: { eyebrow: "SEO", headline: "SEO is not a setup task", myth: "SEO is something you set up once when the site launches.", fact: "Rankings follow ongoing work: technical fixes, useful content and earned links." },
  case_study: { eyebrow: "CASE STUDY", case_id: "kcpl", headline: "A storefront built around how people actually buy a laptop." },
  story_question: { text: "Is your website actually bringing you customers?", subtext: "Reply and tell us." },
  story_tip: { text: "Your homepage has a few seconds to explain what you do.", subtext: "Say it in one plain line." },
  story_cta: { text: "Need help getting found online?", subtext: "One team for your site, search and socials.", cta: "DM us" },
};

const commands = {
  tick: () => jobs.tick(),
  plan: () => jobs.planDay(business, { date: flags.date, force: Boolean(flags.force) }),
  "generate-post": () => jobs.generateItem(business, "post", { date: flags.date }),
  "generate-story": () => jobs.generateItem(business, "story", { date: flags.date }),
  publish: () => jobs.publishDue(business),
  monitor: () => jobs.monitor(business),
  cleanup: () => jobs.cleanup(business),
  status: () => jobs.status(),
  approve: () => jobs.approve(positional[0]),
  reject: () => jobs.reject(positional[0]),
  regenerate: () => jobs.regenerate(positional[0]),
  "publish-now": () => jobs.publishNow(positional[0]),
  skip: () => jobs.skipDay(business, flags.date),
  pause: () => jobs.setPaused(business, true),
  resume: () => jobs.setPaused(business, false),
  "check-instagram": async () => ({ account: await checkAccount(business) }),
  "refresh-token": () => refreshTokenIfDue(business, { force: true }),
  // After messaging your bot once, prints the chat id to put in TELEGRAM_CHAT_ID.
  "telegram-chat-id": async () => {
    if (!settings.telegram.token) throw new Error("Set TELEGRAM_BOT_TOKEN in .env first");
    const r = await (await fetch(`${settings.telegram.apiBase}/bot${settings.telegram.token}/getUpdates`)).json();
    const chats = new Map((r.result || []).map((u) => u.message?.chat).filter(Boolean).map((c) => [c.id, c.username || c.title || c.first_name]));
    return chats.size ? Object.fromEntries(chats) : "No messages yet: open your bot in Telegram, send it any message, then run this again.";
  },
  "test-telegram": async () => ({ sent: await notify(`Test message from the Instagram automation (${business}).`) }),
  // Consistent DB snapshot + config copy; keeps the newest 14. Run daily from host cron.
  backup: () => {
    const dir = path.join(settings.dataDir, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `automation-${stamp}.db`);
    getDb().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    fs.cpSync(settings.configDir, path.join(dir, `config-${stamp}`), { recursive: true });
    const old = fs.readdirSync(dir).filter((f) => f.startsWith("automation-")).sort().slice(0, -14);
    for (const f of old) {
      fs.rmSync(path.join(dir, f));
      fs.rmSync(path.join(dir, f.replace("automation-", "config-").replace(/.db$/, "")), { recursive: true, force: true });
    }
    return { backup: file, removed: old.length };
  },
  "render-samples": async () => {
    const biz = loadBusiness(business);
    const out = [];
    fs.mkdirSync("data/samples", { recursive: true });
    for (const [t, f] of Object.entries(SAMPLES)) {
      const type = t.startsWith("story_") ? "story" : "post";
      out.push(await renderCreative(biz, { template: t, fields: f, date: "sample", type, outFile: `data/samples/${t}.jpg` }));
    }
    return out;
  },
};

if (!commands[cmd]) {
  console.log(`Commands: ${Object.keys(commands).join(", ")}`);
  process.exit(cmd ? 1 : 0);
}

try {
  const result = await commands[cmd]();
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
} finally {
  closeDb();
}
