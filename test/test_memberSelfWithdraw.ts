// A member withdrawing the row THEY submitted, along the whole path it travels:
// declaration → projected document → strict readback → capability → intent.
//
// Its own file because the bug it guards was invisible to every stage tested
// alone. The projection emitted `selfDelete` and a unit test on `writeFor`
// passed; the document reached the reader without a `statusField`, because that
// key is attached by the TRANSITION half and this collection declares no
// transitions; and `withdrawable` then answered `[]` for a permission the rules
// grant. Three correct-looking stages, one control that never appears.
//
// So every test here starts at `projectAppViews` and ends at a capability or an
// intent, with `projectedWriteOf` in the middle. Anything that reads the write
// entry straight out of the projection is testing the half that already worked.

import { test } from "node:test";
import assert from "node:assert/strict";

import { projectAppViews } from "../src/publishProject.js";
import { AuthoredAppZ } from "../src/publishManifest.js";
import { projectedWriteOf } from "../src/view/writeRead.js";
import { capabilityOf } from "../src/view/capability.js";
import { readIntentMessage } from "../src/view/intent.js";
import { VIEW_MESSAGE } from "../src/view/protocol.js";
import type { ProjectedViewWrite } from "../src/appViews.js";

const OWNER = "owner@chat.jp";
const EDITOR = "editor@chat.jp";
const OBSERVER = "observer@chat.jp";
const STAMP = { publishedAt: 1_700_000_000_000, email: OWNER, uid: "u-owner" };

/** A members-only group chat: every record is bound to its submitter, which is
 *  exactly what leaves the member tier with no role-based write to project.
 *  No transitions — a message is posted and deleted, never moved. */
const chat = (overrides: Record<string, unknown> = {}) =>
  AuthoredAppZ.parse({
    aid: "app_chat",
    members: {
      [OWNER]: { "*": "owner" },
      [EDITOR]: { "*": "editor" },
      // Holds a role, so the tier admits them, and may write nothing by role.
      [OBSERVER]: { "*": "viewer" },
    },
    collections: { messages: { submitOnly: true, statusField: "status", ...(overrides.collection as object) } },
    public: {
      submit: {
        messages: {
          auth: "verifiedEmail",
          emailField: "author",
          createFields: ["author", "body", "status"],
          initialStatus: "posted",
          selfDelete: ["posted"],
        },
      },
    },
    views: [{ id: "room", audience: "member", path: "views/room.html", collections: ["messages"] }],
  });

/** The member document as a READER gets it: projected, then parsed by the same
 *  strict readback both hosts use. This round trip is the point of the file. */
const readBack = (authored: ReturnType<typeof chat>): ProjectedViewWrite => {
  const written = projectAppViews(authored, STAMP)
    .filter((entry) => entry.tier === "member")
    .flatMap((entry) => entry.config.write);
  assert.equal(written.length, 1, "the collection has to be in the member document at all");
  // Through JSON, because that is what Firestore hands back — and it is what
  // turns an `undefined` the projection never set into a key that is absent.
  const parsed = projectedWriteOf(JSON.parse(JSON.stringify(written[0])));
  assert.notEqual(parsed, null, "the entry has to survive the strict readback");
  return parsed as ProjectedViewWrite;
};

const withdrawal = (address: string) => ({
  type: VIEW_MESSAGE.intent,
  requestId: "r1",
  kind: "withdraw",
  cid: "messages",
  itemId: "m1",
  address,
});

const mine = (cid: string, itemId: string): Record<string, unknown> | null =>
  cid === "messages" && itemId === "m1" ? { status: "posted", author: OBSERVER } : null;

test("a self-delete collection with no transitions keeps its status field through the readback", () => {
  // `statusField` used to ride ONLY with the transition table, so a collection
  // that declares no transitions lost it — and the rules read the CURRENT
  // status off the record before consulting `selfDelete`, so a projection
  // without it describes a withdrawal nobody can perform.
  const write = readBack(chat());
  assert.equal(write.statusField, "status");
  assert.deepEqual(write.selfDelete, ["posted"]);
  // And still no transition table, which is a different promise: a status field
  // with no table must not make anything movable.
  assert.equal(write.transitions, undefined);
  assert.equal(capabilityOf(write, OWNER, "member").transitionAny, false);
});

test("the member who submitted the row is told they may withdraw it", () => {
  const write = readBack(chat());
  const can = capabilityOf(write, OWNER, "member");
  assert.deepEqual(can.withdrawFrom, ["posted"], "the page draws its control from this");
  assert.equal(can.withdrawAny, false, "no role deletes here — only the submitter");
});

test("the withdrawal is judged, not refused as a collection nobody declared", () => {
  // The refusal that sent this whole investigation the wrong way: an empty
  // projection made `writeFor` drop the collection, and the page's ask came
  // back `unknown-collection` about a collection it was reading on the same
  // screen.
  const read = readIntentMessage(withdrawal(OBSERVER), [readBack(chat())], mine, { address: OBSERVER, tier: "member" });
  assert.equal(read.ok, true, read.ok ? "" : `refused: ${read.reason}`);
});

test("a status the declaration does not name is still refused", () => {
  const write = readBack(chat());
  const elsewhere = (cid: string, itemId: string) => (mine(cid, itemId) === null ? null : { status: "archived", author: OBSERVER });
  const read = readIntentMessage(withdrawal(OBSERVER), [write], elsewhere, { address: OBSERVER, tier: "member" });
  assert.equal(read.ok, false);
  assert.equal(read.reason, "illegal-transition");
});

// --- the two halves together, which is where the reader stops being a tier ---

/** The same chat, plus a staff delete. Both permissions are now declared on one
 *  collection, and WHICH ONE ANSWERS depends on the person asking. */
const both = () => chat({ collection: { writerDelete: true } });

test("a writer deletes by role, and is handed no status list beside it", () => {
  const can = capabilityOf(readBack(both()), OWNER, "member");
  assert.equal(can.withdrawAny, true);
  assert.deepEqual(can.withdrawFrom, [], "a role deletes in any status; a list here would refuse for the wrong reason");
});

test("a NON-writer who submitted the row keeps their own half, though a role deletes here too", () => {
  // `writerDelete` is a property of the COLLECTION and being a writer is a
  // property of the READER. Choosing between the two per collection took the
  // submitter's own delete away from every viewer and assignee on a board that
  // also let staff delete — while `firestore.rules` reads
  // `isWriter(r) || selfDelete(...)`, which grants it.
  const write = readBack(both());
  const can = capabilityOf(write, OBSERVER, "member");
  assert.equal(can.withdrawAny, false, "they hold no writing role");
  assert.deepEqual(can.withdrawFrom, ["posted"], "but the row is theirs");

  const read = readIntentMessage(withdrawal(OBSERVER), [write], mine, { address: OBSERVER, tier: "member" });
  assert.equal(read.ok, true, read.ok ? "" : `refused: ${read.reason}`);
});

test("a non-writer with no row of their own is refused, and named as a permission", () => {
  // Whether the row is theirs is `ownRow`'s to answer, so the parent judges the
  // status and lets the rules do the rest. What it must not do is claim there
  // is no such collection.
  const write = readBack(both());
  const theirs = (cid: string, itemId: string) => (mine(cid, itemId) === null ? null : { status: "archived", author: OBSERVER });
  const read = readIntentMessage(withdrawal(OBSERVER), [write], theirs, { address: OBSERVER, tier: "member" });
  assert.equal(read.ok, false);
  assert.notEqual(read.reason, "unknown-collection");
});

test("the participant tier is unchanged by any of this", () => {
  const roster = projectAppViews(chat(), STAMP)
    .filter((entry) => entry.tier === "roster")
    .flatMap((entry) => entry.config.write);
  const parsed = roster.length === 0 ? null : projectedWriteOf(JSON.parse(JSON.stringify(roster[0])));
  if (parsed === null) return;
  assert.deepEqual(capabilityOf(parsed, "guest@example.jp", "roster").withdrawFrom, ["posted"]);
});
