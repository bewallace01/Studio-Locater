/**
 * Cloudflare Worker: serve static assets from the `public` directory only.
 * `node_modules` is never uploaded. Yelp API must use a Worker route or
 * separate backend; the browser falls back to Nominatim when /api is unavailable.
 */
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
