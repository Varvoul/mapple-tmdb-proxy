/**
 * Hidden Gems Movies: /api/gems/movie
 *
 * Returns PURE currently-playing movies released THIS YEAR only.
 * Filters out old movies that linger in /movie/now_playing because they're
 * still in theatres in some regions.
 *
 * How it works:
 *   1. Fetches /movie/now_playing from mapple.fun, pages 1-20 (in parallel
 *      batches of 10).
 *   2. Filters results: keeps only movies where release_date year == current
 *      year. Dynamic — auto-adjusts every Jan 1.
 *   3. Sorts by popularity desc by default. Use ?sort_by=popularity.asc for
 *      true "hidden gems" (least popular but currently playing). Other options:
 *      vote_average.desc, release_date.desc, release_date.asc.
 *   4. Caches the full filtered list for 10 minutes (keyed by year + language
 *      + sort).
 *   5. Returns 20 items per page (TMDB standard).
 *
 * Query params:
 *   - page (default 1)
 *   - language (default en-US)
 *   - sort_by (default popularity.desc)
 *       Options: popularity.desc, popularity.asc, vote_average.desc,
 *                 vote_average.asc, release_date.desc, release_date.asc
 *
 * Response shape:
 *   {
 *     "page": 1,
 *     "results": [...20 items...],
 *     "total_pages": N,
 *     "total_results": M,
 *     "filter": {
 *       "type": "movie",
 *       "source_endpoint": "/movie/now_playing",
 *       "date_range": { "year": 2026 },
 *       "field": "release_date",
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

const TTL_MS = 10 * 60 * 1000;
const MAX_UPSTREAM_PAGES = 20;
const BATCH_SIZE = 10;
const PAGE_SIZE = 20;

async function fetchAllUpstreamPages(language) {
  const allResults = [];
  let upstreamTotalPages = MAX_UPSTREAM_PAGES;

  for (let start = 1; start <= MAX_UPSTREAM_PAGES; start += BATCH_SIZE) {
    const batch = [];
    const end = Math.min(start + BATCH_SIZE - 1, MAX_UPSTREAM_PAGES, upstreamTotalPages);

    for (let p = start; p <= end; p++) {
      batch.push(
        tmdbGet('movie/now_playing', { language, page: String(p) })
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
    if (batchEmpty) break;
  }

  return { results: allResults, upstreamTotalPages };
}

function parseYear(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const m = dateStr.match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

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
    case 'release_date.desc':
      sorted.sort((a, b) => (b.release_date || '').localeCompare(a.release_date || ''));
      break;
    case 'release_date.asc':
      sorted.sort((a, b) => (a.release_date || '').localeCompare(b.release_date || ''));
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

  const language = req.query?.language || 'en-US';
  const page = Math.max(1, parseInt(req.query?.page || '1', 10));
  const sortBy = req.query?.sort_by || 'popularity.desc';

  // Dynamic year: current year only (no past years)
  const currentYear = new Date().getFullYear();

  const cacheKey = buildCacheKey('gems/movie', {
    language,
    year: String(currentYear),
    sort: sortBy,
  });

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
    const { results: allResults, upstreamTotalPages } = await fetchAllUpstreamPages(language);
    upstreamPagesFetched = Math.min(MAX_UPSTREAM_PAGES, upstreamTotalPages);

    // Deduplicate by movie id
    const seen = new Set();
    const deduped = [];
    for (const item of allResults) {
      if (item.id && !seen.has(item.id)) {
        seen.add(item.id);
        deduped.push(item);
      }
    }

    // Filter: release_date year == current year
    filteredResults = deduped.filter((item) => {
      const year = parseYear(item.release_date);
      if (year === null) return false;
      return year === currentYear;
    });

    // Sort
    filteredResults = sortResults(filteredResults, sortBy);

    cachedAt = new Date().toISOString();

    cacheSet(cacheKey, {
      results: filteredResults,
      cached_at: cachedAt,
      upstream_pages_fetched: upstreamPagesFetched,
      total_fetched: allResults.length,
    }, 200, 'application/json', TTL_MS);

    res.setHeader('X-Cache', 'MISS');
  }

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
      type: 'movie',
      source_endpoint: '/movie/now_playing',
      date_range: {
        year: currentYear,
      },
      field: 'release_date',
      upstream_pages_fetched: upstreamPagesFetched,
      sort_by: sortBy,
    },
    cached_at: cachedAt,
    cached_until: new Date(Date.now() + TTL_MS).toISOString(),
  });
}
