# ADR-001: Keep the `/health` hook in `index.js`, and guard it

**Status:** Accepted
**Date:** 2026-11-27
**Deciders:** Project owner

## Context

`GET /health/status` is a custom addition that lives in `health/`. To be
reachable it needs one hook in `index.js`, a file owned by upstream. The repo is
a GitHub fork kept current with "Sync fork" (a merge of upstream into the fork),
so upstream-owned files can change under us at any time.

After an upstream update, `index.js` lost the hook. `/health/status` then fell
through to the API's default JSON response: HTTP 200, wrong shape, no error.
Nothing flagged it, so the status page looked "broken" rather than "unhooked".

Restoring the hook exposed two more problems that had been hidden behind it:

- **Provider discovery failed silently under `server.js`.** It read `GET /`,
  which `server.js` serves as the static landing page (HTML). Discovery threw,
  and the stale `FALLBACK_PROVIDERS` list was used: five removed providers
  (`mkissa`, `anineko`, `anidbapp`, `anibd`, `senshi`) were reported dead with
  `HTTP 404`, while three current ones (`anihq`, `pahenime`, `anipm`) were never
  tested.
- **Every provider was tested with the same show**, while upstream's
  `scripts/provider-cases.json` uses a different show for five providers.

Constraints: upstream owns `index.js`, `server.js`, `package.json` and `api/*`;
the health module must never be able to take the API down; and there should be
no manual step to remember. Upstream recommends self-hosting (`node server.js`)
and the owner syncs from the GitHub web UI, so the fix must not assume `npm
start`, a local checkout, or a particular host.

## Decision

Keep the single hook in `index.js` (as a dynamic import) and make losing it
loud and cheap to fix:

- `health/install-hook.js` — idempotent installer. `node health/install-hook.js`
  restores the hook; `--check` exits 1 if it is missing. The hook goes directly
  under `const path = url.pathname;` in a fixed shape (no blank lines at its
  edges) so merges place it the same way every time.
- `.github/workflows/health-hook.yml` — on every push to the default branch,
  which includes a Sync fork, it runs the installer and commits the result if
  `index.js` changed. It can also be run by hand, and it fails (red ✗) if the
  anchor line is gone.
- `health/health.test.js` — `node --test` fails if the hook is missing, if
  `FALLBACK_PROVIDERS` no longer matches the providers `index.js` registers, or
  if the per-provider shows drift from `scripts/provider-cases.json`.
- Provider discovery tries `/` and then `/_providers` (any unknown path returns
  the same JSON), and the response reports `providerSource` (`discovered` or
  `fallback`) plus a `warning`, so drift is visible instead of silent.
- `package.json` is deliberately left alone: it is upstream-owned and edited
  often, so touching it would add a second place a sync can conflict.

## Options Considered

### Option A: Status quo — hook only, documented in the README

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low |
| Survives upstream updates | No — this is what broke |
| Works on all deploy targets | Yes |
| Maintenance | A manual step someone has to remember |

**Pros:** nothing new to maintain.
**Cons:** failure is silent (HTTP 200, wrong shape) and found late.

### Option B: Hook + guardrails (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low–Med (one script, one workflow, one test file) |
| Survives upstream updates | Mostly — the hook can still be lost, but it is restored automatically and caught by tests |
| Works on all deploy targets | Yes — still a single hook in `index.js`, no host settings involved |
| Maintenance | Tests tell you when lists drift |

**Pros:** keeps the one-touch-point design; recovery needs no action from the
owner; works with the web-UI sync flow.
**Cons:** `index.js` is still an upstream file we edit, so a merge can conflict
(see below); the workflow commits to the fork.

### Option C: A new entry file and a changed start command (no upstream edits)

For example `health/start.js` wraps `worker.fetch` and then imports `server.js`.
This was prototyped against the current `server.js` and works.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low |
| Survives upstream updates | Yes, as long as `server.js` keeps calling `worker.fetch` |
| Works on all deploy targets | No — the host's start command must change; serverless entry points are not covered |
| Maintenance | A setting outside git to remember |

**Pros:** zero upstream edits, so no merge conflicts and no workflow.
**Cons:** if `server.js` changes how it calls the worker, the wrapper stops
applying and fails silently with the original symptom.

### Option D: Probe from outside the API (cron job or sidecar service)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Med–High (separate deployment) |
| Survives upstream updates | Yes — zero upstream touch-points |
| Works on all deploy targets | Needs its own hosting; moves the endpoint off this host |
| Maintenance | A second thing to deploy and monitor |

## Trade-off Analysis

The outage was caused by *silence*, not by the hook itself. Option B removes
the silence (tests, workflow failure, `providerSource`) and the toil (installer
plus workflow) for the cost of a few small files, and keeps the design and URL
unchanged.

In a local simulation of seven kinds of upstream edit to `index.js`, the chosen
placement conflicted in one (upstream adding a line directly under
`const path = url.pathname;`); the other six merged cleanly with the hook intact.
Placing the hook after the OPTIONS block conflicted in two, and the original
placement conflicted when upstream edited the OPTIONS `if` line. No placement is
conflict-proof, which is why the workflow restores the hook whenever a sync or a
conflict resolution loses it.

Option C removes the conflict risk entirely and is the next step if the hook
keeps being lost; it was not chosen first because it depends on a host setting
the project does not control.

## Consequences

- **Easier:** recovering after a sync (nothing to do — the workflow restores the
  hook); noticing drift (a failing test, `providerSource: "fallback"`).
- **Harder:** the workflow adds a commit to the fork after a sync that dropped
  the hook, and a host that auto-deploys may deploy twice (before and after that
  commit), so pull or redeploy after the workflow's green check. Actions must be
  enabled on the fork.
- **To revisit:**
  - The snapshot is cached for 24 h and a real check runs at most every 30 min,
    so a provider that just went down can show `ok` for a long time. Lower
    `CACHE_TTL_MS` in `health/check.js` if fresher status matters.
  - With `CACHE_ENABLED=true` the check goes through the public watch route and
    can be served from the watch cache, masking a provider that just broke.
  - If the hook is lost again despite these guardrails, move to Option C.

## Action Items

1. [x] Restore the hook in `index.js`.
2. [x] Fix discovery, the fallback list and per-provider test shows.
3. [x] Add the installer, workflow and regression tests.
4. [ ] On the fork: add the three files, then run the workflow once (see
       `health/README.md`).
5. [ ] Decide whether 24 h is the right cache TTL for the status page.
