// A projection's `write` half, read back — by the two hosts that must not disagree about it.
//
// Every assertion here is a case where a LOOSE read would draw a control that production refuses.
// That direction is the one that matters: MulmoTerminal's pane previews the page mulmoserver
// serves, and a preview which accepts what production drops is worse than no preview.

import { test } from "node:test";
import assert from "node:assert/strict";

import { projectedWriteOf, projectedWritesOf } from "../src/view/writeRead.js";
import { writeFor, type ProjectedViewWrite } from "../src/appViews.js";
import { AuthoredAppZ } from "../src/publishManifest.js";

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
  assert.equal("rowWriters" in write, false);
  assert.deepEqual(projectedWriteOf({ cid: "bookings", assigneeField: "coach", rowWriters: [] })?.rowWriters, []);
});

test("an empty selfDelete is dropped, because it reads as permission and means the opposite", () => {
  assert.equal("selfDelete" in (projectedWriteOf({ cid: "b", statusField: "s", transitions: { a: ["b"] }, selfDelete: [] }) ?? {}), false);
  const kept = projectedWriteOf({ cid: "b", selfDelete: ["requested"], withdrawMirror: "slots" });
  assert.deepEqual(kept?.selfDelete, ["requested"]);
  assert.equal(kept.withdrawMirror, "slots");
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

test("the writer's delete is read STRICTLY as `true`, and anything else is not a permission", () => {
  // A document read out of Firestore, where anybody who ever held a role could in principle have
  // written it. `"false"` and `1` are both truthy, and a truthy read here would turn either into a
  // delete button for the whole staff tier.
  assert.equal(projectedWriteOf({ cid: "names", writerDelete: true })?.writerDelete, true);
  assert.equal(projectedWriteOf({ cid: "names", writerDelete: "true" }), null);
  assert.equal(projectedWriteOf({ cid: "names", writerDelete: 1 }), null);
});

test("the mirror is carried by whichever half of the withdrawal it arrived with", () => {
  // The rules ask `mirrorReleased` before they ask who is deleting, so a staff delete needs the
  // collection name exactly as a submitter's cancellation does.
  assert.equal(projectedWriteOf({ cid: "bookings", writerDelete: true, withdrawMirror: "slots" })?.withdrawMirror, "slots");
  assert.equal(projectedWriteOf({ cid: "bookings", selfDelete: ["pending"], withdrawMirror: "slots" })?.withdrawMirror, "slots");
  // On its own it names a collection nobody may reopen, so it grants nothing and is not kept.
  assert.equal(projectedWriteOf({ cid: "bookings", withdrawMirror: "slots" }), null);
});

// --- the round trip itself
//
// The bug that produced this block was not a wrong read, it was a MISSING one: `withdrawPart`
// learned to publish `sealed` and nothing here learned to read it, so the deployed JSON silently
// dropped it and every writer got `withdrawAny: true, sealed: []` — the page approving deletions
// Firestore then refused, which is the exact disagreement the projection exists to prevent.
//
// So the assertion is not about `sealed`. It is that whatever `writeFor` emits survives the trip,
// checked key by key against the real projector rather than against a fixture — the next key
// somebody adds is covered without anybody remembering to come back here.

const roundTrip = (write: ProjectedViewWrite): ProjectedViewWrite | null => projectedWriteOf(JSON.parse(JSON.stringify(write)) as unknown);

/** EVERY key `writeFor` can emit, in one collection, so the deepEqual below is a real check on all
 *  of them rather than on the four this fixture happened to declare. A key added to
 *  `ProjectedViewWrite` and not to this app is a key the round trip does not cover — which is
 *  precisely how `sealed` got through. */
const sealingApp = {
  aid: "app_seal",
  members: { "desk@gym.jp": { "*": "owner" }, "coach@gym.jp": { topics: "assignee" } },
  collections: {
    topics: {
      statusField: "status",
      transitions: { initial: ["open"], open: ["closed"] },
      writerDelete: true,
      sealed: ["closed"],
      assigneeField: "owner",
      mail: { toField: "who", on: { closing: { from: ["open"], to: "closed" } }, dataFields: ["title"] },
    },
  },
  public: {
    enabled: true,
    submit: {
      topics: {
        auth: "verifiedEmail",
        emailField: "who",
        createFields: ["title", "who", "owner", "status"],
        initialStatus: "open",
        selfDelete: ["open"],
        // Carries `withdrawMirror`, the eleventh and last key. The `slots`
        // collection it names is not declared here: this test calls `writeFor`,
        // which projects the declaration, and publish is what checks the pair.
        mirror: "slots",
      },
    },
  },
};

test("everything writeFor publishes survives the deployed-JSON round trip", () => {
  const app = AuthoredAppZ.parse(sealingApp);
  for (const audience of ["member", "public"] as const) {
    const written = writeFor(app, audience, "topics");
    assert.notEqual(written, null, `${audience} must project something`);
    if (written === null) continue;
    // deepEqual, not a key spot-check: a half-read key is the failure mode, and
    // reading it as the wrong VALUE is just as silent as not reading it.
    assert.deepEqual(roundTrip(written), written, `${audience} projection must survive readback`);
  }
});

test("the seal reaches a staff page whose only permission is the role one", () => {
  // The narrow case the fix turned on. `statusField` rides with `selfDelete`, so a collection
  // carrying ONLY `writerDelete` reaches the seal with no field attached — and `judgeWithdraw`
  // needs the field to read the record's status. Carried and never consulted is the worst of the
  // three outcomes, because the page looks correct.
  const staffOnly = { cid: "topics", writerDelete: true, statusField: "status", sealed: ["closed"] };
  const read = projectedWriteOf(staffOnly);
  assert.deepEqual(read?.sealed, ["closed"]);
  assert.equal(read.statusField, "status");
});

test("a seal with nothing to read the status off is dropped", () => {
  // Publish refuses this pair, so it is a floor rather than a case: without the field the seal
  // could never be consulted, and a carried-but-dead list is what this whole file guards against.
  assert.equal("sealed" in (projectedWriteOf({ cid: "topics", writerDelete: true, sealed: ["closed"] }) ?? {}), false);
});

test("a seal on a collection nobody may delete from is dropped with the rest", () => {
  // Nothing to narrow: no permission was carried, so there is no control for the page to draw.
  assert.equal(projectedWriteOf({ cid: "topics", statusField: "status", sealed: ["closed"] }), null);
});
