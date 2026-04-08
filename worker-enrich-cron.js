/**
 * Scheduled AI enrichment for Sanity studios (Google Place Details + OpenAI → Sanity).
 * Deploy: npx wrangler deploy -c wrangler.enrich.toml
 *
 * Processes a small batch per run (default 5) so the Worker stays within limits.
 * Run weekly cron + optional manual GET /run?secret=YOUR_CRON_SECRET
 *
 * Secrets (wrangler secret put -c wrangler.enrich.toml):
 *   SANITY_PROJECT_ID, SANITY_DATASET, SANITY_API_TOKEN, GOOGLE_API_KEY, OPENAI_API_KEY
 * Optional: CRON_SECRET (if set, required on /run)
 *
 * Vars: ENRICH_BATCH_SIZE (default 5), ENRICH_FORCE ("true" = ignore missing-fields filter)
 */

async function sanityQuery(projectId, dataset, query, token) {
  const u = new URL(`https://${projectId}.api.sanity.io/v2024-01-01/data/query/${dataset}`);
  u.searchParams.set('query', query);
  const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sanity query ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.result) ? data.result : [];
}

async function sanityPatch(projectId, dataset, token, docId, patch) {
  const url = `https://${projectId}.api.sanity.io/v2024-01-01/data/mutate/${encodeURIComponent(dataset)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      mutations: [{ patch: { id: docId, set: patch } }]
    })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Sanity patch ${res.status}: ${text.slice(0, 300)}`);
}

function formatAddress(addr) {
  if (!addr || typeof addr !== 'object') return '';
  const parts = [addr.streetLine1, addr.streetLine2, addr.city, addr.region, addr.postalCode].filter(Boolean);
  return parts.join(', ');
}

async function fetchPlaceDetails(placeId, apiKey) {
  const fields = ['name', 'formatted_address', 'rating', 'user_ratings_total', 'reviews', 'editorial_summary'].join(
    ','
  );
  const u = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(
    placeId
  )}&fields=${fields}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(u);
  if (!res.ok) throw new Error(`Place Details HTTP ${res.status}`);
  const data = await res.json();
  if (data.status && data.status !== 'OK') {
    throw new Error(data.error_message || `Places ${data.status}`);
  }
  return data.result || {};
}

function reviewsFromDetails(result) {
  const revs = Array.isArray(result.reviews) ? result.reviews : [];
  return revs
    .slice(0, 8)
    .map((r) => (r.text ? String(r.text).trim() : ''))
    .filter(Boolean)
    .join('\n---\n');
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
- "vibeTags": array of 2–6 short tags for atmosphere. Lowercase phrases.
- "classTips": 2–4 sentences of practical first-visit advice.
- "reviewHighlight": one short line, max 120 characters, no quote marks inside.

Be conservative: do not invent specific prices or schedules not implied by the text.`;

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

async function runEnrichment(env) {
  const projectId = String(env.SANITY_PROJECT_ID || '').trim();
  const dataset = String(env.SANITY_DATASET || 'production').trim();
  const token = String(env.SANITY_API_TOKEN || '').trim();
  const googleKey = String(env.GOOGLE_API_KEY || '').trim();
  const openaiKey = String(env.OPENAI_API_KEY || '').trim();
  const batch = Math.min(
    20,
    Math.max(1, parseInt(String(env.ENRICH_BATCH_SIZE || '5'), 10) || 5)
  );
  const force = String(env.ENRICH_FORCE || '').toLowerCase() === 'true';

  if (!projectId || !dataset || !token || !googleKey || !openaiKey) {
    return { ok: false, error: 'Missing env: SANITY_PROJECT_ID, SANITY_DATASET, SANITY_API_TOKEN, GOOGLE_API_KEY, OPENAI_API_KEY' };
  }

  const filter = force
    ? `*[_type == "studio" && defined(placeId) && placeId != ""] | order(_updatedAt desc) [0...${batch}] { _id, name, placeId, address }`
    : `*[_type == "studio" && defined(placeId) && placeId != "" && (
          !defined(experienceLevel) || experienceLevel == "" ||
          !defined(vibeTags) || count(vibeTags) == 0
        )] | order(_updatedAt desc) [0...${batch}] { _id, name, placeId, address }`;

  const rows = await sanityQuery(projectId, dataset, filter, token);
  if (!rows.length) {
    return { ok: true, processed: 0, message: 'No matching studios' };
  }

  let processed = 0;
  const errors = [];
  /** @type {{ _id: string, name: string }[]} */
  const enriched = [];

  for (const doc of rows) {
    try {
      const details = await fetchPlaceDetails(doc.placeId, googleKey);
      const name = details.name || doc.name || 'Studio';
      const reviewsText = reviewsFromDetails(details);
      const editorialSummary =
        details.editorial_summary && details.editorial_summary.overview
          ? String(details.editorial_summary.overview)
          : '';
      const addrLine = formatAddress(doc.address);
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

      await sanityPatch(projectId, dataset, token, doc._id, patch);
      processed++;
      enriched.push({ _id: doc._id, name: name || doc.name || 'Studio' });
    } catch (e) {
      errors.push(`${doc._id}: ${e.message || e}`);
    }
  }

  return { ok: true, processed, enriched, errors, batch: rows.length };
}

export default {
  async scheduled(event, env, ctx) {
    const out = await runEnrichment(env);
    console.log(JSON.stringify(out));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/run' && url.pathname !== '/') {
      return new Response('Not Found', { status: 404 });
    }

    if (url.pathname === '/') {
      return new Response(
        JSON.stringify({
          service: 'studio-locater-enrich',
          hint: 'GET /run to trigger batch (requires CRON_SECRET if configured)'
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    const secret = String(env.CRON_SECRET || '').trim();
    if (secret) {
      const q = url.searchParams.get('secret');
      const h = request.headers.get('Authorization');
      const bearer = h && h.startsWith('Bearer ') ? h.slice(7) : '';
      if (q !== secret && bearer !== secret) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    try {
      const out = await runEnrichment(env);
      return new Response(JSON.stringify(out, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e.message || e) }), { status: 500 });
    }
  }
};
