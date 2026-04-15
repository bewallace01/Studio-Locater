# Studio Locater

Fitness studio discovery (Sanity CMS, Cloudflare Worker, D1, optional search/enrich Workers).

## Git branches and deploys

| Branch    | Purpose |
|-----------|---------|
| **`main`** | Production line — merge here when changes are ready to go live. |
| **`staging`** | Integration / pre-production — try changes here before merging to `main`. |

Typical flow: commit on **`staging`** → deploy to Cloudflare staging → verify → merge **`staging` → `main`** → deploy production.

## Cloudflare (Wrangler)

Authenticate once: `npx wrangler login`

| Environment | npm command | Worker(s) |
|-------------|-------------|-----------|
| **Staging** | `npm run deploy:staging` (same as `npm run deploy`) | `studio-locater-staging` + `public/` assets |
| **Production** | `npm run deploy:prod` | Top-level `studio-locater` + `public/` assets |

Optional search API / enrich Workers: `deploy:all:staging` / `deploy:all:prod` (see `package.json`).

Secrets and vars are per environment in the Cloudflare dashboard or via `wrangler secret put` (use `--env staging` for staging).

**`MINDBODY_APP_KEY`** (Mindbody schedule/pricing on studio pages) — set on **each** Worker you deploy; same hex app key from the Mindbody developer portal is usually fine for both:

| Target | Command |
|--------|---------|
| **Production** (`studio-locater`) | `npx wrangler secret put MINDBODY_APP_KEY --env=""` |
| **Staging** (`studio-locater-staging`) | `npx wrangler secret put MINDBODY_APP_KEY --env staging` |

Paste the secret when prompted. If Cloudflare reports that the latest Worker version isn’t deployed, run the matching deploy (`npm run deploy:prod` or `npm run deploy`) first, or use `npx wrangler versions secret put MINDBODY_APP_KEY --env …`.

For **live** Mindbody businesses (Sanity **`mindbodySiteId`** other than **`-99`**), also set **`MINDBODY_ISSUE_USERNAME`** and **`MINDBODY_ISSUE_PASSWORD`** as secrets on each Worker (same `--env` pattern). See **Studio listings (opt-in)** under Mindbody.

**`PUBLIC_SITE_URL`** — Base URL for links in “new blog post” notification emails when posts are auto-published by the daily cron. Set it to your real production domain when you use one. Admin manual publish uses the current site URL from the browser.


### D1 migrations

Apply new SQL to **remote** D1 when you pull migrations (replace `…` with the migration filename):

`npx wrangler d1 execute studio-locater-admin --file=migrations/….sql --remote -y`

`package.json` includes helpers such as `d1:migrate:remote:signup-email` for migration `004_signup_unique_email.sql` (dedupe signups by email + unique index). Run staging and production databases as needed.

## Local development

- **Site + API stubs:** `npm run dev` (Express `server.js`)
- **Worker parity:** `npm run dev:worker` (Wrangler dev; uses D1/KV with `.dev.vars` where applicable)
- **Sanity Studio:** `npm run cms` from the `studio/` folder  
- **Deploy Studio (hosted):** `npm run cms:deploy` from the repo root (uses `scripts/sanity-deploy.mjs` so paths with **spaces in the folder name** still work). First-time deploy may require `sanity login`. Hostname is set in `studio/sanity.cli.cjs` (`studioHost`). Live URL: **https://studio-locater.sanity.studio**

`.dev.vars` is gitignored; copy from `.dev.vars.example` if present and fill values locally.

### Mindbody sandbox

Use this when experimenting with the [Mindbody Public API](https://developers.mindbodyonline.com/) (e.g. class schedules, pricing) before wiring anything into the Worker.

#### 1. Create a developer account

1. Sign up / log in at **[developers.mindbodyonline.com](https://developers.mindbodyonline.com/)**.
2. Open **Your API credentials** (or **API credentials** under your account/profile — exact label varies). You should see a **Source name** (e.g. `StudioLocater`) and a **Source secret** (you can **reset** it if you do not have it saved). The secret is what the v6 docs call the **`Api-Key`** header for requests.
3. Copy `.dev.vars.example` → `.dev.vars` and set at least:
   - **`MINDBODY_APP_KEY=`** — the **hex Key** next to your app name in the portal’s **Issued** table, **or**
   - **`MINDBODY_SOURCE_SECRET=`** — the **Public API Source** password (if `Api-Key` rejects one, try the other).  
   - `MINDBODY_SITE_ID=-99` — shared sandbox site  

#### 2. Build and test against the sandbox (no real studio)

- **Site ID `-99`** is the shared fake business; you do **not** need a live Mindbody site for this step.
- **Two logins:** (a) **Source secret** → API `Api-Key`. (b) **Sandbox site login** (`mindbodysandboxsite@gmail.com` / published test password) → used only for **POST `/usertoken/issue`** together with your `Api-Key`, so Mindbody returns an **AccessToken** for staff calls. That is separate from browsing the Mindbody website, though the credentials are the same pair Mindbody documents for the sandbox site.
- Run a smoke test from the repo root (requires network):

  `npm run mindbody:sandbox`

  This calls **`/usertoken/issue`**, then **`/class/classschedules`** for the next seven days. If your Source secret is wrong or Mindbody returns an error, the script prints the JSON error.

**Other notes**

- **Nightly reset** — Sandbox data resets around **12:00 AM PST**; IDs are not stable forever.
- **Local Worker** — After things work in the script, you can use the same env vars with `npm run dev:worker`. Do not commit `.dev.vars`.
- **Go live / per-studio access** — Follow Mindbody’s **Getting Started** order: sandbox first, then **request to go live**, then **activation codes/links** for each real business owner.

#### Studio listings (opt-in)

- In **Sanity**, set **Mindbody Site ID** on a `studio` document when that business uses Mindbody and you have access. Optionally set **Mindbody location IDs** (array of numbers) to filter schedule/services when a site has multiple locations.
- **`GET /api/mindbody/studio?slug=…`** and **`GET /api/mindbody/schedule?slug=…`** (same JSON) load **this week’s class schedules** and **`/sale/services`**. The browser never sends `siteId`; the Worker reads **`mindbodySiteId`** from Sanity by slug. Requires **`MINDBODY_APP_KEY`** and credentials for **`POST /usertoken/issue`** (see below).
- **Token issue (`/usertoken/issue`)** — Mindbody returns a staff **AccessToken** only when you send valid **Username** / **Password** for that **SiteId**. For sandbox **`-99`**, this repo uses Mindbody’s published sandbox defaults unless you override with **`MINDBODY_SANDBOX_USERNAME`** / **`MINDBODY_SANDBOX_PASSWORD`** in `.dev.vars`. For **any other** `mindbodySiteId`, set **`MINDBODY_ISSUE_USERNAME`** and **`MINDBODY_ISSUE_PASSWORD`** (values from Mindbody / the business owner, per their go-live flow). Without them, the API responds with `missing_issue_credentials`. On Cloudflare, store the password as a secret, e.g. `npx wrangler secret put MINDBODY_ISSUE_PASSWORD --env=""` and the same for **`--env staging`**; username can be a secret or a plain **var** in the dashboard if you prefer.
- **AccessToken cache** — Staff tokens are cached about **5 minutes** in Workers KV (`MINDBODY_TOKEN_CACHE` in `wrangler.toml`). Local Express uses an in-memory cache only. Optional: **`MINDBODY_TOKEN_TTL_SEC`** (60–3600) in `.dev.vars`.
- Deploy: set **`MINDBODY_APP_KEY`** on staging and production (table under Cloudflare above). For live studios, add issue credentials as above. Redeploy after `wrangler.toml` adds the Mindbody KV binding.

Until Mindbody is configured, `.dev.vars` entries remain optional.
