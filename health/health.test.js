// Run with `npm test`. Guards the things that have broken /health/status after
// upstream updates: the index.js hook disappearing, the provider list going
// stale, and the per-provider test cases drifting from upstream's.
//
// No network is used: global fetch is stubbed, so these run offline and fast.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Env overrides would change which show each provider is tested with — start clean.
delete process.env.HEALTHCHECK_ANILIST_ID;
delete process.env.HEALTHCHECK_EPISODE;

const { default: worker } = await import("../index.js");
const { FALLBACK_PROVIDERS, testCaseFor, _resetHealthStateForTests } = await import("./check.js");
const { hasHook, installHook } = await import("./install-hook.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── helpers ─────────────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
let calls = [];

function stubFetch(route) {
  calls = [];
  globalThis.fetch = async (input) => {
    const { pathname } = new URL(typeof input === "string" ? input : input.url);
    calls.push(pathname);
    return route(pathname);
  };
}

const providersJson = (...ids) => Response.json({ providers: ids });
const streams = () => Response.json({ streams: [{ url: "https://example.test/a.m3u8" }] });
const landingPage = () =>
  new Response("<!doctype html><title>landing</title>", { headers: { "Content-Type": "text/html" } });

const status = (query = "?refresh=1") =>
  worker.fetch(new Request(`http://localhost/health/status${query}`), {});

beforeEach(() => _resetHealthStateForTests());
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── the hook ────────────────────────────────────────────────────────────────
test("index.js still routes /health/* to health/check.js", () => {
  const src = readFileSync(join(root, "index.js"), "utf8");
  assert.ok(hasHook(src), "the /health hook is missing from index.js — run `node health/install-hook.js`");
});

test("install-hook adds a missing hook exactly once and keeps the file's line endings", () => {
  const sample = [
    "export default {",
    "  async fetch(request, env) {",
    "    const url  = new URL(request.url);",
    "    const path = url.pathname;",
    "",
    '    if (request.method === "OPTIONS") return new Response(null);',
    "  },",
    "};",
    "",
  ];

  for (const eol of ["\n", "\r\n"]) {
    const src = sample.join(eol);
    assert.equal(hasHook(src), false);

    const first = installHook(src);
    assert.equal(first.changed, true);
    assert.ok(hasHook(first.src));
    assert.ok(
      first.src.indexOf("health/check.js") < first.src.indexOf("return new Response(null)"),
      "the hook must run before the rest of the handler"
    );
    assert.match(first.src, /const path = url\.pathname;\r?\n\s*\/\/ \[health-hook\]/, "hook goes right under the path line");
    assert.equal(installHook(first.src).changed, false, "second install must be a no-op");
    if (eol === "\r\n") assert.ok(!/(^|[^\r])\n/.test(first.src), "mixed line endings");
  }

  assert.throws(() => installHook("export default {};"), /could not find/);
});

test("the hook does not hijack similarly named paths or CORS preflights", async () => {
  stubFetch(() => {
    throw new Error("no network calls expected");
  });

  const preflight = await worker.fetch(
    new Request("http://localhost/health/status", { method: "OPTIONS" }),
    {}
  );
  assert.equal(preflight.status, 204);

  const other = await worker.fetch(new Request("http://localhost/healthz"), {});
  assert.ok((await other.json()).name, "/healthz should fall through to the normal API response");

  assert.equal(calls.length, 0);
});

// ── drift guards ────────────────────────────────────────────────────────────
test("FALLBACK_PROVIDERS matches the providers index.js registers", async () => {
  const res = await worker.fetch(new Request("http://localhost/_providers"), {});
  const { providers } = await res.json();
  assert.deepEqual(
    [...FALLBACK_PROVIDERS].sort(),
    [...providers].sort(),
    "FALLBACK_PROVIDERS in health/check.js is out of date — make it match the providers listed in index.js"
  );
});

test("per-provider test cases match upstream's scripts/provider-cases.json", () => {
  const cases = JSON.parse(readFileSync(join(root, "scripts", "provider-cases.json"), "utf8"));
  for (const [id, c] of Object.entries(cases)) {
    assert.equal(
      testCaseFor(id).anilistId,
      c.anilistId,
      `${id}: health/check.js tests it with a different show than scripts/provider-cases.json`
    );
  }
});

// ── the endpoint ────────────────────────────────────────────────────────────
test("GET /health/status returns the snapshot, testing each provider with its own show", async () => {
  stubFetch((p) => {
    if (p === "/") return providersJson("alpha", "animenosub");
    if (p.startsWith("/watch/alpha/")) return streams();
    return Response.json({ streams: [] });
  });

  const res = await status();
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.providerSource, "discovered");
  assert.equal(body.fromCache, false);
  assert.deepEqual(
    body.providers.map((p) => [p.id, p.ok, p.reason]),
    [["alpha", true, null], ["animenosub", false, "no streams returned"]]
  );
  assert.ok(calls.includes("/watch/alpha/16498/sub/alpha-1"));
  assert.ok(calls.includes("/watch/animenosub/113415/sub/animenosub-1"));
});

test("a second call is served from cache without re-checking providers", async () => {
  stubFetch((p) => (p === "/" ? providersJson("alpha") : streams()));
  await status();
  const before = calls.length;

  const again = await (await status("")).json();
  assert.equal(again.fromCache, true);
  assert.equal(calls.length, before);
});

test("reports HTTP and network errors per provider instead of failing the whole check", async () => {
  stubFetch((p) => {
    if (p === "/") return providersJson("broken", "offline");
    if (p.startsWith("/watch/broken/")) return new Response("boom", { status: 500 });
    throw new Error("connect ECONNREFUSED");
  });

  const body = await (await status()).json();
  assert.deepEqual(
    body.providers.map((p) => [p.id, p.ok, p.reason]),
    [["broken", false, "HTTP 500"], ["offline", false, "connect ECONNREFUSED"]]
  );
});

test("discovery falls through when '/' is the static landing page (as under server.js)", async () => {
  stubFetch((p) => {
    if (p === "/") return landingPage();
    if (p === "/_providers") return providersJson("alpha", "beta");
    return streams();
  });

  const body = await (await status()).json();
  assert.equal(body.providerSource, "discovered");
  assert.deepEqual(body.providers.map((p) => p.id), ["alpha", "beta"]);
});

test("falls back to FALLBACK_PROVIDERS, and says so, when discovery fails", async () => {
  stubFetch((p) => {
    if (p === "/") return landingPage();
    if (p === "/_providers") return new Response("nope", { status: 404 });
    return streams();
  });

  const body = await (await status()).json();
  assert.equal(body.providerSource, "fallback");
  assert.match(body.warning, /FALLBACK_PROVIDERS/);
  assert.deepEqual(body.providers.map((p) => p.id), FALLBACK_PROVIDERS);
});
