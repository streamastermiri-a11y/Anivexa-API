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

// Default is AniList id 16498 (Attack on Titan Season 1) — widely
// carried and well-known, chosen to minimize "provider is actually
// fine, it just doesn't have THIS show" false negatives. Override via
// env var if a different test case fits your providers better.
const TEST_ANILIST_ID = process.env.HEALTHCHECK_ANILIST_ID || "16498";
const TEST_EPISODE = process.env.HEALTHCHECK_EPISODE || "1";

const CACHE_KEY = "health:status";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PER_PROVIDER_TIMEOUT_MS = 12000;

// Same-instance fallback so repeated calls stay fast even when
// CACHE_ENABLED (Redis) is off — getAsync/setAsync silently no-op in
// that case. Resets on cold start, same as any other in-memory state,
// which is fine: it's a supplement to the Redis cache, not a replacement.
let _memCache = null;

// PATCH: two extra safety nets against runaway repeated real checks —
// both matter most when Redis isn't configured (CACHE_ENABLED=false) or
// the instance keeps sleeping/restarting, since the cache above can't
// help in those cases.
//
// 1. In-flight de-duplication: if several callers arrive while the
//    cache is empty/expired (very normal — several people loading the
//    page around the same moment), only the FIRST one actually runs
//    checkOneProvider on all 15 providers; everyone else just waits for
//    that same run instead of each starting their own full 15-provider
//    test in parallel with each other.
// 2. A hard floor: even a forced refresh, or a cold instance with no
//    cache at all, will not re-run a real check more than once per
//    MIN_INTERVAL_BETWEEN_REAL_CHECKS_MS — serves the last known result
//    instead.
let _inFlightCheck = null;
let _lastRealCheckAt = 0;
let _lastResult = null;
const MIN_INTERVAL_BETWEEN_REAL_CHECKS_MS = 30 * 60 * 1000; // 30 minutes

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

  // Safety net 1: several callers can easily arrive while the cache is
  // empty/expired (just several people loading the page around the same
  // moment) — only the first one actually runs a real check; everyone
  // else joins that same in-flight run instead of each starting their
  // own full 15-provider test in parallel with each other.
  if (_inFlightCheck) {
    const result = await _inFlightCheck;
    return json({ ...result, fromCache: true });
  }

  // Safety net 2: a hard floor against runaway repeated real checks,
  // independent of the cache above — matters most when Redis isn't
  // configured or the instance keeps sleeping/restarting, since a
  // forced refresh or a cold instance with no persisted cache would
  // otherwise re-run the full check every single time.
  const sinceLastReal = Date.now() - _lastRealCheckAt;
  if (_lastResult && sinceLastReal < MIN_INTERVAL_BETWEEN_REAL_CHECKS_MS) {
    return json({ ..._lastResult, fromCache: true });
  }

  _inFlightCheck = runFullCheck(baseUrl);
  let fresh;
  try {
    fresh = await _inFlightCheck;
  } finally {
    _inFlightCheck = null;
  }
  _lastRealCheckAt = Date.now();
  _lastResult = fresh;

  let entry;
  try {
    entry = await setAsync(CACHE_KEY, fresh, CACHE_TTL_MS);
  } catch {
    entry = null;
  }
  _memCache = entry || { data: fresh, expiresAt: Date.now() + CACHE_TTL_MS };
  return json({ ...fresh, fromCache: false });
}
