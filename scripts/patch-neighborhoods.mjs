#!/usr/bin/env node
/**
 * One-time script: patch neighborhood (and optionally tags) on studio documents.
 * Run: node scripts/patch-neighborhoods.mjs
 */
import {createClient} from '@sanity/client';

const client = createClient({
  projectId: 't0z5ndwm',
  dataset: 'production',
  token: 'skCFnOlwl1D1YoIasjrbMWsogKXEmqUv86fnJsZdMqG3XKhVVVE2B4lYrXxO9mNZgzA3PHnJg3lauJP0WFHElwirWSMX3Yv4tHF35Tb3h5c1TDD5g5bQQdn0O5UmAeULdQhc3CFQmxbZ9Jusy3uugnaPKFDlyVKBxn3s3T2aKcOoNIqkYVHd',
  apiVersion: '2024-01-01',
  useCdn: false,
});

const patches = [
  // Brooklyn
  {id: 'import-ea3b17e8d69ec252b310c9a4c50db16f', neighborhood: 'Williamsburg'},
  {id: 'import-1a3822f88d3c38124d6ab495af5ce699', neighborhood: 'Williamsburg', tags: ['Yoga', 'Solidcore']},
  {id: 'import-a803daabcafd8a7e1976208bb00f0bdd', neighborhood: 'DUMBO'},
  {id: 'import-cfe1a5ab52c5e76c75dbc0d48907a321', neighborhood: 'Greenpoint'},
  // Chicago
  {id: 'import-3036efe234f0d8ebb5a8d040afa31eb0', neighborhood: 'West Loop',    tags: ['Yoga', 'Solidcore']},
  {id: 'import-78e54a246e505f2df797127db7c36b3d', neighborhood: 'River North',   tags: ['Yoga', 'Solidcore']},
  {id: 'import-0aa1e1e8a1053c51cb3ea6987d0116ec', neighborhood: 'Lincoln Park',  tags: ['Pilates']},
  {id: 'import-59e9d838b51360c04ab9705f05c7187a', neighborhood: 'Streeterville', tags: ['Yoga', 'Solidcore']},
];

for (const {id, neighborhood, tags} of patches) {
  const patch = client.patch(id).set({neighborhood});
  if (tags) patch.set({tags});
  try {
    const doc = await patch.commit();
    console.log(`✔ ${doc._id}  neighborhood="${neighborhood}"${tags ? `  tags=${JSON.stringify(tags)}` : ''}`);
  } catch (err) {
    console.error(`✘ ${id}:`, err.message);
  }
}

console.log('\nPublishing all patched drafts...');
const ids = patches.map(p => p.id);
for (const id of ids) {
  try {
    await client.request({
      method: 'POST',
      uri: `/v2021-06-07/projects/t0z5ndwm/datasets/production/actions`,
      body: {
        actions: [{
          actionType: 'sanity.action.document.publish',
          draftId: `drafts.${id}`,
          publishedId: id,
        }],
      },
    });
    console.log(`  published ${id}`);
  } catch (err) {
    // might already be published / no draft — that's fine
    console.log(`  (skip publish ${id}: ${err.message})`);
  }
}
console.log('Done.');
