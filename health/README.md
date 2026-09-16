# health/

Custom addition, not part of the upstream repo. Lives in its own folder
so `git pull` / branch syncs never touch or conflict with it.

## GET /health/status

Returns a cached pass/fail snapshot for every provider, refreshing
automatically in the background (10-minute cache) rather than
re-testing on every call. Add `?refresh=1` to force a fresh check.

```json
{
  "checkedAt": "2026-09-16T04:00:00.000Z",
  "testAnilistId": "21",
  "testEpisode": "1",
  "providers": [
    { "id": "anikoto", "ok": true,  "ms": 812,  "reason": null },
    { "id": "mkissa",  "ok": false, "ms": 12004, "reason": "timeout" }
  ],
  "fromCache": true
}
```

## The one touch-point outside this folder

`index.js` has a 3-line hook near the very top of the request handler
that routes `/health/*` here — see the comment there. That's the only
change made outside this folder; everything else is self-contained.

## Tuning

- `HEALTHCHECK_ANILIST_ID` / `HEALTHCHECK_EPISODE` — env vars, override
  the test anime used to probe each provider. Defaults to AniList id
  `21` (One Piece), episode `1`, chosen for being carried almost
  everywhere so a failure is more likely to mean the provider is
  actually down rather than just missing this one show.
