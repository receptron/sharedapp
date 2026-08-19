// The version of the contract this compiler emits, and the floor an author may declare.
//
// It exists for a day that has not happened: a breaking change here, and a browser somewhere running
// a build from before it. What must not happen then is that the old reader draws the new documents.
import { test } from "node:test";
import assert from "node:assert/strict";

import { APP_PROTOCOL, UID_FIELD_PROTOCOL, protocolOf, protocolWithin } from "../src/appProtocol.js";

test("the contract stays on major 1, because every reader in the wild draws major 1", () => {
  // It started at 1.0.0 rather than 0.1.0: apps published before this key existed carry no version,
  // and a reader treats those as 1.0.0 — they are the documents in Firestore right now.
  //
  // The MAJOR is the assertion. A minor moves when a key is added (1.1.0 = `uidField`) and every
  // reader keeps drawing every app that does not use it; a major makes every older reader refuse
  // every app published afterwards, whether or not it uses the new thing, so it is a release plan
  // and not an edit.
  assert.equal(protocolOf(APP_PROTOCOL)?.major, 1);
  assert.notEqual(protocolOf(APP_PROTOCOL), null);
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
