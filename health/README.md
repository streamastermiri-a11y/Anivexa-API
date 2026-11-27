# health/

Custom addition, not part of the upstream repo. Lives in its own folder so
`Sync fork` / `git pull` never touches or conflicts with it.

## Routes

| Route | What it does |
|---|---|
| `GET /health/ping` | Instant "is the hook installed?" probe. No provider calls. Returns `{ "ok": true, "module": "health/check.js", ... }`. |
| `GET /health/status` | Cached pass/fail snapshot for every provider (see below). |
| `GET /health/status?refresh=1` | Skip the cache and run a real check — but never more than one real check per 30 minutes (the response says `refreshThrottled: true` and `nextRealCheckAt` when it declines). |

Any other `/health/*` path behaves like `/health/status`.

```json
{
  "checkedAt": "2026-11-27T04:00:00.000Z",
  "testAnilistId": "16498",
  "testEpisode": "1",
  "providerListSource": "live",
  "providers": [
    { "id": "anikoto",    "ok": true,  "ms": 812,   "reason": null,      "anilistId": "16498" },
    { "id": "animenosub", "ok": false, "ms": 12004, "reason": "timeout", "anilistId": "113415" }
  ],
  "fromCache": true
}
```

- `providerListSource` — `"live"` means the provider list was read from the API
  itself (always current). `"fallback"` means that lookup failed and the ids
  from upstream's `scripts/provider-cases.json` were used instead.
- `reason` — `null` when healthy; otherwise `timeout`, `HTTP <status>: <message>`,
  `no streams returned`, `response was not JSON`, or the network error text.
- `anilistId` — the show that provider was probed with (see "How a provider is checked").

## How a provider is checked

The module calls this API's own `/watch/:provider/:anilistId/sub/:provider-1`
route and requires at least one entry in `streams` — the same route and the
same definition of "working" as upstream's `npm run test:providers`. The call
is made in-process (no network hop), so it works behind proxies and `BASE_PATH`.

Not every provider carries every show, so each provider is probed with the show
upstream lists for it in `scripts/provider-cases.json`. Anything not listed
there uses AniList `16498`.

## The one touch-point outside this folder

`index.js` needs this block, placed after the `OPTIONS` handling and before the
first route (`let m = path.match(...)`):

```js
    // [fork] /health/* → health/check.js (see health/README.md)
    if (path === "/health" || path.startsWith("/health/")) {
      return (await import("./health/check.js")).default(request, env, this?.fetch && ((r) => this.fetch(r, env)));
    }
```

It uses a dynamic `import()`, so the rest of the API never loads (or breaks
because of) this folder.

## After every "Sync fork" — 30-second check

1. Open `https://<your-domain>/health/ping`.
2. See `"ok": true` → done.
3. See the API info JSON (`name`, `providers`, `routes`) instead → the sync removed the hook. Re-add it:
   - **GitHub:** Actions tab → *Re-apply /health hook after sync* → **Run workflow**, or
   - **Terminal:** `node health/ensure-hook.js`, or
   - **By hand:** paste the block above into `index.js`.

⚠️ If GitHub's sync dialog offers **"Discard commits"**, don't click it — that
deletes everything custom in your fork, including this folder. Choose the option
that lets you resolve the conflict instead, and keep both sides.

## Auto-heal (optional)

`.github/workflows/ensure-health-hook.yml` runs after every push that changes
`index.js` (which is what a sync does). If the hook is missing it re-adds it,
runs the tests, and only then commits. If it can't fix things safely it fails
and GitHub emails you — so a broken sync is no longer silent.

One-time setup: forks have Actions switched off by default. Open the **Actions**
tab of your fork and click *"I understand my workflows, go ahead and enable them"*.

## Tuning

| Env var | Effect |
|---|---|
| `HEALTHCHECK_ANILIST_ID` | Probe **every** provider with this AniList id (overrides the per-provider shows). |
| `HEALTHCHECK_EPISODE` | Episode number to probe (default `1`). |

To change how long results are kept or how often a real check may run, edit
`CACHE_TTL_MS` (24 h) and `MIN_INTERVAL_BETWEEN_REAL_CHECKS_MS` (30 min) at the
top of `check.js`.

## Known limitations

- Audio is always `sub`; a provider that only has dub would show as failing.
- Because the check goes through the normal `/watch` route, with
  `CACHE_ENABLED=true` a recent successful response can be served from cache and
  hide a provider that just broke (up to 3 h; 60 s for providers with signed
  stream URLs).

## Tests

```bash
node --test health/health.test.js   # just this folder
npm test                            # everything (also picked up automatically)
```

The first test fails if the hook is missing from `index.js`, so `npm test` after
a sync tells you immediately.
