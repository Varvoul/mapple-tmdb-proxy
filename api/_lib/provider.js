/**
 * Provider resolver: mapple scrape tier first, TMDB-direct second.
 *
 * Returns { status, body, headers, provider } so endpoints can report which
 * tier served the request (X-Upstream response header + source field).
 *
 * Failure semantics:
 *   - mapple 200 with a clean body  → served by mapple (normal case).
 *   - mapple 404                    → authoritative "not found", pass through
 *                                     (a missing TMDB item is missing everywhere).
 *   - mapple 403/429/5xx/no-domain  → fall back to TMDB direct (if configured).
 *   - direct also 5xx               → return the mapple error unchanged.
 */

import { tmdbGet } from './mapple.js';
import { directEnabled, tmdbDirectGet } from './tmdb-direct.js';

export async function tmdbFetch(path, query) {
  const upstream = await tmdbGet(path, query);

  // Authoritative not-found — no point trying the direct tier.
  if (upstream.status === 404) {
    return { ...upstream, provider: 'mapple' };
  }

  // Clean success from mapple.
  if (upstream.status === 200 && upstream.body && !upstream.body.error) {
    return { ...upstream, provider: 'mapple' };
  }

  // mapple failed (403 challenge / 429 / 5xx / no domain / malformed body).
  if (directEnabled()) {
    try {
      const direct = await tmdbDirectGet(path, query);
      if (direct.status < 500) {
        return { ...direct, provider: 'tmdb-direct' };
      }
      // Direct tier also 5xx — fall through and surface the mapple error.
    } catch (_) {
      // Network error on direct tier — fall through.
    }
  }

  return { ...upstream, provider: 'mapple' };
}
