// What publish REFUSES, and why the refusal lives here rather than in a linter.
//
// A linter runs on the author's machine, when the author remembers to run it.
// Publish is the only gate every published byte passes through, so the
// guarantees are put here — the same argument the rules make for themselves
// against `require` in an action ("a linter is not a substitute for a rule").
//
// Two kinds of refusal, and the difference matters when reading this file:
//
//   SECURITY invariants — the declaration is internally consistent and the
//   rules will happily enforce it, but what it permits is not what the author
//   meant. `submitOnly` is the archetype: without it the rules do exactly as
//   told, and the owner can fabricate records in a collection whose entire
//   meaning is "the submitter said this".
//
//   FAIL-CLOSED traps — the rules will refuse EVERY write the declaration was
//   written to allow, and refuse it silently. `initialStatus` without a
//   `statusField` is not a weaker app, it is an app where nobody can submit
//   and nothing says why. These are worth as much as the security ones,
//   because a permission denial carries no explanation to the person hitting
//   it, and the author is not the person hitting it.
//
// Every check returns a LINE the author can act on, and every check has a test
// for the refusal AND a test for the neighbouring declaration that must still
// pass. A refusal test on its own is satisfied by a function that refuses
// everything, which is the one bug this file could have that would look like
// safety.

import type { CollectionFieldSpec, CollectionSchema } from "@mulmoclaude/core/collection";
import { isSafeCustomViewPath } from "@mulmoclaude/core/collection/server";
import { normalizeViews, participantScope, type NormalizedView } from "./appViews.js";
import { APP_PROTOCOL, protocolOf, protocolWithin } from "./appProtocol.js";
import type { AuthoredApp, AuthoredCollectionConfig, AuthoredSubmit } from "./publishManifest.js";

/** What publish knows about a shared collection in this repository, as far as
 *  these checks are concerned: its cid and the schema key its records are
 *  identified by. The whole schema is deliberately not threaded in — these
 *  checks are about the DECLARATION, and the primary key is the one part of
 *  the schema the declaration can contradict. */
export interface PublishableCollection {
  cid: string;
  primaryKey: string;
}

/** Does this submit declaration bind a record to the submitter's identity?
 *
 *  The condition for requiring `submitOnly`, and deliberately NOT "declares an
 *  `audience`": `audience` appears only in the rules' public-create branch, so
 *  an owner or editor never meets it and can add records freely. `immutable`
 *  is the wrong condition too — a survey's responses are not immutable and
 *  can be padded exactly the same way.
 *
 *  What these four have in common is that each one makes the record MEAN "the
 *  person who submitted it said this": a per-uid id, a per-uid+field id, a
 *  row stamped with the submitter's verified address, or a submission
 *  restricted to a named participant. A record created through the writer
 *  branch carries the same shape and none of that meaning. */
export function bindsSubmitterIdentity(submit: AuthoredSubmit): boolean {
  return submit.idFrom === "auth.uid" || submit.idFrom === "auth.uid+field" || submit.emailField !== undefined || submit.audience === "participant";
}

/** The fields a rule actually CHECKS the value of, for one collection.
 *
 *  `keyFields` pins a value against a declared set, `gateOn.match` pins it
 *  against the session's current question, and the status field is pinned by
 *  the transition machine. An aggregation grouped by anything else is grouped
 *  by a field any submitter may write anything into — so the published
 *  aggregate is whatever the noisiest respondent decided it should be. */
function checkedFields(collection: AuthoredCollectionConfig | undefined, submit: AuthoredSubmit | undefined): Set<string> {
  const fields = new Set<string>();
  for (const keyField of submit?.validate?.keyFields ?? []) fields.add(keyField.field);
  if (submit?.gateOn) fields.add(submit.gateOn.match);
  if (collection?.statusField) fields.add(collection.statusField);
  return fields;
}

/** INVARIANT 1 — a submission bound to its submitter needs `submitOnly`. */
function submitOnlyProblems(app: AuthoredApp): string[] {
  const problems: string[] = [];
  for (const [cid, submit] of Object.entries(app.public?.submit ?? {})) {
    if (!bindsSubmitterIdentity(submit)) continue;
    if (app.collections?.[cid]?.submitOnly === true) continue;
    problems.push(
      `collections.${cid}.submitOnly must be true: public.submit.${cid} binds each record to its submitter ` +
        `(${identityBindings(submit).join(", ")}), so a record created any other way would carry that meaning without having earned it. ` +
        `Without submitOnly the rules let an owner or editor write rows directly into ${cid}.`,
    );
  }
  return problems;
}

function identityBindings(submit: AuthoredSubmit): string[] {
  const bindings: string[] = [];
  if (submit.idFrom === "auth.uid" || submit.idFrom === "auth.uid+field") bindings.push(`idFrom: "${submit.idFrom}"`);
  if (submit.emailField !== undefined) bindings.push(`emailField: "${submit.emailField}"`);
  if (submit.audience === "participant") bindings.push(`audience: "participant"`);
  return bindings;
}

/** INVARIANT 2 — every aggregation key is a field some rule checks. */
function aggregateProblems(app: AuthoredApp): string[] {
  const problems: string[] = [];
  for (const [cid, collection] of Object.entries(app.collections ?? {})) {
    const keys = collection.aggregate?.by;
    if (!keys) continue;
    const checked = checkedFields(collection, app.public?.submit?.[cid]);
    const loose = keys.filter((field) => !checked.has(field));
    const spelled = loose.map((field) => `'${field}'`).join(", ");
    if (loose.length > 0) {
      problems.push(
        `collections.${cid}.aggregate.by names ${spelled}, which no rule checks the value of. ` +
          `An aggregation key must appear in public.submit.${cid}.validate.keyFields, in gateOn.match, or be the statusField — ` +
          `otherwise a submitter chooses their own bucket and the published aggregate is not a count of anything.`,
      );
    }
  }
  return problems;
}

/** INVARIANT 3 — `none` may not be published, and `anonymous` may not pretend to
 *  know who anybody is.
 *
 *  This used to refuse everything but `verifiedEmail`. What moved it is the
 *  shape that made the restriction visible: a poll in front of a live audience,
 *  where a Google sign-in between the question and the answer loses most of the
 *  room. `anonymous` is what that shape wants — the browser opens a session by
 *  itself, no screen, and the uid it gets is real enough for the rules to build
 *  `uid + "_" + questionId` out of, which is what makes one-vote-per-question
 *  ENFORCED rather than asked for nicely.
 *
 *  `none` stays refused, and not as a leftover: with nobody signed in there is
 *  no uid, so `idFrom` can only be `auto`, and "one per person" has nothing to
 *  hang on. The button just works again. An app that wants that has said
 *  something different from an app that forgot to think about it, and publish
 *  cannot tell them apart — so it refuses the one that is nearly always the
 *  second.
 *
 *  The guards below are the other half. A session with no account behind it
 *  carries no address, so anything reading one off the record is reading a
 *  string the submitter typed, in a place where the shape of the declaration
 *  says otherwise. Both of these would publish and then behave wrongly rather
 *  than fail, which is the class of thing this file exists for.
 *
 *  They are checked for `none` TOO, refused though it already is: `none` has
 *  no identity either, so an author who fixes the auth mode alone meets the
 *  next refusal on the next publish. All of them in one pass is the rule this
 *  whole file is written to (`publishProblems` returns a list). */
function authProblems(app: AuthoredApp): string[] {
  return Object.entries(app.public?.submit ?? {}).flatMap(([cid, submit]) => {
    const problems: string[] = [];
    if (submit.auth === "none") {
      problems.push(
        `public.submit.${cid}.auth is "none": nobody is signed in, so there is no uid, so \`idFrom\` can only be "auto" and ` +
          `nothing stops the same person submitting again — and again. Use "anonymous": the visitor's browser opens a session by itself, ` +
          `with no sign-in screen, and it gives the rules a uid to bind the record to.`,
      );
    }
    // NO EARLY RETURN, and that is the point: "none" carries no identity either,
    // so every guard below holds for it word for word. Returning here made the
    // author fix the auth mode, publish again, and only then be told about the
    // emailField that was never going to work — one refusal per attempt, over a
    // declaration that was wrong in three places at once. Publish is a manual
    // step; each round trip is a person waiting.
    if (submit.auth !== "anonymous" && submit.auth !== "none") return problems;

    if (submit.emailField !== undefined) {
      problems.push(
        `public.submit.${cid} is "${submit.auth}" and names emailField '${submit.emailField}': that session carries no address. ` +
          `The rules pin that field to the signed-in address only under "verifiedEmail", so here it would hold whatever was submitted — ` +
          `an unverified string sitting in the field the app treats as identity. Drop the emailField, or use "verifiedEmail".`,
      );
    }
    if (submit.audience === "participant") {
      problems.push(
        `public.submit.${cid} is "${submit.auth}" and declares audience "participant": the roster is a list of addresses, and a visitor ` +
          `signed in this way has none, so every submission would be refused by the rules. A participant-only collection is a "verifiedEmail" one.`,
      );
    }
    if (app.collections?.[cid]?.mail !== undefined) {
      problems.push(
        `collections.${cid} queues mail and public.submit.${cid} is "${submit.auth}": the recipient is read off the record (mail.toField), ` +
          `and a submitter with no account behind them chooses it — the app would send mail to any address anybody types. ` +
          `Mail belongs to a "verifiedEmail" collection.`,
      );
    }
    return problems;
  });
}

/** INVARIANT 5 — a mail transition's origins and destination must be disjoint.
 *
 *  Overlap means the same write can satisfy the same template twice over, and
 *  the deterministic mail id is the only other thing stopping a duplicate
 *  send. The rules also require the status to have CHANGED, so an overlapping
 *  declaration is not merely redundant: `from` containing `to` is a transition
 *  that can never fire, which is a mail nobody ever receives. */
function mailProblems(app: AuthoredApp): string[] {
  return Object.entries(app.collections ?? {}).flatMap(([cid, collection]) => collectionMailProblems(cid, collection));
}

function collectionMailProblems(cid: string, collection: AuthoredCollectionConfig): string[] {
  const { mail } = collection;
  if (!mail) return [];
  const problems: string[] = [];
  if (!collection.statusField) {
    problems.push(
      `collections.${cid}.mail needs collections.${cid}.statusField: the rules read the status before and after the write to decide the mail is warranted.`,
    );
  }
  for (const [template, transition] of Object.entries(mail.on)) {
    problems.push(...templateMailProblems(cid, collection, template, transition));
  }
  return problems;
}

function templateMailProblems(cid: string, collection: AuthoredCollectionConfig, template: string, transition: { from: string[]; to: string }): string[] {
  const problems: string[] = [];
  if (transition.from.includes(transition.to)) {
    problems.push(
      `collections.${cid}.mail.on.${template} lists "${transition.to}" in both \`from\` and \`to\`. ` +
        "The rules require the status to CHANGE in the same write, so this template can never send.",
    );
  }
  const allowed = collection.transitions;
  if (allowed) {
    const unreachable = transition.from.filter((from) => !(allowed[from] ?? []).includes(transition.to));
    const spelled = unreachable.map((from) => `'${from}' -> '${transition.to}'`).join(", ");
    if (unreachable.length > 0) {
      problems.push(
        `collections.${cid}.mail.on.${template} sends on ${spelled}, ` +
          `which collections.${cid}.transitions does not allow. The record write is refused first, so the mail never fires.`,
      );
    }
  }
  return problems;
}

/** INVARIANTS 6 and 7 — the window is a real interval, and `keyFields` fits
 *  the unrolled check in the rules. */
function submitShapeProblems(app: AuthoredApp): string[] {
  return Object.entries(app.public?.submit ?? {}).flatMap(([cid, submit]) => [...windowProblems(cid, submit), ...keyFieldCountProblems(cid, submit)]);
}

function windowProblems(cid: string, submit: AuthoredSubmit): string[] {
  const { window } = submit;
  if (window?.from === undefined || window.until === undefined) return [];
  if (Date.parse(window.until) > Date.parse(window.from)) return [];
  return [`public.submit.${cid}.window closes at or before it opens (${window.from} -> ${window.until}): nothing could ever be submitted.`];
}

function keyFieldCountProblems(cid: string, submit: AuthoredSubmit): string[] {
  const keyFields = submit.validate?.keyFields ?? [];
  if (keyFields.length <= 2) return [];
  return [
    `public.submit.${cid}.validate.keyFields declares ${keyFields.length}; the rules check at most 2. ` +
      "Rules have no iteration, so the check is unrolled — a third would be published and never enforced.",
  ];
}

/** The fail-closed traps: declarations the rules read together, where the
 *  missing half denies every write instead of loosening one. */
function coherenceProblems(app: AuthoredApp): string[] {
  const fromSubmits = Object.entries(app.public?.submit ?? {}).flatMap(([cid, submit]) => submitCoherenceProblems(app, cid, submit));
  const fromCollections = Object.entries(app.collections ?? {}).flatMap(([cid, collection]) => gateCoherenceProblems(cid, collection));
  return [...fromSubmits, ...fromCollections];
}

/** `initialStatus` is read together with the collection's `statusField` and
 *  with `createFields`; miss either and every submission is refused. */
function statusCoherenceProblems(cid: string, submit: AuthoredSubmit, collection: AuthoredCollectionConfig | undefined): string[] {
  if (submit.initialStatus === undefined) return [];
  if (!collection?.statusField) {
    return [
      `public.submit.${cid}.initialStatus needs collections.${cid}.statusField: the rules look the status up by that name, and refuse every submission without it.`,
    ];
  }
  if (new Set(submit.createFields).has(collection.statusField)) return [];
  return [
    `public.submit.${cid}.createFields must include "${collection.statusField}": a submission may carry ONLY the createFields, ` +
      "and the rules also require the status field to be present and equal to initialStatus. As written, every submission is refused.",
  ];
}

/** Every field a RULE reads off a submitted record, other than the status
 *  field (which `statusCoherenceProblems` words for itself).
 *
 *  `emailField` and `idField` belong here for exactly the reason `required`
 *  and `keyFields` do, and forgetting them was the same oversight twice: the
 *  rules read `request.resource.data[s.emailField]` and rebuild the document
 *  id from `s.idField`, while `hasOnly(createFields)` decides what a
 *  submission may carry at all. A field in one list and not the other is a
 *  contradiction the submitter cannot resolve — including it is refused,
 *  omitting it fails the check. */
function ruleReadFields(submit: AuthoredSubmit): { field: string; why: string }[] {
  const fields: { field: string; why: string }[] = [];
  if (submit.emailField !== undefined) {
    fields.push({ field: submit.emailField, why: `public.submit.<cid>.emailField — the rules compare it to the submitter's verified address` });
  }
  if ((submit.idFrom === "auth.uid+field" || submit.idFrom === "field") && submit.idField !== undefined) {
    fields.push({ field: submit.idField, why: `public.submit.<cid>.idField — the rules rebuild the document id from it` });
  }
  return fields;
}

/** A checked field a submission is not allowed to carry can never be
 *  satisfied: carrying it fails `hasOnly`, omitting it fails the check. */
function createFieldProblems(cid: string, submit: AuthoredSubmit): string[] {
  const createFields = new Set(submit.createFields);
  const ruleRead = ruleReadFields(submit)
    .filter((entry) => !createFields.has(entry.field))
    .map(
      (entry) =>
        `public.submit.${cid}.createFields must include "${entry.field}" (${entry.why.replace("<cid>", cid)}): ` +
        "a submission may carry only the createFields, so as written every submission is refused whether or not it carries the field.",
    );
  const required = (submit.validate?.required ?? [])
    .filter((field) => !createFields.has(field))
    .map(
      (field) =>
        `public.submit.${cid}.validate.required names "${field}", which is not in createFields: a submission may carry only the createFields, so the requirement can never be met.`,
    );
  const keyFields = (submit.validate?.keyFields ?? [])
    .filter((keyField) => !createFields.has(keyField.field))
    .map(
      (keyField) =>
        `public.submit.${cid}.validate.keyFields checks "${keyField.field}", which is not in createFields: a submission carrying it is refused, and one omitting it fails the check.`,
    );
  return [...ruleRead, ...required, ...keyFields];
}

function submitCoherenceProblems(app: AuthoredApp, cid: string, submit: AuthoredSubmit): string[] {
  const collection = app.collections?.[cid];
  const problems = [...statusCoherenceProblems(cid, submit, collection), ...createFieldProblems(cid, submit)];
  if (submit.idFrom === "auth.uid+field" && submit.idField === undefined) {
    problems.push(
      `public.submit.${cid}.idFrom is "auth.uid+field" but no idField is declared: the rules rebuild the document id from that field and refuse every create.`,
    );
  }
  problems.push(...fieldIdProblems(cid, submit));
  if ((submit.selfUpdate !== undefined || submit.selfTransitions !== undefined || submit.selfDelete !== undefined) && !collection?.statusField) {
    problems.push(
      `public.submit.${cid}.selfUpdate / selfTransitions / selfDelete are declared per CURRENT STATUS, but collections.${cid} declares no statusField: ` +
        "the rules read the current status first and refuse every self-edit without it.",
    );
  }
  problems.push(...selfDeleteProblems(cid, submit, collection));
  if (submit.audience === "participant" && Object.keys(app.members).length === 0) {
    problems.push(
      `public.submit.${cid}.audience is "participant" but the roster is empty: the rules resolve the submitter's role from members, so every submission is refused.`,
    );
  }
  return problems;
}

/** The transition table's word for "no record yet" — the left-hand side that is
 *  not a status any record holds. */
const INITIAL_KEY = "initial";

/** `selfDelete` names statuses, and a status nothing can reach grants nothing.
 *
 *  Worth refusing rather than leaving to the author to notice, because the
 *  declaration and its silence look identical from the outside: the page draws
 *  no withdraw button, the rules refuse the write, and the only symptom is a
 *  member ringing the desk about a slot they cannot give back. The same is
 *  true of the empty list, which reads as "yes, they may" and means the
 *  opposite.
 *
 *  Reachability is judged against the collection's own table, not against
 *  `selfTransitions`: a booking the desk approved is somewhere the submitter
 *  never moved it to, and withdrawing from THERE is a normal thing to allow.
 *
 *  REACHABLE IS THREE THINGS, and reading only the destinations refused the
 *  commonest declaration there is: `initialStatus: "pending"` with
 *  `transitions: { pending: ["approved"] }` puts every record in "pending" the
 *  moment it is written, and `selfDelete: ["pending"]` — withdraw the booking
 *  you just made — was called a status nothing ever reaches. So the status a
 *  submission STARTS in counts, and so does a status the table moves records
 *  OUT of: a key on the left-hand side is the author saying records are in it.
 *  `initial` is not one of those — it is the table's word for "no record yet",
 *  not a status any record holds.
 *
 *  Whether `initialStatus` is itself listed under `transitions.initial` is a
 *  different question, and this check does not ask it: refusing here would
 *  refuse apps that publish today over something no rule reads. */
function selfDeleteProblems(cid: string, submit: AuthoredSubmit, collection: AuthoredCollectionConfig | undefined): string[] {
  const states = submit.selfDelete;
  if (states === undefined) return [];
  if (states.length === 0) {
    return [`public.submit.${cid}.selfDelete is an empty list, which allows nothing. Name the statuses a submitter may withdraw from, or remove the key.`];
  }
  const transitions = collection?.transitions;
  if (transitions === undefined) return [];
  const reachable = new Set([
    ...(submit.initialStatus === undefined ? [] : [submit.initialStatus]),
    ...Object.values(transitions).flat(),
    ...Object.keys(transitions).filter((from) => from !== INITIAL_KEY),
  ]);
  const unreachable = states.filter((state) => !reachable.has(state));
  if (unreachable.length === 0) return [];
  return [
    `public.submit.${cid}.selfDelete names ${unreachable.map((state) => `"${state}"`).join(", ")}, ` +
      `which no record ever holds: it is neither public.submit.${cid}.initialStatus nor a status collections.${cid}.transitions names, ` +
      `so the declaration allows nothing.`,
  ];
}

/** `idFrom: "field"` makes the document id a CLAIM ABOUT ANOTHER RECORD, and
 *  the claim is only worth what is checked.
 *
 *  `idIn` is required rather than optional, and that is the whole point of
 *  refusing here: without it the id is any string a stranger likes, so the app
 *  quietly accepts bookings for slots that do not exist. Nothing downstream
 *  ever notices — the booking is real, its slot is not — which is exactly the
 *  kind of hole a gate is for and a rule cannot state.
 *
 *  `idIn` without the mode is refused for the opposite reason: the rules read
 *  it only in that branch, so an author who wrote it believes a check is
 *  running that is not. */
function fieldIdProblems(cid: string, submit: AuthoredSubmit): string[] {
  const problems: string[] = [];
  if (submit.idFrom === "field") {
    if (submit.idField === undefined) {
      problems.push(
        `public.submit.${cid}.idFrom is "field" but no idField is declared: the rules take the document id from that field and refuse every create.`,
      );
    }
    if (submit.idIn === undefined) {
      problems.push(
        `public.submit.${cid}.idFrom is "field" but no idIn is declared: the document id is then any string a submitter chooses, so the app accepts records ` +
          `pointing at things that do not exist. Name the collection the id must be found in — and, when only some of those records may be claimed, the state ` +
          `they must be in: "idIn": { "collection": "slots", "where": { "field": "state", "equals": "open" } }.`,
      );
    }
  } else if (submit.idIn !== undefined) {
    const mode = submit.idFrom === undefined ? "absent" : JSON.stringify(submit.idFrom);
    problems.push(
      `public.submit.${cid}.idIn is declared but idFrom is ${mode}: the rules read idIn only for ` +
        `idFrom "field", so as written nothing checks the referenced record and the declaration promises a check it does not perform.`,
    );
  }
  return problems;
}

/** Every `idIn` target, checked against the collections this repository has.
 *
 *  Separate from {@link fieldIdProblems} for the reason the file is split at
 *  all: that one reads the declaration alone, this one needs to know what
 *  exists. */
function idTargetProblems(app: AuthoredApp, collections: readonly PublishableCollection[]): string[] {
  const known = new Set(collections.map((collection) => collection.cid));
  const names = known.size > 0 ? [...known].sort().join(", ") : "(none)";
  return Object.entries(app.public?.submit ?? {}).flatMap(([cid, submit]) => idInTargetProblems(cid, submit, known, names));
}

/** Where a `field` id says its record must be found.
 *
 *  A typo passes every other check: the rules look the record up in a
 *  collection that does not exist, the lookup can never succeed, and every
 *  submission is refused with no explanation anywhere. A collection pointing
 *  at ITSELF is worse than a typo — on a create the document being written
 *  does not exist yet, so it is a declaration that can never accept anything. */
function idInTargetProblems(cid: string, submit: AuthoredSubmit, known: ReadonlySet<string>, names: string): string[] {
  const target = submit.idIn?.collection;
  if (target === undefined) return [];
  if (target === cid) {
    return [
      `public.submit.${cid}.idIn.collection names '${cid}' itself: a create writes a document that does not exist yet, so the record can never be found ` +
        "and every submission is refused. Name the collection of the thing being claimed (the slots, the seats, the assets).",
    ];
  }
  if (!known.has(target)) {
    return [
      `public.submit.${cid}.idIn.collection names '${target}', which is not a shared collection in this repository. The rules look the record up there, ` +
        `so nothing can ever be submitted. Shared collections here: ${names}.`,
    ];
  }
  return [];
}

/** A gated reveal reads its flag off the PARENT record, so the path to that parent is not
 *  optional decoration — without it the gate never opens. */
function gateCoherenceProblems(cid: string, collection: AuthoredCollectionConfig): string[] {
  if (collection.revealGated !== true) return [];
  if (collection.gatedFrom !== undefined && collection.revealBy !== undefined) return [];
  return [
    `collections.${cid}.revealGated needs both gatedFrom and revealBy: the flag is read off the PARENT record, and without the path the gate never opens.`,
  ];
}

/** The publisher must be able to write what they are about to write.
 *
 *  On a first publish the rules require the creator to name themselves owner,
 *  in the roster, under `'*'`. Getting this wrong produces a bare permission
 *  error from Firestore with nothing in it about rosters — worth one line
 *  here instead. */
function publisherProblems(app: AuthoredApp, publisherEmail: string): string[] {
  const roles = app.members[publisherEmail];
  if (roles?.["*"] === "owner") return [];
  return [
    `members must give you app-wide owner: add "${publisherEmail}": { "*": "owner" }. ` +
      `The rules require the publisher to hold that role (and to name themselves owner when the app is first created); otherwise the write is refused with no explanation.`,
  ];
}

/** Every cid the declaration mentions must be a collection that exists.
 *
 *  A typo'd cid is not an error anywhere else: the app document simply carries
 *  a configuration for a collection nobody publishes, and the collection the
 *  author meant is published with no configuration at all — i.e. with the
 *  status machine and the submit path silently absent. */
function unknownCidProblems(app: AuthoredApp, collections: readonly PublishableCollection[]): string[] {
  const known = new Set(collections.map((collection) => collection.cid));
  const mentions: [string, string[]][] = [
    ["collections", Object.keys(app.collections ?? {})],
    ["public.read", app.public?.read ?? []],
    ["public.submit", Object.keys(app.public?.submit ?? {})],
    ["participantRead", app.participantRead ?? []],
    // A member's per-collection keys are cids too, and a typo there is the
    // quietest of the lot: the member holds the role on a collection that does
    // not exist, and on the one they were meant to hold it on they fall back
    // to their `'*'` role — or, holding none, to nothing at all.
    ["members", [...new Set(Object.values(app.members).flatMap((roles) => Object.keys(roles)))].filter((key) => key !== "*")],
  ];
  return mentions.flatMap(([where, cids]) =>
    cids
      .filter((cid) => !known.has(cid))
      .map(
        (cid) =>
          `${where} names '${cid}', which is not a shared collection in this repository. ` +
          `Shared collections here: ${known.size > 0 ? [...known].sort().join(", ") : '(none - a schema needs storage.type "firestore")'}.`,
      ),
  );
}

/** Everything publish refuses, as lines the author can act on.
 *
 *  All of them, every time. Publish is a manual step with a human waiting on
 *  it; stopping at the first problem turns one review into five. */
/** An authored `protocol` this compiler cannot honour.
 *
 *  The declaration is a FLOOR, not a value to publish: the projection carries what this compiler
 *  emits, because that is the contract the documents actually keep. So the only thing to check is
 *  the direction that would produce a lie — an app written against a contract newer than this
 *  publisher implements. Compiled anyway, it would be published as documents that do not keep the
 *  promises the author relied on, under a version number a reader believes.
 *
 *  A version this build cannot read at all is refused for the same reason: nothing is known about
 *  what it asks for, and continuing would be a guess in the one direction that fails silently. */
function protocolProblems(app: AuthoredApp): string[] {
  if (app.protocol === undefined) return [];
  const stated = protocolOf(app.protocol);
  if (stated === null) {
    return [`\`protocol\` is "${app.protocol}", which is not a version (expected e.g. "${APP_PROTOCOL}").`];
  }
  const emitted = protocolOf(APP_PROTOCOL);
  if (emitted === null || protocolWithin(stated, emitted)) return [];
  return [
    `This app declares \`protocol: "${app.protocol}"\`, and this publisher writes ${APP_PROTOCOL}.`,
    "Nothing was written: publishing it would stamp a contract these documents do not keep, and the page that reads them would believe the stamp. Update @receptron/sharedapp (and the front-end that draws it) first.",
  ];
}

export function publishProblems(app: AuthoredApp, collections: readonly PublishableCollection[], publisherEmail: string): string[] {
  return [
    ...protocolProblems(app),
    ...unknownCidProblems(app, collections),
    ...publisherProblems(app, publisherEmail),
    ...submitOnlyProblems(app),
    ...aggregateProblems(app),
    ...authProblems(app),
    ...mailProblems(app),
    ...submitShapeProblems(app),
    ...coherenceProblems(app),
    ...primaryKeyProblems(app, collections),
    ...assigneeProblems(app),
    ...stampProblems(app),
    ...windowRefProblems(app, collections),
    ...idTargetProblems(app, collections),
    ...mirrorProblems(app, collections),
    ...viewProblems(app, collections),
  ];
}

/** A public submission must NOT be allowed to name its own primary key.
 *
 *  The rules constrain the DOCUMENT ID (`idFrom`) and cannot constrain the
 *  value of a field — nothing compares `request.resource.data[primaryKey]`
 *  with the path being written. So a submit path that accepts the primary key
 *  as a `createField` lets a submitter write at their one permitted document
 *  id while CLAIMING another record's identity, or a duplicate.
 *
 *  It is refused rather than tolerated because there is nothing for the field
 *  to do: `firestoreStore` takes a shared record's identity from the document
 *  id and overwrites the field on read, so a submitted value is either equal
 *  to the id (noise) or a lie (silently discarded). Publishing a form field
 *  whose value is thrown away is worse than not having it — the author will
 *  believe submitters choose their ids.
 *
 *  This is the second answer to the same question. The first was the reverse —
 *  REQUIRE the key, because a record without one was rejected by every reader
 *  — and it was right about the symptom and wrong about the cure: the identity
 *  belongs to the id the rules can pin, not to a field they cannot. */
function primaryKeyProblems(app: AuthoredApp, collections: readonly PublishableCollection[]): string[] {
  const primaryKeyOf = new Map(collections.map((collection) => [collection.cid, collection.primaryKey]));
  return Object.entries(app.public?.submit ?? {}).flatMap(([cid, submit]) => {
    const primaryKey = primaryKeyOf.get(cid);
    if (primaryKey === undefined || !submit.createFields.includes(primaryKey)) return [];
    return [
      `public.submit.${cid}.createFields must NOT include "${primaryKey}", the schema's primaryKey: the rules can pin the document id but not the value of a field, ` +
        "so a submitter could write at their own id while claiming another record's. A shared record's identity is its document id — the store fills the field from it, " +
        "and a submitted value is either the same thing or a lie that is thrown away.",
    ];
  });
}

/** `assignee` without the field that says which rows are theirs.
 *
 *  A FAIL-CLOSED trap of the worst kind, because it fails closed for one
 *  person and nobody else: the rules ask `collections[cid].assigneeField` for
 *  the field to compare, find nothing, and refuse every write that member
 *  makes. The app works for the owner who set it up, and the member it was set
 *  up for is told only "permission denied".
 *
 *  `'*': "assignee"` is refused outright rather than checked against every
 *  collection. The role means "the rows assigned to you", and what counts as
 *  assigned is per collection — an app-wide one would need the same field name
 *  to be right everywhere, and where it is missing it silently means "no
 *  access to this collection" rather than "no scoping here".
 */
function assigneeProblems(app: AuthoredApp): string[] {
  return Object.entries(app.members).flatMap(([email, roles]) =>
    Object.entries(roles).flatMap(([cid, role]) => {
      if (role !== "assignee") return [];
      if (cid === "*") {
        return [
          `members["${email}"] holds "assignee" under "*", and the role cannot be app-wide: which rows are yours is declared per collection ` +
            '(`collections.<cid>.assigneeField`). Name the collections instead — { "bookings": "assignee" }.',
        ];
      }
      if (app.collections?.[cid]?.assigneeField !== undefined) return [];
      return [
        `members["${email}"] holds "assignee" on '${cid}', but collections.${cid}.assigneeField does not say which field names the member a row belongs to. ` +
          `Add it (assigneeField: "<a field holding an address>"), or give a role that is not row-scoped. Without it the rules have nothing to compare and refuse ` +
          "every write that member makes, while the app keeps working for everybody else.",
      ];
    }),
  );
}

/** A server-stamped field the submitter cannot write, or can rewrite later.
 *
 *  Both failures are silent in opposite directions. Left out of
 *  `createFields`, the rules refuse every submission (`hasOnly(createFields)`
 *  rejects the key the stamp check requires) — an app nobody can use. Left IN
 *  a `selfUpdate` list, the field the queue is ordered by becomes editable by
 *  the person standing in the queue. */
function stampProblems(app: AuthoredApp): string[] {
  return Object.entries(app.public?.submit ?? {}).flatMap(([cid, submit]) => {
    const stamp = submit.stampField;
    if (stamp === undefined) return [];
    const problems: string[] = [];
    if (!submit.createFields.includes(stamp)) {
      problems.push(
        `public.submit.${cid}.stampField names '${stamp}', which is not in createFields. The rules require the record to CARRY the server time in that field, ` +
          "and refuse any key outside createFields — so every submission is denied. Add it to createFields; the page fills it in, not the person.",
      );
    }
    for (const [status, fields] of Object.entries(submit.selfUpdate ?? {})) {
      if (!fields.includes(stamp)) continue;
      problems.push(
        `public.submit.${cid}.selfUpdate.${status} lets the submitter write '${stamp}', which is the field stampField pins to the server clock. ` +
          "Whatever that field orders — a first-come queue, an audit trail — could then be rewritten by the person it ranks. Remove it from selfUpdate.",
      );
    }
    return problems;
  });
}

/** A per-record window bound pointing at a collection or a field the submitter
 *  never writes.
 *
 *  `fromField` makes the rules read another record, and every part of that
 *  read is fail-closed: an unknown collection, or a `ref` the submission does
 *  not carry, means the bound can never be satisfied and the form is shut for
 *  good. */
function windowRefProblems(app: AuthoredApp, collections: readonly PublishableCollection[]): string[] {
  const known = new Set(collections.map((collection) => collection.cid));
  return Object.entries(app.public?.submit ?? {}).flatMap(([cid, submit]) => [
    ...windowBoundProblems(cid, submit, known, "fromField", submit.window?.fromField, "opening"),
    ...windowBoundProblems(cid, submit, known, "untilField", submit.window?.untilField, "closing"),
  ]);
}

/** Both bounds, checked identically. `untilField` arrived with the booking
 *  desk and reads exactly like its twin, so a check that knew only about
 *  `fromField` would let the closing half through unchecked — and a closing
 *  bound that names nothing does not leave the door ajar, it refuses every
 *  submission with no explanation. */
function windowBoundProblems(
  cid: string,
  submit: AuthoredSubmit,
  known: ReadonlySet<string>,
  key: string,
  ref: { ref: string; collection: string; field: string } | undefined,
  which: string,
): string[] {
  if (ref === undefined) return [];
  const problems: string[] = [];
  if (!known.has(ref.collection)) {
    problems.push(
      `public.submit.${cid}.window.${key}.collection names '${ref.collection}', which is not a shared collection in this repository. ` +
        `The rules read the ${which} time off a record there, so nothing can ever be submitted. Shared collections here: ${known.size > 0 ? [...known].sort().join(", ") : "(none)"}.`,
    );
  }
  if (!submit.createFields.includes(ref.ref)) {
    problems.push(
      `public.submit.${cid}.window.${key}.ref names '${ref.ref}', which is not in createFields. The rules take the target record's id from that field ON THE ` +
        "SUBMISSION — if the submitter never writes it, there is nothing to look up and every submission is refused.",
    );
  }
  return problems;
}

/** The two halves of a mirror, checked as the pair they only work as.
 *
 *  `mirror` on the submission and `mirrorOf` on the projection are separate
 *  keys in separate places, and each is inert without the other: a booking
 *  whose slot declares no `mirrorOf` can never be created (the rules demand a
 *  paired write that the projection's own rule will refuse), and a projection
 *  whose authority declares no `mirror` drifts unbounded because nothing makes
 *  the two move together. Both failures are silent, and one of them —
 *  advertising a slot somebody already holds — is the exact thing the mirror
 *  exists to prevent.
 *
 *  Also refuses a collection mirroring ITSELF, which reads as a typo and
 *  behaves as an unwritable collection: every create would have to prove its
 *  own document is simultaneously taken and open. */
function mirrorProblems(app: AuthoredApp, collections: readonly PublishableCollection[]): string[] {
  const known = new Set(collections.map((collection) => collection.cid));
  const names = known.size > 0 ? [...known].sort().join(", ") : "(none)";
  return [
    ...Object.entries(app.public?.submit ?? {}).flatMap(([cid, submit]) => mirrorClaimProblems(app, cid, submit, known, names)),
    ...Object.entries(app.collections ?? {}).flatMap(([cid, collection]) => mirrorOfProblems(app, cid, collection, known, names)),
  ];
}

/** The submission side: `public.submit[cid].mirror`. */
function mirrorClaimProblems(app: AuthoredApp, cid: string, submit: AuthoredSubmit, known: ReadonlySet<string>, names: string): string[] {
  const { mirror } = submit;
  if (mirror === undefined) return [];
  if (mirror === cid) {
    return [`public.submit.${cid}.mirror names its own collection: the projection is a SEPARATE record, and as written no create can satisfy the rules.`];
  }
  if (!known.has(mirror)) {
    return [
      `public.submit.${cid}.mirror names '${mirror}', which is not a shared collection in this repository. ` +
        `The rules require the projection to move in the same write, so every submission is refused. Shared collections here: ${names}.`,
    ];
  }
  if (app.collections?.[mirror]?.mirrorOf !== cid) {
    return [
      `public.submit.${cid}.mirror names '${mirror}', but collections.${mirror} does not declare mirrorOf: "${cid}". ` +
        "The two halves only work as a pair — the submission side demands the projection move with it, and the projection side is what allows that move — " +
        "so as written every submission is refused.",
    ];
  }
  return [];
}

/** The projection side: `collections[cid].mirrorOf`. */
function mirrorOfProblems(app: AuthoredApp, cid: string, collection: AuthoredCollectionConfig, known: ReadonlySet<string>, names: string): string[] {
  const authority = collection.mirrorOf;
  if (authority === undefined) return [];
  if (!known.has(authority)) {
    return [
      `collections.${cid}.mirrorOf names '${authority}', which is not a shared collection in this repository. ` +
        `Nothing can then be true of it, so the projection's state may never be written. Shared collections here: ${names}.`,
    ];
  }
  if (app.public?.submit?.[authority]?.mirror !== cid) {
    return [
      `collections.${cid}.mirrorOf names '${authority}', but public.submit.${authority} does not declare mirror: "${cid}". ` +
        "Only the pair keeps the projection honest: without the other half a record can be created without moving this one, and the public page goes on " +
        "offering something that is already taken.",
    ];
  }
  return [];
}

/** What each view is handed, and whether its audience can actually read it.
 *
 *  Declared, never inferred — a view whose datasets were guessed from
 *  `public.read` renders perfectly and draws an empty grid, with nothing in
 *  the page, the rules or the log to say why.
 *
 *  The reachability check below is that same failure, once per audience. A
 *  `public` view naming a collection outside `public.read` draws nothing; a
 *  `participant` view naming one the participant reaches by neither
 *  `participantRead` nor their own row is worse, because an unscoped list on
 *  an own-row collection is DENIED rather than narrowed — the page does not
 *  render less, it fails.
 *
 *  There is deliberately no such check for `member`. Every read a role opens
 *  is unscoped, and WHICH role a given member holds is not a property of the
 *  declaration: a stylist scoped to `bookings` and an owner read the same
 *  projection. That one is settled at the entrance, by trying the read. */
/** The path, for one view. The SAME validator the host's own custom views use,
 *  rather than a second opinion about what a safe view path is.
 *
 *  Two ad-hoc attempts were wrong here in the same afternoon: a prefix-and-
 *  suffix test let `views/../../secrets.html` through, and `views/[^/]+\.html`
 *  still let `views/..\..\secrets.html` through, because a backslash is not a
 *  slash on this side of the check and IS a separator on Windows. This one
 *  rejects `..`, backslashes, leading slashes and anything outside
 *  `[A-Za-z0-9._-]` per segment.
 *
 *  It matters more here than for a host view: the host reads this path to
 *  decide which file to copy onto a document other people read — for a public
 *  view, a document whose rule is `allow read: if true`, so the blast radius of
 *  a bad path is the world rather than the author's own iframe. Nested paths
 *  ARE allowed by the shared validator; the extra `views/<one name>.html` shape
 *  is this publisher's own narrowing, kept because there is no reason for a
 *  published view to live in a subdirectory. */
function viewPathProblems(view: NormalizedView): string[] {
  if (isSafeCustomViewPath(view.path) && view.path.split("/").length === 2) return [];
  return [
    `${view.where}.path is '${view.path}': a published view is exactly one HTML file directly inside the collection's own views/ directory ` +
      "(e.g. views/booking.html) — no sub-directories, and no segments that climb out of it. The host reads this as a file to publish.",
  ];
}

/** One dataset, for one view: does it exist here, and can the audience it is
 *  handed to actually read it? */
function viewCollectionProblems(app: AuthoredApp, view: NormalizedView, cid: string, known: ReadonlySet<string>): string[] {
  if (!known.has(cid)) {
    return [
      `${view.where}.collections names '${cid}', which is not a shared collection in this repository. ` +
        `Shared collections here: ${known.size > 0 ? [...known].sort().join(", ") : "(none)"}.`,
    ];
  }
  if (view.audience === "public" && !(app.public?.read ?? []).includes(cid)) {
    return [
      `${view.where}.collections names '${cid}', which is not in public.read: the page reads these with the VISITOR's permissions, so the rules refuse the ` +
        "read and the view draws an empty page. Nothing errors — this is the failure that looks like a working view with no data.",
    ];
  }
  // The participant check is HERE now. It used to sit apart, with the promoted-pair checks, because
  // publish promoted `participantRead` from what deploy had staged rather than from the manifest —
  // so the manifest half of this file could not see what would actually land. There is no staging
  // any more (mulmoterminal `plans/feat-shared-app-no-staging.md`): what publish writes is this
  // declaration, so the question is answerable right here.
  if (view.audience === "participant" && participantScope(app, cid, app.participantRead ?? []) === null) {
    return [
      `${view.where}.collections names '${cid}', which a participant cannot read: it is not in participantRead, and public.submit.${cid} declares neither ` +
        'an emailField nor idFrom "auth.uid", so there is no row the rules would call theirs. The page would be refused the read, not handed fewer records.',
    ];
  }
  return [];
}

/** Which of a view's datasets it may WATCH, and the fan-out that is refused.
 *
 *  `live` is a subset of `collections`, so the first check is arithmetic: a
 *  page cannot subscribe to a dataset it was never handed, and the symptom
 *  would be a subscription that never fires rather than an error.
 *
 *  The second is the point of the key. A subscription is a read PER DOCUMENT
 *  PER CHANGE, so a public page watching a collection the public also writes
 *  into is N readers × N writers: 1000 visitors watching 1000 votes is
 *  1,000,000 reads, and every further vote is another 1000. Nobody meets that
 *  bill on the page where it is incurred — the author does, later, and the
 *  first they hear of it is a quota.
 *
 *  The threat is an author declaring it in GOOD FAITH ("show the tally as it
 *  moves"), which is why the refusal names the alternative rather than only
 *  the danger: the member page `/m/{slug}` on the display screen, whose reader
 *  count the roster bounds.
 *
 *  THE MIRROR IS THE SAME FAN-OUT with one hop. A `mirrorOf` collection is the
 *  public projection of a collection the public submits into, written in the
 *  SAME batch as each submission — so a subscription to it moves once per
 *  public write exactly as the records do. Leaving it open would let N→N in
 *  through the one collection this design put in front of the records.
 *
 *  ONLY `audience: "public"`. The roster tiers are bounded by the roster: the
 *  readers are enumerated in `members`, so the fan-out is N→1 by definition,
 *  and the moving picture is precisely what those pages are for.
 *
 *  AND THIS IS NOT A RULE. `firestore.rules` cannot tell a `get` from a
 *  `listen`, so anything in `public.read` can be subscribed to all day by a
 *  third party with their own SDK. What is guarded here is that the
 *  PLATFORM'S OWN PAGE does not open the fan-out — the other half is
 *  mulmoserver's runtime intersection, and neither half may be read as the
 *  guarantee on its own (mulmoterminal `docs/shared-app-principles.md`,
 *  principle 2). */
function viewLiveProblems(app: AuthoredApp, view: NormalizedView): string[] {
  const problems: string[] = [];
  for (const cid of view.live ?? []) {
    if (!view.collections.includes(cid)) {
      problems.push(
        `${view.where}.live names '${cid}', which is not in ${view.where}.collections. A view watches a subset of the datasets it is handed — ` +
          "the page is given no query for this one, so the subscription would be for nothing.",
      );
      continue;
    }
    if (view.audience !== "public") continue;
    if (app.public?.submit?.[cid] !== undefined) {
      problems.push(
        `${view.where}.live names '${cid}', which public.submit.${cid} lets the public write into. A public page watching a collection the public ` +
          "writes is N readers x N writers: 1000 visitors watching 1000 votes is 1,000,000 reads, and every further vote is another 1000. " +
          `Read '${cid}' once when the page opens (leave it out of live). To show the tally as it moves, put the member page /m/{slug} on the ` +
          "display screen — its readers are the roster, which is a number the app knows.",
      );
      continue;
    }
    const mirrorOf = app.collections?.[cid]?.mirrorOf;
    if (mirrorOf !== undefined) {
      problems.push(
        `${view.where}.live names '${cid}', which is collections.${cid}.mirrorOf '${mirrorOf}' — the public projection of a collection the public ` +
          `submits into, written in the SAME batch as each submission. Watching it is the same N x N through the mirror: 1000 visitors watching ` +
          "1000 bookings is 1,000,000 reads. Read it once when the page opens, and show the moving picture on the member page /m/{slug}, " +
          "whose readers the roster bounds.",
      );
    }
  }
  return problems;
}

function viewProblems(app: AuthoredApp, collections: readonly PublishableCollection[]): string[] {
  const normalized = normalizeViews(app);
  if (!normalized.ok) return normalized.problems;
  const known = new Set(collections.map((collection) => collection.cid));
  return normalized.views.flatMap((view) => [
    ...viewPathProblems(view),
    ...view.collections.flatMap((cid) => viewCollectionProblems(app, view, cid, known)),
    ...viewLiveProblems(app, view),
  ]);
}

/** The checks that need a SCHEMA rather than the declaration.
 *
 *  Kept separate from {@link publishProblems} because that gate is handed a cid and a primary key
 *  per collection and nothing else, on purpose: it reads the DECLARATION. A field NAME can only be
 *  judged against the schema that declares it, and the host is the one that reads those off disk.
 *
 *  This is what remains of a larger family. The rest of it — an assignee whose collection carried
 *  no `assigneeField`, a mirror pair with one half missing, a stranded `mirrorOf` — existed because
 *  publish wrote the roster from the manifest and the collection configuration from what a previous
 *  DEPLOY had staged, so the app that landed was one half of each. With staging gone the two halves
 *  are the same manifest read once, and those states cannot be reached; `assigneeProblems` and
 *  `mirrorProblems` above check the declaration against itself, which is now the whole question. */
export function schemaRefProblems(app: AuthoredApp, schemas: { cid: string; schema: CollectionSchema }[]): string[] {
  const schemaOf = new Map(schemas.map((entry) => [entry.cid, entry.schema]));
  return Object.entries(app.public?.submit ?? {}).flatMap(([cid, submit]) => submitRefProblems(schemaOf, cid, submit));
}

function submitRefProblems(schemaOf: ReadonlyMap<string, CollectionSchema>, cid: string, submit: AuthoredSubmit): string[] {
  return [
    ...idInRefProblems(schemaOf, cid, submit),
    ...boundRefProblems(schemaOf, cid, "fromField", submit.window?.fromField),
    ...boundRefProblems(schemaOf, cid, "untilField", submit.window?.untilField),
  ];
}

function idInRefProblems(schemaOf: ReadonlyMap<string, CollectionSchema>, cid: string, submit: AuthoredSubmit): string[] {
  const where = submit.idIn?.where;
  if (where === undefined) return [];
  return [
    ...refFieldProblem(schemaOf, cid, "idIn.where.field", submit.idIn?.collection, where.field),
    ...comparableProblem(schemaOf, cid, submit.idIn?.collection, where),
  ];
}

function boundRefProblems(
  schemaOf: ReadonlyMap<string, CollectionSchema>,
  cid: string,
  key: string,
  ref: { ref: string; collection: string; field: string } | undefined,
): string[] {
  if (ref === undefined) return [];
  return [...refFieldProblem(schemaOf, cid, `window.${key}.field`, ref.collection, ref.field), ...millisProblem(schemaOf, cid, `window.${key}.field`, ref)];
}

/** The field spec a reference points at, or undefined when there is no schema to judge it against
 *  (the host refuses that separately, naming every missing collection at once). */
function referencedField(
  schemaOf: ReadonlyMap<string, CollectionSchema>,
  target: string | undefined,
  field: string | undefined,
): CollectionFieldSpec | undefined {
  if (target === undefined || field === undefined) return undefined;
  return schemaOf.get(target)?.fields?.[field];
}

/** An enum's domain, or undefined for every other kind. Narrowed by the key
 *  rather than asserted: `fields` is a discriminated union and only some of
 *  its members carry `values`. */
function enumValues(spec: CollectionFieldSpec): readonly string[] | undefined {
  return spec.type === "enum" ? spec.values : undefined;
}

function refFieldProblem(
  schemaOf: ReadonlyMap<string, CollectionSchema>,
  cid: string,
  key: string,
  target: string | undefined,
  field: string | undefined,
): string[] {
  if (target === undefined || field === undefined) return [];
  const schema = schemaOf.get(target);
  if (schema === undefined || referencedField(schemaOf, target, field) !== undefined) return [];
  const known = Object.keys(schema.fields ?? {})
    .sort()
    .join(", ");
  return [
    `public.submit.${cid}.${key} names '${field}', which the schema of '${target}' does not declare. ` +
      `The rules read that field off the record and compare it, so as written every submission is refused with nothing to explain it. ` +
      `Fields on '${target}': ${known.length > 0 ? known : "(none)"}.`,
  ];
}

/** A comparison the rules can never satisfy is as dead as a missing field, and
 *  looks even more correct on the page: an `enum` whose domain does not contain
 *  the value, or a boolean field compared with a string. */
function comparableProblem(
  schemaOf: ReadonlyMap<string, CollectionSchema>,
  cid: string,
  target: string | undefined,
  where: { field: string; equals: string | number | boolean },
): string[] {
  const spec = referencedField(schemaOf, target, where.field);
  if (spec === undefined) return [];
  const said = JSON.stringify(where.equals);
  const values = enumValues(spec);
  if (values !== undefined) {
    if (values.includes(String(where.equals))) return [];
    return [
      `public.submit.${cid}.idIn.where.equals is ${said}, which is not one of the values '${where.field}' can hold on '${String(target)}' ` +
        `(${values.join(", ") || "(none)"}). The comparison can never be true, so every submission is refused.`,
    ];
  }
  const wanted = spec.type === "number" ? "number" : spec.type === "boolean" ? "boolean" : "string";
  if (typeof where.equals === wanted) return [];
  return [
    `public.submit.${cid}.idIn.where.equals is ${said}, and '${where.field}' on '${String(target)}' is a ${spec.type} field. ` +
      `The rules compare the stored value with this one and never coerce, so the comparison can never be true and every submission is refused.`,
  ];
}

/** A per-record window bound is EPOCH MILLIS, because the rules have no date
 *  arithmetic and do not coerce: they compare `request.time.toMillis()` with
 *  whatever is stored. A `datetime` field holds an ISO string, which is a type
 *  error that fails closed — the window never opens, and nothing says so. */
function millisProblem(
  schemaOf: ReadonlyMap<string, CollectionSchema>,
  cid: string,
  key: string,
  ref: { collection: string; field: string } | undefined,
): string[] {
  const spec = referencedField(schemaOf, ref?.collection, ref?.field);
  if (spec === undefined || spec.type === "number") return [];
  return [
    `public.submit.${cid}.${key} names '${String(ref?.field)}' on '${String(ref?.collection)}', which is a ${spec.type} field. A per-record bound is ` +
      `EPOCH MILLIS: the rules compare it with request.time.toMillis() and never coerce, so anything else is a type error that refuses every ` +
      `submission — the window simply never opens. Store the instant as a number.`,
  ];
}
