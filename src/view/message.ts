import { VIEW_MESSAGE } from "./protocol.js";

// What the parent will accept from a sandboxed view.
//
// Everything here judges a message against the DECLARATION rather than against
// what the message says about itself: the frame holds the app owner's HTML
// running in a stranger's browser, so "it said it was a booking" is not a fact
// about the app.
//
// The rules would refuse the same things a moment later. The difference is that
// a refusal here can name which assumption in the HTML is wrong, and the author
// is never the person looking at the screen.

/** The only part of a published config this judgement reads: which fields a
 *  public create may carry, per collection.
 *
 *  A structural minimum rather than the whole config, because the two hosts
 *  arrive here holding different things — mulmoserver has PARSED the published
 *  document back out of Firestore, MulmoTerminal has just PROJECTED one from
 *  the working tree and never written it. Both satisfy this, and neither has to
 *  hand the other its own shape. Widen it only for a field this file reads. */
export interface SubmitDeclaration {
  createFields: string[];
}

export interface ViewSubmitConfig {
  submit?: Record<string, SubmitDeclaration | undefined> | undefined;
}

/** One dataset, as the view receives it. */
export type ViewDataset = Record<string, unknown>[];

/** What the view asked to write, once it has survived validation. Held by the
 *  parent until the visitor accepts it — the confirmation panel is drawn from
 *  this object, so what is shown is exactly what would be written. */
export interface PendingSubmit {
  requestId: string;
  cid: string;
  values: Record<string, string>;
}

/** Why a submission was not accepted. Returned rather than thrown: the view is
 *  waiting for an answer to a specific request, and silence looks to the
 *  visitor exactly like a button that does nothing. */
export type SubmitRefusal = "unknown-collection" | "undeclared-field" | "not-a-submission";

export type SubmitRead = { ok: true; pending: PendingSubmit } | { ok: false; reason: SubmitRefusal; requestId: string };

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The view saying it has attached its listener. Before this there is nobody to
 *  receive the state, and the only send would be missed.
 *
 *  The NONCE is the point. `event.source` proves the message came from our
 *  frame; it does not prove it came from the document we put there, and a
 *  sandboxed frame may navigate itself — including before its first `load`,
 *  which is what makes counting loads insufficient on its own. Only the
 *  injected bootstrap knows this value, so only it can be answered with the
 *  app's data. */
export const isReady = (data: unknown, nonce: string): boolean =>
  isRecord(data) && data.type === VIEW_MESSAGE.ready && typeof data.nonce === "string" && data.nonce === nonce;

const NOT_A_SUBMISSION = { ok: false, reason: "not-a-submission" } as const;

/** The values a view may send: strings only.
 *
 *  Not fussiness. The rules compare stored values without coercing, and the
 *  form path sends strings, so accepting a number here would write a record
 *  that differs BY TYPE from the identical-looking one a form wrote. */
const valuesOf = (value: unknown): Record<string, string> | null => {
  if (!isRecord(value)) {
    return null;
  }
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  if (entries.length !== Object.keys(value).length) {
    return null;
  }
  return Object.fromEntries(entries);
};

/** Is this a submission at all? Separate from judging one, because a message
 *  that is not gets NO answer: replying would be answering something nobody
 *  asked. */
const asSubmission = (data: unknown): { requestId: string; cid: string; values: unknown } | null => {
  if (!isRecord(data) || data.type !== VIEW_MESSAGE.submit) {
    return null;
  }
  if (typeof data.requestId !== "string" || typeof data.cid !== "string") {
    return null;
  }
  return { requestId: data.requestId, cid: data.cid, values: data.values };
};

/** The values, judged against what a public create may carry.
 *
 *  `createFields` is the rules' whitelist and it is read with `hasOnly`, so one
 *  extra key does not write a bigger record — it refuses the whole submission,
 *  as a permission error that names nothing. */
const declaredValues = (raw: unknown, createFields: string[], requestId: string, cid: string): SubmitRead => {
  const values = valuesOf(raw);
  if (values === null) {
    return { ...NOT_A_SUBMISSION, requestId };
  }
  const allowed = new Set(createFields);
  if (Object.keys(values).some((field) => !allowed.has(field))) {
    return { ok: false, reason: "undeclared-field", requestId };
  }
  return { ok: true, pending: { requestId, cid, values } };
};

export const readSubmitMessage = (data: unknown, config: ViewSubmitConfig | null): SubmitRead => {
  const message = asSubmission(data);
  if (message === null) {
    return { ...NOT_A_SUBMISSION, requestId: "" };
  }
  const submit = config?.submit?.[message.cid];
  if (submit === undefined) {
    return { ok: false, reason: "unknown-collection", requestId: message.requestId };
  }
  return declaredValues(message.values, submit.createFields, message.requestId, message.cid);
};
