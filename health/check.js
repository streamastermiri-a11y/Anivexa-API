// health/check.js — isolated health-check module for this fork.
//
// WHY IT LIVES IN ITS OWN FOLDER
//   Upstream never touches health/, so "Sync fork" can't overwrite it. The only
//   wiring outside this folder is the 4-line hook in index.js (see
//   health/README.md). It loads this file lazily, so even a broken health
//   module can never take the rest of the API down.
//
// ROUTES (all served by the default export below)
//   GET /health/ping              instant "the hook is installed" probe — no provider calls
//   GET /health/status            cached snapshot of every provider: { id, ok, ms, reason, anilistId }[]
//   GET /health/status?refresh=1  skip the cache (still limited to one real check per 30 min)
//   Any other /health/* path behaves like /health/status, as before.
//
// HOW A PROVIDER IS "CHECKED"
//   We call this API's own /watch/:provider/:anilistId/sub/:provider-:ep route
//   and require at least one entry in `streams` — the same route and the same
//   notion of "working" that upstream's scripts/provider-check.js uses.
//   When the hook passes in `fetchSelf`, the call is made IN-PROCESS (no network
//   hop, so no problems with proxies, https redirects or BASE_PATH). Without it
//   we fall back to a normal HTTP request to our own host.

// Cache helpers come from upstream's smartcache, but optionally: if upstream
// ever renames them, health still works (just without the shared cache).
const smartcache = await import("../core/smartcache.js").catch(() => ({}));
const cacheGet = typeof smartcache.getAsync === "function" ? smartcache.getAsync : async () => null;
const cacheSet = typeof smartcache.setAsync === "function"
  ? smartcache.setAsync
  : async (_key, data, ttlMs) => ({ data, expiresAt: Date.now() + ttlMs });
const entryFresh = typeof smartcache.isFresh === "function"
  ? smartcache.isFresh
  : (entry) => Boolean(entry) && Date.now() < entry.expiresAt;

function readEnv(name) {
  try { return typeof process !== "undefined" ? process.env?.[name] : undefined; } catch { return undefined; }
}

// ── Which anime to probe each provider with ────────────────────────────────
// Not every provider carries every show, so probing all of them with one anime
// produces false "down" results. Upstream already maintains the right show per
// provider in scripts/provider-cases.json — we read that file whenever we can
// (Node), and only use this snapshot if we can't (e.g. Vercel Edge has no fs).
const SNAPSHOT_CASES = {
  anihq: "16498", reanime: "16498", anikoto: "16498", animegg: "16498",
  animenosub: "113415", anizone: "16498", aniwaves: "101922", pahenime: "101922",
  kaa: "16498", animedunya: "101922", animeonsen: "101922", anipm: "16498",
};

const DEFAULT_ANILIST_ID = "16498"; // Attack on Titan S1 — used for providers with no listed case
// HEALTHCHECK_ANILIST_ID / HEALTHCHECK_EPISODE: explicit override, applied to EVERY provider.
const ENV_ANILIST_ID = readEnv("HEALTHCHECK_ANILIST_ID") || "";
const ENV_EPISODE = readEnv("HEALTHCHECK_EPISODE") || "";

let _cases = null;
async function loadCases() {
  if (_cases) return _cases;
  try {
    const fsName = "node:fs"; // variable specifier keeps edge bundlers from choking on it
    const { readFileSync } = await import(fsName);
    const raw = JSON.parse(readFileSync(new URL("../scripts/provider-cases.json", import.meta.url), "utf8"));
    const fromFile = {};
    for (const [id, value] of Object.entries(raw)) {
      if (value?.anilistId) fromFile[id] = String(value.anilistId);
    }
    if (Object.keys(fromFile).length) return (_cases = fromFile);
  } catch { /* no fs, or file moved — use the snapshot */ }
  return (_cases = SNAPSHOT_CASES);
}

// ── Timing / cache policy ─────────────────────────────────────────────────
const CACHE_KEY = "health:status:v2"; // v2: never serve snapshots written by the old (buggy) module
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PER_PROVIDER_TIMEOUT_MS = 12000;
const DISCOVERY_TIMEOUT_MS = 8000;
const MIN_INTERVAL_BETWEEN_REAL_CHECKS_MS = 30 * 60 * 1000; // 30 minutes

// Same-instance state. It matters most when Redis is off (CACHE_ENABLED=false)
// or the instance keeps sleeping/restarting, because the shared cache can't help then.
let _memCache = null;      // last snapshot we read/wrote (with expiry)
let _inFlightCheck = null; // callers arriving mid-check join this instead of starting their own
let _lastRealCheckAt = 0;  // hard floor: at most one real check per MIN_INTERVAL…
let _lastResult = null;    // …otherwise serve this

// ── Helpers ───────────────────────────────────────────────────────────────
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Returns get(path, timeoutMs) → Response, either in-process or over HTTP.
function makeGetter(request, fetchSelf) {
  const url = new URL(request.url);
  if (typeof fetchSelf === "function") {
    return (path, timeoutMs) =>
      withTimeout(Promise.resolve(fetchSelf(new Request(url.origin + path))), timeoutMs);
  }
  const proto = (request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "")).split(",")[0].trim();
  const origin = `${proto}://${url.host}`;
  return (path, timeoutMs) => fetch(origin + path, { signal: AbortSignal.timeout(timeoutMs) });
}

// The provider list comes from the API itself (its root JSON), so it can never
// drift out of date. Two paths are tried because server.js answers "/" with the
// HTML landing page — any other unmatched path falls through to the same JSON.
// Last resort: the provider ids upstream lists in scripts/provider-cases.json.
async function discoverProviders(get) {
  for (const path of ["/", "/__discover"]) {
    try {
      const res = await get(path, DISCOVERY_TIMEOUT_MS);
      if (!res.ok) continue;
      const data = await res.json();
      const ids = (Array.isArray(data?.providers) ? data.providers : [])
        .filter((id) => typeof id === "string" && /^[a-z0-9_-]+$/i.test(id));
      if (ids.length) return { ids, source: "live" };
    } catch { /* try the next path */ }
  }
  return { ids: Object.keys(await loadCases()), source: "fallback" };
}

function shortError(data) {
  return data?.error ? `: ${String(data.error).slice(0, 120)}` : "";
}

async function checkOneProvider(get, id, anilistId, episode) {
  const path = `/watch/${id}/${anilistId}/sub/${id}-${episode}`;
  const startedAt = Date.now();
  try {
    const res = await get(path, PER_PROVIDER_TIMEOUT_MS);
    const ms = Date.now() - startedAt;
    let data = null;
    try { data = await res.json(); } catch { /* body wasn't JSON */ }
    if (!res.ok) return { id, ok: false, ms, reason: `HTTP ${res.status}${shortError(data)}`, anilistId };
    if (data === null) return { id, ok: false, ms, reason: "response was not JSON", anilistId };
    const hasStreams = Array.isArray(data.streams) && data.streams.length > 0;
    const reason = hasStreams ? null : (data.error ? `error${shortError(data)}` : "no streams returned");
    return { id, ok: hasStreams, ms, reason, anilistId };
  } catch (err) {
    const ms = Date.now() - startedAt;
    const reason = err?.name === "TimeoutError" ? "timeout" : String(err?.message || err);
    return { id, ok: false, ms, reason, anilistId };
  }
}

async function runFullCheck(get) {
  const [{ ids, source }, cases] = await Promise.all([discoverProviders(get), loadCases()]);
  const episode = ENV_EPISODE || "1";
  const providers = await Promise.all(
    ids.map((id) => checkOneProvider(get, id, ENV_ANILIST_ID || cases[id] || DEFAULT_ANILIST_ID, episode))
  );
  return {
    checkedAt: new Date().toISOString(),
    testAnilistId: ENV_ANILIST_ID || DEFAULT_ANILIST_ID, // default only — each provider row shows the id it was probed with
    testEpisode: episode,
    providerListSource: source, // "live" = read from the API itself; "fallback" = list may be stale
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

// For tests only.
export function __resetForTests() {
  _memCache = null; _inFlightCheck = null; _lastRealCheckAt = 0; _lastResult = null; _cases = null;
}

// request   — the incoming Request
// _env      — unused (kept so the hook's signature matches the worker's)
// fetchSelf — optional (request) => Response that calls this API's own handler in-process
export default async function healthHandler(request, _env, fetchSelf) {
  const url = new URL(request.url);

  if (url.pathname.replace(/\/+$/, "") === "/health/ping") {
    return json({
      ok: true,
      module: "health/check.js",
      mode: typeof fetchSelf === "function" ? "in-process" : "network",
      time: new Date().toISOString(),
    });
  }

  const forceRefresh = url.searchParams.get("refresh") === "1";

  if (!forceRefresh) {
    if (_memCache && entryFresh(_memCache)) {
      return json({ ..._memCache.data, fromCache: true });
    }
    const cached = await cacheGet(CACHE_KEY).catch(() => null);
    if (cached && entryFresh(cached)) {
      _memCache = cached;
      return json({ ...cached.data, fromCache: true });
    }
  }

  // Several callers can arrive while the cache is empty — only the first runs
  // the real check; everyone else joins that same run.
  if (_inFlightCheck) {
    const result = await _inFlightCheck;
    return json({ ...result, fromCache: true });
  }

  // Hard floor against runaway real checks, independent of the cache.
  const sinceLastReal = Date.now() - _lastRealCheckAt;
  if (_lastResult && sinceLastReal < MIN_INTERVAL_BETWEEN_REAL_CHECKS_MS) {
    return json({
      ..._lastResult,
      fromCache: true,
      ...(forceRefresh
        ? {
            refreshThrottled: true,
            nextRealCheckAt: new Date(_lastRealCheckAt + MIN_INTERVAL_BETWEEN_REAL_CHECKS_MS).toISOString(),
          }
        : {}),
    });
  }

  _inFlightCheck = runFullCheck(makeGetter(request, fetchSelf));
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
    entry = await cacheSet(CACHE_KEY, fresh, CACHE_TTL_MS);
  } catch {
    entry = null;
  }
  _memCache = entry || { data: fresh, expiresAt: Date.now() + CACHE_TTL_MS };
  return json({ ...fresh, fromCache: false });
}
