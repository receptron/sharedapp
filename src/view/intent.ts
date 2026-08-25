import { isRecord } from "./message.js";
import { VIEW_MESSAGE } from "./protocol.js";
import { capabilityOf, mayTransition, type WriteTier } from "./capability.js";
import type { ProjectedViewWrite } from "../appViews.js";
import { mailFor, type QueuedMail } from "./intentMail.js";

// What the parent will accept from a member's or a participant's view, and what
// it will do about it.
//
// mulmoterminal plans/feat-shared-app-member-write.md. Everything here judges a
// message against the PROJECTION rather than against what the message says
// about itself, exactly as the public path does — but the reason is different
// enough to write down.
//
// On the public page, validation stands between a stranger and the owner's
// data. Here the person pressing the button is on the owner's roster and the
// rules already bound them; a refusal produced here is not what makes the write
// safe, and pretending otherwise would be the wrong mental model for the next
// person to change it. What it buys instead:
//
//   A NAME FOR THE REFUSAL. The rules answer with a bare permission error that
//   says nothing about which assumption in the page is wrong, and the author is
//   never the person holding the phone.
//
//   A CLOSED VOCABULARY. A transition moves one declared field, an assignment
//   moves one other, and a withdrawal takes the reader's own row away. Three
//   named things, and no general patch.
//   The rules would allow a general patch just as readily — an editor may write
//   the whole record — so what this stops is not an attacker but a BUG:
//   a mis-wired button reaching as far as the member's role does, with nothing
//   above able to say what happened.

/** The things a view may ask for. A closed set, and the reason it is closed is
 *  above.
 *
 *  `withdraw` names no `to`, because it moves nothing: with `idFrom: "field"`
 *  the record's id IS the exclusivity, so a cancelled booking goes on holding
 *  the slot. It is the only ask that gives it back, by deleting the row and
 *  reopening the mirror in one batch. */
export type IntentKind = "transition" | "assign" | "withdraw";

/** What the view asked, once it has survived judgement: one field, one value,
 *  and the record they belong to. */
export interface JudgedIntent {
  requestId: string;
  kind: IntentKind;
  cid: string;
  itemId: string;
  /** The field this intent moves — `statusField` or `assigneeField`. Absent on
   *  a withdrawal, which moves nothing. */
  field?: string;
  to?: string;
  /** `withdraw` only: the projection collection to reopen in the same batch.
   *  Absent where the app declares no mirror, which is one delete and no
   *  second write. */
  mirror?: string;
  /** The mail this transition queues, if the declaration names one for it. In
   *  the SAME batch as the record: see {@link mailFor}. */
  mail?: QueuedMail;
}

/** Why an intent was not performed. Returned rather than thrown: the view is
 *  waiting on a specific request, and silence looks like a dead button. */
export type IntentRefusal =
  | "not-an-intent"
  /** The page asked about a collection its own view never declared. */
  | "unknown-collection"
  /** Nothing of this kind is writable here — no status field, no assignee
   *  field. For a participant's page this is the common one: the staff
   *  transitions are not in their projection at all. */
  | "not-writable"
  /** The declared table does not carry this move from where the record is, or
   *  — for a withdrawal — the record is in a status the declaration does not
   *  let its submitter take it away from. */
  | "illegal-transition"
  /** An address nobody on the roster holds an assignable role at. Writing it
   *  produces a row NOBODY may touch afterwards. */
  | "unknown-assignee"
  /** The collection allows it and THIS reader may not: a `viewer`, or an
   *  assignee reaching for a colleague's row. The tier admits everybody
   *  holding a role anywhere, so being handed the page is not permission —
   *  see `appCapability`. */
  | "not-permitted";

/** The intent as the view stated it, before anything was judged. Carried on a
 *  REFUSAL as well, so the line the page writes about what just happened can
 *  name the record — a refusal the reader cannot place is barely better than
 *  silence. */
export interface AskedIntent {
  requestId: string;
  kind: IntentKind;
  cid: string;
  itemId: string;
  /** Absent on a withdrawal. */
  to?: string;
}

/** What the parent sends back on the channel. `error` carries a refusal name
 *  when this page produced one, and whatever the rules said when they did. */
export interface IntentAnswer {
  requestId: string;
  ok: boolean;
  error?: string;
}

/** One message, read.
 *
 *  THREE branches rather than two, and the third is the point: a message that is not an intent at
 *  all carries no request id, so it has none to be answered on — and answering it would be
 *  answering something nobody asked. That used to be one refusal branch with `requestId: ""`
 *  fabricated to satisfy the type, which no caller read but every caller was invited to. Splitting
 *  it makes replying to a non-request impossible rather than discouraged. */
export type IntentRead =
  | { ok: true; intent: JudgedIntent }
  | { ok: false; reason: "not-an-intent" }
  | { ok: false; reason: Exclude<IntentRefusal, "not-an-intent">; requestId: string; asked: AskedIntent };

const NOT_AN_INTENT = { ok: false, reason: "not-an-intent" } as const;

/** The record cannot make the move being asked for — a status the table does
 *  not carry, or a withdrawal from a status the declaration does not name. */
const ILLEGAL = { ok: false, reason: "illegal-transition" } as const;

/** Nothing of this kind is writable here: no status field and table, no
 *  assignee field, no declared withdrawal. */
const NOT_WRITABLE = { ok: false, reason: "not-writable" } as const;

const isKind = (value: unknown): value is IntentKind => value === "transition" || value === "assign" || value === "withdraw";

/** Is this an intent at all? Separate from judging one, because a message that
 *  is not gets NO answer — replying would be answering something nobody
 *  asked. */
const askedOf = (data: Record<string, unknown>, kind: IntentKind, requestId: string): AskedIntent | null => {
  if (typeof data.cid !== "string" || typeof data.itemId !== "string") {
    return null;
  }
  const asked = { requestId, kind, cid: data.cid, itemId: data.itemId };
  // A withdrawal names no destination, and one that arrives carrying a `to` is
  // not a withdrawal with extra decoration — it is a page asking for something
  // this parent cannot describe, so it is not read as an intent at all.
  if (kind === "withdraw") {
    if (data.to !== undefined) {
      return null;
    }
    return asked;
  }
  if (typeof data.to !== "string") {
    return null;
  }
  return { ...asked, to: data.to };
};

const asIntent = (data: unknown): AskedIntent | null => {
  if (!isRecord(data) || data.type !== VIEW_MESSAGE.intent) {
    return null;
  }
  if (typeof data.requestId !== "string" || !isKind(data.kind)) {
    return null;
  }
  return askedOf(data, data.kind, data.requestId);
};

/** The record this intent is about, as the page last received it. Null when the
 *  view is asking about something outside the dataset it was handed. */
export type RecordLookup = (cid: string, itemId: string) => Record<string, unknown> | null;

/** The transition half.
 *
 *  The current status comes from the dataset the page holds, which CAN BE
 *  STALE — somebody else may have approved the same booking a second ago. That
 *  is fine and is worth being explicit about: this table catches a button that
 *  should never have been drawn, and the rules catch the race. The authority
 *  stays in one place. With no record to compare against, nothing is claimed
 *  here and the rules answer alone. */
/** What one half of the judgement decided: the field to move, or why not. */
type Judged = { ok: true; field?: string; mail?: QueuedMail; mirror?: string } | { ok: false; reason: IntentRefusal };

/** The status the page believes this record is in, or null when it holds no
 *  such record — which is not the same as "no status" and is not treated as
 *  one: with nothing to compare against, the move is left to the rules. */
const statusHeld = (record: Record<string, unknown> | null, field: string): string | null => {
  const current = record?.[field];
  if (typeof current !== "string") {
    return null;
  }
  return current;
};

/** The move itself, once the field and the status the record is in are both
 *  known. The notice rides along with it — same batch, because the rules
 *  compare the record before and after and would refuse a separate one. */
const judgeMove = (write: ProjectedViewWrite, field: string, record: Record<string, unknown> | null, from: string, to: string): Judged => {
  if (!(write.transitions?.[from] ?? []).includes(to)) {
    return ILLEGAL;
  }
  const mail = mailFor(write.mail, record, from, to);
  if (mail === undefined) {
    return { ok: true, field };
  }
  return { ok: true, field, mail };
};

const judgeTransition = (write: ProjectedViewWrite, asked: { to?: string }, record: Record<string, unknown> | null, who: Who): Judged => {
  // The destination is guaranteed by `asIntent` — a move without one is not
  // read as an intent at all. Restated here because the type carries the
  // withdrawal's absence, and a floor that agrees with the reader beats a
  // non-null assertion nobody can check.
  if (asked.to === undefined) {
    return ILLEGAL;
  }
  if (write.statusField === undefined || write.transitions === undefined) {
    return NOT_WRITABLE;
  }
  if (!mayTransition(capabilityOf(write, who.address, who.tier), write, record, who.address)) {
    return { ok: false, reason: "not-permitted" };
  }
  const current = statusHeld(record, write.statusField);
  if (current === null) {
    return { ok: true, field: write.statusField };
  }
  return judgeMove(write, write.statusField, record, current, asked.to);
};

/** The assignment half. `assignees` is the roster's answer to "who may hold
 *  this", projected into the staff tier because the person reassigning cannot
 *  read the roster themselves. */
const judgeAssign = (write: ProjectedViewWrite, asked: { to?: string }, who: Who): Judged => {
  if (write.assigneeField === undefined || asked.to === undefined) {
    return NOT_WRITABLE;
  }
  const capability = capabilityOf(write, who.address, who.tier);
  if (!capability.assign) {
    // An assignee cannot hand a row on: the rules require it to be theirs
    // BEFORE and AFTER, which no handover satisfies.
    return { ok: false, reason: "not-permitted" };
  }
  if (!capability.assignees.includes(asked.to)) {
    return { ok: false, reason: "unknown-assignee" };
  }
  return { ok: true, field: write.assigneeField };
};

/** Whatever else was decided, the mirror rides with it: the rules ask
 *  `mirrorReleased` before they ask who is deleting, so a delete that leaves
 *  the projection saying `taken` is refused whoever made it. */
const withdrawn = (write: ProjectedViewWrite): Judged => {
  if (write.withdrawMirror === undefined) {
    return { ok: true };
  }
  return { ok: true, mirror: write.withdrawMirror };
};

/** The withdrawal half, and it answers TWO different permissions.
 *
 *  A WRITER takes any row away, in any status — `deleteWith`'s first branch is
 *  `isWriter(r)` and asks nothing about the record — so there is no list to
 *  compare and no status to hold it against. The capability resolves the role;
 *  see `ProjectedViewWrite.writerDelete` for why it carries no statuses.
 *
 *  A SUBMITTER takes their OWN row away, from the statuses `selfDelete` names,
 *  which the rules read. That is the list below, checked against the status the
 *  page holds — and, like a transition, a page holding no such record claims
 *  nothing. Whether the row is theirs is not checked here at all: `ownRow`
 *  compares an address the projection deliberately does not carry. That one is
 *  the rules' to answer.
 *
 *  The refusals are different too. A staff page whose collection declares
 *  `writerDelete` and whose reader is a `viewer` is `not-permitted` — the
 *  control exists and is not theirs — where a collection that declares neither
 *  is `not-writable`. Both used to be `not-writable`, which sent the author of
 *  the page to the declaration when the answer was the roster. */
const judgeWithdraw = (write: ProjectedViewWrite, record: Record<string, unknown> | null, who: Who): Judged => {
  // BEFORE either permission, because it overrides both. `sealedNow` in the
  // rules refuses a delete from these statuses whoever asked — the owner
  // included — so approving here would hand a page a call that is certain to
  // come back a permission denial, which is the one thing this layer exists to
  // stop. `writerDelete` in particular says "any row" and means "any row the
  // record itself has not sealed".
  //
  // `illegal-transition` rather than `not-permitted`: the refusal is about the
  // state this row is IN, not about who is asking, and that is exactly the
  // sentence the status-out-of-range branch below already says.
  if (write.statusField !== undefined && (write.sealed ?? []).length > 0) {
    const held = statusHeld(record, write.statusField);
    if (held !== null && (write.sealed ?? []).includes(held)) {
      return ILLEGAL;
    }
  }
  if (capabilityOf(write, who.address, who.tier).withdrawAny) {
    return withdrawn(write);
  }
  const allowed = write.selfDelete ?? [];
  if (write.statusField === undefined || allowed.length === 0) {
    // `writerDelete` is asked HERE rather than before the submitter's half,
    // because a collection may declare both: a reader who is not a writer still
    // takes their own row away, and refusing them on the staff declaration
    // denied a delete the rules grant (`isWriter(r) || selfDelete(...)`). So it
    // only answers where there is no submitter's half to fall through to — the
    // control exists and is not theirs, which is a different sentence from "no
    // such control", and that one sends the page's author to the declaration.
    return write.writerDelete === true ? { ok: false, reason: "not-permitted" } : NOT_WRITABLE;
  }
  const current = statusHeld(record, write.statusField);
  if (current !== null && !allowed.includes(current)) {
    return ILLEGAL;
  }
  return withdrawn(write);
};

const judge = (declared: ProjectedViewWrite, asked: AskedIntent, record: RecordLookup, who: Who): Judged => {
  if (asked.kind === "assign") {
    return judgeAssign(declared, asked, who);
  }
  if (asked.kind === "withdraw") {
    return judgeWithdraw(declared, record(asked.cid, asked.itemId), who);
  }
  return judgeTransition(declared, asked, record(asked.cid, asked.itemId), who);
};

/** The judged halves put back together. Its own step so the optional notice is
 *  attached in one place rather than by a spread that would carry an
 *  `undefined` key into the write. */
const intentOf = (asked: AskedIntent, judged: { field?: string; mail?: QueuedMail; mirror?: string }): JudgedIntent => {
  const intent: JudgedIntent = { ...asked };
  if (judged.field !== undefined) intent.field = judged.field;
  if (judged.mail !== undefined) intent.mail = judged.mail;
  if (judged.mirror !== undefined) intent.mirror = judged.mirror;
  return intent;
};

/** One message, judged against what this audience's projection says is
 *  writable. */
/** Who is asking, and which tier's page they are asking from — the pair every
 *  capability question needs, since the tier is what decides what a projection
 *  carrying no roles MEANS. */
export interface Who {
  address: string;
  tier: WriteTier;
}

export const readIntentMessage = (data: unknown, write: ProjectedViewWrite[], record: RecordLookup, who: Who): IntentRead => {
  const asked = asIntent(data);
  if (asked === null) {
    return NOT_AN_INTENT;
  }
  const declared = write.find((entry) => entry.cid === asked.cid);
  if (declared === undefined) {
    return { ok: false, reason: "unknown-collection", requestId: asked.requestId, asked };
  }
  const judged = judge(declared, asked, record, who);
  if (!judged.ok) {
    return { ok: false, reason: judged.reason, requestId: asked.requestId, asked };
  }
  return { ok: true, intent: intentOf(asked, judged) };
};
