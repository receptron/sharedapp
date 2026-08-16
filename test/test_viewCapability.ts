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

test("the staff tier is never handed a participant's withdrawal", () => {
  const both: ProjectedViewWrite = { ...staff, selfDelete: ["requested"] };
  assert.deepEqual(capabilityOf(both, "desk@gym.jp", "member").withdrawFrom, []);
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
