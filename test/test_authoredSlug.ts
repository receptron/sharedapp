// The URL name, and why the declaration carries it at all.
//
// `aid` is the identity and `slug` is the name people are handed
// (`https://<host>/{slug}`). They are separate because a shelf every user
// shares cannot hold memorable ids fairly, and the SLUG is where the
// fightable name was moved — so this file pins the two properties a host
// depends on: the key parses, and it parses only in a shape that is safe in
// both places it is used.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAuthoredApp } from "../src/publishManifest.js";

const withSlug = (slug: unknown): ReturnType<typeof parseAuthoredApp> =>
  parseAuthoredApp(JSON.stringify({ aid: "3f2b8c1a", name: "Sakura Hair", slug, members: { "owner@example.com": { "*": "owner" } } }));

test("a declaration may carry the wanted URL name", () => {
  const parsed = withSlug("sakura-hair");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.app.slug : null, "sakura-hair");
});

test("the key is optional — an app reachable only at /staging/{aid} never needs one", () => {
  const parsed = parseAuthoredApp(JSON.stringify({ aid: "3f2b8c1a", members: { "owner@example.com": { "*": "owner" } } }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.app.slug : "unset", undefined);
});

test("a host may write back the slug it actually reserved", () => {
  // The wanted one can be taken, and the reservation is unreadable until the
  // app is published — so the host's write-back is the ONLY record of which
  // slug an app holds. A declaration that refused it would make that record
  // impossible to keep.
  assert.equal(withSlug("sakura-hair-2").ok, true);
});

test("it refuses a shape that is not safe in both a URL and a document id", () => {
  // Uppercase is the one worth naming: a URL path is compared case-sensitively
  // and readers retype it in either case, so `Sakura` and `sakura` would be one
  // name to a person and two reservations to Firestore.
  for (const slug of ["Sakura", "sakura hair", "sakura_hair", "sakura/hair", "-sakura", "sakura-", "sakura--hair", "", "a".repeat(65)]) {
    assert.equal(withSlug(slug).ok, false, `expected ${JSON.stringify(slug)} to be refused`);
  }
});

test("it says what a rejected slug should look like", () => {
  const parsed = withSlug("Sakura Hair");
  assert.equal(parsed.ok, false);
  // The author is holding the file open; a reason without an example is a
  // second round trip.
  assert.match(parsed.ok ? "" : parsed.problems.join("\n"), /sakura-hair/);
});
