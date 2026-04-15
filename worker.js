/**
 * Cloudflare Worker: studio detail pages + sitemap (SEO), admin panel, blog, then static assets.
 *
 * New routes added:
 *   GET  /auth/google          → redirect to Google OAuth
 *   GET  /auth/callback        → handle OAuth code, set session cookie
 *   POST /auth/logout          → clear session
 *   GET  /admin                → serve admin dashboard (requires auth)
 *   GET  /api/admin/me         → current user info (requires auth)
 *   GET  /api/admin/stats      → signup & post stats (requires auth)
 *   GET  /api/admin/signups    → list recent signups (requires auth)
 *   GET  /api/admin/blogs      → list blog posts (requires auth)
 *   POST /api/admin/blogs/generate → generate post via Claude (requires auth)
 *   POST /api/admin/blogs/suggest-prompts → AI prompts (list/refine/schedule_list/schedule_refine) (requires auth)
 *   PATCH  /api/admin/blogs/:id    → publish / unpublish (requires auth)
 *   DELETE /api/admin/blogs/:id    → delete post (requires auth)
 *   GET  /api/admin/schedule   → get blog schedule config (requires auth)
 *   POST /api/admin/schedule   → save blog schedule config (requires auth)
 *   POST /api/track/signup     → record a user signup event (public, no auth)
 *   GET  /api/blog-posts       → JSON list of published posts for nav (public)
 *   POST /api/place-meta       → batch rating/review counts from Google Place Details (public; needs GOOGLE_API_KEY)
 *   GET  /blog                 → public blog listing
 *   GET  /blog/:slug           → public post (published); drafts only if admin session
 *   GET  /sitemap.xml          → homepage, /blog, /classes, studios (Sanity), blog posts (D1), class guides
 *   POST /api/auth/magic-link  → email magic sign-in link (needs Gmail secrets + D1 migration 003)
 *   GET  /auth/magic           → consume token, set user_session cookie
 *   POST /api/auth/user-logout → clear user session (not admin)
 *   GET  /api/me               → current end-user or null
 *   GET/POST/DELETE /api/me/favorites → saved studios (auth)
 *   GET  /api/mindbody/studio?slug=  → JSON: Mindbody class schedule + services (same as /api/mindbody/schedule)
 *   GET  /api/mindbody/schedule?slug= → alias; AccessToken cached in KV MINDBODY_TOKEN_CACHE (~5 min)
 *
 * Secrets required (set via `npx wrangler secret put <NAME>`):
 *   GOOGLE_CLIENT_ID      – OAuth 2.0 client ID from Google Cloud Console
 *   GOOGLE_CLIENT_SECRET  – OAuth 2.0 client secret
 *   ADMIN_EMAILS          – comma-separated allowed emails, e.g. "you@gmail.com"
 *   SESSION_SECRET        – random string for signing (openssl rand -hex 32)
 *   ANTHROPIC_API_KEY     – Claude API key for blog generation
 *   GMAIL_REFRESH_TOKEN   – OAuth refresh token for sending mail (Gmail API gmail.send)
 *   GMAIL_SEND_AS         – From address, e.g. you@gmail.com (must match that mailbox)
 */

import {
  fetchStudioBySlug,
  fetchStudioByDocumentId,
  enrichStudioWithGooglePlaces,
  buildStudioDetailHtml,
  buildStudioNotFoundHtml,
  fetchAllStudioSlugs,
  buildSitemapXml,
  fetchStudiosByCity,
  fetchAllCityTagCombos,
  fetchStudiosByNeighborhood,
  fetchAllNeighborhoodTagCombos,
  buildCityPageHtml,
  cityToSlug,
  citySlugToDisplay,
} from './studio-detail-page.mjs';

import {
  handleRequestMagicLink,
  handleVerifyMagicLink,
  handleUserLogout as handleUserLogoutMagic,
  handleUserMe,
  handleUserFavoritesGet,
  handleUserFavoritesPost,
  handleUserFavoritesDelete,
  notifySubscribersBlogPublished,
} from './user-magic-auth.mjs';

import { CLASS_GUIDE_SLUGS } from './class-guide-slugs.mjs';
import { handleMindbodyStudioApi } from './mindbody-api.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function canonicalPathname(url) {
  let p = url.pathname.replace(/\/$/, '');
  if (!p) p = '/';
  return p;
}

function studioHtmlResponse(html) {
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' }
  });
}

async function htmlForStudioDoc(doc, env, { canonicalUrl, robotsNoIndex }) {
  const gKey = String(env.GOOGLE_API_KEY || '').trim();
  const [{ doc: merged, augmented }, reviews] = await Promise.all([
    enrichStudioWithGooglePlaces(doc, gKey),
    fetchStudioReviews(env, doc.slug),
  ]);
  return buildStudioDetailHtml(merged, { canonicalUrl, robotsNoIndex, googleAugmented: augmented, reviews });
}

async function fetchStudioReviews(env, studioSlug) {
  if (!env.DB || !studioSlug) return [];
  try {
    const rows = await env.DB.prepare(
      'SELECT id, rating, comment, created_at FROM studio_reviews WHERE studio_slug = ? ORDER BY created_at DESC LIMIT 50'
    ).bind(studioSlug).all();
    return rows.results || [];
  } catch {
    return [];
  }
}

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function htmlRes(html, status = 200, extra = {}) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...extra }
  });
}

function redirect(location, status = 302) {
  return new Response(null, { status, headers: { Location: location } });
}

function randomHex(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────────────────────
// Session management (using KV)
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

async function createSession(env, email, userAgent) {
  const id = randomHex(32);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_TTL_SEC;

  // Store in KV (fast auth check)
  await env.SESSIONS.put(id, JSON.stringify({ email, expiresAt }), { expirationTtl: SESSION_TTL_SEC });

  // Store in D1 (audit trail)
  await env.DB.prepare(
    'INSERT INTO admin_sessions (id, email, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, email, now, expiresAt, userAgent || '').run();

  return id;
}

async function getSession(env, request) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)admin_session=([^;]+)/);
  if (!match) return null;

  const id = match[1];
  const raw = await env.SESSIONS.get(id);
  if (!raw) return null;

  const session = JSON.parse(raw);
  if (session.expiresAt < Math.floor(Date.now() / 1000)) {
    await env.SESSIONS.delete(id);
    return null;
  }
  return session;
}

async function deleteSession(env, request) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)admin_session=([^;]+)/);
  if (match) await env.SESSIONS.delete(match[1]);
}

function sessionCookie(id, ttl) {
  return `admin_session=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttl}`;
}

function clearSessionCookie() {
  return 'admin_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

// ─────────────────────────────────────────────────────────────────────────────
// Google OAuth
// ─────────────────────────────────────────────────────────────────────────────

function googleAuthUrl(env, origin) {
  const params = new URLSearchParams({
    client_id:     env.GOOGLE_CLIENT_ID,
    redirect_uri:  `${origin}/auth/callback`,
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'offline',
    prompt:        'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeGoogleCode(env, code, origin) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  `${origin}/auth/callback`,
      grant_type:    'authorization_code',
    }),
  });
  if (!res.ok) throw new Error('Token exchange failed');
  return res.json();
}

async function getGoogleEmail(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error('Failed to get user info');
  const data = await res.json();
  return data.email;
}

function isAllowedEmail(env, email) {
  const allowed = (env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(email.toLowerCase());
}

/** Same rules as requireAuth: dev without KV, or valid session + allowed email. */
async function canPreviewBlogDraft(request, env) {
  if (!env.SESSIONS) return true;
  const session = await getSession(env, request);
  if (!session?.email) return false;
  return isAllowedEmail(env, session.email);
}

// ─────────────────────────────────────────────────────────────────────────────
// Blog generation via Claude
// ─────────────────────────────────────────────────────────────────────────────

// Deterministic image seeds per fitness topic — picsum.photos is free, no API key, always loads
const FITNESS_SEEDS = {
  yoga:       'yoga-studio',
  pilates:    'pilates-class',
  hiit:       'hiit-workout',
  barre:      'barre-dance',
  cycling:    'cycling-bike',
  spin:       'spin-cycling',
  running:    'running-track',
  nutrition:  'healthy-food',
  meditation: 'meditation-calm',
  wellness:   'wellness-spa',
  strength:   'strength-gym',
  dance:      'dance-movement',
  stretching: 'stretching-flex',
  recovery:   'recovery-rest',
  fitness:    'fitness-active',
  default:    'fitness-studio',
};

function unsplashUrl(keyword, w = 1200, h = 520) {
  const raw = String(keyword || 'fitness').trim().toLowerCase();
  const first = raw.split(/[\s,]+/).filter(Boolean)[0] || 'fitness';
  let seed = FITNESS_SEEDS[first];
  if (!seed) {
    // Unique image per keyword when not in the curated map (avoid everyone using FITNESS_SEEDS.default)
    const slug = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    seed = (slug && slug.length <= 64 ? slug : `kw-${simpleHash(raw)}`) || FITNESS_SEEDS.default;
  }
  return `https://picsum.photos/seed/${encodeURIComponent(seed)}/${w}/${h}`;
}

/** Short stable hash for long / odd image_keyword strings (picsum seed). */
function simpleHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return Math.abs(h).toString(36).slice(0, 12);
}

async function generateBlogPost(env, topic, classes, includeQuiz = false) {
  const classContext = classes ? ` The site features classes like: ${classes}.` : '';

  const quizInstructions = includeQuiz ? `
- "quiz": a short 3-question interactive quiz related to the post topic. Use this exact structure:
  {
    "title": "short quiz title",
    "subtitle": "one line description",
    "questions": [
      {
        "question": "question text",
        "options": [
          { "text": "option text", "category": "one of: yoga|pilates|hiit|barre|strength|cardio|wellness" },
          ...4 options
        ]
      }
    ],
    "results": {
      "yoga":     { "title": "Yoga", "description": "1 sentence why this suits them" },
      "pilates":  { "title": "Pilates", "description": "..." },
      "hiit":     { "title": "HIIT Training", "description": "..." },
      "barre":    { "title": "Barre", "description": "..." },
      "strength": { "title": "Strength Training", "description": "..." },
      "cardio":   { "title": "Cardio & Spin", "description": "..." },
      "wellness": { "title": "Yoga & Meditation", "description": "..." }
    }
  }` : '';

  const prompt = `You are a fitness & wellness content writer for Studio Locater, a fitness studio directory app.${classContext}

Write a helpful, engaging blog post about the following topic:
"${topic}"

Requirements:
- Title: compelling, SEO-friendly (under 70 chars)
- Excerpt: 1-2 sentence summary (under 160 chars)
- Body: 450-600 words, formatted as clean HTML using <h2>, <p>, <ul>/<li>. Write with pull-quote-worthy sentences — bold 1-2 standout lines using <strong>.
- Tone: friendly, motivating, practical
- image_keyword: one single English word describing the best Unsplash search term for this post (e.g. yoga, pilates, hiit, cycling, nutrition, meditation, running, barre, strength, wellness)
${includeQuiz ? quizInstructions : '- "quiz": null'}

Respond in this exact JSON format (no markdown, no code fences, raw JSON only):
{
  "title": "...",
  "excerpt": "...",
  "body_html": "...",
  "image_keyword": "...",
  "quiz": ${includeQuiz ? '{...}' : 'null'}
}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: includeQuiz ? 2400 : 1600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error: ${err}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';

  let parsed;
  try {
    const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    throw new Error('Claude returned unparseable JSON. Try again.');
  }

  return {
    title:         parsed.title         || 'Untitled Post',
    excerpt:       parsed.excerpt       || '',
    body_html:     parsed.body_html     || parsed.body || '',
    image_keyword: parsed.image_keyword || 'fitness',
    quiz:          parsed.quiz          || null,
  };
}

async function anthropicJson(env, userPrompt, maxTokens = 1200) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error: ${err}`);
  }
  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Claude returned unparseable JSON. Try again.');
  }
}

/** list → { prompts }; refine → { prompt }; schedule_list → { topics }; schedule_refine → { topics } */
async function handleAdminSuggestPrompts(request, env) {
  await requireAuth(request, env);
  if (!env.ANTHROPIC_API_KEY) return jsonRes({ error: 'ANTHROPIC_API_KEY secret not set.' }, 500);

  const body = await request.json().catch(() => ({}));
  const action  = String(body.action || 'list').toLowerCase();
  const classes = String(body.classes || '').trim();
  const classCtx = classes ? ` Prefer angles that mention or relate to these class types when relevant: ${classes}.` : '';

  if (action === 'schedule_list' || action === 'schedule_topics') {
    const seed = String(body.seed || '').trim();
    const count = Math.min(20, Math.max(5, parseInt(body.count, 10) || 12));
    const seedCtx = seed ? `\nLean toward this theme (broadly): "${seed}".` : '';
    const prompt = `You write ONE-LINE topic entries for an automated blog queue for "Studio Locater", a fitness & wellness studio directory.${classCtx}${seedCtx}

Return exactly ${count} strings. Each string must:
- Be ONE line only (no line breaks inside an item), max 160 characters.
- Work as the sole "topic" passed to an AI that will expand it into a full article — include a clear angle (not just two words).
- Vary angles: class types, choosing studios, motivation, recovery, beginners, community, seasons, myths vs facts, etc.

Respond with raw JSON only:
{"topics":["..."]}`;

    const parsed = await anthropicJson(env, prompt, 1800);
    const topics = Array.isArray(parsed.topics)
      ? parsed.topics.map(t => String(t).trim().replace(/\s+/g, ' ')).filter(Boolean)
      : [];
    if (!topics.length) return jsonRes({ error: 'No topics returned. Try again.' }, 500);
    return jsonRes({ topics });
  }

  if (action === 'schedule_refine') {
    const text = String(body.text || '').trim();
    if (!text) return jsonRes({ error: 'text is required' }, 400);
    const prompt = `You edit a TOPIC POOL for an automated blog schedule at Studio Locater (fitness studio directory). Each line becomes one scheduled post topic.${classCtx}

The editor pasted this (may be messy — duplicates, long paragraphs, bullets):
"""
${text}
"""

Return JSON with key "topics": an array of strings, 5–24 items, one concise topic per string (each suitable as a single prompt for a 400–600 word post). Remove duplicates, split run-on ideas, tighten wording. Each line max 200 characters. No empty strings.

Raw JSON only:
{"topics":["..."]}`;

    const parsed = await anthropicJson(env, prompt, 2000);
    const topics = Array.isArray(parsed.topics)
      ? parsed.topics.map(t => String(t).trim().replace(/\s+/g, ' ')).filter(Boolean)
      : [];
    if (!topics.length) return jsonRes({ error: 'Could not refine list. Try again.' }, 500);
    return jsonRes({ topics });
  }

  if (action === 'refine') {
    const text = String(body.text || body.seed || '').trim();
    if (!text) return jsonRes({ error: 'text is required for refine' }, 400);
    const prompt = `You help an editor who writes blog posts for Studio Locater, a fitness studio directory app.${classCtx}

The editor wrote this rough idea for a post (may be a fragment or bullet list):
"""
${text}
"""

Rewrite it as ONE clear, detailed prompt that another writer could use to produce an 400–600 word article. Include: target reader, tone, 2–4 specific points or sections to cover, and any SEO-friendly angle. Keep it under 1200 characters. Output raw JSON only:
{"prompt":"..."}`;

    const parsed = await anthropicJson(env, prompt, 900);
    const refined = String(parsed.prompt || parsed.refined || '').trim();
    if (!refined) return jsonRes({ error: 'Could not refine prompt. Try again.' }, 500);
    return jsonRes({ prompt: refined });
  }

  const seed = String(body.seed || '').trim();
  const count = Math.min(12, Math.max(3, parseInt(body.count, 10) || 8));
  const seedCtx = seed
    ? `\nSteer topics toward this theme (interpret broadly): "${seed}".`
    : '\nVary themes: studio culture, class formats, motivation, recovery, beginners, seasonal fitness, community, etc.';

  const prompt = `You brainstorm blog post ideas for "Studio Locater", a fitness & wellness studio directory.${classCtx}${seedCtx}

Return exactly ${count} distinct prompts. Each prompt must be 2–4 sentences: concrete angle, what to cover, and why it helps readers pick or enjoy studio classes. No duplicate angles.

Respond with raw JSON only (no markdown):
{"prompts":["..."]}`;

  const parsed = await anthropicJson(env, prompt, 1400);
  const prompts = Array.isArray(parsed.prompts) ? parsed.prompts.map(p => String(p).trim()).filter(Boolean) : [];
  if (!prompts.length) return jsonRes({ error: 'No prompts returned. Try again.' }, 500);
  return jsonRes({ prompts });
}

// ─────────────────────────────────────────────────────────────────────────────
// Blog schedule runner (called from cron)
// ─────────────────────────────────────────────────────────────────────────────

async function runBlogScheduler(env) {
  const now = Math.floor(Date.now() / 1000);

  const schedules = await env.DB.prepare(
    'SELECT * FROM blog_schedule WHERE active = 1 AND (next_run_at IS NULL OR next_run_at <= ?)'
  ).bind(now).all();

  for (const sched of schedules.results) {
    try {
      const pool = JSON.parse(sched.topic_pool || '[]');
      if (!pool.length) continue;

      // Pick next topic (round-robin based on post count)
      const countRow = await env.DB.prepare('SELECT COUNT(*) as c FROM blog_posts WHERE topic IS NOT NULL').first();
      const topicIndex = (countRow?.c || 0) % pool.length;
      const topic = pool[topicIndex];

      const { title, excerpt, body_html, image_keyword } = await generateBlogPost(env, topic, '');
      const slug = slugify(title) + '-' + randomHex(4);
      const status = sched.auto_publish ? 'published' : 'draft';
      const publishedAt = sched.auto_publish ? now : null;

      const inserted = await env.DB.prepare(
        `INSERT INTO blog_posts (slug, title, excerpt, body_html, topic, status, image_keyword, published_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
        .bind(slug, title, excerpt, body_html, topic, status, image_keyword, publishedAt, now, now)
        .first();

      if (status === 'published' && inserted?.id != null) {
        const site = String(env.PUBLIC_SITE_URL || '').trim().replace(/\/$/, '');
        if (site) {
          try {
            await notifySubscribersBlogPublished(env, {
              postId: inserted.id,
              siteOrigin: site,
              slug,
              title,
              excerpt,
            });
          } catch (e) {
            console.error('notifySubscribersBlogPublished (scheduler)', e);
          }
        }
      }

      // Compute next run time
      let nextRun = now;
      if (sched.frequency === 'daily') {
        nextRun += 86400;
      } else if (sched.frequency === 'weekly') {
        nextRun += 7 * 86400;
      } else if (sched.frequency === 'biweekly') {
        nextRun += 14 * 86400;
      }

      await env.DB.prepare(
        'UPDATE blog_schedule SET last_run_at = ?, next_run_at = ? WHERE id = ?'
      ).bind(now, nextRun, sched.id).run();

    } catch (err) {
      console.error('Blog scheduler error for schedule', sched.id, err);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Blog HTML rendering
// ─────────────────────────────────────────────────────────────────────────────

const BLOG_FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;0,700;1,500&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&display=swap" rel="stylesheet">`;
const BLOG_BASE_CSS = `*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}:root{--blush:#F9EAEA;--blush-light:#FDF6F6;--rose:#E8B4B8;--rose-deep:#C97E84;--lavender:#EDE5FA;--lavender-deep:#B39DDB;--gold:#C9A96E;--plum:#3D2B3D;--plum-mid:#6B4C6B;--plum-light:#9E7E9E;--off-white:#FDF8F8;--border:#F0DCE0;--shadow:rgba(61,43,61,0.08);--shadow-md:rgba(61,43,61,0.14);--gradient:linear-gradient(135deg,#C97E84,#B39DDB);}body{font-family:'DM Sans',sans-serif;background:var(--off-white);color:var(--plum);-webkit-font-smoothing:antialiased;}nav{background:rgba(253,248,248,0.92);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);padding:0 40px;height:68px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;}.nav-logo{display:flex;align-items:center;gap:10px;text-decoration:none;}.nav-logo-icon{width:34px;height:34px;border-radius:50%;background:var(--gradient);display:flex;align-items:center;justify-content:center;}.nav-logo-text{font-family:'Playfair Display',serif;font-size:18px;font-weight:600;color:var(--plum);}.nav-link{font-size:13px;color:var(--plum-light);text-decoration:none;font-weight:500;}.nav-link:hover{color:var(--rose-deep);}footer{text-align:center;padding:48px 24px;color:var(--plum-light);font-size:13px;border-top:1px solid var(--border);margin-top:72px;}footer a{color:var(--rose-deep);text-decoration:none;font-weight:600;}.fade-in{opacity:0;transform:translateY(24px);transition:opacity .6s ease,transform .6s ease;}.fade-in.visible{opacity:1;transform:none;}`;

const NAV_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>`;
const FADE_SCRIPT = `<script>const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');io.unobserve(e.target);}}),{threshold:.12});document.querySelectorAll('.fade-in').forEach(el=>io.observe(el));<\/script>`;

function buildBlogIndexHtml(origin, posts) {
  const cards = posts.map((p, i) => {
    const imgUrl = unsplashUrl(p.image_keyword || 'fitness', 800, 420);
    const dateStr = p.published_at ? new Date(p.published_at * 1000).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' }) : '';
    const hasQuiz = !!p.quiz_json;
    return `<article class="post-card fade-in" style="transition-delay:${i * 80}ms">
      <a class="card-image-wrap" href="/blog/${escHtml(p.slug)}" aria-hidden="true" tabindex="-1">
        <img class="card-image" src="${imgUrl}" alt="${escHtml(p.title)}" loading="lazy" width="800" height="420">
        <div class="card-image-overlay"></div>
        ${hasQuiz ? '<span class="quiz-badge">Quiz inside</span>' : ''}
      </a>
      <div class="card-body">
        ${dateStr ? `<div class="post-meta">${dateStr}</div>` : ''}
        <h2><a href="/blog/${escHtml(p.slug)}">${escHtml(p.title)}</a></h2>
        <p class="excerpt">${escHtml(p.excerpt || '')}</p>
        <a class="read-more" href="/blog/${escHtml(p.slug)}">Read more</a>
      </div>
    </article>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fitness &amp; Wellness Blog — Studio Locater</title>
  <meta name="description" content="Fitness tips, class news, and wellness advice from Studio Locater.">
  <link rel="canonical" href="${origin}/blog">
  ${BLOG_FONTS}
  <style>
    ${BLOG_BASE_CSS}
    /* Hero */
    .hero{position:relative;overflow:hidden;background:linear-gradient(155deg,#FDF6F6 0%,#F9EAEA 35%,#EDE5FA 100%);padding:80px 40px 72px;text-align:center;}
    .hero-blob{position:absolute;border-radius:50%;pointer-events:none;}
    .hb1{width:500px;height:500px;background:radial-gradient(circle,rgba(232,180,184,.3) 0%,transparent 70%);top:-100px;right:-80px;}
    .hb2{width:320px;height:320px;background:radial-gradient(circle,rgba(179,157,219,.25) 0%,transparent 70%);bottom:-60px;left:-60px;}
    .hero-tag{font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--rose-deep);font-weight:700;margin-bottom:16px;}
    .hero h1{font-family:'Playfair Display',serif;font-size:48px;font-weight:700;color:var(--plum);margin-bottom:14px;line-height:1.18;}
    .hero p{color:var(--plum-light);font-size:17px;max-width:480px;margin:0 auto 0;line-height:1.65;}
    /* Grid */
    .container{max-width:1080px;margin:0 auto;padding:60px 24px 40px;}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:28px;}
    /* Card */
    .post-card{background:#fff;border:1px solid var(--border);border-radius:20px;overflow:hidden;box-shadow:0 2px 16px var(--shadow);transition:box-shadow .25s,transform .25s;}
    .post-card:hover{box-shadow:0 12px 40px var(--shadow-md);transform:translateY(-4px);}
    .card-image-wrap{display:block;position:relative;height:220px;overflow:hidden;}
    .card-image{width:100%;height:100%;object-fit:cover;transition:transform .5s ease;}
    .post-card:hover .card-image{transform:scale(1.04);}
    .card-image-overlay{position:absolute;inset:0;background:linear-gradient(to bottom,transparent 50%,rgba(61,43,61,.18));}
    .quiz-badge{position:absolute;top:14px;right:14px;background:linear-gradient(135deg,#C97E84,#B39DDB);color:#fff;font-size:11px;font-weight:700;padding:5px 12px;border-radius:20px;letter-spacing:.04em;text-transform:uppercase;}
    .card-body{padding:24px 26px 26px;}
    .post-meta{font-size:11px;color:var(--plum-light);margin-bottom:8px;text-transform:uppercase;letter-spacing:.07em;font-weight:600;}
    .post-card h2{font-family:'Playfair Display',serif;font-size:20px;font-weight:600;margin-bottom:10px;line-height:1.35;}
    .post-card h2 a{color:var(--plum);text-decoration:none;transition:color .15s;}
    .post-card h2 a:hover{color:var(--rose-deep);}
    .excerpt{color:var(--plum-light);font-size:14px;margin-bottom:18px;line-height:1.65;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
    .read-more{display:inline-flex;align-items:center;gap:7px;color:var(--rose-deep);font-size:13px;font-weight:600;text-decoration:none;transition:gap .18s;}
    .read-more::after{content:'→';transition:transform .18s;}
    .read-more:hover::after{transform:translateX(4px);}
    /* Empty */
    .empty{text-align:center;padding:100px 20px;color:var(--plum-light);}
    .empty-icon{width:80px;height:80px;border-radius:50%;background:var(--blush);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;}
    /* Responsive */
    @media(max-width:640px){.hero h1{font-size:34px;}.hero{padding:56px 24px 48px;}.grid{grid-template-columns:1fr;}}
  </style>
</head>
<body>
  <nav>
    <a class="nav-logo" href="/"><div class="nav-logo-icon">${NAV_SVG}</div><span class="nav-logo-text">Studio Locater</span></a>
    <a class="nav-link" href="/">← Studios</a>
  </nav>
  <div class="hero">
    <div class="hero-blob hb1"></div>
    <div class="hero-blob hb2"></div>
    <div class="hero-tag">Wellness &amp; Fitness</div>
    <h1>Tips, Trends<br>&amp; Advice</h1>
    <p>Insights to help you find your perfect class and live your best active life.</p>
  </div>
  <div class="container">
    ${posts.length
      ? `<div class="grid">${cards}</div>`
      : `<div class="empty"><div class="empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#C97E84" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></div><p>No posts published yet — check back soon!</p></div>`
    }
  </div>
  <footer><a href="/">← Studio Locater</a></footer>
  ${FADE_SCRIPT}
</body>
</html>`;
}

function buildBlogPostHtml(origin, post, opts = {}) {
  const draftPreview = opts.draftPreview === true;
  const dateStr = post.published_at
    ? new Date(post.published_at * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : draftPreview && post.created_at
      ? `Draft · ${new Date(post.created_at * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
      : '';

  const heroImg = unsplashUrl(post.image_keyword || 'fitness', 1400, 560);

  // Build quiz HTML if present
  let quizHtml = '';
  if (post.quiz_json) {
    let quiz;
    try { quiz = JSON.parse(post.quiz_json); } catch { quiz = null; }
    if (quiz) {
      const qs = quiz.questions.map((q, qi) => {
        const opts2 = q.options.map((o, oi) => `<button class="quiz-opt" data-q="${qi}" data-cat="${escHtml(o.category)}">${escHtml(o.text)}</button>`).join('');
        return `<div class="quiz-question${qi === 0 ? ' active' : ''}" data-qi="${qi}"><p class="quiz-q-text">${escHtml(q.question)}</p><div class="quiz-opts">${opts2}</div></div>`;
      }).join('');
      const results = Object.entries(quiz.results).map(([cat, r]) =>
        `<div class="quiz-result" data-cat="${escHtml(cat)}"><div class="result-label">Your match</div><h3 class="result-title">${escHtml(r.title)}</h3><p class="result-desc">${escHtml(r.description)}</p><a class="result-cta" href="/?q=${encodeURIComponent(r.title)}">Find ${escHtml(r.title)} studios</a></div>`
      ).join('');
      quizHtml = `
<div class="quiz-wrap fade-in" id="quiz-wrap">
  <div class="quiz-header">
    <div class="quiz-eyebrow">Quick Quiz</div>
    <h2 class="quiz-title">${escHtml(quiz.title)}</h2>
    ${quiz.subtitle ? `<p class="quiz-subtitle">${escHtml(quiz.subtitle)}</p>` : ''}
  </div>
  <div class="quiz-progress-bar"><div class="quiz-progress-fill" id="quiz-progress"></div></div>
  <div class="quiz-body">
    ${qs}
    <div class="quiz-results hidden">${results}</div>
  </div>
  <div class="quiz-actions">
    <button class="quiz-restart hidden" id="quiz-restart">Take it again</button>
  </div>
</div>
<script>
(function(){
  const total=${quiz.questions.length};
  let scores={};
  document.querySelectorAll('.quiz-opt').forEach(btn=>{
    btn.addEventListener('click',function(){
      const qi=parseInt(this.dataset.q), cat=this.dataset.cat;
      scores[cat]=(scores[cat]||0)+1;
      // mark selected
      document.querySelectorAll('.quiz-opt[data-q="'+qi+'"]').forEach(b=>b.classList.remove('selected'));
      this.classList.add('selected');
      // advance
      const next=document.querySelector('.quiz-question[data-qi="'+(qi+1)+'"]');
      setTimeout(()=>{
        document.querySelectorAll('.quiz-question').forEach(q=>q.classList.remove('active'));
        if(next){
          next.classList.add('active');
        } else {
          // show result
          const winner=Object.entries(scores).sort((a,b)=>b[1]-a[1])[0][0];
          document.querySelectorAll('.quiz-result').forEach(r=>r.classList.remove('active'));
          const res=document.querySelector('.quiz-result[data-cat="'+winner+'"]');
          if(res) res.classList.add('active');
          document.querySelector('.quiz-results').classList.remove('hidden');
          document.getElementById('quiz-restart').classList.remove('hidden');
        }
        document.getElementById('quiz-progress').style.width=(Math.min(qi+2,total)/total*100)+'%';
      },280);
    });
  });
  document.getElementById('quiz-restart').addEventListener('click',function(){
    scores={};
    document.querySelectorAll('.quiz-question').forEach((q,i)=>{i===0?q.classList.add('active'):q.classList.remove('active');});
    document.querySelectorAll('.quiz-opt').forEach(b=>b.classList.remove('selected'));
    document.querySelector('.quiz-results').classList.add('hidden');
    document.getElementById('quiz-progress').style.width='0%';
    this.classList.add('hidden');
  });
})();
<\/script>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(post.title)} — Studio Locater Blog</title>
  <meta name="description" content="${escHtml(post.excerpt || '')}">
  ${draftPreview ? '<meta name="robots" content="noindex,nofollow">' : `<link rel="canonical" href="${origin}/blog/${escHtml(post.slug)}">`}
  ${BLOG_FONTS}
  <style>
    ${BLOG_BASE_CSS}
    /* Progress bar */
    #read-progress{position:fixed;top:0;left:0;height:3px;background:var(--gradient);z-index:200;transition:width .1s linear;pointer-events:none;}
    /* Hero image */
    .hero-img-wrap{position:relative;height:480px;overflow:hidden;}
    .hero-img{width:100%;height:100%;object-fit:cover;}
    .hero-img-overlay{position:absolute;inset:0;background:linear-gradient(to bottom,rgba(61,43,61,.18) 0%,rgba(61,43,61,.55) 100%);}
    .hero-text{position:absolute;bottom:0;left:0;right:0;padding:40px 48px;color:#fff;}
    .post-meta-hero{font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:700;margin-bottom:12px;opacity:.85;}
    .hero-title{font-family:'Playfair Display',serif;font-size:42px;font-weight:700;line-height:1.2;max-width:700px;margin:0;}
    /* Content */
    .container{max-width:740px;margin:0 auto;padding:52px 24px 48px;}
    .excerpt-block{font-size:18px;color:var(--plum-light);line-height:1.7;border-left:4px solid var(--rose-deep);padding-left:20px;margin-bottom:40px;font-style:italic;}
    .body{line-height:1.9;font-size:16.5px;color:var(--plum-mid);}
    .body h2{font-family:'Playfair Display',serif;font-size:26px;font-weight:600;margin:44px 0 16px;color:var(--plum);}
    .body p{margin-bottom:22px;}
    .body ul,.body ol{margin-bottom:22px;padding-left:26px;}
    .body li{margin-bottom:10px;}
    .body strong{background:linear-gradient(135deg,rgba(201,126,132,.14),rgba(179,157,219,.14));color:var(--plum);font-weight:600;padding:1px 4px;border-radius:4px;}
    /* Back nav */
    .back-wrap{margin-top:56px;padding-top:36px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;}
    .back-link{display:inline-flex;align-items:center;gap:8px;color:var(--rose-deep);font-size:14px;font-weight:600;text-decoration:none;background:var(--blush);padding:10px 22px;border-radius:50px;border:1px solid var(--rose);transition:all .18s;}
    .back-link:hover{background:var(--rose-deep);color:#fff;border-color:var(--rose-deep);}
    /* Quiz */
    .quiz-wrap{background:#fff;border:1px solid var(--border);border-radius:24px;padding:40px;margin:52px 0;box-shadow:0 4px 24px var(--shadow);}
    .quiz-eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--rose-deep);font-weight:700;margin-bottom:8px;}
    .quiz-title{font-family:'Playfair Display',serif;font-size:26px;font-weight:600;color:var(--plum);margin-bottom:6px;}
    .quiz-subtitle{color:var(--plum-light);font-size:15px;margin-bottom:0;line-height:1.6;}
    .quiz-progress-bar{height:4px;background:var(--border);border-radius:4px;margin:24px 0 28px;overflow:hidden;}
    .quiz-progress-fill{height:100%;background:var(--gradient);border-radius:4px;width:0;transition:width .4s ease;}
    .quiz-question{display:none;}
    .quiz-question.active{display:block;}
    .quiz-q-text{font-family:'Playfair Display',serif;font-size:20px;font-weight:600;color:var(--plum);margin-bottom:20px;line-height:1.4;}
    .quiz-opts{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
    @media(max-width:500px){.quiz-opts{grid-template-columns:1fr;}}
    .quiz-opt{background:var(--blush-light);border:1.5px solid var(--border);border-radius:12px;padding:14px 18px;font-size:14px;font-weight:500;color:var(--plum);cursor:pointer;text-align:left;transition:all .18s;font-family:'DM Sans',sans-serif;}
    .quiz-opt:hover{border-color:var(--rose);background:var(--blush);}
    .quiz-opt.selected{border-color:var(--rose-deep);background:var(--blush);color:var(--rose-deep);}
    .quiz-results{margin-top:8px;}
    .quiz-results.hidden{display:none;}
    .quiz-result{display:none;animation:resultIn .5s ease forwards;}
    .quiz-result.active{display:block;}
    @keyframes resultIn{from{opacity:0;transform:translateY(16px);}to{opacity:1;transform:none;}}
    .result-label{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--rose-deep);font-weight:700;margin-bottom:8px;}
    .result-title{font-family:'Playfair Display',serif;font-size:28px;font-weight:700;color:var(--plum);margin-bottom:10px;}
    .result-desc{color:var(--plum-mid);font-size:15px;line-height:1.65;margin-bottom:20px;}
    .result-cta{display:inline-flex;align-items:center;gap:8px;background:var(--gradient);color:#fff;font-size:14px;font-weight:600;padding:12px 24px;border-radius:50px;text-decoration:none;box-shadow:0 4px 16px rgba(201,126,132,.35);transition:opacity .18s,transform .18s;}
    .result-cta:hover{opacity:.9;transform:translateY(-1px);}
    .quiz-restart{margin-top:20px;background:transparent;border:1.5px solid var(--border);color:var(--plum-light);font-size:13px;padding:8px 18px;border-radius:50px;cursor:pointer;font-family:'DM Sans',sans-serif;transition:all .18s;}
    .quiz-restart:hover{border-color:var(--rose);color:var(--rose-deep);}
    .quiz-restart.hidden{display:none;}
    .quiz-actions{margin-top:8px;}
    /* Responsive */
    @media(max-width:640px){.hero-img-wrap{height:320px;}.hero-title{font-size:28px;}.hero-text{padding:24px;}.container{padding:36px 16px;}.quiz-wrap{padding:28px 20px;}}
  </style>
</head>
<body>
  <div id="read-progress"></div>
  <nav>
    <a class="nav-logo" href="/"><div class="nav-logo-icon">${NAV_SVG}</div><span class="nav-logo-text">Studio Locater</span></a>
    <a class="nav-link" href="/blog">← Blog</a>
  </nav>
  <div class="hero-img-wrap">
    <img class="hero-img" src="${heroImg}" alt="${escHtml(post.title)}" width="1400" height="560" loading="eager">
    <div class="hero-img-overlay"></div>
    <div class="hero-text">
      ${dateStr ? `<div class="post-meta-hero">${escHtml(dateStr)}</div>` : ''}
      <h1 class="hero-title">${escHtml(post.title)}</h1>
    </div>
  </div>
  <div class="container">
    ${post.excerpt ? `<p class="excerpt-block fade-in">${escHtml(post.excerpt)}</p>` : ''}
    <div class="body fade-in">${post.body_html}</div>
    ${quizHtml}
    <div class="back-wrap fade-in">
      <a class="back-link" href="/blog">← All Posts</a>
      <a class="back-link" href="/">Find Studios</a>
    </div>
  </div>
  <footer><a href="/">Studio Locater</a></footer>
  <script>
    const bar=document.getElementById('read-progress');
    window.addEventListener('scroll',()=>{
      const h=document.documentElement,b=document.body,st='scrollTop',sh='scrollHeight';
      const pct=(h[st]||b[st])/((h[sh]||b[sh])-h.clientHeight)*100;
      bar.style.width=Math.min(pct,100)+'%';
    },{passive:true});
  <\/script>
  ${FADE_SCRIPT}
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleAuthGoogle(request, env) {
  if (!env.GOOGLE_CLIENT_ID) {
    return htmlRes('<h1>GOOGLE_CLIENT_ID secret not set. See setup guide.</h1>', 500);
  }
  const url = new URL(request.url);
  return redirect(googleAuthUrl(env, url.origin));
}

async function handleAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) return redirect('/admin?error=denied');

  try {
    const tokens = await exchangeGoogleCode(env, code, url.origin);
    const email  = await getGoogleEmail(tokens.access_token);

    if (!isAllowedEmail(env, email)) {
      return redirect('/admin?error=unauthorized');
    }

    const sessionId = await createSession(env, email, request.headers.get('User-Agent') || '');
    const res = redirect('/admin');
    res.headers.set('Set-Cookie', sessionCookie(sessionId, SESSION_TTL_SEC));
    return res;
  } catch (e) {
    console.error('Auth callback error:', e);
    return redirect('/admin?error=failed');
  }
}

async function handleAuthLogout(request, env) {
  await deleteSession(env, request);
  const res = jsonRes({ ok: true });
  res.headers.set('Set-Cookie', clearSessionCookie());
  return res;
}

async function handleAdminPage(request, env) {
  // Check session — if missing, redirect to Google OAuth
  if (env.SESSIONS) {
    const session = await getSession(env, request);
    if (!session) return redirect('/auth/google');
  }
  // Serve the static admin.html
  return env.ASSETS.fetch(new Request(new URL('/admin.html', new URL(request.url).origin), request));
}

// ── Admin API (all require valid session) ────────────────────────────────────

async function requireAuth(request, env) {
  if (!env.SESSIONS) return { email: 'dev@localhost' }; // dev fallback
  const session = await getSession(env, request);
  if (!session) throw new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401, headers: { 'Content-Type': 'application/json' }
  });
  return session;
}

async function handleAdminMe(request, env) {
  const session = await requireAuth(request, env);
  return jsonRes({ email: session.email });
}

async function handleAdminStats(request, env) {
  await requireAuth(request, env);
  const now   = Math.floor(Date.now() / 1000);
  const d7    = now - 7  * 86400;
  const d30   = now - 30 * 86400;
  const d14   = now - 14 * 86400;

  const [total, last7, last30, prev7, postsRow, dailyRows] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as c FROM user_signups').first(),
    env.DB.prepare('SELECT COUNT(*) as c FROM user_signups WHERE created_at >= ?').bind(d7).first(),
    env.DB.prepare('SELECT COUNT(*) as c FROM user_signups WHERE created_at >= ?').bind(d30).first(),
    env.DB.prepare('SELECT COUNT(*) as c FROM user_signups WHERE created_at >= ? AND created_at < ?').bind(d14, d7).first(),
    env.DB.prepare("SELECT COUNT(*) as c FROM blog_posts WHERE status = 'published'").first(),
    env.DB.prepare(
      `SELECT date(created_at, 'unixepoch') as date, COUNT(*) as count
       FROM user_signups WHERE created_at >= ? GROUP BY date ORDER BY date`
    ).bind(d30).all(),
  ]);

  return jsonRes({
    total:           total?.c  || 0,
    last7:           last7?.c  || 0,
    last30:          last30?.c || 0,
    prev7:           prev7?.c  || 0,
    published_posts: postsRow?.c || 0,
    daily:           dailyRows.results || [],
  });
}

async function handleAdminListBlogs(request, env) {
  await requireAuth(request, env);
  const rows = await env.DB.prepare(
    'SELECT id, slug, title, excerpt, topic, status, published_at, created_at FROM blog_posts ORDER BY created_at DESC LIMIT 100'
  ).all();
  return jsonRes({ posts: rows.results || [] });
}

async function handleAdminGenerateBlog(request, env) {
  await requireAuth(request, env);
  const body = await request.json().catch(() => ({}));
  const topic       = String(body.topic   || '').trim();
  const classes     = String(body.classes || '').trim();
  const includeQuiz = !!body.include_quiz;

  if (!topic) return jsonRes({ error: 'topic is required' }, 400);
  if (!env.ANTHROPIC_API_KEY) return jsonRes({ error: 'ANTHROPIC_API_KEY secret not set.' }, 500);

  const { title, excerpt, body_html, image_keyword, quiz } = await generateBlogPost(env, topic, classes, includeQuiz);
  const slug     = slugify(title) + '-' + randomHex(4);
  const now      = Math.floor(Date.now() / 1000);
  const quizJson = quiz ? JSON.stringify(quiz) : null;

  const result = await env.DB.prepare(
    `INSERT INTO blog_posts (slug, title, excerpt, body_html, topic, status, image_keyword, quiz_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?) RETURNING *`
  ).bind(slug, title, excerpt, body_html, topic, image_keyword, quizJson, now, now).first();

  return jsonRes({ post: result });
}

async function handleAdminPatchBlog(request, env, id, ctx) {
  await requireAuth(request, env);
  const body   = await request.json().catch(() => ({}));
  const status = body.status;
  if (!['published', 'draft'].includes(status)) return jsonRes({ error: 'Invalid status' }, 400);

  const prev = await env.DB.prepare('SELECT status, slug, title, excerpt FROM blog_posts WHERE id = ?')
    .bind(id)
    .first();
  if (!prev) return jsonRes({ error: 'not_found' }, 404);

  const now = Math.floor(Date.now() / 1000);
  const publishedAt = status === 'published' ? now : null;

  await env.DB.prepare(
    'UPDATE blog_posts SET status = ?, published_at = ?, updated_at = ? WHERE id = ?'
  ).bind(status, publishedAt, now, id).run();

  if (status === 'published' && prev.status !== 'published') {
    const origin = new URL(request.url).origin;
    const notify = notifySubscribersBlogPublished(env, {
      postId: id,
      siteOrigin: origin,
      slug: prev.slug,
      title: prev.title,
      excerpt: prev.excerpt,
    });
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(notify);
    else notify.catch((e) => console.error('notifySubscribersBlogPublished', e));
  }

  return jsonRes({ ok: true });
}

async function handleAdminDeleteBlog(request, env, id) {
  await requireAuth(request, env);
  await env.DB.prepare('DELETE FROM blog_posts WHERE id = ?').bind(id).run();
  return jsonRes({ ok: true });
}

async function handleAdminGetSchedule(request, env) {
  await requireAuth(request, env);
  const row = await env.DB.prepare('SELECT * FROM blog_schedule ORDER BY id DESC LIMIT 1').first();
  return jsonRes({ schedule: row || null });
}

async function handleAdminSaveSchedule(request, env) {
  await requireAuth(request, env);
  const body = await request.json().catch(() => ({}));
  const { topic_pool, frequency, day_of_week, auto_publish, active } = body;

  if (!Array.isArray(topic_pool) || !topic_pool.length) {
    return jsonRes({ error: 'topic_pool must be a non-empty array' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const existing = await env.DB.prepare('SELECT id FROM blog_schedule LIMIT 1').first();

  if (existing) {
    await env.DB.prepare(
      `UPDATE blog_schedule SET topic_pool=?, frequency=?, day_of_week=?, auto_publish=?, active=? WHERE id=?`
    ).bind(JSON.stringify(topic_pool), frequency || 'weekly', day_of_week ?? 1, auto_publish ? 1 : 0, active ? 1 : 0, existing.id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO blog_schedule (topic_pool, frequency, day_of_week, auto_publish, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(JSON.stringify(topic_pool), frequency || 'weekly', day_of_week ?? 1, auto_publish ? 1 : 0, active ? 1 : 0, now).run();
  }

  return jsonRes({ ok: true });
}

async function handleTrackSignup(request, env) {
  // Public endpoint — no auth required. Called from your main site when a user registers.
  const body = await request.json().catch(() => ({}));
  const source   = String(body.source   || '').slice(0, 100);
  const metadata = body.metadata ? JSON.stringify(body.metadata).slice(0, 500) : null;
  // Legacy hash (optional dedupe / analytics)
  let emailHash = null;
  let emailPlain = null;
  if (body.email) {
    const normalized = String(body.email).toLowerCase().trim().slice(0, 254);
    if (normalized) {
      emailPlain = normalized;
      const enc = new TextEncoder().encode(normalized);
      const hash = await crypto.subtle.digest('SHA-256', enc);
      emailHash = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    }
  }
  // One signup per email (unique index on email_address); duplicates are ignored.
  await env.DB.prepare(
    'INSERT OR IGNORE INTO user_signups (email, source, metadata, email_address) VALUES (?, ?, ?, ?)'
  ).bind(emailHash, source, metadata, emailPlain).run();
  return jsonRes({ ok: true });
}

async function handleAdminListSignups(request, env) {
  await requireAuth(request, env);
  const url = new URL(request.url);
  let limit = parseInt(url.searchParams.get('limit') || '200', 10);
  if (Number.isNaN(limit) || limit < 1) limit = 200;
  limit = Math.min(500, limit);
  const rows = await env.DB.prepare(
    `SELECT id, created_at, source, metadata, email, email_address
     FROM user_signups ORDER BY created_at DESC LIMIT ?`
  )
    .bind(limit)
    .all();
  return jsonRes({ signups: rows.results || [] });
}

async function handlePublicBlogPostsJson(request, env) {
  const rows = await env.DB.prepare(
    "SELECT slug, title FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 12"
  ).all();
  return new Response(JSON.stringify({ posts: rows.results || [] }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=120',
    },
  });
}

/** Homepage cards: fill review counts from Place Details when CMS/Nearby omitted them. */
const PLACE_META_MAX_IDS = 24;

async function fetchPlaceReviewMetaBatch(env, placeIds) {
  const key = String(env.GOOGLE_API_KEY || '').trim();
  const out = {};
  if (!key || !placeIds.length) return out;
  const unique = [...new Set(placeIds.map(p => String(p).trim()).filter(Boolean))].slice(0, PLACE_META_MAX_IDS);
  const concurrency = 6;
  for (let i = 0; i < unique.length; i += concurrency) {
    const slice = unique.slice(i, i + concurrency);
    await Promise.all(
      slice.map(async pid => {
        try {
          const u =
            `https://maps.googleapis.com/maps/api/place/details/json?` +
            `place_id=${encodeURIComponent(pid)}&fields=rating%2Cuser_ratings_total&key=${encodeURIComponent(key)}`;
          const res = await fetch(u);
          if (!res.ok) return;
          const data = await res.json();
          if (data.status !== 'OK' || !data.result) return;
          const r = data.result;
          const reviews =
            typeof r.user_ratings_total === 'number' && Number.isFinite(r.user_ratings_total)
              ? r.user_ratings_total
              : 0;
          const rating =
            typeof r.rating === 'number' && Number.isFinite(r.rating) ? Math.round(r.rating * 10) / 10 : null;
          out[pid] = { rating, reviews };
        } catch {
          /* skip */
        }
      })
    );
  }
  return out;
}

async function handlePlaceMetaPost(request, env) {
  const body = await request.json().catch(() => ({}));
  const raw = Array.isArray(body.placeIds) ? body.placeIds : [];
  const ids = [...new Set(raw.map(x => String(x).trim()).filter(Boolean))].slice(0, PLACE_META_MAX_IDS);
  if (!ids.length) return jsonRes({ meta: {} });
  const meta = await fetchPlaceReviewMetaBatch(env, ids);
  return jsonRes({ meta });
}

async function handleBlogIndex(request, env) {
  const rows = await env.DB.prepare(
    "SELECT id, slug, title, excerpt, published_at, image_keyword FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 20"
  ).all();
  const html = buildBlogIndexHtml(new URL(request.url).origin, rows.results || []);
  return htmlRes(html);
}

async function handleBlogPost(request, env, slug) {
  // Slug is already decoded by the route matcher.
  const post = await env.DB.prepare('SELECT * FROM blog_posts WHERE slug = ?').bind(slug).first();
  if (!post) return htmlRes('<h1>Post not found</h1>', 404);

  if (post.status === 'published') {
    return htmlRes(buildBlogPostHtml(new URL(request.url).origin, post));
  }

  if (!(await canPreviewBlogDraft(request, env))) {
    return htmlRes('<h1>Post not found</h1>', 404);
  }

  const html = buildBlogPostHtml(new URL(request.url).origin, post, { draftPreview: true });
  return htmlRes(html, 200, { 'Cache-Control': 'private, no-store' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Class Guide pages
// ─────────────────────────────────────────────────────────────────────────────

const CLASS_GUIDE = {
  yoga: {
    name:'Yoga', filter:'Yoga', icon:'fa-person-praying', color:'#7B5EA7', bg:'var(--lavender)',
    tagline:'Find your flow. Calm your mind.',
    description:'Yoga is one of the most versatile fitness practices in the world. From gentle restorative classes to vigorous power flows, every style offers a unique blend of movement, breath, and mindfulness.',
    benefits:['Improves flexibility and range of motion','Builds core and functional strength','Reduces stress and anxiety','Enhances mind-body connection','Supports joint health and mobility'],
    whatToExpect:'Most classes run 60–90 minutes. Wear comfortable, stretchy clothing. Expect a blend of breathwork, flowing sequences, held poses, and a final relaxation (Savasana). Mats are usually available to borrow.',
    difficulty:'Beginner-friendly', duration:'60–90 min', calories:'200–400 kcal',
    gear:'Yoga mat, comfortable stretchy clothes',
    styles:['Vinyasa','Hatha','Yin','Restorative','Ashtanga','Kundalini','Power Yoga'],
    image:'yoga',
  },
  'hot-yoga': {
    name:'Hot Yoga', filter:'Hot Yoga', icon:'fa-fire', color:'#C44040', bg:'#FFE8E8',
    tagline:'Turn up the heat. Sweat it out.',
    description:'Hot yoga takes place in a room heated to 80–105°F. The warmth loosens muscles for deeper stretching, amplifies calorie burn, and creates an intense detoxifying sweat session that clears both body and mind.',
    benefits:['Deeper flexibility from the heat','Elevated calorie burn','Improved cardiovascular endurance','Detoxification through intense sweat','Mental toughness and focus'],
    whatToExpect:'Bring a large water bottle — you\'ll need it. Wear moisture-wicking clothing. Arrive 10–15 min early to acclimate. Beginners may prefer the back row. Classes run 60–90 min.',
    difficulty:'Intermediate', duration:'60–90 min', calories:'400–600 kcal',
    gear:'Large water bottle, sweat towel, moisture-wicking clothes',
    styles:['Bikram (26-pose series)','Hot Vinyasa','Hot Hatha','Hot Power Flow','Heated Yin'],
    image:'yoga',
  },
  pilates: {
    name:'Pilates', filter:'Pilates', icon:'fa-person-walking', color:'#C97E84', bg:'var(--blush)',
    tagline:'Core strength meets graceful movement.',
    description:'Pilates focuses on developing deep core strength, improving posture, and building long, lean muscle. Originally developed by Joseph Pilates, it\'s used by dancers, athletes, and rehab patients worldwide.',
    benefits:['Deep core strength and stability','Improved posture and alignment','Longer, leaner muscle tone','Injury prevention and rehabilitation','Reduced back and joint pain'],
    whatToExpect:'Mat classes need only your body weight; reformer classes use a spring-loaded machine. Classes are typically 45–60 minutes. Wear form-fitting clothes so instructors can check your alignment.',
    difficulty:'All levels', duration:'45–60 min', calories:'175–375 kcal',
    gear:'Grip socks (for reformer), form-fitting clothes',
    styles:['Mat Pilates','Reformer Pilates','Clinical Pilates','Contemporary Pilates','Tower Pilates'],
    image:'pilates',
  },
  reformer: {
    name:'Reformer Pilates', filter:'Pilates', icon:'fa-sliders', color:'#8B6C14', bg:'var(--gold-light)',
    tagline:'Spring-loaded strength and sculpt.',
    description:'Reformer Pilates uses a sliding carriage with spring resistance to deliver a full-body workout unlike anything else. The machine allows infinite variations — making it ideal for every fitness level.',
    benefits:['Variable resistance for any level','Full-body strength and toning','Improved coordination and balance','Joint-friendly low-impact workout','Faster visible results than mat Pilates alone'],
    whatToExpect:'Classes are typically small (8–16 people) for personalized instruction. Grip socks are almost always required. Sessions run 50–60 minutes. Expect to feel muscles you didn\'t know existed.',
    difficulty:'All levels', duration:'50–60 min', calories:'250–450 kcal',
    gear:'Grip socks (usually required), form-fitting clothes',
    styles:['Classical Reformer','Contemporary Reformer','Megaformer','Clinical Reformer','Tower Pilates'],
    image:'pilates',
  },
  barre: {
    name:'Barre', filter:'Barre', icon:'fa-music', color:'#4C7A4C', bg:'#E6F0E6',
    tagline:'Ballet-inspired. Burn-inducing.',
    description:'Barre fuses ballet technique with Pilates, yoga, and strength training. Small isometric movements at the ballet barre target muscles in ways traditional exercise can\'t — creating the signature "barre shake."',
    benefits:['Sculpts legs, glutes, and core','Improves posture and balance','Builds endurance through repetition','Low-impact yet highly effective','No dance experience needed'],
    whatToExpect:'Classes run 45–60 min. Wear grip socks and form-fitting clothes. Be prepared for small pulsing movements that create a deep, satisfying burn. Most studios have a ballet barre along the wall.',
    difficulty:'All levels', duration:'45–60 min', calories:'250–400 kcal',
    gear:'Grip socks, form-fitting leggings and top',
    styles:['Pure Barre','Ballet Barre','Cardio Barre','Barre Fusion','Barre3','Pop Physique'],
    image:'barre',
  },
  lagree: {
    name:'Lagree / Megaformer', filter:'Lagree', icon:'fa-grip-lines-vertical', color:'#5B4B8A', bg:'#EDE8F5',
    tagline:'Slow burn. Maximum results.',
    description:'Lagree Fitness uses the proprietary Megaformer machine to deliver slow, controlled movements that simultaneously build strength, endurance, burn fat, and increase flexibility — all in one 50-minute session.',
    benefits:['Simultaneous cardio + strength','Lean muscle without bulk','Minimal rest maximizes calorie burn','Low impact on joints','Celebrity-favorite results in 50 minutes'],
    whatToExpect:'Classes are exactly 50 minutes of continuous movement with minimal rest. Grip socks are required. The Megaformer has springs and cables for resistance. Prepare to shake — a lot.',
    difficulty:'Intermediate–Advanced', duration:'50 min', calories:'350–600 kcal',
    gear:'Grip socks (required), fitted athletic wear',
    styles:['Lagree Fitness','Megaformer Pilates','SLT (Strengthen Lengthen Tone)','Supraformer'],
    image:'pilates',
  },
  solidcore: {
    name:'Solidcore', filter:'Solidcore', icon:'fa-bolt', color:'#1E6B6B', bg:'#E8F4F4',
    tagline:'Slow. Hard. Transformative.',
    description:'Solidcore\'s [solidcore] method uses a proprietary machine with unstable springs to push slow-twitch muscles to complete failure in 50 intense minutes. It\'s unlike anything else in boutique fitness.',
    benefits:['Builds slow-twitch muscle fibers for lasting tone','Lean, defined physique','Boosts resting metabolism long-term','Strengthens deep stabilizer muscles','Performance tracking every class'],
    whatToExpect:'Classes are exactly 50 min. Coaches are hands-on and motivating. The machine is unique — each class targets specific muscle groups. Expect to be humbled your first few sessions.',
    difficulty:'Challenging', duration:'50 min', calories:'300–500 kcal',
    gear:'Grip socks (required), fitted clothes',
    styles:['[solidcore] method'],
    image:'strength',
  },
  infrared: {
    name:'Infrared', filter:'Infrared', icon:'fa-sun', color:'#C45C26', bg:'#FFF0E6',
    tagline:'Heal from the inside out.',
    description:'Infrared studios use light energy that penetrates deep into muscle tissue — warming your body from within rather than heating the air. This enables deeper stretching, cellular detoxification, and recovery at more comfortable temperatures than traditional hot yoga.',
    benefits:['Deep tissue warmth (not just hot air)','Detoxification at the cellular level','Reduced inflammation and chronic pain','Improved circulation','Comfortable temp (~90°F vs. 105°F hot yoga)'],
    whatToExpect:'Expect a warm but not overwhelming studio (85–95°F). The warmth is gentler than traditional hot yoga. You\'ll still sweat, but without the oppressive heat. Great intro to heated classes.',
    difficulty:'All levels', duration:'45–75 min', calories:'200–400 kcal',
    gear:'Moisture-wicking clothes, water bottle, small towel',
    styles:['Infrared Yoga','Infrared Pilates','Infrared Barre','Infrared Sauna Classes','Infrared Hot Yoga'],
    image:'wellness',
  },
  meditation: {
    name:'Meditation', filter:'Meditation', icon:'fa-brain', color:'#4C5CAE', bg:'#E8EAF8',
    tagline:'Train your mind like you train your body.',
    description:'Meditation studios offer guided sessions to reduce stress, improve focus, and cultivate inner calm. From breathwork to sound baths, these spaces provide dedicated time to quiet the noise of daily life.',
    benefits:['Reduces stress and anxiety measurably','Improves focus and mental clarity','Better sleep quality','Emotional regulation and resilience','Lower blood pressure'],
    whatToExpect:'Sessions vary from 20–60 minutes. You\'ll sit or lie comfortably while an instructor guides your awareness. Some studios use singing bowls, guided visualization, or breathwork techniques.',
    difficulty:'Everyone', duration:'20–60 min', calories:'40–80 kcal',
    gear:'Comfortable clothes (bring layers)',
    styles:['Guided Meditation','Mindfulness MBSR','Sound Bath','Breathwork','Transcendental Meditation','Body Scan'],
    image:'meditation',
  },
  hiit: {
    name:'HIIT', filter:'HIIT', icon:'fa-bolt-lightning', color:'#B03A2E', bg:'#FDECEC',
    tagline:'Work hard. Rest less. See results.',
    description:'High-Intensity Interval Training alternates short bursts of maximum effort with brief recovery periods. HIIT is scientifically proven to burn more calories in less time and boost metabolism for hours after class.',
    benefits:['Burns up to 30% more calories than steady cardio','Continues burning calories post-workout (EPOC effect)','Builds cardiovascular fitness fast','Preserves lean muscle while burning fat','Effective in 20–45 minutes'],
    whatToExpect:'Classes range from 20–45 min of alternating all-out effort and short recovery. Exercises include burpees, sprints, jump squats, kettlebell swings, and more. Push to your limit — then recover.',
    difficulty:'Intermediate–Advanced', duration:'20–45 min', calories:'400–700 kcal',
    gear:'Supportive cross-training shoes, water bottle, towel',
    styles:['Tabata','Circuit Training','OrangeTheory-style','Barry\'s Bootcamp-style','CrossFit WODs'],
    image:'hiit',
  },
  cycling: {
    name:'Cycling / Spin', filter:'Cycling', icon:'fa-person-biking', color:'#1A5276', bg:'#D6EAF8',
    tagline:'Ride to the rhythm. Feel the burn.',
    description:'Indoor cycling classes use stationary bikes to deliver an exhilarating cardio workout. From dark rooms with pumping music (SoulCycle-style) to gamified platforms, there\'s a spin class for every personality.',
    benefits:['Low-impact, joint-friendly cardio','Burns 400–600 calories per class','Builds leg strength and endurance','Easy to scale for all fitness levels','Energizing group atmosphere'],
    whatToExpect:'Classes are 45–60 minutes. Cycling shoes with SPD clips are ideal (many studios provide them). Bring water and a towel — you\'ll sweat. Instructors guide resistance changes and cadence to music.',
    difficulty:'All levels', duration:'45–60 min', calories:'400–600 kcal',
    gear:'Cycling shoes (or trainers), padded shorts optional',
    styles:['SoulCycle-style','Rhythm Cycling','Power Cycling','Endurance Rides','Peloton-style'],
    image:'cycling',
  },
  boxing: {
    name:'Boxing & Kickboxing', filter:'Boxing', icon:'fa-hand-fist', color:'#7D3C98', bg:'#F4ECF7',
    tagline:'Hit harder. Stress less.',
    description:'Boxing and kickboxing studios offer fitness-focused classes that build strength, agility, and cardiovascular endurance through bag work and technique training — no sparring required, ever.',
    benefits:['Full-body strength and coordination','Exceptional stress relief','Burns 500–800 calories per class','Builds confidence and discipline','Improves reflexes and agility'],
    whatToExpect:'Expect a high-energy class with punching bag work, footwork drills, and core exercises. Classes are 45–60 min. Hand wraps or gloves are usually provided. No prior boxing experience needed.',
    difficulty:'All levels', duration:'45–60 min', calories:'500–800 kcal',
    gear:'Hand wraps or boxing gloves, supportive shoes',
    styles:['Fitness Boxing','Kickboxing','Muay Thai Fitness','Title Boxing-style','Shadow Boxing','Rumble Boxing'],
    image:'hiit',
  },
  dance: {
    name:'Dance Fitness', filter:'Dance', icon:'fa-music', color:'#922B21', bg:'#FDEDEC',
    tagline:"Move like nobody's watching.",
    description:'Dance fitness classes make cardio feel like a party. From Latin-inspired Zumba to hip-hop choreography, these classes combine the joy of dancing with the benefits of a real, intense workout.',
    benefits:['High-calorie cardio that doesn\'t feel like exercise','Improves rhythm, coordination, and balance','Boosts mood through music and movement','No dance experience required','Full-body conditioning'],
    whatToExpect:'Classes are 45–60 minutes of continuous movement to music. Expect simple-to-follow choreography that builds in intensity. Sneakers with some pivoting capability are helpful.',
    difficulty:'All levels', duration:'45–60 min', calories:'300–600 kcal',
    gear:'Supportive dance sneakers, breathable clothing',
    styles:['Zumba','Hip Hop Fitness','Cardio Dance','Latin Dance Fitness','Ballet Fusion','Jazzercise'],
    image:'dance',
  },
  aerial: {
    name:'Aerial & Acro', filter:'Aerial', icon:'fa-wand-magic-sparkles', color:'#6B4C7A', bg:'#F5EEF8',
    tagline:'Defy gravity. Discover strength.',
    description:'Aerial fitness classes use silk hammocks, trapeze, or hoop (lyra) suspended from the ceiling. These classes build incredible upper body and core strength while delivering a magical, circus-inspired experience.',
    benefits:['Builds serious upper body and grip strength','Develops spatial awareness and courage','Core strength unlike any floor workout','Increases flexibility in a fun context','Unique, confidence-building experience'],
    whatToExpect:'Beginners start close to the ground with a skilled instructor prioritizing safety at every step. Wear form-fitting clothes without zippers or buttons. Avoid lotion on arms and legs — you need grip.',
    difficulty:'Beginner–Advanced', duration:'60–90 min', calories:'300–500 kcal',
    gear:'Form-fitting clothes (no zippers/buttons), no lotion on skin',
    styles:['Aerial Silk','Aerial Hoop (Lyra)','Flying Trapeze','Aerial Yoga','Hammock Yoga','Aerial Barre'],
    image:'fitness',
  },
  stretch: {
    name:'Stretch & Recovery', filter:'Stretch', icon:'fa-person-rays', color:'#1E8449', bg:'#E9F7EF',
    tagline:'Move better. Feel better. Recover faster.',
    description:'Dedicated stretch and recovery studios focus on improving mobility, flexibility, and active recovery. These classes use assisted stretching, foam rolling, and therapeutic techniques to help your body repair and perform its best.',
    benefits:['Faster muscle recovery between workouts','Improved range of motion over time','Reduced chronic pain and tension','Better posture and alignment','Injury prevention and prehab'],
    whatToExpect:'Sessions are calm and intentional. A practitioner may assist with deeper stretches. Classes last 45–60 min. Each stretch is held 30–90 seconds. Wear comfortable, loose or stretchy clothing.',
    difficulty:'All levels', duration:'45–60 min', calories:'80–150 kcal',
    gear:'Comfortable loose clothing, yoga mat',
    styles:['Assisted Stretching','Yin Yoga','Mobility Training','Foam Rolling','PNF Stretching','Fascial Stretch Therapy'],
    image:'stretching',
  },
  strength: {
    name:'Strength & Conditioning', filter:'Strength', icon:'fa-dumbbell', color:'#2C3E50', bg:'#EAECEE',
    tagline:'Get strong. Stay strong.',
    description:'Strength and conditioning studios provide coach-led group classes focused on building functional strength, power, and athleticism. Unlike traditional gyms, these classes offer programming, coaching, and community.',
    benefits:['Builds lean muscle and bone density','Boosts resting metabolism long-term','Functional strength for everyday life','Structured programming removes guesswork','Supportive group environment'],
    whatToExpect:'Classes use barbells, dumbbells, kettlebells, and bodyweight. Sessions run 45–60 min: warm-up, skill work, then workout. Coaches ensure proper form. All levels welcome — weights are always scaled.',
    difficulty:'All levels', duration:'45–60 min', calories:'300–550 kcal',
    gear:'Athletic shoes, comfortable workout clothes',
    styles:['CrossFit','Olympic Lifting','Functional Fitness','Bootcamp','Kettlebell Training','AMRAP-style'],
    image:'strength',
  },
};

// Maps URL tag slug → display info for city landing pages (derived from CLASS_GUIDE)
const CITY_PAGE_TAGS = Object.fromEntries(
  Object.entries(CLASS_GUIDE).map(([slug, c]) => [slug, {
    tagName: c.name,
    sanityTag: c.filter,
    icon: c.icon,
    color: c.color,
    bg: c.bg,
  }])
);
// Longest slugs first so "hot-yoga" matches before "yoga"
const CITY_PAGE_TAG_SLUGS = Object.keys(CITY_PAGE_TAGS).sort((a, b) => b.length - a.length);

async function handleCityPage(request, env, tagSlug, locationSlug) {
  const url = new URL(request.url);
  const origin = String(url.origin || '').replace(/\/$/, '') || 'https://studiolocater.com';
  const tagInfo = CITY_PAGE_TAGS[tagSlug];
  if (!tagInfo) {
    return new Response(buildStudioNotFoundHtml(`${url.origin}/`), {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=120' }
    });
  }
  const projectId = env.SANITY_PROJECT_ID || 't0z5ndwm';
  const dataset   = env.SANITY_DATASET    || 'production';
  try {
    // Try city first; fall back to neighborhood
    let studios = await fetchStudiosByCity(locationSlug, tagInfo.sanityTag, projectId, dataset);
    if (studios.length === 0) {
      studios = await fetchStudiosByNeighborhood(locationSlug, tagInfo.sanityTag, projectId, dataset);
    }
    if (studios.length === 0) {
      return new Response(buildStudioNotFoundHtml(`${url.origin}/`), {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' }
      });
    }
    const locationDisplayName = citySlugToDisplay(locationSlug);
    const html = buildCityPageHtml(studios, {
      tagSlug, tagName: tagInfo.tagName, tagIcon: tagInfo.icon,
      tagColor: tagInfo.color, tagBg: tagInfo.bg,
      citySlug: locationSlug, cityDisplayName: locationDisplayName, origin,
    });
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
    });
  } catch {
    return new Response('Server error', { status: 500, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function handleNearMePage(request, env, tagSlug) {
  const url = new URL(request.url);
  const origin = String(url.origin || '').replace(/\/$/, '') || 'https://studiolocater.com';
  const tagInfo = CITY_PAGE_TAGS[tagSlug];
  if (!tagInfo) return new Response('Not found', { status: 404 });

  const canonicalUrl = `${origin}/${tagSlug}-studios-near-me`;
  const title = `${tagInfo.tagName} Studios Near Me | Studio Locater`;
  const metaDesc = `Find ${tagInfo.tagName.toLowerCase()} studios near your current location. Studio Locater detects your city and shows you the best local options.`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtml(title)}</title>
  <meta name="description" content="${escHtml(metaDesc)}">
  <link rel="canonical" href="${escHtml(canonicalUrl)}">
  <meta property="og:title" content="${escHtml(title)}">
  <meta property="og:description" content="${escHtml(metaDesc)}">
  <meta property="og:url" content="${escHtml(canonicalUrl)}">
  <link rel="icon" href="/favicon.svg?v=6" type="image/svg+xml" sizes="any">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,600;0,700;1,600&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    :root{--blush:#F9EAEA;--rose-deep:#C97E84;--lavender-deep:#B39DDB;
      --plum:#3D2B3D;--plum-mid:#6B4C6B;--plum-light:#9E7E9E;--off-white:#FDF8F8;--border:#F0DCE0;--shadow:rgba(61,43,61,0.08);}
    body{font-family:'DM Sans',sans-serif;background:var(--off-white);color:var(--plum);line-height:1.6;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
    .card{background:#fff;border:1px solid var(--border);border-radius:24px;padding:48px 40px;max-width:460px;width:100%;text-align:center;box-shadow:0 8px 40px var(--shadow);}
    .icon{width:80px;height:80px;border-radius:22px;display:flex;align-items:center;justify-content:center;font-size:32px;margin:0 auto 24px;}
    h1{font-family:'Playfair Display',serif;font-size:clamp(24px,4vw,30px);font-weight:700;color:var(--plum);margin-bottom:10px;line-height:1.2;}
    h1 em{font-style:italic;color:var(--rose-deep);}
    .sub{font-size:15px;color:var(--plum-mid);margin-bottom:28px;}
    .status{font-size:14px;color:var(--plum-light);margin-bottom:20px;min-height:22px;}
    .spinner{display:inline-block;width:16px;height:16px;border:2px solid #eee;border-top-color:var(--rose-deep);border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:6px;}
    @keyframes spin{to{transform:rotate(360deg)}}
    .manual-form{margin-top:20px;display:none;}
    .manual-form p{font-size:13px;color:var(--plum-light);margin-bottom:10px;}
    .manual-input{width:100%;border:1.5px solid var(--border);border-radius:12px;padding:11px 14px;font-size:15px;font-family:inherit;color:var(--plum);outline:none;margin-bottom:10px;}
    .manual-input:focus{border-color:var(--rose-deep);}
    .manual-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;
      background:linear-gradient(135deg,var(--rose-deep),var(--lavender-deep));color:#fff;border:none;
      border-radius:50px;padding:12px 28px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;transition:opacity .2s;}
    .manual-btn:hover{opacity:.88;}
    .back{display:block;margin-top:20px;font-size:13px;color:var(--rose-deep);text-decoration:none;}
    .back:hover{text-decoration:underline;}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon" style="background:${tagInfo.bg}"><i class="fa-solid ${tagInfo.icon}" style="color:${tagInfo.color}"></i></div>
    <h1>Find <em>${escHtml(tagInfo.tagName)}</em> Studios<br>Near You</h1>
    <p class="sub">We'll detect your city and show you the best nearby studios.</p>
    <p class="status" id="status"><span class="spinner"></span> Detecting your location…</p>
    <div class="manual-form" id="manual-form">
      <p>Or enter your city:</p>
      <input class="manual-input" id="city-input" type="text" placeholder="e.g. Austin, Chicago, Brooklyn" autocomplete="off">
      <button class="manual-btn" id="manual-btn"><i class="fa-solid fa-magnifying-glass"></i> Find Studios</button>
    </div>
    <a class="back" href="/">← Browse all studios</a>
  </div>
  <script>
  (function(){
    var tagSlug=${JSON.stringify(tagSlug)};
    var statusEl=document.getElementById('status');
    var manualForm=document.getElementById('manual-form');
    function slugify(s){return s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');}
    function goTo(citySlug){if(citySlug)window.location.replace('/'+tagSlug+'-studios-'+citySlug);}
    function showManual(msg){statusEl.textContent=msg||'';manualForm.style.display='block';}
    function onGeoSuccess(pos){
      statusEl.innerHTML='<span class="spinner"></span> Finding studios…';
      fetch('/api/geocode?lat='+pos.coords.latitude+'&lng='+pos.coords.longitude)
        .then(function(r){return r.json();})
        .then(function(d){d.city?goTo(d.city):showManual('Could not identify your city.');})
        .catch(function(){showManual('Location lookup failed.');});
    }
    if(navigator.geolocation){
      navigator.geolocation.getCurrentPosition(onGeoSuccess,function(){showManual('Location access denied.');},{timeout:8000});
    } else {showManual('Geolocation not supported.');}
    document.getElementById('manual-btn').addEventListener('click',function(){
      var c=(document.getElementById('city-input').value||'').trim();if(c)goTo(slugify(c));
    });
    document.getElementById('city-input').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('manual-btn').click();});
  })();
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=86400' }
  });
}

async function handleGeocode(request, env) {
  const url = new URL(request.url);
  const lat = url.searchParams.get('lat');
  const lng = url.searchParams.get('lng');
  if (!lat || !lng || isNaN(+lat) || isNaN(+lng)) return jsonRes({ error: 'invalid_coords' }, 400);
  const key = String(env.GOOGLE_API_KEY || '').trim();
  if (!key) return jsonRes({ error: 'no_api_key' }, 503);
  try {
    const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(lat)},${encodeURIComponent(lng)}&result_type=locality&key=${encodeURIComponent(key)}`;
    const r = await fetch(geoUrl);
    if (!r.ok) return jsonRes({ error: 'geocode_failed' }, 502);
    const data = await r.json();
    if (data.status !== 'OK' || !Array.isArray(data.results) || !data.results.length) return jsonRes({ error: 'not_found' }, 404);
    const components = data.results[0].address_components || [];
    const locality = components.find(c => Array.isArray(c.types) && c.types.includes('locality'));
    if (!locality) return jsonRes({ error: 'no_locality' }, 404);
    return jsonRes({ city: cityToSlug(locality.long_name), cityName: locality.long_name });
  } catch {
    return jsonRes({ error: 'geocode_error' }, 500);
  }
}

const CLASS_PAGE_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --blush:#F9EAEA;--blush-light:#FDF6F6;--rose:#E8B4B8;--rose-deep:#C97E84;
    --lavender:#EDE5FA;--lavender-deep:#B39DDB;--gold:#C9A96E;--gold-light:#F5E8C8;
    --plum:#3D2B3D;--plum-mid:#6B4C6B;--plum-light:#9E7E9E;--off-white:#FDF8F8;
    --border:#F0DCE0;--shadow:rgba(61,43,61,0.08);
  }
  body{font-family:'DM Sans',sans-serif;background:var(--off-white);color:var(--plum);line-height:1.6;}
  nav{position:fixed;top:0;left:0;right:0;height:64px;background:rgba(253,248,248,.92);
    backdrop-filter:blur(20px);border-bottom:1px solid var(--border);
    display:flex;align-items:center;justify-content:space-between;padding:0 32px;z-index:100;}
  .nav-logo{display:flex;align-items:center;gap:10px;text-decoration:none;font-family:'Playfair Display',serif;
    font-size:18px;font-weight:600;color:var(--plum);}
  .nav-links-r{display:flex;gap:20px;align-items:center;}
  .nav-links-r a{text-decoration:none;font-size:13.5px;font-weight:500;color:var(--plum-mid);transition:color .2s;}
  .nav-links-r a:hover{color:var(--plum);}
  .nav-cta{background:linear-gradient(135deg,var(--rose-deep),var(--lavender-deep));
    color:#fff !important;padding:9px 20px;border-radius:50px;font-size:13px;}
  /* Hero */
  .hero{padding:120px 24px 56px;text-align:center;position:relative;overflow:hidden;}
  .hero-blob{position:absolute;inset:0;z-index:0;
    background:radial-gradient(ellipse 80% 60% at 50% 0%,var(--blush) 0%,var(--lavender) 40%,var(--off-white) 100%);}
  .hero-inner{position:relative;z-index:1;max-width:700px;margin:0 auto;}
  .hero-icon{width:72px;height:72px;border-radius:20px;display:flex;align-items:center;justify-content:center;
    font-size:28px;margin:0 auto 20px;box-shadow:0 8px 28px var(--shadow);}
  .hero-title{font-family:'Playfair Display',serif;font-size:clamp(36px,6vw,52px);font-weight:700;
    line-height:1.15;color:var(--plum);margin-bottom:12px;}
  .hero-title em{font-style:italic;color:var(--rose-deep);}
  .hero-tagline{font-size:18px;color:var(--plum-mid);margin-bottom:32px;}
  .hero-stats{display:flex;justify-content:center;gap:28px;flex-wrap:wrap;margin-bottom:36px;}
  .stat-chip{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid var(--border);
    border-radius:50px;padding:8px 18px;font-size:13px;font-weight:500;box-shadow:0 2px 8px var(--shadow);}
  .stat-chip i{color:var(--rose-deep);font-size:13px;}
  .hero-cta{display:inline-flex;align-items:center;gap:10px;
    background:linear-gradient(135deg,var(--rose-deep),var(--lavender-deep));
    color:#fff;padding:16px 32px;border-radius:50px;font-size:16px;font-weight:600;
    text-decoration:none;box-shadow:0 6px 20px rgba(201,126,132,.35);transition:transform .2s,box-shadow .2s;}
  .hero-cta:hover{transform:translateY(-2px);box-shadow:0 10px 28px rgba(201,126,132,.45);}
  /* Content */
  .content{max-width:860px;margin:0 auto;padding:56px 24px;}
  .section{margin-bottom:52px;}
  .section-title{font-family:'Playfair Display',serif;font-size:24px;font-weight:600;
    color:var(--plum);margin-bottom:20px;padding-bottom:10px;border-bottom:2px solid var(--rose);}
  .section p{font-size:16px;color:var(--plum-mid);line-height:1.8;margin-bottom:14px;}
  .benefits-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px;}
  .benefit-card{background:#fff;border:1px solid var(--border);border-radius:14px;padding:18px 20px;
    display:flex;align-items:flex-start;gap:12px;box-shadow:0 2px 8px var(--shadow);}
  .benefit-check{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--rose-deep),var(--lavender-deep));
    display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px;}
  .benefit-check i{color:#fff;font-size:11px;}
  .benefit-text{font-size:14px;color:var(--plum);line-height:1.5;}
  .styles-list{display:flex;flex-wrap:wrap;gap:10px;}
  .style-tag{background:var(--lavender);color:var(--plum-mid);border-radius:50px;
    padding:7px 16px;font-size:13px;font-weight:500;}
  .info-box{background:#fff;border:1px solid var(--border);border-radius:16px;
    padding:24px 28px;box-shadow:0 2px 10px var(--shadow);}
  .info-box p{margin-bottom:0;}
  /* Browse all section */
  .browse-section{background:var(--blush-light);border-radius:20px;padding:40px 32px;margin-top:48px;}
  .browse-title{font-family:'Playfair Display',serif;font-size:22px;font-weight:600;
    color:var(--plum);margin-bottom:24px;text-align:center;}
  .browse-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;}
  .browse-card{background:#fff;border:1px solid var(--border);border-radius:14px;
    padding:16px 12px;text-align:center;text-decoration:none;transition:all .2s;
    display:flex;flex-direction:column;align-items:center;gap:8px;}
  .browse-card:hover{border-color:var(--rose);box-shadow:0 4px 16px var(--shadow);transform:translateY(-2px);}
  .browse-icon{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:18px;}
  .browse-name{font-size:12px;font-weight:500;color:var(--plum);}
  footer{text-align:center;padding:40px 24px;border-top:1px solid var(--border);
    color:var(--plum-light);font-size:13px;}
  footer a{color:var(--rose-deep);text-decoration:none;}
  @media(max-width:640px){
    nav{padding:0 16px;height:56px;}
    .hero{padding:90px 16px 40px;}
    .content{padding:36px 16px;}
    .hero-stats{gap:10px;}
  }
`;

function buildClassesIndexHtml(origin) {
  const cards = Object.entries(CLASS_GUIDE).map(([slug, c]) => `
    <a class="class-index-card" href="${origin}/classes/${slug}">
      <div class="class-index-icon" style="background:${c.bg}"><i class="fa-solid ${c.icon}" style="color:${c.color}"></i></div>
      <div class="class-index-name">${c.name}</div>
      <div class="class-index-tag">${c.difficulty}</div>
    </a>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Class Guide — Studio Locater</title>
  <meta name="description" content="Explore every boutique fitness class type — from yoga and Pilates to HIIT, barre, Lagree, and more. Find studios near you for any style.">
  <link rel="canonical" href="${origin}/classes">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;0,700;1,500&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    ${CLASS_PAGE_CSS}
    .index-hero{padding:110px 24px 52px;text-align:center;position:relative;overflow:hidden;}
    .index-hero-blob{position:absolute;inset:0;
      background:radial-gradient(ellipse 90% 70% at 50% 0%,var(--blush) 0%,var(--lavender) 45%,var(--off-white) 100%);}
    .index-hero-inner{position:relative;z-index:1;max-width:640px;margin:0 auto;}
    .index-hero-title{font-family:'Playfair Display',serif;font-size:clamp(32px,6vw,50px);
      font-weight:700;color:var(--plum);line-height:1.2;margin-bottom:14px;}
    .index-hero-title em{font-style:italic;color:var(--rose-deep);}
    .index-hero-sub{font-size:17px;color:var(--plum-mid);max-width:500px;margin:0 auto 32px;}
    .class-index-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px;
      max-width:960px;margin:0 auto;padding:0 24px 64px;}
    .class-index-card{background:#fff;border:1px solid var(--border);border-radius:16px;
      padding:20px 14px;text-align:center;text-decoration:none;
      display:flex;flex-direction:column;align-items:center;gap:10px;
      transition:all .2s;box-shadow:0 2px 8px var(--shadow);}
    .class-index-card:hover{border-color:var(--rose);box-shadow:0 8px 24px rgba(201,126,132,.2);transform:translateY(-3px);}
    .class-index-icon{width:56px;height:56px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:22px;}
    .class-index-name{font-size:14px;font-weight:600;color:var(--plum);}
    .class-index-tag{font-size:11px;color:var(--plum-light);background:var(--blush);
      border-radius:50px;padding:3px 10px;}
  </style>
</head>
<body>
  <nav>
    <a class="nav-logo" href="/"><i class="fa-solid fa-spa" style="color:var(--rose-deep)"></i> Studio Locater</a>
    <div class="nav-links-r">
      <a href="/">Explore</a>
      <a href="/blog">Blog</a>
      <a class="nav-cta" href="/">Find Studios</a>
    </div>
  </nav>

  <div class="index-hero">
    <div class="index-hero-blob"></div>
    <div class="index-hero-inner">
      <div class="index-hero-title">Your Complete<br><em>Class Guide</em></div>
      <p class="index-hero-sub">Every boutique fitness class type explained — what to expect, benefits, gear, and how to find studios near you.</p>
    </div>
  </div>

  <div class="class-index-grid">
    ${cards}
  </div>

  <footer>
    <a href="/">Studio Locater</a> &nbsp;·&nbsp; <a href="/blog">Blog</a> &nbsp;·&nbsp; © 2026
  </footer>
</body>
</html>`;
}

function buildClassPageHtml(origin, slug) {
  const c = CLASS_GUIDE[slug];
  if (!c) return null;

  const heroImg = unsplashUrl(c.image, 1200, 480);
  const benefitCards = c.benefits.map(b => `
    <div class="benefit-card">
      <div class="benefit-check"><i class="fa-solid fa-check"></i></div>
      <div class="benefit-text">${escHtml(b)}</div>
    </div>`).join('');

  const styleTags = c.styles.map(s => `<span class="style-tag">${escHtml(s)}</span>`).join('');

  const otherClasses = Object.entries(CLASS_GUIDE)
    .filter(([k]) => k !== slug)
    .slice(0, 8)
    .map(([k, oc]) => `
      <a class="browse-card" href="${origin}/classes/${k}">
        <div class="browse-icon" style="background:${oc.bg}"><i class="fa-solid ${oc.icon}" style="color:${oc.color}"></i></div>
        <span class="browse-name">${oc.name}</span>
      </a>`).join('');

  const filterParam = encodeURIComponent(c.filter);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escHtml(c.name)} Classes Near You — Studio Locater</title>
  <meta name="description" content="${escHtml(c.description.slice(0, 155))}">
  <link rel="canonical" href="${origin}/classes/${slug}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;0,700;1,500&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    ${CLASS_PAGE_CSS}
    .hero-img-wrap{position:relative;height:clamp(220px,35vw,400px);overflow:hidden;margin-top:64px;}
    .hero-img{width:100%;height:100%;object-fit:cover;}
    .hero-img-overlay{position:absolute;inset:0;background:linear-gradient(to bottom,rgba(61,43,61,.3) 0%,rgba(61,43,61,.55) 100%);}
    .hero-text-over{position:absolute;bottom:36px;left:0;right:0;padding:0 32px;text-align:center;color:#fff;}
    .hero-text-over .breadcrumb{font-size:13px;opacity:.85;margin-bottom:10px;}
    .hero-text-over .breadcrumb a{color:#fff;text-decoration:none;opacity:.8;}
    .hero-text-over h1{font-family:'Playfair Display',serif;font-size:clamp(28px,5vw,46px);font-weight:700;
      text-shadow:0 2px 16px rgba(0,0,0,.4);margin-bottom:8px;}
    .hero-text-over .hero-tagline-over{font-size:16px;opacity:.9;font-style:italic;}
    @media(max-width:640px){
      .hero-img-wrap{height:200px;margin-top:56px;}
      .hero-text-over{bottom:20px;padding:0 16px;}
    }
  </style>
</head>
<body>
  <nav>
    <a class="nav-logo" href="/"><i class="fa-solid fa-spa" style="color:var(--rose-deep)"></i> Studio Locater</a>
    <div class="nav-links-r">
      <a href="/classes">All Classes</a>
      <a href="/blog">Blog</a>
      <a class="nav-cta" href="/?filter=${filterParam}&locate=true">Find Studios Near Me</a>
    </div>
  </nav>

  <div class="hero-img-wrap">
    <img class="hero-img" src="${heroImg}" alt="${escHtml(c.name)} class" width="1200" height="480" loading="eager">
    <div class="hero-img-overlay"></div>
    <div class="hero-text-over">
      <div class="breadcrumb"><a href="/classes">Classes</a> / ${escHtml(c.name)}</div>
      <h1>${escHtml(c.name)}</h1>
      <div class="hero-tagline-over">${escHtml(c.tagline)}</div>
    </div>
  </div>

  <div class="content">
    <!-- Stats chips -->
    <div class="hero-stats" style="margin-bottom:40px;justify-content:flex-start;">
      <div class="stat-chip"><i class="fa-solid fa-signal"></i> ${escHtml(c.difficulty)}</div>
      <div class="stat-chip"><i class="fa-regular fa-clock"></i> ${escHtml(c.duration)}</div>
      <div class="stat-chip"><i class="fa-solid fa-fire"></i> ${escHtml(c.calories)}</div>
      <div class="stat-chip"><i class="fa-solid fa-shirt"></i> ${escHtml(c.gear)}</div>
    </div>

    <!-- CTA -->
    <div style="text-align:center;margin-bottom:52px;">
      <a class="hero-cta" href="/?filter=${filterParam}&locate=true">
        <i class="fa-solid fa-location-crosshairs"></i> Find ${escHtml(c.name)} Studios Near Me
      </a>
    </div>

    <!-- Description -->
    <div class="section">
      <div class="section-title">What is ${escHtml(c.name)}?</div>
      <div class="info-box"><p>${escHtml(c.description)}</p></div>
    </div>

    <!-- Benefits -->
    <div class="section">
      <div class="section-title">Benefits</div>
      <div class="benefits-grid">${benefitCards}</div>
    </div>

    <!-- What to Expect -->
    <div class="section">
      <div class="section-title">What to Expect</div>
      <div class="info-box"><p>${escHtml(c.whatToExpect)}</p></div>
    </div>

    <!-- Styles / Variations -->
    <div class="section">
      <div class="section-title">Styles &amp; Variations</div>
      <div class="styles-list">${styleTags}</div>
    </div>

    <!-- Second CTA -->
    <div style="text-align:center;padding:24px 0 12px;">
      <a class="hero-cta" href="/?filter=${filterParam}&locate=true">
        <i class="fa-solid fa-location-crosshairs"></i> Find ${escHtml(c.name)} Studios Near Me
      </a>
    </div>

    <!-- Browse Other Classes -->
    <div class="browse-section">
      <div class="browse-title">Explore Other Class Types</div>
      <div class="browse-grid">${otherClasses}</div>
    </div>
  </div>

  <footer>
    <a href="/">Studio Locater</a> &nbsp;·&nbsp; <a href="/classes">Class Guide</a> &nbsp;·&nbsp; <a href="/blog">Blog</a> &nbsp;·&nbsp; © 2026
  </footer>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sitemap (must not throw — Search Console / crawlers expect 200 + valid XML)
// ─────────────────────────────────────────────────────────────────────────────

function sitemapResponseHeaders(bodyUtf8, cacheSec) {
  const enc = new TextEncoder();
  const bytes = enc.encode(bodyUtf8);
  const h = {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': `public, max-age=${cacheSec}`,
    'Content-Length': String(bytes.byteLength),
    'X-Content-Type-Options': 'nosniff',
  };
  return { bytes, headers: h };
}

async function handleSitemapXml(request, env) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const origin = String(url.origin || '').replace(/\/$/, '') || 'https://studiolocater.com';
  try {
    const projectId = env.SANITY_PROJECT_ID || 't0z5ndwm';
    const dataset = env.SANITY_DATASET || 'production';
    let slugs = [];
    try {
      slugs = await fetchAllStudioSlugs(projectId, dataset);
    } catch {
      slugs = [];
    }
    if (!Array.isArray(slugs)) slugs = [];

    let blogSlugs = [];
    try {
      if (env.DB) {
        const blogRows = await env.DB.prepare(
          "SELECT slug FROM blog_posts WHERE status = 'published' ORDER BY published_at DESC"
        ).all();
        blogSlugs = (blogRows.results || []).map((r) => r.slug).filter(Boolean);
      }
    } catch {
      blogSlugs = [];
    }

    const classSlugs = [...CLASS_GUIDE_SLUGS];

    let cityPagePaths = [];
    try {
      const combos = await fetchAllCityTagCombos(projectId, dataset);
      // Build tag filter→slug reverse map (filter value → first matching CLASS_GUIDE slug)
      const filterToSlug = new Map();
      for (const [slug, c] of Object.entries(CLASS_GUIDE)) {
        if (!filterToSlug.has(c.filter)) filterToSlug.set(c.filter, slug);
      }
      cityPagePaths = combos
        .filter(({ tag }) => filterToSlug.has(tag))
        .map(({ citySlug, tag }) => `/${filterToSlug.get(tag)}-studios-${citySlug}`);
    } catch {
      cityPagePaths = [];
    }

    const xml = buildSitemapXml(origin, slugs, { blogSlugs, classSlugs, cityPagePaths });
    const { bytes, headers } = sitemapResponseHeaders(xml, 600);
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }
    return new Response(bytes, { status: 200, headers });
  } catch {
    const fallback = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${origin}/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`;
    const { bytes, headers } = sitemapResponseHeaders(fallback, 120);
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }
    return new Response(bytes, { status: 200, headers });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main fetch handler + scheduled handler
// ─────────────────────────────────────────────────────────────────────────────

export default {
  // ── HTTP requests ─────────────────────────────────────────────────────────
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const path = canonicalPathname(url);
    const method = request.method.toUpperCase();

    // ── Auth routes ────────────────────────────────────────────────────────
    if (path === '/auth/google')   return handleAuthGoogle(request, env);
    if (path === '/auth/callback') return handleAuthCallback(request, env);
    if (path === '/auth/logout' && method === 'POST') return handleAuthLogout(request, env);

    // ── End-user magic link (Gmail) ─────────────────────────────────────────
    if (path === '/auth/magic' && method === 'GET') {
      try {
        return await handleVerifyMagicLink(request, env);
      } catch (r) {
        return r instanceof Response ? r : jsonRes({ error: String(r) }, 500);
      }
    }
    if (path === '/api/auth/magic-link' && method === 'POST') {
      try {
        return await handleRequestMagicLink(request, env);
      } catch (r) {
        return r instanceof Response ? r : jsonRes({ error: String(r) }, 500);
      }
    }
    if (path === '/api/auth/user-logout' && method === 'POST') {
      try {
        return await handleUserLogoutMagic(request, env);
      } catch (r) {
        return r instanceof Response ? r : jsonRes({ error: String(r) }, 500);
      }
    }
    if (path === '/api/me' && method === 'GET') {
      try {
        return await handleUserMe(request, env);
      } catch (r) {
        return r instanceof Response ? r : jsonRes({ error: String(r) }, 500);
      }
    }
    if (path === '/api/me/favorites' && method === 'GET') {
      try {
        return await handleUserFavoritesGet(request, env);
      } catch (r) {
        return r instanceof Response ? r : jsonRes({ error: String(r) }, 500);
      }
    }
    if (path === '/api/me/favorites' && method === 'POST') {
      try {
        return await handleUserFavoritesPost(request, env);
      } catch (r) {
        return r instanceof Response ? r : jsonRes({ error: String(r) }, 500);
      }
    }
    if (path === '/api/me/favorites' && method === 'DELETE') {
      try {
        return await handleUserFavoritesDelete(request, env);
      } catch (r) {
        return r instanceof Response ? r : jsonRes({ error: String(r) }, 500);
      }
    }

    // ── Geocode API (for near-me pages) ────────────────────────────────────
    if (path === '/api/geocode' && method === 'GET') return handleGeocode(request, env);

    // ── Studio reviews ──────────────────────────────────────────────────────
    {
      const rm = path.match(/^\/api\/reviews\/([^/]+)$/);
      if (rm) {
        const studioSlug = decodeURIComponent(rm[1]);
        if (method === 'GET') {
          try {
            const rows = env.DB
              ? (await env.DB.prepare(
                  'SELECT id, rating, comment, created_at FROM studio_reviews WHERE studio_slug = ? ORDER BY created_at DESC LIMIT 50'
                ).bind(studioSlug).all()).results || []
              : [];
            const avg = rows.length ? Math.round((rows.reduce((s, r) => s + r.rating, 0) / rows.length) * 10) / 10 : null;
            return jsonRes({ reviews: rows, count: rows.length, avg });
          } catch { return jsonRes({ reviews: [], count: 0, avg: null }); }
        }
        if (method === 'POST') {
          const session = await (async () => { try { return await getUserSession(env, request); } catch { return null; } })();
          if (!session) return jsonRes({ error: 'auth_required' }, 401);
          let body;
          try { body = await request.json(); } catch { return jsonRes({ error: 'bad_json' }, 400); }
          const rating = Number(body.rating);
          if (!Number.isInteger(rating) || rating < 1 || rating > 5) return jsonRes({ error: 'invalid_rating' }, 400);
          const comment = body.comment ? String(body.comment).trim().slice(0, 800) : null;
          const now = Math.floor(Date.now() / 1000);
          try {
            await env.DB.prepare(
              `INSERT INTO studio_reviews (studio_slug, user_id, user_email, rating, comment, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(studio_slug, user_id) DO UPDATE SET rating=excluded.rating, comment=excluded.comment, updated_at=excluded.updated_at`
            ).bind(studioSlug, session.userId, session.email, rating, comment, now, now).run();
            return jsonRes({ ok: true });
          } catch (e) { return jsonRes({ error: String(e && e.message ? e.message : e) }, 500); }
        }
      }
    }

    if ((path === '/api/mindbody/studio' || path === '/api/mindbody/schedule') && method === 'GET') {
      try {
        const out = await handleMindbodyStudioApi(url, env, { fetchStudioBySlug });
        return new Response(JSON.stringify(out.body), {
          status: out.status,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=120',
          },
        });
      } catch (e) {
        return jsonRes({ error: String(e && e.message ? e.message : e) }, 500);
      }
    }

    // ── Admin page ──────────────────────────────────────────────────────────
    if (path === '/admin') return handleAdminPage(request, env);

    // ── Admin API ───────────────────────────────────────────────────────────
    if (path === '/api/admin/me' && method === 'GET') {
      try { return await handleAdminMe(request, env); }
      catch (r) { return r instanceof Response ? r : jsonRes({ error: String(r) }, 500); }
    }
    if (path === '/api/admin/stats' && method === 'GET') {
      try { return await handleAdminStats(request, env); }
      catch (r) { return r instanceof Response ? r : jsonRes({ error: String(r) }, 500); }
    }
    if (path === '/api/admin/signups' && method === 'GET') {
      try { return await handleAdminListSignups(request, env); }
      catch (r) { return r instanceof Response ? r : jsonRes({ error: String(r) }, 500); }
    }
    if (path === '/api/admin/blogs' && method === 'GET') {
      try { return await handleAdminListBlogs(request, env); }
      catch (r) { return r instanceof Response ? r : jsonRes({ error: String(r) }, 500); }
    }
    if (path === '/api/admin/blogs/generate' && method === 'POST') {
      try { return await handleAdminGenerateBlog(request, env); }
      catch (r) { return r instanceof Response ? r : jsonRes({ error: String(r?.message || r) }, 500); }
    }
    if (path === '/api/admin/blogs/suggest-prompts' && method === 'POST') {
      try { return await handleAdminSuggestPrompts(request, env); }
      catch (r) { return r instanceof Response ? r : jsonRes({ error: String(r?.message || r) }, 500); }
    }
    {
      const bm = path.match(/^\/api\/admin\/blogs\/(\d+)$/);
      if (bm) {
        const id = parseInt(bm[1]);
        try {
          if (method === 'PATCH')  return await handleAdminPatchBlog(request, env, id, ctx);
          if (method === 'DELETE') return await handleAdminDeleteBlog(request, env, id);
        } catch (r) { return r instanceof Response ? r : jsonRes({ error: String(r) }, 500); }
      }
    }
    if (path === '/api/admin/schedule' && method === 'GET') {
      try { return await handleAdminGetSchedule(request, env); }
      catch (r) { return r instanceof Response ? r : jsonRes({ error: String(r) }, 500); }
    }
    if (path === '/api/admin/schedule' && method === 'POST') {
      try { return await handleAdminSaveSchedule(request, env); }
      catch (r) { return r instanceof Response ? r : jsonRes({ error: String(r) }, 500); }
    }

    // ── Public tracking endpoint ────────────────────────────────────────────
    if (path === '/api/track/signup' && method === 'POST') {
      try { return await handleTrackSignup(request, env); }
      catch { return jsonRes({ ok: true }); } // never surface errors to public
    }

    if (path === '/api/place-meta' && method === 'POST') {
      try { return await handlePlaceMetaPost(request, env); }
      catch (r) { return r instanceof Response ? r : jsonRes({ error: String(r) }, 500); }
    }

    if (path === '/api/blog-posts' && method === 'GET') {
      try { return await handlePublicBlogPostsJson(request, env); }
      catch (r) { return r instanceof Response ? r : jsonRes({ error: String(r) }, 500); }
    }

    // ── Class guide routes ──────────────────────────────────────────────────
    if (path === '/classes') {
      return new Response(buildClassesIndexHtml(url.origin), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
      });
    }
    {
      const cm = path.match(/^\/classes\/([^/]+)$/);
      if (cm) {
        const slug = decodeURIComponent(cm[1]).toLowerCase();
        const html = buildClassPageHtml(url.origin, slug);
        if (html) return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
        });
        return new Response('Class type not found', { status: 404 });
      }
    }

    // ── Blog routes ─────────────────────────────────────────────────────────
    if (path === '/blog') return handleBlogIndex(request, env);
    {
      const bm = path.match(/^\/blog\/([^/]+)$/);
      if (bm) return handleBlogPost(request, env, decodeURIComponent(bm[1]));
    }

    // ── Sitemap ─────────────────────────────────────────────────────────────
    if (path === '/sitemap.xml') {
      return handleSitemapXml(request, env);
    }

    // ── City landing pages: /{tagSlug}-studios-{citySlug} ───────────────────
    for (const tagSlug of CITY_PAGE_TAG_SLUGS) {
      const prefix = `/${tagSlug}-studios-`;
      if (path.startsWith(prefix)) {
        const citySlug = path.slice(prefix.length);
        if (/^[a-z][a-z0-9-]*$/.test(citySlug)) {
          return handleCityPage(request, env, tagSlug, citySlug);
        }
      }
    }

    // ── Studio detail pages ─────────────────────────────────────────────────
    const projectId  = env.SANITY_PROJECT_ID || 't0z5ndwm';
    const dataset    = env.SANITY_DATASET    || 'production';
    const canonicalUrl = `${url.origin}${canonicalPathname(url)}`;

    const idMatch = url.pathname.match(/^\/studios\/id\/([^/]+)\/?$/);
    if (idMatch) {
      const docId = decodeURIComponent(idMatch[1]);
      try {
        const doc = await fetchStudioByDocumentId(docId, projectId, dataset);
        if (!doc) return new Response(buildStudioNotFoundHtml(`${url.origin}/`), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=120' } });
        return studioHtmlResponse(await htmlForStudioDoc(doc, env, { canonicalUrl, robotsNoIndex: true }));
      } catch { return new Response('Server error', { status: 500, headers: { 'Content-Type': 'text/plain' } }); }
    }

    const m = url.pathname.match(/^\/studios\/([^/]+)\/?$/);
    if (m) {
      const slug = decodeURIComponent(m[1]);
      if (slug === 'id') return new Response(buildStudioNotFoundHtml(`${url.origin}/`), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=120' } });
      try {
        const doc = await fetchStudioBySlug(slug, projectId, dataset);
        if (!doc) return new Response(buildStudioNotFoundHtml(`${url.origin}/`), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=120' } });
        return studioHtmlResponse(await htmlForStudioDoc(doc, env, { canonicalUrl, robotsNoIndex: false }));
      } catch { return new Response('Server error', { status: 500, headers: { 'Content-Type': 'text/plain' } }); }
    }

    // ── Static assets fallback ───────────────────────────────────────────────
    return env.ASSETS.fetch(request);
  },

  // ── Cron trigger (runs blog scheduler daily at 8am UTC) ──────────────────
  async scheduled(_event, env, _ctx) {
    await runBlogScheduler(env);
  },
};
