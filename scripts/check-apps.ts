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

/** The keys `CollectionSchema` requires, and NOTHING MORE — this is deliberately not a full
 *  validation, and the paragraph below is why.
 *
 *  The `.mjs` this replaces tested `primaryKey` and passed whatever else was there into functions
 *  that read the rest. A predicate claiming `CollectionSchema` from that asserts what it has not
 *  proved, so this checks the four keys the type requires. It was still shown wrong twice in one
 *  review — `fields: null` and `fields: []` passed its container test, then `fields: {x: null}`
 *  passed the fixed one — because enumerating bad shapes has no last case.
 *
 *  The host's own `CollectionSchemaZ` IS the last case, and it was tried: it also requires
 *  `dataPath` / `dataSource` / `storage`, which turns "the four keys" into "everything the host
 *  demands". That may well be right, but it cannot be shipped from a machine with no apps
 *  checkout to test it against, and this gate's whole job is to say those apps still publish.
 *
 *  So the shape check stays minimal and the CRASH is contained instead: `checkedProblems` runs the
 *  gate's own checks inside the per-app boundary, so a schema this predicate wrongly admitted
 *  fails ONE app with a message instead of killing the run. That covers every shape, including the
 *  ones nobody has thought of, which is what the enumeration could not do. */
const schemaProblems = (schema: unknown): string[] => {
  if (typeof schema !== "object" || schema === null) return ["not a JSON object"];
  const has = (key: string, kind: "string" | "record"): boolean => {
    if (!(key in schema)) return false;
    const value: unknown = Reflect.get(schema, key);
    return kind === "string" ? typeof value === "string" : typeof value === "object" && value !== null && !Array.isArray(value);
  };
  const absent = [
    ...(has("title", "string") ? [] : ["title"]),
    ...(has("icon", "string") ? [] : ["icon"]),
    ...(has("primaryKey", "string") ? [] : ["primaryKey"]),
    ...(has("fields", "record") ? [] : ["fields"]),
  ];
  return absent.length === 0 ? [] : [`missing ${absent.join(", ")}`];
};

const isCollectionSchema = (schema: unknown): schema is CollectionSchema => schemaProblems(schema).length === 0;

/** Thrown where the file was READ and its shape is wrong — distinct from the fs errors that mean
 *  the checkout is incomplete, which `readApp` labels differently. */
class UnusableSchema extends Error {}

const collectionsOf = (app: string): { cid: string; schema: CollectionSchema }[] => {
  const dir = resolve(root, app, SKILLS);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const where = resolve(dir, entry.name, "schema.json");
      const schema: unknown = JSON.parse(readFileSync(where, "utf8"));
      if (!isCollectionSchema(schema)) throw new UnusableSchema(`${where}: ${schemaProblems(schema).join("; ")}`);
      return { cid: entry.name, schema };
    })
    .sort((left, right) => Number(left.cid > right.cid) - Number(left.cid < right.cid));
};

/** The gate's own checks, inside the per-app boundary. They read the schema deeply — a field
 *  spec's `type`, an enum's values — so a shape the predicate above wrongly admitted throws in
 *  `publishChecks` rather than here. Uncaught, that killed the run: measured on the `.mjs` this
 *  replaces, `fields: null` took the whole gate down at `Object.hasOwn(fields, field)` with no
 *  report and the remaining apps unchecked. Caught, it is one app's problem, which is what the
 *  header means by a failure rather than a skip. */
const checkedProblems = (app: AuthoredApp, collections: { cid: string; schema: CollectionSchema }[]): string[] => {
  try {
    return [
      ...publishProblems(
        app,
        collections.map(({ cid, schema }) => ({ cid, primaryKey: schema.primaryKey })),
        publisherOf(app),
      ),
      ...schemaRefProblems(app, collections),
    ];
  } catch (error) {
    return [`the checks threw on this app's declaration or schemas: ${error instanceof Error ? error.message : String(error)}`];
  }
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
type AppOnDisk =
  | { readonly raw: string; readonly collections: { cid: string; schema: CollectionSchema }[] }
  | { readonly unusable: string; readonly why: "could not be read" | "has an unusable schema" };

/** Two failures that read the same in a log and do not mean the same thing. A file that is not
 *  there is a checkout problem; a `schema.json` that IS there and has the wrong shape is a problem
 *  with the app, and calling it "could not be read" sends the operator to the wrong place. */
const readApp = (app: string): AppOnDisk => {
  try {
    return { raw: readFileSync(resolve(root, app, "app.json"), "utf8"), collections: collectionsOf(app) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { unusable: message, why: error instanceof UnusableSchema ? "has an unusable schema" : "could not be read" };
  }
};

for (const app of APPS) {
  const onDisk = readApp(app);
  if ("unusable" in onDisk) {
    // NOT a skip. See the header: a missing app makes the claim smaller, silently.
    fail(app, onDisk.why, [onDisk.unusable]);
    continue;
  }
  const { raw, collections } = onDisk;
  const parsed = parseAuthoredApp(raw);
  if (!parsed.ok) {
    fail(app, "does not parse", parsed.problems);
    continue;
  }
  const problems = checkedProblems(parsed.app, collections);
  if (problems.length > 0) {
    fail(app, `${problems.length} problem(s)`, problems);
    continue;
  }
  lines.push(`PASS  ${app} -- ${collections.length} collection(s): ${collections.map(({ cid }) => cid).join(", ")}`);
}

console.log(lines.join("\n"));
console.log(failed === 0 ? `\nALL ${APPS.length} APPS PUBLISH` : `\n${failed} of ${APPS.length} APP(S) COULD NOT BE CHECKED OR WOULD BE REFUSED`);
process.exit(failed === 0 ? 0 : 1);
