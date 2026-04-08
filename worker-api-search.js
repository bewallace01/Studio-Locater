const NOMINATIM_UA = 'StudioLocater/1.0 (geocode proxy; contact via site)';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '') {
      const example = `${url.origin}/api/search?lat=34.05&lng=-118.25&type=yoga`;
      const html = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Studio Locater API</title>
<style>
  :root { --bg:#fdf8f8; --text:#3d2b3d; --muted:#6b5a6b; --accent:#c97e84; --code:#f5eaea; }
  body { font-family:system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--text); margin:0; padding:24px; line-height:1.55; }
  .wrap { max-width:36rem; margin:0 auto; }
  h1 { font-size:1.35rem; font-weight:600; letter-spacing:-0.02em; margin:0 0 8px; }
  .sub { color:var(--muted); font-size:0.95rem; margin-bottom:28px; }
  h2 { font-size:0.75rem; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); margin:20px 0 10px; }
  .ep { background:#fff; border:1px solid rgba(201,126,132,.25); border-radius:12px; padding:14px 16px; margin-bottom:12px; }
  .ep strong { display:block; font-size:0.9rem; margin-bottom:6px; }
  code { font-size:0.82rem; background:var(--code); padding:2px 6px; border-radius:6px; }
  .hint { font-size:0.88rem; color:var(--muted); margin-top:6px; }
  a { color:var(--accent); font-weight:600; text-decoration:none; border-bottom:1px solid rgba(201,126,132,.4); }
  a:hover { border-bottom-color:var(--accent); }
  footer { margin-top:32px; font-size:0.85rem; color:var(--muted); }
</style></head><body>
<div class="wrap">
  <h1>Studio Locater API</h1>
  <p class="sub">Backend for search and geocoding. The public site is separate; this URL is only for API traffic.</p>
  <h2>Endpoints</h2>
  <div class="ep">
    <strong>GET /api/search</strong>
    <div>Query: <code>lat</code>, <code>lng</code>, optional <code>type</code> (keyword). Returns Google Places near your point, merged with Sanity when <code>placeId</code> matches.</div>
    <div class="hint">JSON array of results. Optional server-side: set <code>SANITY_AUTO_IMPORT=1</code> and <code>SANITY_API_TOKEN</code> (secret) to upsert new Google-only rows into your dataset after each search (see wrangler.api-search.toml).</div>
  </div>
  <div class="ep">
    <strong>GET /api/geocode</strong>
    <div>Query: <code>q</code> (address or place name). Forward geocode via Nominatim — used so browsers on your live site avoid CORS issues.</div>
  </div>
  <div class="ep">
    <strong>GET /api/reverse</strong>
    <div>Query: <code>lat</code>, <code>lng</code>. Reverse geocode for labels.</div>
  </div>
  <p><a href="${example}">Try sample JSON → /api/search</a></p>
  <footer>Studio Locater · Cloudflare Worker</footer>
</div>
</body></html>`;
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method Not Allowed' }, 405);
    }

    try {
      if (url.pathname === '/api/geocode') {
        return await handleGeocodeProxy(url);
      }
      if (url.pathname === '/api/reverse') {
        return await handleReverseProxy(url);
      }
      if (url.pathname === '/api/search') {
        return await handleSearch(request, env, ctx);
      }
      return jsonResponse({ error: 'Not Found' }, 404);
    } catch (e) {
      return jsonResponse(
        { error: 'Internal Server Error', detail: String(e && e.message ? e.message : e) },
        500
      );
    }
  }
};

async function handleGeocodeProxy(url) {
  const q = url.searchParams.get('q');
  if (!q || !String(q).trim()) {
    return jsonResponse({ error: 'Bad Request', detail: 'q required' }, 400);
  }
  const nomUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
    String(q).trim()
  )}&limit=1`;
  const res = await fetch(nomUrl, {
    headers: {
      'User-Agent': NOMINATIM_UA,
      'Accept-Language': 'en'
    }
  });
  if (!res.ok) {
    return jsonResponse({ error: 'Upstream geocode failed', detail: String(res.status) }, 502);
  }
  const data = await res.json();
  return new Response(JSON.stringify(Array.isArray(data) ? data : []), {
    status: 200,
    headers: corsHeaders()
  });
}

async function handleReverseProxy(url) {
  const lat = url.searchParams.get('lat');
  const lng = url.searchParams.get('lng') || url.searchParams.get('lon');
  const la = parseFloat(lat);
  const lo = parseFloat(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) {
    return jsonResponse({ error: 'Bad Request', detail: 'lat and lng required' }, 400);
  }
  const nomUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(
    lat
  )}&lon=${encodeURIComponent(lng)}`;
  const res = await fetch(nomUrl, {
    headers: {
      'User-Agent': NOMINATIM_UA,
      'Accept-Language': 'en'
    }
  });
  if (!res.ok) {
    return jsonResponse({ error: 'Upstream reverse failed', detail: String(res.status) }, 502);
  }
  const data = await res.json();
  return new Response(JSON.stringify(data), { status: 200, headers: corsHeaders() });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8'
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}

/** When the client sends no `type`, Nearby Search would return random POIs — bias toward studios. */
const DEFAULT_NEARBY_KEYWORD =
  'yoga pilates barre fitness studio class infrared hot yoga meditation lagree megaformer solidcore aerial trx';

/**
 * Drop obvious non-studio results (restaurants, shops) while keeping gyms, spas, and name matches.
 */
function filterFitnessLikePlaces(results) {
  if (!Array.isArray(results) || !results.length) return results;
  const NAME_RE =
    /yoga|pilates|barre|fitness|meditation|reformer|bikram|wellness|stretch|core|sculpt|spin|cycle|athletic|gym|studio|training|\bhiit\b|namaste|vinyasa|ashtanga|power\s*yoga|hot\s*yoga|mat\s*pilates|lagree|megaformer|solidcore|solid\s*core|infrared|infra[\s-]?red|aerial|trx|bungee|rowing|boxing|bootcamp|kickboxing|rumble|tone\s*house|soulcycle|oranj/i;
  const FIT_TYPES = new Set(['gym', 'spa', 'physiotherapist']);
  const STRONG_FOOD = new Set(['restaurant', 'meal_takeaway', 'food', 'cafe', 'bar']);
  return results.filter((r) => {
    const name = r.name || '';
    const types = r.types || [];
    if (types.some((t) => STRONG_FOOD.has(t)) && !NAME_RE.test(name)) return false;
    if (NAME_RE.test(name)) return true;
    if (types.some((t) => FIT_TYPES.has(t))) return true;
    return false;
  });
}

async function fetchGooglePlaces(lat, lng, keyword, apiKey) {
  const params = new URLSearchParams({
    location: `${lat},${lng}`,
    radius: '5000',
    keyword: keyword || DEFAULT_NEARBY_KEYWORD,
    key: apiKey
  });
  const res = await fetch(
    `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${params.toString()}`
  );
  if (!res.ok) {
    throw new Error(`Google Places HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(data.error_message || `Google Places status: ${data.status}`);
  }
  const raw = Array.isArray(data.results) ? data.results : [];
  const filtered = filterFitnessLikePlaces(raw);
  return filtered.length ? filtered : raw;
}

async function fetchSanityStudios(env, placeIds) {
  if (!placeIds.length) return [];
  const projectId = String(env.SANITY_PROJECT_ID || '').trim();
  const dataset = String(env.SANITY_DATASET || '').trim();
  if (!projectId || !dataset) {
    throw new Error('Missing SANITY_PROJECT_ID or SANITY_DATASET');
  }
  const groq =
    '*[_type == "studio" && placeId in $placeIds]{ placeId, tags, featured, description, website, rating, reviews, reviewHighlight, experienceLevel, vibeTags, classTips, "slug": slug.current, "cardImageUrl": cardImage.asset->url }';
  const base = `https://${projectId}.apicdn.sanity.io/v2024-01-01/data/query/${dataset}`;
  const u = new URL(base);
  u.searchParams.set('query', groq);
  u.searchParams.set('$placeIds', JSON.stringify(placeIds));
  const res = await fetch(u.toString());
  if (!res.ok) {
    throw new Error(`Sanity HTTP ${res.status}`);
  }
  const data = await res.json();
  return Array.isArray(data.result) ? data.result : [];
}

function googlePhotoUrl(photoReference, apiKey) {
  if (!photoReference || !apiKey) return null;
  const ref = encodeURIComponent(String(photoReference));
  return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=${ref}&key=${encodeURIComponent(
    apiKey
  )}`;
}

function mergeResults(googleResults, sanityResults, googleApiKey) {
  const sanityById = new Map();
  for (const r of sanityResults || []) {
    if (r && r.placeId) sanityById.set(r.placeId, r);
  }
  return googleResults.map((r) => {
    const sid = r.place_id;
    const s = sanityById.get(sid) || {};
    const loc = r.geometry && r.geometry.location ? r.geometry.location : {};
    const photoRef =
      Array.isArray(r.photos) && r.photos[0] && r.photos[0].photo_reference
        ? r.photos[0].photo_reference
        : null;
    const googleImg = googlePhotoUrl(photoRef, googleApiKey);
    const cmsImg = s.cardImageUrl && String(s.cardImageUrl).trim() ? String(s.cardImageUrl).trim() : null;
    const reviewsGoogle =
      typeof r.user_ratings_total === 'number' && Number.isFinite(r.user_ratings_total)
        ? r.user_ratings_total
        : 0;
    const reviewsSanity = typeof s.reviews === 'number' && Number.isFinite(s.reviews) ? s.reviews : null;
    const ratingSanity = typeof s.rating === 'number' && Number.isFinite(s.rating) ? s.rating : null;

    return {
      placeId: sid,
      name: r.name || '',
      rating: ratingSanity != null ? ratingSanity : r.rating != null ? r.rating : null,
      reviews: reviewsSanity != null ? reviewsSanity : reviewsGoogle,
      address: r.vicinity || '',
      lat: loc.lat != null ? loc.lat : null,
      lng: loc.lng != null ? loc.lng : null,
      tags: Array.isArray(s.tags) ? s.tags : [],
      featured: typeof s.featured === 'boolean' ? s.featured : false,
      description: s.description != null ? s.description : null,
      reviewHighlight: s.reviewHighlight != null && String(s.reviewHighlight).trim() ? String(s.reviewHighlight).trim() : null,
      imageUrl: cmsImg || googleImg || null,
      experienceLevel: s.experienceLevel && String(s.experienceLevel).trim() ? String(s.experienceLevel).trim() : null,
      vibeTags: Array.isArray(s.vibeTags) ? s.vibeTags.filter(Boolean) : [],
      classTips: s.classTips != null && String(s.classTips).trim() ? String(s.classTips).trim() : null,
      website: s.website != null && String(s.website).trim() ? String(s.website).trim() : null,
      slug: s.slug != null && String(s.slug).trim() ? String(s.slug).trim() : null
    };
  });
}

function slugify(name) {
  return String(name || 'studio')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'studio';
}

/** Same deterministic ids as `scripts/import-from-search-api.mjs` (SHA-256 prefix). */
async function stableStudioId(placeId) {
  const enc = new TextEncoder().encode(String(placeId));
  const buf = await crypto.subtle.digest('SHA-256', enc);
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `import-${hex.slice(0, 32)}`;
}

function vicinityToAddress(vicinity) {
  const s = String(vicinity || '').trim();
  if (!s) {
    return {
      _type: 'address',
      streetLine1: 'Address from Google',
      city: 'Unknown',
      region: '',
      country: 'US'
    };
  }
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1) {
    return {
      _type: 'address',
      streetLine1: parts[0],
      city: parts[0],
      region: '',
      country: 'US'
    };
  }
  if (parts.length === 2) {
    return {
      _type: 'address',
      streetLine1: parts[0],
      city: parts[1],
      region: '',
      country: 'US'
    };
  }
  return {
    _type: 'address',
    streetLine1: parts[0],
    city: parts[1],
    region: parts[2],
    country: 'US'
  };
}

/** Studio schema uses precision(1) — Google can return 4.666. */
function roundRating1(n) {
  const x = typeof n === 'number' && Number.isFinite(n) ? n : 4.5;
  return Math.round(x * 10) / 10;
}

/**
 * Upsert Google-only rows into Sanity (optional).
 * Requires secret SANITY_API_TOKEN and SANITY_AUTO_IMPORT=1.
 * @returns {{ ok: boolean, detail: string }}
 */
async function runSanityAutoImport(env, merged, sanityResults) {
  const auto = String(env.SANITY_AUTO_IMPORT || '').trim();
  if (auto !== '1' && auto.toLowerCase() !== 'true') {
    return { ok: false, detail: 'disabled' };
  }

  const token = String(env.SANITY_API_TOKEN || env.SANITY_WRITE_TOKEN || '').trim();
  const projectId = String(env.SANITY_PROJECT_ID || '').trim();
  const dataset = String(env.SANITY_DATASET || '').trim();
  if (!token) {
    return { ok: false, detail: 'missing_token' };
  }
  if (!projectId || !dataset) {
    return { ok: false, detail: 'missing_project' };
  }

  const max = Math.min(
    100,
    Math.max(1, parseInt(String(env.SANITY_AUTO_IMPORT_MAX || '25'), 10) || 25)
  );

  const inSanity = new Set((sanityResults || []).map((r) => r.placeId).filter(Boolean));
  const pending = merged.filter(
    (m) =>
      m.placeId &&
      !inSanity.has(m.placeId) &&
      m.lat != null &&
      m.lng != null &&
      Number.isFinite(+m.lat) &&
      Number.isFinite(+m.lng)
  );
  if (!pending.length) {
    return { ok: true, detail: 'no_pending', written: 0 };
  }

  const slice = pending.slice(0, max);
  const mutations = [];

  for (const row of slice) {
    const _id = await stableStudioId(row.placeId);
    const name = row.name || 'Studio';
    const tags = Array.isArray(row.tags) && row.tags.length ? row.tags : ['Yoga'];
    const slugSuffix = _id.replace(/^import-/, '').slice(0, 10);
    const slugCurrent = `${slugify(name)}-${slugSuffix}`.slice(0, 96);
    const doc = {
      _id,
      _type: 'studio',
      name,
      slug: { _type: 'slug', current: slugCurrent },
      address: vicinityToAddress(row.address),
      location: { _type: 'geopoint', lat: row.lat, lng: row.lng },
      placeId: row.placeId,
      tags,
      rating: roundRating1(row.rating),
      reviews: 0,
      priceTier: 2,
      featured: false
    };
    mutations.push({ createOrReplace: doc });
  }

  const url = `https://${projectId}.api.sanity.io/v2024-01-01/data/mutate/${encodeURIComponent(
    dataset
  )}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ mutations })
  });
  const text = await res.text();
  if (!res.ok) {
    console.error('Sanity auto-import failed:', res.status, text);
    return { ok: false, detail: `http_${res.status}`, body: text.slice(0, 500) };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: true, detail: 'ok', written: mutations.length };
  }
  const results = parsed.results || [];
  const written = results.filter((r) => r.operation === 'create' || r.operation === 'update').length;
  console.log('Sanity auto-import ok:', written || mutations.length, 'documents');
  return { ok: true, detail: 'ok', written: written || mutations.length };
}

async function handleSearch(request, env, ctx) {
  const GOOGLE_API_KEY = env.GOOGLE_API_KEY;
  const SANITY_PROJECT_ID = String(env.SANITY_PROJECT_ID || '').trim();
  const SANITY_DATASET = String(env.SANITY_DATASET || '').trim();
  if (!GOOGLE_API_KEY) {
    return jsonResponse({ error: 'Server misconfiguration', detail: 'GOOGLE_API_KEY' }, 500);
  }
  if (!SANITY_PROJECT_ID || !SANITY_DATASET) {
    return jsonResponse(
      { error: 'Server misconfiguration', detail: 'SANITY_PROJECT_ID / SANITY_DATASET' },
      500
    );
  }
  const envSanity = { SANITY_PROJECT_ID, SANITY_DATASET };

  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get('lat'));
  const lng = parseFloat(url.searchParams.get('lng'));
  const typeParam = (url.searchParams.get('type') || '').trim();
  const keyword = typeParam || DEFAULT_NEARBY_KEYWORD;

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return jsonResponse({ error: 'Bad Request', detail: 'lat and lng are required' }, 400);
  }

  let googleResults;
  try {
    googleResults = await fetchGooglePlaces(lat, lng, keyword, GOOGLE_API_KEY);
  } catch (e) {
    return jsonResponse(
      { error: 'Google Places failed', detail: String(e && e.message ? e.message : e) },
      500
    );
  }

  const placeIds = googleResults.map(r => r.place_id).filter(Boolean);

  let sanityResults = [];
  try {
    sanityResults = await fetchSanityStudios(envSanity, placeIds);
  } catch (e) {
    sanityResults = [];
  }

  const merged = mergeResults(googleResults, sanityResults, GOOGLE_API_KEY);

  const headers = new Headers(corsHeaders());
  const importDebug = String(env.SANITY_IMPORT_DEBUG || '').trim() === '1';

  if (importDebug) {
    headers.set('Access-Control-Expose-Headers', 'X-Sanity-Import');
    const result = await runSanityAutoImport(env, merged, sanityResults).catch((e) => ({
      ok: false,
      detail: 'exception',
      err: String(e && e.message ? e.message : e)
    }));
    const label =
      result.detail === 'disabled'
        ? 'off'
        : result.detail === 'missing_token'
          ? 'missing_token'
          : result.detail === 'missing_project'
            ? 'missing_project'
            : result.detail === 'no_pending'
              ? 'no_pending'
              : result.ok
                ? `ok:${result.written ?? 0}`
                : `error:${result.detail}${result.body ? ':' + result.body.slice(0, 120) : ''}${result.err ? ':' + result.err : ''}`;
    headers.set('X-Sanity-Import', label);
  } else if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(
      runSanityAutoImport(env, merged, sanityResults).catch((e) =>
        console.error('Sanity auto-import:', e)
      )
    );
  }

  return new Response(JSON.stringify(merged), { status: 200, headers });
}
