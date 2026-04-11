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

### D1 migrations

Apply new SQL to **remote** D1 when you pull migrations (replace `…` with the migration filename):

`npx wrangler d1 execute studio-locater-admin --file=migrations/….sql --remote -y`

`package.json` includes helpers such as `d1:migrate:remote:signup-email` for migration `004_signup_unique_email.sql` (dedupe signups by email + unique index). Run staging and production databases as needed.

## Local development

- **Site + API stubs:** `npm run dev` (Express `server.js`)
- **Worker parity:** `npm run dev:worker` (Wrangler dev; uses D1/KV with `.dev.vars` where applicable)
- **Sanity Studio:** `npm run cms` from the `studio/` folder

`.dev.vars` is gitignored; copy from `.dev.vars.example` if present and fill values locally.
