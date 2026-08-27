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
  /** The collection whose records the platform draws as ARTICLES, when this app has one — the only
   *  cid `view.open` may name. Absent on every app that publishes none, where an open has no page
   *  to reach and is refused. */
  articleCid?: string | undefined;
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
  // `hasOwn`, not `!== undefined`: `constructor`, `toString` and `__proto__` are all "present" on
  // any object, so a cid of `constructor` would be read as a declared collection and its
  // `createFields` looked up on a function. Refusing it here keeps the boundary the wording claims
  // — only what the app declared — and stops the write path being reached with a spec that is not
  // one.
  const submit = config !== null && config.submit !== undefined && Object.hasOwn(config.submit, message.cid) ? config.submit[message.cid] : undefined;
  if (submit === undefined) {
    return { ok: false, reason: "unknown-collection", requestId: message.requestId };
  }
  return declaredValues(message.values, submit.createFields, message.requestId, message.cid);
};

/** A view asking about ONE of its own rows: which collection, and the key that
 *  completes the id. */
export interface LookupAsk {
  requestId: string;
  cid: string;
  key: string;
}

/** Why a lookup will not be performed — and the first value is not like the other two.
 *
 *  `not-a-lookup` means THIS IS NOT ONE: the caller goes on to read the message as something else,
 *  and nobody is waiting on an answer to it. The other two mean it IS a lookup and will not be
 *  served, so the page's promise must be settled with them — a read has no timeout, and a page that
 *  is never answered waits forever with nothing on screen to say why. */
export type LookupRefusal = "not-a-lookup" | "invalid-lookup" | "unknown-collection";

export type LookupRead = { ok: true; ask: LookupAsk } | { ok: false; reason: LookupRefusal; requestId: string };

/** Read a `lookup`, and refuse it for the same reasons a submission is refused.
 *
 *  A cid the app never opened for submission is refused rather than looked up:
 *  the id strategy comes from that declaration, so without it there is nothing
 *  to build an id FROM — and answering "not found" would be a claim about a
 *  collection this page has no business asking after.
 *
 *  The key is a plain string and is never used as a path on its own: the parent
 *  builds `uid + "_" + key` and reads that document, so the worst a page can do
 *  with a made-up key is ask about a row of its own that does not exist. */
export const readLookupMessage = (data: unknown, config: ViewSubmitConfig | null): LookupRead => {
  // Not one of ours, or one with nobody waiting on it (no request id, so no promise to settle).
  // Both fall through to be read as something else.
  if (!isRecord(data) || data.type !== VIEW_MESSAGE.lookup || typeof data.requestId !== "string" || data.requestId === "") {
    return { ok: false, reason: "not-a-lookup", requestId: "" };
  }
  // From here it IS a lookup and somebody is waiting. A malformed one must be ANSWERED — refused
  // with a reason — rather than dropped: `view.mine("votes", "")` used to fall through to the
  // submission reader, be refused there with no request id, and leave the page on a promise that
  // never settled. A read has no timeout; nothing anywhere would have said so.
  if (typeof data.cid !== "string" || data.cid === "" || typeof data.key !== "string" || data.key === "") {
    return { ok: false, reason: "invalid-lookup", requestId: data.requestId };
  }
  // `hasOwn` for the reason the submission reader gives: `constructor` is present on every object,
  // and reading it as a declared collection would send the host off to look up a row in a
  // collection this app never opened.
  if (config === null || config.submit === undefined || !Object.hasOwn(config.submit, data.cid)) {
    return { ok: false, reason: "unknown-collection", requestId: data.requestId };
  }
  return { ok: true, ask: { requestId: data.requestId, cid: data.cid, key: data.key } };
};

/** What the parent found, as the view is told it.
 *
 *  `known` is the field that carries the honesty: false means nobody looked —
 *  the host offers no `lookup` port, or the read failed — and a page must draw
 *  that as "unknown", never as "you have not answered". */
export interface LookupAnswer {
  known: boolean;
  found: boolean;
  record?: Record<string, unknown>;
}

/** A view asking for ONE article to be opened: which collection, and which record. */
export interface OpenAsk {
  requestId: string;
  cid: string;
  id: string;
}

/** WHAT AN ID MAY BE, on its way into a URL.
 *
 *  The host builds `/a/{slug}/{id}` out of this, so the grammar is the defence that does not depend
 *  on one host remembering to encode: a `/` would address a different route, a `.` at the front is
 *  a relative segment, and an empty string is the index. Wider than the `slug` grammar
 *  (`publishManifest`'s `idFrom: "slug"`) on purpose — an app whose articles have generated ids has
 *  the same claim on a link — and narrower than a Firestore document id, which may hold anything at
 *  all. */
const OPEN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

/** Why an article will not be opened. `not-an-open` is the one that means THIS IS NOT ONE — nobody
 *  is waiting on it, and the caller reads the message as something else. The other two mean it is
 *  one and will not be served, so the page's promise has to be settled with them. */
export type OpenRefusal = "not-an-open" | "invalid-open" | "unknown-collection";

export type OpenRead = { ok: true; ask: OpenAsk } | { ok: false; reason: OpenRefusal; requestId: string };

/** Read an `open`, against the ONE collection this app draws articles from.
 *
 *  A cid that is not that collection is refused rather than navigated to: `/a/{slug}/{id}` has
 *  nothing in it to say which collection an id belongs to, so the host would send the visitor to a
 *  page that reads a record of a different collection, or none — an address that looks broken.
 *
 *  `articleCid` is null on an app that publishes no articles, where every open is refused: there is
 *  no such page to reach. */
export const readOpenMessage = (data: unknown, articleCid: string | null): OpenRead => {
  if (!isRecord(data) || data.type !== VIEW_MESSAGE.open || typeof data.requestId !== "string" || data.requestId === "") {
    return { ok: false, reason: "not-an-open", requestId: "" };
  }
  if (typeof data.cid !== "string" || typeof data.id !== "string" || !OPEN_ID.test(data.id)) {
    return { ok: false, reason: "invalid-open", requestId: data.requestId };
  }
  if (articleCid === null || data.cid !== articleCid) {
    return { ok: false, reason: "unknown-collection", requestId: data.requestId };
  }
  return { ok: true, ask: { requestId: data.requestId, cid: data.cid, id: data.id } };
};

/** What the host did about an `open`.
 *
 *  `opened: false` is not always a refusal, which is why the reason rides beside it: a host that
 *  offers no navigation at all — the author's preview pane, where there is no browser history to
 *  push onto — answers `no-navigation`, and the honest thing for a page to do about that is
 *  nothing. In production the answer usually never arrives at all: the host navigates, this
 *  document is replaced, and the promise goes with it. That is what a link does. */
export interface OpenAnswer {
  opened: boolean;
  reason?: OpenRefusal | "no-navigation";
}

/** What a frame may say about ITSELF, and the only codes a parent will hear.
 *
 *  A FIXED list, matched exactly. The frame holds untrusted HTML, so `code`
 *  arrives as an arbitrary string of arbitrary length — and a notice is built
 *  to be copied out of the host and read by somebody else, often a language
 *  model. Passing the page's own word through would hand it a writing surface
 *  on the diagnostic itself. Anything unrecognised becomes `unknown`, which is
 *  the host's word, not the page's. */
export const VIEW_NOTICE_CODES = ["error", "unhandled-rejection", "modal-ignored", "notices-dropped"] as const;

export type ViewNoticeCode = (typeof VIEW_NOTICE_CODES)[number] | "unknown";

/** How much of `detail` survives.
 *
 *  The bootstrap already truncates, and this truncates again rather than
 *  trusting it: a document that replaced the injected one can post straight to
 *  the parent, and it is not running our bootstrap at all. */
export const NOTICE_DETAIL_LIMIT = 300;

export interface ViewNotice {
  code: ViewNoticeCode;
  /** PAGE-AUTHORED and untrusted — an exception's message is whatever the HTML
   *  threw, and `throw new Error(someone@example.com)` is a sentence the page
   *  chose. A host showing this to anyone but the author must drop it; a host
   *  showing it to the author should mark where it came from. This module
   *  bounds its LENGTH and nothing else, because what is safe to show is a
   *  question about the reader, and the reader is the host's. */
  detail: string;
}

const isNoticeCode = (value: unknown): value is ViewNoticeCode => VIEW_NOTICE_CODES.some((code) => code === value);

/** A notice from the document we injected, or null.
 *
 *  Nonce-checked like `ready`, for the same reason and with a smaller
 *  consequence: only the injected bootstrap knows the value, so only it can
 *  report. A document that replaced it and guessed would gain the ability to
 *  lie in a diagnostic — not to read anything. */
export const readNotice = (data: unknown, nonce: string): ViewNotice | null => {
  if (!isRecord(data) || data.type !== VIEW_MESSAGE.notice) {
    return null;
  }
  if (typeof data.nonce !== "string" || data.nonce !== nonce) {
    return null;
  }
  const detail = typeof data.detail === "string" ? data.detail : "";
  return { code: isNoticeCode(data.code) ? data.code : "unknown", detail: detail.slice(0, NOTICE_DETAIL_LIMIT) };
};
