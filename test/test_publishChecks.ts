// What publish refuses — and, for every refusal, the neighbouring declaration
// it must still accept.
//
// The pairing is the point. A file of refusal assertions is satisfied by
// `publishProblems = () => ["no"]`, and an implementation that refuses
// everything looks exactly like a safe one from inside its own test suite. So
// each case below states the accepted form first or immediately after.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AuthoredAppZ } from "../src/publishManifest.js";
import { publishProblems, promotedRoleProblems } from "../src/publishChecks.js";

const OWNER = "owner@salon.jp";
/** The repository's shared collections, as publish sees them: a cid and the
 *  schema key its records are identified by. `id` throughout, which is why
 *  `id` throughout, and NO submit fixture below names it in createFields: a
 *  shared record's identity is its document id, and a submitter that could
 *  name its own would be claiming an identity the rules cannot check. */
const CIDS = [
  { cid: "bookings", primaryKey: "id" },
  { cid: "responses", primaryKey: "id" },
  { cid: "services", primaryKey: "id" },
  { cid: "answers", primaryKey: "id" },
];

/** Build + parse a declaration through the real zod schema, so no fixture can
 *  assert about a shape publish would have rejected before it got this far. */
function app(overrides: Record<string, unknown>) {
  return AuthoredAppZ.parse({ aid: "app_test", members: { [OWNER]: { "*": "owner" } }, ...overrides });
}

const problemsFor = (overrides: Record<string, unknown>, cids: readonly { cid: string; primaryKey: string }[] = CIDS) =>
  publishProblems(app(overrides), cids, OWNER);

/** Assert exactly which check fired, by a distinctive fragment of its line —
 *  not merely that SOMETHING was refused, which would pass on an unrelated
 *  failure and hide the check under test being dead. */
function listed(fragment: string, problems: string[]): string {
  const bullets = problems.map((problem) => `  - ${problem}`).join("\n");
  return `expected a problem mentioning ${JSON.stringify(fragment)}, got:\n${bullets || "  (none)"}`;
}

function refuses(problems: string[], fragment: string): void {
  assert.ok(
    problems.some((problem) => problem.includes(fragment)),
    listed(fragment, problems),
  );
}

// --- invariant 1: submitOnly ------------------------------------------------

const IDENTITY_BOUND: Record<string, unknown>[] = [
  { auth: "verifiedEmail", createFields: ["a"], idFrom: "auth.uid" },
  { auth: "verifiedEmail", createFields: ["a", "who"], idFrom: "auth.uid+field", idField: "who" },
  { auth: "verifiedEmail", createFields: ["a", "email"], emailField: "email" },
  { auth: "verifiedEmail", createFields: ["a"], audience: "participant" },
];

test("a submission bound to its submitter must declare submitOnly", () => {
  // Each of the four bindings makes the record MEAN "the submitter said this".
  // The writer branch of `allow create` never meets any of them, so without
  // submitOnly an owner or editor can manufacture the same rows.
  for (const submit of IDENTITY_BOUND) {
    const problems = problemsFor({ public: { submit: { responses: submit } }, collections: { responses: {} } });
    refuses(problems, "collections.responses.submitOnly must be true");
  }
});

test("declaring submitOnly satisfies it", () => {
  for (const submit of IDENTITY_BOUND) {
    const problems = problemsFor({ public: { submit: { responses: submit } }, collections: { responses: { submitOnly: true } } });
    assert.deepEqual(problems, [], `must accept ${JSON.stringify(submit)}`);
  }
});

test("a submission NOT bound to its submitter must not be forced to submitOnly", () => {
  // The counter-case that keeps the rule from being "always require it": S1's
  // ledger-style booking form, where staff enter records on a customer's
  // behalf. Requiring submitOnly there would break the feature.
  const problems = problemsFor({
    public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["customerName"], idFrom: "auto" } } },
    collections: { bookings: {} },
  });
  assert.deepEqual(problems, []);
});

test("immutable is not the condition — a mutable survey is padded the same way", () => {
  // `immutable` was the tempting condition and it is wrong: S2's responses are
  // not immutable and can be inflated exactly as a vote can.
  const problems = problemsFor({
    public: { submit: { responses: { auth: "verifiedEmail", createFields: ["q1"], idFrom: "auth.uid" } } },
    collections: { responses: { immutable: false } },
  });
  refuses(problems, "submitOnly must be true");
});

// --- invariant 2: aggregation keys -----------------------------------------

test("an aggregation key no rule checks is refused, and a checked one is not", () => {
  const loose = problemsFor({
    collections: { responses: { submitOnly: true, aggregate: { by: ["q1"] } } },
    public: { submit: { responses: { auth: "verifiedEmail", createFields: ["q1"], idFrom: "auth.uid" } } },
  });
  refuses(loose, "aggregate.by names 'q1'");

  const checked = problemsFor({
    collections: { responses: { submitOnly: true, aggregate: { by: ["q1"] } } },
    public: {
      submit: {
        responses: { auth: "verifiedEmail", createFields: ["q1"], idFrom: "auth.uid", validate: { keyFields: [{ field: "q1", values: ["a", "b"] }] } },
      },
    },
  });
  assert.deepEqual(checked, []);
});

test("the status field and gateOn.match also count as checked", () => {
  // The transition machine pins the status; the session gate pins the match
  // field. Both are checked by a rule, so both are legitimate group-by keys.
  const byStatus = problemsFor({ collections: { responses: { statusField: "status", aggregate: { by: ["status"] } } } });
  assert.deepEqual(byStatus, []);

  const byGate = problemsFor({
    collections: { answers: { submitOnly: true, aggregate: { by: ["questionId"] } } },
    public: {
      submit: { answers: { auth: "verifiedEmail", createFields: ["questionId"], idFrom: "auth.uid", gateOn: { phase: "open", match: "questionId" } } },
    },
  });
  assert.deepEqual(byGate, []);
});

// --- invariant 3: auth stage ------------------------------------------------

test("only verifiedEmail may be published, and the rules keep the other two", () => {
  for (const auth of ["none", "anonymous"]) {
    refuses(problemsFor({ public: { submit: { bookings: { auth, createFields: ["a"] } } } }), `public.submit.bookings.auth is "${auth}"`);
  }
  assert.deepEqual(problemsFor({ public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["a"] } } } }), []);
});

// --- invariant 4: names -----------------------------------------------------

test("a cid the repository does not have is refused rather than published as dead config", () => {
  // Nothing else notices this: the app document simply configures a collection
  // nobody publishes, and the collection that WAS meant goes out with no
  // status machine and no submit path.
  refuses(problemsFor({ collections: { bookingz: {} } }), "collections names 'bookingz'");
  refuses(problemsFor({ public: { read: ["servicez"] } }), "public.read names 'servicez'");
  refuses(problemsFor({ participantRead: ["nope"] }), "participantRead names 'nope'");
  assert.deepEqual(problemsFor({ collections: { bookings: {} }, public: { read: ["services"] }, participantRead: ["services"] }), []);
});

test("a name that no downstream encoding could carry is refused by the parser itself", () => {
  // The rule is `isValidCollectionName`, stated once. A second rule here is how
  // the layers come to disagree.
  assert.throws(() => app({ collections: { "book/ings": {} } }));
});

// --- invariant 5: mail ------------------------------------------------------

const MAIL_BASE = {
  statusField: "status",
  transitions: { initial: ["pending"], pending: ["approved", "rejected"], approved: [], rejected: [] },
};

test("a mail transition whose from includes its to can never send", () => {
  refuses(
    problemsFor({
      collections: {
        bookings: { ...MAIL_BASE, mail: { toField: "customerEmail", on: { "booking-approved": { from: ["pending", "approved"], to: "approved" } } } },
      },
    }),
    'lists "approved" in both',
  );
  assert.deepEqual(
    problemsFor({
      collections: { bookings: { ...MAIL_BASE, mail: { toField: "customerEmail", on: { "booking-approved": { from: ["pending"], to: "approved" } } } } },
    }),
    [],
  );
});

test("a mail transition the state machine forbids is refused", () => {
  // The record write is denied first, so the mail simply never fires — a
  // feature that is silently absent rather than broken.
  refuses(
    problemsFor({
      collections: { bookings: { ...MAIL_BASE, mail: { toField: "e", on: { t: { from: ["approved"], to: "rejected" } } } } },
    }),
    "which collections.bookings.transitions does not allow",
  );
});

test("mail needs a statusField, because the rules read the status either side of the write", () => {
  refuses(
    problemsFor({ collections: { bookings: { mail: { toField: "e", on: { t: { from: ["a"], to: "b" } } } } } }),
    "mail needs collections.bookings.statusField",
  );
});

// --- invariants 6 and 7: window and keyFields -------------------------------

test("a window that closes before it opens is refused; a real interval is not", () => {
  refuses(
    problemsFor({
      public: {
        submit: { bookings: { auth: "verifiedEmail", createFields: ["a"], window: { from: "2026-09-30T00:00:00Z", until: "2026-09-01T00:00:00Z" } } },
      },
    }),
    "closes at or before it opens",
  );
  assert.deepEqual(
    problemsFor({
      public: {
        submit: { bookings: { auth: "verifiedEmail", createFields: ["a"], window: { from: "2026-09-01T00:00:00Z", until: "2026-09-30T00:00:00Z" } } },
      },
    }),
    [],
  );
});

test("keyFields is capped at two, because the rules unroll the check", () => {
  const keyFields = (count: number) => Array.from({ length: count }, (_unused, index) => ({ field: `f${index}`, values: ["x"] }));
  const submitWith = (count: number) => ({
    auth: "verifiedEmail",
    createFields: [...keyFields(count).map((keyField) => keyField.field)],
    validate: { keyFields: keyFields(count) },
  });
  refuses(problemsFor({ public: { submit: { bookings: submitWith(3) } } }), "the rules check at most 2");
  assert.deepEqual(problemsFor({ public: { submit: { bookings: submitWith(2) } } }), []);
});

// --- the fail-closed traps --------------------------------------------------

test("initialStatus without a statusField would deny every submission", () => {
  refuses(
    problemsFor({
      collections: { bookings: {} },
      public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["a"], initialStatus: "pending" } } },
    }),
    "initialStatus needs collections.bookings.statusField",
  );
});

test("the status field must be one of the createFields a submission may carry", () => {
  // `hasOnly(createFields)` and "the status must equal initialStatus" are both
  // required by the same rule. Omit the field from createFields and the two
  // cannot be satisfied at once — every submission is refused, silently.
  refuses(
    problemsFor({
      collections: { bookings: { statusField: "status" } },
      public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["a"], initialStatus: "pending" } } },
    }),
    'createFields must include "status"',
  );
  assert.deepEqual(
    problemsFor({
      collections: { bookings: { statusField: "status" } },
      public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["a", "status"], initialStatus: "pending" } } },
    }),
    [],
  );
});

test("a required or key-checked field outside createFields can never be satisfied", () => {
  refuses(
    problemsFor({ public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["a"], validate: { required: ["b"] } } } } }),
    'validate.required names "b"',
  );
  refuses(
    problemsFor({
      public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["a"], validate: { keyFields: [{ field: "b", values: ["x"] }] } } } },
    }),
    'validate.keyFields checks "b"',
  );
});

test("auth.uid+field without an idField denies every create", () => {
  refuses(
    problemsFor({
      collections: { responses: { submitOnly: true } },
      public: { submit: { responses: { auth: "verifiedEmail", createFields: ["a"], idFrom: "auth.uid+field" } } },
    }),
    "no idField is declared",
  );
});

test("selfUpdate without a statusField denies every self-edit", () => {
  // `selfUpdate` is declared per CURRENT STATUS; with no status field the
  // rules read null and refuse before looking at the field list.
  refuses(
    problemsFor({
      collections: { bookings: {} },
      public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["a"], selfUpdate: { pending: ["a"] } } } },
    }),
    "declares no statusField",
  );
});

test("a participant submission with nobody on the roster refuses every submission", () => {
  // The rules resolve the submitter's role from `members` before they look at
  // anything else, so an empty roster is not a smaller app — it is a form that
  // silently rejects everyone who fills it in. A fail-closed trap, and the
  // author is never the person who hits it.
  const roster = {
    collections: { answers: { submitOnly: true } },
    public: { submit: { answers: { auth: "verifiedEmail", createFields: ["a"], audience: "participant" } } },
  };
  refuses(publishProblems(app({ ...roster, members: {} }), CIDS, OWNER), "the roster is empty");
  // The same declaration with somebody on the roster publishes.
  assert.deepEqual(problemsFor(roster), []);
});

test("revealGated needs the parent it reads the flag off", () => {
  refuses(problemsFor({ collections: { answers: { revealGated: true } } }), "revealGated needs both gatedFrom and revealBy");
  assert.deepEqual(problemsFor({ collections: { answers: { revealGated: true, gatedFrom: "responses", revealBy: "revealed" } } }), []);
});

test("a submit path that lets the submitter name its own primaryKey is refused", () => {
  // The rules pin the DOCUMENT ID (`idFrom`) and cannot pin the value of a
  // field. Accept the primary key as a createField and a submitter can write
  // at their one permitted id while claiming another record's identity.
  refuses(
    problemsFor({ public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["id", "customerName"] } } } }),
    'createFields must NOT include "id", the schema\'s primaryKey',
  );
  assert.deepEqual(problemsFor({ public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["customerName"] } } } }), []);
});

test("the primaryKey check follows the schema, not the name 'id'", () => {
  // A collection keyed by `name` (S1's services) must be held to `name`.
  // Hard-coding "id" would pass this file and fail the first real schema.
  const keyedByName = [{ cid: "bookings", primaryKey: "name" }];
  refuses(
    problemsFor({ public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["name"] } } } }, keyedByName),
    'createFields must NOT include "name"',
  );
  assert.deepEqual(problemsFor({ public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["id"] } } } }, keyedByName), []);
});

test("emailField and idField must be in createFields — the rules read them off the record", () => {
  // The same contradiction `required` and `keyFields` have: the rules read
  // `resource.data[emailField]`, and `hasOnly(createFields)` decides what may
  // be there at all. Declared in one and not the other, every submission is
  // refused whether or not it carries the field.
  refuses(
    problemsFor({
      collections: { responses: { submitOnly: true } },
      public: { submit: { responses: { auth: "verifiedEmail", createFields: ["answer"], emailField: "email" } } },
    }),
    'createFields must include "email"',
  );
  refuses(
    problemsFor({
      collections: { responses: { submitOnly: true } },
      public: { submit: { responses: { auth: "verifiedEmail", createFields: ["answer"], idFrom: "auth.uid+field", idField: "who" } } },
    }),
    'createFields must include "who"',
  );
  assert.deepEqual(
    problemsFor({
      collections: { responses: { submitOnly: true } },
      public: { submit: { responses: { auth: "verifiedEmail", createFields: ["answer", "email"], emailField: "email" } } },
    }),
    [],
  );
});

// --- the publisher ----------------------------------------------------------

test("the publisher must hold app-wide owner in the roster they are publishing", () => {
  // Otherwise Firestore answers with a permission error that says nothing
  // about rosters, on a write the author believes they are entitled to make.
  const problems = publishProblems(app({}), CIDS, "someone-else@salon.jp");
  refuses(problems, 'add "someone-else@salon.jp": { "*": "owner" }');
  assert.deepEqual(publishProblems(app({}), CIDS, OWNER), []);
});

test("a per-collection role is not app-wide owner", () => {
  // `role(a, '*')` falls back to the '*' entry only; a member holding
  // `{ bookings: "owner" }` cannot write the app document.
  const problems = publishProblems(AuthoredAppZ.parse({ aid: "app_test", members: { [OWNER]: { bookings: "owner" } } }), CIDS, OWNER);
  refuses(problems, "members must give you app-wide owner");
});

// --- the assignee role ------------------------------------------------------

const STYLIST = "stylist-a@salon.jp";

test("assignee needs the field that says which rows are the member's", () => {
  // The nastiest failure shape available: it fails closed for ONE member. The
  // owner who set the app up sees it working, and the stylist is told
  // "permission denied" with nothing naming a cause.
  const problems = problemsFor({ members: { [OWNER]: { "*": "owner" }, [STYLIST]: { bookings: "assignee" } } });
  refuses(problems, "collections.bookings.assigneeField does not say which field");

  assert.deepEqual(
    problemsFor({
      members: { [OWNER]: { "*": "owner" }, [STYLIST]: { bookings: "assignee" } },
      collections: { bookings: { assigneeField: "stylistEmail" } },
    }),
    [],
  );
});

test("assignee cannot be app-wide", () => {
  // Which rows are yours is per collection. An app-wide one would need the
  // same field name to be right in every collection, and where it is missing
  // it means "no access at all" rather than "no scoping here".
  const problems = problemsFor({
    members: { [OWNER]: { "*": "owner" }, [STYLIST]: { "*": "assignee" } },
    collections: { bookings: { assigneeField: "stylistEmail" } },
  });
  refuses(problems, 'holds "assignee" under "*"');
});

test("a role on a collection that does not exist is reported", () => {
  // The member holds the role on nothing, and on the collection they were
  // meant to hold it on they fall back to their '*' role — or to nothing.
  refuses(problemsFor({ members: { [OWNER]: { "*": "owner" }, [STYLIST]: { bokings: "editor" } } }), "members names 'bokings'");
});

// --- the server-stamped field -----------------------------------------------

const QUEUE = { auth: "verifiedEmail" as const, createFields: ["classId", "createdAt"], stampField: "createdAt" };

test("a stamped field the submission may not carry shuts the form", () => {
  // `hasOnly(createFields)` refuses the key the stamp check requires, so every
  // submission is denied — and the declaration reads as if it were working.
  const problems = problemsFor({ public: { submit: { bookings: { ...QUEUE, createFields: ["classId"] } } } });
  refuses(problems, "which is not in createFields");
  assert.deepEqual(problemsFor({ public: { submit: { bookings: QUEUE } } }), []);
});

test("a stamped field the submitter may edit later is not a stamp", () => {
  // Whatever it orders — a first-come queue, an audit trail — could then be
  // rewritten by the person it ranks.
  const problems = problemsFor({
    public: { submit: { bookings: { ...QUEUE, selfUpdate: { requested: ["createdAt"] } } } },
  });
  refuses(problems, "which is the field stampField pins to the server clock");
});

// --- a window bound that lives on another record ----------------------------

const OPENS = { ref: "serviceId", collection: "services", field: "opensAt" };
const BOOKING = { auth: "verifiedEmail" as const, createFields: ["serviceId"], window: { fromField: OPENS } };

test("a per-record window bound must point at a real collection", () => {
  const problems = problemsFor({ public: { submit: { bookings: { ...BOOKING, window: { fromField: { ...OPENS, collection: "classes" } } } } } });
  refuses(problems, "window.fromField.collection names 'classes'");
  assert.deepEqual(problemsFor({ public: { submit: { bookings: BOOKING } } }), []);
});

test("a per-record window bound must be reachable from the submission", () => {
  // The rules take the target's id from a field ON THE SUBMISSION. If the
  // submitter never writes it there is nothing to look up, and the form is
  // shut for good rather than open.
  const problems = problemsFor({ public: { submit: { bookings: { ...BOOKING, createFields: ["name"] } } } });
  refuses(problems, "window.fromField.ref names 'serviceId'");
});

// --- the pair publish actually writes ---------------------------------------

test("an assignee whose field never reached the deploy is refused at publish", () => {
  // deploy A (no assigneeField) → edit B (add the field AND the member) →
  // publish, without redeploying. Every manifest-level check passes on a
  // declaration that is internally sound, while what lands is A's field-less
  // configuration beside B's roster: that one member is refused every write and
  // the app keeps working for everybody else.
  const declared = app({
    members: { [OWNER]: { "*": "owner" }, "anna@salon.jp": { bookings: "assignee" } },
    collections: { bookings: { assigneeField: "stylistEmail" } },
  });
  const stagedDoc = (config: Record<string, unknown>) => ({
    cid: "bookings",
    doc: { publishedSchema: { title: "b", icon: "event", primaryKey: "id", fields: {} }, deployedAt: 1, deployedBy: OWNER, config },
  });

  // The manifest alone is sound, which is exactly why this needed its own check.
  assert.deepEqual(publishProblems(declared, CIDS, OWNER), []);

  refuses(promotedRoleProblems(declared, [stagedDoc({})] as never), "carries no assigneeField");
  assert.deepEqual(promotedRoleProblems(declared, [stagedDoc({ assigneeField: "stylistEmail" })] as never), []);
});

test("a collection with nothing staged is left to the gate that names them all", () => {
  // "not staged, so there is no reviewed version to promote" lists every
  // missing collection at once; repeating it per member would bury it.
  const declared = app({
    members: { [OWNER]: { "*": "owner" }, "anna@salon.jp": { bookings: "assignee" } },
    collections: { bookings: { assigneeField: "stylistEmail" } },
  });
  assert.deepEqual(promotedRoleProblems(declared, []), []);
});

// --- the slot booking: a document id that is a CLAIM about another record ----

/** The declaration the salon template writes, in full. Every case below starts
 *  from this and breaks exactly one thing: the interesting failures here are
 *  all "one half of a pair is missing" rather than "the shape is wrong". */
interface SalonDraft {
  // Named members rather than an index signature: every case below reaches for
  // `bookings` and `slots` by name, and an index signature would make each one
  // possibly-undefined and bury the assertion in guards.
  collections: { bookings: Record<string, unknown>; slots: Record<string, unknown> };
  public: { enabled: boolean; read: string[]; view?: { path: string; collections: string[] }; submit: { bookings: Record<string, unknown> } };
  /** The app's pages, per audience — the generalisation of `public.view`. */
  views?: Record<string, unknown>[];
  participantRead?: string[];
}

const salonDraft = (): SalonDraft => ({
  collections: {
    bookings: { statusField: "status", transitions: { initial: ["requested"] }, submitOnly: true },
    slots: { mirrorOf: "bookings" },
  },
  public: {
    enabled: true,
    read: ["slots"],
    submit: {
      bookings: {
        auth: "verifiedEmail",
        emailField: "customerEmail",
        createFields: ["slot", "customerName", "customerEmail", "status"],
        initialStatus: "requested",
        idFrom: "field",
        idField: "slot",
        idIn: { collection: "slots", where: { field: "state", equals: "open" } },
        mirror: "slots",
        window: {
          fromField: { ref: "slot", collection: "slots", field: "opensAt" },
          untilField: { ref: "slot", collection: "slots", field: "closesAt" },
        },
      },
    },
  },
});

const SALON_CIDS = [
  { cid: "bookings", primaryKey: "id" },
  { cid: "slots", primaryKey: "id" },
];

/** Break one thing about the salon declaration, and report what publish says. */
const salon = (mutate: (draft: SalonDraft) => void): string[] => {
  const draft = salonDraft();
  mutate(draft);
  return problemsFor(
    {
      collections: draft.collections,
      public: draft.public,
      ...(draft.views === undefined ? {} : { views: draft.views }),
      ...(draft.participantRead === undefined ? {} : { participantRead: draft.participantRead }),
    },
    SALON_CIDS,
  );
};

const bookingOf = (draft: SalonDraft): Record<string, unknown> => draft.public.submit.bookings;
const windowOf = (draft: SalonDraft): Record<string, unknown> => bookingOf(draft).window as Record<string, unknown>;

test("the whole booking declaration passes", () => {
  // First, and not a formality: every refusal below is only meaningful against
  // a neighbour that publishes.
  assert.deepEqual(
    salon(() => {}),
    [],
  );
});

test("refuses a field id with nothing to check it against", () => {
  // Without idIn the document id is any string a submitter likes, so the app
  // accepts bookings for slots that do not exist. Nothing downstream notices.
  refuses(
    salon((draft) => {
      delete bookingOf(draft).idIn;
    }),
    "no idIn is declared",
  );
});

test("refuses a field id with no field", () => {
  refuses(
    salon((draft) => {
      delete bookingOf(draft).idField;
    }),
    "no idField is declared",
  );
});

test("refuses idIn where the rules would never read it", () => {
  // Declared under `auth.uid` it looks like a check and is not one.
  refuses(
    salon((draft) => {
      bookingOf(draft).idFrom = "auth.uid";
      delete bookingOf(draft).idField;
    }),
    "the rules read idIn only for",
  );
});

test("refuses a field id whose field a submitter may not write", () => {
  refuses(
    salon((draft) => {
      bookingOf(draft).createFields = ["customerName", "customerEmail", "status"];
    }),
    "createFields must include",
  );
});

test("refuses half a mirror, from either side", () => {
  refuses(
    salon((draft) => {
      delete draft.collections.slots.mirrorOf;
    }),
    "does not declare mirrorOf",
  );
  refuses(
    salon((draft) => {
      delete bookingOf(draft).mirror;
    }),
    "does not declare mirror",
  );
});

test("refuses a mirror of itself and a mirror of nothing", () => {
  refuses(
    salon((draft) => {
      bookingOf(draft).mirror = "bookings";
    }),
    "names its own collection",
  );
  refuses(
    salon((draft) => {
      bookingOf(draft).mirror = "ghosts";
      draft.collections.slots = {};
    }),
    "not a shared collection",
  );
});

test("refuses a projection whose authority is not a collection here", () => {
  // The other direction from the test above: `mirror` names the projection,
  // `mirrorOf` names the authority, and this is the authority half. Nothing can
  // be true of a collection that does not exist, so the rules would never let
  // the projection's `state` be written at all — the public page keeps
  // advertising whatever it last said.
  refuses(
    salon((draft) => {
      draft.collections.slots.mirrorOf = "ghosts";
    }),
    "collections.slots.mirrorOf names 'ghosts'",
  );
});

test("checks the closing bound as thoroughly as the opening one", () => {
  refuses(
    salon((draft) => {
      windowOf(draft).untilField = { ref: "slot", collection: "ghosts", field: "closesAt" };
    }),
    "window.untilField.collection names 'ghosts'",
  );
  refuses(
    salon((draft) => {
      windowOf(draft).untilField = { ref: "whenever", collection: "slots", field: "closesAt" };
    }),
    "window.untilField.ref names 'whenever'",
  );
});

// --- the public view --------------------------------------------------------

const viewed = (mutate: (view: { path: string; collections: string[] }) => void): string[] =>
  salon((draft) => {
    const view = { path: "views/booking.html", collections: ["slots"] };
    mutate(view);
    draft.public.view = view;
  });

test("a declared public view passes", () => {
  assert.deepEqual(
    viewed(() => {}),
    [],
  );
});

test("refuses a view fed a collection the visitor may not read", () => {
  // The worst failure this feature has: the view renders, the data never
  // arrives, and it draws an empty grid with nothing anywhere to say why.
  refuses(
    viewed((view) => {
      view.collections = ["slots", "bookings"];
    }),
    "not in public.read",
  );
});

test("refuses a view that is not one HTML file directly under views/", () => {
  refuses(
    viewed((view) => {
      view.path = "../../etc/passwd";
    }),
    "exactly one HTML file",
  );
  // The one a prefix-and-suffix test lets through, and the reason this is a
  // regex: the host reads the path to decide which file to publish, and what
  // it publishes is `allow read: if true`.
  refuses(
    viewed((view) => {
      view.path = "views/../../secrets.html";
    }),
    "exactly one HTML file",
  );
  refuses(
    viewed((view) => {
      view.path = "views/nested/booking.html";
    }),
    "exactly one HTML file",
  );
  // A backslash is not a slash to a regex and IS a separator on Windows, so
  // this is the same escape wearing a different coat.
  refuses(
    viewed((view) => {
      view.path = "views/..\\..\\secrets.html";
    }),
    "exactly one HTML file",
  );
  refuses(
    viewed((view) => {
      view.path = "/etc/views/passwd.html";
    }),
    "exactly one HTML file",
  );
});

// --- the same gate, once per audience ---------------------------------------

test("a member view passes without being in public.read — it is not the public page", () => {
  assert.deepEqual(
    salon((draft) => {
      draft.views = [{ id: "desk", audience: "member", path: "views/desk.html", collections: ["bookings"] }];
    }),
    [],
  );
});

test("refuses a participant view naming a collection the PROMOTED rules will not let them read", () => {
  // Worse than the public case: an unscoped list on an own-row collection is
  // DENIED rather than narrowed, so the page fails rather than rendering less.
  //
  // And judged against what DEPLOY staged, not against app.json: publish
  // overwrites `participantRead` with the staged schemas' own, so adding a cid
  // to the manifest and publishing without redeploying produces exactly the
  // page this refuses — offered to the participant, then refused the read.
  const declared = app({
    participantRead: ["slots"],
    views: [{ id: "mine", audience: "participant", path: "views/mine.html", collections: ["slots"] }],
  });
  const staged = (participantRead: boolean) => [
    { cid: "slots", doc: { publishedSchema: { title: "s", icon: "event", primaryKey: "id", fields: {} }, deployedAt: 1, deployedBy: OWNER, participantRead } },
  ];

  // The manifest alone is sound, which is why this needed the promoted gate.
  assert.deepEqual(publishProblems(declared, [{ cid: "slots", primaryKey: "id" }], OWNER), []);

  refuses(promotedRoleProblems(declared, staged(false) as never), "which a participant cannot read once this publishes");
  assert.deepEqual(promotedRoleProblems(declared, staged(true) as never), []);
});

test("the path check binds every audience, not just the public one", () => {
  refuses(
    salon((draft) => {
      draft.views = [{ id: "desk", audience: "member", path: "views/../../secrets.html", collections: ["bookings"] }];
    }),
    "exactly one HTML file",
  );
});

test("refuses a view naming a collection this repository does not publish, whoever it is for", () => {
  refuses(
    salon((draft) => {
      draft.views = [{ id: "desk", audience: "member", path: "views/desk.html", collections: ["nowhere"] }];
    }),
    "which is not a shared collection",
  );
});

test("refuses an idIn pointing at nothing, or at itself", () => {
  refuses(
    salon((draft) => {
      bookingOf(draft).idIn = { collection: "slotz", where: { field: "state", equals: "open" } };
    }),
    "idIn.collection names 'slotz'",
  );
  // On a create the document being written does not exist yet, so a
  // self-referential idIn is a declaration nothing can ever satisfy.
  refuses(
    salon((draft) => {
      bookingOf(draft).idIn = { collection: "bookings" };
    }),
    "names 'bookings' itself",
  );
});

/** A staged collection as publish sees it: the schema deploy promoted, and
 *  that collection's rule configuration. `slots` carries the three fields the
 *  salon declaration reads off it — without them the ref-field check fires
 *  first and a mirror test would pass on the wrong refusal. */
const SLOT_FIELDS = { state: { type: "string" }, opensAt: { type: "number" }, closesAt: { type: "number" } };

const stagedSalonDoc = (cid: string, config: Record<string, unknown>) => ({
  cid,
  doc: {
    publishedSchema: { title: cid, icon: "event", primaryKey: "id", fields: cid === "slots" ? SLOT_FIELDS : {} },
    deployedAt: 1,
    deployedBy: OWNER,
    config,
  },
});

test("refuses a mirror whose other half was never deployed", () => {
  // The same trap as the assignee's field, reached the same way: publish takes
  // the submission side from app.json and the collection side from the DEPLOY.
  // Declare both halves, publish without redeploying, and what lands is a
  // booking that must move its projection beside a projection that refuses to
  // move -- every submission denied, on a declaration that reads as correct.
  const declared = app(salonDraft() as unknown as Record<string, unknown>);

  // Sound on disk, which is why this needed a check of its own.
  assert.deepEqual(publishProblems(declared, SALON_CIDS, OWNER), []);

  const stale = [stagedSalonDoc("bookings", {}), stagedSalonDoc("slots", {})];
  refuses(promotedRoleProblems(declared, stale as never), "does not declare mirrorOf");
  const fresh = [stagedSalonDoc("bookings", {}), stagedSalonDoc("slots", { mirrorOf: "bookings" })];
  assert.deepEqual(promotedRoleProblems(declared, fresh as never), []);
});

test("refuses a mirror REMOVED from the declaration but not from the deploy", () => {
  // The dangerous direction, and the one a submission-side walk cannot see.
  // Delete both halves from app.json and publish without redeploying: nothing
  // requires the projection to move any more, while the promoted collection
  // still allows it to be written. Bookings are created and the public row
  // goes on saying `open`. Every check passes; every submission succeeds; only
  // the page is wrong.
  const withoutPair = salonDraft();
  delete withoutPair.public.submit.bookings.mirror;
  delete withoutPair.collections.slots.mirrorOf;
  const declared = app(withoutPair as unknown as Record<string, unknown>);

  // The declaration on disk is sound — the pair is simply gone from it.
  assert.deepEqual(publishProblems(declared, SALON_CIDS, OWNER), []);

  const stale = [stagedSalonDoc("bookings", {}), stagedSalonDoc("slots", { mirrorOf: "bookings" })];
  refuses(promotedRoleProblems(declared, stale as never), "app.json no longer declares");
  // Deployed after the removal, the two agree again and publish is free.
  const fresh = [stagedSalonDoc("bookings", {}), stagedSalonDoc("slots", {})];
  assert.deepEqual(promotedRoleProblems(declared, fresh as never), []);
});

/** The salon's two collections as deploy staged them, with `slots` fields
 *  chosen per case: what these tests are about is what the STAGED schema says. */
const stagedWithFields = (cid: string, fields: Record<string, unknown>, config: Record<string, unknown> = {}) => ({
  cid,
  doc: {
    publishedSchema: { title: cid, icon: "event", primaryKey: "id", fields },
    deployedAt: 1,
    deployedBy: OWNER,
    config,
  },
});

/** What the salon declaration actually needs off `slots`: a state to compare
 *  and two bounds the rules read as epoch millis. */
const SOUND = { state: { type: "string" }, opensAt: { type: "number" }, closesAt: { type: "number" } };

const stagedFor = (slotFields: Record<string, unknown>) => [
  stagedWithFields("bookings", { slot: { type: "string" }, status: { type: "string" } }),
  stagedWithFields("slots", slotFields, { mirrorOf: "bookings" }),
];

test("refuses a field the referenced record's staged schema does not declare", () => {
  // A typo in a field NAME publishes cleanly and denies every submission with
  // no message: the rules read the field off the record, find nothing, and
  // refuse. It cannot be caught by the declaration gate, which is given a cid
  // and a primary key per collection — only a schema can judge a field name,
  // and the schema that matters is the one publish promotes.

  const declared = app(salonDraft() as unknown as Record<string, unknown>);
  // With all three present and of the right kind, publish is free.
  assert.deepEqual(promotedRoleProblems(declared, stagedFor(SOUND) as never), []);

  // One at a time, so a passing case cannot be hiding behind another failure.
  const without = (field: string) => Object.fromEntries(Object.entries(SOUND).filter(([name]) => name !== field));
  refuses(promotedRoleProblems(declared, stagedFor(without("state")) as never), "idIn.where.field names 'state'");
  refuses(promotedRoleProblems(declared, stagedFor(without("opensAt")) as never), "window.fromField.field names 'opensAt'");
  refuses(promotedRoleProblems(declared, stagedFor(without("closesAt")) as never), "window.untilField.field names 'closesAt'");
});

test("refuses a comparison the rules could never satisfy", () => {
  // A field that EXISTS can still be unreachable. These publish cleanly and
  // deny every submission, and the declaration reads as correct in both cases.
  const declared = app(salonDraft() as unknown as Record<string, unknown>);
  const enumState = (values: string[]) => ({ state: { type: "enum", values }, opensAt: { type: "number" }, closesAt: { type: "number" } });

  // An enum whose domain contains the value is exactly right.
  assert.deepEqual(promotedRoleProblems(declared, stagedFor(enumState(["open", "taken"])) as never), []);
  refuses(promotedRoleProblems(declared, stagedFor(enumState(["free", "taken"])) as never), "not one of the values");

  // A bound the rules read as epoch millis, stored as an ISO string: a type
  // error that fails closed, so the window never opens and nothing says why.
  refuses(
    promotedRoleProblems(declared, stagedFor({ state: { type: "string" }, opensAt: { type: "datetime" }, closesAt: { type: "number" } }) as never),
    "is a datetime field",
  );

  // Comparing a boolean field with a string.
  refuses(
    promotedRoleProblems(declared, stagedFor({ state: { type: "boolean" }, opensAt: { type: "number" }, closesAt: { type: "number" } }) as never),
    "is a boolean field",
  );
});
