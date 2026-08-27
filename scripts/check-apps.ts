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
//   yarn check:apps [path-to-apps-checkout]   (default: ../apps)
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

import type { CollectionSchema } from "@mulmoclaude/core/collection";
import { parseAuthoredApp, publishProblems, schemaRefProblems, type AuthoredApp } from "../src/index.js";

/** The ten in the compatibility baseline (issue #28), by path under the apps checkout. */
const APPS = ["lunches", "survey", "gym", "live", "tennis.grok", "codex/tennis", "test.rooms", "tennis.muse", "gemini/tennis.g", "mbti"];

/** Where a repository keeps its collections: one directory per cid, the directory name IS the cid. */
const SKILLS = ".claude/skills";

const root = resolve(process.argv[2] ?? "../apps");

/** The publisher, read off the manifest rather than off this laptop: the roster check compares the
 *  two, and which machine runs this script is not what is under test. */
const publisherOf = (app: AuthoredApp): string => Object.entries(app.members).find(([, roles]) => roles["*"] === "owner")?.[0] ?? "";

/** The four keys `CollectionSchema` requires. Checked rather than asserted: this value came from
 *  `JSON.parse` of a file in ANOTHER repository, which is the one place in this script where
 *  nothing is known, and a predicate that claimed the type from `primaryKey` alone would be a cast
 *  wearing a guard's clothes.
 *
 *  This is the ONE intentional difference from the `.mjs` this replaces, which checked `primaryKey`
 *  and passed whatever else was there. A schema missing `title`, `icon` or `fields` is not one the
 *  host would promote, and the header above says an app that cannot be read is a FAILURE rather
 *  than a skip — so it fails, naming the key that is missing rather than the file. */
const schemaProblems = (schema: unknown): string[] => {
  if (typeof schema !== "object" || schema === null) return ["not a JSON object"];
  const has = (key: string, kind: "string" | "object"): boolean => key in schema && typeof Reflect.get(schema, key) === kind;
  const absent = [
    ...(has("title", "string") ? [] : ["title"]),
    ...(has("icon", "string") ? [] : ["icon"]),
    ...(has("primaryKey", "string") ? [] : ["primaryKey"]),
    ...(has("fields", "object") ? [] : ["fields"]),
  ];
  return absent.length === 0 ? [] : [`missing ${absent.join(", ")}`];
};

const isCollectionSchema = (schema: unknown): schema is CollectionSchema => schemaProblems(schema).length === 0;

/** Every collection committed beside the app, with the schema the host would promote. Throws with
 *  the path in the message: a schema that cannot be read is the same failure as an app that cannot,
 *  for the same reason. */
const collectionsOf = (app: string): { cid: string; schema: CollectionSchema }[] => {
  const dir = resolve(root, app, SKILLS);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const where = resolve(dir, entry.name, "schema.json");
      const schema: unknown = JSON.parse(readFileSync(where, "utf8"));
      if (!isCollectionSchema(schema)) throw new Error(`${where}: ${schemaProblems(schema).join("; ")}`);
      return { cid: entry.name, schema };
    })
    .sort((left, right) => Number(left.cid > right.cid) - Number(left.cid < right.cid));
};

const lines: string[] = [];
let failed = 0;
const fail = (app: string, why: string, detail: readonly string[] = []): void => {
  failed += 1;
  lines.push(`FAIL  ${app} -- ${why}`, ...detail.map((line) => `        ${line}`));
};

/** The app's text and its collections, or the reason neither could be had. Returned rather than
 *  assigned into two `let`s: untyped ones were implicitly `any`, and `scripts/` holds a type
 *  coverage floor that says so. */
type AppOnDisk = { readonly raw: string; readonly collections: { cid: string; schema: CollectionSchema }[] } | { readonly unreadable: string };

const readApp = (app: string): AppOnDisk => {
  try {
    return { raw: readFileSync(resolve(root, app, "app.json"), "utf8"), collections: collectionsOf(app) };
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message : String(error) };
  }
};

for (const app of APPS) {
  const onDisk = readApp(app);
  if ("unreadable" in onDisk) {
    // NOT a skip. See the header: a missing app makes the claim smaller, silently.
    fail(app, "could not be read", [onDisk.unreadable]);
    continue;
  }
  const { raw, collections } = onDisk;
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
