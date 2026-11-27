// Hermetic tests for the /health module — no network, no real providers.
// `npm test` (node --test) picks this file up automatically. Run it alone with:
//   node --test health/health.test.js
//
// The first test is the important one: it fails right after a bad sync if the
// /health hook disappeared from index.js.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.CACHE_ENABLED = "false"; // keep any real cache out of the way
delete process.env.HEALTHCHECK_ANILIST_ID;
delete process.env.HEALTHCHECK_EPISODE;

const { default: healthHandler, __resetForTests } = await import("./check.js");
const { installHook, hasHook, HOOK } = await import("./ensure-hook.js");

const upstreamCases = JSON.parse(
  readFileSync(new URL("../scripts/provider-cases.json", import.meta.url), "utf8")
);

function statusRequest() {
  return new Request("http://localhost/health/status?refresh=1");
}

test("index.js routes /health/ping to the health module (hook is installed)", async () => {
  const { default: worker } = await import("../index.js");
  const res = await worker.fetch(new Request("http://localhost/health/ping"), {});
  const body = await res.json();
  assert.equal(
    body.ok,
    true,
    "GET /health/ping did not reach health/check.js — the /health hook is missing from index.js. " +
      "Fix: node health/ensure-hook.js   (or see health/README.md)"
  );
  assert.equal(body.module, "health/check.js");
  assert.equal(body.mode, "in-process");
});

test("ensure-hook: inserts the hook after the OPTIONS block, and only once", () => {
  const base = [
    "export default {",
    "  async fetch(request, env) {",
    "    const url = new URL(request.url);",
    "    const path = url.pathname;",
    "",
    '    if (request.method === "OPTIONS") {',
    "      return new Response(null, { status: 204 });",
    "    }",
    "",
    "    let m = path.match(/^\\/map\\/(\\d+)\\/?$/);",
    '    return new Response("x");',
    "  },",
    "};",
    "",
  ].join("\n");

  assert.equal(hasHook(base), false);
  const once = installHook(base);
  assert.equal(hasHook(once), true);
  assert.ok(once.includes(HOOK));
  assert.ok(once.indexOf('request.method === "OPTIONS"') < once.indexOf(HOOK), "hook must come after OPTIONS handling");
  assert.ok(once.indexOf(HOOK) < once.indexOf("let m = path.match("), "hook must come before the first route");
  assert.equal(installHook(once), once, "running it again must change nothing");
});

test("ensure-hook: refuses to guess when index.js has no recognisable anchor", () => {
  assert.throws(() => installHook("export default { fetch() {} };\n"), /anchor not found/);
});

test("status: discovers providers live and judges each one by its streams array", async () => {
  __resetForTests();
  const fakeSelf = async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/") return Response.json({ providers: ["alpha", "beta", "gamma", "delta"] });
    if (pathname.startsWith("/watch/alpha/")) return Response.json({ streams: [{ url: "https://x/y.m3u8" }] });
    if (pathname.startsWith("/watch/beta/")) return Response.json({ error: "No episodes found" }, { status: 404 });
    if (pathname.startsWith("/watch/gamma/")) return Response.json({ streams: [] });
    return new Response("<html>oops</html>", { status: 200 });
  };

  const res = await healthHandler(statusRequest(), {}, fakeSelf);
  const body = await res.json();
  const byId = Object.fromEntries(body.providers.map((p) => [p.id, p]));

  assert.equal(body.providerListSource, "live");
  assert.equal(body.fromCache, false);
  assert.equal(byId.alpha.ok, true);
  assert.equal(byId.alpha.reason, null);
  assert.equal(byId.beta.ok, false);
  assert.match(byId.beta.reason, /^HTTP 404: No episodes found/);
  assert.equal(byId.gamma.ok, false);
  assert.equal(byId.gamma.reason, "no streams returned");
  assert.equal(byId.delta.ok, false);
  assert.equal(byId.delta.reason, "response was not JSON");
});

test("status: probes each provider with the show upstream lists for it", async () => {
  __resetForTests();
  const ids = Object.keys(upstreamCases);
  const seen = {};
  const fakeSelf = async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/") return Response.json({ providers: ids });
    const [, , id, anilistId] = pathname.split("/"); // /watch/:id/:anilistId/sub/:id-:ep
    seen[id] = anilistId;
    return Response.json({ streams: [{ url: "u" }] });
  };

  await healthHandler(statusRequest(), {}, fakeSelf);
  for (const id of ids) {
    assert.equal(seen[id], String(upstreamCases[id].anilistId), `${id} should be probed with its own test show`);
  }
});

test("status: if discovery fails it falls back to upstream's provider ids and says so", async () => {
  __resetForTests();
  const probed = [];
  const fakeSelf = async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("/watch/")) {
      probed.push(pathname.split("/")[2]);
      return Response.json({ streams: [{ url: "u" }] });
    }
    return new Response("nope", { status: 500 });
  };

  const body = await (await healthHandler(statusRequest(), {}, fakeSelf)).json();
  assert.equal(body.providerListSource, "fallback");
  assert.deepEqual(probed.sort(), Object.keys(upstreamCases).sort());
});

test("status: a repeat call is served from cache and a forced refresh is throttled", async () => {
  __resetForTests();
  let watchCalls = 0;
  const fakeSelf = async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/") return Response.json({ providers: ["alpha"] });
    watchCalls++;
    return Response.json({ streams: [{ url: "u" }] });
  };

  const first = await (await healthHandler(statusRequest(), {}, fakeSelf)).json();
  const again = await (await healthHandler(new Request("http://localhost/health/status"), {}, fakeSelf)).json();
  const forced = await (await healthHandler(statusRequest(), {}, fakeSelf)).json();

  assert.equal(first.fromCache, false);
  assert.equal(again.fromCache, true);
  assert.equal(forced.fromCache, true);
  assert.equal(forced.refreshThrottled, true);
  assert.ok(forced.nextRealCheckAt);
  assert.equal(watchCalls, 1, "only the first call should have run a real check");
});
