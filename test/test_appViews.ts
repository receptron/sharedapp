// The app's pages, per audience: what normalizes, what is refused, and what
// each audience is handed.
//
// Every refusal here is paired with the neighbouring declaration that must
// still pass — a file of refusals alone is satisfied by an implementation that
// refuses everything, which from inside its own suite looks like safety.

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeViews, participantScope, viewDocId, writeFor, PUBLIC_VIEW_ID } from "../src/appViews.js";
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

test("a participant page drops a collection the participant may not read", () => {
  // Reading it anyway would publish `scope: "all"` for a collection the rules then deny — the page
  // fails rather than showing less. This used to be judged against a "promoted" configuration
  // (what a previous deploy had staged, which publish promoted over the manifest); with staging
  // gone the manifest is what lands, and it is the only answer there is.
  const tiers = projectAppViews(app({ views: [{ id: "mine", audience: "participant", path: "views/mine.html", collections: ["notices"] }] }), STAMP);
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

test("the document id keeps the live prefix, and the id the author wrote", () => {
  // The prefix outlived the `staged:` set it distinguished. It stays because every published app
  // on disk is addressed by these ids.
  assert.equal(viewDocId("desk"), "live:desk");
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

test("the statuses a submitter may withdraw from reach a member too, where no role deletes", () => {
  // The rules answer a withdrawal from the RECORD: `ownRow` compares
  // `emailField` and never asks which tier the reader is standing on. So a
  // member who submitted a row has always been allowed to withdraw it, and the
  // member tier has to say so — projecting nothing made `writeFor` return null
  // for the whole collection, and the page's ask came back `unknown-collection`
  // about a collection it was reading from.
  const withdrawable = salon({
    public: { submit: { bookings: { ...SALON_PUBLIC.submit.bookings, selfDelete: ["pending"] } } },
  });
  assert.deepEqual(writeOf(withdrawable, "roster")[0]?.selfDelete, ["pending"]);
  assert.deepEqual(writeOf(withdrawable, "member")[0]?.selfDelete, ["pending"]);

  // BOTH DECLARATIONS TRAVEL where both are made. Which one answers is decided
  // per READER by `capabilityOf` — a writer deletes by role, and the `viewer`
  // who submitted a row still takes their own away — so the document cannot
  // make that choice on their behalf. See `test_memberSelfWithdraw.ts`.
  const byRole = salon({
    collections: { bookings: { ...SALON_COLLECTIONS.bookings, writerDelete: true } },
    public: { submit: { bookings: { ...SALON_PUBLIC.submit.bookings, selfDelete: ["pending"] } } },
  });
  assert.equal(writeOf(byRole, "member")[0]?.writerDelete, true);
  assert.deepEqual(writeOf(byRole, "member")[0]?.selfDelete, ["pending"]);
});

test("the status field a withdrawal is checked against travels with it, table or no table", () => {
  // The rules read the CURRENT status off the record before consulting
  // `selfDelete`, and a collection that is posted and deleted — never moved —
  // declares no transitions. `statusField` used to ride only with the table, so
  // exactly those collections lost it and the withdrawal became uncheckable.
  const noTable = salon({
    collections: { bookings: { statusField: "status" } },
    public: { submit: { bookings: { ...SALON_PUBLIC.submit.bookings, selfDelete: ["pending"] } } },
  });
  const staff = writeOf(noTable, "member")[0];
  assert.equal(staff?.statusField, "status");
  assert.deepEqual(staff?.selfDelete, ["pending"]);
  // Still not movable: a field with no table must not offer every value.
  assert.equal(staff?.transitions, undefined);
});

test("the collection a withdrawal must reopen travels with the permission", () => {
  // The rules refuse a delete that leaves the mirror saying `taken`, so the
  // page needs the name of the collection to reopen — with the permission and
  // without it, every withdrawal it draws is refused.
  const slotted = salon({
    public: { submit: { bookings: { ...SALON_PUBLIC.submit.bookings, mirror: "slots", selfDelete: ["pending"] } } },
  });
  assert.equal(writeOf(slotted, "roster")[0]?.withdrawMirror, "slots");
  // An app with no contested slot has no mirror, and the key stays off.
  const plain = salon({ public: { submit: { bookings: { ...SALON_PUBLIC.submit.bookings, selfDelete: ["pending"] } } } });
  assert.equal(writeOf(plain, "roster")[0]?.withdrawMirror, undefined);
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

test("the write tables follow the declaration", () => {
  // They used to follow a second, "promoted" configuration — what a previous deploy had staged —
  // because publish replaced `collections` with it, so a manifest edited since would advertise
  // transitions the live rules denied. Publish writes both halves from this manifest now.
  const staff = projectAppViews(salon({ collections: { bookings: { statusField: "state", transitions: { open: ["closed"] } } } }), STAMP)
    .filter((entry) => entry.tier === "member")
    .flatMap((entry) => entry.config.write);
  assert.equal(staff[0]?.statusField, "state");
  assert.deepEqual(staff[0]?.transitions, { open: ["closed"] });
});

test("a participant reads a collection the app opens to the world", () => {
  // The most ordinary booking declaration there is: the slots are public, and the participant's
  // own page lists them beside their bookings. Refusing that would say "a participant cannot read
  // this" about a collection every stranger can.
  const declared = app({ public: { enabled: true, read: ["slots"], submit: {} } });
  assert.deepEqual(participantScope(declared, "slots", []), { cid: "slots", scope: "all" });
  // Not open, and nothing else reaches it: still null.
  assert.equal(participantScope(app({ public: { enabled: true, read: [], submit: {} } }), "slots", []), null);
});

test("the public page is projected the SAME writes as the participant", () => {
  // The statement this pins is about the RULES, not about taste. `ownRow` in `firestore.rules` asks
  // for `authed()` and nothing else — no role, no membership, an anonymous uid will do — and both
  // audiences read their moves out of `public.submit[cid]`. So the visitor on `/a` who booked the
  // slot and the participant on `/p` who booked the same slot may do exactly the same things to it.
  //
  // It was projected to `/p` and not to `/a`, which is how a public page came to be unable to offer
  // a cancellation the rules were waiting to allow: the page could ask, and nothing could answer.
  const authored = salon();
  const theirs = writeFor(authored, "participant", "bookings");
  const visitor = writeFor(authored, "public", "bookings");
  assert.deepEqual(visitor, theirs);
  assert.deepEqual(visitor?.transitions, { pending: ["cancelled"] });

  // The withdrawal half of the same statement, on an app that declares one.
  const withdrawable = salon({
    collections: { bookings: { statusField: "status", transitions: { initial: ["pending"] } } },
    public: { submit: { bookings: { auth: "verifiedEmail", emailField: "email", createFields: ["email"], selfDelete: ["pending"] } } },
  });
  assert.deepEqual(writeFor(withdrawable, "public", "bookings"), writeFor(withdrawable, "participant", "bookings"));
  assert.deepEqual(writeFor(withdrawable, "public", "bookings")?.selfDelete, ["pending"]);
});

test("and never the staff half, for the reason the participant never gets it", () => {
  // No roster, no assignment: those are answered by a ROLE, and a public visitor holds none. A
  // `writers` list on a world-readable document would also be an address list published for nothing
  // (principle 5).
  const visitor = writeFor(salon(), "public", "bookings");
  assert.equal(visitor?.writers, undefined);
  assert.equal(visitor?.rowWriters, undefined);
  assert.equal(visitor?.assigneeField, undefined);
  assert.equal(visitor?.mail, undefined);
});

// --- `writerDelete`: the staff half of a withdrawal
//
// It is projected from a different declaration to a different tier from `selfDelete`, because they
// are different permissions: the rules answer one with `isWriter` and no status, and the other from
// the record plus the statuses the list names. The gap this fills was silent — a member page's
// `withdrawFrom` came back empty exactly as it does for a collection nobody may delete from — and
// the workaround it forced was to publish the OWNER's page as `participant`, which costs assignment,
// the staff transitions and the roster's answer about who is who.

/** A salon whose desk may take a booking off the books entirely. */
const deletable = () =>
  salon({
    collections: {
      bookings: { ...SALON_COLLECTIONS.bookings, writerDelete: true },
      names: { writerDelete: true },
    },
  });

test("the staff tier is handed the writer's delete, and the roster's tier is not", () => {
  const staff = writeFor(deletable(), "member", "bookings");
  assert.equal(staff?.writerDelete, true);
  // And the participant's half is untouched by it: `selfDelete` is what the rules read for THEM,
  // and this app declares none.
  assert.equal(staff?.selfDelete, undefined);
  assert.equal(writeFor(deletable(), "participant", "bookings")?.writerDelete, undefined);
  assert.equal(writeFor(deletable(), "public", "bookings")?.writerDelete, undefined);
});

test("a collection with NO status is deletable by a writer, which the participant's half cannot express", () => {
  // `selfDelete` names statuses, so a roster of names — no `statusField`, nothing to move — grants
  // nothing there however it is declared. The role branch asks no status at all.
  const staff = writeFor(deletable(), "member", "names");
  assert.equal(staff?.writerDelete, true);
  assert.equal(staff?.statusField, undefined);
});

test("the mirror rides with a writer's delete, because the rules ask for it before they ask who", () => {
  // `deleteWith` opens with `mirrorReleased`. A desk handed the permission and not the collection
  // name could only ever be refused — and the slot would stay unsellable with nothing to show.
  const mirrored = salon({
    collections: { bookings: { ...SALON_COLLECTIONS.bookings, writerDelete: true } },
    public: { submit: { bookings: { ...SALON_PUBLIC.submit.bookings, mirror: "slots", selfDelete: ["pending"] } } },
  });
  assert.equal(writeFor(mirrored, "member", "bookings")?.withdrawMirror, "slots");
  assert.equal(writeFor(mirrored, "participant", "bookings")?.withdrawMirror, "slots");
});

test("a collection whose ONLY writable thing is the writer's delete still gets an entry", () => {
  // `writeFor` drops an entry that says nothing — `names` has no transitions, no assignment and no
  // roster half — so without this the permission would be projected into nothing at all.
  const entry = writeFor(deletable(), "member", "names");
  assert.notEqual(entry, null);
  assert.deepEqual(entry?.writers, [OWNER]);
});

// --- Platform-drawn pages (`views[].type`) -------------------------------------------------
//
// A view is either HTML the author wrote or a page the platform draws. These pin the four ways of
// failing to say which, plus the one shape an article page has to have — because every one of them
// fails by publishing SOMETHING rather than by erroring, and what a visitor then sees is a
// different app.

const ARTICLE = { id: "public", audience: "public", type: "article", collections: ["articles"], article: { title: "title", body: "body", summary: "summary" } };

test("an article view normalizes with its field mapping", () => {
  const result = normalizeViews(app({ views: [ARTICLE] }));
  assert.ok(result.ok);
  assert.equal(result.views[0]?.type, "article");
  assert.equal(result.views[0]?.path, undefined, "a platform page names no file");
  assert.deepEqual(result.views[0]?.article, { title: "title", body: "body", summary: "summary" });
});

test("refuses a view that declares both a path and a type", () => {
  refuses(problemsOf({ views: [{ ...ARTICLE, path: "views/public.html" }] }), "both `path` and `type`");
});

test("refuses a view that declares neither", () => {
  refuses(problemsOf({ views: [{ id: "public", audience: "public", collections: ["articles"] }] }), "neither `path` nor `type`");
});

test("refuses an article view with no article block", () => {
  refuses(problemsOf({ views: [{ id: "public", audience: "public", type: "article", collections: ["articles"] }] }), "no `article` block");
});

test("refuses an article block with no type, which would silently draw the form", () => {
  // The quiet one. Everything parses, publish succeeds, and the author believes they have named the
  // title field while the visitor is shown the generated form.
  refuses(
    problemsOf({ views: [{ id: "public", audience: "public", path: "views/public.html", collections: ["articles"], article: { title: "t", body: "b" } }] }),
    "`article` block but no `type`",
  );
});

test("refuses an article view over more than one collection", () => {
  // `/a/{slug}/{id}` carries nothing that says which collection the id is in.
  refuses(problemsOf({ views: [{ ...ARTICLE, collections: ["articles", "notes"] }] }), "shows ONE running order");
});

test("refuses an article view published to a members' tier", () => {
  refuses(problemsOf({ views: [{ ...ARTICLE, id: "desk", audience: "member" }] }), "PUBLIC face only");
});

// --- What a submitter may CORRECT (`selfUpdate`) --------------------------------------------
//
// The rules have carried `selfWriteOk` all along; what was missing was anything saying which
// fields it means, which is what `useSharedApp update` needs in order to send the right ones
// instead of everything and a bare permission error.

test("a submitter's own tiers carry the fields they may correct, per status", () => {
  const declaration = app({
    collections: { articles: { statusField: "status", transitions: { initial: ["published"] } } },
    public: {
      enabled: true,
      read: ["articles"],
      submit: { articles: { auth: "verifiedEmail", createFields: ["title"], selfUpdate: { published: ["title", "body"] } } },
    },
  });
  for (const audience of ["public", "participant"] as const) {
    const write = writeFor(declaration, audience, "articles");
    assert.deepEqual(write?.selfUpdate, { published: ["title", "body"] }, `${audience} carries no selfUpdate`);
    // Beside the field the rules read the CURRENT status from, or the map names statuses nothing
    // can be compared against.
    assert.equal(write?.statusField, "status", `${audience} carries selfUpdate with no statusField`);
  }
});

test("the STAFF tier carries it too, because ownRow does not ask which tier you are on", () => {
  // The correction that Codex found on #51, and the same answer `selfDelete` has always given.
  // `ownRow` + `selfWriteOk` compare the caller's address against the RECORD, so a `viewer`, an
  // `assignee`, or a member of a collection no role writes may correct a row they submitted —
  // exactly as they may withdraw one. Narrowing it by TIER took that away from precisely the
  // people who had no other permission.
  const declaration = app({
    collections: { articles: { statusField: "status" } },
    public: { enabled: true, submit: { articles: { auth: "verifiedEmail", createFields: ["title"], selfUpdate: { published: ["title"] } } } },
  });
  assert.deepEqual(writeFor(declaration, "member", "articles")?.selfUpdate, { published: ["title"] });
});

test("a collection whose ONLY writable thing is a correction still reaches the projection", () => {
  // The sharp edge of the same bug: `writeFor` returns null when nothing is writable, so dropping
  // `selfUpdate` on this tier did not merely hide a control — the collection left the document
  // entirely, and the page was answered `unknown-collection` about one the rules would have let
  // its reader edit.
  const declaration = app({
    collections: { notes: { statusField: "status" } },
    public: { enabled: true, submit: { notes: { auth: "verifiedEmail", createFields: ["text"], selfUpdate: { open: ["text"] } } } },
  });
  for (const audience of ["public", "participant", "member"] as const) {
    assert.notEqual(writeFor(declaration, audience, "notes"), null, `${audience} lost the collection`);
  }
});

test("no statusField means no selfUpdate is projected", () => {
  // The rules read the current status before consulting the map, so without the field the map
  // names statuses nothing will ever match — a control drawn on every row and refused on all.
  const declaration = app({
    collections: { articles: {} },
    public: { enabled: true, submit: { articles: { auth: "verifiedEmail", createFields: ["title"], selfUpdate: { published: ["title"] } } } },
  });
  assert.equal(writeFor(declaration, "participant", "articles")?.selfUpdate, undefined);
});

test("an article may be drawn from any field name a schema can declare", () => {
  // Codex on #51. These were held to `NameZ`, which is the COLLECTION-ID grammar — letters,
  // digits, `-` and `_`. A schema's fields are under no such rule, so a perfectly ordinary
  // `headline.text`, `Article Title` or Japanese field could not be named as an article's title,
  // and the refusal would have been about a grammar that governs something else.
  for (const title of ["headline.text", "Article Title", "見出し", "title_2"]) {
    const result = normalizeViews(app({ views: [{ ...ARTICLE, article: { title, body: "body" } }] }));
    assert.ok(result.ok, `expected ${title} to be a legal field name`);
    assert.equal(result.views[0]?.article?.title, title);
  }
});

test("but an article field name is still not nothing", () => {
  // The floor that stays: a blank names no field, and the page would read `undefined` and draw the
  // document id as the heading.
  assert.throws(() => app({ views: [{ ...ARTICLE, article: { title: "  ", body: "body" } }] }));
});
