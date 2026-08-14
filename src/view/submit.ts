// What a public submission BECOMES: which fields land in the document, what its id is, and whether
// a second write travels with it.
//
// Beside the bridge rather than inside it because it is the other half of the same contract. The
// bridge decides WHEN a write may happen — a request from a frame is a request, and nothing is
// written until a person accepts it. This decides WHAT would be written, and it is pure: no
// Firestore, no framework, no clock.
//
// It is here for the reason the runtime is (see `./index.ts`): a shared app has more than one host
// writing these records now — mulmoserver from a visitor's browser, MulmoTerminal from the author's
// machine while they preview — and the record they build must be the SAME record. Every one of
// these decisions is one the deployed rules will check, and getting any of them wrong produces a
// permission error that names nothing:
//
//   the ID IS THE THING BEING CLAIMED for `idFrom: "field"` — a slot, a seat, an asset. A host that
//   invented a random id instead would write a booking that took nothing, successfully, for ever.
//
//   the ADDRESS is not the visitor's to type. The rules compare it to `request.auth.token.email`,
//   so it is filled from the account and a field for it would only be a field to get wrong.
//
//   the STATUS goes in the field `collections[cid].statusField` names, which is a convention only
//   until an app names something else.
//
//   a declared MIRROR must travel in the same write. The rules read it with `getAfter()`, so a
//   mirror written singly is refused — safely, and with nothing to tell the person about it.
//
// Design: mulmoterminal `plans/feat-shared-app-preview.md` section 5.

/** What this needs from the signed-in account, and nothing more. */
export interface Submitter {
  uid: string;
  email: string | null;
}

/** One collection's `public.submit` declaration, as `config/public` publishes it.
 *
 *  Every key here is one the deployed rules read. Widening it is a change to what a host must
 *  honour, not a convenience. */
export interface SubmitSpec {
  auth?: string | undefined;
  createFields: string[];
  /** The field carrying the submitter's verified address. */
  emailField?: string | undefined;
  /** The value the status field must hold on a create. */
  initialStatus?: string | undefined;
  idFrom?: string | undefined;
  idField?: string | undefined;
  /** A collection whose same-id record is flipped to `taken` by the SAME write. */
  mirror?: string | undefined;
}

/** One collection's published form: what a page may draw, and the field publish pinned meaning to. */
export interface DrawnForm {
  fields: Record<string, { label?: string | undefined; required?: true | undefined } | undefined>;
  statusField?: string | undefined;
}

/** One field a submitter may actually fill in. */
export interface WritableField {
  name: string;
  label: string;
  required: boolean;
}

/** Does a submission need somebody signed in? */
export const needsAccount = (submit: SubmitSpec): boolean => submit.auth !== undefined && submit.auth !== "none";

/** The inputs, in the order the declaration lists them — and WITHOUT the two the visitor does not
 *  choose. See the note at the top: the address is compared to their token and the status is pinned
 *  to `initialStatus`, so a box for either can only be filled in wrongly. */
export const writableFields = (drawn: DrawnForm, createFields: readonly string[], emailField: string | undefined): WritableField[] =>
  createFields.flatMap((name) => {
    if (name === emailField || name === drawn.statusField) return [];
    const spec = drawn.fields[name];
    if (spec === undefined) return [];
    return [{ name, label: spec.label ?? name, required: spec.required === true }];
  });

/** Which required fields were left empty, by LABEL — so an answer can name them instead of arriving
 *  as a permission error that names nothing. */
export const missingRequired = (fields: readonly WritableField[], values: Record<string, string>): string[] =>
  fields.filter((field) => field.required && (values[field.name] ?? "") === "").map((field) => field.label);

/** The document to write: the fields the declaration allows, plus the two the rules stamp meaning
 *  onto. An empty value is OMITTED rather than written as `""` — the rules test presence. */
export const recordOf = (
  fields: readonly WritableField[],
  drawn: DrawnForm,
  submit: SubmitSpec,
  values: Record<string, string>,
  account: Submitter | null,
): Record<string, unknown> => {
  const written = fields.flatMap((field) => {
    const value = values[field.name] ?? "";
    return value === "" ? [] : [[field.name, value] as const];
  });
  const email = submit.emailField !== undefined && account?.email != null ? [[submit.emailField, account.email] as const] : [];
  const status = submit.initialStatus !== undefined && drawn.statusField !== undefined ? [[drawn.statusField, submit.initialStatus] as const] : [];
  return Object.fromEntries([...written, ...email, ...status]);
};

/** The record's value for a field, as the rules would read it. A non-string is empty rather than
 *  stringified: the id has to match what the rule builds, and inventing a rendering of a number
 *  would only be a different way to be refused. */
const stringAt = (record: Record<string, unknown>, field: string): string => {
  const value = record[field];
  return typeof value === "string" ? value : "";
};

/** The record id the declaration asks for.
 *
 *  `auth.uid` is "one answer per person"; `auth.uid+field` is "one per person per thing", and for
 *  that one the rules require EXACTLY `uid + "_" + data[idField]`. Built from the RECORD rather
 *  than from what was typed, because the document carries fields the form never showed.
 *
 *  `unique` is passed in rather than generated: this module has no clock and no randomness, and a
 *  timestamp would collide for two answers from one person in the same millisecond. */
export const recordId = (submit: SubmitSpec, uid: string, record: Record<string, unknown>, unique: string): string => {
  if (submit.idFrom === "auth.uid") return uid;
  if (submit.idFrom === "field" && submit.idField !== undefined) return stringAt(record, submit.idField);
  if (submit.idFrom === "auth.uid+field" && submit.idField !== undefined) return `${uid}_${stringAt(record, submit.idField)}`;
  return unique;
};

/** The mirror's two values. `taken` is what a create sets; `open` is what a withdrawal restores. */
export const MIRROR_TAKEN = "taken";
export const MIRROR_OPEN = "open";

/** Everything one submission writes, decided by the DECLARATION rather than by the page.
 *
 *  `mirror` present means the two documents must be committed TOGETHER — the rules read the second
 *  with `getAfter()`. A host without an atomic write cannot honour this and must say so rather than
 *  write the first half. */
export interface PlannedWrite {
  cid: string;
  id: string;
  record: Record<string, unknown>;
  mirror?: { cid: string; id: string; state: string };
}

export const plannedWrite = (cid: string, submit: SubmitSpec, id: string, record: Record<string, unknown>): PlannedWrite => {
  if (submit.mirror === undefined) return { cid, id, record };
  return { cid, id, record, mirror: { cid: submit.mirror, id, state: MIRROR_TAKEN } };
};
