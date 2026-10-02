// `public.readPublished` + `collections[cid].publishField`: visitors read only the rows an owner
// published. The gate's refusals, and what the projection writes for the rules and the page.
import { test } from "node:test";
import assert from "node:assert/strict";

import { AuthoredAppZ } from "../src/publishManifest.js";
import { publishProblems } from "../src/publishChecks.js";
import { projectApp, type PublishStamp } from "../src/publishProject.js";

const OWNER = "owner@box.jp";
const CIDS = [
  { cid: "questions", primaryKey: "id" },
  { cid: "answers", primaryKey: "id" },
];
const STAMP: PublishStamp = { uid: "uid_owner", email: OWNER, publishedAt: 1_760_000_000_000, commit: "abc123def456" };

/** A question box: questions arrive by public submit, the owner publishes the ones to show. */
const box = (overrides: { collection?: Record<string, unknown>; submit?: Record<string, unknown>; public?: Record<string, unknown> } = {}) =>
  AuthoredAppZ.parse({
    aid: "app_box",
    members: { [OWNER]: { "*": "owner" } },
    collections: {
      questions: { submitOnly: true, statusField: "status", transitions: { initial: ["asked"] }, publishField: "published", ...overrides.collection },
    },
    public: {
      enabled: true,
      readPublished: ["questions"],
      submit: { questions: { auth: "anonymous", idFrom: "auth.uid", createFields: ["text", "status"], initialStatus: "asked", ...overrides.submit } },
      ...overrides.public,
    },
  });

/** One key of a projected document, which the projection types as an open record. */
const at = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined);

const problems = (app: ReturnType<typeof box>) => publishProblems(app, CIDS, OWNER);

/** Exactly this check fired, by a distinctive fragment — not merely that something was refused. */
const refuses = (app: ReturnType<typeof box>, fragment: string) => {
  const found = problems(app);
  assert.ok(
    found.some((line) => line.includes(fragment)),
    `expected a problem mentioning ${JSON.stringify(fragment)}, got:\n${found.join("\n") || "(none)"}`,
  );
};

test("publishes a question box whose owner chooses what to show", () => {
  assert.deepEqual(problems(box()), []);
});

test("refuses a readPublished collection with no publish field", () => {
  refuses(box({ collection: { publishField: undefined } }), "publishField is not declared");
});

test("refuses the same collection in public.read and public.readPublished", () => {
  refuses(box({ public: { read: ["questions"] } }), "public.read names it too");
});

test("refuses a sender writing the flag on the way in", () => {
  refuses(box({ submit: { createFields: ["text", "status", "published"] } }), "createFields includes 'published'");
});

test("refuses a sender writing the flag afterwards", () => {
  refuses(box({ submit: { selfUpdate: { asked: ["text", "published"] } } }), "selfUpdate.asked includes 'published'");
});

test("refuses a publish field that is already another field", () => {
  refuses(box({ collection: { publishField: "status" } }), "which is also the statusField");
  refuses(box({ submit: { stampField: "published", createFields: ["text", "status", "published"] } }), "which is also the stampField");
});

test("refuses a readPublished name that is not a collection here", () => {
  refuses(box({ public: { readPublished: ["questoins"] } }), "public.readPublished");
});

test("lets a public view be handed a readPublished collection", () => {
  const app = box({ public: { view: { path: "views/box.html", collections: ["questions"] } } });
  assert.equal(problems(app).filter((line) => line.includes("in neither public.read nor public.readPublished")).length, 0);
});

test("projects the switch for the rules and the filter for the page", () => {
  const projected = projectApp(box(), [], STAMP, null);
  assert.deepEqual(at(at(projected.app, "public"), "readPublished"), ["questions"]);
  assert.equal(at(at(at(projected.app, "collections"), "questions"), "publishField"), "published");
  assert.deepEqual(projected.config.readPublished, { questions: "published" });
});

test("projects nothing new for an app that declares none", () => {
  const plain = AuthoredAppZ.parse({ aid: "app_plain", members: { [OWNER]: { "*": "owner" } }, public: { enabled: true, read: ["answers"] } });
  const projected = projectApp(plain, [], STAMP, null);
  assert.equal(Object.hasOwn(projected.config, "readPublished"), false);
  assert.equal(at(at(projected.app, "public"), "readPublished"), undefined);
});
