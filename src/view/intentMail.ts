import type { AuthoredMail } from "../publishManifest.js";

// The notice a transition sends, derived the way the RULES derive it.
//
// Split from `intent.ts` so the judgement there stays one screen of "may this
// happen"; nothing here decides whether a write is allowed, only what rides
// along with one that is.
//
// mulmoterminal plans/feat-shared-app-member-write.md

/** The mail queued alongside a transition, if the declaration names one.
 *
 *  WHICH TEMPLATE IS DECIDED BY THE MOVE, never by the page: `on[template]`
 *  names the statuses it belongs between, and the rules re-derive the same
 *  thing from the record. Letting a view choose the template would let it queue
 *  "your booking is approved" against a booking it just rejected.
 *
 *  The recipient is read off the RECORD for the same reason. `dataFields` is
 *  what the template may interpolate, and the rules refuse a `data` carrying
 *  anything else. */
export interface QueuedMail {
  to: string;
  template: string;
  data?: Record<string, unknown>;
}

/** The declared fields this record actually carries.
 *
 *  `Object.hasOwn` rather than `in`, because `dataFields` is a list of names an AUTHOR wrote and
 *  `record` is a document read back from Firestore. `in` walks the prototype, so a declaration
 *  naming `constructor` or `toString` would put a FUNCTION into the queued mail — which the rules
 *  then refuse, with a permission error naming nothing, over a template that looks correct. */
const pick = (record: Record<string, unknown>, fields: string[]): Record<string, unknown> => {
  const entries = fields.filter((field) => Object.hasOwn(record, field)).map((field) => [field, record[field]] as const);
  return Object.fromEntries(entries);
};

/** The template whose declared move is the one being made. Both ends, because
 *  the rules check both: with the destination alone, a rejected booking could
 *  be moved straight to approved and mailed. */
const templateFor = (mail: AuthoredMail, from: string, to: string): string | undefined => {
  const found = Object.entries(mail.on).find(([, move]) => move.to === to && move.from.includes(from));
  if (found === undefined) {
    return undefined;
  }
  return found[0];
};

/** The address the notice goes to, read off the RECORD — the same value the
 *  rules re-derive, so a page cannot address one somewhere else. */
const recipientOf = (mail: AuthoredMail, record: Record<string, unknown>): string | undefined => {
  const value = record[mail.toField];
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  return value;
};

export const mailFor = (mail: AuthoredMail | undefined, record: Record<string, unknown> | null, from: string, to: string): QueuedMail | undefined => {
  if (mail === undefined || record === null) {
    return undefined;
  }
  const recipient = recipientOf(mail, record);
  const template = templateFor(mail, from, to);
  if (recipient === undefined || template === undefined) {
    return undefined;
  }
  const data = pick(record, mail.dataFields ?? []);
  if (Object.keys(data).length === 0) {
    return { to: recipient, template };
  }
  return { to: recipient, template, data };
};
