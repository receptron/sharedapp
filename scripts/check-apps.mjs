// THE APPS THAT ALREADY PUBLISH — run against a real checkout, before a release.
//
// The gate in `publishChecks.ts` is tested one rule at a time, each against a declaration written to
// provoke it. That is how a gate should be tested and it is also how a gate drifts: a tightened
// check is judged against its own fixture, never against the apps somebody is running, and an app
// that stops publishing is in another repository with nobody watching. `test/test_publishBaseline.ts`
// holds three shapes against that, in CI, with no sibling checkout. This is the other half — the
// real ten, on the machine of whoever is about to release.
//
// Usage, from this package's root:
//   npx tsx scripts/check-apps.mjs [path-to-apps-checkout]   (default: ../apps)
//
// Not in CI, and not fixable there: `../apps` is a private working checkout, so a CI job depending
// on it would be red for reasons nobody in this repository could act on.
//
// WHAT IS SYNTHESIZED, and why the result is still worth having: the real gate is handed the
// repository's collections (a cid and a primary key each) and their schemas, both of which the HOST
// reads off disk — MulmoTerminal has them, an app checkout does not. So every cid an app names is
// taken as existing with primary key "id", and no schemas are passed. That relaxes exactly two
// checks (a cid that is not in the repository, and a field name a schema does not declare) and
// leaves every other refusal in this package judged against the real declarations. It cannot turn a
// refusal into a pass for anything else — which is what this script is looking for.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseAuthoredApp, publishProblems, schemaRefProblems } from "../src/index.ts";

/** The ten in the issue's baseline, by path under the apps checkout. */
const APPS = ["lunches", "survey", "gym", "live", "tennis.grok", "codex/tennis", "test.rooms", "tennis.muse", "gemini/tennis.g", "mbti"];

const root = resolve(process.argv[2] ?? "../apps");
/** Anybody: the publisher check compares the roster against whoever is publishing, and here that is
 *  whoever the app already says owns it. Reading it off the manifest keeps this script about the
 *  declaration rather than about which laptop it runs on. */
const publisherOf = (app) => Object.entries(app.members ?? {}).find(([, roles]) => roles["*"] === "owner")?.[0] ?? "";

/** Every collection the declaration NAMES, taken as present. See the header. */
const collectionsOf = (app) => {
  const cids = new Set([
    ...Object.keys(app.collections ?? {}),
    ...(app.public?.read ?? []),
    ...Object.keys(app.public?.submit ?? {}),
    ...(app.participantRead ?? []),
    ...(app.views ?? []).flatMap((view) => view.collections ?? []),
    ...(app.public?.view?.collections ?? []),
  ]);
  for (const collection of Object.values(app.collections ?? {})) {
    if (collection.mirrorOf) cids.add(collection.mirrorOf);
  }
  for (const submit of Object.values(app.public?.submit ?? {})) {
    for (const named of [submit.idIn?.collection, submit.window?.fromField?.collection, submit.window?.untilField?.collection, submit.mirror]) {
      if (named) cids.add(named);
    }
  }
  return [...cids].map((cid) => ({ cid, primaryKey: "id" }));
};

const lines = [];
let failed = 0;
for (const app of APPS) {
  const where = resolve(root, app, "app.json");
  let raw;
  try {
    raw = readFileSync(where, "utf8");
  } catch {
    lines.push(`SKIP  ${app} -- no app.json at ${where}`);
    continue;
  }
  const parsed = parseAuthoredApp(raw);
  if (!parsed.ok) {
    failed += 1;
    lines.push(`FAIL  ${app} -- does not parse`, ...parsed.problems.map((problem) => `        ${problem}`));
    continue;
  }
  const problems = [...publishProblems(parsed.app, collectionsOf(parsed.app), publisherOf(parsed.app)), ...schemaRefProblems(parsed.app, [])];
  if (problems.length > 0) {
    failed += 1;
    lines.push(`FAIL  ${app} -- ${problems.length} problem(s)`, ...problems.map((problem) => `        ${problem}`));
    continue;
  }
  lines.push(`PASS  ${app}`);
}

console.log(lines.join("\n"));
console.log(failed === 0 ? "\nALL APPS PUBLISH" : `\n${failed} APP(S) WOULD BE REFUSED`);
process.exit(failed === 0 ? 0 : 1);
