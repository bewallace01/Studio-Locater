/**
 * Serves the Studio Locater front end and proxies Yelp Fusion (API key stays server-side).
 * Live Yelp results are not written to Sanity — see docs/api-compliance.md
 *
 * Run: npm install && cp .env.example .env && npm start
 */
const path = require('path');
require('dotenv').config();
require('dotenv').config({ path: path.join(__dirname, 'studio', '.env') });
const express = require('express');

const app = express();
app.use(express.json({ limit: '48kb' }));
const PORT = Number(process.env.PORT) || 3040;
const YELP_KEY = process.env.YELP_API_KEY;
const SANITY_PROJECT_ID =
  process.env.SANITY_STUDIO_PROJECT_ID || process.env.SANITY_PROJECT_ID || 't0z5ndwm';
const SANITY_DATASET = process.env.SANITY_STUDIO_DATASET || process.env.SANITY_DATASET || 'production';
const GOOGLE_PLACES_KEY =
  process.env.GOOGLE_API_KEY || process.env.SANITY_STUDIO_GOOGLE_MAPS_API_KEY || '';

const publicDir = path.join(__dirname, 'public');

/** Local stub: signup tracking persists only on the Cloudflare Worker (D1). */
app.post('/api/track/signup', (_req, res) => {
  res.json({ ok: true, local: true });
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/sitemap.xml', async (req, res) => {
  try {
    const { fetchAllStudioSlugs, buildSitemapXml } = await import(
      path.join(__dirname, 'studio-detail-page.mjs')
    );
    const slugs = await fetchAllStudioSlugs(SANITY_PROJECT_ID, SANITY_DATASET);
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const origin = `${proto}://${req.get('host') || 'localhost'}`;
    res.type('application/xml').send(buildSitemapXml(origin, slugs));
  } catch (e) {
    console.error(e);
    res.status(500).type('application/xml').send('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>');
  }
});

app.get('/studios/id/:docId', async (req, res) => {
  try {
    const {
      fetchStudioByDocumentId,
      enrichStudioWithGooglePlaces,
      buildStudioDetailHtml,
      buildStudioNotFoundHtml
    } = await import(path.join(__dirname, 'studio-detail-page.mjs'));
    const docId = String(req.params.docId || '').trim();
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host') || 'localhost';
    const origin = `${proto}://${host}`;
    const canonicalUrl = `${origin}${req.path.endsWith('/') ? req.path.slice(0, -1) : req.path}`;

    const doc = await fetchStudioByDocumentId(docId, SANITY_PROJECT_ID, SANITY_DATASET);
    if (!doc) {
      res.status(404).type('html').send(buildStudioNotFoundHtml(`${origin}/`));
      return;
    }
    const { doc: merged, augmented } = await enrichStudioWithGooglePlaces(doc, GOOGLE_PLACES_KEY);
    res.type('html').send(
      buildStudioDetailHtml(merged, { canonicalUrl, robotsNoIndex: true, googleAugmented: augmented })
    );
  } catch (e) {
    console.error(e);
    res.status(500).type('html').send('Server error');
  }
});

app.get('/studios/:slug', async (req, res) => {
  try {
    const {
      fetchStudioBySlug,
      enrichStudioWithGooglePlaces,
      buildStudioDetailHtml,
      buildStudioNotFoundHtml
    } = await import(path.join(__dirname, 'studio-detail-page.mjs'));
    const slug = String(req.params.slug || '').trim();
    if (slug === 'id') {
      const proto = req.headers['x-forwarded-proto'] || req.protocol;
      const origin = `${proto}://${req.get('host') || 'localhost'}`;
      res.status(404).type('html').send(buildStudioNotFoundHtml(`${origin}/`));
      return;
    }
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host') || 'localhost';
    const origin = `${proto}://${host}`;
    const canonicalUrl = `${origin}${req.path.endsWith('/') ? req.path.slice(0, -1) : req.path}`;

    const doc = await fetchStudioBySlug(slug, SANITY_PROJECT_ID, SANITY_DATASET);
    if (!doc) {
      res.status(404).type('html').send(buildStudioNotFoundHtml(`${origin}/`));
      return;
    }
    const { doc: merged, augmented } = await enrichStudioWithGooglePlaces(doc, GOOGLE_PLACES_KEY);
    res.type('html').send(buildStudioDetailHtml(merged, { canonicalUrl, googleAugmented: augmented }));
  } catch (e) {
    console.error(e);
    res.status(500).type('html').send('Server error');
  }
});

app.use(express.static(publicDir));

function makePlaceholderClasses() {
  const names = ['Morning Flow', 'Midday Reset', 'Evening Wind-down', 'Core Fundamentals'];
  const types = ['Yoga', 'Pilates', 'Barre', 'Meditation'];
  const times = ['7:00 AM', '9:30 AM', '12:00 PM', '5:30 PM'];
  const instructors = ['Alex M.', 'Jordan P.', 'Riley S.', 'Casey T.'];
  return names.map((name, i) => ({
    name,
    type: types[i],
    time: times[i],
    dur: '55 min',
    instructor: instructors[i],
    spots: 3 + Math.floor(Math.random() * 8),
    price: 22 + Math.floor(Math.random() * 28)
  }));
}

function tagsFromYelpCategories(categories) {
  const aliases = (categories || []).map(c => (c.alias || '').toLowerCase()).join(' ');
  const titles = (categories || []).map(c => (c.title || '').toLowerCase()).join(' ');
  const t = aliases + ' ' + titles;
  const tags = [];
  if (/hot.?yoga|bikram/.test(t)) tags.push('Hot Yoga');
  else if (/yoga|vinyasa/.test(t)) tags.push('Yoga');
  if (/pilates|reformer/.test(t)) {
    tags.push('Pilates');
    if (/reformer/.test(t)) tags.push('Reformer');
  }
  if (/barre/.test(t)) tags.push('Barre');
  if (/meditat|mindfulness/.test(t)) tags.push('Meditation');
  if (!tags.length) tags.push('Yoga');
  return [...new Set(tags)].slice(0, 5);
}

function pickIconFromTags(tags) {
  if (tags.includes('Hot Yoga')) return 'fa-fire';
  if (tags.includes('Meditation')) return 'fa-brain';
  if (tags.includes('Barre')) return 'fa-music';
  if (tags.includes('Pilates')) return 'fa-person-walking';
  if (tags.includes('Yoga')) return 'fa-leaf';
  return 'fa-spa';
}

function priceToNum(price) {
  if (!price || typeof price !== 'string') return 2;
  return Math.min(3, Math.max(1, price.length));
}

function yelpBusinessToStudio(b, idx) {
  const coords = b.coordinates;
  if (!coords || coords.latitude == null || coords.longitude == null) return null;
  const tags = tagsFromYelpCategories(b.categories);
  const addr = b.location && Array.isArray(b.location.display_address)
    ? b.location.display_address.join(', ')
    : '';
  return {
    id: 'yelp_' + b.id,
    name: (b.name || 'Studio').slice(0, 80),
    lat: coords.latitude,
    lng: coords.longitude,
    rating: b.rating != null ? b.rating : 4.5,
    reviews: b.review_count != null ? b.review_count : 0,
    priceLabel: b.price || '$$',
    priceNum: priceToNum(b.price),
    address: addr,
    tags,
    grad: 'g' + (1 + (idx % 8)),
    icon: pickIconFromTags(tags),
    badge: 'Yelp',
    classes: makePlaceholderClasses(),
    _source: 'yelp',
    yelpUrl: b.url || ''
  };
}

app.get('/api/studios', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'bad_coords', studios: [] });
  }

  if (!YELP_KEY || !YELP_KEY.trim()) {
    return res.json({ error: 'no_key', studios: [], message: 'Set YELP_API_KEY in .env' });
  }

  try {
    const url = new URL('https://api.yelp.com/v3/businesses/search');
    url.searchParams.set('latitude', String(lat));
    url.searchParams.set('longitude', String(lng));
    url.searchParams.set('radius', '40000');
    url.searchParams.set('limit', '50');
    url.searchParams.set('sort_by', 'rating');
    url.searchParams.set('term', 'yoga pilates barre meditation fitness wellness');

    const r = await fetch(url, {
      headers: {
        Authorization: 'Bearer ' + YELP_KEY.trim(),
        'Accept-Language': 'en_US'
      }
    });

    const data = await r.json();
    if (!r.ok) {
      const msg = data.error && data.error.description ? data.error.description : r.statusText;
      return res.status(502).json({ error: 'yelp_error', detail: msg, studios: [] });
    }

    const businesses = data.businesses || [];
    const studios = businesses
      .map((b, i) => yelpBusinessToStudio(b, i))
      .filter(Boolean);

    res.json({ studios, source: 'yelp' });
  } catch (e) {
    res.status(500).json({ error: 'server', detail: String(e.message), studios: [] });
  }
});

app.listen(PORT, () => {
  console.log(`Studio Locater (map): http://127.0.0.1:${PORT}/`);
  console.log(`Serving from: ${publicDir}`);
  if (PORT === 3000) {
    console.log('If the browser shows 404, another process may be bound to :3000 — use PORT=3040 in .env');
  }
  if (!YELP_KEY) {
    console.log('Tip: add YELP_API_KEY to .env for Yelp discovery (see docs/api-compliance.md).');
  }
});
