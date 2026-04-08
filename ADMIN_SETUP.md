# Admin Panel — Setup Guide

This guide walks you through enabling the admin panel for your Studio Locater app.
Everything runs on your existing Cloudflare Worker — no new services required.

---

## What Was Built

| Feature | URL |
|---|---|
| Admin Dashboard | `/admin` |
| Public Blog | `/blog` |
| Blog Post | `/blog/:slug` |
| Signup Tracker API | `POST /api/track/signup` |

---

## Step 1 — Apply the Database Schema

Run this once to create the tables in your **local** D1 (used by `wrangler dev`):

```bash
npm run d1:migrate:local
```

Apply the same schema to your **remote** D1 (used by the deployed Worker):

```bash
npm run d1:migrate:remote
```

If the remote command fails with an authentication error, run `npx wrangler login` and try again. (Local migration does not require remote API access.)

---

## Step 2 — Create a Google OAuth App

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials
2. Click **Create Credentials → OAuth 2.0 Client ID**
3. Application type: **Web application**
4. Name it: `Studio Locater Admin`
5. Under **Authorized redirect URIs**, add:
   - `https://studio-locater.workers.dev/auth/callback` ← your production URL
   - `http://localhost:8787/auth/callback` ← for local dev
6. Copy the **Client ID** and **Client Secret**

---

## Step 3 — Set Worker Secrets

Run each command and paste the value when prompted:

```bash
# Google OAuth credentials (from Step 2)
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET

# Your Gmail address(es) that are allowed to log in
# Multiple emails: comma-separated, e.g.  you@gmail.com,partner@gmail.com
npx wrangler secret put ADMIN_EMAILS

# Random session signing key — run this to generate one:
#   openssl rand -hex 32
npx wrangler secret put SESSION_SECRET

# Your Anthropic API key (for AI blog generation)
# Get one at: https://console.anthropic.com/
npx wrangler secret put ANTHROPIC_API_KEY

# Optional: Google Places API key (already used for studio pages)
# npx wrangler secret put GOOGLE_API_KEY
```

---

## Step 4 — Deploy

Production (main site + admin on the `studio-locater` Worker):

```bash
npm run deploy:all:prod
```

(Deploy only the main Worker with `npm run deploy:prod` if you do not need the API/enrich workers updated.)

---

## Step 5 — Access the Admin Panel

Visit: **`https://<your-subdomain>.workers.dev/admin`** (production Worker hostname)

You'll be redirected to Google sign-in. Only the email(s) you set in `ADMIN_EMAILS` can access it.

---

## Using the Admin Panel

### Overview Tab
Shows total signups, last 7 days, last 30 days, and published blog count. The chart updates automatically as signup events come in.

### Blog Manager Tab
- **Generate Post** — Opens a prompt where you describe a topic. Claude writes a full blog post in seconds. It's saved as a draft for your review.
- **Publish / Unpublish** — Toggle visibility on your public `/blog` page.
- **Delete** — Permanently remove a post.
- **View** — Preview the live post at `/blog/:slug`.

### Auto Schedule Tab
Configure Claude to auto-write posts on a schedule:
- Set frequency (daily / weekly / every 2 weeks)
- Add a pool of topics — Claude rotates through them automatically
- Toggle **Auto-publish** to skip draft review, or leave off to approve each post first
- Toggle **Schedule active** to pause without losing settings

The cron runs daily at 8am UTC and checks if any scheduled posts are due.

---

## Tracking User Signups

When a user signs up on your main site, call this endpoint:

```js
// Anywhere in your existing frontend JS:
fetch('/api/track/signup', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    source: 'homepage',        // optional — where they signed up
    email: userEmail,          // optional — stored as a short hash, never plaintext
    metadata: { plan: 'free' } // optional — any extra context
  })
});
```

Signup events appear immediately in the admin Overview chart.

---

## Local Development

1. Copy `.dev.vars.example` → `.dev.vars` and fill in OAuth, `ADMIN_EMAILS`, `SESSION_SECRET` (`openssl rand -hex 32`), and `ANTHROPIC_API_KEY`.
2. Apply the local D1 schema: `npm run d1:migrate:local`
3. Run the Worker locally:

```bash
npm run dev:worker
```

- Admin: http://localhost:8787/admin  
- Blog: http://localhost:8787/blog  

`npm start` (Express on port 3040) serves the marketing site and a **stub** `POST /api/track/signup`; admin APIs and D1 require `wrangler dev` above.

Note: For local OAuth testing, add `http://localhost:8787/auth/callback` to your Google OAuth client redirect URIs.

---

## Files Changed / Created

| File | Description |
|---|---|
| `worker.js` | Extended with auth, admin API, blog routes, cron handler |
| `wrangler.toml` | Added D1 database, KV namespace, and cron trigger |
| `public/admin.html` | Admin dashboard SPA |
| `migrations/001_admin.sql` | D1 schema (sessions, signups, blog posts, schedule) |
| `ADMIN_SETUP.md` | This guide |

---

## Security Notes

- The `/admin` route requires a valid Google OAuth session — no session = redirect to Google login
- Only emails listed in `ADMIN_EMAILS` can authenticate
- Session tokens are stored in Cloudflare KV with a 7-day TTL and HttpOnly, Secure, SameSite=Lax cookies
- Signup emails are SHA-256 hashed before storage (first 16 hex chars only — irreversible)
- All admin API routes return 401 if no valid session is present
