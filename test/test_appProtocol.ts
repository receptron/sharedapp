// The version of the contract this compiler emits, and the floor an author may declare.
//
// It exists for a day that has not happened: a breaking change here, and a browser somewhere running
// a build from before it. What must not happen then is that the old reader draws the new documents.
import { test } from "node:test";
import assert from "node:assert/strict";

import { APP_PROTOCOL, BASE_PROTOCOL, UID_FIELD_PROTOCOL, protocolFor, protocolOf, protocolWithin } from "../src/appProtocol.js";

test("an app using nothing new is stamped what it has always been stamped", () => {
  // The compatibility assertion, and the whole reason the version is per app rather than per build.
  // It started at 1.0.0 rather than 0.1.0: apps published before this key existed carry no version,
  // and a reader treats those as 1.0.0 — they are the documents in Firestore right now. Every
  // reader in the wild draws major 1, so anything that moves this line stops them all.
  assert.equal(BASE_PROTOCOL, "1.0.0");
  assert.equal(protocolFor({}), BASE_PROTOCOL);
  assert.equal(protocolFor({ public: { submit: { responses: {} } } }), BASE_PROTOCOL);
});

test("an app using uidField says so, in a version that stays inside major 1", () => {
  assert.equal(protocolFor({ public: { submit: { claims: { uidField: "uid" } } } }), UID_FIELD_PROTOCOL);
  // The major is what makes an older reader refuse an app, and this addition does not need one: a
  // reader that has not learnt uidField already refuses such a projection through the submit/form
  // consistency check it has had since 1.0.0 (the uid is in `createFields`, because the rules take
  // no key outside it, and never in `form.fields`, because not drawing it IS the feature). Moving
  // this to 2 would refuse every uid app on every reader in the wild to buy a screen they already
  // show. What the number is for here is the authored floor, which an old PUBLISHER refuses.
  assert.equal(protocolOf(UID_FIELD_PROTOCOL)?.major, 1);
  assert.ok(protocolOf(UID_FIELD_PROTOCOL)!.minor > protocolOf(BASE_PROTOCOL)!.minor);
  // One collection out of several is enough: the app is published, and read, whole.
  assert.equal(protocolFor({ public: { submit: { tasks: {}, claims: { uidField: "uid" } } } }), UID_FIELD_PROTOCOL);
});

test("a feature floor is a version this compiler can actually emit", () => {
  // A floor above what publish writes would refuse every app that declared it — including the one
  // the floor was added for, which is the shape that gets shipped because nothing else tests it.
  const emitted = protocolOf(APP_PROTOCOL);
  const floor = protocolOf(UID_FIELD_PROTOCOL);
  assert.notEqual(floor, null);
  assert.ok(emitted !== null && floor !== null && protocolWithin(floor, emitted));
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
