/**
 * Movies Current-Year: GET /api/movies/current-year
 *
 * Returns movies released in the current year only (UTC). No past years.
 *
 * Source: GET /movie/now_playing
 *
 * Filtering:
 *   - Dynamic date range (UTC):
 *       from = January 1 of currentYear
 *       to   = today (UTC)
 *   - Filter by release_date within that range.
 *   - No hidden-gem filter. No airing filter.
 *
 * Cache: 12 hours. Keyed by language + date range.
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
 *     "total_pages": 3,
 *     "total_results": 52,
 *     "current_page": 1,
 *     "last_visible_page": 3,
 *     "has_next_page": true,
 *     "date_range": { "from": "2026-01-01", "to": "2026-06-15" },
 *     "source": "movie/now_playing",
 *     "cached_at": "...",
 *     "cached_until": "...",
 *     "results": [...]
 *   }
 */

import {
  MAX_UPSTREAM_PAGES,
  TTL_MOVIES_CURRENT_YEAR,
  fetchUpstreamPages,
  deduplicateById,
  sortResults,
  paginate,
  getCache,
  setCache,
  makeCacheKey,
  setHeaders,
  handlePreflight,
  computeMovieCurrentYearDateRange,
  parseDate,
} from '../_lib/gems-helpers.js';

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;

  const language = req.query?.language || 'en-US';
  const page = Math.max(1, parseInt(req.query?.page || '1', 10));
  const sortBy = req.query?.sort_by || 'popularity.desc';

  // Compute dynamic date range
  const dateRange = computeMovieCurrentYearDateRange();

  // Cache key: feature + language + date range
  const cacheKey = makeCacheKey('movies/current-year', {
    language,
    from: dateRange.from,
    to: dateRange.to,
  });

  let filteredResults;
  let cachedAt;
  let pagesFetched;
  let cacheStatus = 'MISS';

  const cached = getCache(cacheKey);
  if (cached.found) {
    filteredResults = cached.value.results;
    cachedAt = cached.cachedAt;
    pagesFetched = cached.value.upstream_pages_fetched;
    cacheStatus = 'HIT';
  } else {
    // Fetch /movie/now_playing pages 1-50
    const { results: allResults, pagesFetched: pf } =
      await fetchUpstreamPages('movie/now_playing', {}, language);
    pagesFetched = pf;

    // Deduplicate
    const deduped = deduplicateById(allResults);

    // Filter by date range on release_date
    const fromDate = parseDate(dateRange.from);
    const toDate = parseDate(dateRange.to);

    filteredResults = deduped.filter((item) => {
      const releaseDate = parseDate(item.release_date);
      if (!releaseDate) return false;
      return releaseDate >= fromDate && releaseDate <= toDate;
    });

    cachedAt = new Date().toISOString();

    setCache(cacheKey, {
      results: filteredResults,
      cached_at: cachedAt,
      upstream_pages_fetched: pagesFetched,
      date_range: dateRange,
      source: 'movie/now_playing',
    }, TTL_MOVIES_CURRENT_YEAR);
  }

  // Sort and paginate
  const sorted = sortResults(filteredResults, sortBy);
  const pageData = paginate(sorted, page);

  setHeaders(res, cacheStatus, TTL_MOVIES_CURRENT_YEAR);

  return res.status(200).json({
    ...pageData,
    date_range: {
      from: dateRange.from,
      to: dateRange.to,
    },
    source: 'movie/now_playing',
    upstream_pages_fetched: pagesFetched,
    max_upstream_pages: MAX_UPSTREAM_PAGES,
    cached_at: cachedAt,
    cached_until: new Date(Date.now() + TTL_MOVIES_CURRENT_YEAR).toISOString(),
  });
}
