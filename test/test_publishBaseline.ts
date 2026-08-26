// THE COMPATIBILITY BASELINE: three declarations that are published today, and the assertion that
// this package still accepts them.
//
// Every other test in this directory names ONE rule and pins it. That is what a gate needs, and it
// is also how a gate drifts: each new refusal is judged against the declaration written to provoke
// it, never against the apps somebody already runs. A tightened check that refuses a live app looks
// exactly like a check that works — the test it was added with is green, and the app that stops
// publishing is in another repository.
//
// So these three are shapes, not examples. Between them they carry every mode a published app uses:
//
//   - a live poll:     `auth: "anonymous"` + `idFrom: "auth.uid+field"` — one vote per person with
//                      no sign-in screen, which is the whole reason `anonymous` exists.
//   - a class booking: a status machine with `initialStatus`, a `stampField`, a composite id, and a
//                      window read off ANOTHER collection's record.
//   - a court booking: `idFrom: "field"` (the id IS the contested slot), a `mirror`, `selfUpdate`
//                      and `selfDelete` — the app that made "withdraw what you just booked" a shape
//                      rather than an idea.
//
// They are kept HERE rather than run against `../apps`, because a sibling checkout is not a thing
// CI has. `scripts/check-apps.mjs` is the other half: it runs the same two gates over the real ten
// on the machine of whoever is about to release. This file is what stops the drift; that script is
// what proves it stopped it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAuthoredApp } from "../src/publishManifest.js";
import { publishProblems, schemaRefProblems } from "../src/publishChecks.js";
import { projectApp, type PublishedApp, type PublishStamp } from "../src/publishProject.js";

const OWNER = "desk@example.jp";
const STAMP: PublishStamp = { uid: "uid_owner", email: OWNER, publishedAt: 1_700_000_000_000 };
const MEMBERS = { [OWNER]: { "*": "owner" } };

const known = (...cids: string[]) => cids.map((cid) => ({ cid, primaryKey: "id" }));

/** A schema as the HOST reads it off disk, narrowed to what these declarations refer to. Cast at
 *  the call sites, as `test_publishChecks.ts` does: the full `CollectionSchema` carries labels and
 *  widgets that say nothing about the question here. */
const schema = (cid: string, fields: Record<string, unknown>) => ({ cid, schema: { title: cid, icon: "event", primaryKey: "id", fields } });

/** The published `public.submit[cid]` block, or a failure naming what was missing. */
const publishedSubmit = (app: Record<string, unknown>, cid: string): Record<string, unknown> => {
  const publicBlock = app.public as { submit?: Record<string, Record<string, unknown>> } | undefined;
  const submit = publicBlock?.submit?.[cid];
  assert.ok(submit, `the app document has no public.submit.${cid}`);
  return submit;
};

/** The published `collections[cid]` block, same rule. */
const publishedCollection = (app: Record<string, unknown>, cid: string): Record<string, unknown> => {
  const collections = app.collections as Record<string, Record<string, unknown>> | undefined;
  const collection = collections?.[cid];
  assert.ok(collection, `the app document has no collections.${cid}`);
  return collection;
};

/** A live poll: the room votes from their phones, with no sign-in between the question and the
 *  answer. `anonymous` is what makes that possible, and the composite id is what makes one vote per
 *  person ENFORCED rather than asked for nicely. */
const LIVE = {
  aid: "app_live",
  members: MEMBERS,
  collections: {
    questions: { statusField: "state", transitions: { initial: ["draft"], draft: ["open"], open: ["closed"], closed: ["open"] } },
    votes: { submitOnly: true },
  },
  public: {
    enabled: true,
    read: ["questions"],
    submit: {
      votes: {
        auth: "anonymous",
        idFrom: "auth.uid+field",
        idField: "questionId",
        stampField: "votedAt",
        createFields: ["questionId", "choice", "votedAt"],
        validate: { keyFields: [{ field: "choice", values: ["a", "b", "c", "d", "e"] }] },
      },
    },
  },
  views: [{ id: "public", audience: "public", path: "views/poll.html", collections: ["questions"] }],
};

/** A class booking: a status the desk moves, a server stamp, an id built from the visitor and the
 *  class they picked, and a window whose bounds live on the CLASS. */
const GYM = {
  aid: "app_gym",
  members: MEMBERS,
  collections: {
    bookings: {
      submitOnly: true,
      statusField: "status",
      peerVisibility: "public",
      transitions: { initial: ["requested"], requested: ["cancelled"] },
    },
  },
  participantRead: ["classes"],
  public: {
    enabled: true,
    read: ["classes"],
    submit: {
      bookings: {
        auth: "verifiedEmail",
        emailField: "memberEmail",
        idFrom: "auth.uid+field",
        idField: "classId",
        stampField: "createdAt",
        initialStatus: "requested",
        createFields: ["classId", "memberEmail", "memberName", "createdAt", "status"],
        selfTransitions: { requested: ["cancelled"] },
        window: { fromField: { ref: "classId", collection: "classes", field: "opensAt" } },
      },
    },
  },
  views: [
    { id: "public", audience: "public", path: "views/signup.html", collections: ["classes"] },
    { id: "mine", audience: "participant", path: "views/mine.html", collections: ["classes", "bookings"] },
    { id: "desk", audience: "member", path: "views/desk.html", collections: ["classes", "bookings"] },
  ],
};

/** A court booking: the document id IS the slot, so the second person to want it is refused by the
 *  rules rather than by a check nobody wrote. `selfDelete: ["booked"]` is "give the court back",
 *  and "booked" is where every record starts. */
const TENNIS = {
  aid: "app_tennis",
  members: MEMBERS,
  collections: {
    bookings: { submitOnly: true, statusField: "status", transitions: { initial: ["booked"] } },
    slots: { mirrorOf: "bookings" },
  },
  public: {
    enabled: true,
    read: ["courts", "slots"],
    submit: {
      bookings: {
        auth: "verifiedEmail",
        emailField: "requesterEmail",
        createFields: ["requesterName", "requesterEmail", "slot", "purpose", "players", "status"],
        initialStatus: "booked",
        idFrom: "field",
        idField: "slot",
        idIn: { collection: "slots", where: { field: "state", equals: "open" } },
        mirror: "slots",
        window: {
          fromField: { ref: "slot", collection: "slots", field: "opensAt" },
          untilField: { ref: "slot", collection: "slots", field: "closesAt" },
        },
        selfUpdate: { booked: ["purpose", "players"] },
        selfDelete: ["booked"],
      },
    },
  },
  views: [{ id: "public", audience: "public", path: "views/book.html", collections: ["courts", "slots"] }],
};

const SHAPES = [
  { name: "a live poll (anonymous + composite id)", declaration: LIVE, cids: known("questions", "votes"), schemas: [] },
  {
    name: "a class booking (status, stamp, composite id, window off another record)",
    declaration: GYM,
    cids: known("bookings", "classes"),
    schemas: [schema("classes", { opensAt: { type: "number" } })],
  },
  {
    name: "a court booking (field id, mirror, selfUpdate, selfDelete)",
    declaration: TENNIS,
    cids: known("bookings", "slots", "courts"),
    schemas: [schema("slots", { state: { type: "string" }, opensAt: { type: "number" }, closesAt: { type: "number" } })],
  },
];

for (const shape of SHAPES) {
  test(`${shape.name} parses, and publish has nothing to say about it`, () => {
    // Through the FILE parser, not the zod object alone: an app.json is what an author has, and the
    // two disagree about `aid` (which is read through core).
    const parsed = parseAuthoredApp(JSON.stringify(shape.declaration));
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.problems.join("\n"));
    assert.deepEqual(publishProblems(parsed.app, shape.cids, OWNER), []);
    assert.deepEqual(schemaRefProblems(parsed.app, shape.schemas as never), []);
  });
}

test("the three shapes still compile to the same documents", () => {
  // The other half of a compatibility baseline. Nothing above would notice a projection that
  // started writing a different field: the gate would still be silent, and the app would be
  // published wrongly rather than refused. Pinned as the field a rule reads, per shape, rather than
  // as a whole snapshot — a snapshot of everything is a test that fails on every addition and is
  // therefore updated without being read.
  const projected = SHAPES.map((shape) => {
    const parsed = parseAuthoredApp(JSON.stringify(shape.declaration));
    assert.equal(parsed.ok, true);
    return projectApp(parsed.app, [], STAMP, null);
  });
  const [live, gym, tennis] = projected as [PublishedApp, PublishedApp, PublishedApp];

  assert.equal(live.app.owner, STAMP.uid, "the publisher's uid, which the rules compare on create");
  assert.deepEqual(live.app.memberEmails, [OWNER], "derived, never authored");
  assert.equal(publishedSubmit(live.app, "votes").auth, "anonymous");
  assert.equal(publishedSubmit(live.app, "votes").idFrom, "auth.uid+field");
  // The public config document is the one a STRANGER's page reads, and it carries the submit
  // declaration too — the page draws the form from it.
  assert.equal(live.config.submit.votes?.idField, "questionId");

  assert.equal(publishedSubmit(gym.app, "bookings").initialStatus, "requested");
  assert.equal(publishedSubmit(gym.app, "bookings").stampField, "createdAt");
  assert.deepEqual(publishedCollection(gym.app, "bookings").transitions, { initial: ["requested"], requested: ["cancelled"] });

  assert.equal(publishedSubmit(tennis.app, "bookings").mirror, "slots");
  assert.deepEqual(publishedSubmit(tennis.app, "bookings").selfDelete, ["booked"]);
  assert.equal(publishedCollection(tennis.app, "slots").mirrorOf, "bookings");
});
