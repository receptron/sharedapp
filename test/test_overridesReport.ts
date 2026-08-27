// Which config blocks count as a silencing override, and what a probe's answer means.
//
// The pairing matters as much as it does for the publish gate: a predicate that accepted NOTHING
// would report "all 0 overrides still suppress something" and pass, while the check it powers
// looked at nothing at all. That is the exact shape of the bug this check exists to catch, so
// every refusal below sits beside the neighbouring block that must still be accepted.

import { test } from "node:test";
import assert from "node:assert/strict";

import { deadProbes, probesFor, renderReport, silencingOverrideOf, silencingOverrides, type Probe } from "../scripts/overrides-report.js";

const DEBT = { files: ["src/publishChecks.ts"], rules: { "max-lines": "warn" } };

test("a hand-written silencing block is an override, in both the warn and off forms", () => {
  assert.deepEqual(silencingOverrideOf(DEBT), { files: ["src/publishChecks.ts"], rules: ["max-lines"] });
  assert.deepEqual(silencingOverrideOf({ files: ["test/a.ts"], rules: { "sonarjs/code-eval": "off" } }), {
    files: ["test/a.ts"],
    rules: ["sonarjs/code-eval"],
  });
});

test("numeric severities say the same thing as the words", () => {
  assert.deepEqual(silencingOverrideOf({ files: ["a.ts"], rules: { x: 0 } }), { files: ["a.ts"], rules: ["x"] });
  assert.deepEqual(silencingOverrideOf({ files: ["a.ts"], rules: { x: 1 } }), { files: ["a.ts"], rules: ["x"] });
  assert.equal(silencingOverrideOf({ files: ["a.ts"], rules: { x: 2 } }), null);
});

test("a severity written with options is read from its first element", () => {
  assert.deepEqual(silencingOverrideOf({ files: ["a.ts"], rules: { "max-lines": ["warn", { max: 600 }] } }), { files: ["a.ts"], rules: ["max-lines"] });
  assert.equal(silencingOverrideOf({ files: ["a.ts"], rules: { "max-lines": ["error", { max: 600 }] } }), null);
});

test("a block carrying languageOptions is still an override — that is where the scripts exemptions live", () => {
  const scripts = { files: ["scripts/**/*.ts"], languageOptions: { globals: { console: "readonly" } }, rules: { "no-console": "off" } };
  assert.deepEqual(silencingOverrideOf(scripts), { files: ["scripts/**/*.ts"], rules: ["no-console"] });
});

test("a block that RAISES any rule is a gate, not an exemption", () => {
  assert.equal(silencingOverrideOf({ files: ["a.ts"], rules: { x: "off", y: "error" } }), null);
  assert.deepEqual(silencingOverrideOf({ files: ["a.ts"], rules: { x: "off", y: "warn" } }), { files: ["a.ts"], rules: ["x", "y"] });
});

test("a block with no files, or no rules, names nothing to measure", () => {
  assert.equal(silencingOverrideOf({ rules: { x: "off" } }), null);
  assert.equal(silencingOverrideOf({ files: [], rules: { x: "off" } }), null);
  assert.equal(silencingOverrideOf({ files: ["a.ts"], rules: {} }), null);
  assert.equal(silencingOverrideOf({ files: ["a.ts"] }), null);
});

test("nothing that is not a block survives the predicate", () => {
  [null, undefined, 0, "", "files", [], { files: "a.ts", rules: { x: "off" } }, { files: [1], rules: { x: "off" } }, { files: ["a.ts"], rules: null }].forEach(
    (value) => {
      assert.equal(silencingOverrideOf(value), null, `accepted ${JSON.stringify(value)}`);
    },
  );
});

test("silencingOverrides keeps the config's own order and drops the presets", () => {
  const config = [{ name: "preset", rules: { a: "error" } }, DEBT, { files: ["b.ts"], rules: { z: "off" } }, "not a block"];
  assert.deepEqual(
    silencingOverrides(config).map((override) => override.rules),
    [["max-lines"], ["z"]],
  );
});

test("one probe per rule, because a block can be dead in one rule and live in another", () => {
  assert.deepEqual(probesFor([{ files: ["a.ts"], rules: ["x", "y"] }]), [
    { files: ["a.ts"], rule: "x" },
    { files: ["a.ts"], rule: "y" },
  ]);
  assert.deepEqual(probesFor([]), []);
});

const probe = (rule: string, reports: number): Probe => ({ files: ["a.ts"], rule, reports });

test("a probe is dead when the rule it silences reports nothing, and only then", () => {
  assert.deepEqual(deadProbes([probe("x", 0), probe("y", 1), probe("z", 99)]), [probe("x", 0)]);
  assert.deepEqual(deadProbes([probe("y", 1)]), []);
  assert.deepEqual(deadProbes([]), []);
});

test("the report names the dead ones and says so in its verdict", () => {
  const clean = renderReport([probe("x", 3)]);
  assert.match(clean, /^live {2}x {2}<- {2}a\.ts$/m);
  assert.match(clean, /all 1 silencing overrides still suppress something/);
  assert.doesNotMatch(clean, /DEAD/);

  const rotten = renderReport([probe("x", 3), probe("y", 0)]);
  assert.match(rotten, /^DEAD {2}y {2}<- {2}a\.ts$/m);
  assert.match(rotten, /1 of 2 silencing overrides suppress NOTHING/);
});

test("the dead rows come last, so a truncated log keeps the actionable half", () => {
  const lines = renderReport([probe("dead", 0), probe("live", 2)]).split("\n");
  assert.ok(lines.indexOf("live  live  <-  a.ts") < lines.indexOf("DEAD  dead  <-  a.ts"));
});

test("an empty config is reported as such, never as a pass", () => {
  assert.match(renderReport([]), /all 0 silencing overrides still suppress something/);
});
