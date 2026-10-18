/**
 * Combined movie details: /api/details/movie/{tmdb_id}
 *
 * Returns EVERYTHING for a single movie in one response:
 *   - metadata (title, overview, genres, runtime, etc.)
 *   - cast_crew (cast + crew from credits)
 *   - pictures (backdrops, posters, logos)
 *   - external_ids (imdb_id, facebook_id, etc.)
 *   - statistics (vote_average, vote_count, popularity, budget, revenue, status)
 *   - recommendations, similar, videos, watch_providers, release_dates, keywords
 *
 * All wrapped under a `data` object. Caches for 2 hours.
 *
 * Mapple's /movie/{id} endpoint returns most sub-resources inline by default
 * (credits, images, external_ids, keywords, recommendations, similar, videos,
 * watch/providers, release_dates, reviews, translations) — so we make ONE
 * upstream call and re-shape the response for the caller.
 *
 * Optional query params:
 *   - language (default en-US)
 *   - include_image_language (default en,null — English + no-language images)
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

  // Extract movie ID from URL: /api/details/movie/{id}
  const match = (req.url || '').match(/^\/api\/details\/movie\/([^/?]+)/);
  const movieId = match ? decodeURIComponent(match[1]) : (req.query?.id);

  if (!movieId || !/^\d+$/.test(movieId)) {
    return res.status(400).json({
      error: 'Invalid movie ID. Must be a numeric TMDB movie ID.',
      usage: '/api/details/movie/{tmdb_id}?language=en-US',
    });
  }

  // Build query params
  const language = (req.query?.language) || 'en-US';
  const includeImageLanguage = (req.query?.include_image_language) || 'en,null';
  const query = { language, include_image_language: includeImageLanguage };

  // Cache key — includes movie ID + all params
  const cacheKey = buildCacheKey(`details/movie/${movieId}`, query);
  const cached = cacheGet(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('X-Cache-TTL', `${Math.floor((cached.expiresAt - Date.now()) / 1000)}s`);
    Object.entries(edgeCacheHeaders(TTL_MS)).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(cached.status).json(cached.value);
  }

  // Fetch from mapple — single call returns everything inline
  const upstream = await tmdbGet(`movie/${movieId}`, query);

  if (upstream.status !== 200) {
    res.setHeader('X-Cache', 'ERROR');
    return res.status(upstream.status).json({
      error: 'Failed to fetch movie details',
      status: upstream.status,
      upstream: upstream.body,
    });
  }

  const m = upstream.body;

  // Re-shape into the requested combined response
  const combined = {
    id: m.id,
    type: 'movie',
    cached_at: new Date().toISOString(),
    cached_until: new Date(Date.now() + TTL_MS).toISOString(),
    source: 'mapple.fun -> TMDB',
    data: {
      // Core metadata
      metadata: {
        id: m.id,
        title: m.title,
        original_title: m.original_title,
        original_language: m.original_language,
        tagline: m.tagline,
        overview: m.overview,
        release_date: m.release_date,
        runtime: m.runtime,
        genres: m.genres || [],
        homepage: m.homepage,
        status: m.status,
        adult: m.adult,
        backdrop_path: m.backdrop_path,
        poster_path: m.poster_path,
        belongs_to_collection: m.belongs_to_collection || null,
        production_companies: m.production_companies || [],
        production_countries: m.production_countries || [],
        spoken_languages: m.spoken_languages || [],
        origin_country: m.origin_country || [],
        alternative_titles: m.alternative_titles || null,
      },

      // Cast & crew
      cast_crew: {
        cast: (m.credits?.cast) || [],
        crew: (m.credits?.crew) || [],
      },

      // Pictures (backdrops, posters, logos)
      pictures: {
        backdrops: (m.images?.backdrops) || [],
        posters: (m.images?.posters) || [],
        logos: (m.images?.logos) || [],
      },

      // External IDs
      external_ids: m.external_ids || {
        imdb_id: m.imdb_id || null,
        facebook_id: null,
        instagram_id: null,
        twitter_id: null,
      },

      // Statistics
      statistics: {
        vote_average: m.vote_average,
        vote_count: m.vote_count,
        popularity: m.popularity,
        budget: m.budget,
        revenue: m.revenue,
        status: m.status,
        runtime: m.runtime,
        release_date: m.release_date,
      },

      // Related content
      recommendations: (m.recommendations?.results) || [],
      similar: (m.similar?.results) || [],

      // Videos (trailers, teasers)
      videos: (m.videos?.results) || [],

      // Watch providers by country
      watch_providers: m['watch/providers']?.results || {},

      // Release dates by country
      release_dates: (m.release_dates?.results) || [],

      // Keywords / tags
      keywords: (m.keywords?.keywords) || [],

      // Reviews
      reviews: (m.reviews?.results) || [],

      // Translations
      translations: (m.translations?.translations) || [],
    },
  };

  // Cache it
  cacheSet(cacheKey, combined, 200, 'application/json', TTL_MS);

  res.setHeader('X-Cache', 'MISS');
  res.setHeader('X-Cache-TTL', `${Math.floor(TTL_MS / 1000)}s`);
  Object.entries(edgeCacheHeaders(TTL_MS)).forEach(([k, v]) => res.setHeader(k, v));
  return res.status(200).json(combined);
}
