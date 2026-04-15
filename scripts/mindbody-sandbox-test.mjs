#!/usr/bin/env node
/**
 * Smoke-test Mindbody Public API v6 against the shared sandbox (Site ID -99).
 *
 * 1. POST /usertoken/issue — Api-Key + SiteId headers, Username/Password in JSON body.
 * 2. GET /class/classschedules — Api-Key, SiteId, and `authorization: <AccessToken>` (raw token; see v6 Swagger).
 *
 * Setup:
 *   - Developer portal may show BOTH an app "Key" (hex) AND "Public API Source" password.
 *     The `Api-Key` header must match what Mindbody expects — try in order:
 *       MINDBODY_APP_KEY=...   ← hex key next to your app name (StudioLocater-1), OR
 *       MINDBODY_SOURCE_SECRET=...  ← Source password under Public API Source Credentials
 *       MINDBODY_SITE_ID=-99
 *   - Sandbox *site* login (published by Mindbody for token issue) defaults below;
 *     override with MINDBODY_SANDBOX_USERNAME / MINDBODY_SANDBOX_PASSWORD if needed.
 *
 * Usage:
 *   npm run mindbody:sandbox
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.dev.vars') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const BASE =
  process.env.MINDBODY_API_BASE_URL?.replace(/\/$/, '') ||
  'https://api.mindbodyonline.com/public/v6';

/** App table "Key" (hex) often works as Api-Key; if 401, try Source password instead. */
const apiKey =
  process.env.MINDBODY_APP_KEY?.trim() ||
  process.env.MINDBODY_API_KEY?.trim() ||
  process.env.MINDBODY_SOURCE_SECRET?.trim();

const siteId = (process.env.MINDBODY_SITE_ID || '-99').trim();

/** Mindbody documents these for sandbox token issue (Site -99). */
const sandboxUser =
  process.env.MINDBODY_SANDBOX_USERNAME?.trim() || 'mindbodysandboxsite@gmail.com';
const sandboxPass =
  process.env.MINDBODY_SANDBOX_PASSWORD?.trim() || 'Apitest1234';

function isoRangeDays(from, days) {
  const a = new Date(from);
  a.setUTCHours(0, 0, 0, 0);
  const b = new Date(a);
  b.setUTCDate(b.getUTCDate() + days);
  return { start: a.toISOString(), end: b.toISOString() };
}

async function main() {
  if (!apiKey) {
    console.error(
      'Set one of in .dev.vars: MINDBODY_APP_KEY (hex from Issued/App row), or MINDBODY_SOURCE_SECRET (Public API Source password).'
    );
    process.exit(1);
  }

  const issueUrl = `${BASE}/usertoken/issue`;
  const issueRes = await fetch(issueUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': apiKey,
      SiteId: siteId,
    },
    body: JSON.stringify({
      Username: sandboxUser,
      Password: sandboxPass,
    }),
  });

  const issueText = await issueRes.text();
  let issueJson;
  try {
    issueJson = JSON.parse(issueText);
  } catch {
    console.error('Token issue: non-JSON response', issueRes.status, issueText.slice(0, 500));
    process.exit(1);
  }

  if (!issueRes.ok) {
    console.error('Token issue failed:', issueRes.status, JSON.stringify(issueJson, null, 2));
    if (issueRes.status === 401 && issueJson?.Error?.Message?.includes?.('API key')) {
      console.error(`
Hint: "Invalid API key" usually means the wrong secret is in .dev.vars.
  • If you only set MINDBODY_SOURCE_SECRET, try MINDBODY_APP_KEY=<hex key from the app table> instead (or vice versa).
  • If the value has # or =, wrap it in double quotes in .dev.vars.
  • Confirm the key status is Active in the Mindbody portal.`);
    }
    process.exit(1);
  }

  const token =
    issueJson.AccessToken ||
    issueJson.accessToken ||
    issueJson.access_token;
  if (!token) {
    console.error('Token issue: no AccessToken in body:', JSON.stringify(issueJson, null, 2));
    process.exit(1);
  }

  console.log('Token OK (AccessToken received). Fetching class schedules…\n');

  const { start, end } = isoRangeDays(new Date(), 7);
  const qs = new URLSearchParams();
  qs.set('request.startDate', start);
  qs.set('request.endDate', end);
  qs.set('request.limit', '50');

  const schedUrl = `${BASE}/class/classschedules?${qs.toString()}`;
  const schedRes = await fetch(schedUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Api-Key': apiKey,
      SiteId: siteId,
      // Public API v6: staff AccessToken in `authorization` (Swagger; not always "Bearer …")
      authorization: String(token),
    },
  });

  const schedText = await schedRes.text();
  let schedJson;
  try {
    schedJson = JSON.parse(schedText);
  } catch {
    console.error('Schedules: non-JSON response', schedRes.status, schedText.slice(0, 500));
    process.exit(1);
  }

  if (!schedRes.ok) {
    console.error('Schedules failed:', schedRes.status, JSON.stringify(schedJson, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify(schedJson, null, 2));

  const rows =
    schedJson?.ClassSchedules ||
    schedJson?.classSchedules ||
    schedJson?.Classes ||
    schedJson?.classes;
  const n = Array.isArray(rows) ? rows.length : 0;
  console.error(`\n(${n} class schedule row(s); sandbox resets nightly.)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
