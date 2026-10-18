# Mapple TMDB Proxy

A Vercel serverless proxy for [mapple.fun](https://mapple.fun)'s TMDB API.

## Features

- **Auto-domain discovery** — Survives mapple domain rotations (mapplee.com → mapple.fun → next). The proxy bootstraps the current domain by following `mapplee.com`'s 301 redirect, and re-discovers on auth failure.
- **2-hour TTL cache** — Cached per endpoint + per parameter set. Different params = fresh fetch. In-memory cache for warm invocations + Vercel edge cache via `Cache-Control: s-maxage=7200`.
- **Combined detail endpoints** — Get metadata + cast/crew + pictures + seasons + external IDs + statistics in one call.
- **Full TMDB passthrough** — Generic `/api/tmdb/<path>` proxy supports every endpoint and parameter TMDB officially offers.

## Endpoints

### Generic proxy
```
GET /api/tmdb/<tmdb-path>?<any-tmdb-params>
```
Examples:
- `/api/tmdb/movie/popular?language=en-US&page=1`
- `/api/tmdb/tv/1396?language=en-US`
- `/api/tmdb/search/tv?query=Naruto&language=en-US`
- `/api/tmdb/discover/movie?with_genres=28&primary_release_date.gte=2025-01-01`
- `/api/tmdb/trending/movie/day?language=en-US`
- `/api/tmdb/tv/1396/season/1?language=en-US`
- `/api/tmdb/tv/1396/season/1/episode/1?language=en-US`

### Combined movie details
```
GET /api/details/movie/{tmdb_id}?language=en-US
```
Returns `{ id, type, cached_at, cached_until, data: { metadata, cast_crew, pictures, external_ids, statistics, recommendations, similar, videos, watch_providers, release_dates, keywords, reviews, translations } }`

### Combined TV details
```
GET /api/details/tv/{tmdb_id}?language=en-US&expand_seasons=false
```
Returns `{ id, type, cached_at, cached_until, data: { metadata, cast_crew, pictures, seasons, external_ids, statistics, keywords, videos, reviews, translations } }`

Set `expand_seasons=true` to fetch each season's full episode list (slower but richer data).

### Health check
```
GET /api/health
```
Returns current mapple domain, auth status, cache stats. Use `?refresh=true` to force re-discovery.

## Caching

- **TTL**: 2 hours (7200 seconds) for detail endpoints
- **Short TTL**: 10 minutes for popular / now_playing / upcoming / on_the_air / airing_today
- **No cache**: trending, search, changes endpoints
- **Cache key**: path + sorted query params — different params = different cache entry = fresh fetch
- **Edge cache**: `Cache-Control: s-maxage=7200, stale-while-revalidate=14400` lets Vercel's CDN serve cached responses
- **In-memory**: Warm serverless invocations serve instantly from memory

## Auto-Domain Discovery

The mapple project periodically rotates its public domain. As of Oct 2026:
- `mapplee.com` → 301 redirects to current active domain
- `mapple.fun` → current active domain
- Historical: mapple.rip, mapple.bid, mapple.uk, mapple.club, mappletv.uk

The proxy:
1. Hits `mapplee.com/api/request-token` (which 301s to the current domain)
2. Captures the final hostname after redirects
3. Caches it in memory for 60 seconds
4. On auth failure (401 after retries), re-discovers from scratch

This means: **if mapple changes domain tomorrow, the proxy keeps working** without any code changes.

## Auth Flow

The proxy implements the same 3-step anonymous auth flow mapple's own frontend uses:

1. `POST /api/request-token` → sets `_mapple_site` cookie
2. `POST /api/tmdb-key` → returns `{ key, expiresAt }` (5-min TTL)
3. `GET /api/tmdb/<path>` with `x-api-key: <key>` header + cookie

On 401, the proxy force-refreshes the key. If that fails, it re-discovers the domain.

## Deployment

This project is configured for Vercel. Deploy via:
1. Push to a Git repo and import on Vercel, OR
2. Use `vercel` CLI: `vercel --prod`

No environment variables needed — auth is fully anonymous.

## Limitations

Mapple.fun has an allowlist of endpoints it proxies. The following TMDB endpoints are NOT available:
- `/tv/{id}/external_ids` (standalone) — but core `/tv/{id}` includes some external IDs inline
- `/tv/{id}/aggregate_credits` — use `/tv/{id}/credits` instead
- `/tv/{id}/content_ratings`
- `/tv/{id}/episode_groups`
- `/tv/{id}/screened_theatrically`
- `/tv/{id}/lists`, `/movie/{id}/lists`
- `/tv/{id}/changes`, `/movie/{id}/changes`
- `/tv/changes`, `/movie/changes`, `/person/changes` (global changes lists)
- `/person/popular`
- `/tv/{id}/season/{n}/credits|images|videos|external_ids`

For movies, the core `/movie/{id}` endpoint includes most sub-resources (external_ids, keywords, recommendations, similar, videos, watch/providers, release_dates) inline by default — so the combined movie endpoint gets everything in one call.
