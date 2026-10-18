/**
 * Shared helpers for the hidden-gems / airing / current-year endpoints.
 *
 * All endpoints share the same pattern:
 *   1. Scan up to 50 upstream TMDB pages (parallel batches of 10).
 *   2. Filter client-side (date range, status, etc.).
 *   3. Sort the filtered list.
 *   4. Cache the full filtered list with a feature-specific TTL.
 *   5. Slice into 20-item pages on demand.
 */

import { tmdbFetch } from './provider.js';
import {
  buildCacheKey,
  get as cacheGet,
  set as cacheSet,
} from './cache.js';

export const MAX_UPSTREAM_PAGES = 50;
export const BATCH_SIZE = 10;
export const PER_PAGE = 20;

// TTL constants
export const TTL_HIDDEN_GEMS = 12 * 60 * 60 * 1000;   // 12 hours
export const TTL_TV_AIRING = 6 * 60 * 60 * 1000;      // 6 hours
export const TTL_MOVIES_CURRENT_YEAR = 12 * 60 * 60 * 1000; // 12 hours

// Hidden gem thresholds (configurable — change here to adjust globally)
export const HIDDEN_GEM = {
  MIN_RATING: 7.0,
  MIN_VOTE_COUNT: 50,
  MAX_POPULARITY: 50,
};

/**
 * Sleep helper.
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Parse a date string "YYYY-MM-DD" into a Date object (UTC).
 * Returns null if invalid.
 */
export function parseDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Format a Date object as "YYYY-MM-DD" in UTC.
 */
export function formatDateUTC(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Compute the dynamic date range for TV airing:
 *   from = January 1 of (currentYear - 3)
 *   to   = today (UTC)
 */
export function computeTvAiringDateRange() {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const from = new Date(Date.UTC(currentYear - 3, 0, 1)); // Jan 1, (currentYear-3)
  const to = now;
  return {
    from: formatDateUTC(from),
    to: formatDateUTC(to),
    fromYear: currentYear - 3,
    toYear: currentYear,
  };
}

/**
 * Compute the dynamic date range for movies current-year:
 *   from = January 1 of currentYear
 *   to   = today (UTC)
 */
export function computeMovieCurrentYearDateRange() {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const from = new Date(Date.UTC(currentYear, 0, 1)); // Jan 1, currentYear
  const to = now;
  return {
    from: formatDateUTC(from),
    to: formatDateUTC(to),
    year: currentYear,
  };
}

/**
 * Fetch up to maxPages (default MAX_UPSTREAM_PAGES) pages from a TMDB list
 * endpoint in parallel batches of BATCH_SIZE.
 *
 * @param {string} path       - TMDB path (e.g. "tv/on_the_air", "discover/tv")
 * @param {object} baseQuery  - Query params to send on every request
 * @param {string} language   - Language code
 * @param {function} shouldStopEarly - Optional: (batchResults, allResults) => boolean
 *        If returns true, stop scanning (e.g. when sorted by popularity.asc
 *        and we hit popularity > threshold).
 * @param {number} maxPages   - Optional: override MAX_UPSTREAM_PAGES
 * @returns {Promise<{results: Array, upstreamTotalPages: number, pagesFetched: number}>}
 */
export async function fetchUpstreamPages(path, baseQuery, language, shouldStopEarly, maxPages) {
  const limit = maxPages || MAX_UPSTREAM_PAGES;
  const allResults = [];
  let upstreamTotalPages = limit;
  let pagesFetched = 0;

  for (let start = 1; start <= limit; start += BATCH_SIZE) {
    const batch = [];
    const end = Math.min(start + BATCH_SIZE - 1, limit, upstreamTotalPages);

    for (let p = start; p <= end; p++) {
      const query = { ...baseQuery, language, page: String(p) };
      batch.push(
        tmdbFetch(path, query)
          .then((r) => {
            if (r && r.status === 200 && r.body) {
              if (r.body.total_pages) {
                upstreamTotalPages = Math.min(upstreamTotalPages, r.body.total_pages);
              }
              return r.body.results || [];
            }
            return [];
          })
          .catch(() => [])
      );
    }

    const batchResults = await Promise.all(batch);
    let batchEmpty = true;
    for (const r of batchResults) {
      if (r.length > 0) batchEmpty = false;
      allResults.push(...r);
      pagesFetched++;
    }

    // Early termination check
    if (shouldStopEarly && shouldStopEarly(batchResults.flat(), allResults)) {
      break;
    }

    // If entire batch was empty, we've passed the last page — stop
    if (batchEmpty) break;
  }

  return { results: allResults, upstreamTotalPages, pagesFetched };
}

/**
 * Deduplicate items by ID.
 */
export function deduplicateById(items) {
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    if (item.id && !seen.has(item.id)) {
      seen.add(item.id);
      deduped.push(item);
    }
  }
  return deduped;
}

/**
 * Sort items by the requested sort key.
 * Supports: popularity.desc, popularity.asc, vote_average.desc, vote_average.asc,
 *           first_air_date.desc, first_air_date.asc, release_date.desc, release_date.asc
 */
export function sortResults(results, sortBy) {
  const sorted = [...results];
  const getDate = (item) => item.first_air_date || item.release_date || '';

  switch (sortBy) {
    case 'popularity.asc':
      sorted.sort((a, b) => (a.popularity || 0) - (b.popularity || 0));
      break;
    case 'vote_average.desc':
      sorted.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
      break;
    case 'vote_average.asc':
      sorted.sort((a, b) => (a.vote_average || 0) - (b.vote_average || 0));
      break;
    case 'first_air_date.desc':
    case 'release_date.desc':
      sorted.sort((a, b) => getDate(b).localeCompare(getDate(a)));
      break;
    case 'first_air_date.asc':
    case 'release_date.asc':
      sorted.sort((a, b) => getDate(a).localeCompare(getDate(b)));
      break;
    case 'popularity.desc':
    default:
      sorted.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
      break;
  }
  return sorted;
}

/**
 * Paginate a list into 20-item pages and return the requested page.
 * Returns { page, per_page, total_pages, total_results, results, has_next_page }
 */
export function paginate(items, page) {
  const totalResults = items.length;
  const totalPages = Math.max(1, Math.ceil(totalResults / PER_PAGE));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (safePage - 1) * PER_PAGE;
  const pageResults = items.slice(startIndex, startIndex + PER_PAGE);

  return {
    page: safePage,
    per_page: PER_PAGE,
    total_pages: totalPages,
    total_results: totalResults,
    current_page: safePage,
    last_visible_page: totalPages,
    has_next_page: safePage < totalPages,
    results: pageResults,
  };
}

/**
 * Check cache for a stored filtered list. Returns { found, value, cachedAt } or { found: false }.
 */
export function getCache(cacheKey) {
  const cached = cacheGet(cacheKey);
  if (cached) {
    return {
      found: true,
      value: cached.value,
      cachedAt: cached.value.cached_at,
    };
  }
  return { found: false };
}

/**
 * Store a filtered list in cache.
 */
export function setCache(cacheKey, value, ttlMs) {
  cacheSet(cacheKey, value, 200, 'application/json', ttlMs);
}

/**
 * Build a cache key from feature name + params.
 */
export function makeCacheKey(feature, params) {
  return buildCacheKey(feature, params);
}

/**
 * Set standard CORS + cache headers on the response.
 */
export function setHeaders(res, cacheStatus, ttlMs) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.setHeader('X-Cache', cacheStatus); // HIT or MISS
  res.setHeader('X-Cache-TTL', `${Math.floor(ttlMs / 1000)}s`);
  res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${Math.floor(ttlMs / 1000)}, stale-while-revalidate=${Math.floor(ttlMs / 500)}`);
}

/**
 * Handle OPTIONS preflight + non-GET methods.
 */
export function handlePreflight(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    res.status(204).end();
    return true;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return true;
  }
  return false;
}
