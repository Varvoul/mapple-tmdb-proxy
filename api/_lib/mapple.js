/**
 * Mapple.fun auth + auto-domain discovery module.
 *
 * The mapple project periodically rotates its public domain (mapplee.com,
 * mapple.fun, mapple.rip, mapple.bid, mapple.uk, mapple.club, mappletv.uk).
 *
 * This module:
 *   1. Maintains a list of known mapple domains.
 *   2. Bootstraps the "current" domain by hitting mapplee.com (which 301-redirects
 *      to whatever the active domain is this week).
 *   3. Caches the working domain + auth cookies + TMDB key in module-level
 *      variables that survive across warm serverless invocations.
 *   4. On auth failure (401), force-refreshes the key — and if that fails too,
 *      re-discovers the current domain from scratch.
 */

// Known bootstrap domains. mapplee.com is canonical and 301-redirects to the
// current active domain. The others are historical fallbacks (from the CSP
// `frame-ancestors` directive we observed in the response headers).
const BOOTSTRAP_DOMAINS = [
  'mapplee.com', // canonical — always 301s to current
  'mapple.fun',  // current as of Oct 2026
  'mapple.rip',
  'mapple.bid',
  'mapple.uk',
  'mapple.club',
  'mappletv.uk',
];

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Ch-Ua': '"Not.A/Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Linux"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

// Module-level state — survives across warm invocations within the same
// serverless instance. Cold starts will re-bootstrap.
let _currentDomain = null;
let _cookieHeader = '';
let _tmdbKey = null;
let _tmdbKeyExpiresAt = 0;
let _lastDiscoveryAt = 0;
let _discoveryPromise = null;

const DISCOVERY_COOLDOWN_MS = 60_000; // don't re-discover more than once/min
const KEY_BUFFER_MS = 30_000;          // refresh key 30s before expiry

/**
 * Discover the current mapple domain by hitting mapplee.com (which 301s).
 * Returns the active domain string (e.g. "mapple.fun") or null on failure.
 */
async function discoverDomain() {
  const now = Date.now();
  if (_currentDomain && now - _lastDiscoveryAt < DISCOVERY_COOLDOWN_MS) {
    return _currentDomain;
  }
  if (_discoveryPromise) return _discoveryPromise;

  _discoveryPromise = (async () => {
    try {
      // mapplee.com is the canonical redirect source. Follow redirects to
      // find the current active domain.
      for (const bootstrap of BOOTSTRAP_DOMAINS) {
        try {
          const res = await fetch(`https://${bootstrap}/api/request-token`, {
            method: 'POST',
            redirect: 'follow',
            headers: {
              ...BROWSER_HEADERS,
              'Content-Type': 'application/json',
              Origin: `https://${bootstrap}`,
              Referer: `https://${bootstrap}/`,
            },
          });
          if (!res.ok) continue;

          // res.url is the final URL after following redirects
          const finalUrl = new URL(res.url);
          const finalDomain = finalUrl.hostname;

          // Extract cookies from the response
          const setCookies = extractSetCookies(res.headers);
          const cookieStr = setCookies.map((c) => c.split(';')[0]).join('; ');

          _currentDomain = finalDomain;
          _cookieHeader = cookieStr;
          _lastDiscoveryAt = now;

          // Also try to parse the token response — but we mostly care about
          // the cookie + domain here, since /api/tmdb-key will give us the
          // actual API key.
          try {
            await res.json();
          } catch (_) {}

          console.log(`[mapple] Discovered current domain: ${finalDomain}`);
          return _currentDomain;
        } catch (e) {
          console.log(`[mapple] Bootstrap ${bootstrap} failed: ${e.message}`);
          continue;
        }
      }
    } finally {
      _discoveryPromise = null;
    }
    return null;
  })();

  return _discoveryPromise;
}

/**
 * Extract Set-Cookie headers from a Response. Node 20+ supports
 * headers.getSetCookie(); older runtimes need manual parsing.
 */
function extractSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') {
    const arr = headers.getSetCookie();
    if (Array.isArray(arr) && arr.length) return arr;
  }
  // Manual fallback — getSetCookie may not be available
  const raw = headers.get('set-cookie');
  if (!raw) return [];
  // Multiple cookies are comma-separated, but commas can also appear inside
  // expires dates. Split on the pattern ", <name>=" instead.
  return raw.split(/,(?=\s*[_a-zA-Z][-_a-zA-Z0-9]*=)/);
}

/**
 * Refresh the request token (anonymous session). Updates cookies.
 */
async function refreshRequestToken() {
  const domain = await discoverDomain();
  if (!domain) throw new Error('No mapple domain available');

  const res = await fetch(`https://${domain}/api/request-token`, {
    method: 'POST',
    redirect: 'follow',
    headers: {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/json',
      Origin: `https://${domain}`,
      Referer: `https://${domain}/`,
      ...( _cookieHeader ? { Cookie: _cookieHeader } : {}),
    },
  });
  if (!res.ok) {
    // Domain may have changed — force re-discovery
    _currentDomain = null;
    _cookieHeader = '';
    _tmdbKey = null;
    throw new Error(`request-token failed: ${res.status}`);
  }

  // Update cookies
  const setCookies = extractSetCookies(res.headers);
  if (setCookies.length) {
    const newCookies = setCookies.map((c) => c.split(';')[0]).join('; ');
    // Merge with existing cookies (new ones override)
    _cookieHeader = mergeCookies(_cookieHeader, newCookies);
  }

  // Parse body to confirm token received (we don't use the token directly —
  // it's the cookie that matters for /api/tmdb-key)
  try {
    await res.json();
  } catch (_) {}

  return true;
}

/**
 * Fetch a fresh TMDB API key. The key has a ~5min TTL.
 */
async function fetchTmdbKey() {
  const domain = await discoverDomain();
  if (!domain) throw new Error('No mapple domain available');

  const res = await fetch(`https://${domain}/api/tmdb-key`, {
    method: 'POST',
    redirect: 'follow',
    headers: {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/json',
      Origin: `https://${domain}`,
      Referer: `https://${domain}/`,
      Cookie: _cookieHeader || '',
    },
  });

  if (res.status === 401) {
    // Cookie expired or invalid — refresh request token, then retry
    _cookieHeader = '';
    await refreshRequestToken();
    return fetchTmdbKey();
  }
  if (!res.ok) {
    // Domain may have changed — force re-discovery
    _currentDomain = null;
    throw new Error(`tmdb-key failed: ${res.status}`);
  }

  const data = await res.json();
  if (!data || typeof data.key !== 'string') {
    throw new Error('Invalid tmdb-key response');
  }

  // Persist any new cookies from this response
  const setCookies = extractSetCookies(res.headers);
  if (setCookies.length) {
    const newCookies = setCookies.map((c) => c.split(';')[0]).join('; ');
    _cookieHeader = mergeCookies(_cookieHeader, newCookies);
  }

  _tmdbKey = data.key;
  _tmdbKeyExpiresAt = data.expiresAt || (Date.now() + 240_000); // 4min default
  console.log(`[mapple] Got TMDB key, expires in ${(_tmdbKeyExpiresAt - Date.now()) / 1000}s`);
  return _tmdbKey;
}

/**
 * Ensure we have a valid (non-expired) TMDB key.
 */
async function ensureKey() {
  const now = Date.now();
  if (_tmdbKey && now < _tmdbKeyExpiresAt - KEY_BUFFER_MS) {
    return _tmdbKey;
  }
  if (!_cookieHeader) {
    await refreshRequestToken();
  }
  return fetchTmdbKey();
}

/**
 * Sleep helper for exponential backoff.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make an authenticated GET to /api/tmdb/<path> on the current mapple domain.
 * Returns { status, body, headers } — caller decides how to handle errors.
 *
 * Retry logic:
 *   - 401: refresh key, retry (up to 3 times)
 *   - 429: exponential backoff (1s, 2s, 4s), respect Retry-After header
 *   - 5xx: return immediately (caller should surface as 502/503)
 */
async function tmdbGet(path, query) {
  const domain = await discoverDomain();
  if (!domain) {
    return { status: 503, body: { error: 'No mapple domain available' }, headers: {} };
  }

  // Build URL with query string
  const url = new URL(`https://${domain}/api/tmdb/${path.replace(/^\//, '')}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
  }

  let rateLimitRetries = 0;
  const MAX_RATE_LIMIT_RETRIES = 3;

  // Try up to 3 times for auth, plus extra retries for rate limiting
  for (let attempt = 0; attempt < 3 + MAX_RATE_LIMIT_RETRIES; attempt++) {
    const key = await ensureKey();
    const res = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: {
        ...BROWSER_HEADERS,
        'x-api-key': key,
        Origin: `https://${domain}`,
        Referer: `https://${domain}/`,
        Cookie: _cookieHeader || '',
      },
    });

    // 401 — refresh key and retry
    if (res.status === 401) {
      console.log(`[mapple] 401 on ${path} (attempt ${attempt + 1}), refreshing key`);
      _tmdbKey = null;
      _tmdbKeyExpiresAt = 0;
      try {
        await fetchTmdbKey();
      } catch (e) {
        console.log(`[mapple] Key refresh failed: ${e.message}, re-discovering domain`);
        _currentDomain = null;
        _cookieHeader = '';
        await discoverDomain();
      }
      continue;
    }

    // 429 — rate limited, exponential backoff
    if (res.status === 429) {
      if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
        console.log(`[mapple] 429 on ${path} — max retries exceeded`);
        const bodyText = await res.text();
        return {
          status: 429,
          body: { error: 'Rate limited by upstream (TMDB/mapple)', raw: bodyText.slice(0, 200) },
          headers: { contentType: 'application/json' },
        };
      }
      // Respect Retry-After header if present, otherwise exponential backoff
      const retryAfter = res.headers.get('retry-after');
      let waitMs;
      if (retryAfter) {
        waitMs = parseInt(retryAfter, 10) * 1000 || 1000;
      } else {
        waitMs = Math.pow(2, rateLimitRetries) * 1000; // 1s, 2s, 4s
      }
      console.log(`[mapple] 429 on ${path} — backing off ${waitMs}ms (retry ${rateLimitRetries + 1}/${MAX_RATE_LIMIT_RETRIES})`);
      await sleep(waitMs);
      rateLimitRetries++;
      continue;
    }

    // 5xx — return immediately, caller should handle
    if (res.status >= 500) {
      const bodyText = await res.text();
      let body;
      try {
        body = JSON.parse(bodyText);
      } catch (_) {
        body = { error: `Upstream ${res.status}`, raw: bodyText.slice(0, 200) };
      }
      return {
        status: res.status,
        body,
        headers: { contentType: res.headers.get('content-type') || 'application/json' },
      };
    }

    // Success or other 4xx — return as-is
    const bodyText = await res.text();
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch (_) {
      body = { error: 'Invalid JSON', raw: bodyText.slice(0, 500) };
    }

    return {
      status: res.status,
      body,
      headers: {
        contentType: res.headers.get('content-type') || 'application/json',
      },
    };
  }

  return { status: 401, body: { error: 'Unauthorized after retries' }, headers: {} };
}

/**
 * Merge two Cookie header strings. New cookies override existing ones with
 * the same name.
 */
function mergeCookies(existing, incoming) {
  const map = new Map();
  for (const part of (existing || '').split('; ')) {
    if (!part) continue;
    const idx = part.indexOf('=');
    if (idx > 0) map.set(part.slice(0, idx), part.slice(idx + 1));
  }
  for (const part of (incoming || '').split('; ')) {
    if (!part) continue;
    const idx = part.indexOf('=');
    if (idx > 0) map.set(part.slice(0, idx), part.slice(idx + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Get current status info (for /api/health).
 */
function getStatus() {
  return {
    currentDomain: _currentDomain,
    hasCookie: !!_cookieHeader,
    hasKey: !!_tmdbKey,
    keyExpiresAt: _tmdbKeyExpiresAt || null,
    keyExpiresIn: _tmdbKeyExpiresAt ? _tmdbKeyExpiresAt - Date.now() : null,
    lastDiscoveryAt: _lastDiscoveryAt || null,
    knownDomains: BOOTSTRAP_DOMAINS,
  };
}

export {
  discoverDomain,
  refreshRequestToken,
  fetchTmdbKey,
  ensureKey,
  tmdbGet,
  getStatus,
  BOOTSTRAP_DOMAINS,
};
