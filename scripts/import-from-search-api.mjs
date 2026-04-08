#!/usr/bin/env node
/**
 * Import Google search results (merged JSON from your Worker) into Sanity as `studio` documents.
 *
 * Why this exists: the live site reads Places + Sanity by default; it does not write from the
 * browser. For one-off bulk imports, use this script. For automatic writes on every API search,
 * enable SANITY_AUTO_IMPORT on the Cloudflare API Worker (see wrangler.api-search.toml).
 *
 * Setup:
 *   1. sanity.io/manage → your project → API → Tokens → create token with Editor (or Developer).
 *   2. Put in studio/.env or .env at repo root:
 *        SANITY_API_TOKEN=sk...
 *        SANITY_STUDIO_PROJECT_ID=xxxx   (or SANITY_PROJECT_ID)
 *        SANITY_STUDIO_DATASET=production
 *   3. npm install (adds @sanity/client)
 *
 * Usage:
 *   node scripts/import-from-search-api.mjs --lat=40.015 --lng=-105.270
 *   node scripts/import-from-search-api.mjs --lat=40.015 --lng=-105.270 --type=pilates
 *   SEARCH_API_BASE=https://your-worker.workers.dev node scripts/import-from-search-api.mjs ...
 *   DRY_RUN=1 node ...   # print documents only, no writes
 *
 * Env:
 *   SEARCH_API_BASE  — same as meta search-api-base on the site (Worker URL, no trailing slash)
 */

import { createHash } from 'node:crypto';
import { createClient } from '@sanity/client';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });
dotenv.config({ path: join(__dirname, '..', 'studio', '.env') });

function slugify(name) {
  return String(name || 'studio')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'studio';
}

/** Worker returns `address` as Google `vicinity` — map into required Sanity address fields. */
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

function stableId(placeId) {
  const h = createHash('sha256').update(placeId).digest('hex').slice(0, 32);
  return `import-${h}`;
}

function parseArgs() {
  const out = { lat: null, lng: null, type: '' };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--lat=')) out.lat = parseFloat(a.slice(6));
    else if (a.startsWith('--lng=')) out.lng = parseFloat(a.slice(6));
    else if (a.startsWith('--type=')) out.type = a.slice(7);
  }
  return out;
}

async function main() {
  const { lat, lng, type } = parseArgs();
  const projectId =
    process.env.SANITY_STUDIO_PROJECT_ID || process.env.SANITY_PROJECT_ID || '';
  const dataset = process.env.SANITY_STUDIO_DATASET || process.env.SANITY_DATASET || 'production';
  const token = process.env.SANITY_API_TOKEN || '';
  const base = (process.env.SEARCH_API_BASE || '').replace(/\/$/, '');

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    console.error('Usage: node scripts/import-from-search-api.mjs --lat=LAT --lng=LNG [--type=keyword]');
    process.exit(1);
  }
  if (!base) {
    console.error('Set SEARCH_API_BASE to your Worker URL (same as the public site meta tag).');
    process.exit(1);
  }
  if (!projectId || !token) {
    console.error('Set SANITY_STUDIO_PROJECT_ID and SANITY_API_TOKEN (Editor token from sanity.io/manage).');
    process.exit(1);
  }

  const u = new URL(`${base}/api/search`);
  u.searchParams.set('lat', String(lat));
  u.searchParams.set('lng', String(lng));
  if (type) u.searchParams.set('type', type);

  const res = await fetch(u);
  if (!res.ok) {
    console.error('Search API error:', res.status, await res.text());
    process.exit(1);
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) {
    console.log('No results from API.');
    return;
  }

  const dry = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const client = createClient({ projectId, dataset, token, apiVersion: '2024-01-01', useCdn: false });

  let n = 0;
  for (const row of rows) {
    const placeId = row.placeId;
    if (!placeId || row.lat == null || row.lng == null) continue;

    const name = row.name || 'Studio';
    const tags =
      Array.isArray(row.tags) && row.tags.length ? row.tags : ['Yoga'];
    const doc = {
      _id: stableId(placeId),
      _type: 'studio',
      name,
      slug: { _type: 'slug', current: slugify(name) },
      address: vicinityToAddress(row.address),
      location: { _type: 'geopoint', lat: row.lat, lng: row.lng },
      placeId,
      tags,
      rating: typeof row.rating === 'number' ? row.rating : 4.5,
      reviews: typeof row.reviews === 'number' ? row.reviews : 0,
      priceTier: 2,
      featured: !!row.featured,
      description: row.description || undefined
    };

    if (dry) {
      console.log(JSON.stringify(doc, null, 2));
      n++;
      continue;
    }

    await client.createOrReplace(doc);
    n++;
  }

  console.log(dry ? `DRY_RUN: would import ${n} studios` : `Imported ${n} studios into ${dataset}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
