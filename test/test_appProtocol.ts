// The version of the contract this compiler emits, and the floor an author may declare.
//
// It exists for a day that has not happened: a breaking change here, and a browser somewhere running
// a build from before it. What must not happen then is that the old reader draws the new documents.
import { test } from "node:test";
import assert from "node:assert/strict";

import { APP_PROTOCOL, APP_PROTOCOL_BASE, protocolFor, protocolOf, protocolWithin } from "../src/appProtocol.js";

test("an ordinary app is still stamped the contract every deployed reader knows", () => {
  // THE COMPATIBILITY ASSERTION, and it survived the arrival of a second contract because that one
  // is per app. It started at 1.0.0 rather than 0.1.0: apps published before this key existed carry
  // no version and a reader treats those as 1.0.0 — they are the documents in Firestore right now.
  // Every reader in the wild draws major 1, so an app that moves off this line stops them all, and
  // an app that does so WITHOUT NEEDING TO stops them for nothing.
  assert.equal(APP_PROTOCOL_BASE, "1.0.0");
  assert.equal(protocolFor({}), "1.0.0");
  assert.equal(protocolFor({ views: [{}] }), "1.0.0", "an ordinary HTML view is not a reason");
});

test("adding a key an older reader may ignore does not move the number", () => {
  // `uidField` shipped as 2.0.0, then 1.1.0, then as nothing at all, and this is the reasoning that
  // has to survive the next addition shaped like it. Four things could have read the difference:
  //
  //   - the reader's gate compares the MAJOR only (`protocolDrawable`), so a minor is inert;
  //   - a reader's behaviour switch (`protocolAtLeast`) would read it, and there is not one;
  //   - the authored floor is checked by `protocolProblems`, which never runs for a key an older
  //     build does not know — `SubmitZ` is `.strict()`, so that build stops at the schema first;
  //   - and a human reading the document finds `submit.<cid>.uidField` in it, beside the stamp.
  //
  // A number derived from the declaration and published next to the declaration carries nothing.
  assert.equal(protocolFor({ views: [{}, {}] }), APP_PROTOCOL_BASE);
});

test("a view the reader must UNDERSTAND moves the major, for that app alone", () => {
  // The other half, and the reason the stamp is per app again. `views[].article` turns on a SECOND
  // address under the app's public entrance, `/a/{slug}/{id}`: a reader that does not know it draws
  // the app's own index there instead, so every link ever shared to an article lands on the wrong
  // page. Nothing errors, so the major has to move and the older reader has to refuse.
  assert.equal(protocolFor({ views: [{ article: { title: "title", body: "body" } }] }), "2.0.0");
  // The KEY that is asked about is `article` and not the retired `type`, which no reader will ever
  // see again — a view carrying it is refused at the gate, so a protocol derived from it would be
  // derived from a declaration that cannot be published.
  assert.equal(protocolFor({ views: [{}] }), APP_PROTOCOL_BASE);
  // And ONLY for that app. Stamping every app 2.0.0 would make every deployed reader refuse every
  // app published after this build, including ones whose documents did not change at all.
  assert.equal(protocolFor({ views: [{}] }), "1.0.0");
  assert.notEqual(APP_PROTOCOL, APP_PROTOCOL_BASE, "the newest contract is not the one most apps keep");
});

test("a floor above what this build emits is not within it", () => {
  // What the version still exists for: a key whose MEANING moves is invisible to a strict schema,
  // so the author names the contract and `protocolProblems` refuses one this build cannot honour.
  // The ceiling is APP_PROTOCOL — the newest contract this build IMPLEMENTS — and not the one a
  // given app is stamped with: a floor is a statement about the publisher, not about the app.
  const emitted = protocolOf(APP_PROTOCOL);
  // One narrowing assert, then three live ones. Repeating `emitted !== null` in each conjunct was
  // dead after the first `assert.ok`, which narrows the whole expression it was given.
  assert.ok(emitted !== null, "the build's own protocol must read as a version");
  assert.ok(!protocolWithin({ major: 2, minor: 1, patch: 0 }, emitted));
  assert.ok(protocolWithin({ major: 2, minor: 0, patch: 0 }, emitted));
  assert.ok(protocolWithin({ major: 1, minor: 0, patch: 0 }, emitted));
});

test("a version is three numbers, and anything else is not one", () => {
  assert.deepEqual(protocolOf("1.2.3"), { major: 1, minor: 2, patch: 3 });
  for (const text of ["1", "1.2", "1.2.3.4", "v1.2.3", "1.2.3-rc1", "beta", "", "1.2.x"]) {
    assert.equal(protocolOf(text), null, `expected "${text}" not to read as a version`);
  }
});

test("an authored floor is within what this compiler emits only if it is not newer", () => {
  const emitted = protocolOf("1.4.2");
  assert.notEqual(emitted, null);
  const within = (text: string) =>
    protocolWithin(protocolOf(text) as { major: number; minor: number; patch: number }, emitted as { major: number; minor: number; patch: number });
  assert.equal(within("1.4.2"), true, "the same contract");
  assert.equal(within("1.4.1"), true);
  assert.equal(within("1.3.9"), true);
  assert.equal(within("0.9.9"), true);
  assert.equal(within("1.4.3"), false, "a patch this compiler has not implemented");
  assert.equal(within("1.5.0"), false);
  assert.equal(within("2.0.0"), false);
});

test("a slug id moves the major on its own, with no article view anywhere", () => {
  // Codex found this on #51, and it is the worse half of the two: the reader BUILDS the id. An
  // older `recordId` has no `slug` branch, so it falls through to the random uuid it uses for
  // `auto` — while the deployed rules require the document id to EQUAL the submitted field. Every
  // submission is then refused with a bare permission error, on a page that drew itself perfectly.
  //
  // Stamped 1.0.0, that older reader would have gone ahead and done it.
  assert.equal(protocolFor({ public: { submit: { articles: { idFrom: "slug" } } } }), APP_PROTOCOL);
  // And the two are INDEPENDENT: neither implies the other, so both are asked. An app may name its
  // records by slug and publish no articles, or publish articles over generated ids.
  assert.equal(protocolFor({ views: [{ article: { title: "title", body: "body" } }], public: { submit: { notes: { idFrom: "auto" } } } }), APP_PROTOCOL);
  assert.equal(protocolFor({ public: { submit: { bookings: { idFrom: "field" }, notes: {} } } }), APP_PROTOCOL_BASE);
  assert.equal(protocolFor({ public: { submit: {} } }), APP_PROTOCOL_BASE);
});
