/**
 * End-user magic-link auth + Gmail send + favorites (D1 migration 003).
 * Secrets: GMAIL_REFRESH_TOKEN, GMAIL_SEND_AS — reuse GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 * from an OAuth client that has Gmail API enabled with scope gmail.send.
 */

const USER_SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
const MAGIC_LINK_TTL_SEC = 60 * 15; // 15 minutes

function jsonRes(data, status = 200, extraHeaders) {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  if (extraHeaders instanceof Headers) {
    extraHeaders.forEach((v, k) => h.append(k, v));
  }
  return new Response(JSON.stringify(data), { status, headers: h });
}

function redirect(location, status = 302) {
  return new Response(null, { status, headers: { Location: location } });
}

function randomHex(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeEmail(s) {
  const e = String(s || '')
    .trim()
    .toLowerCase()
    .slice(0, 254);
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return '';
  return e;
}

function userSessionCookie(id, ttlSec) {
  return `user_session=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttlSec}`;
}

function clearUserSessionCookie() {
  return 'user_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

function gmailClientCreds(env) {
  const id = String(env.GMAIL_CLIENT_ID || env.GOOGLE_CLIENT_ID || '').trim();
  const secret = String(env.GMAIL_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || '').trim();
  return { id, secret };
}

async function gmailAccessToken(env) {
  const refresh = String(env.GMAIL_REFRESH_TOKEN || '').trim();
  const { id: clientId, secret: clientSecret } = gmailClientCreds(env);
  if (!refresh || !clientId || !clientSecret) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return typeof data.access_token === 'string' ? data.access_token : null;
}

/** RFC 2822-ish message; Gmail `raw` is base64url. */
function buildMimeMessage({ from, to, subject, text, html }) {
  const boundary = 'b_' + randomHex(8);
  const subj = subject.replace(/\r?\n/g, ' ');
  let body =
    `From: ${from}\r\n` +
    `To: ${to}\r\n` +
    `Subject: ${subj}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\n\r\n` +
    `${text}\r\n\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/html; charset=UTF-8\r\n\r\n` +
    `${html}\r\n\r\n` +
    `--${boundary}--`;
  const bytes = new TextEncoder().encode(body);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendGmail(env, { to, subject, text, html }) {
  const access = await gmailAccessToken(env);
  if (!access) return { ok: false, error: 'gmail_not_configured' };
  const from = String(env.GMAIL_SEND_AS || '').trim();
  if (!from) return { ok: false, error: 'gmail_send_as_missing' };
  const raw = buildMimeMessage({ from, to, subject, text, html });
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    const t = await res.text();
    return { ok: false, error: 'gmail_send_failed', detail: t.slice(0, 200) };
  }
  return { ok: true };
}

export async function getUserSession(env, request) {
  if (!env.SESSIONS) return null;
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)user_session=([^;]+)/);
  if (!match) return null;
  const id = match[1];
  const raw = await env.SESSIONS.get(id);
  if (!raw) return null;
  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    return null;
  }
  if (session.kind !== 'user' || session.userId == null || !session.email) return null;
  if (session.expiresAt < Math.floor(Date.now() / 1000)) {
    await env.SESSIONS.delete(id);
    return null;
  }
  return { sessionId: id, userId: session.userId, email: session.email };
}

async function createUserSession(env, userId, email) {
  const id = randomHex(32);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + USER_SESSION_TTL_SEC;

  await env.SESSIONS.put(
    id,
    JSON.stringify({ kind: 'user', userId, email, expiresAt }),
    { expirationTtl: USER_SESSION_TTL_SEC }
  );

  await env.DB.prepare(
    'INSERT INTO user_sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(id, userId, expiresAt, now)
    .run()
    .catch(() => {});

  const headers = new Headers();
  headers.append('Set-Cookie', userSessionCookie(id, USER_SESSION_TTL_SEC));
  return headers;
}

export async function handleRequestMagicLink(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  if (!email) return jsonRes({ error: 'valid_email_required' }, 400);

  const refresh = String(env.GMAIL_REFRESH_TOKEN || '').trim();
  if (!refresh) return jsonRes({ error: 'email_not_configured' }, 503);

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + MAGIC_LINK_TTL_SEC;

  await env.DB.prepare(
    `INSERT INTO users (email, name, email_pref, verified, created_at, updated_at)
     VALUES (?, NULL, 'instant', 0, ?, ?)
     ON CONFLICT(email) DO UPDATE SET updated_at = excluded.updated_at`
  )
    .bind(email, now, now)
    .run();

  const row = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (!row?.id) return jsonRes({ error: 'user_create_failed' }, 500);
  const userId = row.id;

  await env.DB.prepare('DELETE FROM magic_links WHERE user_id = ? AND used = 0').bind(userId).run();

  const token = randomHex(24);
  await env.DB.prepare(
    'INSERT INTO magic_links (id, user_id, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)'
  )
    .bind(token, userId, expiresAt, now)
    .run();

  const origin = new URL(request.url).origin;
  const verifyUrl = `${origin}/auth/magic?token=${encodeURIComponent(token)}`;

  const send = await sendGmail(env, {
    to: email,
    subject: 'Your Studio Locater sign-in link',
    text: `Sign in to Studio Locater:\n\n${verifyUrl}\n\nThis link expires in 15 minutes. If you didn't request this, you can ignore this email.`,
    html: `<p>Click to sign in to <strong>Studio Locater</strong>:</p><p><a href="${verifyUrl}">Sign in</a></p><p style="color:#666;font-size:13px">This link expires in 15 minutes. If you didn't request this, ignore this email.</p>`,
  });

  if (!send.ok) {
    return jsonRes({ error: send.error || 'send_failed' }, 502);
  }

  return jsonRes({ ok: true });
}

export async function handleVerifyMagicLink(request, env) {
  const url = new URL(request.url);
  const token = String(url.searchParams.get('token') || '').trim();
  if (!token || token.length < 32) return redirect(`${url.origin}/?auth=invalid`);

  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT ml.id, ml.user_id, u.email
     FROM magic_links ml
     JOIN users u ON u.id = ml.user_id
     WHERE ml.id = ? AND ml.used = 0 AND ml.expires_at > ?`
  )
    .bind(token, now)
    .first();

  if (!row) return redirect(`${url.origin}/?auth=expired`);

  await env.DB.prepare('UPDATE magic_links SET used = 1 WHERE id = ?').bind(token).run();
  await env.DB.prepare('UPDATE users SET verified = 1, updated_at = ? WHERE id = ?')
    .bind(now, row.user_id)
    .run();

  const cookieHeaders = await createUserSession(env, row.user_id, row.email);
  const out = new Headers();
  out.set('Location', `${url.origin}/?signed_in=1`);
  cookieHeaders.forEach((v, k) => out.append(k, v));
  return new Response(null, { status: 302, headers: out });
}

export async function handleUserLogout(request, env) {
  const u = await getUserSession(env, request);
  const headers = new Headers();
  headers.append('Set-Cookie', clearUserSessionCookie());
  if (u?.sessionId && env.SESSIONS) await env.SESSIONS.delete(u.sessionId);
  if (u?.sessionId) {
    await env.DB.prepare('DELETE FROM user_sessions WHERE id = ?').bind(u.sessionId).run().catch(() => {});
  }
  return jsonRes({ ok: true }, 200, headers);
}

export async function handleUserMe(request, env) {
  const u = await getUserSession(env, request);
  if (!u) return jsonRes({ user: null });
  const row = await env.DB.prepare('SELECT email, name, email_pref FROM users WHERE id = ?')
    .bind(u.userId)
    .first();
  return jsonRes({
    user: {
      email: u.email,
      name: row?.name || null,
      emailPref: row?.email_pref || 'instant',
    },
  });
}

export async function handleUserFavoritesGet(request, env) {
  const u = await getUserSession(env, request);
  if (!u) return jsonRes({ error: 'unauthorized' }, 401);
  const rows = await env.DB.prepare(
    `SELECT studio_id, studio_name, studio_data FROM user_favorites WHERE user_id = ? ORDER BY created_at DESC`
  )
    .bind(u.userId)
    .all();
  const list = (rows.results || []).map(r => ({
    studioId: r.studio_id,
    studioName: r.studio_name,
    studioData: r.studio_data ? JSON.parse(r.studio_data) : null,
  }));
  return jsonRes({ favorites: list });
}

export async function handleUserFavoritesPost(request, env) {
  const u = await getUserSession(env, request);
  if (!u) return jsonRes({ error: 'unauthorized' }, 401);
  const body = await request.json().catch(() => ({}));
  const studioId = String(body.studioId || '').trim().slice(0, 512);
  if (!studioId) return jsonRes({ error: 'studioId_required' }, 400);
  const studioName = body.studioName != null ? String(body.studioName).slice(0, 500) : null;
  const studioData =
    body.studioData && typeof body.studioData === 'object'
      ? JSON.stringify(body.studioData).slice(0, 8000)
      : null;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO user_favorites (user_id, studio_id, studio_name, studio_data, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, studio_id) DO UPDATE SET
       studio_name = excluded.studio_name,
       studio_data = excluded.studio_data`
  )
    .bind(u.userId, studioId, studioName, studioData, now)
    .run();
  return jsonRes({ ok: true });
}

export async function handleUserFavoritesDelete(request, env) {
  const u = await getUserSession(env, request);
  if (!u) return jsonRes({ error: 'unauthorized' }, 401);
  const body = await request.json().catch(() => ({}));
  const studioId = String(body.studioId || '').trim().slice(0, 512);
  if (!studioId) return jsonRes({ error: 'studioId_required' }, 400);
  await env.DB.prepare('DELETE FROM user_favorites WHERE user_id = ? AND studio_id = ?')
    .bind(u.userId, studioId)
    .run();
  return jsonRes({ ok: true });
}
