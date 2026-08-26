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
      public: { submit: { bookings: { auth: "verifiedEmail", emailField: "who", createFields: ["a"], selfUpdate: { pending: ["a"] } } } },
    }),
    "declares no statusField",
  );
});

test("selfDelete without a statusField denies every withdrawal", () => {
  // Same shape as selfUpdate above: the rules read the CURRENT status first.
  refuses(
    problemsFor({
      collections: { bookings: { submitOnly: true } },
      public: { submit: { bookings: { auth: "verifiedEmail", emailField: "who", createFields: ["a", "who"], selfDelete: ["pending"] } } },
    }),
    "declares no statusField",
  );
});

test("selfDelete naming a status nothing reaches allows nothing", () => {
  // The declaration and its absence look identical from outside — no button,
  // a refused write — and the author is never the person holding the phone.
  refuses(
    problemsFor({
      collections: { bookings: { submitOnly: true, statusField: "status", transitions: { initial: ["pending"], pending: ["cancelled"] } } },
      public: { submit: { bookings: { auth: "verifiedEmail", emailField: "who", createFields: ["status", "who"], selfDelete: ["withdrawn"] } } },
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
      collections: { bookings: { submitOnly: true, statusField: "status", transitions: { initial: ["pending"], pending: ["approved"] } } },
      public: {
        submit: { bookings: { auth: "verifiedEmail", emailField: "who", createFields: ["status", "who"], initialStatus: "pending", selfDelete: ["pending"] } },
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
      collections: { bookings: { submitOnly: true, statusField: "status", transitions: { held: ["approved"] } } },
      public: { submit: { bookings: { auth: "verifiedEmail", emailField: "who", createFields: ["status", "who"], selfDelete: ["held"] } } },
    }),
    [],
  );
  refuses(
    problemsFor({
      collections: { bookings: { submitOnly: true, statusField: "status", transitions: { initial: ["pending"], pending: ["approved"] } } },
      public: { submit: { bookings: { auth: "verifiedEmail", emailField: "who", createFields: ["status", "who"], selfDelete: ["initial"] } } },
    }),
    "which no record ever holds",
  );
});

test("selfDelete with no statuses at all is refused rather than read as yes", () => {
  refuses(
    problemsFor({
      collections: { bookings: { submitOnly: true, statusField: "status", transitions: { initial: ["pending"] } } },
      public: { submit: { bookings: { auth: "verifiedEmail", emailField: "who", createFields: ["status", "who"], selfDelete: [] } } },
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
      collections: { bookings: { submitOnly: true, statusField: "status", transitions: { initial: ["pending"], pending: ["approved"] } } },
      public: {
        submit: {
          bookings: {
            auth: "verifiedEmail",
            emailField: "who",
            createFields: ["status", "who"],
            selfTransitions: { pending: ["cancelled"] },
            selfDelete: ["approved"],
          },
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
  const problems = problemsFor({ protocol: "3.0.0" });
  refuses(problems, 'This app declares `protocol: "3.0.0"`');
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

// --- the gate's own field ---------------------------------------------------

test("a gateOn.match the submission may not carry has no input that works", () => {
  // `gateMatches()` reads `request.resource.data[g.match]`. Outside createFields
  // there is no submission that passes: carrying the field fails `hasOnly`,
  // omitting it fails the gate. The form is shut and reads as if it were open.
  const gated = (createFields: string[]) => ({
    collections: { answers: { submitOnly: true } },
    public: {
      submit: { answers: { auth: "verifiedEmail", createFields, idFrom: "auth.uid", gateOn: { phase: "open", match: "questionId" } } },
    },
  });
  refuses(problemsFor(gated(["choice"])), 'public.submit.answers.createFields must include "questionId"');
  assert.deepEqual(problemsFor(gated(["choice", "questionId"])), []);
});

// --- where a gated reveal reads its flag ------------------------------------

test("a gatedFrom naming no collection of this repository never opens the gate", () => {
  // The half-declared pair is refused above; this is the typo one step further
  // in, where both keys are present and the parent does not exist.
  refuses(
    problemsFor({ collections: { answers: { revealGated: true, gatedFrom: "responsez", revealBy: "revealed" } } }),
    "collections.answers.gatedFrom names 'responsez'",
  );
  assert.deepEqual(problemsFor({ collections: { answers: { revealGated: true, gatedFrom: "responses", revealBy: "revealed" } } }), []);
});

// --- a mirror is one thing written twice ------------------------------------

test("a mirror without a shared document id projects onto nothing", () => {
  // The projection's whole job is to say "this slot is taken" about THAT slot,
  // which it can only do by sharing the record's id. With `auto` the pair is
  // written and the row the public page reads is never the row that was claimed.
  for (const idFrom of ["auto", "auth.uid"]) {
    refuses(
      salon((draft) => {
        bookingOf(draft).idFrom = idFrom;
        delete bookingOf(draft).idIn;
      }),
      `public.submit.bookings.mirror names 'slots', but idFrom is ${JSON.stringify(idFrom)}`,
    );
  }
  // Omitted entirely is the same declaration, said by leaving it out.
  refuses(
    salon((draft) => {
      delete bookingOf(draft).idFrom;
      delete bookingOf(draft).idIn;
    }),
    "but idFrom is absent",
  );
  // And the mode that works — the whole salon declaration, unchanged — still does.
  assert.deepEqual(
    salon(() => {}),
    [],
  );
});

test("a mirror with two things wrong says both, rather than one per publish", () => {
  // The missing `mirrorOf` used to hide the missing `idFrom` behind it: the
  // author fixed one half, published again, and was refused again. Publish is
  // a manual step, so that is a second round trip for nothing.
  const problems = salon((draft) => {
    delete draft.collections.slots.mirrorOf;
    bookingOf(draft).idFrom = "auto";
    delete bookingOf(draft).idIn;
  });
  refuses(problems, "does not declare mirrorOf");
  refuses(problems, 'but idFrom is "auto"');
});

test("the missing idField and idIn of a field id are reported once, by their own check", () => {
  // `fieldIdProblems` already owns those two, and a mirror in the same
  // declaration must not say them a second time.
  const problems = salon((draft) => {
    delete bookingOf(draft).idField;
    delete bookingOf(draft).idIn;
  });
  refuses(problems, 'public.submit.bookings.idFrom is "field" but no idField is declared');
  refuses(problems, 'public.submit.bookings.idFrom is "field" but no idIn is declared');
  assert.equal(
    problems.filter((problem) => problem.includes("but idFrom is")).length,
    0,
    `the mirror check must stay quiet when idFrom IS "field":\n${problems.join("\n")}`,
  );
});

// --- the status a record arrives in -----------------------------------------

test("an initialStatus the transition table does not start in is refused by every create", () => {
  // The rules judge a create against `transitions.initial`. Both halves read as
  // correct on their own, and what reaches the submitter is a bare denial.
  const table = (initial: string[]) => ({
    collections: { bookings: { statusField: "status", transitions: { initial, requested: ["approved"] } } },
    public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["a", "status"], initialStatus: "requested" } } },
  });
  refuses(problemsFor(table(["held"])), 'public.submit.bookings.initialStatus is "requested"');
  assert.deepEqual(problemsFor(table(["requested"])), []);
});

test("a collection with no transition table at all is left alone", () => {
  // `lunches`, `survey` and `mbti` carry a status and move it by hand. There is
  // no table for the declaration to contradict, so there is nothing to refuse.
  assert.deepEqual(
    problemsFor({
      collections: { responses: { statusField: "status", submitOnly: true } },
      public: { submit: { responses: { auth: "verifiedEmail", emailField: "email", createFields: ["email", "status"], initialStatus: "submitted" } } },
    }),
    [],
  );
});

// --- the fields a self-edit may never touch ---------------------------------

/** A booking a submitter may amend, and the three fields amending would break. */
const SELF = {
  collections: { bookings: { statusField: "status", transitions: { initial: ["booked"] }, submitOnly: true } },
  submit: {
    auth: "verifiedEmail" as const,
    emailField: "customerEmail",
    createFields: ["slot", "customerEmail", "purpose", "status"],
    initialStatus: "booked",
    idFrom: "field" as const,
    idField: "slot",
    idIn: { collection: "services" },
  },
};

const selfUpdating = (fields: string[]) =>
  problemsFor({ collections: SELF.collections, public: { submit: { bookings: { ...SELF.submit, selfUpdate: { booked: fields } } } } });

test("an ordinary business field is exactly what selfUpdate is for", () => {
  // First, because each refusal below is only worth what this accepts.
  assert.deepEqual(selfUpdating(["purpose"]), []);
});

test("selfUpdate may not carry the submitter's own identity", () => {
  refuses(selfUpdating(["purpose", "customerEmail"]), "lets the submitter write 'customerEmail'");
});

test("selfUpdate may not carry the field the document id was built from", () => {
  refuses(selfUpdating(["slot"]), "lets the submitter write 'slot'");
});

test("selfUpdate may not carry the status the transition table governs", () => {
  // Listed here, the status moves without being checked against
  // selfTransitions at all — the submitter holding the staff's pen.
  refuses(selfUpdating(["status"]), "lets the submitter write 'status'");
});

test("the server-stamped field keeps its own refusal, and is not reported twice", () => {
  const problems = problemsFor({
    collections: SELF.collections,
    public: {
      submit: {
        bookings: { ...SELF.submit, createFields: [...SELF.submit.createFields, "createdAt"], stampField: "createdAt", selfUpdate: { booked: ["createdAt"] } },
      },
    },
  });
  const said = problems.filter((problem) => problem.includes("'createdAt'"));
  assert.equal(said.length, 1, `expected exactly one line about createdAt, got:\n${said.join("\n")}`);
  refuses(said, "which is the field stampField pins to the server clock");
});

test("every problem in a declaration with several is returned at once", () => {
  // Publish is a manual step; stopping at the first would make it N round trips.
  const problems = selfUpdating(["customerEmail", "slot", "status"]);
  for (const field of ["customerEmail", "slot", "status"]) {
    refuses(problems, `lets the submitter write '${field}'`);
  }
});

// --- what the mail queue reads off the record -------------------------------

const mailed = (mail: Record<string, unknown>) => {
  const draft = salonDraft();
  draft.collections.bookings.mail = mail;
  return app(draft as unknown as Record<string, unknown>);
};

const MAIL = { toField: "customerEmail", on: { booked: { from: ["requested"], to: "booked" } }, dataFields: ["slot"] };

test("a mail queue's fields must exist on the record it reads them off", () => {
  // The declaration gate cannot see this: a `toField` the schema does not
  // declare means the queue finds no address and SKIPS the send, so the status
  // moves, the app looks like it worked, and nobody is told.
  const BOOKING_FIELDS = { slot: { type: "string" }, status: { type: "string" }, customerEmail: { type: "string" } };
  const schemas = (bookingFields: Record<string, unknown>) => [schemaWithFields("bookings", bookingFields), schemaWithFields("slots", SOUND)];

  assert.deepEqual(schemaRefProblems(mailed(MAIL), schemas(BOOKING_FIELDS) as never), []);
  const without = (field: string) => Object.fromEntries(Object.entries(BOOKING_FIELDS).filter(([name]) => name !== field));
  refuses(schemaRefProblems(mailed(MAIL), schemas(without("customerEmail")) as never), "collections.bookings.mail.toField names 'customerEmail'");
  refuses(schemaRefProblems(mailed(MAIL), schemas(without("slot")) as never), "collections.bookings.mail.dataFields names 'slot'");
  // No schema for the collection at all is somebody else's error, said once.
  assert.deepEqual(schemaRefProblems(mailed(MAIL), [schemaWithFields("slots", SOUND)] as never), []);
});

test("a field name every object already answers to is not a declared field", () => {
  // `constructor`, `toString` and `__proto__` are names an author can type, and
  // reached through the prototype chain they answer "yes, that field exists" to
  // every check here — a gate with three holes in it, failing exactly where it
  // was added to catch a silence.
  const BOOKING_FIELDS = { slot: { type: "string" }, status: { type: "string" }, customerEmail: { type: "string" } };
  const schemas = [schemaWithFields("bookings", BOOKING_FIELDS), schemaWithFields("slots", SOUND)];

  refuses(schemaRefProblems(mailed({ ...MAIL, toField: "constructor" }), schemas as never), "mail.toField names 'constructor'");
  refuses(schemaRefProblems(mailed({ ...MAIL, dataFields: ["toString"] }), schemas as never), "mail.dataFields names 'toString'");

  // And the same question asked of the reference family beside it.
  const draft = salonDraft();
  bookingOf(draft).idIn = { collection: "slots", where: { field: "constructor", equals: "open" } };
  refuses(schemaRefProblems(app(draft as unknown as Record<string, unknown>), schemas as never), "idIn.where.field names 'constructor'");
});

test("an enum comparison is a string, and publish does not convert one for the rules", () => {
  // `String(equals)` made `1` look like `'1'` here and nothing like it there:
  // the rules compare the stored value with the published literal and never
  // coerce, so the comparison is false forever and every submission is refused.
  const declared = (equals: string | number | boolean) => {
    const draft = salonDraft();
    bookingOf(draft).idIn = { collection: "slots", where: { field: "state", equals } };
    return app(draft as unknown as Record<string, unknown>);
  };
  const enumState = (values: string[]) => [
    schemaWithFields("bookings", { slot: { type: "string" }, status: { type: "string" } }),
    schemaWithFields("slots", { state: { type: "enum", values }, opensAt: { type: "number" }, closesAt: { type: "number" } }),
  ];

  assert.deepEqual(schemaRefProblems(declared("open"), enumState(["open", "taken"]) as never), []);
  refuses(schemaRefProblems(declared(1), enumState(["1", "2"]) as never), "not one of the values");
  refuses(schemaRefProblems(declared(true), enumState(["true", "false"]) as never), "not one of the values");
  refuses(schemaRefProblems(declared("shut"), enumState(["open", "taken"]) as never), "not one of the values");
});

// --- uidField: identity without an address ----------------------------------
//
// The shape it exists for is a shared to-do board, and the reason it exists is
// that the document id is spent: the claim's id IS the task's id, which is what
// stops two people taking one task, so identity has to live in a field. The
// field version there was is `emailField`, and a board showing who is working on
// what publishes the whole row — a rule cannot hide a field — so the address
// goes out with the name.

/** The board, as it publishes: one claim per task, taken by whoever is signed
 *  in, given back by them alone. */
const boardDraft = (): Record<string, unknown> => ({
  collections: { claims: { submitOnly: true, statusField: "status", transitions: { initial: ["doing"], doing: ["done"] } } },
  public: {
    enabled: true,
    submit: {
      claims: {
        auth: "verifiedEmail",
        uidField: "uid",
        createFields: ["taskId", "name", "uid", "status"],
        initialStatus: "doing",
        idFrom: "field",
        idField: "taskId",
        idIn: { collection: "tasks" },
        selfUpdate: { doing: ["name"] },
        selfDelete: ["doing"],
      },
    },
  },
});

const CLAIM_CIDS = [
  { cid: "claims", primaryKey: "id" },
  { cid: "tasks", primaryKey: "id" },
];

const board = (edit: (draft: Record<string, unknown>) => void = () => {}) => {
  const draft = boardDraft();
  edit(draft);
  return publishProblems(app(draft), CLAIM_CIDS, OWNER);
};

/** The claim declaration inside a draft, as the tests reach for it. */
const claimOf = (draft: Record<string, unknown>) =>
  ((draft.public as Record<string, unknown>).submit as Record<string, Record<string, unknown>>).claims as Record<string, unknown>;

test("publishes a board that identifies its submitters by uid and collects no address", () => {
  // FIRST, because every refusal below is only worth what this accepts.
  assert.deepEqual(board(), []);
});

test("uidField binds the record to its submitter, so the collection needs submitOnly", () => {
  // Same reason as the other four bindings: the writer branch never meets the
  // public-create checks, so without submitOnly the desk can manufacture rows
  // that MEAN "this person took this task".
  refuses(
    board((draft) => {
      delete (draft.collections as Record<string, Record<string, unknown>>).claims!.submitOnly;
    }),
    "collections.claims.submitOnly must be true",
  );
});

test("declaring uidField needs no protocol floor, because a build that lacks the key stops sooner", () => {
  // It used to require `protocol: "1.1.0"`. Removed after measuring what an older build does with
  // this declaration: `SubmitZ` is `.strict()`, so it answers `Unrecognized key: "uidField"` —
  // before any version is compared, and identically whether or not a floor was declared. A floor
  // that changes nothing is friction taught to every author of a board.
  assert.deepEqual(board(), []);
  // And the floor mechanism is still there for the change a schema cannot see — a key whose
  // MEANING moves. Naming a contract this build does not implement is refused, floor or no floor.
  //
  // The example moved from 1.1.0 to 2.1.0 when article views made this build emit 2.0.0: a floor is
  // a statement about the PUBLISHER, so 1.1.0 is now a contract this build can honour and refusing
  // it would be wrong. What must still be refused is one above the newest it implements.
  refuses(
    board((draft) => {
      draft.protocol = "2.1.0";
    }),
    "this publisher writes 2.0.0",
  );
});

test("uidField must be in createFields, like every other field a rule reads", () => {
  // Unsatisfiable both ways: carrying it fails `hasOnly(createFields)`, omitting
  // it fails `uidOk`. The submitter cannot resolve either.
  refuses(
    board((draft) => {
      claimOf(draft).createFields = ["taskId", "name", "status"];
    }),
    'createFields must include "uid"',
  );
});

test("uidField may not be listed in selfUpdate", () => {
  // The rules freeze it (`uidHeld`), so the declaration does not loosen
  // anything — it draws a button with nothing behind it and reads, to the next
  // person, like a granted permission.
  refuses(
    board((draft) => {
      claimOf(draft).selfUpdate = { doing: ["name", "uid"] };
    }),
    "selfUpdate.doing lets the submitter write 'uid'",
  );
});

test('uidField is refused with auth "none", and accepted with "anonymous"', () => {
  // The pairing that has no other spelling is the accepted one: an anonymous
  // session has no address at all, so `emailField` cannot say whose row this is.
  // With nobody signed in there is no uid either, and every create is refused
  // with nothing to explain it.
  refuses(
    board((draft) => {
      claimOf(draft).auth = "none";
    }),
    "there is no session and therefore no uid",
  );
  assert.deepEqual(
    board((draft) => {
      claimOf(draft).auth = "anonymous";
    }),
    [],
  );
});

test("a participant view reaches a collection scoped by uidField", () => {
  // `ownRow` grants it, so a projection answering "a participant cannot read
  // this" would be the projection disagreeing with the rules — the one
  // direction this package is not allowed to be wrong in.
  assert.deepEqual(
    board((draft) => {
      draft.views = [{ id: "mine", audience: "participant", path: "views/mine.html", collections: ["claims"] }];
    }),
    [],
  );
});

// --- two system bindings on one field ---------------------------------------

test("refuses one field claimed by two of the bindings the host fills in", () => {
  // Nothing is misspelt: each key is individually correct, each check that looks at one of them
  // passes, and the runtime writes the field twice — so the surviving value depends on the order
  // `recordOf` happens to use. The rules require both, and every create is denied.
  refuses(
    board((draft) => {
      claimOf(draft).stampField = "uid";
      claimOf(draft).createFields = ["taskId", "name", "uid", "status"];
    }),
    "points uidField and stampField at the same field 'uid'",
  );
  // The pairs that predate uidField are the same mistake and were equally silent.
  refuses(
    board((draft) => {
      claimOf(draft).emailField = "uid";
    }),
    "points emailField and uidField at the same field 'uid'",
  );
  refuses(
    board((draft) => {
      claimOf(draft).uidField = "status";
      claimOf(draft).createFields = ["taskId", "name", "status"];
    }),
    "at the same field 'status'",
  );
});

test("a field claimed three times is one line naming all three", () => {
  // Per field rather than per pair: three lines saying the same thing about one field is three
  // round trips to fix one mistake, and publish is a manual step with a person waiting.
  const problems = board((draft) => {
    claimOf(draft).emailField = "uid";
    claimOf(draft).stampField = "uid";
  });
  refuses(problems, "points emailField and uidField and stampField at the same field 'uid'");
  assert.equal(problems.filter((problem) => problem.includes("at the same field")).length, 1);
});

test("the same names in different collections are not a collision", () => {
  // The acceptance half. Every app here calls its stamp `createdAt`; the check is about one
  // declaration pointing two bindings at one field, not about a name being popular.
  const draft = boardDraft();
  (draft.collections as Record<string, Record<string, unknown>>).notes = { submitOnly: true };
  ((draft.public as Record<string, unknown>).submit as Record<string, unknown>).notes = {
    auth: "verifiedEmail",
    uidField: "uid",
    createFields: ["body", "uid"],
  };
  assert.deepEqual(publishProblems(app(draft), [...CLAIM_CIDS, { cid: "notes", primaryKey: "id" }], OWNER), []);
});

// --- writerDelete: a control that cannot work must not be published

test("a writerDelete on an immutable collection is refused, and on a mutable one is not", () => {
  // `deleteWith` asks `!flagOn(c, "immutable")` before it asks who is asking, so this pair draws a
  // delete button for the owner and refuses every press — with a bare permission error, which says
  // nothing about the declaration that caused it.
  refuses(problemsFor({ collections: { bookings: { writerDelete: true, immutable: true } } }), "writerDelete and immutable");
  assert.deepEqual(problemsFor({ collections: { bookings: { writerDelete: true } } }), []);
});

test("a writerDelete nobody holds the role for is refused", () => {
  // The permission is a ROLE. With no owner or editor on the collection the capability resolves to
  // "no" for everybody the staff tier admits, so the page would draw the control for all of them —
  // the declaration/enforcement mismatch this projection exists to prevent.
  const problems = publishProblems(
    AuthoredAppZ.parse({
      aid: "app_test",
      // An app-wide owner is required elsewhere; this one holds it nowhere near `bookings`.
      members: { [OWNER]: { "*": "owner", bookings: "viewer" } },
      collections: { bookings: { writerDelete: true } },
    }),
    CIDS,
    OWNER,
  );
  refuses(problems, 'nobody holds "owner" or "editor"');
});

test("a writerDelete held by a collection-level editor is accepted", () => {
  // The paired acceptance, and it pins the role RESOLUTION as well as the check: the per-collection
  // entry wins over the app-wide one, which is how the rules resolve it (`role()`), so an app-wide
  // owner scoped down to `viewer` here is refused above while an editor here is not.
  assert.deepEqual(problemsFor({ members: { [OWNER]: { "*": "owner", bookings: "editor" } }, collections: { bookings: { writerDelete: true } } }), []);
});

// --- refIn: the parent record's state, on every create ----------------------

const ROUNDTABLE_CIDS = [
  { cid: "topics", primaryKey: "id" },
  { cid: "messages", primaryKey: "id" },
];

/** The roundtable, reduced to the declaration under test: a thread whose
 *  messages may only be added while the topic says `open`, and a topic with no
 *  way back out of `closed`. */
const roundtable = (refIn: unknown) => ({
  collections: {
    topics: { statusField: "status", transitions: { initial: ["open"], open: ["closed"] } },
    messages: { statusField: "status", transitions: { initial: ["posted"] }, ...(refIn === undefined ? {} : { refIn }) },
  },
});

const roundtableProblems = (refIn: unknown) => problemsFor(roundtable(refIn), ROUNDTABLE_CIDS);

const OPEN_TOPIC = { ref: "topicId", collection: "topics", where: { field: "status", equals: "open" } };

test("accepts a refIn naming a real collection, and the app without one", () => {
  // The accepted form first: this is the whole declaration an app needs to
  // stop its own writers posting into a thread the host closed.
  assert.deepEqual(roundtableProblems(OPEN_TOPIC), []);
  // Existence alone is a legitimate weaker form — the parent must be there.
  assert.deepEqual(roundtableProblems({ ref: "topicId", collection: "topics" }), []);
  // And a collection that never declares it is untouched.
  assert.deepEqual(roundtableProblems(undefined), []);
});

test("refuses a refIn pointing at a collection that does not exist", () => {
  // The silence this catches is total AND self-inflicted: the rules get() a
  // collection that is not there, which is an evaluation error, so the author
  // locks their own app out of `messages` and nothing anywhere says why.
  refuses(roundtableProblems({ ...OPEN_TOPIC, collection: "topicz" }), "collections.messages.refIn.collection names 'topicz'");
});

test("refuses a refIn naming its own collection", () => {
  // It reads like the one shape a ref-keyed check adds over `idIn` — a reply
  // that may only be posted while the message it answers stands — and it is a
  // collection nothing can ever be written to: `refIn` makes the ref field
  // mandatory, so every row needs a row to point at, the FIRST one included.
  // A rules test found this; publish is where it becomes readable.
  refuses(roundtableProblems({ ref: "replyTo", collection: "messages" }), "names 'messages' itself");
});

const roundtableSchemas = (messageFields: Record<string, unknown>, topicFields: Record<string, unknown>) => [
  schemaWithFields("messages", messageFields),
  schemaWithFields("topics", topicFields),
];

const MESSAGE_FIELDS = { topicId: { type: "string" }, body: { type: "text" }, status: { type: "string" } };
const TOPIC_FIELDS = { title: { type: "string" }, status: { type: "string" } };

test("refuses a refIn whose ref field the schema does not declare", () => {
  // The half that is judged against the collection being WRITTEN, not the
  // parent — and the worst failure in the family, because the path is built
  // out of the missing field: not "some creates are refused" but none at all,
  // the owner's included.
  const declared = app(roundtable(OPEN_TOPIC));
  assert.deepEqual(schemaRefProblems(declared, roundtableSchemas(MESSAGE_FIELDS, TOPIC_FIELDS) as never), []);

  const withoutRef = Object.fromEntries(Object.entries(MESSAGE_FIELDS).filter(([name]) => name !== "topicId"));
  refuses(schemaRefProblems(declared, roundtableSchemas(withoutRef, TOPIC_FIELDS) as never), "collections.messages.refIn.ref names 'topicId'");
});

test("refuses a refIn whose where.field the parent's schema does not declare", () => {
  const declared = app(roundtable(OPEN_TOPIC));
  const withoutStatus = Object.fromEntries(Object.entries(TOPIC_FIELDS).filter(([name]) => name !== "status"));
  refuses(schemaRefProblems(declared, roundtableSchemas(MESSAGE_FIELDS, withoutStatus) as never), "collections.messages.refIn.where.field names 'status'");
});

test("refuses a refIn comparison the rules could never satisfy", () => {
  // `status` exists and is an enum that does not contain "open": reads as
  // correct, refuses every message forever.
  const declared = app(roundtable(OPEN_TOPIC));
  const enumStatus = (values: string[]) => ({ title: { type: "string" }, status: { type: "enum", values } });
  assert.deepEqual(schemaRefProblems(declared, roundtableSchemas(MESSAGE_FIELDS, enumStatus(["open", "closed"])) as never), []);
  refuses(schemaRefProblems(declared, roundtableSchemas(MESSAGE_FIELDS, enumStatus(["live", "closed"])) as never), "not one of the values");
});

// --- sealed: a status a record cannot be deleted from ----------------------

const sealedProblemsFor = (topics: Record<string, unknown>) =>
  problemsFor(
    { collections: { topics: { statusField: "status", transitions: { initial: ["open"], open: ["closed"] }, ...topics }, messages: {} } },
    ROUNDTABLE_CIDS,
  );

test("accepts sealing a status records actually reach", () => {
  // The accepted form: without this, deleting the closed topic and writing it
  // again as `open` undoes the close in two ordinary writes, and `refIn`
  // reports a genuinely open topic.
  assert.deepEqual(sealedProblemsFor({ sealed: ["closed"] }), []);
  assert.deepEqual(sealedProblemsFor({}), []);
});

test("refuses a sealed list that seals nothing", () => {
  refuses(sealedProblemsFor({ sealed: [] }), "collections.topics.sealed is an empty list");
  refuses(sealedProblemsFor({ sealed: ["archived"] }), 'collections.topics.sealed names "archived"');
});

test("refuses sealed without a statusField to read", () => {
  // The quiet one: the rules reach a record's status only through
  // `statusField`, so without it nothing is ever sealed — the app publishes
  // and the promise is simply not kept.
  const problems = problemsFor(
    { collections: { topics: { transitions: { initial: ["open"], open: ["closed"] }, sealed: ["closed"] }, messages: {} } },
    ROUNDTABLE_CIDS,
  );
  refuses(problems, "declares no statusField");
});

test("refuses a ref field whose value could never be a document id", () => {
  // The rules build the parent's path out of this value, and `$(...)` on a
  // non-string is an evaluation error — so a number field publishes cleanly
  // and then refuses every create in the collection, the owner's included.
  const declared = app(roundtable(OPEN_TOPIC));
  const numeric = { ...MESSAGE_FIELDS, topicId: { type: "number" } };
  refuses(schemaRefProblems(declared, roundtableSchemas(numeric, TOPIC_FIELDS) as never), "declares as a number field");
  // A `ref` field is the natural way to name a parent, and it is a string.
  const asRef = { ...MESSAGE_FIELDS, topicId: { type: "ref", to: "topics" } };
  assert.deepEqual(schemaRefProblems(declared, roundtableSchemas(asRef, TOPIC_FIELDS) as never), []);
});

test("refuses a ref field pointing somewhere other than refIn.collection", () => {
  // Correct-looking twice over: the field says one collection, refIn says
  // another, and the ids are then searched for where they were never issued.
  const declared = app(roundtable(OPEN_TOPIC));
  const elsewhere = { ...MESSAGE_FIELDS, topicId: { type: "ref", to: "messages" } };
  refuses(schemaRefProblems(declared, roundtableSchemas(elsewhere, TOPIC_FIELDS) as never), "a ref field pointing at 'messages'");
});

test("sealed reachability is judged against THIS collection's submissions", () => {
  // Reading every submit block let one collection's initialStatus vouch for
  // another's statuses — `topics.sealed: ["posted"]` passing because
  // `messages` happens to post — so the check answered about the wrong
  // collection and waved through the typo it exists to catch.
  const problems = problemsFor(
    {
      collections: {
        topics: { statusField: "status", transitions: { initial: ["open"], open: ["closed"] }, sealed: ["posted"] },
        messages: { statusField: "status", submitOnly: true },
      },
      public: { submit: { messages: { auth: "verifiedEmail", createFields: ["body", "status"], emailField: "who", initialStatus: "posted" } } },
    },
    ROUNDTABLE_CIDS,
  );
  refuses(problems, 'collections.topics.sealed names "posted"');
});

test("refuses selfDelete and sealed naming the same status", () => {
  // A flat contradiction the rules settle by refusing, so the form promises a
  // withdrawal it can never perform.
  const problems = problemsFor(
    {
      collections: { topics: { statusField: "status", transitions: { initial: ["open"], open: ["closed"] }, sealed: ["closed"] }, messages: {} },
      public: {
        submit: {
          topics: { auth: "verifiedEmail", createFields: ["title", "status"], emailField: "who", initialStatus: "open", selfDelete: ["closed"] },
        },
      },
    },
    ROUNDTABLE_CIDS,
  );
  refuses(problems, 'both name "closed"');
});

/** A magazine: one collection of articles, and a view declaring which field of one is which.
 *
 *  Its schema names a `readCount` nobody maps, so the TYPE half can be provoked without inventing
 *  a second fixture — and `summary` is optional in the declaration and present here, so dropping
 *  it from the schema is a real refusal rather than an absent key. */
const magazineSchemas = [
  schemaWithFields("articles", {
    slug: { type: "string" },
    title: { type: "string" },
    lede: { type: "text" },
    prose: { type: "markdown" },
    status: { type: "string" },
    readCount: { type: "number" },
  }),
];

/** Which field of an article is which — the only part of the declaration these tests vary.
 *
 *  A TYPED parameter rather than a mutation of an untyped draft, and not only for tidiness: this
 *  repository holds `test/tsconfig.json` to a type-coverage floor, and reaching into a
 *  `Record<string, unknown>` through a cast to change one key spends that budget for nothing. */
interface ArticleMap {
  title: string;
  body: string;
  summary?: string;
}

const magazineDraft = (article: ArticleMap): Record<string, unknown> => ({
  collections: { articles: { statusField: "status", transitions: { initial: ["published"] } } },
  public: {
    enabled: true,
    read: ["articles"],
    submit: {
      articles: {
        auth: "verifiedEmail",
        idFrom: "slug",
        idField: "slug",
        audience: "participant",
        createFields: ["slug", "title", "lede", "prose", "status"],
        initialStatus: "published",
      },
    },
  },
  views: [{ id: "public", audience: "public", type: "article", collections: ["articles"], article }],
});

/** The magazine's problems, with the field mapping the caller wants to try. Sound by default, so a
 *  test names ONLY the thing it is provoking. */
const magazine = (article: Partial<ArticleMap> = {}) =>
  schemaRefProblems(app(magazineDraft({ title: "title", body: "prose", summary: "lede", ...article })), magazineSchemas as never);

// --- an article view's field mapping, against the schema that holds the articles ---------------
//
// Codex found this on #51. Every way of getting it wrong is QUIET: the runtime reads a key that is
// not there, gets undefined, and draws something rather than failing.

test("refuses an article title the schema does not declare", () => {
  refuses(magazine({ title: "headline" }), "does not declare");
});

test("refuses an article body the schema does not declare", () => {
  refuses(magazine({ body: "text" }), "renders EMPTY");
});

test("refuses a summary the schema does not declare, though the page would still draw", () => {
  // The mildest of the three and still a refusal: the index falls back to the article's opening,
  // so the author's declaration does nothing and nothing anywhere says so.
  refuses(magazine({ summary: "excerpt" }), "does nothing");
});

test("refuses a title that is not text — a number is read as a string that is never there", () => {
  refuses(magazine({ title: "readCount" }), "number field");
});

test("accepts a markdown body, which is what an article body ought to be", () => {
  // The positive half. A check that refused every type would satisfy all four tests above.
  assert.deepEqual(magazine(), []);
});

/** A magazine's SUBMIT declaration, on its own — the collection half of `magazineDraft` is not
 *  what these vary, and `publishProblems` is the gate that reads them. */
const articles = (edit: (submit: Record<string, unknown>) => void = () => {}) => {
  const submit: Record<string, unknown> = {
    auth: "verifiedEmail",
    idFrom: "slug",
    idField: "slug",
    emailField: "authorEmail",
    stampField: "publishedAt",
    createFields: ["slug", "title", "prose", "authorEmail", "uid", "publishedAt", "status"],
    initialStatus: "published",
  };
  edit(submit);
  return publishProblems(
    app({
      // `submitOnly` because the declaration binds each record to its submitter (`emailField`), and
      // this repository already refuses that pair without it — a record created any other way would
      // carry that meaning without having earned it. Worth knowing for a magazine: an app that
      // stamps articles with their author's address is one the DESK cannot enter an article into.
      collections: { articles: { submitOnly: true, statusField: "status", transitions: { initial: ["published"] } } },
      public: { enabled: true, read: ["articles"], submit: { articles: submit } },
    }),
    [{ cid: "articles", primaryKey: "id" }],
    OWNER,
  );
};

// --- a slug taken from a field the HOST fills in -----------------------------------------------
//
// Codex found this on #51. Each one publishes cleanly and then refuses every submission, in a way
// that reads like a rules problem rather than a declaration one.

test("refuses a slug field that is also the email field", () => {
  // An address always contains '@', which the slug grammar refuses — so the create fails on a
  // value the visitor never typed and cannot correct.
  refuses(
    articles((draft) => {
      draft.idField = "authorEmail";
      draft.emailField = "authorEmail";
    }),
    "which a URL name may not",
  );
});

test("refuses a slug field that is also the stamp field", () => {
  // Not a string at all: the rules pin it to the server's clock, so no id can be built from it.
  refuses(
    articles((draft) => {
      draft.idField = "publishedAt";
      draft.stampField = "publishedAt";
    }),
    "timestamp rather than a string",
  );
});

test("refuses a slug field that is also the uid field", () => {
  refuses(
    articles((draft) => {
      draft.idField = "uid";
      draft.uidField = "uid";
    }),
    'idFrom "auth.uid" is for',
  );
});

test("refuses a slug field that is also the status field, when a status is filled in", () => {
  // The worse of the two shapes: EVERY article would be named after the initial status, so the
  // first create takes `articles/published` and every one after it is a write to a document that
  // exists. The app works exactly once, and nothing about that reads as a declaration problem.
  refuses(
    articles((draft) => {
      draft.idField = "status";
    }),
    "would work exactly once",
  );
});

test("refuses a slug field that is also the status field, when nothing fills it", () => {
  // The other shape. With no `initialStatus` nothing writes the field at all, so every submission
  // is refused for a missing id — naming a box the form never showed.
  refuses(
    articles((draft) => {
      draft.idField = "status";
      delete draft.initialStatus;
    }),
    "nothing fills it at all",
  );
});

test("accepts a slug field of its own, beside the fields the host fills", () => {
  // The positive half: an app may bind a record to its submitter and stamp it AND have a URL name,
  // so long as the name is a field of its own. A check that refused the combination outright would
  // satisfy the three tests above.
  assert.deepEqual(articles(), []);
});

// --- a self-write with nothing saying whose the row is -----------------------------------------
//
// From the architecture review. `selfUpdate`, `selfTransitions` and `selfDelete` all reach the
// rules through `ownRow`, which recognises four bindings and no others. Declared without one, the
// app publishes cleanly, the projection advertises the control, `describe` reports the fields —
// and every attempt is refused by the rules with the one sentence they have.

/** A magazine-shaped declaration on a collection this gate knows about: the id is spent on the
 *  URL name, so identity has nowhere to live but a field. */
const authored = (submit: Record<string, unknown>) => ({
  collections: { bookings: { submitOnly: true, statusField: "status", transitions: { initial: ["published"] } } },
  public: {
    submit: {
      bookings: { auth: "verifiedEmail", idFrom: "slug", idField: "slug", initialStatus: "published", selfUpdate: { published: ["title"] }, ...submit },
    },
  },
});

test("refuses a self-write when nothing says which row is the submitter's", () => {
  refuses(problemsFor(authored({ createFields: ["slug", "title", "status"] })), "nothing that says which row is theirs");
});

test('names audience "participant" as the trap it is', () => {
  // It reads like ownership and `bindsSubmitterIdentity` even counts it — but the two are different
  // questions. Audience decides who may CREATE a row; ownRow asks whose a row is. A roster of
  // twenty contributors satisfies the first and tells the rules nothing about the second.
  refuses(problemsFor(authored({ audience: "participant", createFields: ["slug", "title", "status"] })), 'audience "participant" is not enough');
});

test("accepts a self-write bound by an address, and by a uid", () => {
  // The positive half, and both shapes: a magazine that stamps its author's address, and a board
  // that must not publish one. A check that refused every declaration would satisfy both tests
  // above.
  assert.deepEqual(problemsFor(authored({ emailField: "authorEmail", createFields: ["slug", "title", "status", "authorEmail"] })), []);
  assert.deepEqual(problemsFor(authored({ uidField: "authorUid", createFields: ["slug", "title", "status", "authorUid"] })), []);
});
