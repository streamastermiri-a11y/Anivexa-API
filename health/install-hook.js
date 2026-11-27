#!/usr/bin/env node
// Puts the /health/* hook back into index.js if an upstream sync removed it.
// Safe to run any number of times — it does nothing when the hook is already there.
//
//   node health/install-hook.js            add the hook if it's missing
//   node health/install-hook.js --check    change nothing; exit 1 if it's missing
//   node health/install-hook.js --file F   work on another index.js (used for testing)
//
// On a GitHub fork, .github/workflows/health-hook.yml runs this for you after every sync.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Any reference to ./health/check.js counts as "installed", including an older hand-written hook.
const HOOK_PATTERN = /["']\.\/health\/check\.js["']/;

// The hook goes right after the request handler reads the URL path.
const ANCHOR = /^([ \t]*)const\s+path\s*=\s*url\.pathname;[ \t]*\r?\n/m;

export function hasHook(src) {
  return HOOK_PATTERN.test(src);
}

function hookLines(indent) {
  return [
    `// [health-hook] routes /health/* to health/check.js. An upstream sync can overwrite index.js;`,
    `// if /health/status stops working, run \`node health/install-hook.js\` (see health/README.md).`,
    `if (request.method !== "OPTIONS" && (path === "/health" || path.startsWith("/health/"))) {`,
    `  return (await import("./health/check.js")).default(request);`,
    `}`,
  ].map((line) => indent + line);
}

// Returns { changed, src }. Throws if index.js no longer has the line we anchor on.
export function installHook(src) {
  if (hasHook(src)) return { changed: false, src };

  const m = ANCHOR.exec(src);
  if (!m) {
    throw new Error(
      'could not find "const path = url.pathname;" in index.js — add the hook by hand (see health/README.md)'
    );
  }

  const eol = m[0].endsWith("\r\n") ? "\r\n" : "\n";
  const at = m.index + m[0].length;
  const nextLineIsBlank = /^[ \t]*\r?\n/.test(src.slice(at));
  // The block goes directly under the anchor line and has no blank line at either
  // edge. That keeps git from sliding it around, so a later "Sync fork" merge sees
  // the same insertion point every time (and only conflicts if upstream edits the
  // line right under `const path = ...`).
  const block = hookLines(m[1]).join(eol) + eol + (nextLineIsBlank ? "" : eol);

  return { changed: true, src: src.slice(0, at) + block + src.slice(at) };
}

function main(argv) {
  try {
    const i = argv.indexOf("--file");
    const file =
      i >= 0
        ? resolve(argv[i + 1] ?? "")
        : resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

    const src = readFileSync(file, "utf8");
    if (hasHook(src)) {
      console.log(`health hook already present in ${file}`);
      return 0;
    }
    if (argv.includes("--check")) {
      console.error(`health hook is MISSING from ${file} — run: node health/install-hook.js`);
      return 1;
    }
    writeFileSync(file, installHook(src).src);
    console.log(`health hook restored in ${file}`);
    return 0;
  } catch (err) {
    console.error(`health hook: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
