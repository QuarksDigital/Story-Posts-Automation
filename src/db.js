// SQLite via Node's built-in node:sqlite (no native build, no separate DB
// server). Every row is keyed by business_id so more clients can share one DB.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { settings } from "./config.js";

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS businesses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  website       TEXT,
  instagram_account_id TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS content_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id     INTEGER NOT NULL REFERENCES businesses(id),
  date            TEXT NOT NULL,            -- local date in business timezone
  content_type    TEXT NOT NULL CHECK (content_type IN ('post','story')),
  content_pillar  TEXT,
  topic           TEXT,
  angle           TEXT,
  hook            TEXT,
  template        TEXT,
  fields          TEXT NOT NULL DEFAULT '{}', -- JSON: everything the template renders
  caption         TEXT,
  hashtags        TEXT NOT NULL DEFAULT '[]', -- JSON array
  cta             TEXT,
  source          TEXT NOT NULL DEFAULT 'ai',  -- ai | fallback | manual
  creative_path   TEXT,
  validation      TEXT NOT NULL DEFAULT '[]', -- JSON: warnings kept for review
  status          TEXT NOT NULL,
  scheduled_at    TEXT,
  published_at    TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  instagram_container_id TEXT,
  instagram_media_id TEXT,
  instagram_url   TEXT,
  error           TEXT,
  notified_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (business_id, date, content_type)
);
CREATE INDEX IF NOT EXISTS idx_items_status ON content_items(status, scheduled_at);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER,
  item_id     INTEGER,
  level       TEXT NOT NULL,   -- info | warn | error
  kind        TEXT NOT NULL,   -- plan | render | validate | publish | token | system
  message     TEXT NOT NULL,
  data        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS llm_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id   INTEGER,
  provider      TEXT,
  model         TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(settings.dataDir, { recursive: true });
  db = new DatabaseSync(path.join(settings.dataDir, "automation.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

export function closeDb() {
  if (db) db.close();
  db = undefined;
}

const nowIso = () => new Date().toISOString();

export function ensureBusiness(biz) {
  const d = getDb();
  d.prepare(
    `INSERT INTO businesses (slug, name, website, instagram_account_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET name=excluded.name, website=excluded.website,
       instagram_account_id=excluded.instagram_account_id, updated_at=?`
  ).run(biz.slug, biz.profile.business_name, biz.profile.website || "", biz.instagramAccountId || "", nowIso());
  return d.prepare("SELECT id FROM businesses WHERE slug = ?").get(biz.slug).id;
}

const JSON_COLS = ["fields", "hashtags", "validation"];
function hydrate(row) {
  if (!row) return row;
  const out = { ...row };
  for (const c of JSON_COLS) out[c] = JSON.parse(row[c] ?? "null");
  return out;
}

export function getItem(id) {
  return hydrate(getDb().prepare("SELECT * FROM content_items WHERE id = ?").get(id));
}

export function getItemFor(businessId, date, type) {
  return hydrate(
    getDb().prepare("SELECT * FROM content_items WHERE business_id=? AND date=? AND content_type=?").get(businessId, date, type)
  );
}

export function listItems({ businessId, since, statuses, limit = 100 } = {}) {
  const where = [];
  const args = [];
  if (businessId) (where.push("business_id = ?"), args.push(businessId));
  if (since) (where.push("date >= ?"), args.push(since));
  if (statuses?.length) (where.push(`status IN (${statuses.map(() => "?").join(",")})`), args.push(...statuses));
  const sql = `SELECT * FROM content_items ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY date DESC, content_type ASC LIMIT ?`;
  return getDb().prepare(sql).all(...args, limit).map(hydrate);
}

export function insertItem(item) {
  const cols = Object.keys(item);
  const vals = cols.map((c) => (JSON_COLS.includes(c) ? JSON.stringify(item[c]) : item[c]));
  const res = getDb()
    .prepare(`INSERT INTO content_items (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...vals);
  return getItem(Number(res.lastInsertRowid));
}

export function updateItem(id, patch) {
  const cols = Object.keys(patch);
  if (!cols.length) return getItem(id);
  const vals = cols.map((c) => (JSON_COLS.includes(c) ? JSON.stringify(patch[c]) : patch[c]));
  getDb()
    .prepare(`UPDATE content_items SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...vals, nowIso(), id);
  return getItem(id);
}

export function deleteItem(id) {
  getDb().prepare("DELETE FROM content_items WHERE id = ?").run(id);
}

export function logEvent({ businessId = null, itemId = null, level = "info", kind = "system", message, data }) {
  getDb()
    .prepare("INSERT INTO events (business_id, item_id, level, kind, message, data) VALUES (?, ?, ?, ?, ?, ?)")
    .run(businessId, itemId, level, kind, message, data === undefined ? null : JSON.stringify(data));
  const line = `[${level}] ${kind}: ${message}`;
  if (process.env.QUIET_LOGS !== "1") (level === "error" ? console.error : console.log)(line);
}

export function recentEvents({ businessId, level, sinceIso, limit = 50 } = {}) {
  const where = [];
  const args = [];
  if (businessId) (where.push("business_id = ?"), args.push(businessId));
  if (level) (where.push("level = ?"), args.push(level));
  if (sinceIso) (where.push("created_at >= ?"), args.push(sinceIso));
  return getDb()
    .prepare(`SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit);
}

export function recordUsage(u) {
  getDb()
    .prepare("INSERT INTO llm_usage (business_id, provider, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)")
    .run(u.businessId ?? null, u.provider, u.model, u.inputTokens ?? 0, u.outputTokens ?? 0, u.costUsd ?? 0);
}

export function usageSince(sinceIso) {
  return getDb()
    .prepare(
      "SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cost_usd),0) AS cost_usd FROM llm_usage WHERE created_at >= ?"
    )
    .get(sinceIso);
}

export function kvGet(key) {
  const row = getDb().prepare("SELECT value FROM kv WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : undefined;
}

export function kvSet(key, value) {
  getDb()
    .prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .run(key, JSON.stringify(value), nowIso());
}

export function businessSlug(businessId) {
  return getDb().prepare("SELECT slug FROM businesses WHERE id = ?").get(businessId)?.slug;
}
