// What a reader may change, as the two parents both have to answer it.
//
// This module moved here from mulmoserver so the author's preview and the live
// page could stop being two implementations. The bug that made it urgent is the
// one asserted at the bottom: MulmoTerminal's pane used the PUBLIC bridge, which
// sends no `viewer` at all, so every roster page previewed there was handed `{}`
// — and a page written against it drew no buttons, which reads exactly like a
// page whose author got the capability names wrong.
//
// The shape assertions are here for the same reason. `can` is keyed by
// COLLECTION, and a page reaching for `viewer.can.transitionAny` gets undefined
// for every app that ever existed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { capabilityOf, capabilitiesFor, mayTransition, viewerFor } from "../src/view/capability.js";
import type { ProjectedViewWrite } from "../src/appViews.js";

const staff: ProjectedViewWrite = {
  cid: "bookings",
  statusField: "status",
  transitions: { requested: ["approved", "rejected"] },
  assigneeField: "coach",
  writers: ["desk@gym.jp"],
  rowWriters: ["coach@gym.jp"],
};

/** A participant's projection: no role lists at all, because a participant's
 *  permission comes from the RECORD. */
const roster: ProjectedViewWrite = {
  cid: "bookings",
  statusField: "status",
  transitions: { requested: ["cancelled"] },
  selfDelete: ["requested"],
};

test("the roster tier decides from the record, so absence is permission to try", () => {
  const can = capabilityOf(roster, "member@example.com", "roster");
  assert.equal(can.transitionAny, true);
  assert.deepEqual(can.withdrawFrom, ["requested"]);
});

test("the member tier fails closed when the projection names no roles", () => {
  // Every projection published before the role lists existed looks like this,
  // which is why it must refuse rather than shrug. Principle 8.
  const { cid, ...rest } = roster;
  assert.equal(cid, "bookings");
  const can = capabilityOf(rest as ProjectedViewWrite & { cid: string }, "desk@gym.jp", "member");
  assert.equal(can.transitionAny, false);
  assert.equal(can.assign, false);
  assert.deepEqual(can.withdrawFrom, []);
});

test("a writer moves any row; an assignee moves only their own", () => {
  const desk = capabilityOf(staff, "desk@gym.jp", "member");
  assert.equal(desk.transitionAny, true);
  assert.equal(desk.assign, true);

  const coach = capabilityOf(staff, "coach@gym.jp", "member");
  assert.equal(coach.transitionAny, false);
  assert.equal(coach.transitionOwn, true);
  // An assignee cannot hand a row on: the rules require it to be theirs before
  // AND after, which no handover satisfies.
  assert.equal(coach.assign, false);

  assert.equal(mayTransition(coach, staff, { coach: "coach@gym.jp" }, "coach@gym.jp"), true);
  assert.equal(mayTransition(coach, staff, { coach: "other@gym.jp" }, "coach@gym.jp"), false);
  // No such row held: left to the rules rather than refused on a guess.
  assert.equal(mayTransition(coach, staff, null, "coach@gym.jp"), true);
});

test("a reader holding no role at all is refused, though the tier admitted them", () => {
  const observer = capabilityOf(staff, "observer@gym.jp", "member");
  assert.equal(observer.transitionAny, false);
  assert.equal(observer.transitionOwn, false);
  assert.equal(observer.assign, false);
});

test("a role that deletes takes the whole answer, and no status list rides beside it", () => {
  // `writerDelete` is any row in any status. Handing the same reader a list as
  // well would draw a control whose refusal names the wrong reason.
  const byRole: ProjectedViewWrite = { ...staff, writerDelete: true, selfDelete: ["requested"] };
  const desk = capabilityOf(byRole, "desk@gym.jp", "member");
  assert.equal(desk.withdrawAny, true);
  assert.deepEqual(desk.withdrawFrom, []);
});

test("a member with no role that deletes still gets the submitter's own half", () => {
  // `ownRow` in the rules asks `authed()` and compares `emailField` — it never
  // asks which tier the reader is on. So a member who SUBMITTED a row may
  // withdraw it, and answering `[]` here reported the rules wrongly: the app it
  // costs is a members-only one whose records are bound to their submitter (a
  // group chat), where there is no role-based write to project at all.
  const own: ProjectedViewWrite = { ...staff, selfDelete: ["requested"] };
  const desk = capabilityOf(own, "desk@gym.jp", "member");
  // Both halves in ONE assertion, and taken before anything narrows them. "Still never both — that
  // is `writerDelete`'s doing, not the tier's" used to be restated as
  // `withdrawAny && withdrawFrom.length > 0`, but the assert above had already narrowed
  // `withdrawAny` to the literal `false`, so that expression folded to `false` and the line could
  // not fail whatever `capabilityOf` returned.
  assert.deepEqual({ withdrawAny: desk.withdrawAny, withdrawFrom: desk.withdrawFrom }, { withdrawAny: false, withdrawFrom: ["requested"] });
});

test("a withdrawal needs a status field, whichever tier is asking", () => {
  // The rules read the CURRENT status off the record before consulting the
  // list, so a collection with none grants nothing however the key is written.
  const { statusField: __dropped, ...noStatus } = staff;
  const write: ProjectedViewWrite = { ...noStatus, selfDelete: ["requested"] };
  assert.deepEqual(capabilityOf(write, "desk@gym.jp", "member").withdrawFrom, []);
  assert.deepEqual(capabilityOf(write, "member@example.com", "roster").withdrawFrom, []);
});

test("`can` is keyed by collection, which is the whole shape a page reads", () => {
  const viewer = viewerFor([staff], "desk@gym.jp", "member");
  assert.deepEqual(Object.keys(viewer), ["me", "can"]);
  assert.equal(viewer.me, "desk@gym.jp");
  assert.deepEqual(Object.keys(viewer.can), ["bookings"]);
  // The reach that looked like a platform bug and was a page bug.
  assert.equal((viewer.can as Record<string, unknown>).transitionAny, undefined);
  assert.equal(viewer.can.bookings?.transitionAny, true);
});

test("a reader with no verified address is a member of nothing, and still has the shape", () => {
  // A page must be able to read `viewer.me` and `viewer.can` without guarding
  // every access: signed out is an ANSWER, not a missing object.
  const viewer = viewerFor([staff], null, "member");
  assert.equal(viewer.me, null);
  assert.equal(viewer.can.bookings?.transitionAny, false);
});

test("the assignee picker is the two role lists, sorted, and nobody else", () => {
  assert.deepEqual(capabilitiesFor([staff], "desk@gym.jp", "member").bookings?.assignees, ["coach@gym.jp", "desk@gym.jp"]);
});

// --- `withdrawAny`: the staff half, resolved against the roster
//
// `withdrawFrom` is the submitter's list of statuses and this is a role, so the two are separate
// fields rather than one with a wider setting. A page asks whichever one its tier carries.

const removable: ProjectedViewWrite = { cid: "names", writerDelete: true, writers: ["desk@gym.jp"], rowWriters: ["coach@gym.jp"] };

test("a writer may take any row away; an assignee and an observer may not", () => {
  assert.equal(capabilityOf(removable, "desk@gym.jp", "member").withdrawAny, true);
  // An assignee writes the rows assigned to them and the rules stop there: `deleteWith`'s second
  // branch wants `isAssigned` AND `assignedBefore`, which is about the row, not about this list.
  assert.equal(capabilityOf(removable, "coach@gym.jp", "member").withdrawAny, false);
  assert.equal(capabilityOf(removable, "observer@gym.jp", "member").withdrawAny, false);
});

test("an app published before the key existed answers NO, rather than everybody", () => {
  // The same fail-closed direction as the rest of this tier: absence on the staff side is "refuse",
  // because a projection that cannot tell a receptionist from an observer must not be read as
  // permission. Every projection in the world is in this state until its app is republished.
  assert.equal(capabilityOf({ cid: "names", writers: ["desk@gym.jp"] }, "desk@gym.jp", "member").withdrawAny, false);
});

test("the roster's tier never carries it, whatever the document says", () => {
  // A participant's deletion is `selfDelete` — their own row, from the statuses the rules read.
  // `writerDelete` reaching that tier would draw a delete-anything control on a page whose readers
  // are participants.
  //
  // ASKED WITH THE WRITER'S OWN ADDRESS, which is the only version of this test that means
  // anything: with a stranger's address the roles branch refuses them anyway, so it passes whether
  // or not the tier is checked at all. The document is what cannot be trusted here — the roster's
  // is a different one from the staff's, and this package is not the only thing that can write it.
  assert.equal(capabilityOf(removable, "desk@gym.jp", "roster").withdrawAny, false);
  assert.equal(capabilityOf(removable, "guest@x.jp", "roster").withdrawAny, false);
});

test("a projection that names no roles grants the staff tier nothing, and every field says so", () => {
  // The `member` half of a collection that names no roles at all. There is nothing for a role to
  // grant, so the answer is the "grants nothing" document — and it is pinned WHOLE rather than one
  // field at a time, because what matters is that every one of them is empty. Flipping any single
  // field of it to `true` used to leave the entire suite green, and a page reading such an answer
  // draws a control the rules will refuse, which arrives at the visitor as a bare permission error.
  assert.deepEqual(capabilityOf({ cid: "names" }, "desk@gym.jp", "member"), {
    cid: "names",
    transitionAny: false,
    transitionOwn: false,
    assign: false,
    assignees: [],
    withdrawFrom: [],
    withdrawAny: false,
    sealed: [],
    correctFrom: {},
    correctAny: false,
  });
});
