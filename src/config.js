// Loads environment + per-business JSON config. Business config is re-read on
// every job so edits to config/businesses/<slug>/*.json apply without a restart.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Tiny .env loader (no dependency). Real environment variables win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(ROOT, ".env"));

const env = (k, d = "") => process.env[k] ?? d;
const bool = (k, d = false) => {
  const v = process.env[k];
  return v === undefined ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase());
};

export const settings = {
  port: Number(env("PORT", "8080")),
  publicBaseUrl: env("PUBLIC_BASE_URL", "http://localhost:8080").replace(/\/$/, ""),
  adminToken: env("ADMIN_TOKEN"),
  dataDir: path.resolve(ROOT, env("DATA_DIR", "data")),
  configDir: path.resolve(ROOT, env("CONFIG_DIR", "config")),
  scheduler: env("SCHEDULER", "external"), // "internal" = built-in ticker, "external" = n8n
  tickSeconds: Number(env("TICK_SECONDS", "60")),

  llm: {
    provider: env("LLM_PROVIDER", "mock"), // anthropic | openai | mock
    model: env("LLM_MODEL", ""),
    effort: env("LLM_EFFORT", "low"),
    apiKey: env("ANTHROPIC_API_KEY") || env("AI_API_KEY"),
    baseUrl: env("LLM_BASE_URL", ""),
    usdToInr: Number(env("USD_TO_INR", "88")),
  },

  instagram: {
    mode: env("PUBLISH_MODE", "dry-run"), // live | dry-run
    graphBase: env("GRAPH_API_BASE", "https://graph.instagram.com").replace(/\/$/, ""),
    graphVersion: env("GRAPH_API_VERSION", "v23.0"),
    accountId: env("INSTAGRAM_ACCOUNT_ID"),
    accessToken: env("META_ACCESS_TOKEN"),
    pollIntervalMs: Number(env("IG_POLL_INTERVAL_MS", "3000")),
    pollMaxTries: Number(env("IG_POLL_MAX_TRIES", "20")),
    publishRetries: Number(env("IG_PUBLISH_RETRIES", "2")),
    retryDelayMs: Number(env("IG_RETRY_DELAY_MS", "5000")),
    tokenRefresh: env("IG_TOKEN_REFRESH", "auto"), // auto = only for graph.instagram.com tokens | on | off
  },

  telegram: {
    token: env("TELEGRAM_BOT_TOKEN"),
    chatId: env("TELEGRAM_CHAT_ID"),
    polling: bool("TELEGRAM_POLLING", true),
    apiBase: env("TELEGRAM_API_BASE", "https://api.telegram.org"),
  },
};

export function businessDir(slug) {
  return path.join(settings.configDir, "businesses", slug);
}

export function listBusinesses() {
  const dir = path.join(settings.configDir, "businesses");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "business.json")));
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing config file: ${file}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Invalid JSON in ${file}: ${e.message}`);
  }
}

export function loadBusiness(slug) {
  const dir = businessDir(slug);
  const profile = readJson(path.join(dir, "business.json"));
  const strategy = readJson(path.join(dir, "strategy.json"));
  const fallbacks = readJson(path.join(dir, "fallback.json"), []);
  if (profile.slug !== slug) throw new Error(`business.json slug "${profile.slug}" does not match folder "${slug}"`);
  return { slug, dir, assetsDir: path.join(dir, "assets"), profile, strategy, fallbacks };
}
