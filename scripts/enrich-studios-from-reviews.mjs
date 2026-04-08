#!/usr/bin/env node
/**
 * Batch-enrich Sanity `studio` documents using Google Place Details (review snippets)
 * + OpenAI to propose experience level, vibe tags, class tips, and a review highlight.
 *
 * You still own the content: review output in Sanity, edit or publish as needed.
 *
 * Prerequisites:
 *   - GOOGLE_API_KEY with Places API enabled (same key as your Worker).
 *   - OPENAI_API_KEY (https://platform.openai.com/api-keys) — charges apply.
 *   - SANITY_API_TOKEN (Editor) + SANITY_STUDIO_PROJECT_ID + SANITY_STUDIO_DATASET
 *     in studio/.env or .env (same as import script).
 *
 * Usage:
 *   node scripts/enrich-studios-from-reviews.mjs
 *   node scripts/enrich-studios-from-reviews.mjs --limit=5
 *   node scripts/enrich-studios-from-reviews.mjs --force
 *   DRY_RUN=1 node scripts/enrich-studios-from-reviews.mjs --limit=2
 *
 * Flags:
 *   --limit=N     Max studios to process (default 25)
 *   --force       Re-enrich even if experienceLevel / vibes already set
 *   --sleep=MS    Delay between studios (default 400)
 */

import { createClient } from '@sanity/client';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });
dotenv.config({ path: join(__dirname, '..', 'studio', '.env') });

function parseArgs() {
  const out = { limit: 25, force: false, sleep: 400 };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--limit=')) out.limit = Math.max(1, parseInt(a.slice(8), 10) || 25);
    else if (a === '--force') out.force = true;
    else if (a.startsWith('--sleep=')) out.sleep = Math.max(0, parseInt(a.slice(8), 10) || 400);
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPlaceDetails(placeId, apiKey) {
  const fields = [
    'name',
    'formatted_address',
    'rating',
    'user_ratings_total',
    'reviews',
    'editorial_summary'
  ].join(',');
  const u = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(
    placeId
  )}&fields=${fields}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(u);
  if (!res.ok) throw new Error(`Place Details HTTP ${res.status}`);
  const data = await res.json();
  if (data.status && data.status !== 'OK') {
    throw new Error(data.error_message || `Places status: ${data.status}`);
  }
  return data.result || {};
}

async function openaiEnrich({ name, addressLine, reviewsText, editorialSummary, openaiKey }) {
  const sys = `You help curate a boutique fitness directory. Output ONLY valid JSON, no markdown.`;
  const user = `Business name: ${name}
Address: ${addressLine}
${editorialSummary ? `Google editorial summary: ${editorialSummary}\n` : ''}
Customer review excerpts (may be truncated):
${reviewsText || '(no reviews returned by Google for this place)'}

Return JSON with exactly these keys:
- "experienceLevel": one of "" | "beginner" | "all_levels" | "mixed" | "intermediate" | "advanced"
  Use "" only if there is truly not enough signal.
- "vibeTags": array of 2–6 short tags for atmosphere (e.g. "warm staff", "small classes"). Lowercase phrases, no hashtags.
- "classTips": 2–4 sentences of practical first-visit advice (parking, arrival time, what to bring, culture). If unknown, suggest calling ahead.
- "reviewHighlight": one short line capturing reviewer sentiment, max 120 characters, no quote marks inside.

Be conservative: do not invent specific prices, schedules, or amenities not implied by the text.`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openaiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.35,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user }
      ]
    })
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${raw.slice(0, 400)}`);
  const j = JSON.parse(raw);
  const txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!txt) throw new Error('OpenAI empty response');
  return JSON.parse(txt);
}

function formatAddress(addr) {
  if (!addr || typeof addr !== 'object') return '';
  const parts = [addr.streetLine1, addr.streetLine2, addr.city, addr.region, addr.postalCode].filter(Boolean);
  return parts.join(', ');
}

function reviewsFromDetails(result) {
  const revs = Array.isArray(result.reviews) ? result.reviews : [];
  return revs
    .slice(0, 8)
    .map((r) => (r.text ? String(r.text).trim() : ''))
    .filter(Boolean)
    .join('\n---\n');
}

async function main() {
  const { limit, force, sleep: sleepMs } = parseArgs();
  const dry = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

  const projectId = process.env.SANITY_STUDIO_PROJECT_ID || process.env.SANITY_PROJECT_ID || '';
  const dataset = process.env.SANITY_STUDIO_DATASET || process.env.SANITY_DATASET || 'production';
  const token = process.env.SANITY_API_TOKEN || '';
  const googleKey = process.env.GOOGLE_API_KEY || '';
  const openaiKey = process.env.OPENAI_API_KEY || '';

  if (!projectId || !token) {
    console.error('Set SANITY_STUDIO_PROJECT_ID and SANITY_API_TOKEN.');
    process.exit(1);
  }
  if (!googleKey) {
    console.error('Set GOOGLE_API_KEY (Places API).');
    process.exit(1);
  }
  if (!openaiKey) {
    console.error('Set OPENAI_API_KEY.');
    process.exit(1);
  }

  const client = createClient({
    projectId,
    dataset,
    token,
    apiVersion: '2024-01-01',
    useCdn: false
  });

  const filter = force
    ? `*[_type == "studio" && defined(placeId) && placeId != ""] | order(_updatedAt desc) [0...${limit}] { _id, name, placeId, address, experienceLevel, vibeTags }`
    : `*[_type == "studio" && defined(placeId) && placeId != "" && (
          !defined(experienceLevel) || experienceLevel == "" ||
          !defined(vibeTags) || count(vibeTags) == 0
        )] | order(_updatedAt desc) [0...${limit}] { _id, name, placeId, address, experienceLevel, vibeTags }`;

  const rows = await client.fetch(filter);
  if (!Array.isArray(rows) || !rows.length) {
    console.log('No matching studios. Use --force to re-process, or add placeIds in Sanity.');
    return;
  }

  console.log(`Processing ${rows.length} studio(s)${dry ? ' (DRY_RUN)' : ''}…`);

  let ok = 0;
  for (let i = 0; i < rows.length; i++) {
    const doc = rows[i];
    const placeId = doc.placeId;
    const addrLine = formatAddress(doc.address);
    process.stdout.write(`[${i + 1}/${rows.length}] ${doc.name || doc._id}… `);
    try {
      const details = await fetchPlaceDetails(placeId, googleKey);
      const name = details.name || doc.name || 'Studio';
      const reviewsText = reviewsFromDetails(details);
      const editorialSummary =
        details.editorial_summary && details.editorial_summary.overview
          ? String(details.editorial_summary.overview)
          : '';

      const enriched = await openaiEnrich({
        name,
        addressLine: details.formatted_address || addrLine,
        reviewsText,
        editorialSummary,
        openaiKey
      });

      const patch = {
        experienceLevel: enriched.experienceLevel != null ? String(enriched.experienceLevel).trim() : '',
        vibeTags: Array.isArray(enriched.vibeTags)
          ? [...new Set(enriched.vibeTags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 8)
          : [],
        classTips: enriched.classTips != null ? String(enriched.classTips).trim() : '',
        reviewHighlight:
          enriched.reviewHighlight != null ? String(enriched.reviewHighlight).trim().slice(0, 160) : ''
      };

      if (dry) {
        console.log('dry-run patch:', JSON.stringify(patch, null, 2));
      } else {
        await client.patch(doc._id).set(patch).commit();
        console.log('saved.');
      }
      ok++;
    } catch (e) {
      console.log('SKIP:', e.message || e);
    }
    if (i < rows.length - 1) await sleep(sleepMs);
  }

  console.log(`Done. ${ok} enriched${dry ? ' (dry-run, no writes)' : ''}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
