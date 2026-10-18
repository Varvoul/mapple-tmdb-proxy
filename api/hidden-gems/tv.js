/**
 * Hidden Gems TV: GET /api/hidden-gems/tv
 *
 * Returns PURE hidden-gem TV shows. NO date-range or airing-status filter.
 * Searches across all years using /discover/tv.
 *
 * Hidden Gem Definition:
 *   - vote_average >= 7.0
 *   - vote_count >= 50
 *   - popularity <= 50
 *   - include_adult = false
 *
 * TMDB discover supports vote_average.gte, vote_count.gte, include_adult
 * natively. Popularity.lte is NOT a TMDB filter, so we filter popularity
 * client-side. We sort by popularity.asc at TMDB level so low-popularity
 * items come first, and we can stop scanning early once popularity > 50.
 *
 * Cache: 12 hours. Keyed by language + filter config.
 *
 * Query params:
 *   - page (default 1, min 1)
 *   - language (default en-US)
 *   - sort_by (default popularity.asc — true hidden gems first)
 *
 * Response shape:
 *   {
 *     "page": 1,
 *     "per_page": 20,
 *     "total_pages": 5,
 *     "total_results": 92,
 *     "current_page": 1,
 *     "last_visible_page": 5,
 *     "has_next_page": true,
 *     "source": "discover/tv",
 *     "filters": {
 *       "hidden_gem": {
 *         "min_rating": 7.0,
 *         "min_vote_count": 50,
 *         "max_popularity": 50
 *       }
 *     },
 *     "cached_at": "...",
 *     "cached_until": "...",
 *     "results": [...20 items...]
 *   }
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

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;

  const language = req.query?.language || 'en-US';
  const page = Math.max(1, parseInt(req.query?.page || '1', 10));
  const sortBy = req.query?.sort_by || 'popularity.asc';

  // Cache key: feature + language + filter config (sort doesn't change the
  // filtered set, only ordering — so we sort client-side from the cached list)
  const cacheKey = makeCacheKey('hidden-gems/tv', {
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
    // Build TMDB discover query — apply server-side filters at TMDB level
    // Sort by popularity.asc so low-popularity items come first.
    // We stop early once we see popularity > MAX_POPULARITY.
    const baseQuery = {
      'vote_average.gte': String(HIDDEN_GEM.MIN_RATING),
      'vote_count.gte': String(HIDDEN_GEM.MIN_VOTE_COUNT),
      include_adult: 'false',
      sort_by: 'popularity.asc',
    };

    const shouldStopEarly = (batchResults) => {
      // If ALL items in this batch have popularity > MAX_POPULARITY, stop
      // (since sorted ascending, all subsequent will also be too high)
      if (batchResults.length === 0) return false;
      return batchResults.every(
        (item) => (item.popularity || 0) > HIDDEN_GEM.MAX_POPULARITY
      );
    };

    const { results: allResults, pagesFetched: pf } =
      await fetchUpstreamPages('discover/tv', baseQuery, language, shouldStopEarly);
    pagesFetched = pf;

    // Deduplicate
    const deduped = deduplicateById(allResults);

    // Client-side filter: popularity <= MAX_POPULARITY
    // (vote_average and vote_count already filtered at TMDB level)
    filteredResults = deduped.filter(
      (item) => (item.popularity || 0) <= HIDDEN_GEM.MAX_POPULARITY
    );

    cachedAt = new Date().toISOString();

    // Cache the full filtered list (unsorted — sort happens at request time)
    setCache(cacheKey, {
      results: filteredResults,
      cached_at: cachedAt,
      upstream_pages_fetched: pagesFetched,
      source: 'discover/tv',
    }, TTL_HIDDEN_GEMS);
  }

  // Sort the cached list according to the requested sort
  const sorted = sortResults(filteredResults, sortBy);

  // Paginate
  const pageData = paginate(sorted, page);

  setHeaders(res, cacheStatus, TTL_HIDDEN_GEMS);

  return res.status(200).json({
    ...pageData,
    source: 'discover/tv',
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
    cached_until: new Date(Date.now() + TTL_HIDDEN_GEMS).toISOString(),
  });
}
