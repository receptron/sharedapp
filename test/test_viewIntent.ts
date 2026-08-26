// What the parent will accept from a member's page, and what it refuses.
//
// The property with the sharpest edge is the one that is NOT an answer: a message that is not an
// intent at all gets no reply, because replying would be answering something nobody asked. The
// type says so now — that branch carries no `requestId` — where it used to fabricate an empty one
// that no caller read and every caller was invited to.

import { test } from "node:test";
import assert from "node:assert/strict";

import { readIntentMessage } from "../src/view/intent.js";
import { VIEW_MESSAGE } from "../src/view/protocol.js";
import type { ProjectedViewWrite } from "../src/appViews.js";

const bookings: ProjectedViewWrite = {
  cid: "bookings",
  statusField: "status",
  transitions: { requested: ["approved"] },
  writers: ["desk@gym.jp"],
};

const held = (cid: string, itemId: string): Record<string, unknown> | null =>
  cid === "bookings" && itemId === "b1" ? { status: "requested", memberEmail: "guest@x.jp" } : null;

const desk = { address: "desk@gym.jp", tier: "member" as const };

const intent = (over: Record<string, unknown> = {}) => ({
  type: VIEW_MESSAGE.intent,
  requestId: "r1",
  kind: "transition",
  cid: "bookings",
  itemId: "b1",
  to: "approved",
  ...over,
});

test("a declared move by a writer is judged good", () => {
  const read = readIntentMessage(intent(), [bookings], held, desk);
  assert.equal(read.ok, true);
  assert.equal(read.intent.field, "status");
  assert.equal(read.intent.to, "approved");
});

test("something that is not an intent gets NO request id to answer on", () => {
  const read = readIntentMessage({ hello: "there" }, [bookings], held, desk);
  assert.equal(read.ok, false);
  assert.equal(read.reason, "not-an-intent");
  // The branch carries neither, which is what makes answering it impossible rather than
  // discouraged. A caller reaching for `requestId` here is a type error.
  assert.equal("requestId" in read, false);
  assert.equal("asked" in read, false);
});

test("a refusal that IS an answer carries what was asked, so the page can name the record", () => {
  const read = readIntentMessage(intent({ cid: "payments" }), [bookings], held, desk);
  assert.equal(read.ok, false);
  assert.equal(read.reason, "unknown-collection");
  assert.equal(read.requestId, "r1");
  assert.equal(read.asked.cid, "payments");
});

test("a reader holding no role is refused, though the tier admitted them", () => {
  const read = readIntentMessage(intent(), [bookings], held, { address: "observer@gym.jp", tier: "member" });
  assert.equal(read.ok, false);
  assert.equal(read.reason, "not-permitted");
});

test("a move the table does not carry is refused against the status the page holds", () => {
  const read = readIntentMessage(intent({ to: "cancelled" }), [bookings], held, desk);
  assert.equal(read.ok, false);
  assert.equal(read.reason, "illegal-transition");
});

test("a withdrawal carrying a destination is not read as an intent at all", () => {
  // Not a withdrawal with extra decoration — a page asking for something this parent cannot
  // describe. Answering it would be describing it.
  const read = readIntentMessage(intent({ kind: "withdraw", to: "gone" }), [bookings], held, desk);
  assert.equal(read.ok, false);
  assert.equal(read.reason, "not-an-intent");
});

test("mail rides with the move, and takes only the fields the declaration named", () => {
  const mailed: ProjectedViewWrite = {
    ...bookings,
    mail: { toField: "memberEmail", on: { approved: { from: ["requested"], to: "approved" } }, dataFields: ["status", "constructor"] },
  };
  const read = readIntentMessage(intent(), [mailed], held, desk);
  assert.equal(read.ok, true);
  // The move itself, checked HERE too and not only on the mail-less path: the two share nothing
  // but a name, so `field` could be wrong on this branch alone with the whole suite green.
  assert.equal(read.intent.field, "status");
  assert.equal(read.intent.to, "approved");
  assert.equal(read.intent.mail?.to, "guest@x.jp");
  assert.equal(read.intent.mail.template, "approved");
  // `constructor` is on every object's PROTOTYPE and on no record. A declaration naming it must
  // not put a function into the queued mail — the rules refuse that with a permission error
  // naming nothing, over a template that reads as correct.
  assert.deepEqual(read.intent.mail.data, { status: "requested" });
});

// --- the staff half of a withdrawal (`writerDelete`)
//
// The permission the rules always had and no page could ask for: `deleteWith` opens with
// `isWriter(r)` and asks nothing about the record, while the projection carried only `selfDelete`,
// which is the roster's. An owner who wanted to delete a row had to move the whole page to
// `participant` — giving up assignment, the staff transitions and the roster's answer about who is
// who — to reach a permission they already held.

/** A staff projection for a collection whose rows the desk may take away. No `selfDelete`: that is
 *  the other tier's declaration and this page never carries it. */
const names: ProjectedViewWrite = { cid: "names", writerDelete: true, writers: ["desk@gym.jp"] };

const withdraw = (cid: string, itemId: string) => ({ type: VIEW_MESSAGE.intent, requestId: "r1", kind: "withdraw", cid, itemId });

test("a writer takes any row away, and needs no status to do it", () => {
  // NO `statusField` on this collection at all, which is the ordinary shape of a roster of names —
  // and the participant's half cannot express it: `selfDelete` names statuses, so a collection
  // without one grants nothing there however it is declared.
  const read = readIntentMessage(withdraw("names", "n1"), [names], () => null, desk);
  assert.equal(read.ok, true);
  assert.equal(read.intent.kind, "withdraw");
  assert.equal(read.intent.field, undefined, "a withdrawal moves nothing");
});

test("the status the row is in does not narrow it, because the rules do not either", () => {
  // A list here would be a check only the page believes in: the writer branch reads no statuses, so
  // a page hiding the control in some status hides a deletion the rules would have allowed.
  const moving: ProjectedViewWrite = { ...names, cid: "bookings", statusField: "status", transitions: { requested: ["approved"] } };
  const read = readIntentMessage(withdraw("bookings", "b1"), [moving], held, desk);
  assert.equal(read.ok, true);
});

test("a reader on the same page who holds no role is NOT-PERMITTED, rather than told nothing is writable", () => {
  // Two different sentences for two different problems. `not-writable` sends the author to the
  // declaration; the declaration is right here and the answer is the roster.
  const observer = { address: "observer@gym.jp", tier: "member" as const };
  const read = readIntentMessage(withdraw("names", "n1"), [names], () => null, observer);
  assert.equal(read.ok, false);
  assert.equal(read.reason, "not-permitted");
});

test("a collection that declares neither half is still not-writable", () => {
  const readOnly: ProjectedViewWrite = { cid: "names", writers: ["desk@gym.jp"] };
  const read = readIntentMessage(withdraw("names", "n1"), [readOnly], () => null, desk);
  assert.equal(read.ok, false);
  assert.equal(read.reason, "not-writable");
});

test("the mirror rides with a writer's delete too", () => {
  // `deleteWith` asks `mirrorReleased` BEFORE it asks who is deleting, so a desk deleting a booking
  // without reopening the slot is refused exactly as a visitor's cancellation would be — and the
  // slot would otherwise be unsellable for ever.
  const mirrored: ProjectedViewWrite = { ...names, cid: "bookings", withdrawMirror: "slots" };
  const read = readIntentMessage(withdraw("bookings", "b1"), [mirrored], held, desk);
  assert.equal(read.ok, true);
  assert.equal(read.intent.mirror, "slots");
});

test("a participant's own withdrawal is judged exactly as before", () => {
  // The staff half is a second permission, not a wider setting of this one: the statuses still
  // apply, because the rules read this list.
  const own: ProjectedViewWrite = { cid: "bookings", statusField: "status", selfDelete: ["requested"] };
  const guest = { address: "guest@x.jp", tier: "roster" as const };
  assert.equal(readIntentMessage(withdraw("bookings", "b1"), [own], held, guest).ok, true);

  const later = (cid: string, itemId: string) => (cid === "bookings" && itemId === "b1" ? { status: "approved" } : null);
  const refused = readIntentMessage(withdraw("bookings", "b1"), [own], later, guest);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "illegal-transition");
});

// --- the seal, which overrides both halves (`sealed`)
//
// `writerDelete` says "any row" and the rules mean "any row the RECORD has not sealed": `sealedNow`
// is a conjunct above the branch `isWriter` sits in, so it refuses the owner too. Approving here
// would hand the page a call certain to come back a permission denial — the one thing this layer
// exists to stop — and the neighbouring test above is exactly why it has to be said explicitly:
// the staff half is deliberately status-blind, so nothing else in this file would catch it.

const sealedNames: ProjectedViewWrite = {
  cid: "topics",
  writerDelete: true,
  writers: ["desk@gym.jp"],
  statusField: "status",
  sealed: ["closed"],
};

const topicHeld = (cid: string, itemId: string): Record<string, unknown> | null =>
  cid === "topics" ? { status: itemId === "t-closed" ? "closed" : "open" } : null;

test("a writer cannot take away a row the record has sealed", () => {
  const read = readIntentMessage(withdraw("topics", "t-closed"), [sealedNames], topicHeld, desk);
  assert.equal(read.ok, false);
  // About the STATE the row is in, not about who asked — the same sentence the
  // status-out-of-range branch says for the submitter's half.
  assert.equal(read.reason, "illegal-transition");
});

test("the seal names one status, and leaves the others alone", () => {
  // The guard on the guard: without this the test above passes just as well
  // against a projection that refused every delete.
  const read = readIntentMessage(withdraw("topics", "t-open"), [sealedNames], topicHeld, desk);
  assert.equal(read.ok, true);
});

test("a collection that seals nothing is unaffected", () => {
  const read = readIntentMessage(withdraw("names", "n1"), [names], () => null, desk);
  assert.equal(read.ok, true);
});
