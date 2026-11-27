// Health-check module — GET /health/status.
//
// Lives in its own folder so upstream syncs (git pull / zip updates) never
// overwrite it. Its ONE touch-point outside this folder is the /health/* hook
// in index.js. If an upstream sync removes that hook, `node health/install-hook.js`
// puts it back (on a GitHub fork, .github/workflows/health-hook.yml does that
// automatically after every sync) and `npm test` fails until it is back — see
// health/README.md and health/ADR-001-health-hook.md.
//
// How it works: for every provider this API serves, it calls this API's own
// public /watch/:provider/:id/sub/:provider-:ep route for one known test anime
// and checks that at least one stream comes back. That re-uses each provider's
// real, already-working code instead of integrating with every provider's
// internals.
//
//   GET /health/status            cached snapshot (refreshes itself when stale)
//   GET /health/status?refresh=1  ask for a fresh check (rate-limited, see below)

import { getAsync, setAsync, isFresh } from "../core/smartcache.js";

// process may not exist on some edge runtimes — read env defensively.
function readEnv(name) {
  try {
    return typeof process !== "undefined" ? process.env?.[name] : undefined;
  } catch {
    return undefined;
  }
}

// ── Which providers to check ────────────────────────────────────────────────
// The list is read from this API itself instead of being hard-coded here, so it
// can't drift when upstream adds or removes a provider (that drift is how
// removed providers kept showing up as "dead" in /health/status).
//
// "/" is tried first. Under server.js "/" is the static landing page (HTML), so
// the second path is the one that works there: any unknown URL falls through to
// index.js's default JSON response, which carries the same `providers` list.
//
// FALLBACK_PROVIDERS is a last resort. When it is used, the response says so
// (`providerSource: "fallback"` + `warning`), and health.test.js fails whenever
// it stops matching the providers index.js registers.
export const FALLBACK_PROVIDERS = [
  "anihq", "reanime", "anikoto", "animegg", "animenosub", "anizone",
  "aniwaves", "pahenime", "kaa", "animedunya", "animeonsen", "anipm",
];

const DISCOVERY_PATHS = ["/", "/_providers"];
const DISCOVERY_TIMEOUT_MS = 8000;

async function fetchProviderList(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json(); // throws on HTML (e.g. the static landing page)
  const ids = Array.isArray(data?.providers) ? data.providers : [];
  // These ids end up inside URLs, so only accept plain provider names.
  if (!ids.length || !ids.every((id) => typeof id === "string" && /^[\w-]+$/.test(id))) {
    throw new Error("no provider list in response");
  }
  return ids;
}

async function discoverProviders(baseUrl) {
  for (const path of DISCOVERY_PATHS) {
    try {
      return { ids: await fetchProviderList(`${baseUrl}${path}`), source: "discovered" };
    } catch {
      // try the next path
    }
  }
  return { ids: FALLBACK_PROVIDERS, source: "fallback" };
}

// ── Which show to test each provider with ───────────────────────────────────
// Default is AniList 16498 (Attack on Titan S1): widely carried, so a failure is
// more likely to mean "provider is down" than "provider doesn't have this show".
// The providers below use a different show, mirroring upstream's
// scripts/provider-cases.json (health.test.js fails if the two drift apart).
// HEALTHCHECK_ANILIST_ID / HEALTHCHECK_EPISODE override the show for every provider.
export const DEFAULT_TEST_ANILIST_ID = "16498";
export const PROVIDER_TEST_CASES = {
  animenosub: { anilistId: "113415" }, // Jujutsu Kaisen
  aniwaves:   { anilistId: "101922" }, // Demon Slayer
  pahenime:   { anilistId: "101922" },
  animedunya: { anilistId: "101922" },
  animeonsen: { anilistId: "101922" },
};

const ENV_ANILIST_ID = readEnv("HEALTHCHECK_ANILIST_ID") || null;
const TEST_EPISODE = readEnv("HEALTHCHECK_EPISODE") || "1";

export function testCaseFor(providerId) {
  return {
    anilistId: ENV_ANILIST_ID || PROVIDER_TEST_CASES[providerId]?.anilistId || DEFAULT_TEST_ANILIST_ID,
  };
}

// ── Caching and rate limiting ───────────────────────────────────────────────
const CACHE_KEY = "health:status";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PER_PROVIDER_TIMEOUT_MS = 12000;

// Same-instance fallback so repeated calls stay fast even when CACHE_ENABLED
// (Redis) is off — getAsync/setAsync silently no-op in that case. Resets on cold
// start, which is fine: it supplements the Redis cache, it doesn't replace it.
let _memCache = null;

// Two safety nets against runaway repeated real checks. They matter most when
// Redis isn't configured or the instance keeps sleeping/restarting, since the
// cache above can't help in those cases.
//
// 1. In-flight de-duplication: if several callers arrive while the cache is
//    empty/expired, only the FIRST runs the real check; the rest wait for that
//    same run instead of each starting their own full test.
// 2. A hard floor: even ?refresh=1, or a cold instance with no cache, will not
//    re-run a real check more than once per MIN_INTERVAL_BETWEEN_REAL_CHECKS_MS —
//    the last known result is served instead (flagged fromCache: true).
let _inFlightCheck = null;
let _lastRealCheckAt = 0;
let _lastResult = null;
const MIN_INTERVAL_BETWEEN_REAL_CHECKS_MS = 30 * 60 * 1000; // 30 minutes

// Test helper: forget all in-process state.
export function _resetHealthStateForTests() {
  _memCache = null;
  _inFlightCheck = null;
  _lastRealCheckAt = 0;
  _lastResult = null;
}

// ── The check itself ────────────────────────────────────────────────────────
async function checkOneProvider(baseUrl, providerId) {
  const { anilistId } = testCaseFor(providerId);
  const url = `${baseUrl}/watch/${providerId}/${anilistId}/sub/${providerId}-${TEST_EPISODE}`;
  const startedAt = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PER_PROVIDER_TIMEOUT_MS) });
    const ms = Date.now() - startedAt;
    if (!res.ok) return { id: providerId, ok: false, ms, reason: `HTTP ${res.status}`, anilistId };
    const data = await res.json();
    const hasStreams = Array.isArray(data.streams) && data.streams.length > 0;
    return { id: providerId, ok: hasStreams, ms, reason: hasStreams ? null : "no streams returned", anilistId };
  } catch (err) {
    const ms = Date.now() - startedAt;
    const reason = err.name === "TimeoutError" ? "timeout" : String(err.message || err);
    return { id: providerId, ok: false, ms, reason, anilistId };
  }
}

async function runFullCheck(baseUrl) {
  const { ids, source } = await discoverProviders(baseUrl);
  const providers = await Promise.all(ids.map((id) => checkOneProvider(baseUrl, id)));
  return {
    checkedAt: new Date().toISOString(),
    testAnilistId: ENV_ANILIST_ID || DEFAULT_TEST_ANILIST_ID,
    testEpisode: TEST_EPISODE,
    providerSource: source,
    ...(source === "fallback" && {
      warning: "Could not read the provider list from this API; using FALLBACK_PROVIDERS, which may be out of date.",
    }),
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

  // Safety net 1: join a check that is already running.
  if (_inFlightCheck) {
    const result = await _inFlightCheck;
    return json({ ...result, fromCache: true });
  }

  // Safety net 2: hard floor between real checks.
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
