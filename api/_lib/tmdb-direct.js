/**
 * TMDB-direct fallback provider.
 *
 * The mapple scraping tier (see mapple.js) is fragile: as of Oct 2026
 * mapple.fun sits behind a Cloudflare bot-challenge that serverless IPs
 * cannot pass (every discovery/auth POST returns a 403 challenge page,
 * so domain discovery never succeeds). When that tier is unavailable,
 * this provider serves the SAME data straight from TMDB using a
 * server-side read token (env var TMDB_BEARER) so every proxy endpoint
 * keeps working with identical response shapes.
 *
 * Design notes:
 *   - The mapple tier is ALWAYS tried first (provider.js). This module is
 *     a pure fallback: zero behaviour change while mapple is healthy.
 *   - The mapple tier's "one call returns everything inline" contract for
 *     /movie/{id} and /tv/{id} is replicated here by injecting TMDB's
 *     append_to_response with the same sub-resources the combined detail
 *     endpoints consume.
 *   - The read token is the same api_read token the site itself embeds in
 *     its public frontend bundle — read-only scope, no write access.
 */

const TMDB_BASE = 'https://api.themoviedb.org/3';

// append_to_response enrichment so the one-call details contract of the
// mapple tier (everything inline) is replicated on the direct tier.
const DETAIL_APPEND = {
  movie: [
    'credits',
    'images',
    'keywords',
    'videos',
    'reviews',
    'translations',
    'external_ids',
    'watch/providers',
    'release_dates',
    'recommendations',
    'similar',
    'alternative_titles',
  ].join(','),
  tv: [
    'credits',
    'images',
    'keywords',
    'videos',
    'reviews',
    'translations',
    'external_ids',
    'alternative_titles',
  ].join(','),
};

/**
 * Whether the direct tier is configured and usable.
 */
export function directEnabled() {
  return Boolean(process.env.TMDB_BEARER);
}

/**
 * Inject append_to_response for single-item detail paths so direct-tier
 * payloads carry every sub-resource the combined endpoints expect.
 * List/search/season paths are passed through untouched.
 */
function enrichQuery(path, query) {
  if (/^movie\/\d+$/.test(path) && !query.append_to_response) {
    return { ...query, append_to_response: DETAIL_APPEND.movie };
  }
  if (/^tv\/\d+$/.test(path) && !query.append_to_response) {
    return { ...query, append_to_response: DETAIL_APPEND.tv };
  }
  return query;
}

/**
 * Authenticated GET against TMDB directly.
 * Returns the same { status, body, headers } contract as mapple.js tmdbGet.
 */
async function tmdbDirectGet(path, query) {
  const token = process.env.TMDB_BEARER;
  if (!token) {
    return {
      status: 503,
      body: { error: 'TMDB direct tier not configured (set TMDB_BEARER env var)' },
      headers: {},
    };
  }

  const url = new URL(`${TMDB_BASE}/${path.replace(/^\//, '')}`);
  const q = enrichQuery(path, { ...(query || {}) });
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
  });

  const bodyText = await res.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (_) {
    body = { error: 'Invalid JSON from TMDB', raw: bodyText.slice(0, 300) };
  }

  return {
    status: res.status,
    body,
    headers: { contentType: res.headers.get('content-type') || 'application/json' },
  };
}

export { tmdbDirectGet };
