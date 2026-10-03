// `shareCard` (receptron/mulmoserver#336): the field a link to one row draws on a social network.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { CollectionSchema } from "@mulmoclaude/core/collection";

import { AuthoredAppZ } from "../src/publishManifest.js";
import { publishProblems, schemaRefProblems } from "../src/publishChecks.js";
import { projectApp, type PublishStamp } from "../src/publishProject.js";

const OWNER = "owner@box.jp";
const STAMP: PublishStamp = { uid: "uid_owner", email: OWNER, publishedAt: 1_760_000_000_000 };
const COLLECTIONS = [{ cid: "questions", primaryKey: "id" }];

const schema: CollectionSchema = {
  title: "Questions",
  icon: "help",
  primaryKey: "id",
  fields: {
    id: { type: "string", label: "ID", primary: true },
    text: { type: "text", label: "Question" },
    votes: { type: "number", label: "Votes" },
    published: { type: "boolean", label: "Published" },
  },
};
const SCHEMAS = [{ cid: "questions", schema }];

/** `shareCard: null` declares none. */
const app = (publicBlock: Record<string, unknown>, shareCard: unknown = { collection: "questions", textField: "text" }) =>
  AuthoredAppZ.parse({
    aid: "app_box",
    members: { [OWNER]: { "*": "owner" } },
    collections: { questions: { submitOnly: true, publishField: "published" } },
    public: { enabled: true, ...publicBlock },
    ...(shareCard === null ? {} : { shareCard }),
  });

const cardProblems = (declared: ReturnType<typeof app>) =>
  [...publishProblems(declared, COLLECTIONS, OWNER), ...schemaRefProblems(declared, SCHEMAS)].filter((problem) => problem.includes("shareCard"));

test("a card on a collection visitors read, every row or the published ones, is accepted", () => {
  assert.deepEqual(cardProblems(app({ read: ["questions"] })), []);
  assert.deepEqual(cardProblems(app({ readPublished: ["questions"] })), []);
});

test("a card on a collection no visitor reads is refused — it could never be drawn", () => {
  assert.equal(cardProblems(app({ read: [] })).length, 1);
});

test("the field must exist and be text", () => {
  assert.equal(cardProblems(app({ read: ["questions"] }, { collection: "questions", textField: "missing" })).length, 1);
  assert.equal(cardProblems(app({ read: ["questions"] }, { collection: "questions", textField: "votes" })).length, 1);
});

test("the declaration is strict, and collection and textField go together", () => {
  const parses = (shareCard: unknown) => AuthoredAppZ.safeParse({ aid: "a", members: {}, shareCard }).success;
  assert.equal(parses({ collection: "questions" }), false);
  assert.equal(parses({ textField: "text" }), false);
  assert.equal(parses({ collection: "questions", textField: "text", image: "x" }), false);
  assert.equal(parses({ title: "" }), false);
  assert.equal(parses({ title: "x".repeat(201) }), false);
  assert.equal(parses({}), true);
  assert.equal(parses({ title: "Which prime?" }), true);
  assert.equal(parses({ collection: "questions", textField: "text", title: "Ask me" }), true);
});

test("an app-only card names no collection, so it needs none readable and no schema", () => {
  for (const card of [{}, { title: "Which prime?" }]) {
    assert.deepEqual(cardProblems(app({ read: [] }, card)), []);
  }
});

test("config/public carries only the keys declared", () => {
  assert.deepEqual(projectApp(app({ read: [] }, {}), SCHEMAS, STAMP, null).config.shareCard, {});
  assert.deepEqual(projectApp(app({ read: [] }, { title: "Which prime?" }), SCHEMAS, STAMP, null).config.shareCard, { title: "Which prime?" });
});

test("config/public carries the card when declared, and nothing when not", () => {
  const declared = projectApp(app({ read: ["questions"] }), SCHEMAS, STAMP, null).config;
  assert.deepEqual(declared.shareCard, { collection: "questions", textField: "text" });
  const absent = projectApp(app({ read: ["questions"] }, null), SCHEMAS, STAMP, null).config;
  assert.equal(Object.hasOwn(absent, "shareCard"), false);
});
