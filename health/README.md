# health/

Custom addition, not part of the upstream repo. It lives in its own folder so
upstream syncs don't overwrite it, and it has **one** touch-point outside the
folder: a small hook in `index.js` (see "The hook in index.js" below).

## GET /health/status

A pass/fail snapshot for every provider. It is cached, so most calls are
instant. Add `?refresh=1` to ask for a fresh check (see "Caching").

```json
{
  "checkedAt": "2026-11-27T04:00:00.000Z",
  "testAnilistId": "16498",
  "testEpisode": "1",
  "providerSource": "discovered",
  "providers": [
    { "id": "anikoto",  "ok": true,  "ms": 812,   "reason": null,      "anilistId": "16498" },
    { "id": "pahenime", "ok": false, "ms": 12004, "reason": "timeout", "anilistId": "101922" }
  ],
  "fromCache": true
}
```

- `providerSource` — `"discovered"` is normal: the provider list was read from
  this API. `"fallback"` means it couldn't be read, the built-in list was used,
  and a `warning` field says so. Treat it as something to look at.
- `anilistId` — the show used to test that provider. `testAnilistId` is the
  default show (or your env override).

## How it checks

Each provider is tested by calling this API's own public
`/watch/:provider/:id/sub/:provider-:ep` route for one known show; it passes if
at least one stream comes back. That re-uses each provider's real code instead
of needing a separate integration with every provider.

The provider list is read from the API itself (`/`, then `/_providers`) instead
of a copy kept here, so it can't drift when upstream adds or removes providers.
Under `server.js`, `/` is the static landing page, which is why the second path
exists.

The default show is AniList 16498 (Attack on Titan S1). Five providers use a
different show, mirroring upstream's `scripts/provider-cases.json` (`npm test`
fails if the two drift apart).

## Caching

- The snapshot is cached for 24 h (Redis when `CACHE_ENABLED=true`, otherwise
  in memory).
- Callers that arrive during a running check share it.
- A real check runs at most once per 30 min per instance. `?refresh=1` inside
  that window returns the last result (`fromCache: true`).
- The check goes through the public watch route, so with `CACHE_ENABLED=true` a
  recent success can be answered from the watch cache (3 h; 60 s for the
  signed-stream providers) instead of hitting the provider.

## The hook in index.js

The installer puts this directly under `const path = url.pathname;`:

```js
// [health-hook] routes /health/* to health/check.js. An upstream sync can overwrite index.js;
// if /health/status stops working, run `node health/install-hook.js` (see health/README.md).
if (request.method !== "OPTIONS" && (path === "/health" || path.startsWith("/health/"))) {
  return (await import("./health/check.js")).default(request);
}
```

It is a dynamic import on purpose: if `health/` is broken or missing, only
`/health/*` fails — never the rest of the API.

## Keeping the hook when you sync a fork

Upstream owns `index.js`, so it is the one file a sync can change under you.
Everything else here (`health/`, `.github/workflows/health-hook.yml`) doesn't
exist upstream, so "Sync fork" never touches it.

**One-time setup, on github.com**

1. In your fork, add these files (*Add file → Upload files*, or *Create new
   file* and paste the contents):
   - `health/check.js` (replaces the old one)
   - `health/install-hook.js`
   - `.github/workflows/health-hook.yml`

   Optional: `health/health.test.js`, `health/README.md`,
   `health/ADR-001-health-hook.md`.
2. Open the **Actions** tab. If a banner says workflows are disabled, click
   *I understand my workflows, go ahead and enable them*.
3. Choose **Keep /health hook → Run workflow**. It adds the hook to `index.js`
   and commits it for you.

**After every Sync fork**

The workflow runs by itself on each push to `main`. If the sync dropped the
hook, it commits it back within about a minute. Wait for its green check before
you pull or redeploy, so you pick up that commit.

- Never choose an option that discards or overwrites your fork's own commits:
  that deletes `health/` and the workflow as well.
- If GitHub says the sync has a conflict in `index.js`, it offers a pull
  request to resolve it. Keep both sides: delete only the `<<<<<<<`, `=======`
  and `>>>>>>>` lines. This only happens when upstream edits the line directly
  under `const path = url.pathname;`.
- A red ✗ on the workflow means `index.js` changed so much that the line the
  installer looks for is gone. Add the five hook lines above by hand, right under
  `const path = url.pathname;`.

**Quick check:** open `/health/status`. You should see `checkedAt` and a
`providers` list of objects. If you see `name` and `routes` instead, the hook is
missing.

## Running it locally

- `node health/install-hook.js` — add the hook if it's missing (safe to repeat)
- `node health/install-hook.js --check` — exit 1 if it's missing
- `node --test` (same as `npm test`) — the health tests fail if the hook is
  missing, or if `FALLBACK_PROVIDERS` / the per-provider shows have drifted from
  `index.js` / `scripts/provider-cases.json`

## Tuning

- `HEALTHCHECK_ANILIST_ID` / `HEALTHCHECK_EPISODE` — override the test show for
  every provider (defaults: the per-provider shows above, episode `1`).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/health/status` returns `{ "name": "Anivexa API …", "providers": ["anihq", …] }` | Hook missing from `index.js` | Run the **Keep /health hook** workflow (Actions tab), or `node health/install-hook.js` |
| `providerSource: "fallback"` plus a `warning` | The provider list couldn't be read from the API | Check the API can reach itself; if `npm test` says `FALLBACK_PROVIDERS` is stale, update it |
| A provider shows `HTTP 404` | It isn't registered in `index.js` any more (stale list) | Same as above |
| `ok: false`, `no streams returned` | The provider has no streams for its test show, or it is broken | Try another show with `HEALTHCHECK_ANILIST_ID` |
| `?refresh=1` returns old data | The 30-min rate limit | Wait, or restart the instance |
