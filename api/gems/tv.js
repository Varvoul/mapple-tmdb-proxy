/**
 * Hidden Gems TV: /api/gems/tv
 *
 * Returns PURE currently-airing TV shows that started in the last 3 years
 * (current year + previous 2 years). Filters out old long-running shows
 * and finished shows that pollute the raw /tv/on_the_air endpoint.
 *
 * How it works:
 *   1. Fetches /tv/on_the_air from mapple.fun, pages 1-20 (in parallel batches
 *      of 10 for speed without overwhelming rate limits).
 *   2. Filters results: keeps only shows where first_air_date year is within
 *      [currentYear - 2, currentYear]. Dynamic — auto-adjusts every Jan 1.
 *   3. Sorts by popularity desc (most popular first) by default. Use
 *      ?sort_by=popularity.asc for true "hidden gems" (least popular but
 *      currently airing). Other options: vote_average.desc, first_air_date.desc.
 *   4. Caches the full filtered list for 10 minutes (keyed by year window +
 *      language + sort). Subsequent page requests serve from cache instantly.
 *   5. Returns 20 items per page (TMDB standard), with total_pages and
 *      total_results reflecting the FILTERED set.
 *
 * Query params:
 *   - page (default 1) — which page of filtered results to return
 *   - language (default en-US) — metadata language
 *   - sort_by (default popularity.desc) — sort order for filtered results
 *       Options: popularity.desc, popularity.asc, vote_average.desc,
 *                 vote_average.asc, first_air_date.desc, first_air_date.asc
 *
 * Response shape (mirrors TMDB list format + extra metadata):
 *   {
 *     "page": 1,
 *     "results": [...20 items...],
 *     "total_pages": N,
 *     "total_results": M,
 *     "filter": {
 *       "type": "tv",
 *       "source_endpoint": "/tv/on_the_air",
 *       "date_range": { "start_year": 2024, "end_year": 2026 },
 *       "field": "first_air_date",
 *       "upstream_pages_fetched": 50
 *     },
 *     "cached_at": "...",
 *     "cached_until": "..."
 *   }
 */

import { tmdbGet } from '../_lib/mapple.js';
import {
  buildCacheKey,
  get as cacheGet,
  set as cacheSet,
  edgeCacheHeaders,
} from '../_lib/cache.js';

const TTL_MS = 10 * 60 * 1000;        // 10 min cache
const MAX_UPSTREAM_PAGES = 20;        // 20 pages × 20 = 400 upstream items
const BATCH_SIZE = 10;                 // 10 parallel requests per batch
const PAGE_SIZE = 20;                  // TMDB standard

/**
 * Fetch all upstream pages of /tv/on_the_air in parallel batches.
 * Stops early if a batch returns empty (means we hit the last page).
 */
async function fetchAllUpstreamPages(language) {
  const allResults = [];
  let upstreamTotalPages = MAX_UPSTREAM_PAGES;

  for (let start = 1; start <= MAX_UPSTREAM_PAGES; start += BATCH_SIZE) {
    const batch = [];
    const end = Math.min(start + BATCH_SIZE - 1, MAX_UPSTREAM_PAGES, upstreamTotalPages);

    for (let p = start; p <= end; p++) {
      batch.push(
        tmdbGet('tv/on_the_air', { language, page: String(p) })
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
    }

    // If entire batch was empty, we've passed the last page — stop
    if (batchEmpty) break;
  }

  return { results: allResults, upstreamTotalPages };
}

/**
 * Parse year from a date string like "2025-03-14". Returns null if invalid.
 */
function parseYear(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const m = dateStr.match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Sort filtered results by the requested sort key.
 */
function sortResults(results, sortBy) {
  const sorted = [...results];
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
      sorted.sort((a, b) => (b.first_air_date || '').localeCompare(a.first_air_date || ''));
      break;
    case 'first_air_date.asc':
      sorted.sort((a, b) => (a.first_air_date || '').localeCompare(b.first_air_date || ''));
      break;
    case 'popularity.desc':
    default:
      sorted.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
      break;
  }
  return sorted;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Parse params
  const language = req.query?.language || 'en-US';
  const page = Math.max(1, parseInt(req.query?.page || '1', 10));
  const sortBy = req.query?.sort_by || 'popularity.desc';

  // Compute dynamic year window: current year + previous 2 years (3 total)
  const currentYear = new Date().getFullYear();
  const startYear = currentYear - 2;
  const endYear = currentYear;

  // Cache key includes year window + language + sort
  // When year changes (new Jan 1), cache key changes → fresh fetch
  const cacheKey = buildCacheKey('gems/tv', {
    language,
    years: `${startYear}-${endYear}`,
    sort: sortBy,
  });

  // Check cache for the full filtered list
  const cached = cacheGet(cacheKey);
  let filteredResults;
  let cachedAt;
  let upstreamPagesFetched;

  if (cached) {
    filteredResults = cached.value.results;
    cachedAt = cached.value.cached_at;
    upstreamPagesFetched = cached.value.upstream_pages_fetched;
    res.setHeader('X-Cache', 'HIT');
  } else {
    // Fetch all upstream pages
    const { results: allResults, upstreamTotalPages } = await fetchAllUpstreamPages(language);
    upstreamPagesFetched = Math.min(MAX_UPSTREAM_PAGES, upstreamTotalPages);

    // Deduplicate by TV id (in case of overlap across pages)
    const seen = new Set();
    const deduped = [];
    for (const item of allResults) {
      if (item.id && !seen.has(item.id)) {
        seen.add(item.id);
        deduped.push(item);
      }
    }

    // Filter by year window (first_air_date year in [startYear, endYear])
    filteredResults = deduped.filter((item) => {
      const year = parseYear(item.first_air_date);
      if (year === null) return false;
      return year >= startYear && year <= endYear;
    });

    // Sort
    filteredResults = sortResults(filteredResults, sortBy);

    cachedAt = new Date().toISOString();

    // Cache the full filtered list
    cacheSet(cacheKey, {
      results: filteredResults,
      cached_at: cachedAt,
      upstream_pages_fetched: upstreamPagesFetched,
      total_fetched: allResults.length,
    }, 200, 'application/json', TTL_MS);

    res.setHeader('X-Cache', 'MISS');
  }

  // Paginate the filtered results
  const totalResults = filteredResults.length;
  const totalPages = Math.max(1, Math.ceil(totalResults / PAGE_SIZE));
  const startIndex = (page - 1) * PAGE_SIZE;
  const pageResults = filteredResults.slice(startIndex, startIndex + PAGE_SIZE);

  res.setHeader('X-Cache-TTL', `${Math.floor(TTL_MS / 1000)}s`);
  Object.entries(edgeCacheHeaders(TTL_MS)).forEach(([k, v]) => res.setHeader(k, v));

  return res.status(200).json({
    page,
    results: pageResults,
    total_pages: totalPages,
    total_results: totalResults,
    filter: {
      type: 'tv',
      source_endpoint: '/tv/on_the_air',
      date_range: {
        start_year: startYear,
        end_year: endYear,
      },
      field: 'first_air_date',
      upstream_pages_fetched: upstreamPagesFetched,
      sort_by: sortBy,
    },
    cached_at: cachedAt,
    cached_until: new Date(Date.now() + TTL_MS).toISOString(),
  });
}
