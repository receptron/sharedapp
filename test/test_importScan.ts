// The scan two guards depend on, held in BOTH directions.
//
// A source scan that misses a form passes every assertion about what it did not find, which is
// indistinguishable from a clean tree until the day someone writes that form. So the shapes it must
// see are pinned beside the near-misses it must not count — and the near-misses are the half that
// fails when a matcher quietly stops matching.

import { test } from "node:test";
import assert from "node:assert/strict";

import { reachesIn, UNRESOLVED, type ModuleReach } from "./importScan.js";

const M = "../elsewhere.js";

const SEES: [string, ModuleReach[]][] = [
  [`import { a, type B } from "${M}";`, [{ specifier: M, runtime: true, values: ["a"], types: ["B"] }]],
  // Not erased: this compiles to `import {} from "…"`, which still loads the module.
  [`import { type A } from "${M}";`, [{ specifier: M, runtime: true, values: [], types: ["A"] }]],
  [`import { type A, type B } from "${M}";`, [{ specifier: M, runtime: true, values: [], types: ["A", "B"] }]],
  // Erased whole — the clause carries the `type`, not the elements.
  [`import type { A } from "${M}";`, [{ specifier: M, runtime: false, values: [], types: ["A"] }]],
  [`export type { A } from "${M}";`, [{ specifier: M, runtime: false, values: [], types: ["A"] }]],
  [`import d, * as ns from "${M}";`, [{ specifier: M, runtime: true, values: ["default", "*"], types: [] }]],
  [`import "${M}";`, [{ specifier: M, runtime: true, values: [], types: [] }]],
  [`const load = () => import("${M}");`, [{ specifier: M, runtime: true, values: ["*"], types: [] }]],
  [`export { a } from "${M}";`, [{ specifier: M, runtime: true, values: ["a"], types: [] }]],
  [`export * from "${M}";`, [{ specifier: M, runtime: true, values: ["*"], types: [] }]],
  [`export * as ns from "${M}";`, [{ specifier: M, runtime: true, values: ["*"], types: [] }]],
  [`import {\n  a,\n  b,\n} from "${M}";`, [{ specifier: M, runtime: true, values: ["a", "b"], types: [] }]],
  // A specifier it cannot read is a reach of its own, so a caller's pins go red rather than passing.
  [`const load = (p: string) => import(p);`, [{ specifier: UNRESOLVED, runtime: true, values: ["*"], types: [] }]],
];

const COUNTS_NOTHING: string[] = [
  `// import { a } from "${M}";`,
  `/* import { a } from "${M}"; */`,
  `const text = 'import { a } from "${M}"';`,
  `const text = \`import { a } from "${M}"\`;`,
  `export const a = 1;`,
];

test("the scan sees every form that makes a module load", () => {
  SEES.forEach(([source, expected]) => {
    assert.deepEqual(reachesIn("probe.ts", source), expected, source);
  });
});

test("the scan counts nothing that does not reach a module", () => {
  COUNTS_NOTHING.forEach((source) => {
    assert.deepEqual(reachesIn("probe.ts", source), [], source);
  });
});

test("the scan reads every reach in one file, not just the first", () => {
  const source = [`import { a } from "./one.js";`, `import type { B } from "./two.js";`, `import "./three.js";`, `export { c } from "./four.js";`].join("\n");
  assert.deepEqual(
    reachesIn("probe.ts", source).map((reach) => `${reach.specifier} ${reach.runtime ? "loads" : "erased"}`),
    ["./one.js loads", "./two.js erased", "./three.js loads", "./four.js loads"],
  );
});
