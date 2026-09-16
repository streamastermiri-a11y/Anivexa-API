// Isolated health-check module. Lives in its own folder specifically so
// `git pull` from upstream never touches it — the only other change is
// a small 3-line hook near the top of index.js that routes /health/*
// requests here (see the comment there). Nothing in this file is
// imported by, or modifies, any upstream file.
//
// GET /health/status
//   Returns a cached health snapshot for every provider: { id, ok, ms,
//   reason }[]. If no cached snapshot exists yet, or the cached one has
//   expired, THIS call becomes the one that refreshes it — it tests
//   every provider in parallel (bounded by a per-provider timeout) and
//   caches the result, so most callers get an instant cached read and
//   only the rare "first call after expiry" pays the real cost.
//
// GET /health/status?refresh=1
//   Forces a fresh check, ignoring any cached snapshot.
//
// Each provider is "checked" by calling this API's own public
// /watch/:provider/:id/:audio/:provider-:ep route for one known test
// anime — the same route everyone else already uses — and checking
// whether it comes back with at least one stream. This reuses each
// provider's real, already-working logic instead of needing separate
// integration with every provider's internals.

import { getAsync, setAsync, isFresh } from "../core/smartcache.js";

const PROVIDERS = [
  "mkissa", "reanime", "anikoto", "animegg", "anineko", "anidbapp",
  "2dhive", "animenosub", "anizone", "aniwaves", "anibd", "senshi",
  "kaa", "animedunya", "animeonsen",
];

// Default is AniList id 21 (One Piece) — long-running and almost
// certainly carried by every provider, chosen to minimize "provider is
// actually fine, it just doesn't have THIS show" false negatives.
// Override via env var if a different test case fits your providers
// better.
const TEST_ANILIST_ID = process.env.HEALTHCHECK_ANILIST_ID || "21";
const TEST_EPISODE = process.env.HEALTHCHECK_EPISODE || "1";

const CACHE_KEY = "health:status";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PER_PROVIDER_TIMEOUT_MS = 12000;

// Same-instance fallback so repeated calls stay fast even when
// CACHE_ENABLED (Redis) is off — getAsync/setAsync silently no-op in
// that case. Resets on cold start, same as any other in-memory state,
// which is fine: it's a supplement to the Redis cache, not a replacement.
let _memCache = null;

async function checkOneProvider(baseUrl, providerId) {
  const url = `${baseUrl}/watch/${providerId}/${TEST_ANILIST_ID}/sub/${providerId}-${TEST_EPISODE}`;
  const startedAt = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PER_PROVIDER_TIMEOUT_MS) });
    const ms = Date.now() - startedAt;
    if (!res.ok) return { id: providerId, ok: false, ms, reason: `HTTP ${res.status}` };
    const data = await res.json();
    const hasStreams = Array.isArray(data.streams) && data.streams.length > 0;
    return { id: providerId, ok: hasStreams, ms, reason: hasStreams ? null : "no streams returned" };
  } catch (err) {
    const ms = Date.now() - startedAt;
    const reason = err.name === "TimeoutError" ? "timeout" : String(err.message || err);
    return { id: providerId, ok: false, ms, reason };
  }
}

async function runFullCheck(baseUrl) {
  const providers = await Promise.all(PROVIDERS.map((id) => checkOneProvider(baseUrl, id)));
  return {
    checkedAt: new Date().toISOString(),
    testAnilistId: TEST_ANILIST_ID,
    testEpisode: TEST_EPISODE,
    providers,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

export default async function healthHandler(request) {
  const url = new URL(request.url);
  const forceRefresh = url.searchParams.get("refresh") === "1";
  const baseUrl = `${url.protocol}//${url.host}`;

  if (!forceRefresh) {
    if (_memCache && isFresh(_memCache)) {
      return json({ ..._memCache.data, fromCache: true });
    }
    const cached = await getAsync(CACHE_KEY).catch(() => null);
    if (cached && isFresh(cached)) {
      _memCache = cached;
      return json({ ...cached.data, fromCache: true });
    }
  }

  const fresh = await runFullCheck(baseUrl);
  let entry;
  try {
    entry = await setAsync(CACHE_KEY, fresh, CACHE_TTL_MS);
  } catch {
    entry = null;
  }
  _memCache = entry || { data: fresh, expiresAt: Date.now() + CACHE_TTL_MS };
  return json({ ...fresh, fromCache: false });
}
