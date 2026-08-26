// `idFrom: "slug"` — the id a record is NAMED by, as opposed to the id it CLAIMS.
//
// The mode exists so an article's URL is its own name. What makes it worth its
// own file is that the grammar is stated twice on purpose: `firestore.rules`
// holds the authority (it answers for a client that never came through this
// package) and `SLUG_ID_PATTERN` here exists to refuse early and name the
// field. These tests pin THIS half; `test/rules/rules_articles.ts` in
// mulmoserver pins the other, with the same names in it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { BAD_SLUG, badSlugField, MISSING_ID_FIELD, missingIdField, recordId, SLUG_ID_PATTERN, SubmitRefused, type SubmitSpec } from "../src/view/submit.js";

const submit: SubmitSpec = {
  createFields: ["slug", "title", "body"],
  idFrom: "slug",
  idField: "slug",
};

const article = (slug: string) => ({ slug, title: "題", body: "本文" });

test("the id is the submitted name, verbatim", () => {
  assert.equal(recordId(submit, "u-writer", article("why-terminals-won"), "unique-fallback"), "why-terminals-won");
});

test("the uid is not part of it", () => {
  // The difference from `auth.uid+field`, which is the mode this one exists to
  // avoid: an article's URL must not carry whoever happened to write it.
  const id = recordId(submit, "u-writer", article("why-terminals-won"), "unique-fallback");
  assert.ok(!id.includes("u-writer"));
});

test("an empty name is missing, not malformed", () => {
  // Two refusals that must not be confused: a box left blank sends the writer
  // looking for a typo in nothing.
  assert.equal(missingIdField(submit, article("")), "slug");
  assert.equal(badSlugField(submit, article("")), undefined);
  assert.equal(missingIdField(submit, article("   ")), "slug");
  assert.equal(badSlugField(submit, article("   ")), undefined);
});

test("recordId refuses an empty name with the missing code", () => {
  assert.throws(
    () => recordId(submit, "u-writer", article(""), "unique-fallback"),
    (err: unknown) => err instanceof SubmitRefused && err.code === MISSING_ID_FIELD,
  );
});

test("recordId refuses a malformed name, and names the field", () => {
  assert.throws(
    () => recordId(submit, "u-writer", article("Why Terminals Won"), "unique-fallback"),
    (err: unknown) => err instanceof SubmitRefused && err.code === BAD_SLUG && err.message.includes("slug"),
  );
});

test("the grammar", () => {
  // The same table as the rules suite, and deliberately so: a name this
  // package accepts and the rules refuse is a bare permission error with no
  // field named, which is the failure both halves exist to prevent.
  for (const ok of ["why-terminals-won", "a", "2026-09-01-issue", "0", `a${"b".repeat(63)}`]) {
    assert.ok(SLUG_ID_PATTERN.test(ok), `expected ${ok} to be legal`);
    assert.equal(badSlugField(submit, article(ok)), undefined);
  }
  for (const bad of ["Why-Terminals-Won", "why_terminals_won", "-leading", "why.won", "why won", "なぜ", "why%2Fwon", "why/won", "", "a".repeat(65)]) {
    if (bad !== "") assert.ok(!SLUG_ID_PATTERN.test(bad), `expected ${bad} to be refused`);
  }
});

test("another mode is not judged by the slug grammar", () => {
  // `field` ids are slot ids, which no author chose and this grammar has no
  // business narrowing — a uuid slot would be refused by it.
  const claim: SubmitSpec = { createFields: ["slot"], idFrom: "field", idField: "slot" };
  assert.equal(badSlugField(claim, { slot: "SLOT_2026-09-01T10:00" }), undefined);
  assert.equal(recordId(claim, "u-writer", { slot: "SLOT_2026-09-01T10:00" }, "unique"), "SLOT_2026-09-01T10:00");
});
