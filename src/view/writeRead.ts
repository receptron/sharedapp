import type { AuthoredMail } from "../publishManifest.js";
import type { ProjectedViewWrite } from "../appViews.js";

// The `write` half of a tier's projection, READ BACK.
//
// `appViews.ts` emits these documents; this is the only place that reads one and does not trust
// it. Both are here for the reason the whole package exists: mulmoserver reads the document off
// Firestore, where anybody who has ever held a role could in principle have written it, and
// MulmoTerminal reads one the compiler has just produced in-process. Two readers, one question —
// and the answers must not differ, because the second is a PREVIEW of the first and a preview that
// accepts what production drops draws a control the rules will refuse.
//
// Nothing here grants anything. `firestore.rules` already allows every write these entries
// describe. What a strict read buys is a page that draws only the buttons that exist, and a
// refusal that can name itself instead of arriving as a permission error that names nothing.
//
// IT LIVES UNDER `view/` AND MUST STAY THERE. MulmoTerminal's headless preview serves this
// directory over loopback and nothing else — an allow-list built from `dist/view` — so a module
// here that imports a sibling of the directory is a 404 at load time, and the whole runtime fails
// to parse. What the browser then shows is a page that never readies, reported as the author's.
// The imports above are TYPES, which are erased; a runtime one would have to move too.
//
// mulmoterminal plans/feat-shared-app-member-write.md

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const stringsOf = (value: unknown): string[] => listOf(value).filter((entry): entry is string => typeof entry === "string");

/** `{ <current status>: [<status>...] }`, with anything unreadable dropped. */
const tableOf = (value: unknown): Record<string, string[]> | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).map(([from, to]) => [from, stringsOf(to)] as const);
  return Object.fromEntries(entries.filter(([, to]) => to.length > 0));
};

const mailOf = (value: unknown): AuthoredMail | undefined => {
  if (!isRecord(value) || typeof value.toField !== "string" || !isRecord(value.on)) {
    return undefined;
  }
  const on = Object.entries(value.on).flatMap(([template, move]) => {
    if (!isRecord(move) || typeof move.to !== "string") {
      return [];
    }
    return [[template, { from: stringsOf(move.from), to: move.to }] as const];
  });
  return { toField: value.toField, on: Object.fromEntries(on), dataFields: stringsOf(value.dataFields) };
};

/** One collection's writable half.
 *
 *  Dropped rather than raised when it does not parse, and unlike a view's
 *  collections this is NOT all-or-nothing: a missing entry costs a button,
 *  which the page then reports as "not writable by this build" — where a
 *  missing dataset would have the page draw the wrong thing silently. */
/** The transition half, attached in place.
 *
 *  BOTH HALVES OR NEITHER: a status field with no table would offer every
 *  value, and a table with no field has nothing to write it to. */
const addTransitions = (write: ProjectedViewWrite, value: Record<string, unknown>): void => {
  const transitions = tableOf(value.transitions);
  if (typeof value.statusField !== "string" || value.statusField === "" || transitions === undefined) {
    return;
  }
  write.statusField = value.statusField;
  write.transitions = transitions;
  const mail = mailOf(value.mail);
  if (mail !== undefined) {
    write.mail = mail;
  }
};

const addAssignment = (write: ProjectedViewWrite, value: Record<string, unknown>): void => {
  if (typeof value.assigneeField !== "string" || value.assigneeField === "") {
    return;
  }
  write.assigneeField = value.assigneeField;
  // ONLY when the document actually carries one. An empty list here is not the
  // same as no list: absence is what tells `appCapability` that a projection
  // states no roles at all, and inventing `[]` makes it look role-scoped —
  // which on the roster tier refuses a participant's own-row transition before
  // the rules ever get to apply `ownRow`.
  if (Array.isArray(value.rowWriters)) {
    write.rowWriters = stringsOf(value.rowWriters);
  }
};

/** The withdrawal half.
 *
 *  Both keys are read here and only the first is required: an app with no
 *  contested slot declares no mirror, and a withdrawal there is one delete.
 *  An empty list is dropped rather than kept — it reads as "yes, they may" and
 *  means the opposite, and publish refuses it upstream for the same reason. */
const addWithdrawal = (write: ProjectedViewWrite, value: Record<string, unknown>): void => {
  const selfDelete = stringsOf(value.selfDelete);
  if (selfDelete.length === 0) {
    return;
  }
  write.selfDelete = selfDelete;
  if (typeof value.withdrawMirror === "string" && value.withdrawMirror !== "") {
    write.withdrawMirror = value.withdrawMirror;
  }
};

export const projectedWriteOf = (value: unknown): ProjectedViewWrite | null => {
  if (!isRecord(value) || typeof value.cid !== "string" || value.cid === "") {
    return null;
  }
  const write: ProjectedViewWrite = { cid: value.cid };
  // Each half attaches itself or does not, in one pass — a new one is a line
  // in this list rather than another statement in a function that is already
  // at its limit.
  for (const add of [addTransitions, addAssignment, addWithdrawal]) {
    add(write, value);
  }
  if (Array.isArray(value.writers)) {
    write.writers = stringsOf(value.writers);
  }
  // A collection with nothing writable is dropped rather than kept as an empty
  // entry: an entry is what a page draws a button from.
  if (Object.keys(write).length === 1) {
    return null;
  }
  return write;
};

/** Every readable entry in a tier's `{tier}/config` document.
 *
 *  The `config` wrapper is here rather than at each call site so both hosts reach the same floor
 *  for a document that carries no `write` at all — a tier published before the roles existed, or
 *  one whose collections are all read-only. `[]` is the honest answer to that: nothing is
 *  writable, so no page draws a control. */
export const projectedWritesOf = (config: Record<string, unknown> | null | undefined): ProjectedViewWrite[] => {
  if (!isRecord(config)) return [];
  return listOf(config.write)
    .map(projectedWriteOf)
    .filter((entry): entry is ProjectedViewWrite => entry !== null);
};
