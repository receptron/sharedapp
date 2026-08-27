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
import { declaresMoves, normalizeViews, participantScope, type NormalizedView, type ViewAudience } from "./appViews.js";
import { agentCids, AGENT_ID_PATTERN, AGENT_INSTRUCTION_MAX, RESERVED_AGENT_IDS } from "./appAgents.js";
import { APP_PROTOCOL, protocolOf, protocolWithin } from "./appProtocol.js";
import { writersOf } from "./appViews.js";
import type { AuthoredAgent, AuthoredApp, AuthoredCollectionConfig, AuthoredSubmit, AuthoredView } from "./publishManifest.js";
import { byText } from "./byText.js";

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
  return (
    submit.idFrom === "auth.uid" ||
    submit.idFrom === "auth.uid+field" ||
    submit.emailField !== undefined ||
    // The same meaning as `emailField` with no address in it: the row says
    // whose it is, and the rules read it. Missing here, an app that identifies
    // its submitters by uid would have been the one shape that could be padded
    // by a writer while claiming to be per-person.
    submit.uidField !== undefined ||
    submit.audience === "participant"
  );
}

/** The fields a rule actually CHECKS the value of, for one collection.
 *
 *  `keyFields` pins a value against a declared set, `gateOn.match` pins it
 *  against the session's current question, and the status field is pinned by
 *  the transition machine. An aggregation grouped by anything else is grouped
 *  by a field any submitter may write anything into — so the published
 *  aggregate is whatever the noisiest respondent decided it should be. */
/** The status field a collection actually names, or undefined where it names none.
 *
 *  Absent and `""` are the SAME answer — an empty field name names nothing, and the rules would
 *  look a status up under a name no record carries. Every check that asks this question has to
 *  agree on that, or one of them accepts a declaration another refuses.
 *
 *  `AuthoredAppZ` parses `statusField` as `.trim().min(1).optional()`, so `""` cannot survive it.
 *  It is still handled here rather than assumed away: `AuthoredApp` is the zod TYPE, and a caller
 *  building one in TypeScript never meets the parser. */
function statusFieldOf(collection: AuthoredCollectionConfig | undefined): string | undefined {
  const named = collection?.statusField;
  return named === undefined || named === "" ? undefined : named;
}

function checkedFields(collection: AuthoredCollectionConfig | undefined, submit: AuthoredSubmit | undefined): Set<string> {
  const fields = new Set<string>();
  for (const keyField of submit?.validate?.keyFields ?? []) fields.add(keyField.field);
  if (submit?.gateOn) fields.add(submit.gateOn.match);
  const status = statusFieldOf(collection);
  if (status !== undefined) fields.add(status);
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
  // Kept in step with `bindsSubmitterIdentity` above, and the pair is easy to split: this one only
  // WORDS the refusal, so a binding missing here does not change which declarations are refused —
  // it empties the parentheses that were supposed to say what made the app one of them.
  if (submit.uidField !== undefined) bindings.push(`uidField: "${submit.uidField}"`);
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
    // Asked of "none" ONLY, and so it sits above the early return rather than
    // beside the emailField guard below: a uid is exactly what an anonymous
    // session HAS, and `uidField` with `auth: "anonymous"` is the pairing that
    // has no other spelling. With nobody signed in there is no uid at all, so
    // `uidOk` is false for every create and the collection accepts nothing —
    // fail-closed and silent, a form that refuses everything with no reason to
    // read off it.
    if (submit.auth === "none" && submit.uidField !== undefined) {
      problems.push(
        `public.submit.${cid}.auth is "none" and names uidField '${submit.uidField}': there is no session and therefore no uid, ` +
          'so the rules refuse every create and the form is shut with nothing to explain it. Use "anonymous" (a session with no sign-in screen, which still has a uid).',
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
  if (statusFieldOf(collection) === undefined) {
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
  return Object.entries(app.public?.submit ?? {}).flatMap(([cid, submit]) => [
    ...windowProblems(cid, submit),
    ...keyFieldCountProblems(cid, submit),
    ...capCeilingProblems(cid, submit),
  ]);
}

/** EVERY declared cap against the per-field ceiling, not merely the one an article view draws its
 *  body from. A cap above it is a number that cannot be honoured — the host would accept a value
 *  the store then refuses — and it is just as wrong on a field no page reads. */
function capCeilingProblems(cid: string, submit: AuthoredSubmit): string[] {
  return Object.entries(submit.maxBytes ?? {}).flatMap(([field, cap]) =>
    cap > MAX_FIELD_BYTES
      ? [
          `public.submit.${cid}.maxBytes.${field} is ${cap}, above the ${MAX_FIELD_BYTES} bytes one field may be. Bytes, not characters: Japanese ` +
            "runs about 2.4 bytes a character, so this is roughly 40,000 characters of Japanese or 100,000 of English — long for one article, and a " +
            "tenth of what a whole index may cost.",
        ]
      : [],
  );
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
function coherenceProblems(app: AuthoredApp, collections: readonly PublishableCollection[]): string[] {
  const known = new Set(collections.map((collection) => collection.cid));
  const names = known.size > 0 ? [...known].sort(byText).join(", ") : "(none)";
  const fromSubmits = Object.entries(app.public?.submit ?? {}).flatMap(([cid, submit]) => submitCoherenceProblems(app, cid, submit));
  const fromCollections = Object.entries(app.collections ?? {}).flatMap(([cid, collection]) => gateCoherenceProblems(cid, collection, known, names));
  return [...fromSubmits, ...fromCollections];
}

/** `initialStatus` is read together with the collection's `statusField` and
 *  with `createFields`; miss either and every submission is refused. */
function statusCoherenceProblems(cid: string, submit: AuthoredSubmit, collection: AuthoredCollectionConfig | undefined): string[] {
  if (submit.initialStatus === undefined) return [];
  const status = statusFieldOf(collection);
  if (collection === undefined || status === undefined) {
    return [
      `public.submit.${cid}.initialStatus needs collections.${cid}.statusField: the rules look the status up by that name, and refuse every submission without it.`,
    ];
  }
  const problems: string[] = [];
  if (!new Set(submit.createFields).has(status)) {
    problems.push(
      `public.submit.${cid}.createFields must include "${status}": a submission may carry ONLY the createFields, ` +
        "and the rules also require the status field to be present and equal to initialStatus. As written, every submission is refused.",
    );
  }
  problems.push(...initialTransitionProblems(cid, submit, collection));
  return problems;
}

/** A collection with a transition table publishes that table as the law for
 *  CREATE too: the rules ask whether `transitions.initial` contains the status
 *  the new record arrives in. So `initialStatus` naming a status the table's
 *  `initial` row does not list is refused by every create — the two
 *  declarations are each correct on their own and contradict each other, which
 *  is the shape that reaches the submitter as a bare permission error.
 *
 *  Only asked of a collection that HAS a table. `lunches`, `survey` and `mbti`
 *  carry a status and no transitions at all, which is a status the app moves
 *  by hand rather than an unreachable one, and there is nothing there for a
 *  rule to disagree with. */
function initialTransitionProblems(cid: string, submit: AuthoredSubmit, collection: AuthoredCollectionConfig): string[] {
  const transitions = collection.transitions;
  if (transitions === undefined || submit.initialStatus === undefined) return [];
  const initial = transitions[INITIAL_KEY] ?? [];
  if (initial.includes(submit.initialStatus)) return [];
  const listed = initial.map((status) => `"${status}"`).join(", ");
  return [
    `public.submit.${cid}.initialStatus is "${submit.initialStatus}", which collections.${cid}.transitions.initial does not list ` +
      `(${listed || "nothing"}). A create is judged against that row, so every submission is refused. Add it there, or submit the status the table starts in.`,
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
 *  omitting it fails the check.
 *
 *  `gateOn.match` is the third of them, and the same oversight a third time:
 *  `gateMatches()` reads `request.resource.data[g.match]` to decide which
 *  phase record the submission is answering. Leave it out of `createFields`
 *  and there is no input that works — carrying it fails `hasOnly`, omitting it
 *  fails the gate — so the gate that was meant to open on a phase is instead a
 *  form nobody can send. */
function ruleReadFields(submit: AuthoredSubmit): { field: string; why: string }[] {
  const fields: { field: string; why: string }[] = [];
  if (submit.emailField !== undefined) {
    fields.push({ field: submit.emailField, why: `public.submit.<cid>.emailField — the rules compare it to the submitter's verified address` });
  }
  if (submit.uidField !== undefined) {
    fields.push({
      field: submit.uidField,
      why: `public.submit.<cid>.uidField — the rules compare it to the submitter's own uid, and refuse a create that carries another`,
    });
  }
  if (ID_FROM_FIELD_MODES.includes(submit.idFrom ?? "") && submit.idField !== undefined) {
    fields.push({ field: submit.idField, why: `public.submit.<cid>.idField — the rules rebuild the document id from it` });
  }
  if (submit.gateOn !== undefined) {
    fields.push({
      field: submit.gateOn.match,
      why: `public.submit.<cid>.gateOn.match — the rules read it off the submission to find the phase record the gate is open on`,
    });
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
  problems.push(...fieldIdProblems(cid, submit, collection?.statusField));
  if ((submit.selfUpdate !== undefined || submit.selfTransitions !== undefined || submit.selfDelete !== undefined) && statusFieldOf(collection) === undefined) {
    problems.push(
      `public.submit.${cid}.selfUpdate / selfTransitions / selfDelete are declared per CURRENT STATUS, but collections.${cid} declares no statusField: ` +
        "the rules read the current status first and refuse every self-edit without it.",
    );
  }
  problems.push(...selfDeleteProblems(cid, submit, collection));
  problems.push(...selfWriteOwnerProblems(cid, submit));
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

/** WHICH ROW IS WHOSE, without which every self-write is refused.
 *
 *  `selfUpdate`, `selfTransitions` and `selfDelete` all reach the rules through `ownRow`, and
 *  `ownRow` recognises exactly four bindings: `idFrom: "auth.uid"`, `idFrom: "auth.uid+field"`,
 *  `emailField` (against a verified address) and `uidField`. Declare a self-write with none of
 *  them and the app publishes cleanly, the projection advertises the control, `describe` reports
 *  the fields — and every attempt is refused by the rules, with the one sentence they have.
 *
 *  `audience: "participant"` IS NOT ONE OF THEM, and it is the trap worth naming in the message.
 *  It reads like ownership and `bindsSubmitterIdentity` above even counts it, but the two are
 *  different questions: audience decides WHO MAY CREATE a row, and `ownRow` asks WHOSE A ROW IS.
 *  A roster of twenty contributors satisfies the first and tells the rules nothing about the
 *  second.
 *
 *  It bites hardest on exactly the app this key was added for. An article is named by its slug, so
 *  `idFrom` is spent on the URL and cannot carry the author — which leaves `emailField` or
 *  `uidField` as the only way to say who wrote it. */
function selfWriteOwnerProblems(cid: string, submit: AuthoredSubmit): string[] {
  const declared = [
    submit.selfUpdate === undefined ? null : "selfUpdate",
    submit.selfTransitions === undefined ? null : "selfTransitions",
    submit.selfDelete === undefined ? null : "selfDelete",
  ].filter((key): key is string => key !== null);
  if (declared.length === 0) return [];
  if (submit.idFrom === "auth.uid" || submit.idFrom === "auth.uid+field" || submit.emailField !== undefined || submit.uidField !== undefined) {
    return [];
  }
  const named = declared.map((key) => `public.submit.${cid}.${key}`).join(", ");
  return [
    `${named} let a SUBMITTER write their own row, but ${cid} declares nothing that says which row is theirs. The rules answer that with ownRow, which ` +
      `reads emailField, uidField, idFrom "auth.uid" or idFrom "auth.uid+field" — and none of those is declared here, so every one of these writes would be ` +
      `refused. Add "emailField" (the submitter's verified address) or "uidField" (their opaque id, for a board that must not publish addresses).` +
      (submit.audience === "participant" ? ' Note that audience "participant" is not enough: it decides who may CREATE a row, not whose a row is.' : ""),
  ];
}

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
 *  different question, and this check still does not ask it — reachability is
 *  what it is about, and a status the create rule refuses is unreachable for a
 *  reason of its own. That question is asked once, by
 *  {@link initialTransitionProblems}, so an app missing the row is told what is
 *  wrong with the row rather than about the selfDelete downstream of it. */
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
  const listed = unreachable.map((state) => `"${state}"`).join(", ");
  return [
    `public.submit.${cid}.selfDelete names ${listed}, ` +
      `which no record ever holds: it is neither public.submit.${cid}.initialStatus nor a status collections.${cid}.transitions names, ` +
      `so the declaration allows nothing.`,
  ];
}

/** The id modes whose document id is REBUILT FROM A SUBMITTED FIELD.
 *
 *  One list because three checks ask the same question — is this field the
 *  rules' business, is it frozen, may it appear in `selfUpdate` — and a mode
 *  added to two of the three is the silent half of a permissive declaration. */
const ID_FROM_FIELD_MODES: readonly string[] = ["auth.uid+field", "field", "slug"];

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
function fieldIdProblems(cid: string, submit: AuthoredSubmit, statusField: string | undefined): string[] {
  const problems: string[] = [];
  // `slug` needs the same field and refuses the same way, and needs `idIn` not
  // at all: the id is the record's own name, so there is no other record for a
  // reference to be wrong about. What `idIn` does for `field`, the grammar in
  // the rules does here — and it cannot be done at publish time, because
  // publish never sees a submission (principle 2).
  if (submit.idFrom === "slug" && submit.idField === undefined) {
    problems.push(
      `public.submit.${cid}.idFrom is "slug" but no idField is declared: the rules take the document id from that field and refuse every create. ` +
        `Name the field the URL name is submitted in — "idField": "slug".`,
    );
  }
  problems.push(...slugSourceProblems(cid, submit, statusField));
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
        `idFrom "field", so as written nothing checks the referenced record and the declaration promises a check it does not perform.` +
        (submit.idFrom === "slug"
          ? ` A "slug" id names the record itself rather than another one, so there is nothing for idIn to look in — delete it, or use idFrom "field" if the ` +
            `name really must already exist as a record somewhere.`
          : ""),
    );
  }
  return problems;
}

/** A slug taken from a field the HOST fills in, which is a name no visitor can ever choose.
 *
 *  `recordOf` writes three fields itself, whatever the form showed: the verified address, the
 *  uid, and the server stamp. Naming one of them as the slug source publishes cleanly and then
 *  refuses every single submission, in a way that reads like a rules problem:
 *
 *    - `emailField` always holds an address, and an address always contains `@`, which the slug
 *      grammar refuses — so the create fails on a value the visitor never typed;
 *    - `stampField` is not a string at all. It is a server timestamp, so the id cannot be built
 *      from it and `recordId` reads it as empty;
 *    - `uidField` is an opaque id nobody chose, which would work and is certainly not a URL name —
 *      and it is already what `idFrom: "auth.uid"` exists for.
 *
 *  Refused here rather than left to the rules, because the rules can only say no: they see one
 *  submission and cannot know the field was never the visitor's to fill. */
function slugSourceProblems(cid: string, submit: AuthoredSubmit, statusField: string | undefined): string[] {
  if (submit.idFrom !== "slug" || submit.idField === undefined) return [];
  const filled: [string | undefined, string, string][] = [
    [
      submit.emailField,
      `public.submit.${cid}.emailField`,
      "the rules fill it with the submitter's verified address, and an address contains '@', which a URL name may not",
    ],
    [
      submit.stampField,
      `public.submit.${cid}.stampField`,
      "the rules fill it with the server's clock, which is a timestamp rather than a string, so no id can be built from it",
    ],
    [
      submit.uidField,
      `public.submit.${cid}.uidField`,
      'the rules fill it with the submitter\'s own uid, which nobody chose and no reader can recognise — that is what idFrom "auth.uid" is for',
    ],
    // The STATUS field, and the one that is easy to miss because it is declared on the COLLECTION
    // rather than here — which is why it has to be passed in. `recordOf` fills it from
    // `initialStatus`, so it is no more the visitor's than the three above, and it fails in
    // whichever of two ways the declaration chooses. The second is the worse one: the app works
    // exactly once.
    [statusField, `collections.${cid}.statusField`, statusWhy(submit)],
  ];
  return filled
    .filter(([field]) => field !== undefined && field === submit.idField)
    .map(
      ([, key, why]) =>
        `public.submit.${cid}.idField is '${submit.idField}', which is also ${key}: ${why}. Give the URL name a field of its own, ` +
        "one the person writing the article fills in.",
    );
}

/** Which way a status-named slug fails, which depends on whether anything fills the field. */
function statusWhy(submit: AuthoredSubmit): string {
  if (submit.initialStatus === undefined) {
    return (
      "the rules read it from the declaration rather than from the form, and with no initialStatus nothing fills it at all — so every submission is " +
      "refused for a missing id, naming a box the form never showed"
    );
  }
  return (
    `every record would be named '${submit.initialStatus}', so the first article takes that id and every article after it is a write to a document ` +
    "that already exists — which the public submission path never allows. The app would work exactly once"
  );
}

/** Every `idIn` target, checked against the collections this repository has.
 *
 *  Separate from {@link fieldIdProblems} for the reason the file is split at
 *  all: that one reads the declaration alone, this one needs to know what
 *  exists. */
function idTargetProblems(app: AuthoredApp, collections: readonly PublishableCollection[]): string[] {
  const known = new Set(collections.map((collection) => collection.cid));
  const names = known.size > 0 ? [...known].sort(byText).join(", ") : "(none)";
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

/** `sealed` names statuses, and the same two ways of naming nothing as
 *  `selfDelete`: an empty list, and a status no record ever holds.
 *
 *  Plus one of its own — without a `statusField` the rules cannot read a
 *  record's status at all, so `sealedNow` is false for every row and the
 *  declaration seals nothing. That is the failure this file exists for: the
 *  app publishes, the page says the record is permanent, and it is not.
 *
 *  Judged against `transitions` and against `initialStatus`, because a status
 *  is reached either by being written first or by being transitioned into. */
function sealedProblems(app: AuthoredApp): string[] {
  return Object.entries(app.collections ?? {}).flatMap(([cid, collection]) => {
    const states = collection.sealed;
    if (states === undefined) return [];
    if (states.length === 0) {
      return [`collections.${cid}.sealed is an empty list, which seals nothing. Name the statuses a record may not be deleted from, or remove the key.`];
    }
    if (collection.statusField === undefined) {
      return [
        `collections.${cid}.sealed names statuses but collections.${cid} declares no statusField: the rules read a record's status through it, so nothing ` +
          "is ever sealed and every row stays deletable. Declare the statusField, or remove the key.",
      ];
    }
    const { transitions } = collection;
    if (transitions === undefined) return [];
    // `app.public.submit[cid]`, NOT every submit block in the app. Reading them
    // all made one collection's `initialStatus` vouch for another's statuses —
    // `topics.sealed: ["posted"]` passed because `messages` happens to post —
    // so the check answered about the wrong collection and let through exactly
    // the typo it exists to catch.
    const reachable = new Set([
      ...Object.values(transitions).flat(),
      ...Object.keys(transitions).filter((from) => from !== INITIAL_KEY),
      ...(app.public?.submit?.[cid]?.initialStatus === undefined ? [] : [app.public.submit[cid].initialStatus]),
    ]);
    const unreachable = states.filter((state) => !reachable.has(state));
    if (unreachable.length === 0) return [];
    const listed = unreachable.map((state) => `"${state}"`).join(", ");
    return [
      `collections.${cid}.sealed names ${listed}, which no record ever holds: ` +
        `it is neither an initialStatus nor a status collections.${cid}.transitions names, so the declaration seals nothing.`,
    ];
  });
}

/** `selfDelete` and `sealed` naming the same status is a flat contradiction —
 *  one says the submitter may take their row away from it, the other that
 *  nobody may — and the rules settle it by refusing: `sealedNow` is a
 *  conjunct above the branch `selfDelete` sits in.
 *
 *  So the declaration reads as a promise the app then breaks, and the page
 *  draws a control that always fails. Unlike the `writerDelete` pairing, which
 *  is legitimate — "a writer removes any row, except the ones the record has
 *  sealed" is a coherent thing to want, and the projection now carries `sealed`
 *  so the page can honour it — there is no reading of THIS pair that means
 *  anything, because both halves name the same status explicitly. */
function sealedSelfDeleteProblems(app: AuthoredApp): string[] {
  return Object.entries(app.collections ?? {}).flatMap(([cid, collection]) => {
    const sealed = new Set(collection.sealed ?? []);
    const clash = (app.public?.submit?.[cid]?.selfDelete ?? []).filter((state) => sealed.has(state));
    if (clash.length === 0) return [];
    const listed = clash.map((state) => `"${state}"`).join(", ");
    return [
      `public.submit.${cid}.selfDelete and collections.${cid}.sealed both name ${listed}: one says the submitter ` +
        "may withdraw their row from that status and the other that nobody may delete it at all. The rules refuse the delete, so the form promises a " +
        "withdrawal it can never perform. Name the status in one of them.",
    ];
  });
}

/** Where a `refIn` says the parent record lives.
 *
 *  The same typo as `idIn`'s and the same silence: the rules `get()` a
 *  collection that does not exist, the lookup can never succeed, and every
 *  create is refused with nothing anywhere to say why. Worse here than there,
 *  because `refIn` binds the OWNER — an author who mistypes it locks their own
 *  app and the agents sitting at it out of a collection at the same time, and
 *  the app still publishes.
 *
 *  A collection naming ITSELF is refused too, and it took a rules test to see
 *  why. It reads like the one shape a ref-keyed check adds over `idIn` — a
 *  reply that may only be posted while the message it answers stands — and it
 *  cannot work: `refIn` makes the ref field MANDATORY (a create without it
 *  builds a path out of nothing, which is an evaluation error), so every row
 *  needs a row to point at, INCLUDING THE FIRST. There is no way to write the
 *  root, and no batch helps because that batch's own root has the same problem.
 *  The collection accepts nothing, ever.
 *
 *  It is also the one shape `getAfter()` would wave through: a create whose
 *  `ref` names its own document id is checked against the row being written,
 *  so the creator supplies the state the gate reads. The rules refuse that
 *  case separately and fail closed; this is the readable refusal. */
function refInTargetProblems(app: AuthoredApp, collections: readonly PublishableCollection[]): string[] {
  const known = new Set(collections.map((collection) => collection.cid));
  const names = known.size > 0 ? [...known].sort(byText).join(", ") : "(none)";
  return Object.entries(app.collections ?? {}).flatMap(([cid, collection]) => {
    const target = collection.refIn?.collection;
    if (target === undefined) return [];
    if (target === cid) {
      return [
        `collections.${cid}.refIn.collection names '${cid}' itself. Every row would need a row of its own collection to point at — including the first, ` +
          "which has nothing to point at — and `refIn` makes the ref field mandatory, so the collection could never take a single record. " +
          "Name the collection of the thing being pointed AT (the topic, the shift, the order).",
      ];
    }
    if (known.has(target)) return [];
    return [
      `collections.${cid}.refIn.collection names '${target}', which is not a shared collection in this repository. The rules look the parent record up ` +
        `there on every create — the owner's included — so nothing can be added to '${cid}' at all. Shared collections here: ${names}.`,
    ];
  });
}

/** A gated reveal reads its flag off the PARENT record, so the path to that parent is not
 *  optional decoration — without it the gate never opens.
 *
 *  And the parent must be a collection this repository actually publishes. A
 *  typo'd `gatedFrom` is the same failure one step further in: the rules look
 *  the flag up in a collection that does not exist, the lookup can never
 *  succeed, and the gated collection stays hidden for good with nothing on the
 *  page or in the log to say why. */
function gateCoherenceProblems(cid: string, collection: AuthoredCollectionConfig, known: ReadonlySet<string>, names: string): string[] {
  if (collection.revealGated !== true) return [];
  if (collection.gatedFrom === undefined || collection.revealBy === undefined) {
    return [
      `collections.${cid}.revealGated needs both gatedFrom and revealBy: the flag is read off the PARENT record, and without the path the gate never opens.`,
    ];
  }
  if (known.has(collection.gatedFrom)) return [];
  return [
    `collections.${cid}.gatedFrom names '${collection.gatedFrom}', which is not a shared collection in this repository. ` +
      `The rules read the reveal flag off a record there, so the gate can never open and '${cid}' stays hidden. Shared collections here: ${names}.`,
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
          `Shared collections here: ${known.size > 0 ? [...known].sort(byText).join(", ") : '(none - a schema needs storage.type "firestore")'}.`,
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
    ...coherenceProblems(app, collections),
    ...primaryKeyProblems(app, collections),
    ...assigneeProblems(app),
    ...writerDeleteProblems(app),
    ...stampProblems(app),
    ...systemBindingProblems(app),
    ...systemFieldProblems(app),
    ...windowRefProblems(app, collections),
    ...idTargetProblems(app, collections),
    ...refInTargetProblems(app, collections),
    ...sealedProblems(app),
    ...sealedSelfDeleteProblems(app),
    ...mirrorProblems(app, collections),
    ...viewProblems(app, collections),
    ...agentProblems(app, collections),
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
/** A deletion nobody can ever make, and a deletion nobody is left to make.
 *
 *  `writerDelete` is a control on a staff page, and both failures below draw it
 *  and then refuse every press — the mismatch the whole projection exists to
 *  prevent, and neither one raises anything at the moment it happens: an
 *  `immutable` collection refuses the delete in the rules with a bare
 *  permission error, and an app with no writer refuses it because there is
 *  nobody the capability resolves for. */
function writerDeleteProblems(app: AuthoredApp): string[] {
  return Object.entries(app.collections ?? {}).flatMap(([cid, collection]) => {
    if (collection.writerDelete !== true) return [];
    if (collection.immutable === true) {
      return [
        `collections.${cid} declares both writerDelete and immutable. The rules refuse EVERY delete on an immutable collection, owner included ` +
          '(`deleteWith` asks `!flagOn(c, "immutable")` before it asks who is asking), so the page would draw a control that cannot work. Drop whichever one ' +
          "the app does not mean.",
      ];
    }
    if (writersOf(app, cid).length > 0) return [];
    return [
      `collections.${cid} declares writerDelete, and nobody holds "owner" or "editor" on it. The permission is a ROLE, so a page would draw the control for ` +
        "everybody the staff tier admits and the rules would refuse all of them. Give somebody the role, or drop the key.",
    ];
  });
}

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

/** TWO SYSTEM BINDINGS ON ONE FIELD.
 *
 *  Four keys make the host write a field rather than the visitor: `emailField` (the account's
 *  address), `uidField` (the account's uid), the `statusField` under an `initialStatus`, and
 *  `stampField` (the server's clock). Name the same field twice and the declaration asks for two
 *  different values in one place — which is not a contradiction anything reports, because each key
 *  is individually correct and each check that looks at one of them passes.
 *
 *  What happens instead is that the host writes one value over the other (`recordOf` fills them in
 *  a fixed order, so the loser depends on that order rather than on anything an author decided) and
 *  the rules require BOTH: `uidOk` compares the field with `request.auth.uid`, `stampOk` with
 *  `request.time`. Every create is denied, on a declaration where nothing was misspelt.
 *
 *  Reported per field rather than per pair, and with the bindings sorted, so a field claimed three
 *  times is one line naming all three. */
function systemBindingProblems(app: AuthoredApp): string[] {
  return Object.entries(app.public?.submit ?? {}).flatMap(([cid, submit]) => {
    const statusField = app.collections?.[cid]?.statusField;
    const claims: { field: string | undefined; by: string; writes: string }[] = [
      { field: submit.emailField, by: `emailField`, writes: "the submitter's verified address" },
      { field: submit.uidField, by: `uidField`, writes: "the submitter's uid" },
      {
        field: submit.initialStatus === undefined ? undefined : statusField,
        by: `initialStatus (collections.${cid}.statusField)`,
        writes: `"${submit.initialStatus}"`,
      },
      { field: submit.stampField, by: `stampField`, writes: "the server's clock" },
    ];
    const byField = new Map<string, { by: string; writes: string }[]>();
    for (const claim of claims) {
      if (claim.field === undefined) continue;
      byField.set(claim.field, [...(byField.get(claim.field) ?? []), { by: claim.by, writes: claim.writes }]);
    }
    return [...byField.entries()]
      .filter(([, holders]) => holders.length > 1)
      .map(
        ([field, holders]) =>
          `public.submit.${cid} points ${holders.map((holder) => holder.by).join(" and ")} at the same field '${field}', and each of them writes something different ` +
          `(${holders.map((holder) => holder.writes).join(", ")}). The host fills it in twice and one value survives; the rules require all of them, so every submission is refused ` +
          `with nothing misspelt anywhere. Give each binding its own field.`,
      );
  });
}

/** The fields a `selfUpdate` list may never contain, because each of them is
 *  what some OTHER check pinned down.
 *
 *  Each is a different loss and they are all silent. `emailField` is the
 *  submitter's identity: editable, a record can be handed to somebody else
 *  after the fact, and every rule that reads "is this yours" reads the new
 *  answer. `idField` is what the document id was built from, so editing it
 *  leaves the record saying one thing and living at the id of another — in
 *  `field` mode the rules refuse the write outright, which is a button the
 *  page draws and nothing behind it. `statusField` is the transition machine:
 *  a status in a plain `selfUpdate` list moves without being checked against
 *  `selfTransitions` at all, which is the submitter holding the staff's pen.
 *
 *  `stampField` is the fourth of the family and stays in {@link stampProblems}
 *  with the rest of its own story; it is skipped here so one mistake is not
 *  reported twice. */
function systemFieldProblems(app: AuthoredApp): string[] {
  return Object.entries(app.public?.submit ?? {}).flatMap(([cid, submit]) => selfUpdateSystemProblems(app, cid, submit));
}

function selfUpdateSystemProblems(app: AuthoredApp, cid: string, submit: AuthoredSubmit): string[] {
  const pinned: { field: string | undefined; why: string }[] = [
    {
      field: submit.emailField,
      why:
        `it is public.submit.${cid}.emailField, the field the rules compare with the submitter's verified address. ` +
        "A submitter who may rewrite it can move their own record onto somebody else's name",
    },
    {
      field: submit.uidField,
      why:
        `it is public.submit.${cid}.uidField, the field the rules compare with the submitter's own uid. ` +
        "The rules freeze it (`uidHeld`) so the write is refused rather than obeyed — a button the page draws with nothing behind it, and a declaration that reads like it grants something",
    },
    {
      field: ID_FROM_FIELD_MODES.includes(submit.idFrom ?? "") ? submit.idField : undefined,
      why:
        `it is public.submit.${cid}.idField, the field the document id was built from. ` +
        "Editing it leaves the record claiming one thing while living at the id of another, and in `field` and `slug` mode the rules refuse the write " +
        "(`idHeld`) — a button the page draws and nothing behind it. In `slug` mode it is also the URL, so a rename that DID go through would strand every " +
        "link ever shared",
    },
    {
      field: app.collections?.[cid]?.statusField,
      why:
        `it is collections.${cid}.statusField, and a status in selfUpdate moves without being checked against selfTransitions. ` +
        "That is the staff's transition table, held by the person the table is about",
    },
  ];
  return Object.entries(submit.selfUpdate ?? {}).flatMap(([status, fields]) =>
    pinned
      .filter((entry) => entry.field !== undefined && fields.includes(entry.field))
      .map(
        (entry) => `public.submit.${cid}.selfUpdate.${status} lets the submitter write '${String(entry.field)}', and ${entry.why}. Remove it from selfUpdate.`,
      ),
  );
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
        `The rules read the ${which} time off a record there, so nothing can ever be submitted. Shared collections here: ${known.size > 0 ? [...known].sort(byText).join(", ") : "(none)"}.`,
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
  const names = known.size > 0 ? [...known].sort(byText).join(", ") : "(none)";
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
  // Two INDEPENDENT things can be wrong about a mirror that names a real
  // collection, and both are collected rather than returned one at a time: a
  // missing `mirrorOf` hid the missing `idFrom` behind it, so the author fixed
  // one half, published again, and was refused again. Above this line the
  // early returns stay — a mirror naming nothing, or naming itself, makes
  // every further question about it meaningless.
  const problems: string[] = [];
  if (app.collections?.[mirror]?.mirrorOf !== cid) {
    problems.push(
      `public.submit.${cid}.mirror names '${mirror}', but collections.${mirror} does not declare mirrorOf: "${cid}". ` +
        "The two halves only work as a pair — the submission side demands the projection move with it, and the projection side is what allows that move — " +
        "so as written every submission is refused.",
    );
  }
  if (submit.idFrom !== "field") {
    const mode = submit.idFrom === undefined ? "absent" : JSON.stringify(submit.idFrom);
    problems.push(
      `public.submit.${cid}.mirror names '${mirror}', but idFrom is ${mode}. A mirror is one thing written twice: the record and its projection SHARE a ` +
        `document id, which is how the projection can say "this slot is taken" about that exact slot. With any other mode the projection lands at an id ` +
        `nothing points at, so the row the public page reads is never the row that was claimed. Declare idFrom: "field" with the field naming the thing ` +
        "being claimed.",
    );
  }
  return problems;
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
  // A platform-drawn page has no file, and `normalizeViews` has already refused
  // the case where it has neither. Asked here rather than at the call site so
  // that every caller of this check gets the same answer for the same view.
  if (view.path === undefined) return [];
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
        `Shared collections here: ${known.size > 0 ? [...known].sort(byText).join(", ") : "(none)"}.`,
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
      `${view.where}.collections names '${cid}', which a participant cannot read: it is not in participantRead, and public.submit.${cid} declares no ` +
        'emailField, no uidField and no idFrom "auth.uid", so there is no row the rules would call theirs. The page would be refused the read, not handed fewer records.',
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

/** The most a view may be capped to and still be a cap worth declaring.
 *
 *  Arbitrary, and deliberately generous: what the key exists to stop is the
 *  collection with no ceiling at all, not a page that reads eight hundred
 *  rows. A number above this is either a misunderstanding of what the key does
 *  or a request for the whole collection, and the second one is spelled by
 *  leaving the key out. */
const MAX_VIEW_LIMIT = 1000;

/** The LATEST-N cap: which of a view's datasets may carry one.
 *
 *  Three refusals, and each of them is a read that would be WRONG rather than
 *  merely absent — which is the whole reason the key is gated instead of
 *  simply passed through.
 *
 *  NO `stampField` IS THE IMPORTANT ONE. A limit has to be ordered by
 *  something, and the only field the rules guarantee on every record of a
 *  collection is the one they pin to the server clock themselves. Ordered by
 *  anything else, two things go wrong at once and neither shows: a record
 *  MISSING the field is excluded from the query rather than sorted last, and a
 *  field a submitter writes is a field a submitter can hold the window with.
 *  Ordered by NOTHING — a bare `limit` — Firestore falls back to the document
 *  id, so a chat room would return an arbitrary twenty rows and never deliver
 *  another message. That last one is what makes this a fail-closed trap rather
 *  than a preference: nothing errors, and the page looks like it is working.
 *
 *  AN OWN-ROW SCOPE cannot be ordered at all today. The query already carries
 *  a `where` on the submitter's address, so a second field in the sort needs a
 *  COMPOSITE INDEX, and `firestore.indexes.json` in mulmoserver declares none —
 *  the read would come back as a failure, which on a participant's page is a
 *  blank one. Refused with the reason rather than silently dropped, because the
 *  author has somewhere to go: cap the page that reads the collection whole. */
function viewLimitProblems(app: AuthoredApp, view: NormalizedView): string[] {
  const problems: string[] = [];
  for (const [cid, rows] of Object.entries(view.limit ?? {})) {
    if (!view.collections.includes(cid)) {
      problems.push(
        `${view.where}.limit names '${cid}', which is not in ${view.where}.collections. The cap applies to a dataset this page is handed — ` +
          "there is no query here to put it on.",
      );
      continue;
    }
    if (rows > MAX_VIEW_LIMIT) {
      problems.push(
        `${view.where}.limit.${cid} is ${rows}, above the ${MAX_VIEW_LIMIT} this key is for. It exists to stop a collection that grows forever ` +
          "being read whole on every open; a page that genuinely wants every record declares no limit for this dataset.",
      );
      continue;
    }
    if (app.public?.submit?.[cid]?.stampField === undefined) {
      problems.push(
        `${view.where}.limit caps '${cid}', which declares no public.submit.${cid}.stampField. A cap has to be ordered by something, and that is ` +
          "the only field the rules put on every record themselves (the server clock, pinned on create and frozen after). Without it the limit " +
          "falls back to Firestore's document-id order: the page gets an arbitrary N records and a NEW record never reaches it — nothing errors, " +
          `and the page looks like it is working. Declare public.submit.${cid}.stampField, or drop the cap.`,
      );
      continue;
    }
    if (view.audience === "participant" && participantScope(app, cid, app.participantRead ?? [])?.scope === "own") {
      problems.push(
        `${view.where}.limit caps '${cid}', which a participant reads as their OWN ROWS: the query already carries a where on the field that makes ` +
          "it readable, so ordering it as well needs a composite index, and the deployment declares none — the read would FAIL rather than return " +
          "fewer rows. A submitter's own rows are bounded by how much they submitted; cap the page that reads the collection whole instead.",
      );
    }
  }
  return problems;
}

/** The longest one field may be, and the most an index may cost — the two halves of the same
 *  number.
 *
 *  A COLLECTION THAT GROWS FOREVER is what `limit` was written for, and an articles collection is
 *  the purest example there is: it only ever gets longer, and every reader reads it. But `limit`
 *  caps ROWS, and rules cannot project a field away (principle 5), so the index downloads whole
 *  documents — BODIES INCLUDED. Twenty rows is a bound on nothing until something bounds the row.
 *
 *  `maxBytes` is that something, and it is why this check multiplies. `limit x maxBytes` is the
 *  worst-case payload an anonymous reader pulls down on every single open of the index, and it is
 *  a number publish can compute from the declaration alone — the only place in the system where
 *  that cost is visible before somebody pays it.
 *
 *  IN BYTES, and the first draft of this check was in characters. It was wrong in the direction
 *  that matters: a Japanese article measures about 2.4 bytes a character, so the same declaration
 *  that appeared to promise an 800 KB index delivered 2 MB. Every cost here is paid in bytes —
 *  the document limit, the payload, the reader's connection — so a ceiling in characters bounds
 *  none of them while reading exactly as though it did. */
const MAX_FIELD_BYTES = 100_000;

/** The most an index may cost one reader, in bytes, on one open. A ceiling on the absurd rather
 *  than an editorial opinion about article length — but a real one now that it is measured in the
 *  unit the reader's connection is. */
const MAX_INDEX_BYTES = 1_000_000;

/** A map entry, read the way `limitFor` reads one and for the reason written there: `constructor`,
 *  `toString` and `hasOwnProperty` are all legal collection names, and an article field name has no
 *  grammar at all. A plain index into a map that does not mention the key reaches Object.prototype
 *  and hands back a FUNCTION — so `rows === undefined` is false, `rows * cap` is NaN, and every
 *  comparison against NaN is false. The check would not fire, and an unbounded index would publish.
 *
 *  The non-number guard is the second half of the same thought: nothing but a number is a cap. */
const capIn = (map: Record<string, number> | undefined, key: string): number | undefined => {
  if (map === undefined || !Object.hasOwn(map, key)) return undefined;
  const held = map[key];
  return typeof held === "number" ? held : undefined;
};

/** An `article` view's bounds, and the audience that makes them enforceable.
 *
 *  THE AUDIENCE IS THE LOAD-BEARING ONE. `maxBytes` is not a rule (see its declaration): publish
 *  checks it and the host refuses the value before sending it, and neither of those binds somebody
 *  writing straight to Firestore. What makes that acceptable is that the only people who may write
 *  an article are the participants a roster carries — people the owner invited by name. Let a
 *  collection with `type: "article"` be submitted to by the world and the cap becomes a comment.
 *
 *  EVERY TEXT FIELD THE PAGE DRAWS is capped, not only the body. Capping the body alone left the
 *  long text one rename away: a contributor — or a `useSharedApp` agent that will not stop — puts
 *  it in `title` or `summary`, publish reports a cheap index, and the row is still whatever
 *  Firestore will hold. */
/** Is every writer of this collection somebody the roster names?
 *
 *  THE QUESTION THE CAP DEPENDS ON, and it took a real app to state it correctly. `maxBytes` is
 *  enforced by publish and by the host, never by a rule, so it binds only people who go through a
 *  host — which is fine for people the owner invited and worthless against a stranger.
 *
 *  There are two ways to be roster-only and the first draft accepted just one:
 *
 *  - `audience: "participant"`, which the rules read directly (`r == "participant"`), and
 *  - a submission window that has CLOSED. `inWindow` is reached only through `publicCreate`; the
 *    writer branch (`isWriter(r) && !submitOnly`) never consults it. So an app whose window shut in
 *    the past is one where the public path refuses everyone and the roster's writers go on writing.
 *
 *  Refusing the second cost a real blog its own desk: `audience: "participant"` forces
 *  `submitOnly` (see `submitOnlyProblems`), `submitOnly` closes the writer branch, and the owner
 *  then has to hold `participant` on their own collection — where `role()` prefers the
 *  per-collection entry over `*`, so they lose `writerDelete` and every other writer power on the
 *  articles they publish. That is a large change of model to buy a guarantee the app already had.
 *
 *  THE CLOCK IS DELIBERATE and it is not flaky. Publishing happens at an instant, and the question
 *  is about that instant: can a stranger create here now? A window whose `until` has passed can
 *  never reopen — `inWindow` conjoins it with every per-record bound, so a false there is final —
 *  and a window that has NOT yet closed is one where a stranger genuinely can write, which is the
 *  refusal above, correctly given. */
function rosterOnly(submit: AuthoredSubmit): boolean {
  if (submit.audience === "participant") return true;
  const until = submit.window?.until;
  return until !== undefined && Date.parse(until) <= Date.now();
}

const noLimitProblem = (view: NormalizedView, cid: string): string =>
  `${view.where} publishes '${cid}' as articles and declares no limit for it, so the index reads EVERY article — bodies included, because a rule ` +
  `cannot hide a field — on every open, forever. Add "limit": { "${cid}": 10 }.`;

/** The text fields an article view draws, deduplicated — an author may legitimately point two of
 *  the three at one field, and a cap named twice is not two costs. */
function drawnTextFields(view: NormalizedView): string[] {
  const { article } = view;
  if (article === undefined) return [];
  return [...new Set([article.title, article.body, article.summary].filter((field): field is string => field !== undefined))];
}

/** One collection's submit declaration, read the way `capIn` reads a cap and for the same reason:
 *  `constructor` is a legal collection name, and a plain index into a map that does not mention it
 *  hands back Object's own constructor. That is not undefined, so the "no submit block" refusal is
 *  skipped and the checks below judge a FUNCTION — refusing, but naming the wrong thing.
 *
 *  The older `app.public?.submit?.[cid]` call sites in this file predate the lookup and are not
 *  touched here; each one refuses on a different key and needs its own reading. */
function submitFor(app: AuthoredApp, cid: string): AuthoredSubmit | undefined {
  const declared = app.public?.submit;
  if (declared === undefined || !Object.hasOwn(declared, cid)) return undefined;
  return declared[cid];
}

function articleCostProblems(app: AuthoredApp, view: NormalizedView): string[] {
  if (view.type !== "article") return [];
  const cid = view.collections[0];
  if (cid === undefined) return [];
  const submit = submitFor(app, cid);
  const rows = capIn(view.limit, cid);
  const problems: string[] = [];
  // A MAGAZINE NOBODY MAY SUBMIT TO is a dead end rather than a shape to allow through, and the
  // dead end is already there: the index needs a `limit`, a `limit` needs a `stampField` to order
  // by, and `stampField` lives in `public.submit[cid]`. Without the block, publish refuses the
  // limit and this check refuses its absence, and neither line says the collection is the problem.
  if (submit === undefined) {
    return [
      `${view.where} publishes '${cid}' as articles and there is no public.submit.${cid} to publish them through. Everything the index needs is ` +
        "declared there — the stampField it is ordered by, the length an article may be, and the audience allowed to write one — so an article " +
        "collection nobody may submit to cannot be indexed at all. Declare the submit block, or draw this page from HTML of your own.",
    ];
  }
  if (!rosterOnly(submit)) {
    problems.push(
      `${view.where} publishes '${cid}' as articles, and anybody with an account can create one: public.submit.${cid} neither says ` +
        '"audience": "participant" nor closes its window. An article\'s length is bounded by the declaration and by the host, never by the rules, so ' +
        "the bound holds only over people the roster names. Restrict the audience, close the submission window, or publish this collection through a " +
        "page of your own instead.",
    );
  }
  if (rows === undefined) problems.push(noLimitProblem(view, cid));
  const drawn = drawnTextFields(view).map((field) => ({ field, cap: capIn(submit.maxBytes, field) }));
  for (const { field, cap } of drawn) {
    if (cap !== undefined) continue;
    problems.push(
      `${view.where} draws '${field}' and public.submit.${cid}.maxBytes says nothing about it, so that field has no length at all short of ` +
        `Firestore's 1 MiB document. The index downloads whole records, so an uncapped text field is where the long text goes the moment the body ` +
        `is capped. Add "maxBytes": { "${field}": 100000 }.`,
    );
  }
  const declared = drawn.map(({ cap }) => cap);
  const total = declared.every((cap) => cap !== undefined) ? declared.reduce<number>((sum, cap) => sum + cap, 0) : undefined;
  if (rows !== undefined && total !== undefined && rows * total > MAX_INDEX_BYTES) {
    problems.push(
      `${view.where} reads ${rows} articles whose drawn text may total ${total} bytes each, so one open of the index costs a reader at least ` +
        `${rows * total} bytes — above ${MAX_INDEX_BYTES}, and paid on every open by everyone. AT LEAST, not exactly: a rule cannot project a field ` +
        "away, so the index downloads the whole record — the slug, the status, the stamp and every other field ride along uncounted. Lower the " +
        "limit or the caps; the only way to a cheap index is a second collection carrying title and summary alone.",
    );
  }
  return problems;
}

/** A colour for a page nobody draws.
 *
 *  `theme` is read by the runtime that DRAWS a page from the declaration, and only `views[].type`
 *  produces one. An app whose pages are all its own HTML styles them itself and never looks here,
 *  so the key would sit in the manifest meaning nothing — the same silent no-op `viewLiveProblems`
 *  refuses one key over.
 *
 *  It does NOT move the protocol, and that asymmetry is the point: a reader too old to know `hue`
 *  draws the page in its default colours, which is the page. A reader too old to know `type` draws
 *  the GENERATED FORM in a magazine's place, which is not. */
function themeProblems(app: AuthoredApp, views: readonly NormalizedView[]): string[] {
  if (app.theme === undefined || views.some((view) => view.type !== undefined)) return [];
  return [
    "theme sets a colour and no view declares `type`, so nothing draws a page from this app's declaration and the key does nothing. A page " +
      "written as HTML carries its own colours. Delete `theme`, or publish a page the platform draws.",
  ];
}

function viewProblems(app: AuthoredApp, collections: readonly PublishableCollection[]): string[] {
  const normalized = normalizeViews(app);
  if (!normalized.ok) return normalized.problems;
  const known = new Set(collections.map((collection) => collection.cid));
  return [
    ...themeProblems(app, normalized.views),
    ...normalized.views.flatMap((view) => [
      ...viewPathProblems(view),
      ...view.collections.flatMap((cid) => viewCollectionProblems(app, view, cid, known)),
      ...viewLiveProblems(app, view),
      ...viewLimitProblems(app, view),
      ...articleCostProblems(app, view),
    ]),
  ];
}

// ---------------------------------------------------------------------------
// The STANDING INSTRUCTIONS — `agents[]`
//
// A brief is prose, so almost nothing about it can be checked. What CAN be
// checked is the same class of thing every other refusal here is about: a duty
// published where the wrong people can read it, and a duty nobody can carry out.
//
// The first is a leak. `config/public` is `allow read: if true` forever, so a
// public brief is world-readable by construction — and a brief is where an app
// says when to approve and when to delete. So a public brief may name only what
// that audience ALREADY has: what `public.read` publishes to the world, plus the
// collections it may submit to or move its own row in. A name outside that is
// the app's internal vocabulary going out on a document that never needed it.
//
// The second is the file's usual fail-closed trap. A brief asking for a move
// this audience does not carry is not a smaller job — it is an agent that wakes
// up, reads the rows and is refused, with the author believing the desk is
// staffed. `not-permitted` is the answer at the far end, and the author is not
// the person who hears it.

/** May this audience READ `cid` at all? The same three answers `views[]` gets,
 *  and for the same reason: a brief that says "watch the bookings" to a reader
 *  the rules deny is a subscription that never fires. */
function agentCanRead(app: AuthoredApp, audience: ViewAudience, cid: string): boolean {
  if (audience === "public") return (app.public?.read ?? []).includes(cid);
  if (audience === "participant") return participantScope(app, cid, app.participantRead ?? []) !== null;
  // A member holds a role, and every read branch a role opens is unscoped —
  // WHICH role is not a property of the declaration (see `writersOf`).
  return true;
}

/** Can THIS audience actually submit through `public.submit[cid]`?
 *
 *  "A submit declaration exists" is not the question, and reading it as one accepts a duty whose
 *  one action the rules would refuse. `publicCreate` in `firestore.rules` adds two conditions that
 *  are properties of the DECLARATION rather than of the writer, so they are answerable here:
 *
 *    `audience: "participant"` pins the create branch to the participant ROLE
 *  (`s.get("audience","") != "participant" || r == "participant"`). The member tier is `staffOf`
 *  — owner / editor / viewer / assignee — and a stranger on the public face holds no role at all,
 *  so neither of those may lean on such a form. (Sourcery on receptron/sharedapp#49.)
 *
 *  `auth: "none"` is NOT tested here although `publicCreate` also gates it on the master switch:
 *  `authProblems` refuses that value outright, above, so a condition for it could never fire — and
 *  a refusal nothing can reach is one nobody can trust is right.
 *
 *  Everything else about a create is about the WRITER or the record (`authOk`, `inWindow`,
 *  `idOk`), and none of those is a reason to refuse a declaration. */
function agentCanSubmit(app: AuthoredApp, audience: ViewAudience, cid: string): boolean {
  const submit = app.public?.submit?.[cid];
  if (submit === undefined) return false;
  return submit.audience !== "participant" || audience === "participant";
}

/** Can this audience DO anything to `cid` — move it, hand it over, take it
 *  away, correct their own row, or send one in?
 *
 *  `declaresMoves` rather than `writeFor`, and the difference is the blanket permission a writing
 *  role has over every collection there has ever been: an owner may rewrite any record in their own
 *  app, so counting that here would make every duty over every collection actionable and this
 *  refusal would never fire again. What the author is being asked about is what they DECLARED. */
const agentCanAct = (app: AuthoredApp, audience: ViewAudience, cid: string): boolean => declaresMoves(app, audience, cid) || agentCanSubmit(app, audience, cid);

/** One brief's id, held to the grammar it is reported under. */
function agentIdProblems(id: string, where: string, seen: Map<string, string>): string[] {
  if (RESERVED_AGENT_IDS.includes(id)) return [`${where}.id is '${id}', which is reserved: that is the id every tier's own projection document carries.`];
  if (!AGENT_ID_PATTERN.test(id)) {
    return [
      `${where}.id is '${id}': an agent id must be lowercase letters, digits and hyphens, start with a letter or digit, and be at most 64 characters ` +
        "(e.g. front-desk). It is what a report names this instruction by when it hands it to an agent.",
    ];
  }
  const first = seen.get(id);
  if (first !== undefined) {
    return [`${where}.id is '${id}', which ${first} already uses. Two briefs with one id cannot be told apart in the report that carries them.`];
  }
  seen.set(id, where);
  return [];
}

/** The instruction itself: prose, and bounded.
 *
 *  The cap is not tidiness. This text is published on a document read by every
 *  agent that opens the app, and it arrives in their context as a request from
 *  the author — so an unbounded key is a payload delivered by whoever published
 *  (or cloned and re-published) the app. Bounded, the reader can print it WHOLE,
 *  which is what lets it promise never to hand back a shortened one. */
function agentInstructionProblems(instruction: string, where: string): string[] {
  if (instruction.length <= AGENT_INSTRUCTION_MAX) return [];
  return [
    `${where}.instruction is ${instruction.length} characters, above the ${AGENT_INSTRUCTION_MAX} this key allows. A standing instruction is a brief: ` +
      "it is published to every agent that opens the app and printed whole, so there is a size past which it stops being one. Put the detail on the page.",
  ];
}

/** Why this audience is denied a read of `cid`, in the terms that audience's own rules use. */
const unreadableBecause = (audience: ViewAudience, cid: string): string =>
  audience === "public"
    ? "it is not in public.read, so the rules refuse the read and the subscription would never fire."
    : `it is not in participantRead, and public.submit.${cid} declares no emailField, no uidField and no idFrom "auth.uid", so there is no row the rules would call theirs.`;

/** ONE cid a brief names, judged for the audience the brief is written for.
 *
 *  Three refusals, in order: the collection is not in this repository at all; it is WATCHED by a
 *  reader the rules deny (a subscription that never fires); or it is named by a reader who can
 *  neither read nor write it.
 *
 *  That last one is the principle-5 half, and it is about the NAME rather than the data. Every cid
 *  a brief names is written onto the document that audience reads — `config/public` for a public
 *  brief, which is `allow read: if true` forever, and the roster's `live:config` for a participant
 *  one, which every listed participant reads. A collection the duty cannot use is not a dataset it
 *  could work from; it is one more of the app's internal names on a document that never needed it.
 *
 *  Read-OR-write, never read-and-write: the ordinary public brief names a collection it may only
 *  SUBMIT to (`public.submit`), which the world may never read, and that greeter is what this key
 *  exists for. */
function agentCidProblems(app: AuthoredApp, agent: AuthoredAgent, where: string, cid: string, known: ReadonlySet<string>): string[] {
  if (!known.has(cid)) {
    return [
      `${where} names '${cid}', which is not a shared collection in this repository. ` +
        `Shared collections here: ${known.size > 0 ? [...known].sort(byText).join(", ") : "(none)"}.`,
    ];
  }
  const readable = agentCanRead(app, agent.audience, cid);
  if (!readable && (agent.watch ?? []).includes(cid)) {
    return [
      `${where}.watch names '${cid}', which an agent reading as '${agent.audience}' cannot read: ${unreadableBecause(agent.audience, cid)}` +
        " A duty cannot be given over data the reader is denied.",
    ];
  }
  if (readable || agentCanAct(app, agent.audience, cid)) return [];
  return [
    `${where} names '${cid}', which an agent reading as '${agent.audience}' can neither read nor write. Every cid a brief names is PUBLISHED on the ` +
      `document that audience reads${agent.audience === "public" ? " — and the public one is world-readable forever" : ""}, so naming a collection the ` +
      "duty cannot use puts one more of this app's internal names there for nothing. Name the collections the job actually touches.",
  ];
}

/** A brief that cannot act on ANY of the collections it names.
 *
 *  Not the same question as the one above, which is asked per cid: a brief may read one dataset in
 *  order to write another, and that is a job. A brief where nothing is writable is not — the agent
 *  wakes up, reads the rows and is refused. "Look and report" is what the user of the terminal asks
 *  for; it is not something an app publishes. */
function agentInertProblems(app: AuthoredApp, agent: AuthoredAgent, where: string, cids: string[], known: ReadonlySet<string>): string[] {
  if (cids.length === 0 || cids.some((cid) => known.has(cid) && agentCanAct(app, agent.audience, cid))) return [];
  const spelled = cids.map((cid) => `'${cid}'`).join(", ");
  return [
    `${where} names ${spelled}, and an agent reading as '${agent.audience}' can do nothing to any of them: ` +
      "no form to submit through, and no transition, assignment or withdrawal this audience carries. A published standing instruction is a JOB — " +
      "the agent would wake up, read the rows and be refused. If the agent is only meant to look and report, that is what the user of the terminal " +
      "asks it for; it is not something the app publishes.",
  ];
}

/** The collections a brief names: they exist, this audience may read what it watches, every name
 *  is one that audience already has, and the duty can actually be carried out. */
function agentCollectionProblems(app: AuthoredApp, agent: AuthoredAgent, where: string, known: ReadonlySet<string>): string[] {
  const cids = agentCids(agent);
  return [...cids.flatMap((cid) => agentCidProblems(app, agent, where, cid, known)), ...agentInertProblems(app, agent, where, cids, known)];
}

/** What publish refuses about the standing instructions. */
function agentProblems(app: AuthoredApp, collections: readonly PublishableCollection[]): string[] {
  const known = new Set(collections.map((collection) => collection.cid));
  const seen = new Map<string, string>();
  return (app.agents ?? []).flatMap((agent, index) => {
    const where = `agents[${index}]`;
    return [
      ...agentIdProblems(agent.id, where, seen),
      ...agentInstructionProblems(agent.instruction, where),
      ...(agent.audience === "public" && app.public === undefined
        ? [
            `${where} is written for audience "public", and this app declares no \`public\` block. There is no public face to sit at, and the document a ` +
              "public brief is published on is the one the world reads — so there is nowhere to put it that is not an accident.",
          ]
        : []),
      ...agentCollectionProblems(app, agent, where, known),
    ];
  });
}

/** What publish SAYS about the standing instructions without stopping.
 *
 *  A warning rather than a refusal because both of these are declarations that
 *  work — they are just very likely not what the author meant, and the author is
 *  the only person who can tell. Kept out of {@link publishProblems} on purpose:
 *  a gate that stops for a maybe teaches people to stop reading it. */
export function agentWarnings(app: AuthoredApp): string[] {
  return (app.agents ?? []).flatMap((agent, index) => {
    const where = `agents[${index}]`;
    return [
      ...(agent.watch === undefined
        ? [
            `${where} declares no \`watch\`, so nothing will ever wake an agent up for it. It is read once, by whoever runs \`describe\` on the app. ` +
              "That is a real thing to publish; it is not a standing job.",
          ]
        : []),
      ...(/<\s*(form|script|iframe)\b|__MC_VIEW/i.test(agent.instruction)
        ? [`${where}.instruction contains markup. A brief is plain text read by an agent — the HTML a person sees belongs in a \`views[]\` page.`]
        : []),
    ];
  });
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
  return [
    ...Object.entries(app.public?.submit ?? {}).flatMap(([cid, submit]) => submitRefProblems(schemaOf, cid, submit)),
    ...Object.entries(app.collections ?? {}).flatMap(([cid, collection]) => mailRefProblems(schemaOf, cid, collection)),
    ...Object.entries(app.collections ?? {}).flatMap(([cid, collection]) => refInRefProblems(schemaOf, cid, collection)),
    ...(app.views ?? []).flatMap((view, index) => articleRefProblems(schemaOf, view, `views[${index}]`)),
  ];
}

/** WHICH FIELD IS THE TITLE, checked against the collection that holds the articles.
 *
 *  The same kind of check as `mailRefProblems` above and for the same reason: this is a field NAME
 *  in `app.json` and whether it exists is a fact about the SCHEMA, so neither gate can see it
 *  alone. What makes it worth having is that every way of getting it wrong is quiet — the runtime
 *  reads a key that is not there, gets `undefined`, and draws something rather than failing:
 *
 *    - a missing `title` falls back to the DOCUMENT ID, so the index reads as a list of slugs;
 *    - a missing `body` renders an empty article, indistinguishable from one nobody has written;
 *    - a missing `summary` silently uses the article's opening instead, so the author's declaration
 *      does nothing and nothing says so.
 *
 *  And the TYPE matters as much as the name, exactly as it does for `refIn.ref`: a `number` or
 *  `boolean` title is read as a string that is never there. `STRING_VALUED` is the same set, so a
 *  `markdown` body — which is what an article body ought to be — passes, and so does a plain
 *  `string` or `text`.
 *
 *  Judged only where there IS a schema, so a collection the host could not read is named once by
 *  its own error rather than a second time here. */
function articleRefProblems(schemaOf: ReadonlyMap<string, CollectionSchema>, view: AuthoredView, where: string): string[] {
  const { article } = view;
  const cid = view.collections[0];
  const schema = cid === undefined ? undefined : schemaOf.get(cid);
  if (view.type !== "article" || article === undefined || schema === undefined) return [];
  const fields = schema.fields ?? {};
  const known = Object.keys(fields).sort(byText).join(", ") || "(none)";
  const drawn: { key: "title" | "body" | "summary"; field: string | undefined; missing: string }[] = [
    { key: "title", field: article.title, missing: "the page falls back to the document id, so the index reads as a list of URL names" },
    { key: "body", field: article.body, missing: "every article renders EMPTY, which looks exactly like one nobody has written yet" },
    { key: "summary", field: article.summary, missing: "the index quietly shows the article's opening instead, and this declaration does nothing" },
  ];
  return drawn.flatMap(({ key, field, missing }) => {
    if (field === undefined) return [];
    if (!declaredField(fields, field)) {
      return [`${where}.article.${key} names '${field}', which the schema of '${cid}' does not declare — ${missing}. Fields on '${cid}': ${known}.`];
    }
    const spec = fields[field];
    if (spec === undefined || STRING_VALUED.has(spec.type)) return [];
    return [
      `${where}.article.${key} names '${field}', which the schema of '${cid}' declares as a ${spec.type} field. The page reads it as text, so ` +
        `${missing}. Use a string, text or markdown field.`,
    ];
  });
}

/** The mail queue's field names, against the collection's own schema.
 *
 *  Both failures are quiet in a way the declaration gate cannot see. A
 *  `toField` the schema does not declare means the queue reads no address off
 *  the record and the send is SKIPPED — the status moves, the app looks like
 *  it worked, and the person who was supposed to be told never hears. A
 *  missing `dataFields` entry is a template rendered with a hole in it: the
 *  mail goes out saying nothing about the booking it is about.
 *
 *  Judged only where there IS a schema, so a collection the host could not
 *  read is named once by its own error rather than a second time here. */
function mailRefProblems(schemaOf: ReadonlyMap<string, CollectionSchema>, cid: string, collection: AuthoredCollectionConfig): string[] {
  const { mail } = collection;
  const schema = schemaOf.get(cid);
  if (mail === undefined || schema === undefined) return [];
  const fields = schema.fields ?? {};
  const known = Object.keys(fields).sort(byText).join(", ") || "(none)";
  const problems: string[] = [];
  if (!declaredField(fields, mail.toField)) {
    problems.push(
      `collections.${cid}.mail.toField names '${mail.toField}', which the schema of '${cid}' does not declare. The queue reads the recipient off the record, ` +
        `so there is no address to send to and the mail is silently skipped — the status moves and nobody is told. Fields on '${cid}': ${known}.`,
    );
  }
  for (const field of mail.dataFields ?? []) {
    if (declaredField(fields, field)) continue;
    problems.push(
      `collections.${cid}.mail.dataFields names '${field}', which the schema of '${cid}' does not declare. It is copied off the record into the template's ` +
        `data, so the mail goes out with that value missing. Fields on '${cid}': ${known}.`,
    );
  }
  return problems;
}

/** `refIn`, against the two schemas it spans.
 *
 *  `ref` is read off the record BEING WRITTEN and `where.field` off the parent,
 *  so the two halves are judged against different collections — and each is a
 *  different silence when it is wrong. A `ref` the schema does not declare
 *  means the rules build a path out of a field that is never there, which is an
 *  evaluation error: the collection accepts nothing, from anybody, and the
 *  author's own page reports a permission denial it cannot explain.
 *
 *  Not refused when the field is merely absent from a submit form's
 *  `createFields`: a writer creates rows the form never touches, and `refIn` is
 *  about writers. What must exist is the SCHEMA field. */
/** Field kinds that reach the rules as a STRING, which is the whole
 *  requirement: `refIn.ref` becomes a path segment, and `$(...)` on anything
 *  else is an evaluation error — so a `number` id field publishes cleanly and
 *  then refuses every create in the collection, the owner's included, with
 *  nothing anywhere to say why.
 *
 *  Deliberately permissive about MEANING and strict about TYPE. A `datetime` is
 *  a strange thing to name a parent by and it does work, so it is not this
 *  check's business; a `money` field cannot work at all, and that is. Refusing
 *  something that would have worked is a loud, readable publish error; letting
 *  through something that cannot is the silent failure this whole file exists
 *  to prevent. */
const STRING_VALUED = new Set(["string", "text", "email", "markdown", "ref", "enum", "date", "datetime"]);

/** The two ways a ref field is the wrong field, both of them silent at publish
 *  and total at write time. */
function refKindProblems(own: CollectionSchema | undefined, cid: string, refIn: { ref: string; collection: string }): string[] {
  const spec = own?.fields?.[refIn.ref];
  if (spec === undefined || !Object.hasOwn(own?.fields ?? {}, refIn.ref)) return [];
  if (!STRING_VALUED.has(spec.type)) {
    return [
      `collections.${cid}.refIn.ref names '${refIn.ref}', which the schema of '${cid}' declares as a ${spec.type} field. The rules build the parent's ` +
        "path out of that value, and a path segment that is not a string is an evaluation error — so nothing can be created in " +
        `'${cid}' at all, the owner included. The field has to hold the parent's document id as a string.`,
    ];
  }
  // A `ref` field already declares where its ids live. When it disagrees with
  // `refIn.collection` the lookup goes to a collection those ids were never
  // minted in, so every create is refused — and the declaration reads as
  // correct twice over, which is why nothing downstream catches it.
  if (spec.type === "ref" && spec.to !== refIn.collection) {
    return [
      `collections.${cid}.refIn.ref names '${refIn.ref}', a ref field pointing at '${spec.to}', but collections.${cid}.refIn.collection says ` +
        `'${refIn.collection}'. The rules look the parent up in the collection named here, so the ids that field holds are searched for somewhere they ` +
        "were never issued and every create is refused. Make the two agree.",
    ];
  }
  return [];
}

function refInRefProblems(schemaOf: ReadonlyMap<string, CollectionSchema>, cid: string, collection: AuthoredCollectionConfig): string[] {
  const { refIn } = collection;
  if (refIn === undefined) return [];
  const own = schemaOf.get(cid);
  const refProblem =
    own === undefined || declaredField(own.fields ?? {}, refIn.ref)
      ? []
      : [
          `collections.${cid}.refIn.ref names '${refIn.ref}', which the schema of '${cid}' does not declare. The rules build the path to the parent out of ` +
            `that field, so a record without it is an evaluation error and NOTHING can be created in '${cid}' — the owner included. ` +
            `Fields on '${cid}': ${
              Object.keys(own.fields ?? {})
                .sort(byText)
                .join(", ") || "(none)"
            }.`,
        ];
  const where = refIn.where;
  return [
    ...refProblem,
    ...refKindProblems(own, cid, refIn),
    ...(where === undefined
      ? []
      : [
          ...refFieldProblem(schemaOf, `collections.${cid}.refIn.where.field`, refIn.collection, where.field),
          ...comparableProblem(schemaOf, `collections.${cid}.refIn.where`, refIn.collection, where),
        ]),
  ];
}

function submitRefProblems(schemaOf: ReadonlyMap<string, CollectionSchema>, cid: string, submit: AuthoredSubmit): string[] {
  return [
    ...maxBytesRefProblems(schemaOf, cid, submit),
    ...idInRefProblems(schemaOf, cid, submit),
    ...boundRefProblems(schemaOf, cid, "fromField", submit.window?.fromField),
    ...boundRefProblems(schemaOf, cid, "untilField", submit.window?.untilField),
  ];
}

/** A length cap on a field that is not there, or is not text.
 *
 *  Both are silent, and silent in the direction that matters: a cap keyed by a misspelt field name
 *  bounds NOTHING — the host looks the value up by the name it was sent, finds no cap, and lets it
 *  through. So the app reads as bounded, publish agreed, and the first over-long article is the
 *  first anyone hears of it. A cap on a `number` or a `table` is the same failure with a clearer
 *  cause: the host measures a string's length and that field never holds one.
 *
 *  Judged only where there IS a schema, so a collection the host could not read is named once by
 *  its own error rather than a second time here. */
function maxBytesRefProblems(schemaOf: ReadonlyMap<string, CollectionSchema>, cid: string, submit: AuthoredSubmit): string[] {
  const schema = schemaOf.get(cid);
  if (schema === undefined) return [];
  const fields = schema.fields ?? {};
  const known = Object.keys(fields).sort(byText).join(", ") || "(none)";
  return Object.keys(submit.maxBytes ?? {}).flatMap((field) => {
    const where = `public.submit.${cid}.maxBytes.${field}`;
    if (!declaredField(fields, field)) {
      return [`${where} caps a field the schema of '${cid}' does not declare, so it bounds nothing and nothing says so. Fields on '${cid}': ${known}.`];
    }
    const spec = fields[field];
    if (spec === undefined || STRING_VALUED.has(spec.type)) return [];
    return [`${where} caps a ${spec.type} field. A cap is a byte length, and only a text field has one — use a string, text or markdown field.`];
  });
}

function idInRefProblems(schemaOf: ReadonlyMap<string, CollectionSchema>, cid: string, submit: AuthoredSubmit): string[] {
  const where = submit.idIn?.where;
  if (where === undefined) return [];
  return [
    ...refFieldProblem(schemaOf, `public.submit.${cid}.idIn.where.field`, submit.idIn?.collection, where.field),
    ...comparableProblem(schemaOf, `public.submit.${cid}.idIn.where`, submit.idIn?.collection, where),
  ];
}

function boundRefProblems(
  schemaOf: ReadonlyMap<string, CollectionSchema>,
  cid: string,
  key: string,
  ref: { ref: string; collection: string; field: string } | undefined,
): string[] {
  if (ref === undefined) return [];
  return [
    ...refFieldProblem(schemaOf, `public.submit.${cid}.window.${key}.field`, ref.collection, ref.field),
    ...millisProblem(schemaOf, cid, `window.${key}.field`, ref),
  ];
}

/** The field spec a reference points at, or undefined when there is no schema to judge it against
 *  (the host refuses that separately, naming every missing collection at once). */
function referencedField(
  schemaOf: ReadonlyMap<string, CollectionSchema>,
  target: string | undefined,
  field: string | undefined,
): CollectionFieldSpec | undefined {
  if (target === undefined || field === undefined) return undefined;
  const fields = schemaOf.get(target)?.fields;
  return fields !== undefined && declaredField(fields, field) ? fields[field] : undefined;
}

/** Does the schema DECLARE this field — asked with `Object.hasOwn`, never by
 *  indexing and comparing with undefined.
 *
 *  A field name comes out of a hand-written `app.json`, and `constructor`,
 *  `toString` and `__proto__` are all names an author can type. Reached
 *  through the prototype chain they answer "yes, that field exists" to every
 *  check in this file, which turns the whole schema-reference family into a
 *  gate with three holes in it — and the failure downstream is the silent one
 *  these checks were added to catch. */
function declaredField(fields: Record<string, CollectionFieldSpec>, field: string): boolean {
  return Object.hasOwn(fields, field);
}

/** An enum's domain, or undefined for every other kind. Narrowed by the key
 *  rather than asserted: `fields` is a discriminated union and only some of
 *  its members carry `values`. */
function enumValues(spec: CollectionFieldSpec): readonly string[] | undefined {
  return spec.type === "enum" ? spec.values : undefined;
}

function refFieldProblem(schemaOf: ReadonlyMap<string, CollectionSchema>, label: string, target: string | undefined, field: string | undefined): string[] {
  if (target === undefined || field === undefined) return [];
  const schema = schemaOf.get(target);
  if (schema === undefined || referencedField(schemaOf, target, field) !== undefined) return [];
  const known = Object.keys(schema.fields ?? {})
    .sort(byText)
    .join(", ");
  return [
    `${label} names '${field}', which the schema of '${target}' does not declare. ` +
      `The rules read that field off the record and compare it, so as written every write it guards is refused with nothing to explain it. ` +
      `Fields on '${target}': ${known.length > 0 ? known : "(none)"}.`,
  ];
}

/** A comparison the rules can never satisfy is as dead as a missing field, and
 *  looks even more correct on the page: an `enum` whose domain does not contain
 *  the value, or a boolean field compared with a string. */
function comparableProblem(
  schemaOf: ReadonlyMap<string, CollectionSchema>,
  label: string,
  target: string | undefined,
  where: { field: string; equals: string | number | boolean },
): string[] {
  const spec = referencedField(schemaOf, target, where.field);
  if (spec === undefined) return [];
  const said = JSON.stringify(where.equals);
  const values = enumValues(spec);
  if (values !== undefined) {
    // NOT `String(where.equals)`: an enum's domain is strings, and the rules
    // compare `resource.data[f]` with the published literal without coercing.
    // `equals: 1` against values `['1']` reads as correct here and is false
    // there, which is a form that refuses every submission and says nothing.
    if (typeof where.equals === "string" && values.includes(where.equals)) return [];
    return [
      `${label}.equals is ${said}, which is not one of the values '${where.field}' can hold on '${String(target)}' ` +
        `(${values.join(", ") || "(none)"}). The comparison can never be true, so every write it guards is refused.`,
    ];
  }
  const wanted = spec.type === "number" || spec.type === "boolean" ? spec.type : "string";
  if (typeof where.equals === wanted) return [];
  return [
    `${label}.equals is ${said}, and '${where.field}' on '${String(target)}' is a ${spec.type} field. ` +
      `The rules compare the stored value with this one and never coerce, so the comparison can never be true and every write it guards is refused.`,
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
