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
import { publishProblems, schemaRefProblems } from "../src/publishChecks.js";
import { APP_PROTOCOL } from "../src/appProtocol.js";

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

test("anonymous publishes, none does not", () => {
  // The pair that decides whether an audience answers at all. `anonymous` costs
  // the visitor nothing and still yields a uid; `none` yields none, so the same
  // person submits as often as they can press the button.
  assert.deepEqual(problemsFor({ public: { submit: { bookings: { auth: "anonymous", createFields: ["a"] } } } }), []);
  assert.deepEqual(problemsFor({ public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["a"] } } } }), []);
  refuses(problemsFor({ public: { submit: { bookings: { auth: "none", createFields: ["a"] } } } }), 'public.submit.bookings.auth is "none"');
});

test('"none" is told everything that is wrong with it, not just that it is "none"', () => {
  // Publish is a manual step, and it stops at nothing: the whole point of returning a LIST is that
  // an author fixes the declaration once. Returning early here meant switching to "anonymous",
  // publishing again, and only then hearing about the emailField that was never going to work —
  // one refusal per attempt, over a declaration wrong in three places at once.
  const problems = problemsFor({
    collections: {
      bookings: {
        statusField: "status",
        transitions: { pending: ["approved"] },
        mail: { toField: "who", on: { ok: { from: ["pending"], to: "approved" } } },
      },
    },
    members: { [OWNER]: { "*": "owner" }, "guest@salon.jp": { "*": "participant" } },
    public: {
      submit: {
        bookings: { auth: "none", createFields: ["a", "email", "who"], emailField: "email", audience: "participant" },
      },
    },
  });
  refuses(problems, 'public.submit.bookings.auth is "none"');
  refuses(problems, "that session carries no address");
  refuses(problems, 'declares audience "participant"');
  refuses(problems, 'queues mail and public.submit.bookings is "none"');
});

test("an anonymous submission may not carry an address, a roster seat, or a mail queue", () => {
  // Each of these publishes cleanly today and behaves wrongly afterwards: the
  // field the app reads as identity holds a typed string, a participant that can
  // never be on the roster, or a mail queue anybody may aim.
  refuses(
    problemsFor({
      collections: { bookings: { submitOnly: true } },
      public: { submit: { bookings: { auth: "anonymous", createFields: ["a", "email"], emailField: "email" } } },
    }),
    "that session carries no address",
  );
  refuses(
    problemsFor({
      collections: { bookings: { submitOnly: true } },
      public: { submit: { bookings: { auth: "anonymous", createFields: ["a"], audience: "participant" } } },
    }),
    'declares audience "participant"',
  );
  refuses(
    problemsFor({
      collections: {
        bookings: {
          statusField: "status",
          transitions: { pending: ["approved"] },
          mail: { toField: "who", on: { ok: { from: ["pending"], to: "approved" } } },
        },
      },
      public: { submit: { bookings: { auth: "anonymous", createFields: ["a", "who"] } } },
    }),
    'queues mail and public.submit.bookings is "anonymous"',
  );
  // …and the same three under verifiedEmail are ordinary declarations.
  assert.deepEqual(
    problemsFor({
      collections: { bookings: { submitOnly: true } },
      public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["a", "email"], emailField: "email" } } },
    }),
    [],
  );
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

test("selfDelete without a statusField denies every withdrawal", () => {
  // Same shape as selfUpdate above: the rules read the CURRENT status first.
  refuses(
    problemsFor({
      collections: { bookings: {} },
      public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["a"], selfDelete: ["pending"] } } },
    }),
    "declares no statusField",
  );
});

test("selfDelete naming a status nothing reaches allows nothing", () => {
  // The declaration and its absence look identical from outside — no button,
  // a refused write — and the author is never the person holding the phone.
  refuses(
    problemsFor({
      collections: { bookings: { statusField: "status", transitions: { initial: ["pending"], pending: ["cancelled"] } } },
      public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["status"], selfDelete: ["withdrawn"] } } },
    }),
    "which no record ever holds",
  );
});

test("selfDelete from the status a submission STARTS in is allowed", () => {
  // The commonest declaration there is, and it was refused: `initialStatus` puts every record in
  // that status the moment it is written, so "withdraw the booking you just made" is the first
  // thing an author asks for. Reading only the transition DESTINATIONS called it unreachable —
  // and the refusal is not a warning, it is a publish that does not happen.
  assert.deepEqual(
    problemsFor({
      collections: { bookings: { statusField: "status", transitions: { pending: ["approved"] } } },
      public: {
        submit: { bookings: { auth: "verifiedEmail", createFields: ["status"], initialStatus: "pending", selfDelete: ["pending"] } },
      },
    }),
    [],
  );
});

test("selfDelete from a status the table only moves records OUT of is allowed", () => {
  // A left-hand key is the author saying records are in it. `initial` is the one that is not: it is
  // the table's word for "no record yet", so a selfDelete naming it still allows nothing.
  assert.deepEqual(
    problemsFor({
      collections: { bookings: { statusField: "status", transitions: { held: ["approved"] } } },
      public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["status"], selfDelete: ["held"] } } },
    }),
    [],
  );
  refuses(
    problemsFor({
      collections: { bookings: { statusField: "status", transitions: { initial: ["pending"], pending: ["approved"] } } },
      public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["status"], selfDelete: ["initial"] } } },
    }),
    "which no record ever holds",
  );
});

test("selfDelete with no statuses at all is refused rather than read as yes", () => {
  refuses(
    problemsFor({
      collections: { bookings: { statusField: "status", transitions: { initial: ["pending"] } } },
      public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["status"], selfDelete: [] } } },
    }),
    "allows nothing",
  );
});

test("selfDelete from a status only the STAFF can reach is allowed", () => {
  // Reachability is judged against the collection's table, not the
  // submitter's: withdrawing a booking the desk approved is the normal case,
  // and judging it against selfTransitions would refuse exactly that.
  assert.deepEqual(
    problemsFor({
      collections: { bookings: { statusField: "status", transitions: { initial: ["pending"], pending: ["approved"] } } },
      public: {
        submit: {
          bookings: { auth: "verifiedEmail", createFields: ["status"], selfTransitions: { pending: ["cancelled"] }, selfDelete: ["approved"] },
        },
      },
    }),
    [],
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

test("refuses a participant view naming a collection a participant cannot read", () => {
  // Worse than the public case: an unscoped list on an own-row collection is
  // DENIED rather than narrowed, so the page fails rather than rendering less.
  //
  // This used to be judged against what DEPLOY staged — publish overwrote
  // `participantRead` with the staged schemas' own, so the manifest could not
  // answer it. There is no staging any more, so the declaration IS what lands
  // and the ordinary gate can say so.
  const reads = (participantRead: string[]) =>
    app({
      participantRead,
      views: [{ id: "mine", audience: "participant", path: "views/mine.html", collections: ["slots"] }],
    });
  const CID = [{ cid: "slots", primaryKey: "id" }];

  refuses(publishProblems(reads([]), CID, OWNER), "which a participant cannot read");
  assert.deepEqual(publishProblems(reads(["slots"]), CID, OWNER), []);
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

/** The salon's two collections as the repository holds them, with `slots` fields chosen per case:
 *  what these tests are about is what the SCHEMA says, which is the one thing the declaration gate
 *  cannot see. */
const schemaWithFields = (cid: string, fields: Record<string, unknown>) => ({
  cid,
  schema: { title: cid, icon: "event", primaryKey: "id", fields },
});

/** What the salon declaration actually needs off `slots`: a state to compare
 *  and two bounds the rules read as epoch millis. */
const SOUND = { state: { type: "string" }, opensAt: { type: "number" }, closesAt: { type: "number" } };

const schemasFor = (slotFields: Record<string, unknown>) => [
  schemaWithFields("bookings", { slot: { type: "string" }, status: { type: "string" } }),
  schemaWithFields("slots", slotFields),
];

test("refuses a field the referenced record's schema does not declare", () => {
  // A typo in a field NAME publishes cleanly and denies every submission with
  // no message: the rules read the field off the record, find nothing, and
  // refuse. It cannot be caught by the declaration gate, which is given a cid
  // and a primary key per collection — only a schema can judge a field name,
  // and the schema that matters is the one publish promotes.

  const declared = app(salonDraft() as unknown as Record<string, unknown>);
  // With all three present and of the right kind, publish is free.
  assert.deepEqual(schemaRefProblems(declared, schemasFor(SOUND) as never), []);

  // One at a time, so a passing case cannot be hiding behind another failure.
  const without = (field: string) => Object.fromEntries(Object.entries(SOUND).filter(([name]) => name !== field));
  refuses(schemaRefProblems(declared, schemasFor(without("state")) as never), "idIn.where.field names 'state'");
  refuses(schemaRefProblems(declared, schemasFor(without("opensAt")) as never), "window.fromField.field names 'opensAt'");
  refuses(schemaRefProblems(declared, schemasFor(without("closesAt")) as never), "window.untilField.field names 'closesAt'");
});

test("refuses a comparison the rules could never satisfy", () => {
  // A field that EXISTS can still be unreachable. These publish cleanly and
  // deny every submission, and the declaration reads as correct in both cases.
  const declared = app(salonDraft() as unknown as Record<string, unknown>);
  const enumState = (values: string[]) => ({ state: { type: "enum", values }, opensAt: { type: "number" }, closesAt: { type: "number" } });

  // An enum whose domain contains the value is exactly right.
  assert.deepEqual(schemaRefProblems(declared, schemasFor(enumState(["open", "taken"])) as never), []);
  refuses(schemaRefProblems(declared, schemasFor(enumState(["free", "taken"])) as never), "not one of the values");

  // A bound the rules read as epoch millis, stored as an ISO string: a type
  // error that fails closed, so the window never opens and nothing says why.
  refuses(
    schemaRefProblems(declared, schemasFor({ state: { type: "string" }, opensAt: { type: "datetime" }, closesAt: { type: "number" } }) as never),
    "is a datetime field",
  );

  // Comparing a boolean field with a string.
  refuses(
    schemaRefProblems(declared, schemasFor({ state: { type: "boolean" }, opensAt: { type: "number" }, closesAt: { type: "number" } }) as never),
    "is a boolean field",
  );
});

test("an app declaring a contract newer than this publisher writes is refused", () => {
  // The floor. Compiled anyway, the app would be published as documents stamped with a version they
  // do not honour — and the page that reads them believes the stamp, which is worse than a refusal
  // the author can act on. The refusal names both versions.
  const problems = problemsFor({ protocol: "2.0.0" });
  refuses(problems, 'This app declares `protocol: "2.0.0"`');
  // Both versions, so the author can see which side to move.
  refuses(problems, `this publisher writes ${APP_PROTOCOL}`);
});

test("an app declaring the contract this publisher writes, or an older one, is fine", () => {
  assert.deepEqual(problemsFor({ protocol: APP_PROTOCOL }), []);
});

test("a `protocol` that is not a version is refused rather than guessed at", () => {
  // Guessing low is the direction that fails silently: an unreadable version says nothing about what
  // the app relies on, so continuing would publish under a contract nobody checked.
  //
  // ASSERTED, not merely built: this loop called `listed(...)` and threw the message away, so it
  // passed on every value including the ones that publish cleanly — a refusal test satisfied by no
  // refusal at all.
  for (const stated of ["2", "1.0", "v1.0.0", "latest"]) {
    refuses(problemsFor({ protocol: stated }), `\`protocol\` is "${stated}", which is not a version`);
  }
  // And the shape that IS a version still passes, so the check is not simply refusing everything.
  assert.deepEqual(problemsFor({ protocol: "1.0.0" }), []);
});
