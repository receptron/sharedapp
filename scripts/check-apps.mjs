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
// WHAT IT READS, and why it is the real check rather than an approximation: an app IS a repository
// (design D1), so its collections are the ones committed beside its `app.json` — one directory per
// cid under `.claude/skills/`, each with the `schema.json` the host promotes. That is where the
// primary key comes from, and it is what `schemaRefProblems` needs in order to judge a field NAME,
// an enum's domain, or a bound the rules read as epoch millis. Passing an empty schema list here
// would silently skip every one of those checks while still printing a pass, which is the failure
// mode this script exists to catch in the gate.
//
// AN APP THAT CANNOT BE READ IS A FAILURE, not a skip. The whole claim is "these ten still
// publish", and ten minus the ones that were not there is a different, weaker claim that looks
// identical on the way past.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { parseAuthoredApp, publishProblems, schemaRefProblems } from "../src/index.ts";

/** The ten in the compatibility baseline (issue #28), by path under the apps checkout. */
const APPS = ["lunches", "survey", "gym", "live", "tennis.grok", "codex/tennis", "test.rooms", "tennis.muse", "gemini/tennis.g", "mbti"];

/** Where a repository keeps its collections: one directory per cid, the directory name IS the cid. */
const SKILLS = ".claude/skills";

const root = resolve(process.argv[2] ?? "../apps");

/** The publisher, read off the manifest rather than off this laptop: the roster check compares the
 *  two, and which machine runs this script is not what is under test. */
const publisherOf = (app) => Object.entries(app.members ?? {}).find(([, roles]) => roles["*"] === "owner")?.[0] ?? "";

/** Every collection committed beside the app, with the schema the host would promote. Throws with
 *  the path in the message: a schema that cannot be read is the same failure as an app that cannot,
 *  for the same reason. */
const collectionsOf = (app) => {
  const dir = resolve(root, app, SKILLS);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const where = resolve(dir, entry.name, "schema.json");
      const schema = JSON.parse(readFileSync(where, "utf8"));
      if (typeof schema.primaryKey !== "string") throw new Error(`${where}: no primaryKey`);
      return { cid: entry.name, schema };
    })
    .sort((left, right) => (left.cid < right.cid ? -1 : left.cid > right.cid ? 1 : 0));
};

const lines = [];
let failed = 0;
const fail = (app, why, detail = []) => {
  failed += 1;
  lines.push(`FAIL  ${app} -- ${why}`, ...detail.map((line) => `        ${line}`));
};

for (const app of APPS) {
  let raw;
  let collections;
  try {
    raw = readFileSync(resolve(root, app, "app.json"), "utf8");
    collections = collectionsOf(app);
  } catch (error) {
    // NOT a skip. See the header: a missing app makes the claim smaller, silently.
    fail(app, "could not be read", [String(error?.message ?? error)]);
    continue;
  }
  const parsed = parseAuthoredApp(raw);
  if (!parsed.ok) {
    fail(app, "does not parse", parsed.problems);
    continue;
  }
  const problems = [
    ...publishProblems(
      parsed.app,
      collections.map(({ cid, schema }) => ({ cid, primaryKey: schema.primaryKey })),
      publisherOf(parsed.app),
    ),
    ...schemaRefProblems(parsed.app, collections),
  ];
  if (problems.length > 0) {
    fail(app, `${problems.length} problem(s)`, problems);
    continue;
  }
  lines.push(`PASS  ${app} -- ${collections.length} collection(s): ${collections.map(({ cid }) => cid).join(", ")}`);
}

console.log(lines.join("\n"));
console.log(failed === 0 ? `\nALL ${APPS.length} APPS PUBLISH` : `\n${failed} of ${APPS.length} APP(S) COULD NOT BE CHECKED OR WOULD BE REFUSED`);
process.exit(failed === 0 ? 0 : 1);
