/**
 * URL segment for /studios/:slug — shared by Studio UI and backfill scripts.
 * @param {string} input
 * @returns {string}
 */
export function slugifyStudio(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
}
