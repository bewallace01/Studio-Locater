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
 *
 * Secrets required (set via `npx wrangler secret put <NAME>`):
 *   GOOGLE_CLIENT_ID      – OAuth 2.0 client ID from Google Cloud Console
 *   GOOGLE_CLIENT_SECRET  – OAuth 2.0 client secret
 *   ADMIN_EMAILS          – comma-separated allowed emails, e.g. "you@gmail.com"
 *   SESSION_SECRET        – random string for signing (openssl rand -hex 32)
 *   ANTHROPIC_API_KEY     – Claude API key for blog generation
 */

import {
  fetchStudioBySlug,
  fetchStudioByDocumentId,
  enrichStudioWithGooglePlaces,
  buildStudioDetailHtml,
  buildStudioNotFoundHtml,
  fetchAllStudioSlugs,
  buildSitemapXml
} from './studio-detail-page.mjs';

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
  const { doc: merged, augmented } = await enrichStudioWithGooglePlaces(doc, gKey);
  return buildStudioDetailHtml(merged, { canonicalUrl, robotsNoIndex, googleAugmented: augmented });
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
  const key = (keyword || 'default').toLowerCase().split(/[\s,]/)[0];
  const seed = FITNESS_SEEDS[key] || FITNESS_SEEDS.default;
  return `https://picsum.photos/seed/${seed}/${w}/${h}`;
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

      await env.DB.prepare(
        `INSERT INTO blog_posts (slug, title, excerpt, body_html, topic, status, image_keyword, published_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(slug, title, excerpt, body_html, topic, status, image_keyword, publishedAt, now, now).run();

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

async function handleAdminPatchBlog(request, env, id) {
  await requireAuth(request, env);
  const body   = await request.json().catch(() => ({}));
  const status = body.status;
  if (!['published', 'draft'].includes(status)) return jsonRes({ error: 'Invalid status' }, 400);

  const now = Math.floor(Date.now() / 1000);
  const publishedAt = status === 'published' ? now : null;

  await env.DB.prepare(
    'UPDATE blog_posts SET status = ?, published_at = ?, updated_at = ? WHERE id = ?'
  ).bind(status, publishedAt, now, id).run();

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
  await env.DB.prepare(
    'INSERT INTO user_signups (email, source, metadata, email_address) VALUES (?, ?, ?, ?)'
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
    "SELECT id, slug, title, excerpt, published_at FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 20"
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
// Main fetch handler + scheduled handler
// ─────────────────────────────────────────────────────────────────────────────

export default {
  // ── HTTP requests ─────────────────────────────────────────────────────────
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = canonicalPathname(url);
    const method = request.method.toUpperCase();

    // ── Auth routes ────────────────────────────────────────────────────────
    if (path === '/auth/google')   return handleAuthGoogle(request, env);
    if (path === '/auth/callback') return handleAuthCallback(request, env);
    if (path === '/auth/logout' && method === 'POST') return handleAuthLogout(request, env);

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
          if (method === 'PATCH')  return await handleAdminPatchBlog(request, env, id);
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

    // ── Blog routes ─────────────────────────────────────────────────────────
    if (path === '/blog') return handleBlogIndex(request, env);
    {
      const bm = path.match(/^\/blog\/([^/]+)$/);
      if (bm) return handleBlogPost(request, env, decodeURIComponent(bm[1]));
    }

    // ── Sitemap ─────────────────────────────────────────────────────────────
    if (path === '/sitemap.xml') {
      const projectId = env.SANITY_PROJECT_ID || 't0z5ndwm';
      const dataset   = env.SANITY_DATASET    || 'production';
      try {
        const slugs = await fetchAllStudioSlugs(projectId, dataset);
        const xml   = buildSitemapXml(url.origin, slugs);
        return new Response(xml, {
          headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=600' }
        });
      } catch {
        return new Response('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>', {
          headers: { 'Content-Type': 'application/xml; charset=utf-8' }
        });
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
