import type { ViewDataset } from "./message.js";

// WHAT THIS READER HAS ALREADY SUBMITTED, as a page may see it.
//
// The gap it closes: a page is handed what its projection lets it READ, and a collection people
// submit to is exactly the one that cannot be in it — one visitor would be reading every other
// visitor's answer. So a page could not tell whether the person in front of it had already
// answered. It kept that in a variable, a reload lost it, and the page then offered an action the
// rules were certain to refuse: the visitor met a permission error for behaving normally.
//
// The parent reads it — the rules grant a submitter their own row (`ownRow` is the last branch of
// `readWith`, and it asks for `authed()` and nothing else) — and the parent decides how much of it
// goes into the sandbox. That decision is this module.
//
// IT LIVES IN THE PACKAGE because both parents answer it. mulmoserver reads for the live pages and
// MulmoTerminal reads for the author's preview of those same pages, and the two must project the
// same fields: an author previewing a page that was handed one more field than production hands it
// is previewing a page that does not exist. It was mulmoserver's alone, and MulmoTerminal's preview
// answered nothing at all — so a page asking "have I registered?" was told "unknown" for ever, drew
// its registration form on top of a registration that existed, and the author was left debugging
// the page.

/** The fields a page in this position could have SENT — the same list the generated form draws,
 *  which is `createFields` minus the ones the host fills in (the address, the uid, the status, the
 *  stamp). `writableFields` in `submit.ts` computes it; this only needs the names. */
export interface OwnRowFields {
  cid: string;
  fields: readonly { name: string }[];
}

/** One own-row as the view receives it: the document id, and the fields the page could have sent.
 *
 *  NARROWER THAN WHAT THE RULES RETURN, deliberately. `ownRow` grants the submitter their whole
 *  document, and the whole document is not the page's business: the status the app moved it to, the
 *  staff member it was assigned to, a reviewer's note. Handing those to sandboxed HTML would widen
 *  what a published page knows about the app it belongs to — in order to tell it something it
 *  already knew, which is that this person answered.
 *
 *  THE ID IS KEPT, and it is not bookkeeping: where the collection is `idFrom: "auth.uid"` the id IS
 *  the reader's uid, and that is the only way a page can learn its own — the uid FIELD is one of the
 *  host-filled ones dropped above. A page comparing `row.uid` to something it never received got
 *  `undefined === undefined` and drew nothing. */
export const ownRow = (fields: readonly { name: string }[], record: Record<string, unknown>): Record<string, unknown> => {
  const kept: Record<string, unknown> = { id: record.id };
  for (const field of fields) {
    if (record[field.name] !== undefined) {
      kept[field.name] = record[field.name];
    }
  }
  return kept;
};

/** One entry per collection a read ESTABLISHED something about — the ones this reader has not
 *  answered as an empty array, and the ones nothing could look up left out entirely.
 *
 *  Three states, and the page needs all three. "You have not answered" is an empty array. "Nothing
 *  could be read" — no lookup for that id strategy, a refused or offline read — is a missing key,
 *  because an empty array there would take an action away from somebody entitled to it. And "this
 *  host says nothing at all" is no `mine` whatsoever, which is decided one level up, in the parent.
 *
 *  `known` is a list rather than the caller filtering `specs`: which collections were readable is
 *  the read's own answer, and reconstructing it here would be a second opinion about it. */
export const ownRowsFor = (
  specs: readonly OwnRowFields[],
  answers: Record<string, Record<string, unknown>[]>,
  known: readonly string[],
): Record<string, ViewDataset> =>
  Object.fromEntries(
    specs.filter((spec) => known.includes(spec.cid)).map((spec) => [spec.cid, (answers[spec.cid] ?? []).map((record) => ownRow(spec.fields, record))]),
  );
