// The `view` subpath must be servable ON ITS OWN.
//
// MulmoTerminal's headless preview serves `dist/view` over loopback and nothing else — an
// allow-list built from that directory — because the harness is an ES module whose imports need a
// real base URL. A module here that reaches a SIBLING of the directory is therefore a 404 at load
// time, and an ES module graph that 404s does not degrade: nothing parses, so the page never
// readies and the run reports the author's page as the one that never answered.
//
// That is why this is a test about the SOURCE rather than about behaviour. Every other test in
// this package imports these modules directly, where a `../` resolves perfectly well; the only
// thing that could see the fault was a browser, and it saw it as somebody else's bug.
//
// A TYPE import may cross the line, because it is erased. Nothing else may.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const viewDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "view");

/** Every `import`/`export ... from` that is NOT type-only, with its specifier. */
const runtimeSpecifiers = (source: string): string[] => {
  const found: string[] = [];
  for (const line of source.split("\n")) {
    const match = /^\s*(?:import|export)\s+(?!type\s)([^;]*?)from\s+"([^"]+)"/u.exec(line);
    if (match === null) continue;
    // `import { type A, type B } from` is erased whole; `import { a, type B }` is not.
    const named = match[1] ?? "";
    const inner = /^\s*\{([^}]*)\}\s*$/u.exec(named)?.[1];
    if (inner !== undefined && inner.split(",").every((part) => part.trim() === "" || part.trim().startsWith("type "))) continue;
    found.push(match[2] ?? "");
  }
  return found;
};

test("nothing under `view/` imports anything outside it at runtime", () => {
  const offenders: string[] = [];
  for (const name of readdirSync(viewDir).filter((entry) => entry.endsWith(".ts"))) {
    const source = readFileSync(path.join(viewDir, name), "utf8");
    for (const specifier of runtimeSpecifiers(source)) {
      // A bare specifier would be a dependency, which this subpath has none of and must not grow:
      // the harness serves files, not a resolver.
      if (specifier.startsWith("../") || !specifier.startsWith(".")) offenders.push(`${name} -> ${specifier}`);
    }
  }
  assert.deepEqual(offenders, [], "these would 404 in MulmoTerminal's headless preview and take the whole runtime down");
});

test("the check can actually see an offender", () => {
  // Otherwise the test above passes by matching nothing, which is how it would look on the day the
  // regex stops recognising an import.
  assert.deepEqual(runtimeSpecifiers('import { thing } from "../elsewhere.js";'), ["../elsewhere.js"]);
  assert.deepEqual(runtimeSpecifiers('export { thing } from "../elsewhere.js";'), ["../elsewhere.js"]);
  assert.deepEqual(runtimeSpecifiers('import { zod } from "zod";'), ["zod"]);
  // And that it lets an erased one through.
  assert.deepEqual(runtimeSpecifiers('import type { A } from "../appViews.js";'), []);
  assert.deepEqual(runtimeSpecifiers('import { type A, type B } from "../appViews.js";'), []);
  // A mixed one is NOT erased, so it counts.
  assert.deepEqual(runtimeSpecifiers('import { a, type B } from "../appViews.js";'), ["../appViews.js"]);
});
