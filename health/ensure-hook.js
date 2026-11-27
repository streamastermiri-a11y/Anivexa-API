// health/ensure-hook.js — (re)installs the /health hook into index.js.
//
//   node health/ensure-hook.js           add the hook if a sync removed it (safe to run any time)
//   node health/ensure-hook.js --check   only report; exit 1 if the hook is missing
//
// Idempotent: if the hook is already there, it does nothing. If it can't find
// where to put it (upstream restructured index.js), it changes nothing and
// exits with code 2 so you know to add the hook by hand (see health/README.md).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HOOK_MARKER = "health/check.js";

export const HOOK = `    // [fork] /health/* → health/check.js (see health/README.md)
    if (path === "/health" || path.startsWith("/health/")) {
      return (await import("./health/check.js")).default(request, env, this?.fetch && ((r) => this.fetch(r, env)));
    }

`;

// The hook goes right before the first route (after the CORS/OPTIONS block).
const ANCHOR = /^[ \t]*let m = path\.match\(/m;

export function hasHook(src) {
  return src.includes(HOOK_MARKER);
}

// Returns the new source, or throws if there's nowhere to put the hook.
export function installHook(src) {
  if (hasHook(src)) return src;
  const hit = ANCHOR.exec(src);
  if (!hit) throw new Error("anchor not found: could not find the first `let m = path.match(` route in index.js");
  const hook = src.includes("\r\n") ? HOOK.replace(/\n/g, "\r\n") : HOOK;
  return src.slice(0, hit.index) + hook + src.slice(hit.index);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const indexPath = fileURLToPath(new URL("../index.js", import.meta.url));
  const checkOnly = process.argv.includes("--check");
  const src = readFileSync(indexPath, "utf8");

  if (hasHook(src)) {
    console.log("✓ /health hook is already in index.js — nothing to do.");
  } else if (checkOnly) {
    console.error("✗ /health hook is MISSING from index.js (a sync probably replaced it). Run: node health/ensure-hook.js");
    process.exit(1);
  } else {
    try {
      writeFileSync(indexPath, installHook(src));
      console.log("✓ Re-added the /health hook to index.js.");
    } catch (err) {
      console.error(`✗ ${err.message}\n  Add the hook by hand — see health/README.md ("The one touch-point outside this folder").`);
      process.exit(2);
    }
  }
}
