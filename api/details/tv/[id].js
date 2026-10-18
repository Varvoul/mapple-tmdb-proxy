/**
 * Combined TV details: /api/details/tv/{tmdb_id}
 *
 * Returns EVERYTHING for a single TV show in one response:
 *   - metadata (name, overview, genres, networks, etc.)
 *   - cast_crew (cast + crew from credits)
 *   - pictures (backdrops, posters, logos)
 *   - seasons (full seasons array — TV only)
 *   - external_ids (note: mapple doesn't expose /tv/{id}/external_ids as a
 *     standalone endpoint; we extract what's available from core response)
 *   - statistics (vote_average, vote_count, popularity, number_of_seasons,
 *     number_of_episodes, status, first_air_date, last_air_date)
 *   - keywords, videos, reviews, translations
 *
 * All wrapped under a `data` object. Caches for 2 hours.
 *
 * Mapple's /tv/{id} endpoint returns most sub-resources inline by default
 * (credits, images, keywords, videos, reviews, translations) — so we make ONE
 * upstream call and re-shape the response for the caller.
 *
 * Optional query params:
 *   - language (default en-US)
 *   - include_image_language (default en,null)
 *   - expand_seasons (default false) — if true, fetch each season's full
 *     details (including episodes) in parallel. Adds latency but returns
 *     richer season data.
 */

import { tmdbGet } from '../../_lib/mapple.js';
import {
  buildCacheKey,
  get as cacheGet,
  set as cacheSet,
  edgeCacheHeaders,
} from '../../_lib/cache.js';

const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Extract TV ID from URL
  const match = (req.url || '').match(/^\/api\/details\/tv\/([^/?]+)/);
  const tvId = match ? decodeURIComponent(match[1]) : (req.query?.id);

  if (!tvId || !/^\d+$/.test(tvId)) {
    return res.status(400).json({
      error: 'Invalid TV ID. Must be a numeric TMDB TV ID.',
      usage: '/api/details/tv/{tmdb_id}?language=en-US',
    });
  }

  const language = (req.query?.language) || 'en-US';
  const includeImageLanguage = (req.query?.include_image_language) || 'en,null';
  const expandSeasons = req.query?.expand_seasons === 'true' ||
                        req.query?.expand_seasons === '1';
  const query = { language, include_image_language: includeImageLanguage };

  // Cache key — includes TV ID + all params (including expand_seasons flag)
  const cacheKey = buildCacheKey(`details/tv/${tvId}`, {
    ...query,
    expand_seasons: expandSeasons ? '1' : '0',
  });
  const cached = cacheGet(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('X-Cache-TTL', `${Math.floor((cached.expiresAt - Date.now()) / 1000)}s`);
    Object.entries(edgeCacheHeaders(TTL_MS)).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(cached.status).json(cached.value);
  }

  // Fetch from mapple — single call returns core + credits + images + keywords
  // + videos + reviews + translations + seasons inline
  const upstream = await tmdbGet(`tv/${tvId}`, query);

  if (upstream.status !== 200) {
    res.setHeader('X-Cache', 'ERROR');
    return res.status(upstream.status).json({
      error: 'Failed to fetch TV details',
      status: upstream.status,
      upstream: upstream.body,
    });
  }

  const t = upstream.body;

  // Optionally expand each season with full episode lists
  let seasonsExpanded = t.seasons || [];
  if (expandSeasons && seasonsExpanded.length > 0) {
    // Fetch all seasons in parallel (mapple rate-limits, so cap at 5 at a time)
    const chunks = [];
    for (let i = 0; i < seasonsExpanded.length; i += 5) {
      chunks.push(seasonsExpanded.slice(i, i + 5));
    }
    seasonsExpanded = [];
    for (const chunk of chunks) {
      const results = await Promise.all(
        chunk.map((s) =>
          tmdbGet(`tv/${tvId}/season/${s.season_number}`, { language })
            .then((r) => (r.status === 200 ? r.body : s))
            .catch(() => s)
        )
      );
      seasonsExpanded.push(...results);
    }
  }

  // Re-shape into combined response
  const combined = {
    id: t.id,
    type: 'tv',
    cached_at: new Date().toISOString(),
    cached_until: new Date(Date.now() + TTL_MS).toISOString(),
    source: 'mapple.fun -> TMDB',
    data: {
      // Core metadata
      metadata: {
        id: t.id,
        name: t.name,
        original_name: t.original_name,
        original_language: t.original_language,
        tagline: t.tagline,
        overview: t.overview,
        type: t.type,
        status: t.status,
        in_production: t.in_production,
        first_air_date: t.first_air_date,
        last_air_date: t.last_air_date,
        last_episode_to_air: t.last_episode_to_air || null,
        next_episode_to_air: t.next_episode_to_air || null,
        genres: t.genres || [],
        homepage: t.homepage,
        adult: t.adult,
        backdrop_path: t.backdrop_path,
        poster_path: t.poster_path,
        networks: t.networks || [],
        production_companies: t.production_companies || [],
        production_countries: t.production_countries || [],
        spoken_languages: t.spoken_languages || [],
        languages: t.languages || [],
        origin_country: t.origin_country || [],
        created_by: t.created_by || [],
        episode_run_time: t.episode_run_time || [],
      },

      // Cast & crew
      cast_crew: {
        cast: (t.credits?.cast) || [],
        crew: (t.credits?.crew) || [],
      },

      // Pictures
      pictures: {
        backdrops: (t.images?.backdrops) || [],
        posters: (t.images?.posters) || [],
        logos: (t.images?.logos) || [],
      },

      // Seasons (TV only) — full seasons array, optionally expanded with episodes
      seasons: seasonsExpanded.map((s) => ({
        id: s.id,
        season_number: s.season_number,
        name: s.name,
        overview: s.overview,
        air_date: s.air_date,
        episode_count: s.episode_count,
        poster_path: s.poster_path,
        ...(s.episodes ? { episodes: s.episodes } : {}),
      })),

      // External IDs — mapple doesn't expose /tv/{id}/external_ids standalone,
      // but some shows include tvdb_id/imdb_id in the core response
      external_ids: t.external_ids || {
        imdb_id: t.imdb_id || null,
        tvdb_id: t.tvdb_id || null,
        facebook_id: t.facebook_id || null,
        instagram_id: t.instagram_id || null,
        twitter_id: t.twitter_id || null,
      },

      // Statistics
      statistics: {
        vote_average: t.vote_average,
        vote_count: t.vote_count,
        popularity: t.popularity,
        status: t.status,
        type: t.type,
        number_of_seasons: t.number_of_seasons,
        number_of_episodes: t.number_of_episodes,
        first_air_date: t.first_air_date,
        last_air_date: t.last_air_date,
        in_production: t.in_production,
      },

      // Keywords
      keywords: (t.keywords?.results) || (t.keywords?.keywords) || [],

      // Videos
      videos: (t.videos?.results) || [],

      // Reviews
      reviews: (t.reviews?.results) || [],

      // Translations
      translations: (t.translations?.translations) || [],
    },
  };

  cacheSet(cacheKey, combined, 200, 'application/json', TTL_MS);

  res.setHeader('X-Cache', 'MISS');
  res.setHeader('X-Cache-TTL', `${Math.floor(TTL_MS / 1000)}s`);
  Object.entries(edgeCacheHeaders(TTL_MS)).forEach(([k, v]) => res.setHeader(k, v));
  return res.status(200).json(combined);
}
