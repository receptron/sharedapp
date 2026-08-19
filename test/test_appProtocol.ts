// The version of the contract this compiler emits, and the floor an author may declare.
//
// It exists for a day that has not happened: a breaking change here, and a browser somewhere running
// a build from before it. What must not happen then is that the old reader draws the new documents.
import { test } from "node:test";
import assert from "node:assert/strict";

import { APP_PROTOCOL, protocolOf, protocolWithin } from "../src/appProtocol.js";

test("every app is stamped the first contract, uidField included", () => {
  // The compatibility assertion. It started at 1.0.0 rather than 0.1.0: apps published before this
  // key existed carry no version and a reader treats those as 1.0.0 — they are the documents in
  // Firestore right now. Every reader in the wild draws major 1, so anything that moves this line
  // stops them all.
  assert.equal(APP_PROTOCOL, "1.0.0");
  assert.equal(APP_PROTOCOL, APP_PROTOCOL);
});

test("adding a key to the contract does not move the number, because nothing reads the move", () => {
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
  assert.equal(APP_PROTOCOL, "1.0.0");
});

test("a floor above what this build emits is not within it", () => {
  // What the version still exists for: a key whose MEANING moves is invisible to a strict schema,
  // so the author names the contract and `protocolProblems` refuses one this build cannot honour.
  const emitted = protocolOf(APP_PROTOCOL);
  assert.notEqual(emitted, null);
  assert.ok(emitted !== null && !protocolWithin({ major: 1, minor: 1, patch: 0 }, emitted));
  assert.ok(emitted !== null && protocolWithin({ major: 1, minor: 0, patch: 0 }, emitted));
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
