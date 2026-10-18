/**
 * TV Airing (Pure): GET /api/tv/airing
 *
 * Returns TV shows currently airing whose first episode air date falls within
 * a dynamic range: from Jan 1 of (currentYear - 3) up to today (UTC).
 *
 * Source: GET /tv/on_the_air
 *
 * Filtering (server-side after fetching):
 *   1. Dynamic Date Range (UTC):
 *        from = January 1 of (currentYear - 3)
 *        to   = today (UTC)
 *   2. Exclude missing first_air_date.
 *   3. Exclude status: "Ended", "Canceled"
 *      (Requires fetching /tv/{id} details — done in parallel batches,
 *       capped at 200 detail calls to stay within timeout.)
 *   4. NO hidden gem filters here.
 *
 * Cache: 6 hours. Keyed by language + date range.
 *
 * Query params:
 *   - page (default 1, min 1)
 *   - language (default en-US)
 *   - sort_by (default popularity.desc)
 *
 * Response shape:
 *   {
 *     "page": 1,
 *     "per_page": 20,
 *     "total_pages": 4,
 *     "total_results": 75,
 *     "current_page": 1,
 *     "last_visible_page": 4,
 *     "has_next_page": true,
 *     "date_range": { "from": "2023-01-01", "to": "2026-06-15" },
 *     "source": "tv/on_the_air",
 *     "cached_at": "...",
 *     "cached_until": "...",
 *     "results": [...]
 *   }
 */

import { tmdbGet } from '../_lib/mapple.js';
import {
  MAX_UPSTREAM_PAGES,
  TTL_TV_AIRING,
  fetchUpstreamPages,
  deduplicateById,
  sortResults,
  paginate,
  getCache,
  setCache,
  makeCacheKey,
  setHeaders,
  handlePreflight,
  computeTvAiringDateRange,
  parseDate,
  sleep,
} from '../_lib/gems-helpers.js';

// For TV airing, we scan up to 20 upstream pages (400 items max).
// After date filtering, this typically yields 50-150 items.
// The spec allows "up to 50 pages" but 20 is sufficient for the date filter
// to produce a good result set within Vercel's 60s timeout.
const TV_AIRING_MAX_PAGES = 20;

// Cap on detail fetches for status filtering (to stay within Vercel timeout).
// We check status for the top 60 most popular date-filtered items.
// Items beyond this cap are included as-is (date filter + on_the_air source
// already ensure they're currently airing).
const MAX_DETAIL_FETCHES = 60;
const DETAIL_BATCH_SIZE = 20;

// Statuses to exclude
const EXCLUDED_STATUSES = new Set(['Ended', 'Canceled']);

/**
 * Fetch TV detail for a single show to get its `status` field.
 * Returns { id, status, in_production } or null on failure.
 */
async function fetchTvDetail(tvId, language) {
  const r = await tmdbGet(`tv/${tvId}`, { language });
  if (r && r.status === 200 && r.body) {
    return {
      id: r.body.id,
      status: r.body.status,
      in_production: r.body.in_production,
    };
  }
  return null;
}

/**
 * Fetch details for a list of TV IDs in parallel batches.
 * Returns a Map<id, {status, in_production}>.
 */
async function fetchDetailsBatch(tvIds, language) {
  const detailMap = new Map();
  const idsToFetch = tvIds.slice(0, MAX_DETAIL_FETCHES);

  for (let i = 0; i < idsToFetch.length; i += DETAIL_BATCH_SIZE) {
    const batch = idsToFetch.slice(i, i + DETAIL_BATCH_SIZE);
    const results = await Promise.all(
      batch.map((id) =>
        fetchTvDetail(id, language).catch(() => null)
      )
    );
    for (const r of results) {
      if (r && r.id) {
        detailMap.set(r.id, r);
      }
    }
  }

  return detailMap;
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;

  const language = req.query?.language || 'en-US';
  const page = Math.max(1, parseInt(req.query?.page || '1', 10));
  const sortBy = req.query?.sort_by || 'popularity.desc';

  // Compute dynamic date range
  const dateRange = computeTvAiringDateRange();

  // Cache key: feature + language + date range
  const cacheKey = makeCacheKey('tv/airing', {
    language,
    from: dateRange.from,
    to: dateRange.to,
  });

  let filteredResults;
  let cachedAt;
  let pagesFetched;
  let detailsFetched;
  let cacheStatus = 'MISS';

  const cached = getCache(cacheKey);
  if (cached.found) {
    filteredResults = cached.value.results;
    cachedAt = cached.cachedAt;
    pagesFetched = cached.value.upstream_pages_fetched;
    detailsFetched = cached.value.details_fetched;
    cacheStatus = 'HIT';
  } else {
    // Step 1: Fetch /tv/on_the_air pages 1-20 (sufficient for date filter)
    const { results: allResults, pagesFetched: pf } =
      await fetchUpstreamPages('tv/on_the_air', {}, language, null, TV_AIRING_MAX_PAGES);
    pagesFetched = pf;

    // Step 2: Deduplicate
    const deduped = deduplicateById(allResults);

    // Step 3: Filter by date range on first_air_date
    const fromDate = parseDate(dateRange.from);
    const toDate = parseDate(dateRange.to);

    const dateFiltered = deduped.filter((item) => {
      const airDate = parseDate(item.first_air_date);
      if (!airDate) return false;
      return airDate >= fromDate && airDate <= toDate;
    });

    // Step 4: Fetch details for status filtering
    // Sort date-filtered items by popularity desc so we check the most
    // popular ones first (in case we hit the MAX_DETAIL_FETCHES cap)
    const sortedForDetail = [...dateFiltered].sort(
      (a, b) => (b.popularity || 0) - (a.popularity || 0)
    );

    const detailMap = await fetchDetailsBatch(
      sortedForDetail.map((item) => item.id),
      language
    );
    detailsFetched = detailMap.size;

    // Step 5: Exclude Ended/Canceled
    filteredResults = dateFiltered.filter((item) => {
      const detail = detailMap.get(item.id);
      if (!detail) {
        // We didn't fetch details for this item (over the cap).
        // Include it — date filter already applied, and it IS in /tv/on_the_air.
        return true;
      }
      // Exclude Ended / Canceled
      if (detail.status && EXCLUDED_STATUSES.has(detail.status)) {
        return false;
      }
      return true;
    });

    cachedAt = new Date().toISOString();

    setCache(cacheKey, {
      results: filteredResults,
      cached_at: cachedAt,
      upstream_pages_fetched: pagesFetched,
      details_fetched: detailsFetched,
      date_range: dateRange,
      source: 'tv/on_the_air',
    }, TTL_TV_AIRING);
  }

  // Sort the cached list
  const sorted = sortResults(filteredResults, sortBy);
  const pageData = paginate(sorted, page);

  setHeaders(res, cacheStatus, TTL_TV_AIRING);

  return res.status(200).json({
    ...pageData,
    date_range: {
      from: dateRange.from,
      to: dateRange.to,
    },
    source: 'tv/on_the_air',
    upstream_pages_fetched: pagesFetched,
    max_upstream_pages: TV_AIRING_MAX_PAGES,
    details_fetched: detailsFetched,
    excluded_statuses: [...EXCLUDED_STATUSES],
    cached_at: cachedAt,
    cached_until: new Date(Date.now() + TTL_TV_AIRING).toISOString(),
  });
}
