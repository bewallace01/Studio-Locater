#!/usr/bin/env node
/**
 * Set missing studio slugs from document name (with collision handling).
 *
 *   SANITY_STUDIO_PROJECT_ID / SANITY_PROJECT_ID
 *   SANITY_STUDIO_DATASET / SANITY_DATASET (default production)
 *   SANITY_API_TOKEN (Editor)
 *
 *   node scripts/backfill-studio-slugs.mjs
 *   node scripts/backfill-studio-slugs.mjs --dry-run
 */
import {createClient} from '@sanity/client';
import dotenv from 'dotenv';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {slugifyStudio} from '../studio/lib/slugifyStudio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({path: join(__dirname, '..', '.env')});
dotenv.config({path: join(__dirname, '..', 'studio', '.env')});

const dry = process.argv.includes('--dry-run');

const projectId =
  process.env.SANITY_STUDIO_PROJECT_ID || process.env.SANITY_PROJECT_ID || '';
const dataset = process.env.SANITY_STUDIO_DATASET || process.env.SANITY_DATASET || 'production';
const token = process.env.SANITY_API_TOKEN || '';

if (!projectId || !token) {
  console.error('Set SANITY_STUDIO_PROJECT_ID and SANITY_API_TOKEN (Editor) in studio/.env or .env');
  process.exit(1);
}

const client = createClient({
  projectId,
  dataset,
  apiVersion: '2024-01-01',
  token,
  useCdn: false
});

async function uniqueSlug(base, excludeId) {
  let s = base;
  let n = 0;
  while (n < 200) {
    const hit = await client.fetch(
      `count(*[_type == "studio" && slug.current == $slug && _id != $id])`,
      {slug: s, id: excludeId}
    );
    if (!hit) return s;
    n += 1;
    s = `${base}-${n + 1}`;
    if (s.length > 96) s = s.slice(0, 96);
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 96);
}

async function main() {
  const rows = await client.fetch(
    `*[_type == "studio" && (!defined(slug.current) || slug.current == "") && defined(name) && name != ""]{_id, name}`
  );
  if (!rows.length) {
    console.log('No studios need a slug.');
    return;
  }
  console.log(`${dry ? '[dry-run] ' : ''}Processing ${rows.length} studio(s)...`);

  for (const row of rows) {
    const base = slugifyStudio(row.name);
    if (!base) {
      console.warn(`Skip ${row._id}: could not slugify name`);
      continue;
    }
    const finalSlug = await uniqueSlug(base, row._id);
    console.log(`  ${row._id}  "${row.name}"  →  ${finalSlug}`);
    if (!dry) {
      await client
        .patch(row._id)
        .set({slug: {_type: 'slug', current: finalSlug}})
        .commit();
    }
  }
  console.log(dry ? 'Dry run complete.' : 'Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
