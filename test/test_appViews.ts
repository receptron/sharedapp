// The app's pages, per audience: what normalizes, what is refused, and what
// each audience is handed.
//
// Every refusal here is paired with the neighbouring declaration that must
// still pass — a file of refusals alone is satisfied by an implementation that
// refuses everything, which from inside its own suite looks like safety.

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeViews, participantScope, viewDocId, PUBLIC_VIEW_ID } from "../src/appViews.js";
import { projectAppViews } from "../src/publishProject.js";
import { AuthoredAppZ } from "../src/publishManifest.js";

const OWNER = "owner@salon.jp";
const STAMP = { publishedAt: 1_700_000_000_000, email: OWNER, uid: "u-owner" };

const app = (overrides: Record<string, unknown>) => AuthoredAppZ.parse({ aid: "app_views", members: { [OWNER]: { "*": "owner" } }, ...overrides });

const DESK = { id: "desk", audience: "member", path: "views/desk.html", collections: ["bookings"] };

const problemsOf = (overrides: Record<string, unknown>): string[] => {
  const result = normalizeViews(app(overrides));
  return result.ok ? [] : result.problems;
};

function refuses(problems: string[], fragment: string): void {
  const bullets = problems.map((problem) => `  - ${problem}`).join("\n");
  assert.ok(
    problems.some((problem) => problem.includes(fragment)),
    `expected a problem mentioning ${JSON.stringify(fragment)}, got:\n${bullets || "  (none)"}`,
  );
}

// --- normalization ----------------------------------------------------------

test("the older public.view spelling normalizes into the list, under the reserved id", () => {
  const result = normalizeViews(app({ public: { view: { path: "views/booking.html", collections: ["slots"] } } }));
  assert.ok(result.ok);
  assert.deepEqual(result.views, [{ id: PUBLIC_VIEW_ID, audience: "public", path: "views/booking.html", collections: ["slots"], where: "public.view" }]);
});

test("an app declaring neither spelling normalizes to nothing, not to a problem", () => {
  const result = normalizeViews(app({}));
  assert.ok(result.ok);
  assert.deepEqual(result.views, []);
});

test("refuses both spellings at once rather than choosing one silently", () => {
  refuses(problemsOf({ views: [DESK], public: { view: { path: "views/booking.html", collections: ["slots"] } } }), "declares both");
});

test("refuses an id that is not a legal document id — it IS the document id", () => {
  // The one that matters: staging would write one path and withdrawal would
  // tidy another, and neither says anything.
  refuses(problemsOf({ views: [{ ...DESK, id: "desk/../evil" }] }), "It becomes the document id");
  refuses(problemsOf({ views: [{ ...DESK, id: "live:desk" }] }), "It becomes the document id");
  refuses(problemsOf({ views: [{ ...DESK, id: "Desk" }] }), "It becomes the document id");
  refuses(problemsOf({ views: [{ ...DESK, id: "-desk" }] }), "It becomes the document id");
  assert.deepEqual(problemsOf({ views: [{ ...DESK, id: "front-desk-2" }] }), []);
});

test("refuses the id the projection itself is published at", () => {
  refuses(problemsOf({ views: [{ ...DESK, id: "config" }] }), "which is reserved");
});

test("refuses the public id on a page that is not the public one", () => {
  refuses(problemsOf({ views: [{ ...DESK, id: "public" }] }), "belongs to the public page");
  assert.deepEqual(problemsOf({ views: [{ ...DESK, id: "public", audience: "public" }] }), []);
});

test("refuses two views at one id — they would be one page", () => {
  refuses(problemsOf({ views: [DESK, { ...DESK, path: "views/stock.html" }] }), "already uses");
});

test("accepts two views for one audience, which is the point of the id", () => {
  assert.deepEqual(problemsOf({ views: [DESK, { ...DESK, id: "stock", path: "views/stock.html" }] }), []);
});

test("refuses an audience outside the closed set, at the parser", () => {
  assert.throws(() => app({ views: [{ ...DESK, audience: "editor" }] }));
});

// --- what each audience is handed -------------------------------------------

test("a participant reads a participantRead collection whole, and their own row otherwise", () => {
  const declared = app({
    participantRead: ["notices"],
    public: {
      submit: {
        bookings: { auth: "verifiedEmail", createFields: ["email"], emailField: "email" },
        seats: { auth: "anonymous", createFields: ["x"], idFrom: "auth.uid" },
      },
    },
  });
  const promoted = ["notices"];
  assert.deepEqual(participantScope(declared, "notices", promoted), { cid: "notices", scope: "all" });
  assert.deepEqual(participantScope(declared, "bookings", promoted), { cid: "bookings", scope: "own", emailField: "email" });
  assert.deepEqual(participantScope(declared, "seats", promoted), { cid: "seats", scope: "own", ownDocId: "auth.uid" });
  // Neither: the rules would refuse the read, so there is nothing to hand a page.
  assert.equal(participantScope(declared, "ledger", promoted), null);
});

test("the participant scope follows what will be PROMOTED, not what the manifest says", () => {
  // `projectPublish` overwrites `participantRead` with the staged schemas' own,
  // so a cid added to app.json since the last deploy is not in the rules.
  // Reading the manifest here would publish `scope: "all"` for a collection the
  // rules then deny — the page fails rather than showing less.
  const declared = app({ participantRead: ["notices"] });
  assert.equal(participantScope(declared, "notices", []), null);
  const tiers = projectAppViews(
    app({ participantRead: ["notices"], views: [{ id: "mine", audience: "participant", path: "views/mine.html", collections: ["notices"] }] }),
    STAMP,
    { participantRead: [] },
  );
  assert.deepEqual(tiers.find((tier) => tier.audience === "participant")?.config.views, [{ id: "mine", collections: [] }]);
});

test("more than one public page is refused: there is only one document to publish it at", () => {
  // Nothing would error. `config/view` is a single document, so the second
  // entry is published nowhere and which one is live depends on the order they
  // were written in.
  refuses(
    problemsOf({
      views: [
        { ...DESK, id: "one", audience: "public" },
        { ...DESK, id: "two", audience: "public" },
      ],
    }),
    "a second audience",
  );
  // The member tiers have no such limit — the id IS the address there.
  assert.deepEqual(problemsOf({ views: [DESK, { ...DESK, id: "stock" }] }), []);
});

test("the projection separates the tiers, and a staff page is not in the participants' one", () => {
  const tiers = projectAppViews(
    app({
      participantRead: ["notices"],
      views: [
        DESK,
        { id: "mine", audience: "participant", path: "views/mine.html", collections: ["notices"] },
        { id: "public", audience: "public", path: "views/booking.html", collections: ["slots"] },
      ],
    }),
    STAMP,
  );
  const member = tiers.find((tier) => tier.audience === "member");
  const participant = tiers.find((tier) => tier.audience === "participant");
  assert.equal(member?.tier, "member");
  assert.equal(participant?.tier, "roster");
  assert.deepEqual(
    member?.config.views,
    [{ id: "desk", collections: [{ cid: "bookings", scope: "all" }] }],
    "the front desk reads the whole collection, and only the front desk's tier knows the page exists",
  );
  assert.deepEqual(participant?.config.views, [{ id: "mine", collections: [{ cid: "notices", scope: "all" }] }]);
  // The public page is neither tier's business: it keeps config/public.
  assert.equal(
    tiers.flatMap((tier) => tier.views).some((view) => view.audience === "public"),
    false,
  );
});

test("both tiers come back even when empty, so a withdrawal has something to act on", () => {
  const tiers = projectAppViews(app({}), STAMP);
  assert.deepEqual(
    tiers.map((tier) => [tier.tier, tier.views.length]),
    [
      ["member", 0],
      ["roster", 0],
    ],
  );
});

test("the document id carries the stage, and the id the author wrote", () => {
  assert.equal(viewDocId("live", "desk"), "live:desk");
  assert.equal(viewDocId("staged", "desk"), "staged:desk");
});

// --- what each audience may CHANGE -----------------------------------------
//
// The rules already allow every write these entries describe. What is pinned
// here is that the two audiences are handed DIFFERENT tables — a participant
// offered the staff transitions draws an approve button that the rules refuse
// when pressed, which is declaration and enforcement disagreeing.

const STYLIST = "stylist@salon.jp";
const RECEPTION = "reception@salon.jp";
const OBSERVER = "observer@salon.jp";
const CUSTOMER = "customer@example.jp";

/** One roster carrying every role the rules distinguish, because the staff
 *  tier's single document is read by all of them. */
const SALON_MEMBERS = {
  [OWNER]: { "*": "owner" },
  [RECEPTION]: { bookings: "editor" },
  [STYLIST]: { bookings: "assignee" },
  // Holds a role, so `staffOf` admits them — and may write nothing.
  [OBSERVER]: { bookings: "viewer" },
  [CUSTOMER]: { "*": "participant" },
};

const SALON_COLLECTIONS = {
  bookings: {
    statusField: "status",
    transitions: { initial: ["pending"], pending: ["approved", "rejected"], approved: ["done"] },
    assigneeField: "stylistEmail",
    mail: { toField: "email", on: { "booking-approved": { from: ["pending"], to: "approved" } } },
  },
};

const SALON_PUBLIC = {
  submit: {
    bookings: { auth: "verifiedEmail", emailField: "email", createFields: ["email", "startAt"], selfTransitions: { pending: ["cancelled"] } },
  },
};

const SALON_VIEWS = [
  { id: "desk", audience: "member", path: "views/desk.html", collections: ["bookings"] },
  { id: "mine", audience: "participant", path: "views/mine.html", collections: ["bookings"] },
];

/** A salon whose bookings are approved by staff and cancelled by the customer. */
const salon = (overrides: Record<string, unknown> = {}) =>
  app({ members: SALON_MEMBERS, collections: SALON_COLLECTIONS, public: SALON_PUBLIC, views: SALON_VIEWS, ...overrides });

const writeOf = (authored: ReturnType<typeof app>, tier: "member" | "roster") =>
  projectAppViews(authored, STAMP)
    .filter((entry) => entry.tier === tier)
    .flatMap((entry) => entry.config.write);

test("the two audiences get DIFFERENT transition tables for the same field", () => {
  const staff = writeOf(salon(), "member");
  const theirs = writeOf(salon(), "roster");
  assert.deepEqual(staff[0]?.transitions, { initial: ["pending"], pending: ["approved", "rejected"], approved: ["done"] });
  // The participant's own transitions, and nothing of the staff's: an
  // `approved` button on their page is refused the moment it is pressed.
  assert.deepEqual(theirs[0]?.transitions, { pending: ["cancelled"] });
  assert.equal(theirs[0]?.statusField, "status");
});

test("the roster's answer to WHO may write travels with the declaration", () => {
  // The point of the pair. One `member/config` is read by everybody the tier
  // admits — the receptionist, the stylist scoped to their own rows, and an
  // observer who may write nothing — and none of them can look their own role
  // up (`apps/{aid}` is `readerOf(a, '*')`, which a per-collection role does
  // not satisfy). Without these lists the page draws approve for all three and
  // the rules refuse two of them when pressed.
  const staff = writeOf(salon(), "member");
  assert.deepEqual(staff[0]?.writers, [OWNER, RECEPTION].sort(), "owner and editor write every row");
  assert.deepEqual(staff[0]?.rowWriters, [STYLIST], "the assignee writes only the rows assigned to them");
  // A viewer is in neither, which is the whole difference between "holds a
  // role" and "may change this".
  assert.ok(!(staff[0]?.writers ?? []).includes(OBSERVER));
  assert.ok(!(staff[0]?.rowWriters ?? []).includes(OBSERVER));
  // And the assignment candidates are these two together — not published a
  // third time, so a third list cannot disagree with the two the rules read.
  assert.deepEqual([...(staff[0]?.writers ?? []), ...(staff[0]?.rowWriters ?? [])].sort(), [OWNER, RECEPTION, STYLIST].sort());
});

test("assignment, and every address, reach the staff tier only", () => {
  const staff = writeOf(salon(), "member");
  assert.equal(staff[0]?.assigneeField, "stylistEmail");
  const theirs = writeOf(salon(), "roster");
  assert.equal(theirs[0]?.assigneeField, undefined);
  // A participant writes their own row, which the rules answer from the record
  // rather than from a role — so an address list there would be a roster leak
  // for nothing.
  assert.equal(theirs[0]?.writers, undefined);
  assert.equal(theirs[0]?.rowWriters, undefined);
});

test("the assignee role with no field to compare grants nothing, and says so", () => {
  // `isAssigned` in the rules requires the field, so publishing `rowWriters`
  // without one would name people who cannot write after all.
  const noField = salon({ collections: { bookings: { statusField: "status", transitions: { pending: ["approved"] } } } });
  const staff = writeOf(noField, "member");
  assert.equal(staff[0]?.rowWriters, undefined);
  assert.deepEqual(staff[0]?.writers, [OWNER, RECEPTION].sort(), "the unscoped writers are still named");
});

test("the statuses a submitter may withdraw from reach the participant tier only", () => {
  // Staff already delete by role, and the rules answer a withdrawal from the
  // RECORD — so this belongs to the tier whose reader owns the row.
  const withdrawable = salon({
    public: { submit: { bookings: { ...SALON_PUBLIC.submit.bookings, selfDelete: ["pending"] } } },
  });
  assert.deepEqual(writeOf(withdrawable, "roster")[0]?.selfDelete, ["pending"]);
  assert.equal(writeOf(withdrawable, "member")[0]?.selfDelete, undefined);
});

test("withdrawal with no status field to read it against is nothing", () => {
  // The rules take the CURRENT status off the record before consulting the
  // list, so the key without a field grants nothing however it is written —
  // and a projected list would draw a button that is always refused.
  const noField = salon({
    collections: { bookings: {} },
    public: { submit: { bookings: { ...SALON_PUBLIC.submit.bookings, selfDelete: ["pending"] } } },
  });
  assert.deepEqual(writeOf(noField, "roster"), []);
});

test("withdrawal alone is enough to publish an entry", () => {
  // `writeFor` returns null when nothing is writable. A collection whose only
  // participant-side power is giving the row back still needs its entry, or
  // the page is handed nothing and draws no button.
  const onlyWithdraw = salon({
    collections: { bookings: { statusField: "status", transitions: { initial: ["pending"] } } },
    public: { submit: { bookings: { auth: "verifiedEmail", emailField: "email", createFields: ["email"], selfDelete: ["pending"] } } },
  });
  const theirs = writeOf(onlyWithdraw, "roster");
  assert.deepEqual(theirs[0]?.selfDelete, ["pending"]);
  assert.equal(theirs[0]?.transitions, undefined);
});

test("the mail a transition queues reaches the staff tier only", () => {
  // The rules let only a writer (or the row's own assignee) queue mail, so a
  // participant handed this could only ever be refused.
  assert.equal(writeOf(salon(), "member")[0]?.mail?.toField, "email");
  assert.equal(writeOf(salon(), "roster")[0]?.mail, undefined);
});

test("a collection with nothing writable is ABSENT, not present and empty", () => {
  // A page draws its buttons from these entries; an empty one would be a
  // collection with a button that does nothing.
  const readOnly = salon({ collections: { bookings: { statusField: "status" } }, public: { submit: {} } });
  assert.deepEqual(writeOf(readOnly, "member"), []);
  assert.deepEqual(writeOf(readOnly, "roster"), []);
});

test("a status field with no table, and a table with no field, are both nothing", () => {
  // Half a declaration is not half a feature: a field with no table would
  // offer every value, and a table with no field has nothing to write to.
  const noTable = salon({ collections: { bookings: { statusField: "status", assigneeField: "stylistEmail" } } });
  assert.equal(writeOf(noTable, "member")[0]?.transitions, undefined);
  assert.equal(writeOf(noTable, "member")[0]?.assigneeField, "stylistEmail");
  // The OTHER tier reads a different table, so dropping the staff one must not
  // take the customer's cancel with it: the two are independent declarations.
  assert.deepEqual(writeOf(noTable, "roster")[0]?.transitions, { pending: ["cancelled"] });

  const noField = salon({ collections: { bookings: { transitions: { pending: ["approved"] } } } });
  assert.deepEqual(writeOf(noField, "member"), []);
  // And with no status field there is nothing to write either table to, so the
  // participant loses their move as well — for the same reason, not by accident.
  assert.deepEqual(writeOf(noField, "roster"), []);
});

test("the write tables follow what publish PROMOTES, not what the manifest says", () => {
  // The mirror of the `participantRead` case above, and the same failure: at
  // publish `projectPublish` replaces `collections` with what the staged
  // schemas carry, so a manifest edited since the last deploy would advertise
  // transitions the live rules deny. Both halves are passed together — one
  // without the other publishes datasets from revision A beside buttons from B.
  const promoted = { collections: { bookings: { statusField: "status", transitions: { pending: ["approved"] } } } };
  const staff = projectAppViews(salon({ collections: { bookings: { statusField: "state", transitions: { open: ["closed"] } } } }), STAMP, promoted)
    .filter((entry) => entry.tier === "member")
    .flatMap((entry) => entry.config.write);
  assert.equal(staff[0]?.statusField, "status");
  assert.deepEqual(staff[0]?.transitions, { pending: ["approved"] });
});
