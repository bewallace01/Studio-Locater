/**
 * Server-rendered studio detail HTML for SEO (canonical URL, meta, JSON-LD).
 * Used by Cloudflare worker.js and Express (server.js).
 */

const EXPERIENCE_LABELS = {
  beginner: 'Beginner-friendly',
  all_levels: 'All levels',
  mixed: 'Mixed levels',
  intermediate: 'Intermediate+',
  advanced: 'Advanced'
};

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function normalizeExternalUrl(href) {
  const t = String(href || '').trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  if (/^\/\//.test(t)) return 'https:' + t;
  return 'https://' + t;
}

export function formatSanityAddress(addr) {
  if (addr == null || addr === '') return '';
  if (typeof addr === 'string') return addr;
  const line1 = addr.streetLine1 || '';
  const line2 = addr.streetLine2 && String(addr.streetLine2).trim() ? ', ' + addr.streetLine2 : '';
  const cityLine = [addr.city, addr.region].filter(Boolean).join(', ');
  const zipCountry = [addr.postalCode, addr.country].filter(Boolean).join(' ');
  const parts = [];
  if (line1) parts.push(line1 + line2);
  if (cityLine) parts.push(cityLine);
  if (zipCountry) parts.push(zipCountry);
  return parts.join(', ') || '';
}

function experienceLevelLabel(key) {
  const k = String(key || '').trim();
  return EXPERIENCE_LABELS[k] || '';
}

function priceLabel(tier) {
  const pr = Math.min(3, Math.max(1, typeof tier === 'number' && Number.isFinite(tier) ? tier : 2));
  return ['$', '$$', '$$$'][pr - 1];
}

function metaDescription(studio) {
  const d =
    (studio.description && String(studio.description).trim()) ||
    (studio.reviewHighlight && String(studio.reviewHighlight).trim()) ||
    (studio.classTips && String(studio.classTips).trim()) ||
    '';
  const line = d.replace(/\s+/g, ' ').trim();
  if (line.length <= 165) return line;
  return line.slice(0, 162).trim() + '…';
}

function jsonLdLocalBusiness(studio, canonicalUrl) {
  const name = studio.name || 'Studio';
  const addr = studio.address;
  const street = addr && typeof addr === 'object' ? [addr.streetLine1, addr.streetLine2].filter(Boolean).join(', ') : '';
  const locality = addr && addr.city ? String(addr.city) : '';
  const region = addr && addr.region ? String(addr.region) : '';
  const postal = addr && addr.postalCode ? String(addr.postalCode) : '';
  const country = addr && addr.country ? String(addr.country) : 'US';
  const lat = studio.lat != null && Number.isFinite(+studio.lat) ? +studio.lat : null;
  const lng = studio.lng != null && Number.isFinite(+studio.lng) ? +studio.lng : null;
  const img = studio.cardImageUrl && String(studio.cardImageUrl).trim() ? String(studio.cardImageUrl).trim() : null;
  const sameAs = [];
  if (studio.website && String(studio.website).trim()) sameAs.push(normalizeExternalUrl(studio.website));

  const obj = {
    '@context': 'https://schema.org',
    '@type': 'SportsActivityLocation',
    name,
    description: metaDescription(studio) || undefined,
    url: canonicalUrl,
    image: img || undefined,
    address: {
      '@type': 'PostalAddress',
      streetAddress: street || undefined,
      addressLocality: locality || undefined,
      addressRegion: region || undefined,
      postalCode: postal || undefined,
      addressCountry: country
    },
    geo:
      lat != null && lng != null
        ? {
            '@type': 'GeoCoordinates',
            latitude: lat,
            longitude: lng
          }
        : undefined,
    aggregateRating:
      typeof studio.rating === 'number' &&
      Number.isFinite(studio.rating) &&
      typeof studio.reviews === 'number' &&
      studio.reviews > 0
        ? {
            '@type': 'AggregateRating',
            ratingValue: studio.rating,
            reviewCount: studio.reviews,
            bestRating: 5,
            worstRating: 1
          }
        : undefined,
    sameAs: sameAs.length ? sameAs : undefined
  };

  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

/**
 * @param {object} studio - document from fetchStudioBySlug (plain fields + address object)
 * @param {{ canonicalUrl: string }} opts
 */
export function buildStudioDetailHtml(studio, opts) {
  const { canonicalUrl } = opts;
  const name = escapeHtml(studio.name || 'Studio');
  const addrLine = escapeHtml(formatSanityAddress(studio.address));
  const desc = studio.description && String(studio.description).trim();
  const metaDesc = escapeHtml(metaDescription(studio) || `${studio.name || 'Studio'} — boutique fitness on Studio Locater.`);
  const img = studio.cardImageUrl && String(studio.cardImageUrl).trim() ? escapeHtml(String(studio.cardImageUrl).trim()) : '';
  const website = studio.website && String(studio.website).trim() ? normalizeExternalUrl(studio.website) : '';
  const level = experienceLevelLabel(studio.experienceLevel);
  const vibes = Array.isArray(studio.vibeTags) ? studio.vibeTags.filter(Boolean) : [];
  const tips = studio.classTips && String(studio.classTips).trim();
  const highlight = studio.reviewHighlight && String(studio.reviewHighlight).trim();
  const rating =
    typeof studio.rating === 'number' && Number.isFinite(studio.rating) ? studio.rating.toFixed(1) : '';
  const revs =
    typeof studio.reviews === 'number' && Number.isFinite(studio.reviews) ? studio.reviews : 0;
  const price = priceLabel(studio.priceTier);
  const tags = Array.isArray(studio.tags) ? studio.tags.filter(Boolean) : [];

  const jsonLd = jsonLdLocalBusiness(
    { ...studio, lat: studio.lat, lng: studio.lng, cardImageUrl: studio.cardImageUrl },
    canonicalUrl
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name} | Studio Locater</title>
  <meta name="description" content="${metaDesc}">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <meta property="og:title" content="${name} | Studio Locater">
  <meta property="og:description" content="${metaDesc}">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:type" content="website">
  ${img ? `<meta property="og:image" content="${img}">` : ''}
  <meta name="twitter:card" content="summary_large_image">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600&family=DM+Sans:opsz,wght@9..40,400;9..40,600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
  <script type="application/ld+json">${jsonLd}</script>
  <style>
    :root {
      --blush:#F9EAEA; --rose-deep:#C97E84; --lavender-deep:#B39DDB; --plum:#3D2B3D;
      --plum-mid:#6B4C6B; --plum-light:#9E7E9E; --border:#F0DCE0; --off:#FDF8F8;
    }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:'DM Sans',sans-serif; background:var(--off); color:var(--plum); line-height:1.65; -webkit-font-smoothing:antialiased; }
    .wrap { max-width:720px; margin:0 auto; padding:24px 20px 80px; }
    nav { padding:16px 0 28px; }
    nav a { color:var(--rose-deep); font-weight:600; text-decoration:none; font-size:14px; }
    nav a:hover { text-decoration:underline; }
    h1 { font-family:'Playfair Display',serif; font-size:clamp(1.75rem,4vw,2.25rem); font-weight:600; color:var(--plum); margin-bottom:12px; line-height:1.2; }
    .hero-img { width:100%; border-radius:16px; margin:20px 0; max-height:360px; object-fit:cover; border:1px solid var(--border); }
    .meta { display:flex; flex-wrap:wrap; gap:12px 20px; align-items:center; color:var(--plum-mid); font-size:14px; margin-bottom:20px; }
    .meta strong { color:var(--plum); }
    .addr { display:flex; gap:8px; align-items:flex-start; font-size:14px; color:var(--plum-mid); margin-bottom:20px; }
    .addr i { color:var(--rose-deep); margin-top:3px; }
    .btn-row { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:28px; }
    .btn { display:inline-flex; align-items:center; gap:8px; padding:10px 18px; border-radius:50px; font-size:13px; font-weight:600; text-decoration:none; transition:background .2s,color .2s; }
    .btn-primary { background:var(--blush); color:var(--rose-deep); border:none; }
    .btn-primary:hover { background:var(--rose-deep); color:#fff; }
    .btn-ghost { background:#fff; color:var(--plum-mid); border:1.5px solid var(--border); }
    .btn-ghost:hover { border-color:var(--rose-deep); color:var(--rose-deep); }
    .prose { font-size:15px; color:var(--plum-mid); margin-bottom:22px; }
    .prose h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--plum-light); margin:24px 0 10px; font-weight:700; }
    .pill { display:inline-block; padding:5px 12px; border-radius:50px; font-size:12px; font-weight:600; background:var(--blush); color:var(--rose-deep); margin:3px 6px 3px 0; }
    .tags span { display:inline-block; padding:4px 10px; border-radius:50px; font-size:12px; background:#fff; border:1px solid var(--border); margin:3px 6px 3px 0; color:var(--plum-mid); }
    blockquote { border-left:3px solid var(--rose-deep); padding-left:16px; margin:16px 0; font-style:italic; color:var(--plum-mid); }
  </style>
</head>
<body>
  <div class="wrap">
    <nav><a href="/"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Back to search</a></nav>
    <article itemscope itemtype="https://schema.org/SportsActivityLocation">
      <header>
        <h1 itemprop="name">${name}</h1>
        <div class="meta">
          ${rating ? `<span><i class="fa-solid fa-star" style="color:#C9A96E"></i> <strong>${rating}</strong> (${revs.toLocaleString()} reviews)</span>` : ''}
          <span><strong>${escapeHtml(price)}</strong></span>
          ${level ? `<span class="pill">${escapeHtml(level)}</span>` : ''}
        </div>
        ${img ? `<img class="hero-img" src="${img}" alt="" itemprop="image" width="800" height="450" loading="eager">` : ''}
        ${addrLine ? `<div class="addr"><i class="fa-solid fa-location-dot" aria-hidden="true"></i><span itemprop="address">${addrLine}</span></div>` : ''}
        <div class="btn-row">
          <a class="btn btn-primary" href="/">Find classes nearby</a>
          ${website ? `<a class="btn btn-ghost" href="${escapeHtml(website)}" target="_blank" rel="noopener noreferrer" itemprop="url">Official website <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:11px;opacity:.8"></i></a>` : ''}
        </div>
      </header>
      ${highlight ? `<blockquote>${escapeHtml(highlight)}</blockquote>` : ''}
      ${desc ? `<section class="prose" itemprop="description">${escapeHtml(desc).replace(/\n/g, '<br>')}</section>` : ''}
      ${tips ? `<section><h2>Class tips</h2><div class="prose">${escapeHtml(tips).replace(/\n/g, '<br>')}</div></section>` : ''}
      ${vibes.length ? `<section><h2>Vibes</h2><p>${vibes.map((v) => `<span class="pill">${escapeHtml(v)}</span>`).join(' ')}</p></section>` : ''}
      ${tags.length ? `<section><h2>Class types</h2><div class="tags">${tags.map((t) => `<span>${escapeHtml(t)}</span>`).join('')}</div></section>` : ''}
    </article>
  </div>
</body>
</html>`;
}

/**
 * @param {string} slug - slug.current value
 * @param {string} projectId
 * @param {string} dataset
 * @returns {Promise<object|null>}
 */
export async function fetchStudioBySlug(slug, projectId, dataset) {
  const s = String(slug || '').trim();
  if (!s || !projectId || !dataset) return null;

  const groq = `*[_type == "studio" && slug.current == $slug][0]{
    _id, name, description, website, reviewHighlight, experienceLevel, vibeTags, classTips,
    placeId, rating, reviews, priceTier, featured, badge, tags,
    address,
    "slug": slug.current,
    "lat": location.lat,
    "lng": location.lng,
    "cardImageUrl": cardImage.asset->url
  }`;

  const base = `https://${projectId}.apicdn.sanity.io/v2024-01-01/data/query/${encodeURIComponent(dataset)}`;
  const u = new URL(base);
  u.searchParams.set('query', groq);
  u.searchParams.set('$slug', JSON.stringify(s));

  const r = await fetch(u.toString());
  if (!r.ok) return null;
  const j = await r.json();
  const doc = j.result;
  if (!doc || !doc.name) return null;
  return doc;
}

/**
 * @returns {Promise<string[]>}
 */
export async function fetchAllStudioSlugs(projectId, dataset) {
  if (!projectId || !dataset) return [];
  const groq = `*[_type == "studio" && defined(slug.current)]{"s": slug.current}`;
  const base = `https://${projectId}.apicdn.sanity.io/v2024-01-01/data/query/${encodeURIComponent(dataset)}`;
  const u = new URL(base);
  u.searchParams.set('query', groq);
  const r = await fetch(u.toString());
  if (!r.ok) return [];
  const j = await r.json();
  const rows = j.result || [];
  return rows.map((row) => row.s).filter(Boolean);
}

/**
 * @param {string} origin - e.g. https://example.com (no trailing slash)
 * @param {string[]} slugs
 */
export function buildSitemapXml(origin, slugs) {
  const base = String(origin || '').replace(/\/$/, '');
  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const entries = [
    { loc: `${base}/`, priority: '1.0', changefreq: 'weekly' },
    ...slugs.map((slug) => ({
      loc: `${base}/studios/${encodeURIComponent(slug)}`,
      priority: '0.7',
      changefreq: 'weekly'
    }))
  ];
  const body = entries
    .map(
      (e) => `  <url>
    <loc>${esc(e.loc)}</loc>
    <changefreq>${e.changefreq}</changefreq>
    <priority>${e.priority}</priority>
  </url>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>`;
}

export function buildStudioNotFoundHtml(canonicalHome) {
  const h = escapeHtml(canonicalHome || '/');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Studio not found | Studio Locater</title>
  <meta name="robots" content="noindex">
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@600&display=swap" rel="stylesheet">
  <style>
    body { font-family:'DM Sans',sans-serif; background:#FDF8F8; color:#3D2B3D; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; text-align:center; }
    a { color:#C97E84; font-weight:600; }
  </style>
</head>
<body>
  <div>
    <p style="margin-bottom:12px">We couldn’t find that studio.</p>
    <p><a href="${h}">Return to Studio Locater</a></p>
  </div>
</body>
</html>`;
}
