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
 *   GET  /api/admin/blogs      → list blog posts (requires auth)
 *   POST /api/admin/blogs/generate → generate post via Claude (requires auth)
 *   PATCH  /api/admin/blogs/:id    → publish / unpublish (requires auth)
 *   DELETE /api/admin/blogs/:id    → delete post (requires auth)
 *   GET  /api/admin/schedule   → get blog schedule config (requires auth)
 *   POST /api/admin/schedule   → save blog schedule config (requires auth)
 *   POST /api/track/signup     → record a user signup event (public, no auth)
 *   GET  /blog                 → public blog listing
 *   GET  /blog/:slug           → public blog post page
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

// ─────────────────────────────────────────────────────────────────────────────
// Blog generation via Claude
// ─────────────────────────────────────────────────────────────────────────────

async function generateBlogPost(env, topic, classes) {
  const classContext = classes ? ` The site features classes like: ${classes}.` : '';
  const prompt = `You are a fitness & wellness content writer for Studio Locater, a fitness studio directory app.${classContext}

Write a helpful, engaging blog post about the following topic:
"${topic}"

Requirements:
- Title: compelling, SEO-friendly (under 70 chars)
- Excerpt: 1–2 sentence summary (under 160 chars)
- Body: 400–600 words, formatted as clean HTML (use <h2>, <p>, <ul>/<li> as appropriate)
- Tone: friendly, motivating, practical — like advice from a knowledgeable fitness friend
- Include actionable tips and relate content back to fitness studios or classes where natural

Respond in this exact JSON format (no markdown, no code fences, just raw JSON):
{
  "title": "...",
  "excerpt": "...",
  "body_html": "..."
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
      max_tokens: 1500,
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
    // Strip any accidental markdown fences
    const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    throw new Error('Claude returned unparseable JSON. Try again.');
  }

  return {
    title:     parsed.title     || 'Untitled Post',
    excerpt:   parsed.excerpt   || '',
    body_html: parsed.body_html || parsed.body || '',
  };
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

      const { title, excerpt, body_html } = await generateBlogPost(env, topic, '');
      const slug = slugify(title) + '-' + randomHex(4);
      const status = sched.auto_publish ? 'published' : 'draft';
      const publishedAt = sched.auto_publish ? now : null;

      await env.DB.prepare(
        `INSERT INTO blog_posts (slug, title, excerpt, body_html, topic, status, published_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(slug, title, excerpt, body_html, topic, status, publishedAt, now, now).run();

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
const BLOG_BASE_CSS = `*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}:root{--blush:#F9EAEA;--blush-light:#FDF6F6;--rose:#E8B4B8;--rose-deep:#C97E84;--lavender:#EDE5FA;--lavender-deep:#B39DDB;--plum:#3D2B3D;--plum-mid:#6B4C6B;--plum-light:#9E7E9E;--off-white:#FDF8F8;--border:#F0DCE0;--shadow:rgba(61,43,61,0.08);--gradient:linear-gradient(135deg,#C97E84,#B39DDB);}body{font-family:'DM Sans',sans-serif;background:var(--off-white);color:var(--plum);-webkit-font-smoothing:antialiased;}nav{background:rgba(253,248,248,0.92);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);padding:0 40px;height:68px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;}.nav-logo{display:flex;align-items:center;gap:10px;text-decoration:none;}.nav-logo-icon{width:34px;height:34px;border-radius:50%;background:var(--gradient);display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;}.nav-logo-text{font-family:'Playfair Display',serif;font-size:18px;font-weight:600;color:var(--plum);}.nav-link{font-size:13px;color:var(--plum-light);text-decoration:none;font-weight:500;}.nav-link:hover{color:var(--rose-deep);}footer{text-align:center;padding:40px;color:var(--plum-light);font-size:13px;border-top:1px solid var(--border);margin-top:60px;}footer a{color:var(--rose-deep);text-decoration:none;font-weight:500;}`;

function buildBlogIndexHtml(origin, posts) {
  const cards = posts.map(p => `
    <article class="post-card">
      <div class="post-meta">${new Date(p.published_at * 1000).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })}</div>
      <h2><a href="/blog/${escHtml(p.slug)}">${escHtml(p.title)}</a></h2>
      <p class="excerpt">${escHtml(p.excerpt || '')}</p>
      <a class="read-more" href="/blog/${escHtml(p.slug)}">Read more →</a>
    </article>
  `).join('');

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
    .hero{background:linear-gradient(155deg,#FDF6F6 0%,#F9EAEA 40%,#EDE5FA 100%);padding:64px 40px 56px;text-align:center;border-bottom:1px solid var(--border);}
    .hero-tag{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--rose-deep);font-weight:600;margin-bottom:14px;}
    .hero h1{font-family:'Playfair Display',serif;font-size:44px;font-weight:700;color:var(--plum);margin-bottom:12px;line-height:1.2;}
    .hero p{color:var(--plum-light);font-size:16px;max-width:500px;margin:0 auto;}
    .container{max-width:780px;margin:0 auto;padding:52px 24px 40px;}
    .post-card{background:#fff;border:1px solid var(--border);border-radius:16px;padding:32px;margin-bottom:20px;box-shadow:0 2px 12px var(--shadow);transition:box-shadow .2s,transform .2s;}
    .post-card:hover{box-shadow:0 8px 32px var(--shadow);transform:translateY(-2px);}
    .post-meta{font-size:11px;color:var(--plum-light);margin-bottom:10px;text-transform:uppercase;letter-spacing:.07em;font-weight:600;}
    .post-card h2{font-family:'Playfair Display',serif;font-size:22px;font-weight:600;margin-bottom:10px;line-height:1.3;}
    .post-card h2 a{color:var(--plum);text-decoration:none;}
    .post-card h2 a:hover{color:var(--rose-deep);}
    .excerpt{color:var(--plum-light);font-size:15px;margin-bottom:18px;line-height:1.65;}
    .read-more{display:inline-flex;align-items:center;gap:6px;color:var(--rose-deep);font-size:13px;font-weight:600;text-decoration:none;background:var(--blush);padding:7px 16px;border-radius:50px;border:1px solid var(--rose);transition:all .18s;}
    .read-more:hover{background:var(--rose-deep);color:#fff;border-color:var(--rose-deep);}
    .empty{text-align:center;padding:80px 20px;color:var(--plum-light);}
    .empty .icon{font-size:48px;margin-bottom:16px;}
    @media(max-width:600px){.hero h1{font-size:32px;}.hero{padding:48px 24px 40px;}.container{padding:36px 16px 32px;}}
  </style>
</head>
<body>
  <nav>
    <a class="nav-logo" href="/"><div class="nav-logo-icon">🏋️</div><span class="nav-logo-text">Studio Locater</span></a>
    <a class="nav-link" href="/">← Back to Studios</a>
  </nav>
  <div class="hero">
    <div class="hero-tag">Wellness &amp; Fitness</div>
    <h1>Tips, Trends &amp; Advice</h1>
    <p>Insights to help you find your perfect class and live your best active life.</p>
  </div>
  <div class="container">
    ${posts.length ? cards : '<div class="empty"><div class="icon">🌸</div><p>No posts published yet — check back soon!</p></div>'}
  </div>
  <footer><a href="/">← Studio Locater</a></footer>
</body>
</html>`;
}

function buildBlogPostHtml(origin, post) {
  const dateStr = post.published_at
    ? new Date(post.published_at * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(post.title)} — Studio Locater Blog</title>
  <meta name="description" content="${escHtml(post.excerpt || '')}">
  <link rel="canonical" href="${origin}/blog/${escHtml(post.slug)}">
  ${BLOG_FONTS}
  <style>
    ${BLOG_BASE_CSS}
    .post-hero{background:linear-gradient(155deg,#FDF6F6 0%,#F9EAEA 40%,#EDE5FA 100%);padding:56px 24px 48px;text-align:center;border-bottom:1px solid var(--border);}
    .post-meta{font-size:11px;color:var(--plum-light);text-transform:uppercase;letter-spacing:.1em;margin-bottom:16px;font-weight:600;}
    .post-hero h1{font-family:'Playfair Display',serif;font-size:40px;font-weight:700;color:var(--plum);line-height:1.25;max-width:700px;margin:0 auto 16px;}
    .post-hero .excerpt{font-size:17px;color:var(--plum-light);max-width:580px;margin:0 auto;line-height:1.65;}
    .container{max-width:720px;margin:0 auto;padding:52px 24px 40px;}
    .divider{width:48px;height:3px;background:var(--gradient);border-radius:2px;margin:0 auto 40px;}
    .body{line-height:1.85;font-size:16px;color:var(--plum-mid);}
    .body h2{font-family:'Playfair Display',serif;font-size:24px;font-weight:600;margin:40px 0 14px;color:var(--plum);}
    .body p{margin-bottom:20px;}
    .body ul,.body ol{margin-bottom:20px;padding-left:24px;}
    .body li{margin-bottom:10px;}
    .body strong{color:var(--plum);font-weight:600;}
    .back-wrap{margin-top:52px;padding-top:32px;border-top:1px solid var(--border);text-align:center;}
    .back-link{display:inline-flex;align-items:center;gap:8px;color:var(--rose-deep);font-size:14px;font-weight:600;text-decoration:none;background:var(--blush);padding:10px 22px;border-radius:50px;border:1px solid var(--rose);transition:all .18s;}
    .back-link:hover{background:var(--rose-deep);color:#fff;border-color:var(--rose-deep);}
    @media(max-width:600px){.post-hero h1{font-size:28px;}.post-hero{padding:40px 20px 36px;}.container{padding:36px 16px;}}
  </style>
</head>
<body>
  <nav>
    <a class="nav-logo" href="/"><div class="nav-logo-icon">🏋️</div><span class="nav-logo-text">Studio Locater</span></a>
    <a class="nav-link" href="/blog">← Blog</a>
  </nav>
  <div class="post-hero">
    ${dateStr ? `<div class="post-meta">${escHtml(dateStr)}</div>` : ''}
    <h1>${escHtml(post.title)}</h1>
    ${post.excerpt ? `<p class="excerpt">${escHtml(post.excerpt)}</p>` : ''}
  </div>
  <div class="container">
    <div class="divider"></div>
    <div class="body">${post.body_html}</div>
    <div class="back-wrap">
      <a class="back-link" href="/blog">← Back to Blog</a>
    </div>
  </div>
  <footer><a href="/">Studio Locater</a></footer>
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
  const topic   = String(body.topic   || '').trim();
  const classes = String(body.classes || '').trim();

  if (!topic) return jsonRes({ error: 'topic is required' }, 400);
  if (!env.ANTHROPIC_API_KEY) return jsonRes({ error: 'ANTHROPIC_API_KEY secret not set.' }, 500);

  const { title, excerpt, body_html } = await generateBlogPost(env, topic, classes);
  const slug = slugify(title) + '-' + randomHex(4);
  const now  = Math.floor(Date.now() / 1000);

  const result = await env.DB.prepare(
    `INSERT INTO blog_posts (slug, title, excerpt, body_html, topic, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?) RETURNING *`
  ).bind(slug, title, excerpt, body_html, topic, now, now).first();

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
  // Hash email for privacy (optional — only stored if provided)
  let email = null;
  if (body.email) {
    const enc  = new TextEncoder().encode(String(body.email).toLowerCase().trim());
    const hash = await crypto.subtle.digest('SHA-256', enc);
    email = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }
  await env.DB.prepare(
    'INSERT INTO user_signups (email, source, metadata) VALUES (?, ?, ?)'
  ).bind(email, source, metadata).run();
  return jsonRes({ ok: true });
}

async function handleBlogIndex(request, env) {
  const rows = await env.DB.prepare(
    "SELECT id, slug, title, excerpt, published_at FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 20"
  ).all();
  const html = buildBlogIndexHtml(new URL(request.url).origin, rows.results || []);
  return htmlRes(html);
}

async function handleBlogPost(request, env, slug) {
  const post = await env.DB.prepare(
    "SELECT * FROM blog_posts WHERE slug = ? AND status = 'published'"
  ).bind(slug).first();
  if (!post) return htmlRes('<h1>Post not found</h1>', 404);
  const html = buildBlogPostHtml(new URL(request.url).origin, post);
  return htmlRes(html);
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
    if (path === '/api/admin/blogs' && method === 'GET') {
      try { return await handleAdminListBlogs(request, env); }
      catch (r) { return r instanceof Response ? r : jsonRes({ error: String(r) }, 500); }
    }
    if (path === '/api/admin/blogs/generate' && method === 'POST') {
      try { return await handleAdminGenerateBlog(request, env); }
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
