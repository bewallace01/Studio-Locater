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

/** Google Maps deep link — no API key required. */
export function googleMapsUrlForStudio(studio) {
  const pid = studio && studio.placeId && String(studio.placeId).trim();
  if (pid) {
    return `https://www.google.com/maps/search/?api=1&query_place_id=${encodeURIComponent(pid)}`;
  }
  const line = studio && formatSanityAddress(studio.address);
  if (line && String(line).trim()) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(line).trim())}`;
  }
  return '';
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

/** Studio page: show Mindbody block only when CMS has a real Site ID (not empty / 0). */
export function studioHasMindbody(studio) {
  const raw = studio && studio.mindbodySiteId;
  if (raw === null || raw === undefined || raw === '') return false;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n === 0) return false;
  return Boolean(String(studio.slug || '').trim());
}

function mindbodyScheduleSectionHtml(studio) {
  if (!studioHasMindbody(studio)) return '';
  const slugEsc = escapeHtml(String(studio.slug || '').trim());
  return `
      <section class="mindbody-section" id="mindbody-live" data-slug="${slugEsc}" data-mindbody="1" hidden>
        <h2>Schedule &amp; pricing</h2>
        <p class="mindbody-lead">Loading schedule and pricing…</p>
        <div class="mindbody-loading" aria-hidden="true"></div>
        <div class="mindbody-body"></div>
        <p class="mindbody-err" hidden role="alert"></p>
      </section>
      <script>
(function(){
  var root = document.getElementById('mindbody-live');
  if (!root) return;
  var slug = root.getAttribute('data-slug');
  function esc(t){ var d=document.createElement('div'); d.textContent = t==null ? '' : String(t); return d.innerHTML; }
  function hideBlock(){ try { root.remove(); } catch(e) { root.style.display = 'none'; } }
  function showBlock(){
    root.hidden = false;
    var lead = root.querySelector('.mindbody-lead');
    if (lead) lead.textContent = 'Live schedule and pricing from Mindbody.';
  }
  fetch('/api/mindbody/studio?slug=' + encodeURIComponent(slug))
    .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, status: r.status, j: j }; }); })
    .then(function(x){
      var loadEl = root.querySelector('.mindbody-loading');
      var body = root.querySelector('.mindbody-body');
      var err = root.querySelector('.mindbody-err');
      if (loadEl) loadEl.style.display = 'none';
      var j = x.j || {};
      if (j.error === 'mindbody_not_configured' || j.error === 'studio_not_found') {
        hideBlock();
        return;
      }
      if (!x.ok || (j.error && !j.classSchedules && !j.services)) {
        showBlock();
        if (err) {
          err.hidden = false;
          err.textContent = j.error ? String(j.error) : 'Could not load Mindbody data.';
        }
        return;
      }
      if (!body) return;
      showBlock();
      var cs = j.classSchedules && j.classSchedules.ClassSchedules;
      var sv = j.services && (j.services.Services || j.services.services);
      var pe = j.partialErrors || {};
      var html = '';
      html += '<h3>Class schedule</h3>';
      if (pe.classSchedules) html += '<p class="mindbody-muted">' + esc('Schedule: ' + pe.classSchedules) + '</p>';
      if (cs && cs.length) {
        html += '<ul class="mindbody-list">';
        for (var i = 0; i < Math.min(cs.length, 50); i++) {
          var row = cs[i];
          var name = row && row.ClassDescription && row.ClassDescription.Name ? row.ClassDescription.Name : 'Class';
          var freq = row.FrequencyType || '';
          var loc = row.Location && row.Location.Name ? row.Location.Name : '';
          html += '<li><strong>' + esc(name) + '</strong>' + (freq ? ' · ' + esc(freq) : '') + (loc ? ' · ' + esc(loc) : '') + '</li>';
        }
        html += '</ul>';
      } else if (!pe.classSchedules) html += '<p class="mindbody-muted">No schedule rows in this date range.</p>';
      html += '<h3>Pricing &amp; passes</h3>';
      if (pe.services) html += '<p class="mindbody-muted">' + esc('Pricing: ' + pe.services) + '</p>';
      if (sv && sv.length) {
        html += '<ul class="mindbody-list mindbody-pricing">';
        for (var k = 0; k < Math.min(sv.length, 50); k++) {
          var s = sv[k];
          var pn = s.Name || 'Option';
          var pr = '';
          if (s.Price != null && s.Price !== '') pr = '$' + Number(s.Price).toFixed(2);
          else if (s.OnlinePrice != null && s.OnlinePrice !== '') pr = '$' + Number(s.OnlinePrice).toFixed(2);
          html += '<li><span class="mb-name">' + esc(pn) + '</span>' + (pr ? ' <span class="mb-price">' + esc(pr) + '</span>' : '') + '</li>';
        }
        html += '</ul>';
      } else if (!pe.services) html += '<p class="mindbody-muted">No pricing options returned.</p>';
      body.innerHTML = html;
    })
    .catch(function(){
      var loadEl = root.querySelector('.mindbody-loading');
      var err = root.querySelector('.mindbody-err');
      if (loadEl) loadEl.style.display = 'none';
      showBlock();
      if (err) { err.hidden = false; err.textContent = 'Network error loading Mindbody.'; }
    });
})();
      </script>`;
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

function studioForJsonLd(studio) {
  return { ...studio };
}

function jsonLdLocalBusiness(studio, canonicalUrl) {
  const s = studioForJsonLd(studio);
  const name = s.name || 'Studio';
  const addr = s.address;
  const street = addr && typeof addr === 'object' ? [addr.streetLine1, addr.streetLine2].filter(Boolean).join(', ') : '';
  const locality = addr && addr.city ? String(addr.city) : '';
  const region = addr && addr.region ? String(addr.region) : '';
  const postal = addr && addr.postalCode ? String(addr.postalCode) : '';
  const country = addr && addr.country ? String(addr.country) : 'US';
  const lat = s.lat != null && Number.isFinite(+s.lat) ? +s.lat : null;
  const lng = s.lng != null && Number.isFinite(+s.lng) ? +s.lng : null;
  const img = s.cardImageUrl && String(s.cardImageUrl).trim() ? String(s.cardImageUrl).trim() : null;
  const sameAs = [];
  if (s.website && String(s.website).trim()) sameAs.push(normalizeExternalUrl(s.website));
  const maps = googleMapsUrlForStudio(s);
  if (maps) sameAs.push(maps);

  const obj = {
    '@context': 'https://schema.org',
    '@type': 'SportsActivityLocation',
    name,
    description: metaDescription(s) || undefined,
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
      typeof s.rating === 'number' &&
      Number.isFinite(s.rating) &&
      typeof s.reviews === 'number' &&
      s.reviews > 0
        ? {
            '@type': 'AggregateRating',
            ratingValue: s.rating,
            reviewCount: s.reviews,
            bestRating: 5,
            worstRating: 1
          }
        : undefined,
    sameAs: sameAs.length ? sameAs : undefined
  };

  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

function buildReviewsSectionHtml(studioSlug, reviews, studioDisplayName) {
  const slug = escapeHtml(String(studioSlug || ''));
  const nameForReview = escapeHtml(String(studioDisplayName || studioSlug || ''));
  const reviewCards = reviews.map(r => {
    const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
    const dateStr = r.created_at ? new Date(r.created_at * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    return `<div class="review-card">
      <div class="review-header">
        <span class="review-stars">${stars}</span>
        ${dateStr ? `<span class="review-date">${dateStr}</span>` : ''}
      </div>
      ${r.comment ? `<p class="review-comment">${escapeHtml(String(r.comment))}</p>` : ''}
    </div>`;
  }).join('');

  return `<section class="reviews-section" id="reviews-section">
    <h2>Community Reviews</h2>
    <div id="reviews-list">
      ${reviews.length > 0 ? reviewCards : '<p class="no-reviews">No reviews yet — be the first!</p>'}
    </div>
    <div id="review-form-wrap"></div>
  </section>
  <script>
  (function(){
    var slug = ${JSON.stringify(slug)};
    var studioName = ${JSON.stringify(nameForReview)};
    var formWrap = document.getElementById('review-form-wrap');
    var reviewsList = document.getElementById('reviews-list');
    var selectedRating = 0;

    function esc(t){ var d=document.createElement('div'); d.textContent=String(t||''); return d.innerHTML; }

    function renderReviewCard(r) {
      var stars = '★'.repeat(r.rating) + '☆'.repeat(5-r.rating);
      var d = r.created_at ? new Date(r.created_at*1000).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}) : '';
      return '<div class="review-card"><div class="review-header"><span class="review-stars">'+stars+'</span>'+(d?'<span class="review-date">'+d+'</span>':'')+'</div>'+(r.comment?'<p class="review-comment">'+esc(r.comment)+'</p>':'')+'</div>';
    }

    function showForm(email) {
      formWrap.innerHTML = '<h3>Leave a Review</h3>'
        +'<div class="star-picker" id="star-picker">'
        +'<button type="button" data-v="1" aria-label="1 star">★</button>'
        +'<button type="button" data-v="2" aria-label="2 stars">★</button>'
        +'<button type="button" data-v="3" aria-label="3 stars">★</button>'
        +'<button type="button" data-v="4" aria-label="4 stars">★</button>'
        +'<button type="button" data-v="5" aria-label="5 stars">★</button>'
        +'</div>'
        +'<textarea id="review-comment" placeholder="Share your experience (optional)" maxlength="800"></textarea>'
        +'<div><button class="review-submit-btn" id="review-submit"><i class="fa-solid fa-star"></i> Submit Review</button></div>'
        +'<p id="review-msg" style="font-size:13px;margin-top:8px;color:var(--plum-mid)"></p>';

      document.getElementById('star-picker').addEventListener('click', function(e){
        var btn = e.target.closest('button[data-v]');
        if (!btn) return;
        selectedRating = Number(btn.getAttribute('data-v'));
        document.querySelectorAll('#star-picker button').forEach(function(b,i){
          b.classList.toggle('active', i < selectedRating);
        });
      });

      document.getElementById('review-submit').addEventListener('click', function(){
        var comment = document.getElementById('review-comment').value.trim();
        var msg = document.getElementById('review-msg');
        if (!selectedRating) { msg.textContent = 'Please select a star rating.'; return; }
        this.disabled = true;
        fetch('/api/reviews/'+encodeURIComponent(slug), {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({rating:selectedRating, comment:comment, studioName:studioName})
        }).then(function(r){ return r.json(); }).then(function(d){
          if (d.ok) {
            formWrap.innerHTML = '<p style="font-size:14px;color:var(--plum-mid);margin-top:8px">Thanks for your review!</p>';
            fetch('/api/reviews/'+encodeURIComponent(slug)).then(function(r){return r.json();}).then(function(d){
              if (d.reviews && d.reviews.length) reviewsList.innerHTML = d.reviews.map(renderReviewCard).join('');
            }).catch(function(){});
          } else {
            msg.textContent = d.error || 'Something went wrong.';
            document.getElementById('review-submit').disabled = false;
          }
        }).catch(function(){
          msg.textContent = 'Network error. Try again.';
          document.getElementById('review-submit').disabled = false;
        });
      });
    }

    fetch('/api/me').then(function(r){return r.json();}).then(function(me){
      if (me && me.email) {
        showForm(me.email);
      } else {
        showSignInForm();
      }
    }).catch(function(){ showSignInForm(); });

    function showSignInForm() {
      formWrap.innerHTML = '<p class="review-login-prompt" style="margin-bottom:14px">Sign in to leave a review.</p>'
        +'<div class="review-signin-form" id="review-signin-form">'
        +'<input type="email" id="review-email-input" placeholder="Your email address" autocomplete="email" style="width:100%;border:1.5px solid var(--border);border-radius:10px;padding:10px 12px;font-size:14px;font-family:inherit;color:var(--plum);outline:none;box-sizing:border-box;">'
        +'<button class="review-submit-btn" id="review-email-submit" style="margin-top:10px;"><i class="fa-solid fa-envelope"></i> Send sign-in link</button>'
        +'<p id="review-email-msg" style="font-size:13px;margin-top:8px;color:var(--plum-mid)"></p>'
        +'</div>';

      var emailInput = document.getElementById('review-email-input');
      var emailBtn = document.getElementById('review-email-submit');
      var emailMsg = document.getElementById('review-email-msg');

      emailInput.addEventListener('focus', function(){ this.style.borderColor='var(--rose-deep)'; });
      emailInput.addEventListener('blur',  function(){ this.style.borderColor='var(--border)'; });

      emailBtn.addEventListener('click', function(){
        var email = emailInput.value.trim();
        if (!email || !email.includes('@')) { emailMsg.textContent = 'Please enter a valid email.'; emailMsg.style.color='var(--rose-deep)'; return; }
        emailBtn.disabled = true;
        emailMsg.style.color = 'var(--plum-mid)';
        emailMsg.textContent = 'Sending…';
        fetch('/api/auth/magic-link', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ email: email, return_to: window.location.pathname })
        }).then(function(r){ return r.json(); }).then(function(d){
          if (d.ok || d.sent) {
            formWrap.innerHTML = '<p style="font-size:14px;color:var(--plum-mid)"><i class="fa-solid fa-envelope-circle-check" style="color:var(--rose-deep);margin-right:6px"></i>Check your inbox — we sent a sign-in link to <strong>'+email+'</strong>. Click it and come back to leave your review.</p>';
          } else {
            emailMsg.textContent = d.error === 'email_not_configured' ? 'Email sign-in is not available right now.' : (d.error || 'Something went wrong.');
            emailMsg.style.color = 'var(--rose-deep)';
            emailBtn.disabled = false;
          }
        }).catch(function(){
          emailMsg.textContent = 'Network error. Please try again.';
          emailMsg.style.color = 'var(--rose-deep)';
          emailBtn.disabled = false;
        });
      });

      emailInput.addEventListener('keydown', function(e){ if (e.key === 'Enter') emailBtn.click(); });
    }
  })();
  </script>`;
}

/**
 * @param {object} studio - document from fetchStudioBySlug (plain fields + address object)
 * @param {{ canonicalUrl: string, robotsNoIndex?: boolean, googleAugmented?: boolean, reviews?: Array }} opts
 */
export function buildStudioDetailHtml(studio, opts) {
  const { canonicalUrl, robotsNoIndex, googleAugmented, reviews } = opts;
  const userReviews = Array.isArray(reviews) ? reviews : [];
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
  const mapsUrl = googleMapsUrlForStudio(studio);
  const mapsUrlEsc = mapsUrl ? escapeHtml(mapsUrl) : '';

  const jsonLd = jsonLdLocalBusiness(studio, canonicalUrl);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name} | Studio Locater</title>
  <meta name="description" content="${metaDesc}">
  ${robotsNoIndex ? '<meta name="robots" content="noindex, follow">' : ''}
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <link rel="icon" href="/favicon.svg?v=6" type="image/svg+xml" sizes="any">
  <link rel="apple-touch-icon" href="/favicon.svg?v=6">
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
    .google-note { font-size:12px; color:var(--plum-light); margin:-8px 0 20px; line-height:1.45; }
    .google-note i { margin-right:6px; color:#4285F4; }
    .btn-maps { background:#fff; color:var(--plum); border:1.5px solid var(--border); }
    .btn-maps:hover { border-color:#4285F4; color:#1a73e8; }
    .mindbody-section { margin-top:28px; padding-top:22px; border-top:1px solid var(--border); }
    .mindbody-section h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--plum-light); margin-bottom:8px; }
    .mindbody-section h3 { font-size:14px; color:var(--plum); margin:18px 0 10px; font-weight:600; }
    .mindbody-lead { font-size:13px; color:var(--plum-mid); margin-bottom:14px; }
    .mindbody-loading { font-size:14px; color:var(--plum-light); }
    .mindbody-list { list-style:none; padding:0; margin:0 0 8px; font-size:14px; color:var(--plum-mid); }
    .mindbody-list li { padding:8px 0; border-bottom:1px solid var(--border); }
    .mindbody-list li:last-child { border-bottom:none; }
    .mindbody-pricing .mb-price { font-weight:600; color:var(--rose-deep); }
    .mindbody-muted { font-size:13px; color:var(--plum-light); }
    .mindbody-err { font-size:13px; color:#b00020; }
    /* Reviews */
    .reviews-section { margin-top:32px; padding-top:24px; border-top:1px solid var(--border); }
    .reviews-section > h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--plum-light); margin-bottom:16px; font-weight:700; }
    .review-card { background:#fff; border:1px solid var(--border); border-radius:12px; padding:14px 16px; margin-bottom:12px; }
    .review-header { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
    .review-stars { color:#C9A96E; font-size:14px; letter-spacing:1px; }
    .review-date { font-size:12px; color:var(--plum-light); }
    .review-comment { font-size:14px; color:var(--plum-mid); line-height:1.6; }
    .no-reviews { font-size:14px; color:var(--plum-light); margin-bottom:16px; }
    #review-form-wrap { margin-top:20px; }
    #review-form-wrap h3 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--plum-light); margin-bottom:14px; font-weight:700; }
    .star-picker { display:flex; gap:6px; margin-bottom:14px; }
    .star-picker button { background:none; border:none; font-size:26px; cursor:pointer; color:#ddd; padding:0; line-height:1; transition:color .15s; }
    .star-picker button.active, .star-picker button:hover ~ button { color:#ddd; }
    .star-picker button.active, .star-picker button:hover { color:#C9A96E; }
    #review-comment { width:100%; border:1.5px solid var(--border); border-radius:10px; padding:10px 12px; font-size:14px; font-family:inherit; color:var(--plum); resize:vertical; min-height:80px; outline:none; }
    #review-comment:focus { border-color:var(--rose-deep); }
    .review-submit-btn { margin-top:10px; display:inline-flex; align-items:center; gap:8px; background:var(--rose-deep); color:#fff; border:none; border-radius:50px; padding:10px 22px; font-size:14px; font-weight:600; cursor:pointer; font-family:inherit; transition:opacity .2s; }
    .review-submit-btn:hover { opacity:.88; }
    .review-login-prompt { font-size:14px; color:var(--plum-mid); }
    .review-login-prompt a { color:var(--rose-deep); font-weight:600; text-decoration:none; }
  </style>
</head>
<body>
  <div class="wrap">
    <nav style="display:flex;align-items:center;justify-content:space-between">
      <a href="/"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Back to search</a>
      <span id="detail-nav-auth" style="font-size:13px;color:var(--plum-light)"></span>
    </nav>
    <script>
    fetch('/api/me',{credentials:'same-origin'}).then(r=>r.json()).then(function(d){
      var el=document.getElementById('detail-nav-auth');
      if(!el)return;
      if(d&&d.user&&d.user.email){
        el.innerHTML='<a href="/account" style="color:var(--plum-mid);text-decoration:none;font-weight:500;display:inline-flex;align-items:center;gap:6px;"><i class="fa-solid fa-circle-user" style="color:var(--rose-deep)"></i> My account</a>';
      }
    }).catch(function(){});
    // Strip ?signed_in=1 and show a welcome toast
    (function(){
      try {
        var q=new URLSearchParams(location.search);
        if(q.get('signed_in')==='1'){
          q.delete('signed_in');
          var s=q.toString();
          history.replaceState({},'',s?location.pathname+'?'+s:location.pathname);
          var t=document.createElement('div');
          t.textContent="You're signed in — leave your review below!";
          t.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--plum);color:#fff;padding:12px 22px;border-radius:50px;font-size:14px;font-weight:500;z-index:9999;white-space:nowrap;box-shadow:0 4px 20px rgba(61,43,94,.3)';
          document.body.appendChild(t);
          setTimeout(function(){t.style.opacity='0';t.style.transition='opacity .5s';setTimeout(function(){t.remove()},500)},3500);
        }
      }catch(e){}
    })();
    </script>
    <article itemscope itemtype="https://schema.org/SportsActivityLocation">
      <header>
        <h1 itemprop="name">${name}</h1>
        <div class="meta">
          ${rating
            ? `<span><i class="fa-solid fa-star" style="color:#C9A96E"></i> <strong>${rating}</strong>${
                revs > 0
                  ? ` (${revs.toLocaleString()} reviews)`
                  : ` <span style="color:var(--plum-light);font-weight:400;font-size:13px">(no reviews in directory yet)</span>`
              }</span>`
            : ''}
          <span><strong>${escapeHtml(price)}</strong></span>
          ${level ? `<span class="pill">${escapeHtml(level)}</span>` : ''}
        </div>
        ${googleAugmented ? `<p class="google-note"><i class="fa-brands fa-google" aria-hidden="true"></i>Photos, ratings, and summary text below may come from Google Maps when your CMS fields are empty.</p>` : ''}
        ${img ? `<img class="hero-img" src="${img}" alt="" itemprop="image" width="800" height="450" loading="eager">` : ''}
        ${addrLine ? `<div class="addr"><i class="fa-solid fa-location-dot" aria-hidden="true"></i><span itemprop="address">${addrLine}</span></div>` : ''}
        <div class="btn-row">
          <a class="btn btn-primary" href="/">Find classes nearby</a>
          ${website ? `<a class="btn btn-ghost" href="${escapeHtml(website)}" target="_blank" rel="noopener noreferrer" itemprop="url">Official website <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:11px;opacity:.8"></i></a>` : ''}
          ${mapsUrlEsc ? `<a class="btn btn-maps" href="${mapsUrlEsc}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-map-location-dot" style="margin-right:6px"></i>Google Maps — photos &amp; reviews</a>` : ''}
        </div>
      </header>
      ${highlight ? `<blockquote>${escapeHtml(highlight)}</blockquote>` : ''}
      ${desc ? `<section class="prose" itemprop="description">${escapeHtml(desc).replace(/\n/g, '<br>')}</section>` : ''}
      ${tips ? `<section><h2>Class tips</h2><div class="prose">${escapeHtml(tips).replace(/\n/g, '<br>')}</div></section>` : ''}
      ${vibes.length ? `<section><h2>Vibes</h2><p>${vibes.map((v) => `<span class="pill">${escapeHtml(v)}</span>`).join(' ')}</p></section>` : ''}
      ${tags.length ? `<section><h2>Class types</h2><div class="tags">${tags.map((t) => `<span>${escapeHtml(t)}</span>`).join('')}</div></section>` : ''}
      ${mindbodyScheduleSectionHtml(studio)}
      ${buildReviewsSectionHtml(studio.slug, userReviews, studio.name)}
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

  const groq = `*[_type == "studio" && slug.current == $slug][0]{ ${STUDIO_DETAIL_PROJECTION} }`;

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

const STUDIO_DETAIL_PROJECTION = `_id, name, description, website, reviewHighlight, experienceLevel, vibeTags, classTips,
    placeId, rating, reviews, priceTier, featured, badge, tags, mindbodySiteId, mindbodyLocationIds,
    neighborhood, address,
    "slug": slug.current,
    "lat": location.lat,
    "lng": location.lng,
    "cardImageUrl": cardImage.asset->url`;

/**
 * Load a studio by Sanity document _id (for /studios/id/... when slug is not set yet).
 * @param {string} documentId
 * @param {string} projectId
 * @param {string} dataset
 * @returns {Promise<object|null>}
 */
export async function fetchStudioByDocumentId(documentId, projectId, dataset) {
  const id = String(documentId || '').trim();
  if (!id || !projectId || !dataset) return null;

  const groq = `*[_type == "studio" && _id == $id][0]{ ${STUDIO_DETAIL_PROJECTION} }`;

  const base = `https://${projectId}.apicdn.sanity.io/v2024-01-01/data/query/${encodeURIComponent(dataset)}`;
  const u = new URL(base);
  u.searchParams.set('query', groq);
  u.searchParams.set('$id', JSON.stringify(id));

  const r = await fetch(u.toString());
  if (!r.ok) return null;
  const j = await r.json();
  const doc = j.result;
  if (!doc || !doc.name) return null;
  return doc;
}

function googlePhotoUrl(photoReference, apiKey) {
  if (!photoReference || !apiKey) return null;
  const ref = encodeURIComponent(String(photoReference));
  return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=${ref}&key=${encodeURIComponent(apiKey)}`;
}

/**
 * Merge Google Place Details when the CMS row is sparse (mirrors homepage merge idea).
 * Requires `GOOGLE_API_KEY` (Places) on the Worker / server.
 * @returns {{ doc: object, augmented: boolean }}
 */
export async function enrichStudioWithGooglePlaces(doc, apiKey) {
  if (!doc || !doc.name) return { doc, augmented: false };
  const key = String(apiKey || '').trim();
  const placeId = doc.placeId && String(doc.placeId).trim();
  if (!placeId) return { doc, augmented: false };
  if (!key) return { doc, augmented: false };

  const fields = [
    'name',
    'website',
    'rating',
    'user_ratings_total',
    'photos',
    'editorial_summary',
    'reviews',
    'geometry'
  ].join(',');
  const u = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=${fields}&key=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(u);
    if (!res.ok) return { doc, augmented: false };
    const data = await res.json();
    if (!data || (data.status && data.status !== 'OK')) return { doc, augmented: false };
    const r = data.result;
    if (!r) return { doc, augmented: false };

    const out = { ...doc };
    let augmented = false;

    const hasCmsImage = doc.cardImageUrl && String(doc.cardImageUrl).trim();
    const photoRef = Array.isArray(r.photos) && r.photos[0] && r.photos[0].photo_reference;
    if (!hasCmsImage && photoRef) {
      const pic = googlePhotoUrl(photoRef, key);
      if (pic) {
        out.cardImageUrl = pic;
        augmented = true;
      }
    }

    const cmsDesc = doc.description && String(doc.description).trim();
    const editorial =
      r.editorial_summary && r.editorial_summary.overview ? String(r.editorial_summary.overview).trim() : '';
    if (!cmsDesc && editorial) {
      out.description = editorial;
      augmented = true;
    }

    const cmsWeb = doc.website && String(doc.website).trim();
    if (!cmsWeb && r.website && String(r.website).trim()) {
      out.website = String(r.website).trim();
      augmented = true;
    }

    const gRev =
      typeof r.user_ratings_total === 'number' && Number.isFinite(r.user_ratings_total) ? r.user_ratings_total : 0;
    if (gRev > 0) {
      out.reviews = gRev;
      augmented = true;
      if (typeof r.rating === 'number' && Number.isFinite(r.rating)) {
        out.rating = Math.round(r.rating * 10) / 10;
      }
    } else if (typeof r.rating === 'number' && Number.isFinite(r.rating)) {
      out.rating = Math.round(r.rating * 10) / 10;
      augmented = true;
    }

    const cmsHl = doc.reviewHighlight && String(doc.reviewHighlight).trim();
    if (!cmsHl && Array.isArray(r.reviews) && r.reviews[0] && r.reviews[0].text) {
      let t = String(r.reviews[0].text).trim().replace(/\s+/g, ' ');
      if (t.length > 200) t = t.slice(0, 197).trim() + '…';
      out.reviewHighlight = t;
      augmented = true;
    }

    const lat0 = doc.lat != null && Number.isFinite(+doc.lat) ? +doc.lat : null;
    const lng0 = doc.lng != null && Number.isFinite(+doc.lng) ? +doc.lng : null;
    if ((lat0 == null || lng0 == null) && r.geometry && r.geometry.location) {
      const la = r.geometry.location.lat;
      const lo = r.geometry.location.lng;
      if (Number.isFinite(+la) && Number.isFinite(+lo)) {
        out.lat = +la;
        out.lng = +lo;
        augmented = true;
      }
    }

    return { doc: out, augmented };
  } catch {
    return { doc, augmented: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// City landing pages
// ─────────────────────────────────────────────────────────────────────────────

const STUDIO_CARD_PROJECTION = `_id, name, description, rating, reviews, priceTier, tags, badge,
  "slug": slug.current,
  address,
  "cardImageUrl": cardImage.asset->url`;

/** "New York" → "new-york", "St. Louis" → "st-louis" */
export function cityToSlug(cityName) {
  return String(cityName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** "new-york" → "New York" (best-effort display name) */
export function citySlugToDisplay(slug) {
  return String(slug || '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Fetch studios in a city that match a Sanity tag.
 * @param {string} citySlug  - e.g. "new-york"
 * @param {string} sanityTag - e.g. "Yoga"
 */
export async function fetchStudiosByCity(citySlug, sanityTag, projectId, dataset) {
  if (!citySlug || !sanityTag || !projectId || !dataset) return [];
  const cityName = citySlugToDisplay(citySlug); // "New York"
  const groq = `*[_type == "studio" && lower(address.city) == lower($city) && $tag in tags] | order(featured desc, rating desc)[0...60]{ ${STUDIO_CARD_PROJECTION} }`;
  const base = `https://${projectId}.apicdn.sanity.io/v2024-01-01/data/query/${encodeURIComponent(dataset)}`;
  const u = new URL(base);
  u.searchParams.set('query', groq);
  u.searchParams.set('$city', JSON.stringify(cityName));
  u.searchParams.set('$tag', JSON.stringify(sanityTag));
  const r = await fetch(u.toString());
  if (!r.ok) return [];
  const j = await r.json();
  return Array.isArray(j.result) ? j.result.filter(Boolean) : [];
}

/**
 * Fetch all unique {citySlug, tag} combos for sitemap generation.
 */
export async function fetchAllCityTagCombos(projectId, dataset) {
  if (!projectId || !dataset) return [];
  const groq = `*[_type == "studio" && defined(address.city) && count(tags) > 0]{ "city": address.city, "tags": tags }`;
  const base = `https://${projectId}.apicdn.sanity.io/v2024-01-01/data/query/${encodeURIComponent(dataset)}`;
  const u = new URL(base);
  u.searchParams.set('query', groq);
  const r = await fetch(u.toString());
  if (!r.ok) return [];
  const j = await r.json();
  const rows = Array.isArray(j.result) ? j.result : [];
  const seen = new Set();
  const combos = [];
  for (const row of rows) {
    const city = String(row.city || '').trim();
    if (!city) continue;
    const citySlug = cityToSlug(city);
    if (!citySlug) continue;
    for (const tag of (Array.isArray(row.tags) ? row.tags : [])) {
      const t = String(tag || '').trim();
      if (!t) continue;
      const key = `${citySlug}::${t}`;
      if (!seen.has(key)) {
        seen.add(key);
        combos.push({ citySlug, tag: t });
      }
    }
  }
  return combos;
}

const CITY_PAGE_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --blush:#F9EAEA;--blush-light:#FDF6F6;--rose:#E8B4B8;--rose-deep:#C97E84;
    --lavender:#EDE5FA;--lavender-deep:#B39DDB;
    --plum:#3D2B3D;--plum-mid:#6B4C6B;--plum-light:#9E7E9E;--off-white:#FDF8F8;
    --border:#F0DCE0;--shadow:rgba(61,43,61,0.08);
  }
  body{font-family:'DM Sans',sans-serif;background:var(--off-white);color:var(--plum);line-height:1.6;}
  nav{position:fixed;top:0;left:0;right:0;height:64px;background:rgba(253,248,248,.92);
    backdrop-filter:blur(20px);border-bottom:1px solid var(--border);
    display:flex;align-items:center;justify-content:space-between;padding:0 32px;z-index:100;}
  .nav-logo{display:flex;align-items:center;gap:10px;text-decoration:none;font-family:'Playfair Display',serif;
    font-size:18px;font-weight:600;color:var(--plum);}
  .nav-links-r{display:flex;gap:20px;align-items:center;}
  .nav-links-r a{text-decoration:none;font-size:13.5px;font-weight:500;color:var(--plum-mid);transition:color .2s;}
  .nav-links-r a:hover{color:var(--plum);}
  .nav-cta{background:linear-gradient(135deg,var(--rose-deep),var(--lavender-deep));
    color:#fff !important;padding:9px 20px;border-radius:50px;font-size:13px;}
  .hero{padding:110px 24px 48px;text-align:center;position:relative;overflow:hidden;}
  .hero-blob{position:absolute;inset:0;z-index:0;
    background:radial-gradient(ellipse 80% 60% at 50% 0%,var(--blush) 0%,var(--lavender) 40%,var(--off-white) 100%);}
  .hero-inner{position:relative;z-index:1;max-width:700px;margin:0 auto;}
  .hero-icon{width:72px;height:72px;border-radius:20px;display:flex;align-items:center;justify-content:center;
    font-size:28px;margin:0 auto 16px;box-shadow:0 8px 28px var(--shadow);}
  .breadcrumb{font-size:13px;color:var(--plum-light);margin-bottom:16px;display:flex;align-items:center;
    justify-content:center;gap:6px;flex-wrap:wrap;}
  .breadcrumb a{color:var(--rose-deep);text-decoration:none;}
  .hero-title{font-family:'Playfair Display',serif;font-size:clamp(32px,5.5vw,48px);font-weight:700;
    line-height:1.2;color:var(--plum);margin-bottom:12px;}
  .hero-title em{font-style:italic;color:var(--rose-deep);}
  .hero-sub{font-size:16px;color:var(--plum-mid);}
  .content{max-width:1100px;margin:0 auto;padding:48px 24px 64px;}
  .studio-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px;margin-bottom:56px;}
  .studio-card{background:#fff;border:1px solid var(--border);border-radius:20px;overflow:hidden;
    text-decoration:none;color:inherit;transition:all .2s;box-shadow:0 2px 8px var(--shadow);display:flex;flex-direction:column;}
  .studio-card:hover{border-color:var(--rose);box-shadow:0 8px 28px rgba(201,126,132,.2);transform:translateY(-3px);}
  .card-img{height:160px;background-size:cover;background-position:center;position:relative;background-color:var(--blush);}
  .card-badge{position:absolute;top:10px;left:10px;
    background:linear-gradient(135deg,var(--rose-deep),var(--lavender-deep));
    color:#fff;font-size:11px;font-weight:600;padding:4px 10px;border-radius:50px;}
  .card-body{padding:16px 18px;display:flex;flex-direction:column;gap:7px;flex:1;}
  .card-header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;}
  .card-name{font-family:'Playfair Display',serif;font-size:17px;font-weight:600;color:var(--plum);line-height:1.3;}
  .card-price{font-size:13px;color:var(--plum-light);font-weight:500;white-space:nowrap;margin-top:2px;}
  .card-addr{font-size:12.5px;color:var(--plum-light);display:flex;align-items:center;gap:5px;}
  .card-addr i{color:var(--rose-deep);font-size:11px;}
  .card-rating{display:flex;align-items:center;gap:6px;font-size:13px;}
  .stars{color:#F59E0B;font-size:13px;letter-spacing:1px;}
  .rating-num{font-weight:600;color:var(--plum);}
  .review-count{color:var(--plum-light);}
  .card-desc{font-size:13px;color:var(--plum-mid);line-height:1.5;}
  .card-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:auto;padding-top:4px;}
  .card-tag{background:var(--lavender);color:var(--plum-mid);font-size:11px;font-weight:500;
    padding:3px 10px;border-radius:50px;}
  .no-results{text-align:center;padding:64px 24px;color:var(--plum-mid);}
  .no-results a{color:var(--rose-deep);text-decoration:none;font-weight:500;}
  .cta-section{background:var(--blush);border-radius:24px;padding:48px 32px;text-align:center;}
  .cta-section h2{font-family:'Playfair Display',serif;font-size:26px;font-weight:700;color:var(--plum);margin-bottom:10px;}
  .cta-section p{font-size:15px;color:var(--plum-mid);margin-bottom:28px;}
  .cta-btn{display:inline-flex;align-items:center;gap:10px;
    background:linear-gradient(135deg,var(--rose-deep),var(--lavender-deep));
    color:#fff;padding:14px 32px;border-radius:50px;font-size:15px;font-weight:600;
    text-decoration:none;box-shadow:0 6px 20px rgba(201,126,132,.35);transition:transform .2s,box-shadow .2s;}
  .cta-btn:hover{transform:translateY(-2px);box-shadow:0 10px 28px rgba(201,126,132,.45);}
  footer{text-align:center;padding:40px 24px;border-top:1px solid var(--border);
    color:var(--plum-light);font-size:13px;}
  footer a{color:var(--rose-deep);text-decoration:none;}
  @media(max-width:640px){
    nav{padding:0 16px;height:56px;}
    .hero{padding:90px 16px 36px;}
    .content{padding:32px 16px 48px;}
    .studio-grid{grid-template-columns:1fr;}
  }
`;

/**
 * Build a city landing page: /{tagSlug}-studios-{citySlug}
 */
export function buildCityPageHtml(studios, { tagSlug, tagName, tagIcon, tagColor, tagBg, citySlug, cityDisplayName, origin }) {
  const canonicalUrl = `${origin}/${tagSlug}-studios-${citySlug}`;
  const count = studios.length;
  const title = `Best ${tagName} Studios in ${cityDisplayName} | Studio Locater`;
  const metaDesc = `Find the top ${tagName.toLowerCase()} studios in ${cityDisplayName}. Browse ${count} studio${count !== 1 ? 's' : ''} — read reviews, compare prices, and find your perfect ${tagName.toLowerCase()} class.`;

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `${tagName} Studios in ${cityDisplayName}`,
    url: canonicalUrl,
    numberOfItems: count,
    itemListElement: studios.map((s, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'LocalBusiness',
        name: s.name,
        url: `${origin}/studios/${s.slug}`,
        ...(s.address ? { address: {
          '@type': 'PostalAddress',
          streetAddress: s.address.streetLine1,
          addressLocality: s.address.city,
          addressRegion: s.address.region,
          postalCode: s.address.postalCode,
          addressCountry: s.address.country || 'US'
        }} : {}),
        ...(s.rating ? { aggregateRating: {
          '@type': 'AggregateRating',
          ratingValue: s.rating,
          reviewCount: s.reviews || 1
        }} : {})
      }
    }))
  });

  const breadcrumbJsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Studio Locater', item: `${origin}/` },
      { '@type': 'ListItem', position: 2, name: tagName, item: `${origin}/classes/${tagSlug}` },
      { '@type': 'ListItem', position: 3, name: `${tagName} Studios in ${cityDisplayName}`, item: canonicalUrl }
    ]
  });

  const studioCards = studios.map(s => {
    const addr = s.address ? [s.address.streetLine1, s.address.city, s.address.region].filter(Boolean).join(', ') : '';
    const rating = typeof s.rating === 'number' ? s.rating : 0;
    const fullStars = Math.round(rating);
    const stars = '★'.repeat(fullStars) + '☆'.repeat(Math.max(0, 5 - fullStars));
    const tagPills = (s.tags || []).slice(0, 3).map(t => `<span class="card-tag">${escapeHtml(t)}</span>`).join('');
    const price = s.priceTier ? '$'.repeat(s.priceTier) : '';
    const imgStyle = s.cardImageUrl
      ? `background-image:url(${escapeHtml(s.cardImageUrl)})`
      : `background:${tagBg}`;
    return `
    <a class="studio-card" href="${escapeHtml(`${origin}/studios/${s.slug}`)}">
      <div class="card-img" style="${imgStyle}">
        ${s.badge ? `<span class="card-badge">${escapeHtml(s.badge)}</span>` : ''}
      </div>
      <div class="card-body">
        <div class="card-header">
          <div class="card-name">${escapeHtml(s.name)}</div>
          ${price ? `<span class="card-price">${price}</span>` : ''}
        </div>
        ${addr ? `<p class="card-addr"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(addr)}</p>` : ''}
        ${rating ? `<div class="card-rating"><span class="stars">${stars}</span><span class="rating-num">${rating.toFixed(1)}</span>${s.reviews ? `<span class="review-count">(${s.reviews.toLocaleString()})</span>` : ''}</div>` : ''}
        ${s.description ? `<p class="card-desc">${escapeHtml(s.description.slice(0, 120))}${s.description.length > 120 ? '…' : ''}</p>` : ''}
        <div class="card-tags">${tagPills}</div>
      </div>
    </a>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(metaDesc)}">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(metaDesc)}">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="/favicon.svg?v=6" type="image/svg+xml" sizes="any">
  <link rel="sitemap" type="application/xml" title="Sitemap" href="/sitemap.xml">
  <script type="application/ld+json">${jsonLd}</script>
  <script type="application/ld+json">${breadcrumbJsonLd}</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;0,700;1,500&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>${CITY_PAGE_CSS}</style>
</head>
<body>
  <nav>
    <a class="nav-logo" href="/"><i class="fa-solid fa-spa" style="color:var(--rose-deep)"></i> Studio Locater</a>
    <div class="nav-links-r">
      <a href="/">Explore</a>
      <a href="/classes">Classes</a>
      <a href="/blog">Blog</a>
      <a class="nav-cta" href="/">Find Studios</a>
    </div>
  </nav>

  <div class="hero">
    <div class="hero-blob"></div>
    <div class="hero-inner">
      <div class="hero-icon" style="background:${tagBg}">
        <i class="fa-solid ${tagIcon}" style="color:${tagColor}"></i>
      </div>
      <nav class="breadcrumb" aria-label="Breadcrumb">
        <a href="/">Studio Locater</a>
        <span aria-hidden="true">›</span>
        <a href="/classes/${escapeHtml(tagSlug)}">${escapeHtml(tagName)}</a>
        <span aria-hidden="true">›</span>
        <span>${escapeHtml(cityDisplayName)}</span>
      </nav>
      <h1 class="hero-title">Best <em>${escapeHtml(tagName)}</em> Studios<br>in ${escapeHtml(cityDisplayName)}</h1>
      <p class="hero-sub">${count} studio${count !== 1 ? 's' : ''} found — browse reviews, locations &amp; pricing.</p>
    </div>
  </div>

  <main class="content">
    ${count === 0 ? `
    <div class="no-results">
      <p>No ${escapeHtml(tagName.toLowerCase())} studios found in ${escapeHtml(cityDisplayName)} yet.</p>
      <p style="margin-top:12px"><a href="/">Search all studios</a> &nbsp;·&nbsp; <a href="/classes/${escapeHtml(tagSlug)}">Browse ${escapeHtml(tagName)} guide</a></p>
    </div>` : `
    <div class="studio-grid">${studioCards}
    </div>`}

    <div class="cta-section">
      <h2>Find More Studios Near You</h2>
      <p>Search by location, class type, rating, and more — all free.</p>
      <a class="cta-btn" href="/">Search All Studios <i class="fa-solid fa-arrow-right"></i></a>
    </div>
  </main>

  <footer>
    <a href="/">Studio Locater</a> &nbsp;·&nbsp; <a href="/classes">Class Guide</a> &nbsp;·&nbsp; <a href="/blog">Blog</a> &nbsp;·&nbsp; &copy; 2026
  </footer>
</body>
</html>`;
}

/**
 * Returns [{slug, updatedAt}] for sitemap lastmod support.
 * @returns {Promise<Array<{slug:string, updatedAt:string|null}>>}
 */
export async function fetchAllStudioSlugs(projectId, dataset) {
  if (!projectId || !dataset) return [];
  const groq = `*[_type == "studio" && defined(slug.current)]{"s": slug.current, "u": _updatedAt}`;
  const base = `https://${projectId}.apicdn.sanity.io/v2024-01-01/data/query/${encodeURIComponent(dataset)}`;
  const u = new URL(base);
  u.searchParams.set('query', groq);
  const r = await fetch(u.toString());
  if (!r.ok) return [];
  const j = await r.json();
  const rows = j.result || [];
  return rows.map((row) => ({ slug: row.s, updatedAt: row.u || null })).filter(e => e.slug);
}

// ─────────────────────────────────────────────────────────────────────────────
// Neighborhood landing pages (extends city infrastructure)
// ─────────────────────────────────────────────────────────────────────────────

const STUDIO_NEIGHBORHOOD_PROJECTION = `_id, name, description, rating, reviews, priceTier, tags, badge, neighborhood,
  "slug": slug.current,
  address,
  "cardImageUrl": cardImage.asset->url`;

/**
 * Fetch studios in a neighborhood that match a Sanity tag.
 * @param {string} neighborhoodSlug - e.g. "upper-west-side"
 * @param {string} sanityTag        - e.g. "Yoga"
 */
export async function fetchStudiosByNeighborhood(neighborhoodSlug, sanityTag, projectId, dataset) {
  if (!neighborhoodSlug || !sanityTag || !projectId || !dataset) return [];
  const neighborhoodName = citySlugToDisplay(neighborhoodSlug);
  const groq = `*[_type == "studio" && defined(neighborhood) && lower(neighborhood) == lower($nbhd) && $tag in tags] | order(featured desc, rating desc)[0...60]{ ${STUDIO_NEIGHBORHOOD_PROJECTION} }`;
  const base = `https://${projectId}.apicdn.sanity.io/v2024-01-01/data/query/${encodeURIComponent(dataset)}`;
  const u = new URL(base);
  u.searchParams.set('query', groq);
  u.searchParams.set('$nbhd', JSON.stringify(neighborhoodName));
  u.searchParams.set('$tag', JSON.stringify(sanityTag));
  const r = await fetch(u.toString());
  if (!r.ok) return [];
  const j = await r.json();
  return Array.isArray(j.result) ? j.result.filter(Boolean) : [];
}

/**
 * Fetch all unique {neighborhoodSlug, tag} combos for sitemap generation.
 */
export async function fetchAllNeighborhoodTagCombos(projectId, dataset) {
  if (!projectId || !dataset) return [];
  const groq = `*[_type == "studio" && defined(neighborhood) && neighborhood != "" && count(tags) > 0]{ "neighborhood": neighborhood, "tags": tags }`;
  const base = `https://${projectId}.apicdn.sanity.io/v2024-01-01/data/query/${encodeURIComponent(dataset)}`;
  const u = new URL(base);
  u.searchParams.set('query', groq);
  const r = await fetch(u.toString());
  if (!r.ok) return [];
  const j = await r.json();
  const rows = Array.isArray(j.result) ? j.result : [];
  const seen = new Set();
  const combos = [];
  for (const row of rows) {
    const nbhd = String(row.neighborhood || '').trim();
    if (!nbhd) continue;
    const nbhdSlug = cityToSlug(nbhd);
    if (!nbhdSlug) continue;
    for (const tag of (Array.isArray(row.tags) ? row.tags : [])) {
      const t = String(tag || '').trim();
      if (!t) continue;
      const key = `${nbhdSlug}::${t}`;
      if (!seen.has(key)) {
        seen.add(key);
        combos.push({ neighborhoodSlug: nbhdSlug, tag: t });
      }
    }
  }
  return combos;
}

/**
 * @param {string} origin
 * @param {Array<string|{slug:string,updatedAt?:string}>} studioSlugs
 * @param {{ blogSlugs?: string[]; blogEntries?: {slug:string,lastmod?:string}[]; classSlugs?: string[]; cityPagePaths?: string[] }} [options]
 */
export function buildSitemapXml(origin, studioSlugs, options = {}) {
  const classSlugs   = Array.isArray(options.classSlugs)   ? options.classSlugs.filter(Boolean)   : [];
  const cityPagePaths = Array.isArray(options.cityPagePaths) ? options.cityPagePaths.filter(Boolean) : [];
  // blogEntries supersedes blogSlugs when provided
  const blogEntries = Array.isArray(options.blogEntries)
    ? options.blogEntries.filter(e => e && e.slug)
    : (Array.isArray(options.blogSlugs) ? options.blogSlugs.filter(Boolean).map(s => ({ slug: s })) : []);

  // Normalise studioSlugs: accept both string[] and {slug, updatedAt}[]
  const studioEntries = Array.isArray(studioSlugs)
    ? studioSlugs
        .map(s => typeof s === 'string' ? { slug: s, updatedAt: null } : { slug: s.slug, updatedAt: s.updatedAt || null })
        .filter(e => e.slug)
    : [];

  const base = String(origin || '').replace(/\/$/, '');
  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  function isoDate(ts) {
    if (!ts) return null;
    try { return new Date(ts).toISOString().split('T')[0]; } catch { return null; }
  }

  const entries = [
    { loc: `${base}/`,        priority: '1.0',  changefreq: 'weekly'  },
    { loc: `${base}/blog`,    priority: '0.85', changefreq: 'weekly'  },
    { loc: `${base}/classes`, priority: '0.85', changefreq: 'weekly'  },
    ...cityPagePaths.map((p) => ({ loc: `${base}${p}`,  priority: '0.80', changefreq: 'weekly'  })),
    ...studioEntries.map(({ slug, updatedAt }) => ({
      loc: `${base}/studios/${encodeURIComponent(slug)}`,
      priority: '0.7', changefreq: 'weekly',
      lastmod: isoDate(updatedAt)
    })),
    ...blogEntries.map(({ slug, lastmod }) => ({
      loc: `${base}/blog/${encodeURIComponent(slug)}`,
      priority: '0.72', changefreq: 'monthly',
      lastmod: lastmod || null
    })),
    ...classSlugs.map((slug) => ({ loc: `${base}/classes/${encodeURIComponent(slug)}`, priority: '0.75', changefreq: 'monthly' })),
  ];

  const body = entries
    .map((e) => `  <url>
    <loc>${esc(e.loc)}</loc>
    ${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>\n    ` : ''}<changefreq>${e.changefreq}</changefreq>
    <priority>${e.priority}</priority>
  </url>`)
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
  <link rel="icon" href="/favicon.svg?v=6" type="image/svg+xml" sizes="any">
  <link rel="apple-touch-icon" href="/favicon.svg?v=6">
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
