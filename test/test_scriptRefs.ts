/** The commands CI runs and the commands the docs tell a human to run must EXIST.
 *
 *  This suite is here because a rename is silent: `package.json` is the only place a script's
 *  name is defined, and `ci.yml` and `CLAUDE.md` each name it again in prose that nothing
 *  checks. Renaming `check:pack` and missing one of them leaves a workflow step that fails at
 *  release time with `command not found`, or a documented pre-release gate nobody can run.
 *
 *  WHAT THIS DOES NOT COVER, so the next reader does not over-trust it: it only sees commands
 *  that begin with `yarn`. A surface that spells the invocation some other way — `node
 *  scripts/x.mjs` in a comment, an npx line in a README — is invisible to it, and one of those
 *  is exactly what got missed once already. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Yarn's own subcommands. A `yarn install` in a workflow is not a missing script. */
const YARN_BUILTINS = new Set([
  "install",
  "add",
  "remove",
  "pack",
  "run",
  "why",
  "info",
  "cache",
  "upgrade",
  "link",
  "publish",
  "global",
  "config",
  "list",
  "audit",
]);

/** `JSON.parse` hands back `any`, and the whole point of this suite is that a rename is silent —
 *  so a manifest with no `scripts` block must be a loud failure here, not an empty Set that
 *  makes every reference below look undefined. */
const hasScripts = (value: unknown): value is { scripts: Record<string, unknown> } =>
  typeof value === "object" && value !== null && "scripts" in value && typeof value.scripts === "object" && value.scripts !== null;

const scriptNames = (): Set<string> => {
  const manifest: unknown = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(hasScripts(manifest), "package.json has no scripts block");
  return new Set(Object.keys(manifest.scripts));
};

/** The script name in one `yarn …` invocation, or `null` when the line runs yarn itself.
 *
 *  A single regexp over `yarn\s+(\w+)` reads `yarn run check:pack` as the script `run` — which
 *  is in the built-in list, so the REAL name is silently never checked. That is the shape a
 *  guard fails at: it keeps passing while it has stopped looking. So this walks the tokens
 *  instead, dropping what precedes the name, and anything it cannot account for stays in the
 *  list to be reported rather than dropped. */
const nameOf = (invocation: string): string | null => {
  const words = invocation.trim().split(/\s+/u);
  while (words.length > 0) {
    // `head` / `words` / `script` rather than `token` / `name`: eslint-plugin-security reads a
    // comparison against an identifier called either of those as a possible timing attack, and
    // these hold a shell word and a script name. The names are the more accurate ones anyway.
    const head = words[0] ?? "";
    // `--cwd <dir>` takes a value; every other flag stands alone. `run` is yarn's explicit
    // "this is a script" marker and the script name follows it.
    if (head === "--cwd") words.splice(0, 2);
    else if (head.startsWith("-")) words.shift();
    else if (head === "run") words.shift();
    else break;
  }
  const script = words[0] ?? "";
  return script === "" || YARN_BUILTINS.has(script) ? null : script;
};

/** Every script named by a `yarn …` command in a file. Line continuations are joined first, so
 *  a command split across two lines is one invocation rather than none. */
const referenced = (text: string): string[] =>
  [...text.replaceAll(/\\\n/gu, " ").matchAll(/\byarn\b([^\n`]*)/gu)]
    .map((match) => nameOf(match[1] ?? ""))
    .filter((script): script is string => script !== null);

const workflowText = (): string =>
  readdirSync(path.join(root, ".github", "workflows"))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => readFileSync(path.join(root, ".github", "workflows", name), "utf8"))
    .join("\n");

const assertAllDefined = (source: string, text: string): void => {
  const defined = scriptNames();
  const missing = [...new Set(referenced(text))].filter((script) => !defined.has(script));
  assert.deepEqual(missing, [], `${source} names ${missing.join(", ")}, which package.json does not define`);
};

test("every yarn script the workflows run is one package.json defines", () => {
  assertAllDefined(".github/workflows", workflowText());
});

test("every yarn script the docs tell a human to run is one package.json defines", () => {
  assertAllDefined("CLAUDE.md", readFileSync(path.join(root, "CLAUDE.md"), "utf8"));
});

test("the scan finds what is there, and rejects what is not", () => {
  // Both directions, because a scanner that matches NOTHING passes every assertion above — which
  // is how a guard stops guarding without anything going red.
  assert.ok(referenced(workflowText()).includes("check:pack"), "the consumable job's `yarn check:pack` must be visible to this scan");
  assert.deepEqual(referenced("run: yarn install\nrun: yarn pack --filename x"), [], "yarn's own subcommands are not scripts");
  assert.deepEqual(referenced("see yarn check:nothing for details"), ["check:nothing"]);
});

test("the shapes a single regexp reads wrongly are read correctly", () => {
  // Every one of these was named as a way past the first version of this scan, which matched
  // `yarn\s+(\w+)` and so read `yarn run check:pack` as the script `run` — a built-in, therefore
  // dropped, therefore the real name was never checked and nothing went red.
  assert.deepEqual(referenced("yarn run check:pack"), ["check:pack"]);
  assert.deepEqual(referenced("yarn --cwd packages/x run check:pack"), ["check:pack"]);
  assert.deepEqual(referenced("yarn -s check:pack"), ["check:pack"]);
  assert.deepEqual(referenced("yarn check:Pack"), ["check:Pack"], "an uppercase letter is still a name, and a wrong one must be reported");
  assert.deepEqual(referenced("yarn \\\n  check:pack"), ["check:pack"], "a continued line is one invocation");
  // And the negative half: a bare `yarn` is an install, not a script.
  assert.deepEqual(referenced("yarn"), []);
  assert.deepEqual(referenced("yarn --frozen-lockfile"), []);
});
