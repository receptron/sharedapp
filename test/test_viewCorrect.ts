// The correction: rewriting fields of a record that already exists.
//
// The ask that carries VALUES, and therefore the only one whose bounds are not implied by the
// vocabulary. Four of them, and each is tested from the side that would let a write through:
//
//   `correctAny`   the ROLE branch -- the author editing their own article, which is the case
//                  `correctFrom` cannot express because an ordinary blog declares no `selfUpdate`.
//   `correctFrom`  the SUBMITTER's branch, per status.
//   `frozen`       binds both, the owner included. Not a permission.
//   `maxBytes`     the one refusal here that the deployed rules do NOT also make.
//
// The last two are checked BEFORE the role, and there is a test for that ordering: a judgement
// that asked who first would approve an owner's edit of the stamp and hand the page a call that
// can only come back as a permission denial naming no field.

import { test } from "node:test";
import assert from "node:assert/strict";

import { readIntentMessage } from "../src/view/intent.js";
import { capabilityOf } from "../src/view/capability.js";
import { byText } from "../src/byText.js";
import { VIEW_MESSAGE } from "../src/view/protocol.js";
import type { ProjectedViewWrite } from "../src/appViews.js";

/** A blog's `posts`: the author is a writer, nobody else writes here, and the two fields the rules
 *  derived an identity from on create are frozen. No `selfUpdate` at all — which is the point. */
const posts: ProjectedViewWrite = {
  cid: "posts",
  statusField: "status",
  transitions: { published: ["archived"] },
  writers: ["author@blog.jp"],
  frozen: ["publishedAt", "slug"],
  maxBytes: { title: 200, body: 60000 },
};

const held = (cid: string, itemId: string): Record<string, unknown> | null =>
  cid === "posts" && itemId === "hello" ? { status: "published", title: "Hello" } : null;

const author = { address: "author@blog.jp", tier: "member" as const };
const stranger = { address: "reader@x.jp", tier: "member" as const };

const correction = (over: Record<string, unknown> = {}) => ({
  type: VIEW_MESSAGE.intent,
  requestId: "r1",
  kind: "correct",
  cid: "posts",
  itemId: "hello",
  values: { title: "Hello again" },
  ...over,
});

test("a writer corrects any field, with no status and no field list to satisfy", () => {
  const read = readIntentMessage(correction({ values: { title: "Hello again", body: "…", tags: "a,b" } }), [posts], held, author);
  assert.equal(read.ok, true);
  assert.deepEqual(read.intent.values, { title: "Hello again", body: "…", tags: "a,b" });
  // No field moves: a correction names its own, so there is nothing for the parent to add.
  assert.equal(read.intent.field, undefined);
});

test("a reader holding no role is refused, and the refusal is about the ROLE", () => {
  const read = readIntentMessage(correction(), [posts], held, stranger);
  assert.equal(read.ok, false);
  // Not `not-permitted`: this projection grants corrections only by role and this reader has none,
  // so there is no control here that is merely not theirs.
  assert.equal(read.reason, "not-writable");
});

test("a frozen field is refused for the OWNER too, and named as frozen rather than forbidden", () => {
  const read = readIntentMessage(correction({ values: { publishedAt: "2020-01-01T00:00:00Z" } }), [posts], held, author);
  assert.equal(read.ok, false);
  assert.equal(read.reason, "frozen-field");
});

test("the frozen check runs BEFORE the role, so no role can approve what the rules will refuse", () => {
  // The same message, judged for a reader with no role: still `frozen-field`, never `not-writable`.
  // If the order were the other way round the two readers would get different names for a write
  // neither of them may make.
  const read = readIntentMessage(correction({ values: { slug: "renamed" } }), [posts], held, stranger);
  assert.equal(read.ok, false);
  assert.equal(read.reason, "frozen-field");
});

test("a value over maxBytes is refused, measured in BYTES", () => {
  // 100 characters of Japanese is about 240 bytes -- over a 200-byte cap, and under it if anyone
  // counts characters. That is the whole difference this test is here to pin.
  const read = readIntentMessage(correction({ values: { title: "あ".repeat(100) } }), [posts], held, author);
  assert.equal(read.ok, false);
  assert.equal(read.reason, "too-long");
  // 60 characters is 180 bytes: under the same cap, and accepted.
  assert.equal(readIntentMessage(correction({ values: { title: "あ".repeat(60) } }), [posts], held, author).ok, true);
});

test("a correction naming no fields is ANSWERED, not ignored", () => {
  // The page is holding a promise. A button that resolves nothing is indistinguishable from a
  // broken one, which is why this is a refusal and not a message the parent declines to read.
  const read = readIntentMessage(correction({ values: {} }), [posts], held, author);
  assert.equal(read.ok, false);
  assert.equal(read.reason, "nothing-to-correct");
  assert.equal(read.requestId, "r1");
});

test("values that are not all strings are not an intent at all", () => {
  // Refused WHOLESALE rather than filtered: a page sending a number has been half understood by a
  // filter, and the write that followed would be a different write from the one it asked for.
  const read = readIntentMessage(correction({ values: { title: "ok", views: 12 } }), [posts], held, author);
  assert.equal(read.ok, false);
  assert.equal(read.reason, "not-an-intent");
});

test("a correction carrying a destination is not a correction", () => {
  const read = readIntentMessage(correction({ to: "archived" }), [posts], held, author);
  assert.equal(read.ok, false);
  assert.equal(read.reason, "not-an-intent");
});

// --- the submitter's half

/** A suggestion box: no roles at all, and the submitter may fix their own wording while it is
 *  still `pending`. This is what `correctFrom` describes and `correctAny` cannot. */
const notes: ProjectedViewWrite = {
  cid: "notes",
  statusField: "status",
  selfUpdate: { pending: ["text"] },
  frozen: ["submittedAt"],
};

const pending = (cid: string, itemId: string): Record<string, unknown> | null => (cid === "notes" && itemId === "n1" ? { status: "pending" } : null);
const answered = (cid: string, itemId: string): Record<string, unknown> | null => (cid === "notes" && itemId === "n1" ? { status: "answered" } : null);

const note = (over: Record<string, unknown> = {}) => ({
  type: VIEW_MESSAGE.intent,
  requestId: "r2",
  kind: "correct",
  cid: "notes",
  itemId: "n1",
  values: { text: "fixed" },
  ...over,
});

const guest = { address: "guest@x.jp", tier: "roster" as const };

test("a submitter corrects the fields their status names", () => {
  assert.equal(readIntentMessage(note(), [notes], pending, guest).ok, true);
});

test("a field outside the list is the READER's refusal; a status outside the map is the RECORD's", () => {
  const outside = readIntentMessage(note({ values: { author: "somebody" } }), [notes], pending, guest);
  assert.equal(outside.ok, false);
  assert.equal(outside.reason, "not-permitted");
  const moved = readIntentMessage(note(), [notes], answered, guest);
  assert.equal(moved.ok, false);
  assert.equal(moved.reason, "illegal-transition");
});

test("a page holding no such record claims nothing about the status", () => {
  // The dataset can be a second stale, so the button was drawn from what the page last saw. The
  // race belongs to the rules, exactly as it does for a transition.
  const nothing = () => null;
  assert.equal(readIntentMessage(note(), [notes], nothing, guest).ok, true);
});

test("a status whose name is a prototype key is not a permission", () => {
  // `correctFrom` is a map keyed by statuses an AUTHOR wrote, and `constructor` is a legal one. A
  // plain index into a map that does not name it hands back a FUNCTION, which `includes` would
  // then be asked for. Written with a status the declaration does NOT carry, so the test fails
  // against a plain lookup rather than passing either way.
  const inherited = (cid: string, itemId: string): Record<string, unknown> | null => (cid === "notes" && itemId === "n1" ? { status: "constructor" } : null);
  const read = readIntentMessage(note(), [notes], inherited, guest);
  assert.equal(read.ok, false);
  assert.equal(read.reason, "illegal-transition");
});

test("a correction never moves the status, whoever asks", () => {
  // Not because the status is frozen — it moves — but because it moves through `transition`, which
  // is judged against the declared table and carries the notice the declaration names for that
  // move. A correction able to set it would be a way past both, and the writer branch asks nothing
  // about tables at all.
  const read = readIntentMessage(correction({ values: { status: "archived" } }), [posts], held, author);
  assert.equal(read.ok, false);
  assert.equal(read.reason, "reserved-field");
});

test("a correction never moves the ASSIGNEE either, and that is the sharper half", () => {
  // `assign` refuses an address nobody on the roster holds a role at, because writing one produces
  // a row NOBODY may touch afterwards. A writer reaching the field through a correction skips that
  // check entirely — the rules do not make it, and `correctAny` asks nothing about who is named.
  const staffed: ProjectedViewWrite = { ...posts, assigneeField: "editor", rowWriters: ["sub@blog.jp"] };
  const read = readIntentMessage(correction({ values: { editor: "stranger@x.jp" } }), [staffed], held, author);
  assert.equal(read.ok, false);
  assert.equal(read.reason, "reserved-field");
  // Refused BEFORE the role, like the frozen fields: a reader with no role gets the same name for
  // it, because no role makes it correctable.
  const byStranger = readIntentMessage(correction({ values: { editor: "x@x.jp" } }), [staffed], held, stranger);
  assert.equal(byStranger.ok, false);
  assert.equal(byStranger.reason, "reserved-field");
});

test("the capability tells the page what NOT to draw, not only what it may write", () => {
  // `sealed` rides here for the same reason one field up: the sandboxed page never sees the
  // projection, only `viewer.can`. A page told it may rewrite anything and not told about these
  // draws an input for `publishedAt`, and the reader presses Save and is refused. A named refusal
  // is better than a permission error and it is still a control that should not have been drawn.
  const staffed: ProjectedViewWrite = { ...posts, assigneeField: "editor" };
  const can = capabilityOf(staffed, "author@blog.jp", "member");
  assert.equal(can.correctAny, true);
  // The rules' frozen set, AND the two fields the other asks own.
  assert.deepEqual([...can.frozen].sort(byText), ["editor", "publishedAt", "slug", "status"]);
  assert.deepEqual(can.maxBytes, { title: 200, body: 60000 });
});

test("a collection with no caps carries no empty map to compare against", () => {
  // `{}` would read as "every field is capped at nothing" to a page comparing lengths.
  const uncapped = capabilityOf(notes, "guest@x.jp", "roster");
  assert.equal("maxBytes" in uncapped, false);
  // And the frozen list is still answered — it is not the same key and not the same question.
  assert.deepEqual([...uncapped.frozen].sort(byText), ["status", "submittedAt"]);
});
