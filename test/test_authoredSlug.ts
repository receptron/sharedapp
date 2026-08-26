// The URL name — authored in `app.json`, and reserved in `appSlugs/{slug}`.
//
// `aid` is the identity and `slug` is the name people are handed
// (`https://<host>/{slug}`). They are separate because a shelf every user
// shares cannot hold memorable ids fairly, and the SLUG is where the
// fightable name was moved — so this file pins the two properties a host
// depends on: the key parses, and it parses only in a shape that is safe in
// both places it is used.
//
// The reservation document is here too, at the bottom. Nothing in this package
// writes it — the host does — which is exactly why its shape is pinned here:
// an untested factory whose output decides who may read a reservation is a
// guarantee nobody is holding.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAuthoredApp } from "../src/publishManifest.js";
import { appSlugDoc, APP_SLUGS_COLLECTION } from "../src/publishProject.js";
import { byText } from "./helpers.js";

const withSlug = (slug: unknown): ReturnType<typeof parseAuthoredApp> =>
  parseAuthoredApp(JSON.stringify({ aid: "3f2b8c1a", name: "Sakura Hair", slug, members: { "owner@example.com": { "*": "owner" } } }));

test("a declaration may carry the wanted URL name", () => {
  const parsed = withSlug("sakura-hair");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.app.slug, "sakura-hair");
});

test("the key is optional — an app reachable only at /staging/{aid} never needs one", () => {
  const parsed = parseAuthoredApp(JSON.stringify({ aid: "3f2b8c1a", members: { "owner@example.com": { "*": "owner" } } }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.app.slug, undefined);
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
  assert.match(parsed.problems.join("\n"), /sakura-hair/);
});

// --- the reservation document -----------------------------------------------
//
// `appSlugs/{slug}` -> `{ aid, published }`. The rule over it is
// `allow read: if resource.data.published == true`, and the whole point of that
// flag is that a slug is HUMAN-READABLE: a reservation anyone could read would
// let anyone guess the URL and be handed the aid, and the aid is the
// `/staging/{aid}` entrance to work that has not been published yet.

test("a deployed app reserves its name without handing it out", () => {
  // What deploy writes. `published: false` is not bookkeeping — it is the whole
  // difference between a reserved name and a leaked staging entrance.
  assert.deepEqual(appSlugDoc("3f2b8c1a", false), { aid: "3f2b8c1a", published: false });
});

test("publishing flips the flag and nothing else — a reservation is never re-pointed", () => {
  // The rules enforce the `aid` half on update; this pins that the projection
  // does not ask them to. Same aid in, same aid out, so a publish can only ever
  // be the flip.
  const reserved = appSlugDoc("3f2b8c1a", false);
  const published = appSlugDoc("3f2b8c1a", true);
  assert.equal(published.aid, reserved.aid);
  assert.equal(published.published, true);
});

test("the reservation carries the aid and the flag, and NOTHING else", () => {
  // Once published this document is world-readable, so every key added to it
  // later is published to the world by default. Pinned as an exact key list so
  // that adding one is a decision someone had to make here first.
  assert.deepEqual(Object.keys(appSlugDoc("3f2b8c1a", true)).sort(byText), ["aid", "published"]);
});

test("the reservations live in a collection of their own, above any app", () => {
  // Not under `apps/{aid}`: a visitor holding only the slug has to resolve it
  // to an aid BEFORE it can read anything there, so the lookup cannot itself
  // require knowing the aid.
  assert.equal(APP_SLUGS_COLLECTION, "appSlugs");
  assert.equal(APP_SLUGS_COLLECTION.includes("/"), false);
});
