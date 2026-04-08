/**
 * Cloudflare Worker: studio detail pages + sitemap (SEO), then static assets from `public/`.
 */
import {
  fetchStudioBySlug,
  fetchStudioByDocumentId,
  buildStudioDetailHtml,
  buildStudioNotFoundHtml,
  fetchAllStudioSlugs,
  buildSitemapXml
} from './studio-detail-page.mjs';

function canonicalPathname(url) {
  let p = url.pathname.replace(/\/$/, '');
  if (!p) p = '/';
  return p;
}

function studioHtmlResponse(html) {
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300'
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = canonicalPathname(url);

    if (path === '/sitemap.xml') {
      const projectId = env.SANITY_PROJECT_ID || 't0z5ndwm';
      const dataset = env.SANITY_DATASET || 'production';
      try {
        const slugs = await fetchAllStudioSlugs(projectId, dataset);
        const xml = buildSitemapXml(url.origin, slugs);
        return new Response(xml, {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=600'
          }
        });
      } catch {
        return new Response('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>', {
          headers: { 'Content-Type': 'application/xml; charset=utf-8' }
        });
      }
    }

    const projectId = env.SANITY_PROJECT_ID || 't0z5ndwm';
    const dataset = env.SANITY_DATASET || 'production';
    const canonicalUrl = `${url.origin}${canonicalPathname(url)}`;

    const idMatch = url.pathname.match(/^\/studios\/id\/([^/]+)\/?$/);
    if (idMatch) {
      const docId = decodeURIComponent(idMatch[1]);
      try {
        const doc = await fetchStudioByDocumentId(docId, projectId, dataset);
        if (!doc) {
          return new Response(buildStudioNotFoundHtml(`${url.origin}/`), {
            status: 404,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=120'
            }
          });
        }
        return studioHtmlResponse(
          buildStudioDetailHtml(doc, { canonicalUrl, robotsNoIndex: true })
        );
      } catch {
        return new Response('Server error', {
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    }

    const m = url.pathname.match(/^\/studios\/([^/]+)\/?$/);
    if (m) {
      const slug = decodeURIComponent(m[1]);
      if (slug === 'id') {
        return new Response(buildStudioNotFoundHtml(`${url.origin}/`), {
          status: 404,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=120'
          }
        });
      }
      try {
        const doc = await fetchStudioBySlug(slug, projectId, dataset);
        if (!doc) {
          return new Response(buildStudioNotFoundHtml(`${url.origin}/`), {
            status: 404,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=120'
            }
          });
        }
        return studioHtmlResponse(buildStudioDetailHtml(doc, { canonicalUrl }));
      } catch {
        return new Response('Server error', {
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
