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
  if (!read.ok) return;
  assert.equal(read.intent.field, "status");
  assert.equal(read.intent.to, "approved");
});

test("something that is not an intent gets NO request id to answer on", () => {
  const read = readIntentMessage({ hello: "there" }, [bookings], held, desk);
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.equal(read.reason, "not-an-intent");
  // The branch carries neither, which is what makes answering it impossible rather than
  // discouraged. A caller reaching for `requestId` here is a type error.
  assert.equal("requestId" in read, false);
  assert.equal("asked" in read, false);
});

test("a refusal that IS an answer carries what was asked, so the page can name the record", () => {
  const read = readIntentMessage(intent({ cid: "payments" }), [bookings], held, desk);
  assert.equal(read.ok, false);
  if (read.ok || read.reason === "not-an-intent") return;
  assert.equal(read.reason, "unknown-collection");
  assert.equal(read.requestId, "r1");
  assert.equal(read.asked.cid, "payments");
});

test("a reader holding no role is refused, though the tier admitted them", () => {
  const read = readIntentMessage(intent(), [bookings], held, { address: "observer@gym.jp", tier: "member" });
  assert.equal(read.ok, false);
  if (read.ok || read.reason === "not-an-intent") return;
  assert.equal(read.reason, "not-permitted");
});

test("a move the table does not carry is refused against the status the page holds", () => {
  const read = readIntentMessage(intent({ to: "cancelled" }), [bookings], held, desk);
  assert.equal(read.ok, false);
  if (read.ok || read.reason === "not-an-intent") return;
  assert.equal(read.reason, "illegal-transition");
});

test("a withdrawal carrying a destination is not read as an intent at all", () => {
  // Not a withdrawal with extra decoration — a page asking for something this parent cannot
  // describe. Answering it would be describing it.
  const read = readIntentMessage(intent({ kind: "withdraw", to: "gone" }), [bookings], held, desk);
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.equal(read.reason, "not-an-intent");
});

test("mail rides with the move, and takes only the fields the declaration named", () => {
  const mailed: ProjectedViewWrite = {
    ...bookings,
    mail: { toField: "memberEmail", on: { approved: { from: ["requested"], to: "approved" } }, dataFields: ["status", "constructor"] },
  };
  const read = readIntentMessage(intent(), [mailed], held, desk);
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.intent.mail?.to, "guest@x.jp");
  assert.equal(read.intent.mail?.template, "approved");
  // `constructor` is on every object's PROTOTYPE and on no record. A declaration naming it must
  // not put a function into the queued mail — the rules refuse that with a permission error
  // naming nothing, over a template that reads as correct.
  assert.deepEqual(read.intent.mail?.data, { status: "requested" });
});
