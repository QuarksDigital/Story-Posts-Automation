// Official Instagram Content Publishing API only: container -> status poll ->
// media_publish. No passwords, no browser automation, no unofficial clients.
//
// Works with both login flavours (set GRAPH_API_BASE):
//   https://graph.instagram.com  - "Instagram API with Instagram Login" (no Facebook Page needed)
//   https://graph.facebook.com   - "Instagram API with Facebook Login" (Page-linked account)
import { settings } from "./config.js";
import { kvGet, kvSet } from "./db.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GraphError extends Error {
  constructor(message, { status, code, subcode, transient } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.transient = transient;
  }
}

// Graph error codes worth retrying (rate limits / temporary server issues).
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 368, 613, 9004, 2207001, 2207003]);

/** Per-business credentials: env suffix (META_ACCESS_TOKEN__QUARKS) beats the default; a refreshed token in the DB beats both. */
export function credentials(slug) {
  const suffix = `__${slug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const accountId = process.env[`INSTAGRAM_ACCOUNT_ID${suffix}`] || settings.instagram.accountId;
  const envToken = process.env[`META_ACCESS_TOKEN${suffix}`] || settings.instagram.accessToken;
  const stored = kvGet(`ig_token:${slug}`);
  // a refreshed token is only used while the .env token it was derived from is unchanged
  const token = stored?.token && stored.base_env === envToken ? stored.token : envToken;
  return { accountId, token, envToken };
}

async function graph(method, path, params, token) {
  const { graphBase, graphVersion } = settings.instagram;
  const url = new URL(`${graphBase}/${graphVersion}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: token });
  let res;
  try {
    res =
      method === "GET"
        ? await fetch(`${url}?${body}`, { signal: AbortSignal.timeout(60_000) })
        : await fetch(url, { method, body, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw new GraphError(`Network error calling Instagram: ${e.message}`, { transient: true });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const err = json.error || {};
    const msg = err.error_user_msg || err.message || `HTTP ${res.status}`;
    throw new GraphError(`Instagram API: ${msg} (code ${err.code ?? "?"}${err.error_subcode ? "/" + err.error_subcode : ""})`, {
      status: res.status,
      code: err.code,
      subcode: err.error_subcode,
      transient: res.status >= 500 || TRANSIENT_CODES.has(err.code) || TRANSIENT_CODES.has(err.error_subcode) || err.is_transient === true,
    });
  }
  return json;
}

/**
 * Publishes one JPEG (already reachable at imageUrl) as a feed post or story.
 * Returns { containerId, mediaId, permalink }.
 */
export async function publishImage({ slug, type, imageUrl, caption }) {
  const { accountId, token } = credentials(slug);
  if (!accountId || !token) throw new GraphError("INSTAGRAM_ACCOUNT_ID / META_ACCESS_TOKEN not configured", { transient: false });

  const params = { image_url: imageUrl };
  if (type === "story") params.media_type = "STORIES";
  else params.caption = caption;
  const container = await graph("POST", `${accountId}/media`, params, token);

  // Meta downloads and processes the image asynchronously.
  let status = "IN_PROGRESS";
  for (let i = 0; i < settings.instagram.pollMaxTries; i++) {
    const s = await graph("GET", container.id, { fields: "status_code,status" }, token);
    status = s.status_code;
    if (status === "FINISHED") break;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new GraphError(`Media container ${status}: ${s.status || "Instagram could not process the image"}`, { transient: false });
    }
    await sleep(settings.instagram.pollIntervalMs);
  }
  if (status !== "FINISHED") throw new GraphError(`Media container still ${status} after polling`, { transient: true });

  let published;
  try {
    published = await graph("POST", `${accountId}/media_publish`, { creation_id: container.id }, token);
  } catch (e) {
    // No response means it may already be live: never auto-retry that (duplicate post risk).
    if (e.status === undefined) e.transient = false;
    throw e;
  }
  let permalink = null;
  try {
    permalink = (await graph("GET", published.id, { fields: "permalink" }, token)).permalink ?? null;
  } catch {
    // the post is live; a missing permalink is not a failure
  }
  return { containerId: container.id, mediaId: published.id, permalink };
}

/** Cheap read-only check that the token works and points at the right account. */
export async function checkAccount(slug) {
  const { accountId, token } = credentials(slug);
  if (!accountId || !token) return { ok: false, error: "INSTAGRAM_ACCOUNT_ID / META_ACCESS_TOKEN not configured" };
  try {
    const me = await graph("GET", accountId, { fields: "id,username" }, token);
    let quota = null;
    try {
      quota = (await graph("GET", `${accountId}/content_publishing_limit`, { fields: "quota_usage,config" }, token)).data?.[0] ?? null;
    } catch {
      // optional endpoint
    }
    return { ok: true, username: me.username, id: me.id, quota };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  }
}

/**
 * Long-lived Instagram-Login tokens last 60 days and can be refreshed once
 * they are at least 24h old. Refreshing weekly keeps them alive indefinitely.
 * (Facebook-Login Page tokens do not expire this way; nothing to do there.)
 */
export async function refreshTokenIfDue(slug, { force = false } = {}) {
  const mode = settings.instagram.tokenRefresh;
  const applies = mode === "on" || (mode === "auto" && settings.instagram.graphBase.includes("graph.instagram.com"));
  if (!applies) return { skipped: "token refresh not applicable (Facebook-Login Page tokens do not need it)" };
  const { token, envToken } = credentials(slug);
  if (!token) return { skipped: "no token" };
  const stored = kvGet(`ig_token:${slug}`);
  const lastRefresh = stored?.refreshed_at ? Date.parse(stored.refreshed_at) : 0;
  if (!force && Date.now() - lastRefresh < 7 * 86400_000) return { skipped: "refreshed recently" };

  const url = `${settings.instagram.graphBase}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new GraphError(`Token refresh failed: ${json.error?.message || res.status}`, { code: json.error?.code });
  kvSet(`ig_token:${slug}`, {
    token: json.access_token,
    base_env: envToken,
    refreshed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + (json.expires_in ?? 0) * 1000).toISOString(),
  });
  return { refreshed: true, expires_in_days: Math.round((json.expires_in ?? 0) / 86400) };
}
