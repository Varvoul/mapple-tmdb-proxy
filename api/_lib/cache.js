/**
 * In-memory TTL cache for Vercel serverless functions.
 *
 * - Cache key = path + sorted query string. Different params = different
 *   cache entry = fresh fetch from upstream.
 * - TTL: 2 hours by default (configurable).
 * - Survives across warm invocations within the same serverless instance.
 *   Cold starts start with an empty cache.
 * - Also exposes a helper to set Cache-Control headers so Vercel's edge
 *   network caches responses too (s-maxage=7200).
 */

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const _cache = new Map(); // key -> { value, expiresAt, status, contentType }
const _stats = { hits: 0, misses: 0, sets: 0, evictions: 0 };

/**
 * Build a normalized cache key from path + query.
 * Sorts query params so {a:1,b:2} and {b:2,a:1} produce the same key.
 */
function buildCacheKey(path, query) {
  let qs = '';
  if (query && typeof query === 'object') {
    const entries = Object.entries(query)
      .filter(([_, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)]);
    entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  }
  return `${path}?${qs}`;
}

/**
 * Get a cached entry. Returns null if not found or expired.
 * Side effect: evicts expired entries.
 */
function get(key) {
  const entry = _cache.get(key);
  if (!entry) {
    _stats.misses++;
    return null;
  }
  if (Date.now() >= entry.expiresAt) {
    _cache.delete(key);
    _stats.evictions++;
    _stats.misses++;
    return null;
  }
  _stats.hits++;
  return entry;
}

/**
 * Store an entry in the cache with a TTL.
 */
function set(key, value, status, contentType, ttlMs = DEFAULT_TTL_MS) {
  // Cap cache size to prevent memory bloat (1000 entries)
  if (_cache.size >= 1000) {
    // Evict oldest 100 entries
    const keys = [..._cache.keys()].slice(0, 100);
    for (const k of keys) _cache.delete(k);
    _stats.evictions += keys.length;
  }
  _cache.set(key, {
    value,
    status,
    contentType,
    expiresAt: Date.now() + ttlMs,
    cachedAt: Date.now(),
  });
  _stats.sets++;
}

/**
 * Invalidate a specific cache entry.
 */
function invalidate(key) {
  return _cache.delete(key);
}

/**
 * Clear the entire cache.
 */
function clear() {
  const size = _cache.size;
  _cache.clear();
  return size;
}

/**
 * Get cache stats.
 */
function getStats() {
  let totalSize = 0;
  for (const entry of _cache.values()) {
    try {
      totalSize += JSON.stringify(entry.value).length;
    } catch (_) {}
  }
  return {
    ..._stats,
    size: _cache.size,
    approxSizeBytes: totalSize,
    ttlMs: DEFAULT_TTL_MS,
  };
}

/**
 * Compute the Cache-Control header value for Vercel edge caching.
 * Uses s-maxage so the browser doesn't cache (stale data UX) but Vercel's
 * edge network does for 2h. stale-while-revalidate keeps serving cached
 * content while refreshing in the background.
 */
function edgeCacheHeaders(ttlMs = DEFAULT_TTL_MS) {
  const seconds = Math.floor(ttlMs / 1000);
  return {
    'Cache-Control': `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=${seconds * 2}`,
  };
}

export {
  buildCacheKey,
  get,
  set,
  invalidate,
  clear,
  getStats,
  edgeCacheHeaders,
  DEFAULT_TTL_MS,
};
