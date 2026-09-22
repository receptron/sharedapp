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
// An `import type` / `export type` CLAUSE may cross the line, because it is erased. Nothing else
// may — and `import { type A } from` is NOT that clause: under `verbatimModuleSyntax` it compiles
// to `import {} from`, which still loads the module and so still 404s. This test said otherwise
// until #87, and the form it waved through is the one nobody had written yet.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { reachesIn } from "./importScan.js";

const viewDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "view");

/** Every specifier this file LOADS. `reachesIn` is shared with `test_coreCompat.ts` and has its
 *  own tests in `test_importScan.ts`; a specifier it could not read comes back as a reach whose
 *  specifier is not relative, so it lands here as an offender rather than being waved through. */
const runtimeSpecifiers = (source: string): string[] =>
  reachesIn("view.ts", source)
    .filter((reach) => reach.runtime)
    .map((reach) => reach.specifier);

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
  // scan stops recognising an import.
  assert.deepEqual(runtimeSpecifiers('import { thing } from "../elsewhere.js";'), ["../elsewhere.js"]);
  assert.deepEqual(runtimeSpecifiers('export { thing } from "../elsewhere.js";'), ["../elsewhere.js"]);
  assert.deepEqual(runtimeSpecifiers('import { zod } from "zod";'), ["zod"]);
  // The forms a line-based regex used to miss: no clause at all, a dynamic one, and a clause the
  // author broke over several lines.
  assert.deepEqual(runtimeSpecifiers('import "../elsewhere.js";'), ["../elsewhere.js"]);
  assert.deepEqual(runtimeSpecifiers('const load = () => import("../elsewhere.js");'), ["../elsewhere.js"]);
  assert.deepEqual(runtimeSpecifiers('import {\n  thing,\n} from "../elsewhere.js";'), ["../elsewhere.js"]);
  // Only the CLAUSE-level `type` is erased.
  assert.deepEqual(runtimeSpecifiers('import type { A } from "../appViews.js";'), []);
  assert.deepEqual(runtimeSpecifiers('export type { A } from "../appViews.js";'), []);
  // `import { type A }` is NOT: it compiles to `import {} from`, which loads the module. This is
  // the rule this test had backwards (#87).
  assert.deepEqual(runtimeSpecifiers('import { type A, type B } from "../appViews.js";'), ["../appViews.js"]);
  assert.deepEqual(runtimeSpecifiers('import { a, type B } from "../appViews.js";'), ["../appViews.js"]);
});
