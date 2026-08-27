// Which config blocks count as a silencing override, what removing one leaves behind, and what a
// probe's answer means.
//
// The pairing matters as much as it does for the publish gate: a predicate that accepted NOTHING
// would report "all 0 silencing overrides still suppress something" and pass, while the check it
// powers looked at nothing at all. That is the shape of the bug this check exists to catch, so
// every refusal below sits beside the block that must still be accepted.
//
// Three of these tests exist because a reviewer found the case, and all three were the SAME
// failure — a block the predicate did not recognise and dropped in silence, which reads exactly
// like a clean run.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deadProbes,
  failed,
  withoutRule,
  renderReport,
  select,
  unexpectedPresets,
  EXPECTED_PRESETS,
  type Probe,
  type Override,
} from "../scripts/overrides-report.js";

const DEBT = { files: ["src/publishChecks.ts"], rules: { "max-lines": "warn" } };

const rulesOf = (config: readonly unknown[]): string[] => select(config).overrides.map((override) => override.rule);

test("a hand-written silencing block is an override, in both the warn and off forms", () => {
  assert.deepEqual(select([DEBT]).overrides, [{ index: 0, pattern: "src/publishChecks.ts", rule: "max-lines" }]);
  assert.deepEqual(rulesOf([{ files: ["test/a.ts"], rules: { "sonarjs/code-eval": "off" } }]), ["sonarjs/code-eval"]);
});

test("numeric severities say the same thing as the words", () => {
  assert.deepEqual(rulesOf([{ files: ["a.ts"], rules: { x: 0 } }]), ["x"]);
  assert.deepEqual(rulesOf([{ files: ["a.ts"], rules: { x: 1 } }]), ["x"]);
  assert.deepEqual(rulesOf([{ files: ["a.ts"], rules: { x: 2 } }]), []);
});

test("a severity written with options is read from its first element", () => {
  assert.deepEqual(rulesOf([{ files: ["a.ts"], rules: { "max-lines": ["warn", { max: 600 }] } }]), ["max-lines"]);
  assert.deepEqual(rulesOf([{ files: ["a.ts"], rules: { "max-lines": ["error", { max: 600 }] } }]), []);
});

test("a block carrying languageOptions is still an override — that is where the scripts exemptions live", () => {
  const scripts = { files: ["scripts/**/*.ts"], languageOptions: { globals: { console: "readonly" } }, rules: { "no-console": "off" } };
  assert.deepEqual(rulesOf([scripts]), ["no-console"]);
});

/** A block that silences one rule and raises another is not two-thirds of an exemption; it holds a
 *  real one. An earlier predicate took a block to be silencing only if EVERY rule in it was, so
 *  `x` here vanished whole and was never measured — a false LIVE wearing the check's own uniform. */
test("a MIXED block yields its silencing rules and drops only the enforced ones", () => {
  assert.deepEqual(rulesOf([{ files: ["a.ts"], rules: { x: "off", y: "error" } }]), ["x"]);
  assert.deepEqual(rulesOf([{ files: ["a.ts"], rules: { x: "off", y: "warn" } }]), ["x", "y"]);
  assert.deepEqual(rulesOf([{ files: ["a.ts"], rules: { y: "error" } }]), []);
});

/** ESLint's AND form, `files: [["src/*", "**\/*.ts"]]`, is legal and unsupported here. What must not
 *  happen is dropping it quietly, because a real exemption would then stop being measured and the
 *  count would still read as complete. */
test("a files shape this module cannot read is REPORTED, never skipped", () => {
  const nested = select([{ files: [["src/*", "**/*.ts"]], rules: { x: "off" } }]);
  assert.deepEqual(nested.overrides, []);
  assert.equal(nested.unclassified.length, 1);
  assert.match(nested.unclassified[0]?.why ?? "", /only an array of plain patterns/);

  const unknownSeverity = select([{ files: ["a.ts"], rules: { x: "sometimes" } }]);
  assert.deepEqual(unknownSeverity.overrides, []);
  assert.match(unknownSeverity.unclassified[0]?.why ?? "", /neither silencing nor enforcing/);

  // and the neighbouring shapes that must still be read
  assert.equal(select([DEBT]).unclassified.length, 0);
});

test("an empty files list names nothing to measure, and says so", () => {
  const empty = select([{ files: [], rules: { x: "off" } }]);
  assert.deepEqual(empty.overrides, []);
  assert.equal(empty.unclassified.length, 1);
});

/** A preset ships defaults nobody here maintains — `typescript-eslint/eslint-recommended` turns off
 *  twenty-three core rules the compiler covers — so measuring it produces DEAD rows telling a
 *  maintainer to delete something they do not own. The set of them is PINNED rather than noted: a
 *  list in a passing log is not a gate, because most green logs are never read. */
test("named blocks are presets: counted, not measured", () => {
  const chosen = select([{ name: "some/preset", files: ["a.ts"], rules: { x: "off" } }, DEBT]);
  assert.deepEqual(
    chosen.overrides.map((override) => override.rule),
    ["max-lines"],
  );
  assert.deepEqual(chosen.presets, [{ index: 0, name: "some/preset" }]);
  assert.equal(chosen.unclassified.length, 0);
});

test("blocks that are not per-file exemptions at all are passed over silently", () => {
  const chosen = select([{ rules: { x: "off" } }, { files: ["a.ts"] }, "not a block", null, DEBT]);
  assert.deepEqual(
    chosen.overrides.map((override) => override.rule),
    ["max-lines"],
  );
  assert.deepEqual(chosen.unclassified, []);
  assert.deepEqual(chosen.presets, []);
});

test("the override remembers WHERE it was, because the probe depends on it", () => {
  const chosen = select(["filler", { files: ["a.ts"], rules: { x: "off" } }]);
  assert.equal(chosen.overrides[0]?.index, 1);
});

/** ASKING THE QUESTION INSTEAD OF A PROXY FOR IT. Two earlier versions forced the rule to `error`
 *  and counted what it reported, which beats whatever ELSE silences the same rule over the same
 *  files — so an exemption already covered by another one was called live. Measured on a
 *  three-block config over one file, twice:
 *
 *      a LATER block silencing the same rule       forced: 1   removed: 0
 *      an EARLIER named preset silencing it        forced: 1   removed: 0
 *
 *  Removing the rule from its own block has no such blind spot, and it is what "delete this
 *  exemption" actually means. */
test("withoutRule drops the one rule from the one block, and leaves every other block alone", () => {
  const config = [
    { files: ["a.ts"], rules: { x: "off", y: "warn" } },
    { files: ["a.ts"], rules: { x: "off" } },
    { files: ["b.ts"], rules: { x: "off" } },
  ];
  const override: Override = { index: 1, pattern: "a.ts", rule: "x" };
  assert.deepEqual(withoutRule(config, override), [
    { files: ["a.ts"], rules: { x: "off", y: "warn" } },
    { files: ["a.ts"], rules: {} },
    { files: ["b.ts"], rules: { x: "off" } },
  ]);
});

test("withoutRule keeps everything else in the block — the scripts exemption carries its globals there", () => {
  const scripts = { files: ["scripts/**/*.ts"], languageOptions: { globals: { console: "readonly" } }, rules: { "no-console": "off", "no-eval": "off" } };
  assert.deepEqual(withoutRule([scripts], { index: 0, pattern: "scripts/**/*.ts", rule: "no-console" }), [
    { files: ["scripts/**/*.ts"], languageOptions: { globals: { console: "readonly" } }, rules: { "no-eval": "off" } },
  ]);
});

test("withoutRule is a no-op where there is nothing to remove", () => {
  const config = [{ files: ["a.ts"], rules: { y: "off" } }];
  assert.deepEqual(withoutRule(config, { index: 0, pattern: "a.ts", rule: "x" }), config);
  assert.deepEqual(withoutRule(config, { index: 9, pattern: "a.ts", rule: "y" }), config);
  assert.deepEqual(withoutRule([{ files: ["a.ts"] }], { index: 0, pattern: "a.ts", rule: "y" }), [{ files: ["a.ts"] }]);
});

const probe = (rule: string, reports: number, pattern = "a.ts"): Probe => ({ index: 0, pattern, rule, reports });

test("a probe is dead when the rule it silences reports nothing, and only then", () => {
  assert.deepEqual(deadProbes([probe("x", 0), probe("y", 1), probe("z", 99)]), [probe("x", 0)]);
  assert.deepEqual(deadProbes([probe("y", 1)]), []);
  assert.deepEqual(deadProbes([]), []);
});

test("the report names the dead ones and says so in its verdict", () => {
  const clean = renderReport([probe("x", 3)], [], []);
  assert.match(clean, /^live {2}x {2}<- {2}a\.ts$/m);
  assert.match(clean, /all 1 silencing overrides still suppress something/);
  assert.doesNotMatch(clean, /DEAD/);

  const rotten = renderReport([probe("x", 3), probe("y", 0)], [], []);
  assert.match(rotten, /^DEAD {2}y {2}<- {2}a\.ts$/m);
  assert.match(rotten, /1 of 2 silencing overrides suppress NOTHING/);
});

test("an unreadable block is in the report and in the verdict, even with nothing dead", () => {
  const report = renderReport([probe("x", 3)], [{ index: 4, why: "files is 7" }], []);
  assert.match(report, /UNREAD {2}eslint\.config\.js element 4: files is 7/);
  assert.match(report, /1 block\(s\) could not be read/);
});

/** WHICH blocks, not how many. A count says "something was not looked at"; a list says which, so a
 *  hand-written block that acquired a `name` and dropped out of the measurement can be recognised
 *  by the person reading the report rather than only by whoever wrote this module. */
test("the unmeasured blocks are always NAMED in the report, in both verdicts", () => {
  assert.match(
    renderReport(
      [probe("x", 1)],
      [],
      [
        { index: 4, name: "a/one" },
        { index: 7, name: "b/two" },
      ],
    ),
    /not measured: 4:a\/one, 7:b\/two/,
  );
  assert.match(
    renderReport(
      [probe("x", 0)],
      [],
      [
        { index: 4, name: "a/one" },
        { index: 7, name: "b/two" },
      ],
    ),
    /not measured: 4:a\/one, 7:b\/two/,
  );
  assert.match(renderReport([probe("x", 1)], [], []), /no named blocks/);
});

test("the run fails on a dead override OR an unreadable block, and passes on neither", () => {
  assert.equal(failed([probe("x", 1)], [], []), false);
  assert.equal(failed([probe("x", 0)], [], []), true);
  assert.equal(failed([probe("x", 1)], [{ index: 0, why: "why" }], []), true);
  assert.equal(failed([], [], []), false);
});

test("the dead rows come last, so a truncated log keeps the actionable half", () => {
  const lines = renderReport([probe("dead", 0), probe("live", 2)], [], []).split("\n");
  assert.ok(lines.indexOf("live  live  <-  a.ts") < lines.indexOf("DEAD  dead  <-  a.ts"));
});

/** A block naming two files can be HALF dead: with the exemption gone one file still reports and
 *  the other does not. Summing them let the living half hide the stale one, and four of this
 *  repository's exemptions name two files or more. */
test("a block naming several files yields one override per file", () => {
  const chosen = select([{ files: ["a.ts", "b.ts"], rules: { x: "off", y: "warn" } }]);
  assert.deepEqual(chosen.overrides, [
    { index: 0, pattern: "a.ts", rule: "x" },
    { index: 0, pattern: "b.ts", rule: "x" },
    { index: 0, pattern: "a.ts", rule: "y" },
    { index: 0, pattern: "b.ts", rule: "y" },
  ]);
});

test("half of a multi-file exemption going quiet is a failure, not an average", () => {
  const half = [probe("x", 3, "a.ts"), probe("x", 0, "b.ts")];
  assert.deepEqual(deadProbes(half), [probe("x", 0, "b.ts")]);
  assert.equal(failed(half, [], []), true);
  assert.match(renderReport(half, [], []), /^DEAD {2}x {2}<- {2}b\.ts$/m);
});

/** A LIST of unmeasured blocks in a passing log is not a gate: most green logs are never read. The
 *  set is pinned, so a dependency shipping a new named config — or a hand-written block acquiring a
 *  `name` and dropping out of the measurement — turns the job red once and someone looks. */
test("an unexpected named block fails the run; an expected one does not", () => {
  const expected = { index: 4, name: EXPECTED_PRESETS[0] ?? "" };
  const ours = { index: 9, name: "our/own-block" };
  assert.deepEqual(unexpectedPresets([expected]), []);
  assert.deepEqual(unexpectedPresets([expected, ours]), [ours]);
  assert.equal(failed([probe("x", 1)], [], [expected]), false);
  assert.equal(failed([probe("x", 1)], [], [expected, ours]), true);
});

test("EXPECTED_PRESETS names the blocks this repo really has, not an empty ratchet", () => {
  assert.ok(EXPECTED_PRESETS.length > 0, "an empty list would pin nothing and pass everything that is named");
  EXPECTED_PRESETS.forEach((name) => {
    assert.match(name, /\//, `${name} does not look like a package's own config name`);
  });
});

/** A negated pattern is not a lint TARGET: handing `"!x"` to `lintFiles` matches nothing, so the
 *  exemption would answer DEAD while doing its job — a false DEAD, which sends someone to delete a
 *  live exemption. None exist in this repository today; the point is that the day one does, the
 *  check says so instead of getting it quietly wrong. */
test("a negated files pattern is REPORTED, never measured as if it were a path", () => {
  const negated = select([{ files: ["src/**/*.ts", "!src/byText.ts"], rules: { x: "off" } }]);
  assert.deepEqual(negated.overrides, []);
  assert.equal(negated.unclassified.length, 1);
  assert.match(negated.unclassified[0]?.why ?? "", /negated pattern/);

  // the neighbouring shape that must still be measured
  assert.deepEqual(select([{ files: ["src/**/*.ts"], rules: { x: "off" } }]).overrides, [{ index: 0, pattern: "src/**/*.ts", rule: "x" }]);
});

/** A GLOB is one line in the config and comes out whole, so it is dead only when nothing it matches
 *  needs it. Measuring per matched file would report every file under the glob that happens not to
 *  need the rule — measured here, removing the `require-await` exemption for `test/**` leaves 21
 *  findings across 4 of the 29 files it matches, so per-file would print 25 DEAD rows for a line
 *  nobody can delete. The unit is what a person would remove. */
test("a glob is one override, not one per file it matches", () => {
  assert.deepEqual(select([{ files: ["test/**/*.ts"], rules: { x: "off" } }]).overrides, [{ index: 0, pattern: "test/**/*.ts", rule: "x" }]);
});
