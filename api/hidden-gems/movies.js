/**
 * Hidden Gems Movies: GET /api/hidden-gems/movies
 *
 * Returns PURE hidden-gem movies. NO date-range or airing filter.
 * Searches across all years using /discover/movie.
 *
 * Hidden Gem Definition:
 *   - vote_average >= 7.0
 *   - vote_count >= 50
 *   - popularity <= 50
 *   - include_adult = false
 *
 * Same strategy as hidden-gems/tv: TMDB discover with vote_average.gte,
 * vote_count.gte, include_adult=false, sort_by=popularity.asc. Filter
 * popularity <= 50 client-side, stop early when popularity exceeds threshold.
 *
 * Cache: 12 hours.
 *
 * Query params:
 *   - page (default 1, min 1)
 *   - language (default en-US)
 *   - sort_by (default popularity.asc)
 */

import {
  HIDDEN_GEM,
  MAX_UPSTREAM_PAGES,
  TTL_HIDDEN_GEMS,
  fetchUpstreamPages,
  deduplicateById,
  sortResults,
  paginate,
  getCache,
  setCache,
  makeCacheKey,
  setHeaders,
  handlePreflight,
} from '../_lib/gems-helpers.js';

// Short TTL for EMPTY result sets — prevents "poisoned" empty copies from
// sticking in cache for hours during upstream outages.
const EMPTY_TTL_MS = 5 * 60 * 1000;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;

  const language = req.query?.language || 'en-US';
  const page = Math.max(1, parseInt(req.query?.page || '1', 10));
  const sortBy = req.query?.sort_by || 'popularity.asc';

  const cacheKey = makeCacheKey('hidden-gems/movies', {
    language,
    min_rating: HIDDEN_GEM.MIN_RATING,
    min_vote_count: HIDDEN_GEM.MIN_VOTE_COUNT,
    max_popularity: HIDDEN_GEM.MAX_POPULARITY,
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
    const baseQuery = {
      'vote_average.gte': String(HIDDEN_GEM.MIN_RATING),
      'vote_count.gte': String(HIDDEN_GEM.MIN_VOTE_COUNT),
      include_adult: 'false',
      sort_by: 'popularity.asc',
    };

    const shouldStopEarly = (batchResults) => {
      if (batchResults.length === 0) return false;
      return batchResults.every(
        (item) => (item.popularity || 0) > HIDDEN_GEM.MAX_POPULARITY
      );
    };

    const { results: allResults, pagesFetched: pf } =
      await fetchUpstreamPages('discover/movie', baseQuery, language, shouldStopEarly);
    pagesFetched = pf;

    const deduped = deduplicateById(allResults);

    filteredResults = deduped.filter(
      (item) => (item.popularity || 0) <= HIDDEN_GEM.MAX_POPULARITY
    );

    cachedAt = new Date().toISOString();

    const effTtl = filteredResults.length ? TTL_HIDDEN_GEMS : EMPTY_TTL_MS;
    setCache(cacheKey, {
      results: filteredResults,
      cached_at: cachedAt,
      upstream_pages_fetched: pagesFetched,
      source: 'discover/movie',
    }, effTtl);
  }

  const effTtl = filteredResults.length ? TTL_HIDDEN_GEMS : EMPTY_TTL_MS;

  const sorted = sortResults(filteredResults, sortBy);
  const pageData = paginate(sorted, page);

  setHeaders(res, cacheStatus, effTtl);

  return res.status(200).json({
    ...pageData,
    source: 'discover/movie',
    filters: {
      hidden_gem: {
        min_rating: HIDDEN_GEM.MIN_RATING,
        min_vote_count: HIDDEN_GEM.MIN_VOTE_COUNT,
        max_popularity: HIDDEN_GEM.MAX_POPULARITY,
      },
    },
    upstream_pages_fetched: pagesFetched,
    max_upstream_pages: MAX_UPSTREAM_PAGES,
    cached_at: cachedAt,
    cached_until: new Date(Date.now() + effTtl).toISOString(),
  });
}
