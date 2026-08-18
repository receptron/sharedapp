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

import {
  MISSING_ID_FIELD,
  missingIdField,
  missingRequired,
  recordId,
  recordOf,
  SubmitRefused,
  writableFields,
  type DrawnForm,
  type SubmitSpec,
} from "../src/view/submit.js";

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

test("no address is written for a submission nobody signed in for", () => {
  // `auth: "none"` is a mode the rules support, and `emailField` is filled from the ACCOUNT — so
  // with nobody signed in the key has to be absent rather than empty. The rules read a public
  // create with `hasOnly(createFields)` and compare the address to `request.auth.token.email`; an
  // empty string would be a value that matches nobody.
  assert.deepEqual(recordOf(fields(), drawn, submit, { memberName: "A" }, null, serverTime), { memberName: "A", status: "requested" });
  const noAddress = { uid: "uid_visitor", email: null };
  assert.deepEqual(recordOf(fields(), drawn, submit, { memberName: "A" }, noAddress, serverTime), { memberName: "A", status: "requested" });
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

test("a required answer of nothing but whitespace is missing, and a real one with spaces in it is not", () => {
  // Space, tab, newline: each is an answer nobody typed on purpose, and each used to pass this
  // check and go on to become a name nobody can read — or a document id made of a space.
  assert.deepEqual(missingRequired(fields(), { memberName: " " }), ["Name"]);
  assert.deepEqual(missingRequired(fields(), { memberName: "\t\n  " }), ["Name"]);
  // And what is trimmed is only the JUDGEMENT. A value whose spaces are part of it is accepted
  // here and stored as typed.
  assert.deepEqual(missingRequired(fields(), { memberName: " A " }), []);
  assert.deepEqual(recordOf(fields(), drawn, submit, { memberName: " A " }, account, serverTime).memberName, " A ");
});

/** The refusal a call made, insisted on: a call that returned an id where one cannot be built is
 *  the bug being tested for, so "no throw" has to fail here rather than skip the assertions. */
const refusalOf = (call: () => string): SubmitRefused => {
  try {
    assert.fail(`built the id ${call()} instead of refusing`);
  } catch (error) {
    assert.ok(error instanceof SubmitRefused, `expected a SubmitRefused, got ${String(error)}`);
    return error;
  }
};

const slot: SubmitSpec = {
  auth: "verifiedEmail",
  createFields: ["slotId", "memberName", "memberEmail"],
  emailField: "memberEmail",
  idFrom: "field",
  idField: "slotId",
};
const slotDrawn: DrawnForm = { fields: { slotId: { label: "Slot", required: true }, memberName: { label: "Name" } } };

test("an id built from a field is refused when the field carries nothing", () => {
  // `""` is not a document id, and the SDK's complaint about it names a path rather than a field.
  const record = recordOf(writableFields(slotDrawn, slot.createFields, slot.emailField), slotDrawn, slot, { memberName: "A" }, account, serverTime);
  assert.equal(missingIdField(slot, record), "slotId");
  const thrown = refusalOf(() => recordId(slot, account.uid, record, "unused"));
  assert.equal(thrown.code, MISSING_ID_FIELD);
  assert.match(thrown.message, /slotId/);
  // A non-string is empty for the same reason `stringAt` says it is: the rules compare a string.
  assert.equal(missingIdField(slot, { slotId: 7 }), "slotId");
});

test("an id field holding nothing but whitespace is refused, and one with spaces IN it is not", () => {
  // `missingRequired` does not cover this: an id field the schema leaves optional is never asked
  // about there, so a lone space arrives here intact — as a document named " " under `field`, and
  // as `"<uid>_ "` under `auth.uid+field`, which is one document per person, the collision this
  // whole refusal exists to prevent.
  assert.equal(missingIdField(slot, { slotId: " " }), "slotId");
  assert.equal(missingIdField({ ...slot, idFrom: "auth.uid+field" }, { slotId: "\t\n" }), "slotId");
  assert.equal(refusalOf(() => recordId(slot, account.uid, { slotId: "  " }, "unused")).code, MISSING_ID_FIELD);
  // Trimmed for the JUDGEMENT only. An id that has a space inside it is the id, and it is built
  // byte-for-byte: the rules compare what the record holds, not a tidied version of it.
  assert.equal(missingIdField(slot, { slotId: "sat 0900" }), undefined);
  assert.equal(recordId(slot, account.uid, { slotId: "sat 0900" }, "unused"), "sat 0900");
});

test("an id built from person AND field is refused rather than collapsing to one per person", () => {
  // `"<uid>_"` IS a valid document id, which is what makes it the worse of the two: every claim by
  // one person lands on the same document and the second looks like it took something.
  const perThing: SubmitSpec = { ...slot, idFrom: "auth.uid+field" };
  assert.equal(refusalOf(() => recordId(perThing, account.uid, {}, "unused")).code, MISSING_ID_FIELD);
});

test("the ids the deployed apps already write are unchanged", () => {
  // The acceptance half. tennis claims a slot by its id; gym and live key one record per person
  // per thing. Both must come out byte-for-byte as they did before the refusal existed.
  const record = recordOf(writableFields(slotDrawn, slot.createFields, slot.emailField), slotDrawn, slot, { slotId: "sat-0900" }, account, serverTime);
  assert.equal(missingIdField(slot, record), undefined);
  assert.equal(recordId(slot, account.uid, record, "unused"), "sat-0900");
  assert.equal(recordId({ ...slot, idFrom: "auth.uid+field" }, account.uid, record, "unused"), "uid_visitor_sat-0900");
  // And the three modes that never look at a field keep answering without one.
  assert.equal(recordId({ ...slot, idFrom: "auth.uid", idField: "slotId" }, account.uid, {}, "unique_1"), "uid_visitor");
  assert.equal(recordId({ ...slot, idFrom: "auto", idField: "slotId" }, account.uid, {}, "unique_1"), "unique_1");
  assert.equal(recordId({ createFields: [] }, account.uid, {}, "unique_1"), "unique_1");
});

test("a stamped field is not a box to fill in, and is stamped anyway", () => {
  // Declared required in the schema, the stamp was drawn as an input the visitor could not
  // usefully fill — and then `missingRequired` stopped the submission over the one field the
  // server was about to overwrite.
  const stamped: SubmitSpec = { ...submit, createFields: [...submit.createFields, "createdAt"], stampField: "createdAt" };
  const stampedDrawn: DrawnForm = { ...drawn, fields: { ...drawn.fields, createdAt: { label: "When", required: true } } };
  const withStamp = writableFields(stampedDrawn, stamped.createFields, stamped.emailField, stamped.stampField);
  assert.deepEqual(
    withStamp.map((field) => field.name),
    ["memberName", "note"],
  );
  assert.deepEqual(missingRequired(withStamp, { memberName: "A" }), []);
  assert.equal(recordOf(withStamp, stampedDrawn, stamped, { memberName: "A" }, account, serverTime).createdAt, SENTINEL);
});

test("passing the stamp of an app that has none changes no field list", () => {
  // The compatibility half: the fourth argument is optional, and an app with nothing to stamp must
  // draw exactly what it drew from three arguments.
  assert.deepEqual(writableFields(drawn, submit.createFields, submit.emailField, submit.stampField), fields());
  assert.deepEqual(writableFields(drawn, submit.createFields, submit.emailField, undefined), fields());
});
