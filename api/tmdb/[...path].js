/**
 * Generic TMDB proxy: /api/tmdb/<any-tmdb-path>?<any-tmdb-params>
 *
 * Supports ALL endpoints that mapple.fun exposes:
 *   - /movie/popular, /movie/top_rated, /movie/upcoming, /movie/now_playing
 *   - /tv/popular, /tv/top_rated, /tv/on_the_air, /tv/airing_today
 *   - /movie/{id}, /tv/{id}
 *   - /movie/{id}/credits, /images, /recommendations, /similar, /videos,
 *     /watch/providers, /reviews
 *   - /tv/{id}/credits, /images, /recommendations, /similar, /videos,
 *     /watch/providers, /reviews
 *   - /tv/{id}/season/{n}, /tv/{id}/season/{n}/episode/{n}
 *   - /search/{movie,tv,person,collection,multi,keyword,company}
 *   - /discover/{movie,tv}
 *   - /genre/{movie,tv}/list
 *   - /trending/{movie,tv,person}/{day,week}
 *   - /person/{id}, /person/{id}/movie_credits, /tv_credits, /combined_credits
 *   - /collection/{id}
 *   - /movie/{id}/lists, /tv/{id}/lists
 *   - etc.
 *
 * All query parameters are passed through to TMDB (language, page, query,
 * with_genres, primary_release_date.gte, append_to_response, etc.).
 *
 * Caching: 2-hour TTL, keyed by path + sorted query params.
 *   Different params = different cache entry = fresh fetch.
 */

import { tmdbGet, getStatus } from '../_lib/mapple.js';
import {
  buildCacheKey,
  get as cacheGet,
  set as cacheSet,
  getStats,
  edgeCacheHeaders,
  DEFAULT_TTL_MS,
} from '../_lib/cache.js';

// Max-age override for highly-dynamic endpoints (no cache)
const NO_CACHE_PATHS = [
  /^\/trending\//,
  /^\/movie\/changes/,
  /^\/tv\/changes/,
  /^\/person\/changes/,
  /^\/search\//,
];

// Shorter TTL (10 min) for list endpoints that update frequently
const SHORT_TTL_PATHS = [
  /^\/movie\/popular/,
  /^\/movie\/now_playing/,
  /^\/movie\/upcoming/,
  /^\/tv\/popular/,
  /^\/tv\/on_the_air/,
  /^\/tv\/airing_today/,
];

function getTtlForPath(path) {
  if (NO_CACHE_PATHS.some((re) => re.test(path))) return 0; // no cache
  if (SHORT_TTL_PATHS.some((re) => re.test(path))) return 10 * 60 * 1000; // 10 min
  return DEFAULT_TTL_MS; // 2 hours
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Parse path: Vercel passes the catch-all in req.query.path (array) or req.url
  // We want to extract the part after /api/tmdb/
  let fullPath = req.url || '';
  // Remove /api/tmdb prefix
  let tmdbPath = fullPath.replace(/^\/api\/tmdb/, '');
  // Split path and query
  const qIdx = tmdbPath.indexOf('?');
  let pathPart = qIdx >= 0 ? tmdbPath.slice(0, qIdx) : tmdbPath;
  let queryString = qIdx >= 0 ? tmdbPath.slice(qIdx + 1) : '';
  // Strip leading slash
  pathPart = pathPart.replace(/^\/+/, '');

  if (!pathPart) {
    return res.status(400).json({
      error: 'Missing TMDB path',
      usage: '/api/tmdb/<tmdb-path>?<params>',
      examples: [
        '/api/tmdb/movie/popular?language=en-US&page=1',
        '/api/tmdb/tv/1396?language=en-US',
        '/api/tmdb/search/tv?query=Naruto&language=en-US',
        '/api/tmdb/discover/movie?with_genres=28&primary_release_date.gte=2025-01-01',
      ],
    });
  }

  // Parse query params — use req.query if available (Vercel populates it),
  // otherwise parse the query string ourselves.
  let query = {};
  if (req.query && Object.keys(req.query).length > 0) {
    // Vercel strips the `path` catch-all param; everything else is real
    for (const [k, v] of Object.entries(req.query)) {
      if (k === 'path') continue;
      if (Array.isArray(v)) {
        query[k] = v[0];
      } else {
        query[k] = v;
      }
    }
  }
  // Fallback: parse query string manually if req.query is empty
  if (Object.keys(query).length === 0 && queryString) {
    for (const pair of queryString.split('&')) {
      if (!pair) continue;
      const [k, v] = pair.split('=');
      query[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }

  // Compute cache key
  const cacheKey = buildCacheKey(pathPart, query);
  const ttl = getTtlForPath(pathPart);

  // Check cache (only if TTL > 0)
  if (ttl > 0) {
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Cache-TTL', `${Math.floor((cached.expiresAt - Date.now()) / 1000)}s`);
      res.setHeader('Content-Type', cached.contentType || 'application/json');
      Object.entries(edgeCacheHeaders(ttl)).forEach(([k, v]) => res.setHeader(k, v));
      return res.status(cached.status).json(cached.value);
    }
  }

  // Cache miss — fetch from mapple
  const upstream = await tmdbGet(pathPart, query);

  if (upstream.status >= 500) {
    res.setHeader('X-Cache', 'ERROR');
    return res.status(upstream.status).json(upstream.body);
  }

  // Cache successful responses (and 404s — they're stable)
  if (ttl > 0 && (upstream.status === 200 || upstream.status === 404)) {
    cacheSet(cacheKey, upstream.body, upstream.status,
             upstream.headers.contentType, ttl);
  }

  res.setHeader('X-Cache', 'MISS');
  res.setHeader('X-Cache-TTL', ttl > 0 ? `${Math.floor(ttl / 1000)}s` : '0');
  res.setHeader('Content-Type', upstream.headers.contentType || 'application/json');
  if (ttl > 0) {
    Object.entries(edgeCacheHeaders(ttl)).forEach(([k, v]) => res.setHeader(k, v));
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }
  return res.status(upstream.status).json(upstream.body);
}
