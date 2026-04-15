/**
 * Mindbody Public API v6 helpers (Worker + Node). Secrets stay server-side only.
 *
 * AccessTokens are cached (~5 min) in Workers KV (`MINDBODY_TOKEN_CACHE`) when bound;
 * otherwise an in-memory Map (best-effort within one isolate).
 */

const DEFAULT_BASE = 'https://api.mindbodyonline.com/public/v6';

/** In-process fallback when `env.MINDBODY_TOKEN_CACHE` is missing (e.g. local Express). */
const memoryTokenCache = new Map();

function mbBase(env) {
  const b = env?.MINDBODY_API_BASE_URL && String(env.MINDBODY_API_BASE_URL).trim();
  return b ? b.replace(/\/$/, '') : DEFAULT_BASE;
}

export function mindbodyApiKey(env) {
  return (
    (env.MINDBODY_APP_KEY && String(env.MINDBODY_APP_KEY).trim()) ||
    (env.MINDBODY_API_KEY && String(env.MINDBODY_API_KEY).trim()) ||
    (env.MINDBODY_SOURCE_SECRET && String(env.MINDBODY_SOURCE_SECRET).trim()) ||
    ''
  );
}

function tokenTtlSeconds(env) {
  const n = Number(env?.MINDBODY_TOKEN_TTL_SEC);
  if (Number.isFinite(n) && n >= 60 && n <= 3600) return Math.floor(n);
  return 300;
}

function cacheKey(siteId) {
  return `mbat:${siteId}`;
}

async function getCachedAccessToken(env, siteId) {
  const k = cacheKey(siteId);
  const kv = env.MINDBODY_TOKEN_CACHE;
  if (kv && typeof kv.get === 'function') {
    const t = await kv.get(k);
    if (t && String(t).trim()) return String(t).trim();
    return null;
  }
  const row = memoryTokenCache.get(k);
  if (row && row.expiresAt > Date.now()) return row.token;
  memoryTokenCache.delete(k);
  return null;
}

async function setCachedAccessToken(env, siteId, token, ttlSec) {
  const k = cacheKey(siteId);
  const ttl = Math.max(60, Math.min(3600, ttlSec));
  const kv = env.MINDBODY_TOKEN_CACHE;
  if (kv && typeof kv.put === 'function') {
    await kv.put(k, token, { expirationTtl: ttl });
    return;
  }
  memoryTokenCache.set(k, { token, expiresAt: Date.now() + ttl * 1000 });
}

function issueCredentials(env, siteId) {
  const u =
    (env.MINDBODY_ISSUE_USERNAME && String(env.MINDBODY_ISSUE_USERNAME).trim()) ||
    (env.MINDBODY_SANDBOX_USERNAME && String(env.MINDBODY_SANDBOX_USERNAME).trim());
  const p =
    (env.MINDBODY_ISSUE_PASSWORD && String(env.MINDBODY_ISSUE_PASSWORD).trim()) ||
    (env.MINDBODY_SANDBOX_PASSWORD && String(env.MINDBODY_SANDBOX_PASSWORD).trim());
  if (u && p) return { Username: u, Password: p };
  if (String(siteId) === '-99')
    return { Username: 'mindbodysandboxsite@gmail.com', Password: 'Apitest1234' };
  return null;
}

export async function mindbodyIssueToken(env, siteId) {
  const apiKey = mindbodyApiKey(env);
  if (!apiKey) throw new Error('missing_api_key');
  const creds = issueCredentials(env, siteId);
  if (!creds) throw new Error('missing_issue_credentials');

  const res = await fetch(`${mbBase(env)}/usertoken/issue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': apiKey,
      SiteId: String(siteId),
    },
    body: JSON.stringify(creds),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('issue_non_json');
  }
  if (!res.ok) {
    const err = new Error(json?.Error?.Message || 'issue_failed');
    err.status = res.status;
    err.body = json;
    throw err;
  }
  const token = json.AccessToken || json.accessToken || json.access_token;
  if (!token) throw new Error('issue_no_token');
  return { token: String(token), issueJson: json };
}

/**
 * Cached staff AccessToken (KV or memory). TTL defaults to 5 minutes or Mindbody expiry minus slack.
 */
export async function mindbodyGetAccessToken(env, siteId) {
  const cached = await getCachedAccessToken(env, siteId);
  if (cached) return cached;

  const { token, issueJson } = await mindbodyIssueToken(env, siteId);
  let ttl = tokenTtlSeconds(env);
  const exp =
    issueJson?.Expires ||
    issueJson?.expires ||
    issueJson?.TokenExpires ||
    issueJson?.tokenExpires;
  if (exp) {
    const ms = typeof exp === 'string' ? Date.parse(exp) : Number(exp);
    if (Number.isFinite(ms) && ms > Date.now()) {
      const sec = Math.floor((ms - Date.now()) / 1000) - 30;
      if (sec >= 60) ttl = Math.min(ttl, sec);
    }
  }
  await setCachedAccessToken(env, siteId, token, ttl);
  return token;
}

function authHeaders(env, siteId, accessToken) {
  return {
    Accept: 'application/json',
    'Api-Key': mindbodyApiKey(env),
    SiteId: String(siteId),
    authorization: String(accessToken),
  };
}

function isoWeekRange() {
  const a = new Date();
  a.setUTCHours(0, 0, 0, 0);
  const b = new Date(a);
  b.setUTCDate(b.getUTCDate() + 7);
  return { start: a.toISOString(), end: b.toISOString() };
}

function appendLocationIds(qs, locationIds) {
  if (!Array.isArray(locationIds) || !locationIds.length) return;
  locationIds.forEach((id, i) => {
    const n = Number(id);
    if (Number.isFinite(n)) qs.set(`request.locationIds[${i}]`, String(Math.trunc(n)));
  });
}

export async function mindbodyGetClassSchedules(env, siteId, accessToken, opts = {}) {
  const { start, end } = isoWeekRange();
  const qs = new URLSearchParams();
  qs.set('request.startDate', start);
  qs.set('request.endDate', end);
  qs.set('request.limit', '100');
  appendLocationIds(qs, opts.locationIds);

  const res = await fetch(`${mbBase(env)}/class/classschedules?${qs}`, {
    headers: authHeaders(env, siteId, accessToken),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const err = new Error('schedules_non_json');
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(json?.Error?.Message || 'schedules_failed');
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/** Pricing options — v6 GET /sale/services */
export async function mindbodyGetServices(env, siteId, accessToken, opts = {}) {
  const qs = new URLSearchParams();
  qs.set('request.limit', '100');
  appendLocationIds(qs, opts.locationIds);

  const res = await fetch(`${mbBase(env)}/sale/services?${qs}`, {
    headers: authHeaders(env, siteId, accessToken),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const err = new Error('services_non_json');
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(json?.Error?.Message || 'services_failed');
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export function normalizeMindbodyLocationIds(doc) {
  const raw = doc && doc.mindbodyLocationIds;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((x) => Number(x)).filter((n) => Number.isFinite(n));
}

/**
 * @param {URL} url - request URL with ?slug=
 * @param {object} env - Worker env or process.env-shaped object
 * @param {{ fetchStudioBySlug: (s:string,p:string,d:string)=>Promise<object|null> }} sanity
 */
export async function handleMindbodyStudioApi(url, env, sanity) {
  const slug = url.searchParams.get('slug') && String(url.searchParams.get('slug')).trim();
  if (!slug) {
    return { status: 400, body: { error: 'missing_slug' } };
  }

  const projectId = env.SANITY_PROJECT_ID || 't0z5ndwm';
  const dataset = env.SANITY_DATASET || 'production';

  let doc;
  try {
    doc = await sanity.fetchStudioBySlug(slug, projectId, dataset);
  } catch {
    return { status: 500, body: { error: 'sanity_error' } };
  }
  if (!doc) return { status: 404, body: { error: 'studio_not_found' } };

  const rawId = doc.mindbodySiteId;
  const siteId =
    rawId === null || rawId === undefined || rawId === ''
      ? null
      : typeof rawId === 'number'
        ? rawId
        : Number(rawId);
  if (siteId == null || !Number.isFinite(siteId)) {
    return { status: 404, body: { error: 'mindbody_not_configured' } };
  }

  if (!mindbodyApiKey(env)) {
    return { status: 503, body: { error: 'mindbody_not_configured_server' } };
  }

  const locationIds = normalizeMindbodyLocationIds(doc);
  const mbOpts = locationIds.length ? { locationIds } : {};

  try {
    const token = await mindbodyGetAccessToken(env, siteId);
    let classSchedules = null;
    let services = null;
    const partialErrors = {};
    try {
      classSchedules = await mindbodyGetClassSchedules(env, siteId, token, mbOpts);
    } catch (e) {
      partialErrors.classSchedules = e && e.message ? String(e.message) : 'failed';
    }
    try {
      services = await mindbodyGetServices(env, siteId, token, mbOpts);
    } catch (e) {
      partialErrors.services = e && e.message ? String(e.message) : 'failed';
    }
    return {
      status: 200,
      body: {
        slug,
        mindbodySiteId: siteId,
        ...(locationIds.length ? { mindbodyLocationIds: locationIds } : {}),
        classSchedules,
        services,
        ...(Object.keys(partialErrors).length ? { partialErrors } : {}),
      },
    };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : 'mindbody_error';
    const status = e && e.status >= 400 && e.status < 600 ? e.status : 502;
    return {
      status,
      body: {
        error: msg,
        detail: e && e.body ? e.body : undefined,
      },
    };
  }
}
