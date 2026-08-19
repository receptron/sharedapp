// What a page is told about the reader's own submissions — and, as much, what it is not.
//
// The page cannot read this for itself and must not be able to: the collection people submit to is
// not in `public.read`, because one visitor reading every other visitor's answer is the thing that
// must never happen. So the parent reads it (the rules grant a submitter their own row) and decides
// how much of it crosses into the sandbox. That decision is `ownRows.ts`, and it is in the package
// because BOTH parents make it — the live page and the author's preview of it — and an author
// previewing a page handed one more field than production hands it is previewing a page that does
// not exist.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ownRow, ownRowsFor, type OwnRowFields } from "../src/view/ownRows.js";

const spec = (cid: string, names: string[]): OwnRowFields => ({ cid, fields: names.map((name) => ({ name })) });

test("it hands back the id and the fields a page could have sent", () => {
  const mine = ownRowsFor([spec("votes", ["questionId", "choice"])], { votes: [{ id: "uid-1_q1", questionId: "q1", choice: "b" }] }, ["votes"]);
  assert.deepEqual(mine, { votes: [{ id: "uid-1_q1", questionId: "q1", choice: "b" }] });
});

test("it drops what the app wrote and the page never sees", () => {
  // `ownRow` in the rules grants the submitter their WHOLE document. The whole document is not the
  // page's business: the status the app moved it to, the staff member it was assigned to, a
  // reviewer's note.
  const mine = ownRowsFor(
    [spec("bookings", ["startAt"])],
    { bookings: [{ id: "b1", startAt: "2026-09-01T10:00", status: "rejected", assignee: "staff@salon.jp", note: "…" }] },
    ["bookings"],
  );
  assert.deepEqual(mine, { bookings: [{ id: "b1", startAt: "2026-09-01T10:00" }] });
});

test("the id survives the projection, because for one id strategy it IS the uid", () => {
  // `idFrom: "auth.uid"` makes the document id the reader's own uid, and the uid FIELD is one of the
  // host-filled ones dropped above — so this is the only way a page can learn its own. A page
  // comparing `row.uid` to something it never received compared `undefined` with `undefined` and
  // drew nothing; the fix is to read the id, and the id has to be here for that to be possible.
  assert.deepEqual(ownRow([{ name: "name" }], { id: "uid-1", name: "Satoshi", uid: "uid-1" }), { id: "uid-1", name: "Satoshi" });
});

test("'you have not answered' is an empty array, per collection", () => {
  // Not by leaving the key out: a page reading `mine.votes` would get `undefined` and have to guess
  // whether that means "no" or "this host does not do that".
  assert.deepEqual(ownRowsFor([spec("votes", ["choice"]), spec("signups", ["name"])], { votes: [{ id: "v1", choice: "a" }] }, ["votes", "signups"]), {
    votes: [{ id: "v1", choice: "a" }],
    signups: [],
  });
});

test("a collection nothing could look up is left out — which is not 'you have not answered'", () => {
  // A `verifiedEmail` collection read before the address is known, an id strategy with no look-up, a
  // refused read. An empty array here would tell the page the visitor has not answered and take a
  // one-time action away from somebody entitled to it.
  assert.deepEqual(ownRowsFor([spec("votes", ["choice"]), spec("responses", ["comment"])], { votes: [{ id: "v1", choice: "a" }] }, ["votes"]), {
    votes: [{ id: "v1", choice: "a" }],
  });
});

test("every row survives where a collection allows more than one", () => {
  // A collection with no `idFrom` gets a random id per submission, so the same person really does
  // have several answers. Picking one would be choosing which of their own answers to hide.
  const mine = ownRowsFor(
    [spec("responses", ["comment"])],
    {
      responses: [
        { id: "r1", comment: "一回目" },
        { id: "r2", comment: "二回目" },
      ],
    },
    ["responses"],
  );
  assert.equal(mine.responses?.length, 2);
});

test("a field the record does not carry is dropped rather than sent empty", () => {
  assert.deepEqual(ownRowsFor([spec("responses", ["comment", "name"])], { responses: [{ id: "r1", comment: "…" }] }, ["responses"]), {
    responses: [{ id: "r1", comment: "…" }],
  });
});
