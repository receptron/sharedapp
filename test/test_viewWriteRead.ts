// A projection's `write` half, read back — by the two hosts that must not disagree about it.
//
// Every assertion here is a case where a LOOSE read would draw a control that production refuses.
// That direction is the one that matters: MulmoTerminal's pane previews the page mulmoserver
// serves, and a preview which accepts what production drops is worse than no preview.

import { test } from "node:test";
import assert from "node:assert/strict";

import { projectedWriteOf, projectedWritesOf } from "../src/view/writeRead.js";

test("a status field with no table grants nothing, and a table with no field has nowhere to write", () => {
  // BOTH HALVES OR NEITHER. A field alone would offer every value; a table alone has no field.
  assert.equal(projectedWriteOf({ cid: "bookings", statusField: "status" }), null);
  assert.equal(projectedWriteOf({ cid: "bookings", transitions: { requested: ["approved"] } }), null);
  const both = projectedWriteOf({ cid: "bookings", statusField: "status", transitions: { requested: ["approved"] } });
  assert.equal(both?.statusField, "status");
});

test("an absent rowWriters stays absent, because `[]` means something else entirely", () => {
  // Absence is what tells `capabilityOf` that a projection names no roles at all. Inventing `[]`
  // makes it look role-scoped, which on the roster tier refuses a participant's own-row transition
  // before the rules ever get to apply `ownRow`.
  const write = projectedWriteOf({ cid: "bookings", assigneeField: "coach" });
  assert.equal(write?.assigneeField, "coach");
  assert.equal("rowWriters" in (write ?? {}), false);
  assert.deepEqual(projectedWriteOf({ cid: "bookings", assigneeField: "coach", rowWriters: [] })?.rowWriters, []);
});

test("an empty selfDelete is dropped, because it reads as permission and means the opposite", () => {
  assert.equal("selfDelete" in (projectedWriteOf({ cid: "b", statusField: "s", transitions: { a: ["b"] }, selfDelete: [] }) ?? {}), false);
  const kept = projectedWriteOf({ cid: "b", selfDelete: ["requested"], withdrawMirror: "slots" });
  assert.deepEqual(kept?.selfDelete, ["requested"]);
  assert.equal(kept?.withdrawMirror, "slots");
});

test("a collection with nothing writable is dropped rather than kept empty", () => {
  // An entry is what a page draws a button from.
  assert.equal(projectedWriteOf({ cid: "bookings" }), null);
  assert.equal(projectedWriteOf({ cid: "" }), null);
  assert.equal(projectedWriteOf("nope"), null);
});

test("a config with no write at all answers with nothing writable", () => {
  assert.deepEqual(projectedWritesOf(null), []);
  assert.deepEqual(projectedWritesOf({}), []);
  assert.deepEqual(projectedWritesOf({ write: "not a list" }), []);
});

test("the unreadable entries are dropped and the rest survive, one bad one costing one button", () => {
  // Unlike a view's collections this is NOT all-or-nothing: a missing entry costs a control, where
  // a missing dataset would have the page draw the wrong thing silently.
  const read = projectedWritesOf({ write: [{ cid: "bookings", statusField: "s", transitions: { a: ["b"] } }, { cid: "" }, { nope: true }] });
  assert.equal(read.length, 1);
  assert.equal(read[0]?.cid, "bookings");
});
