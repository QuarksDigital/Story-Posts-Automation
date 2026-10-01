# Quarks Instagram Automation

Creates and publishes **1 feed post + 1 story per day** for the Quarks Digital Instagram page, with a caption and hashtags, from the business profile in `config/`. Reels stay manual.

Costs are kept down by design: one AI text call a day, template creatives instead of AI images, SQLite instead of a managed database, and the official Instagram API (free).

```
07:30  plan      ── 1 AI call: topic + post copy + caption + hashtags + story copy
                    ├─ deterministic validation (fake phone/URL/price/offer/stat, repeats, lengths)
                    ├─ 1 corrected retry if invalid ── then evergreen fallback library
07:30  render    ── brand template -> 1080x1350 post + 1080x1920 story (JPEG, no AI)
                    └─ approval mode: preview to Telegram [Approve] [Reject] [Regenerate]
09:00  publish   ── post via Instagram Graph API (container -> FINISHED -> media_publish)
19:00  publish   ── story (media_type=STORIES)
hourly monitor   ── alerts only when someone must act; weekly token refresh
daily  cleanup   ── deletes old drafts, keeps published history
```

## Stack and why

| Part | Choice | Monthly cost |
|---|---|---|
| Orchestration | **n8n self-hosted** (5 workflows), or the engine's built-in scheduler | ₹0 |
| Engine | Node.js 22, no framework (`src/`) | ₹0 |
| Database | SQLite via built-in `node:sqlite` (no native build, no DB server) | ₹0 |
| Text AI | One structured-output call/day. Claude by default; any OpenAI-compatible API or local Ollama also works | ₹30–₹200 |
| Creatives | 8 post + 3 story **templates** rendered with Satori → resvg → sharp (no browser, no image API) | ₹0 |
| Publishing | Official Instagram Content Publishing API | ₹0 |
| Notifications / approval | Telegram bot (long polling, so it works without a webhook) | ₹0 |
| Hosting | One small VPS + Caddy (automatic HTTPS) | ₹600–₹650 |

The only costs you can't avoid are the server and the AI text call. Everything else is free.

### Layout

```
config/businesses/quarks/
  business.json     facts the AI may use (services, contacts, case studies, brand colours, banned phrases)
  strategy.json     schedule, approval mode, weekday pillars, caption/hashtag rules, retention
  fallback.json     10 evergreen posts used if AI fails twice
  assets/           logo.png (unmodified, from the website) + Switzer fonts
src/
  jobs.js           plan / render / publish / monitor / cleanup / manual controls (idempotent)
  content.js        the one-call schema + prompt
  validate.js       deterministic checks (no AI)
  render/           templates + renderer
  instagram.js      Graph API publishing + token refresh
  telegram.js       notifications + approve/reject/regenerate buttons
  llm/              anthropic | openai-compatible | mock providers
  server.js         review page, n8n endpoints, public /media for Meta
  cli.js            every operation from the command line
n8n/workflows/      01 planner, 02 post generator, 03 story generator, 04 publisher, 05 error monitor
test/               48 automated tests (fake Graph API + fake Telegram included)
```

Every business fact the AI may mention is in `business.json`. The validator rejects any phone number, URL, email, price, offer, percentage or "3x"-style claim that isn't listed there. It also rejects banned phrases, services or case studies that don't exist, and topics, hooks or stories too close to the last 30 days. Logos, service names, client names and testimonials are printed from the profile, never from AI text.

---

## Testing locally (do these in order, all on your laptop)

Requirements: Node.js 22.13+ (you have 22.13.0). Docker is **not** needed locally.

```bash
cd instagram-automation
npm install
cp .env.example .env
```

### Stage 1 — offline, free (mock AI, dry-run publishing)

`.env` defaults are already offline: `LLM_PROVIDER=mock`, `PUBLISH_MODE=dry-run`.

**1a. Automated test suite (48 tests, about 1 minute):**

```bash
npm test
```

This covers:
- every validator rule
- every template rendering a correct JPEG
- a simulated 14 days (one AI call per day, no repeated topics, fallback, pause/skip, approval and missed slots, edit/regenerate)
- live publishing against a fake Graph API (including retries, permanent errors, token expiry and refresh)
- the server's auth and review page
- Telegram approve buttons

**1b. Look at the designs:**

```bash
npm run cli -- render-samples
```

This writes all 10 templates to `data/samples/`. To change the look, edit `src/render/templates.js` or the colours in `business.json`.

**1c. Walk through a full day by hand.** `--now` simulates the clock (times are UTC; IST = UTC+5:30):

```bash
npm run cli -- tick --now 2026-10-05T02:15:00Z
npm run cli -- status
npm run cli -- approve 1
npm run cli -- approve 2
npm run cli -- publish --now 2026-10-05T03:35:00Z
npm run cli -- publish --now 2026-10-05T13:35:00Z
```

- The first `tick` is 07:45 IST: it plans and renders, and both items wait for approval.
- The first `publish` is 09:05 IST and publishes the post (dry run).
- The second `publish` is 19:05 IST and publishes the story (dry run).

Delete `data/automation.db` and `data/media/` to start fresh.

**1d. Review page:**

```bash
npm start
```

Open http://localhost:8080. With no `ADMIN_TOKEN` it only accepts connections from your own machine. From there you can edit the caption, hashtags or image text (re-rendered with no AI cost), approve, reject, regenerate, publish now, skip the day or pause.

### Stage 2 — real AI text (costs a few paise per run)

In `.env`:

```
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
# optional cheapest model:
# LLM_MODEL=claude-haiku-4-5
```

Then run:

```bash
npm run cli -- plan --force
npm run cli -- generate-post
npm run cli -- generate-story
npm run cli -- status
```

Open `data/media/quarks/` and the review page, and read what it wrote. `status` shows the real token usage and ₹ cost of each call, so you can check the pricing below yourself. Run `plan --force` a few times on different `--date`s (e.g. `--date 2026-10-06`, which is a Tuesday and uses the Service pillar) to see the pillar rotation.

Free alternative: install Ollama, run `ollama pull llama3.1:8b`, then set `LLM_PROVIDER=openai`, `LLM_BASE_URL=http://localhost:11434/v1` and `LLM_MODEL=llama3.1:8b`. The quality is lower, but the validator still blocks invented facts.

### Stage 3 — Telegram approval

1. In Telegram, message **@BotFather** → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
2. Send any message to your new bot, then run `npm run cli -- telegram-chat-id` and put the number in `TELEGRAM_CHAT_ID`.
3. Run `npm run cli -- test-telegram`.
4. Run `npm start`, then on the review page click **Replace today (1 AI call)**. You should get two previews with Approve / Reject / Regenerate buttons, and tapping them updates the review page.

Bot commands: `/status`, `/skip`, `/pause`, `/resume`, `/approve <id>`, `/retry <id>`.

### Stage 4 — n8n locally (optional; the built-in scheduler does the same job)

```bash
# terminal 1: the engine, waiting for n8n to call it
SCHEDULER=external ADMIN_TOKEN=localtest npm start

# terminal 2: n8n
N8N_BLOCK_ENV_ACCESS_IN_NODE=false ENGINE_URL=http://localhost:8080 ADMIN_TOKEN=localtest npx n8n@2.41.5 import:workflow --separate --input=n8n/workflows
N8N_BLOCK_ENV_ACCESS_IN_NODE=false ENGINE_URL=http://localhost:8080 ADMIN_TOKEN=localtest GENERIC_TIMEZONE=Asia/Kolkata npx n8n@2.41.5 start
```

Open http://localhost:5678, create the owner account, then open each "IG" workflow and click **Execute workflow**. The engine log shows each call. Activate the workflows to let them run on schedule.

(In PowerShell, set the variables first with `$env:NAME="value"`.)

### Stage 5 — first real Instagram post, still from your laptop

Instagram's servers download the image from a public HTTPS URL, so your laptop needs a temporary public address. A free Cloudflare quick tunnel works with no account:

```bash
winget install Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:8080
```

It prints `https://something.trycloudflare.com`. Then, in `.env`:

```
PUBLIC_BASE_URL=https://something.trycloudflare.com
ADMIN_TOKEN=<long random string>   # required now that the server is reachable
INSTAGRAM_ACCOUNT_ID=...
META_ACCESS_TOKEN=...              # see "Meta setup" below
PUBLISH_MODE=live
```

Run these in order:

```bash
npm run cli -- check-instagram
npm start
```

1. `check-instagram` is read-only: it shows the username and publishing quota. Don't continue until it says `"ok": true`.
2. In the review page, generate today's content, look at it, and click **Publish now** on the post.
3. Check Instagram. Then do the same for the story.

Keep `approval_mode: true` in `strategy.json` for the first week or two. Switch it to `false` once you trust the output.

---

## Meta setup (one time, about 20 minutes)

1. Switch the Instagram account to a **Business** account. Story publishing through the API needs a professional account; Business is the safest.
2. On developers.facebook.com, **Create app**, then add the **Instagram** product and choose **API setup with Instagram login**.
3. Add the permissions **instagram_business_basic** and **instagram_business_content_publish**.
4. Under *Generate access tokens*, add the @quarksdigital account. In Development mode it must be added as an Instagram tester under App roles, and the invite accepted in the Instagram app.
5. Generate the token. That gives you a long-lived (60-day) token and the account's user ID. Put them in `META_ACCESS_TOKEN` and `INSTAGRAM_ACCOUNT_ID`.
6. The engine refreshes this token weekly (`IG_TOKEN_REFRESH=auto`), so it never reaches the 60-day expiry. If it does fail, the hourly monitor messages you on Telegram.

Your own account works with the app left in Development mode. Publishing to **client** accounts later needs Meta App Review and Business Verification for those permissions.

If you use a Page-linked account (Facebook Login) instead, set `GRAPH_API_BASE=https://graph.facebook.com`, use a Page access token, and use the Instagram business account ID.

---

## Moving to a VPS (only after Stage 5 works)

1. Create an Ubuntu 24.04 VPS with 2 vCPU / 4 GB (e.g. Hetzner CX23). Install Docker. Firewall: allow 22, 80 and 443 only. Run `apt install unattended-upgrades`.
2. Point two DNS records at the server, e.g. `ig.quarksdigital.in` and `n8n.quarksdigital.in`.
3. Copy this folder over (not `node_modules`, not `data/`) and set up `.env`:

   ```bash
   cp .env.example .env
   ```

   Set `PUBLIC_BASE_URL=https://ig.quarksdigital.in`, `ENGINE_HOST`, `N8N_HOST`, `SCHEDULER=external`, `PUBLISH_MODE=live`, and give `ADMIN_TOKEN` and `N8N_ENCRYPTION_KEY` long random values.

4. Start it:

   ```bash
   mkdir -p data && sudo chown 1000:1000 data
   docker compose up -d --build
   ```

   Caddy gets the HTTPS certificates automatically.

5. In n8n (`https://n8n.quarksdigital.in`), create the owner account with a strong password, import the 5 files from `/workflows`, and activate them:

   ```bash
   docker compose exec n8n n8n import:workflow --separate --input=/workflows
   ```

6. Set up daily backups with `crontab -e`. This keeps 14 days on the server; copy `data/backups` off the server occasionally, e.g. with rclone to Google Drive.

   ```
   30 3 * * * cd /root/instagram-automation && docker compose exec -T engine node src/cli.js backup
   ```

**Without n8n** (fits a 1 GB server): set `SCHEDULER=internal` and run `docker compose up -d engine caddy`. Same behaviour, about 400 MB less RAM.

---

## Day-to-day control (you can always take over)

| Want to… | Do this |
|---|---|
| Turn everything off | Review page **Pause automation**, `/pause` in Telegram, or `"automation_enabled": false` in `strategy.json` |
| Skip a day | **Skip today**, `/skip 2026-10-10`, or add the date to `skip_dates` |
| Replace today's content | **Replace today** (1 AI call) or **Regenerate** on one item |
| Edit a caption or the image text | Edit in the review page → **Save edits** (re-rendered, no AI cost) |
| Approve | Telegram button, review page, or `npm run cli -- approve <id>` |
| Change posting times | `schedule` in `strategy.json` (no restart needed) |
| Change pillars or weekday plan | `weekly_calendar` / `pillars` in `strategy.json` |
| Change business info | `business.json`. Add real testimonials, prices or offers there and the AI may use them; the validator blocks anything that isn't listed |
| Allow statistics | Add the verified results to `case_studies[].verified_results` / `verified_facts`. Only those exact figures pass |
| Auto-publish without approval | `"approval_mode": false` |

If publishing fails, the system retries twice, keeps the content, and messages you with the reason. **Publish now** retries it. It never fails silently, and it never retries a publish call that may have gone through (so no duplicate posts).

## Adding a client later

1. Copy `config/businesses/quarks` to `config/businesses/<slug>` and edit the JSON files and assets. Set `"slug"` to match the folder name.
2. Add `INSTAGRAM_ACCOUNT_ID__<SLUG>` and `META_ACCESS_TOKEN__<SLUG>` to `.env`.

The database, scheduler and workflows already loop over every business, so nothing else changes.

## Known limits

- The API can't add interactive story stickers (polls, question boxes), so question stories are plain images.
- Carousels and Reels are not generated, by design.
- Spelling is checked by the model and by your review in approval mode, not by a separate tool.
- Case-study results on the website are not used: the code comment there says some of that copy is placeholder. Add confirmed figures to `verified_results` to allow them.
- `npm audit` reports a moderate advisory in `fflate` (a ZIP parser inside satori). Satori never unzips anything here, so it can't be reached.
