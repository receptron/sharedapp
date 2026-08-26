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
//   so it is filled from the account and a field for it would only be a field to get wrong. The
//   UID (`uidField`) is the same binding for an app that collects no address, and less typeable
//   still: every value but the account's own is refused by `uidOk`.
//
//   the STATUS goes in the field `collections[cid].statusField` names, which is a convention only
//   until an app names something else.
//
//   a declared MIRROR must travel in the same write. The rules read it with `getAfter()`, so a
//   mirror written singly is refused — safely, and with nothing to tell the person about it.
//
//   the SERVER'S CLOCK is what decides a queue. `stampField` is checked on every create
//   (`stampOk` in `firestore.rules`), so a record without it is refused — and the value cannot come
//   from the page, because a page that could write it could write yesterday into it.
//
// Design: mulmoterminal `plans/feat-shared-app-preview.md` section 5.

/** What this needs from the signed-in account, and nothing more. */
export interface Submitter {
  uid: string;
  email: string | null;
}

/** One collection's `public.submit` declaration, as `config/public` publishes it.
 *
 *  Every key here but one is read by the deployed rules; `maxBytes` is the exception and says so
 *  at its own declaration. Widening this is a change to what a host must honour, not a
 *  convenience. */
export interface SubmitSpec {
  auth?: string | undefined;
  createFields: string[];
  /** The field carrying the submitter's verified address. */
  emailField?: string | undefined;
  /** The field carrying the submitter's UID — the same binding as `emailField` for an app that
   *  collects no address, and the rules compare it to `request.auth.uid` on create (`uidOk`).
   *
   *  Filled here for the reason the address is, and the reason is sharper: a uid is not something
   *  a person can type. Drawn as a box, whatever the visitor puts in it is refused, and the refusal
   *  names nothing. */
  uidField?: string | undefined;
  /** The value the status field must hold on a create. */
  initialStatus?: string | undefined;
  idFrom?: string | undefined;
  idField?: string | undefined;
  /** A collection whose same-id record is flipped to `taken` by the SAME write. */
  mirror?: string | undefined;
  /** The field the rules pin to the SERVER's clock on create, and freeze afterwards.
   *
   *  Declared, every create must carry it — the writer branch included — so a host that does not
   *  fill it in writes a record the rules refuse, with nothing on the page to say which field it
   *  was. `recordOf` is the one place it is filled in, for that reason. */
  stampField?: string | undefined;
  /** The longest a field's value may be, in BYTES of UTF-8: `{ <field>: <bytes> }`.
   *
   *  THE ONE KEY HERE THAT IS THE HOST'S OBLIGATION RATHER THAN THE RULES'. Everything above is
   *  read by `firestore.rules` and refused there if a host gets it wrong; this one is refused by
   *  nothing. Publish checks the declaration and the host must check the value, so a host that
   *  drops it does not fail — it accepts an article of any length and pays for it on every open of
   *  the index (see `articleCostProblems`).
   *
   *  AND BEING ON THIS TYPE DOES NOT PROTECT IT. An optional key is one a host copying a closed
   *  list of fields simply omits, and that compiles — so the `writableFields` argument (a host
   *  that has not been updated should fail to COMPILE, not to submit) does not reach this far.
   *  Making it required would only move the omission into a `{}` nobody consults.
   *
   *  What protects it is that the CHECK ships here too, as `overLongFields` below. A host calls
   *  one function rather than re-deriving the rule from the declaration, so there is no closed
   *  list to forget and no second reading of what a cap means. */
  maxBytes?: Record<string, number> | undefined;
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

/** The inputs, in the order the declaration lists them — and WITHOUT the four the visitor does not
 *  choose. See the note at the top: the address is compared to their token, the uid IS their token,
 *  the status is pinned to `initialStatus`, and the stamp is the SERVER's clock, so a box for any
 *  of them can only be filled in wrongly.
 *
 *  IT TAKES THE WHOLE DECLARATION, and that is the fix `uidField` arrived with. The list used to be
 *  positional and growing — `(drawn, createFields, emailField, stampField?)` — with the newest
 *  argument optional so the hosts could adopt it one at a time. What that buys is a host that
 *  silently keeps drawing a box for the field it has not heard of: the stamp was drawn as an empty
 *  box the visitor could not fill, and a uid would be drawn as one they CAN fill and whose every
 *  value the rules refuse. A host that has not been updated should fail to compile, not to submit. */
export const writableFields = (drawn: DrawnForm, submit: SubmitSpec): WritableField[] => {
  const filled = new Set([submit.emailField, submit.uidField, drawn.statusField, submit.stampField].filter((name): name is string => name !== undefined));
  return submit.createFields.flatMap((name) => {
    if (filled.has(name)) return [];
    const spec = drawn.fields[name];
    if (spec === undefined) return [];
    return [{ name, label: spec.label ?? name, required: spec.required === true }];
  });
};

/** A value that is longer than its declared cap, and by how much. */
export interface OverLongField {
  name: string;
  bytes: number;
  cap: number;
}

/** The values a host is about to write that exceed `maxBytes`, so it can refuse them BEFORE the
 *  write and name the field and the cap.
 *
 *  IT SHIPS HERE BECAUSE NOTHING ELSE ENFORCES IT. Every other decision in this file is checked
 *  again by the deployed rules, so a host that gets one wrong collects a permission error; this
 *  one is checked by nobody, and a host that skips it simply accepts the write. A rule is not an
 *  option — a length test on `items` create and update is paid by every app in the deployment
 *  (principle 10), against a bound whose writers the owner invited by name — so the enforcement is
 *  the declaration, the publish gate, and this function, and there is no fourth place.
 *
 *  BYTES OF UTF-8, measured, not `String.length`: Japanese runs about 2.4 bytes a character, so a
 *  host counting characters would let through nearly two and a half times the declared cap.
 *
 *  `Object.hasOwn` before the lookup for `limitFor`'s reason: a field name has no grammar, so
 *  `toString` is a legal one, and a plain index into a map that does not mention it hands back a
 *  FUNCTION — which is not a cap and must not be compared to one.
 *
 *  IT TAKES THE CAPS, NOT A `SubmitSpec`. A correction is the OTHER write of the same field and it
 *  is judged from a `ProjectedViewWrite`, which is a different document with the same caps in it;
 *  a signature naming the submit spec would have sent the correction path off to build a fake one.
 *  Every existing caller passes a `SubmitSpec` and still does — it is a structural supertype. */
export const overLongFields = (values: Record<string, string>, submit: { maxBytes?: Record<string, number> | undefined }): OverLongField[] => {
  const caps = submit.maxBytes;
  if (caps === undefined) return [];
  return Object.entries(values).flatMap(([name, value]) => {
    if (!Object.hasOwn(caps, name)) return [];
    const cap = caps[name];
    if (typeof cap !== "number") return [];
    const bytes = new TextEncoder().encode(value).length;
    return bytes > cap ? [{ name, bytes, cap }] : [];
  });
};

/** Which required fields were left empty, by LABEL — so an answer can name them instead of arriving
 *  as a permission error that names nothing.
 *
 *  Whitespace is empty here. A required answer of one space is not an answer, and treating it as
 *  one only moves the refusal somewhere that cannot name the field: past this check it becomes a
 *  name nobody can read, or — where it is the id field — a document id built out of a space. What
 *  is STORED is not trimmed: `recordOf` writes the value as typed, so an answer whose leading space
 *  is part of it keeps it. */
export const missingRequired = (fields: readonly WritableField[], values: Record<string, string>): string[] =>
  fields.filter((field) => field.required && (values[field.name] ?? "").trim() === "").map((field) => field.label);

/** The value this host writes where the rules require the SERVER's clock — Firestore's
 *  `serverTimestamp()` in both hosts today.
 *
 *  A function rather than a value, and injected rather than imported: this module is pure and has
 *  no Firestore in it (see the note at the top of `./index.ts`), and a sentinel is produced by the
 *  SDK the host resolved. Called only where the declaration asks for one, so a host with no
 *  submission to stamp never has to produce it. */
export type ServerTime = () => unknown;

/** The document to write: the fields the declaration allows, plus the three the rules stamp
 *  meaning onto. An empty value is OMITTED rather than written as `""` — the rules test presence.
 *
 *  `serverTime` is REQUIRED rather than optional, and that is the whole of the fix it arrived with.
 *  Optional, a host that simply did not pass it would go on building a record that looks complete
 *  and is refused by `stampOk` on every create — which is what shipped: `stampField` was declared,
 *  checked at publish, published to `config/public`, and then written by nobody, so a first-come
 *  app refused every public submission with "Missing or insufficient permissions" and named
 *  nothing. Required, a host that has not decided cannot compile.
 *
 *  The stamp goes on LAST. It is kept out of the drawn form by publish, so nothing should be able
 *  to carry a value for it — and if something ever does, the server's clock is the one that has to
 *  win, because it is the one the rules compare against. */
export const recordOf = (
  fields: readonly WritableField[],
  drawn: DrawnForm,
  submit: SubmitSpec,
  values: Record<string, string>,
  account: Submitter | null,
  serverTime: ServerTime,
): Record<string, unknown> => {
  const written = fields.flatMap((field) => {
    const value = values[field.name] ?? "";
    return value === "" ? [] : [[field.name, value] as const];
  });
  const email = submit.emailField !== undefined && account?.email != null ? [[submit.emailField, account.email] as const] : [];
  // The uid, on the same terms as the address and for a sharper reason: `uidOk` compares this field
  // with `request.auth.uid` on the create, so the ONLY value that is ever written here is the one
  // the account carries. It goes on after `written`, so a page that managed to send a value for it
  // — an old host still drawing the box, a frame that composed its own record — has that value
  // replaced rather than submitted and refused.
  const uid = submit.uidField !== undefined && account !== null && account.uid !== "" ? [[submit.uidField, account.uid] as const] : [];
  const status = submit.initialStatus !== undefined && drawn.statusField !== undefined ? [[drawn.statusField, submit.initialStatus] as const] : [];
  const stamp = submit.stampField !== undefined ? [[submit.stampField, serverTime()] as const] : [];
  return Object.fromEntries([...written, ...email, ...uid, ...status, ...stamp]);
};

/** The record's value for a field, as the rules would read it. A non-string is empty rather than
 *  stringified: the id has to match what the rule builds, and inventing a rendering of a number
 *  would only be a different way to be refused. */
const stringAt = (record: Record<string, unknown>, field: string): string => {
  const value = record[field];
  return typeof value === "string" ? value : "";
};

/** The code a host matches on to turn a refusal into a sentence a visitor can act on.
 *
 *  A fixed string rather than the message, because the message is English and the hosts are not:
 *  MulmoTerminal's preview and mulmoserver's page each phrase this for whoever is looking at it. */
export const MISSING_ID_FIELD = "missing-id-field";

/** The same, for a slug that is present and is not a legal name. */
export const BAD_SLUG = "bad-slug";

/** What an `idFrom: "slug"` name may be.
 *
 *  A SECOND STATEMENT of a grammar the rules already hold (`slugOk` in
 *  `firestore.rules`), and that is a cost taken deliberately rather than an
 *  oversight. The rules are the authority — they run for a client that never
 *  came through this package — and this one exists so that a host can refuse
 *  early and name the field, instead of handing the visitor a bare permission
 *  error from a write that was never going to land.
 *
 *  THE TWO MUST NOT DRIFT. Loosening this one only produces worse error
 *  messages; loosening the rules' one is what would actually change what may be
 *  published. If they are ever changed, the rules go first and this follows.
 *
 *  Identical to `VIEW_ID_PATTERN` today and kept separate on purpose: a view id
 *  addresses a document this repository writes, and a slug is a name a stranger
 *  submits. One constant would make a change to either silently change both. */
export const SLUG_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A submission this module will not turn into a write, with the reason in a form a host can
 *  branch on. Thrown rather than returned so that no caller can reach a Firestore path by ignoring
 *  a return value — the whole failure mode being fixed is a bad id that travelled silently. */
export class SubmitRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SubmitRefused";
    this.code = code;
  }
}

/** The id field this record cannot supply, or `undefined` if the id can be built.
 *
 *  For a host that would rather ask than catch: called before `recordId`, it names the field to put
 *  the error beside. `recordId` asks the same question, so a host that skips this is refused, not
 *  allowed.
 *
 *  BLANK IS EMPTY HERE, as it is in `missingRequired` — and this is the check that has to say so,
 *  because that one only speaks for fields marked required. An id field that is optional carries a
 *  lone space straight through: `idFrom: "field"` claims a document named " ", which no page can
 *  show and no author can find, and `auth.uid+field` builds `"<uid>_ "` — one document per person
 *  again, which is the collision this refusal exists to prevent. What is JUDGED is trimmed; what
 *  the id is BUILT from is not, so an id whose spaces are part of it is unchanged. */
export const missingIdField = (submit: SubmitSpec, record: Record<string, unknown>): string | undefined => {
  if (submit.idFrom !== "field" && submit.idFrom !== "auth.uid+field" && submit.idFrom !== "slug") return undefined;
  if (submit.idField === undefined) return undefined;
  return stringAt(record, submit.idField).trim() === "" ? submit.idField : undefined;
};

/** The slug field whose value is not a legal name, or `undefined`.
 *
 *  Beside `missingIdField` and asked the same way round: a host that would
 *  rather ask than catch calls it first to put the error next to the input.
 *  `recordId` asks it again, so skipping it is refused rather than allowed.
 *
 *  Empty is NOT this function's answer — `missingIdField` speaks for that, and
 *  reporting "not a legal name" about a box the visitor left blank sends them
 *  looking for a typo in nothing. */
export const badSlugField = (submit: SubmitSpec, record: Record<string, unknown>): string | undefined => {
  if (submit.idFrom !== "slug" || submit.idField === undefined) return undefined;
  const value = stringAt(record, submit.idField);
  if (value.trim() === "") return undefined;
  return SLUG_ID_PATTERN.test(value) ? undefined : submit.idField;
};

/** The record id the declaration asks for.
 *
 *  `auth.uid` is "one answer per person"; `auth.uid+field` is "one per person per thing", and for
 *  that one the rules require EXACTLY `uid + "_" + data[idField]`. Built from the RECORD rather
 *  than from what was typed, because the document carries fields the form never showed.
 *
 *  `unique` is passed in rather than generated: this module has no clock and no randomness, and a
 *  timestamp would collide for two answers from one person in the same millisecond.
 *
 *  An EMPTY id field is refused here rather than carried forward. Both ways it went wrong were
 *  silent: `field` produced `""`, which is not a document id at all and fails at the SDK with a
 *  message about paths that names no field; `auth.uid+field` produced `"<uid>_"`, which IS a valid
 *  id — one per person with the thing missing, so two claims on two different slots collide on one
 *  document and the second looks like it took something. Falling back to a random id would be a
 *  third silent failure and a worse one: the id IS the claim, so the rules would compare it to
 *  something else and refuse, or accept a booking that took nothing. */
export const recordId = (submit: SubmitSpec, uid: string, record: Record<string, unknown>, unique: string): string => {
  const missing = missingIdField(submit, record);
  if (missing !== undefined) throw new SubmitRefused(MISSING_ID_FIELD, `The submission has no value for "${missing}", which its id is built from.`);
  if (submit.idFrom === "auth.uid") return uid;
  // The name the record is published under. Refused here rather than sent,
  // because the rules refuse it too and a write that cannot land should not
  // reach the network with the field it was wrong about left unnamed.
  const badSlug = badSlugField(submit, record);
  if (badSlug !== undefined) {
    throw new SubmitRefused(
      BAD_SLUG,
      `"${stringAt(record, badSlug)}" is not a legal name for "${badSlug}": it becomes this record's document id and its URL, ` +
        "so it must be lowercase letters, digits and hyphens, start with a letter or digit, and be at most 64 characters.",
    );
  }
  if (submit.idFrom === "slug" && submit.idField !== undefined) return stringAt(record, submit.idField);
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
