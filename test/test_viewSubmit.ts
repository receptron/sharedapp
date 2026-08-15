// What a public submission BECOMES, tested against what the deployed rules require of it.
//
// This half of the package had no test of its own, and the thing that went wrong is the reason it
// needed one: `stampField` was parsed, checked at publish and published to `config/public`, and
// then written by NOBODY. Every check passed. The symptom appeared only in a deployed app, as
// "Missing or insufficient permissions" on every public create, naming no field.
//
// So the assertions here are phrased as the rules read the record, not as the page builds it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { missingRequired, recordId, recordOf, writableFields, type DrawnForm, type SubmitSpec } from "../src/view/submit.js";

/** A sentinel that is not a value this module could have invented. The real one is Firestore's
 *  `serverTimestamp()`, which is opaque here on purpose — see `ServerTime`. */
const SENTINEL = { sentinel: "server-time" };
const serverTime = () => SENTINEL;

const drawn: DrawnForm = {
  fields: { memberName: { label: "Name", required: true }, note: { label: "Note" } },
  statusField: "status",
};

const submit: SubmitSpec = {
  auth: "verifiedEmail",
  createFields: ["memberName", "note", "memberEmail", "status"],
  emailField: "memberEmail",
  initialStatus: "requested",
};

const fields = () => writableFields(drawn, submit.createFields, submit.emailField);
const account = { uid: "uid_visitor", email: "visitor@example.com" };

test("the record carries what the visitor typed, their verified address and the pinned status", () => {
  const record = recordOf(fields(), drawn, submit, { memberName: "A", note: "" }, account, serverTime);
  // `note` was left empty and is ABSENT rather than "": the rules test presence.
  assert.deepEqual(record, { memberName: "A", memberEmail: "visitor@example.com", status: "requested" });
});

test("a declared stampField is written, with the value the HOST produced", () => {
  // `stampOk` refuses a create unless the field is present AND equal to `request.time`, so a
  // record without this key is refused for every first-come app there is.
  const stamped: SubmitSpec = { ...submit, createFields: [...submit.createFields, "createdAt"], stampField: "createdAt" };
  const record = recordOf(writableFields(drawn, stamped.createFields, stamped.emailField), drawn, stamped, { memberName: "A" }, account, serverTime);
  assert.equal(record.createdAt, SENTINEL);
});

test("the stamp is not produced for an app that declares none", () => {
  // A host with nothing to stamp must not be made to build a sentinel it has no use for.
  let calls = 0;
  recordOf(fields(), drawn, submit, { memberName: "A" }, account, () => {
    calls += 1;
    return SENTINEL;
  });
  assert.equal(calls, 0);
});

test("the server's clock wins over anything drawn for the same field", () => {
  // Publish keeps the stamped field out of the drawn form, so this should be unreachable — and it
  // is asserted anyway, because the one value the rules will accept is the one they set.
  const stamped: SubmitSpec = { ...submit, createFields: ["createdAt"], stampField: "createdAt" };
  const withBox: DrawnForm = { fields: { createdAt: { label: "When" } } };
  const record = recordOf(writableFields(withBox, stamped.createFields, undefined), withBox, stamped, { createdAt: "1999-01-01" }, account, serverTime);
  assert.equal(record.createdAt, SENTINEL);
});

test("a required answer left empty is named by its label", () => {
  assert.deepEqual(missingRequired(fields(), { memberName: "", note: "x" }), ["Name"]);
  assert.deepEqual(missingRequired(fields(), { memberName: "A" }), []);
});

test("the id is built from the RECORD, so a stamped app still claims the right thing", () => {
  const stamped: SubmitSpec = { ...submit, stampField: "createdAt", idFrom: "auth.uid+field", idField: "memberEmail" };
  const record = recordOf(fields(), drawn, stamped, { memberName: "A" }, account, serverTime);
  assert.equal(recordId(stamped, account.uid, record, "unused"), "uid_visitor_visitor@example.com");
});
