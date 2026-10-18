/**
 * Health check: /api/health
 *
 * Returns the current mapple domain, auth status, and cache stats.
 * Useful for debugging and monitoring.
 */

import { getStatus, discoverDomain, refreshRequestToken } from './_lib/mapple.js';
import { directEnabled } from './_lib/tmdb-direct.js';
import { getStats } from './_lib/cache.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Force re-discovery if requested
  const forceRediscover = req.query?.refresh === 'true' || req.query?.refresh === '1';
  if (forceRediscover) {
    try {
      await refreshRequestToken();
    } catch (e) {
      // ignore — we still return status
    }
  }

  const status = getStatus();
  const cacheStats = getStats();

  // If no domain yet, try to discover one
  let domain = status.currentDomain;
  if (!domain) {
    try {
      domain = await discoverDomain();
    } catch (e) {
      // ignore
    }
  }

  return res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    providers: {
      serving_order: directEnabled() ? ['mapple', 'tmdb-direct'] : ['mapple'],
      tmdb_direct: {
        enabled: directEnabled(),
        env_var: 'TMDB_BEARER',
        note: 'Fallback tier — serves TMDB data directly when the mapple scrape tier is unavailable (e.g. Cloudflare bot-challenge on upstream).',
      },
    },
    mapple: {
      current_domain: domain,
      has_cookie: status.hasCookie,
      has_key: status.hasKey,
      key_expires_in_seconds: status.keyExpiresIn !== null
        ? Math.floor(status.keyExpiresIn / 1000)
        : null,
      last_discovery_at: status.lastDiscoveryAt
        ? new Date(status.lastDiscoveryAt).toISOString()
        : null,
      last_error: status.lastError || null,
      known_domains: status.knownDomains,
    },
    cache: cacheStats,
    endpoints: {
      generic_proxy: '/api/tmdb/<path>?<params>',
      movie_details: '/api/details/movie/{tmdb_id}',
      tv_details: '/api/details/tv/{tmdb_id}',
      hidden_gems_tv: '/api/hidden-gems/tv (high-rated, low-popularity TV — all years)',
      hidden_gems_movies: '/api/hidden-gems/movies (high-rated, low-popularity movies — all years)',
      tv_airing: '/api/tv/airing (pure airing TV from last 3 years, excludes Ended/Canceled)',
      movies_current_year: '/api/movies/current-year (current-year movies only)',
      health: '/api/health',
    },
  });
}
