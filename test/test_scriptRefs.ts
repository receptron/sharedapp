/** The two release gates are named in `package.json` and named AGAIN, by hand, where they are
 *  run. This pins that pairing, and it is deliberately SMALL.
 *
 *  A general version was written first: scan every surface for any `yarn …` and assert each
 *  names a defined script. It drew twelve findings over two review rounds — `yarn run X` read as
 *  the built-in `run`, `--cwd` swallowing the name, malformed lines counted as absences, prose
 *  mistaken for commands, a `name: yarn x` YAML value mistaken for one, four-backtick fences
 *  mis-segmented — and every fix landed in the PARSER rather than in anything it guarded.
 *
 *  Then the subject was counted. CI already RUNS `check:pack`, `lint`, `test`, `typecheck`,
 *  `format:check` and `typecheck:summary`; break any of those names and CI fails on the spot,
 *  with no help from here. The one reference nothing executes is `yarn check:apps` in
 *  `CLAUDE.md` — deliberately out of CI, because `../apps` is a private checkout. So the general
 *  parser's real subject was ONE script in ONE document, and a parser is not what guards that.
 *
 *  WHAT THIS DELIBERATELY DOES NOT COVER. Two limits, both chosen rather than overlooked:
 *
 *  1. A script added later with a hand-written reference somewhere gets no guard until someone
 *     adds a pin here.
 *  2. A `CLAUDE.md` that CONTRADICTS itself passes — a fenced "do not run this" example puts
 *     `yarn check:apps` at the start of a line just as the real instruction does, and this was
 *     measured passing, not assumed. Telling the two apart means knowing which fenced block is
 *     the instruction, which is a Markdown parser; a parser is exactly what was withdrawn here
 *     after twelve findings, and rebuilding it to catch a document that argues with itself is
 *     the wrong trade. A reader catches that one; a test does not.
 *
 *  The trade in one line: a small rule that is true beats a general one that keeps being wrong
 *  in a new way. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const read = (...parts: string[]): string => readFileSync(path.join(root, ...parts), "utf8");

/** `JSON.parse` hands back `any`, and a manifest with no `scripts` block must be a loud failure
 *  rather than an empty Set that makes every name below look undefined. */
const hasScripts = (value: unknown): value is { scripts: Record<string, unknown> } =>
  typeof value === "object" && value !== null && "scripts" in value && typeof value.scripts === "object" && value.scripts !== null;

const scriptNames = (): Set<string> => {
  const manifest: unknown = JSON.parse(read("package.json"));
  assert.ok(hasScripts(manifest), "package.json has no scripts block");
  return new Set(Object.keys(manifest.scripts));
};

/** A workflow STEP that runs the pack gate. Literal spaces rather than `\s*`, because `\s`
 *  matches a newline and the pair of them backtracks — and the exactness is the point anyway:
 *  reformat the step and this turns RED rather than quietly matching nothing, which is the
 *  failure mode that cost this file its previous two versions. */
const RUNS_PACK_GATE = /^ *- run: yarn check:pack\b/mu;

const workflowText = (): string =>
  readdirSync(path.join(root, ".github", "workflows"))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => read(".github", "workflows", name))
    .join("\n");

test("the documented pre-release gate names a script that exists — the one pairing nothing runs", () => {
  // `check:apps` is the whole reason this file exists. It is not in CI by design, so a rename
  // that misses `CLAUDE.md` leaves a documented command nobody can run, and nothing else notices.
  assert.ok(scriptNames().has("check:apps"), "package.json must define check:apps");
  // Anchored at the start of a line, which is where the fenced command block puts it. A literal
  // search anywhere in the file would also pass for a sentence SAYING the command — "do not run
  // `yarn check:apps`" reads as coverage and instructs the opposite.
  assert.match(read("CLAUDE.md"), /^yarn check:apps\b/mu, "CLAUDE.md's command block must tell a human to run it by that name");
});

test("the consumable job names a script that exists", () => {
  // CI proves this one too, by failing. Pinned anyway because the pairing is the point, and a
  // red test here says WHICH half broke where a `command not found` in a release job does not.
  assert.ok(scriptNames().has("check:pack"), "package.json must define check:pack");
  // Anchored to a `run:` value, not to the file: a workflow could name the command in a `name:`
  // or a comment while the step that executes runs something else entirely. Literal spaces
  // rather than `\s*`, because `\s` matches a newline and the pair of them backtracks — and the
  // exactness is the point anyway: reformat the step and this turns RED rather than quietly
  // matching nothing, which is the failure mode that cost this file its previous two versions.
  assert.match(workflowText(), RUNS_PACK_GATE, "a workflow step must RUN it by that name");
});

test("a mention of the command is not a step that runs it", () => {
  // Measured against a real escape route: text INSIDE another step's block scalar reads as a
  // mention, and must not satisfy the pin. It does not, because the line it sits on starts with
  // the echo rather than with the sequence dash.
  assert.doesNotMatch('      - run: |\n          echo "    - run: yarn check:pack package.tgz"\n', RUNS_PACK_GATE);
  assert.match("      - run: yarn check:pack package.tgz\n", RUNS_PACK_GATE);
});
