import {
  isReady,
  isRecord,
  readLookupMessage,
  readNotice,
  readSubmitMessage,
  type LookupAsk,
  type PendingSubmit,
  type SubmitRead,
  type ViewDataset,
  type ViewNotice,
  type ViewSubmitConfig,
} from "./message.js";
import { VIEW_MESSAGE } from "./protocol.js";

// The parent's side of the conversation with a sandboxed view.
//
// The rule this module exists to enforce: a message from the frame is a
// REQUEST, and a write happens only after `accept()` — which is wired to a
// control the parent draws, outside the iframe. The author's HTML can call
// submit the moment it loads, and all that produces is a confirmation the
// visitor can decline.
//
// `event.source` — the test that the message came from OUR frame — belongs to
// the component, because it is the only part that needs a DOM. Everything about
// WHEN a write happens is here, where it can be tested without an iframe.
//
// NO FRAMEWORK. This module held three `ref`s when it lived in mulmoserver, and
// keeping them would have made a compiler package depend on Vue — which the two
// hosts resolve separately, and two copies of Vue in one page is a reactivity
// bug that reads as "the confirmation never appears".
//
// So the HOST OWNS THE CELLS and passes them in. Not a factory: a factory would
// hand them back widened to `Signal<T>`, and a Vue template only unwraps a real
// `Ref` — the confirmation panel would have bound to an object with a `.value`
// on it and rendered nothing, which is the failure this whole module exists to
// prevent. Passing the cells in leaves their host types where the host can see
// them, and leaves this module owning only the rules.

/** One observable cell, as this module needs it. Vue's `Ref<T>` is one. */
export interface Signal<T> {
  value: T;
}

/** Everything this bridge tracks, created by the host so the host's own
 *  templates can bind to it. */
export interface BridgeCells {
  /** A submission awaiting the visitor's answer, drawn as the confirmation. */
  pending: Signal<PendingSubmit | null>;
  /** A write in flight. Not derived from `pending`: it is what makes decline
   *  refuse, and the two must not be able to disagree. */
  sending: Signal<boolean>;
  /** The document in the frame has answered on the channel. */
  readied: Signal<boolean>;
}

/** The error, as a string, without deciding what to do about it. Kept private
 *  and tiny rather than shared: every host already has this three-line function
 *  under its own name, and exporting a second one only invites a rename. */
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What a bridge does to the world: answer the frame, and write a record. Both
 *  injected, for the reason above. */
/** The private channel between the parent and ONE rendered document.
 *
 *  An interface rather than a `MessagePort` so the rule it exists to enforce
 *  can be tested without an iframe. The component builds one from a real
 *  `MessageChannel` and transfers the far end to the frame; everything about
 *  WHEN data may travel on it is here. */
export interface Channel {
  post: (message: Record<string, unknown>) => void;
  /** Whatever the far end sends back. */
  onMessage: (handler: (data: unknown) => void) => void;
  close: () => void;
}

/** What a bridge does to the world: open the channel, and write a record. Both
 *  injected, for the reason above. */
export interface BridgePorts {
  /** Create the channel and hand its far end to the frame. Called ONCE, in
   *  reply to a `ready` whose nonce checked out, and carrying NO data.
   *
   *  This is what closes the last way a replacement document could be handed
   *  the app's data. A window is addressed through `contentWindow`, which
   *  SURVIVES a navigation — so a fragment that calls the public `ready()` and
   *  navigates in the same tick would otherwise have the parent's reply land in
   *  whatever loaded next. A port belongs to the document that received it, and
   *  the data waits until something answers on it with the name only the
   *  injected document knows. */
  channel: () => Channel;
  submit: (pending: PendingSubmit) => Promise<{ ok: boolean; error?: string }>;
  state: () => Record<string, ViewDataset>;
  /** THE VISITOR'S OWN ROWS, per collection — what they have already submitted
   *  through this page, projected by the host to the fields a page in this
   *  position could have SENT.
   *
   *  Why it exists: a public view is handed `public.read` and nothing else, and
   *  a collection people submit to is exactly the one that must not be there
   *  (one visitor reading every other visitor's answer). So a view could not
   *  tell whether the person in front of it had already answered — it kept that
   *  in a variable, and a reload lost it. The page then offered an action the
   *  rules were certain to refuse, and the visitor met a permission error for
   *  behaving normally. The generated form has always read this back
   *  (`ownRow` grants a submitter their own row); this is the same answer for a
   *  page that replaced it.
   *
   *  Why the host projects rather than the bridge: what the rules return is the
   *  WHOLE document, including fields the app writes and the page never sees —
   *  a status, a staff note, an assignee. Handing those to sandboxed HTML would
   *  widen what a published page knows about the app, in the name of telling it
   *  something it already knew. The rule is "back what a page in this position
   *  could have sent", and the host holds it because the host is the one with
   *  the declaration in hand.
   *
   *  OPTIONAL BOTH WAYS, and absence is not "nothing was submitted": a host that
   *  does not offer the port at all, and one that offers it and answers
   *  `undefined` — it has not read yet, the read was refused — are saying the
   *  same thing, and it is not the same thing an empty array says. A page must
   *  read the difference as UNKNOWN: offer the action, and let the refusal
   *  explain itself. Otherwise it tells somebody they have already answered
   *  when they have not.
   *
   *  The second form is what a live host actually needs: whether it knows
   *  changes DURING a visit — nothing is known until the first read lands, and
   *  a device handed to the next person is back to knowing nothing about them
   *  until theirs does. */
  mine?: (() => Record<string, ViewDataset> | undefined) | undefined;
  /** The same question, asked about ONE key the page names — and the half that
   *  works where `mine` cannot.
   *
   *  `mine` is sent with the state, so the host has to know the answer before
   *  the page says anything. For `idFrom: "auth.uid+field"` it never can: the
   *  ids are `uid + "_" + <field>`, and the rules grant a submitter the document
   *  they can NAME rather than a range of them (a list would need the `{itemId}`
   *  wildcard bound, which never happens — mulmoserver's
   *  `test/rules/rules_ownReadback.ts` pins it). The key is exactly what the
   *  host is missing, and the page has it: it is showing that question.
   *
   *  So the answer is a READ the host performs on demand, with the visitor's own
   *  credentials, against an id it builds itself. A page cannot ask about
   *  anybody else — the uid half is not its to choose.
   *
   *  OPTIONAL, and a host without it answers `known: false`. Absence is
   *  "nobody looked", never "you have not answered". */
  lookup?: ((ask: LookupAsk) => Promise<{ found: boolean; record?: Record<string, unknown> }>) | undefined;
  /** Somewhere to put what the frame says about itself — an uncaught error, a
   *  rejected promise, a modal the sandbox ignored.
   *
   *  OPTIONAL, and the default of dropping them is the honest one: a notice is
   *  only worth carrying if the host has somewhere to put it that a person will
   *  read, and a host that keeps them where nobody looks has built a place for
   *  personal data to accumulate rather than a diagnostic. The public page may
   *  well never take this; the author's own preview is what it was built for.
   *
   *  What arrives has a code from a FIXED list and a bounded `detail` that the
   *  PAGE wrote (see `ViewNotice`). It is not the parent's word. */
  notice?: ((notice: ViewNotice) => void) | undefined;
}

/** Why this message will not become a confirmation, or null when it will.
 *
 *  `busy` is the one that is not about the message: a second request while a
 *  confirmation is open would swap the values under the visitor's cursor, so
 *  the click they are about to make would land on a different write. */
const refusalFor = (read: SubmitRead, open: boolean): { requestId: string; reason: string } | null => {
  if (!read.ok) {
    return { requestId: read.requestId, reason: read.reason };
  }
  if (open) {
    return { requestId: read.pending.requestId, reason: "busy" };
  }
  return null;
};

/** The state message, as the two send sites build it identically.
 *
 *  `viewer` is omitted rather than sent empty when the host offers no `mine`.
 *  The bootstrap hands the second argument to `onState` either way, so an empty
 *  object would reach a page as "you have submitted nothing" — which is a
 *  different statement from "this host does not know", and the wrong one to
 *  make up. */
const stateMessage = (ports: BridgePorts) => {
  const mine = ports.mine?.();
  const collections = ports.state();
  if (mine === undefined) {
    return { type: VIEW_MESSAGE.state, collections };
  }
  return { type: VIEW_MESSAGE.state, collections, viewer: { mine } };
};

/** Answering the frame: the two messages the parent sends, and the rule that
 *  state is only ever sent to a view that asked for it once. */
const replies = (ports: BridgePorts, nonce: () => string, readied: Signal<boolean>) => {
  /** The channel, once the document that received it has answered on it. */
  let open: Channel | null = null;
  /** Offered and not yet answered. Kept so a second `ready` does not offer
   *  another one — a frame that navigated keeps answering to `event.source`. */
  let offered: Channel | null = null;

  const answer = (requestId: string, ok: boolean, error?: string) => {
    open?.post({ type: VIEW_MESSAGE.result, requestId, ok, error });
  };

  /** The answer to a `lookup`. Its own message name, because `{ known, found }`
   *  answers a different question from `{ ok, error }` and a page settling one
   *  as the other would read "not found" as "refused". */
  const answerLookup = (requestId: string, found: { known: boolean; found: boolean; record?: Record<string, unknown> }) => {
    open?.post({ type: VIEW_MESSAGE.lookupResult, requestId, ...found });
  };

  const sendState = () => {
    // Nothing before the document has answered on the channel — and the channel
    // belongs to the document that answered, so nothing reaches one that
    // replaced it.
    if (!readied.value) {
      return;
    }
    open?.post(stateMessage(ports));
  };

  /** A `ready` whose nonce checked out. The reply is the CHANNEL and nothing
   *  else; the data waits for an answer on it. */
  const greet = (onRequest: (data: unknown) => void) => {
    if (readied.value || offered !== null) {
      return;
    }
    const channel = ports.channel();
    offered = channel;
    channel.onMessage((data) => {
      if (!isRecord(data)) {
        return;
      }
      // The window carries exactly ONE thing this page acts on — `ready` — and
      // everything the view ASKS for arrives here, because the injected bridge
      // sends on the port from the moment it has one. Routing it was missing:
      // the handshake was answered and every submission after it was dropped,
      // so the visitor's page sat on a promise that never settled and no
      // confirmation was ever drawn. Nothing said so; a submit is a request
      // with no timeout.
      if (open === channel) {
        onRequest(data);
        return;
      }
      // The name only the injected document knows, echoed on the port it was
      // handed. A document that merely INHERITED the frame cannot send it.
      if (data.nonce !== nonce()) {
        return;
      }
      open = channel;
      readied.value = true;
      channel.post(stateMessage(ports));
    });
  };

  /** A new view was published, or the page moved to another app. The frame is
   *  replaced, so the conversation starts again: the next `ready` is a real
   *  first one and must be answered, or the new view sits there with no data.
   *  The previous channel is closed — whatever holds its far end is a document
   *  we are no longer talking to. */
  const forget = () => {
    offered?.close();
    open = null;
    offered = null;
    readied.value = false;
  };

  return { answer, answerLookup, sendState, greet, forget };
};

/** Everything that arrives FROM the frame, both ways in.
 *
 *  The window carries exactly one thing this page acts on — `ready` — and the
 *  port carries every request the view makes after it, because the injected
 *  bridge sends on the port from the moment it has one. So the same dispatch is
 *  handed to `greet`, and a submission is read the same way whichever door it
 *  came through. Routing the port was missing: the handshake was answered and
 *  every submission after it was dropped, leaving the visitor's page on a
 *  promise that never settled and no confirmation drawn — a submit has no
 *  timeout, so nothing anywhere said so. */
const incoming = (deps: {
  nonce: () => string;
  config: () => ViewSubmitConfig | null;
  pending: Signal<PendingSubmit | null>;
  answer: (requestId: string, ok: boolean, error?: string) => void;
  /** Settle a lookup the page is waiting on, in the shape a lookup is answered
   *  in. Separate from `answer` because a refusal must not arrive as one:
   *  see `dispatch`. */
  answerLookup: (requestId: string, found: { known: boolean; found: boolean }) => void;
  look: (ask: LookupAsk) => void;
  greet: (onRequest: (data: unknown) => void) => void;
  notice: (notice: ViewNotice) => void;
}) => {
  /** A submission the frame sent, once it is known to be one. */
  const offer = (read: SubmitRead) => {
    const refusal = refusalFor(read, deps.pending.value !== null);
    if (refusal === null && read.ok) {
      deps.pending.value = read.pending;
      return;
    }
    // A refusal with a request id is an authoring mistake in the HTML; one
    // without is not a submission at all, and answering it would be answering
    // something nobody asked.
    if (refusal !== null && refusal.requestId !== "") {
      deps.answer(refusal.requestId, false, refusal.reason);
    }
  };
  /** A read the page asked for, or a refusal it can act on.
   *
   *  Judged BEFORE the message is read as a submission: the two are told apart
   *  by their type, and a lookup put through `readSubmitMessage` would come back
   *  as "not a submission" and be answered by nobody — a promise the page waits
   *  on forever, which is the failure mode a read has no timeout to escape. */
  const dispatch = (data: unknown) => {
    const asked = readLookupMessage(data, deps.config());
    if (asked.ok) {
      deps.look(asked.ask);
      return;
    }
    if (asked.reason !== "not-a-lookup") {
      // ANSWERED AS A LOOKUP, not as a result. The page is waiting in `mine()`,
      // which settles on `lookupResult` and reads `{ known, found }`; a
      // `result` carrying `{ ok: false }` reaches it with no `known` at all,
      // which is the shape a page cannot tell apart from "nobody looked" — so
      // an author's mistake in the HTML arrived as the parent's silence. Both
      // refusals here mean the same thing to the page: nothing was read, so
      // nothing is known. WHY it was refused belongs to the author, and a
      // published page has no use for it.
      deps.answerLookup(asked.requestId, { known: false, found: false });
      return;
    }
    offer(readSubmitMessage(data, deps.config()));
  };
  /** A message that has already been proven to come from our frame. */
  return (data: unknown) => {
    // BEFORE the handshake is even considered, because the notices that matter
    // most arrive before it: a page whose script throws while the document is
    // being parsed never reaches `ready()`, and that page — stuck on its
    // loading state, with the reason inside the frame — is the one an author
    // cannot otherwise diagnose. Read first, too, or `dispatch` would judge a
    // notice as a submission and answer nobody.
    const notice = readNotice(data, deps.nonce());
    if (notice !== null) {
      deps.notice(notice);
      return;
    }
    if (isReady(data, deps.nonce())) {
      deps.greet(dispatch);
      return;
    }
    dispatch(data);
  };
};

export const viewBridge = (ports: BridgePorts, config: () => ViewSubmitConfig | null, nonce: () => string, cells: BridgeCells) => {
  const { pending, sending } = cells;
  const { answer, answerLookup, sendState, greet, forget } = replies(ports, nonce, cells.readied);

  /** Answer "have I already got this row?" — with a READ, and never with a guess.
   *
   *  Three outcomes and only one of them is "no": the host offers no port
   *  (nobody looked), the read threw (nobody knows), or the read came back. The
   *  first two are `known: false`, because a page told "no" stops offering the
   *  action to somebody entitled to it — and that is the bug this whole port
   *  exists to fix, arriving from the other direction. */
  const look = async (ask: LookupAsk) => {
    const port = ports.lookup;
    if (port === undefined) {
      answerLookup(ask.requestId, { known: false, found: false });
      return;
    }
    // Called inside a promise so a host that throws SYNCHRONOUSLY is caught here too. Without it
    // the throw escapes `look` as an unhandled rejection and the page is never answered — the same
    // hang as an unroutable message, arriving from the host's side.
    const found = await Promise.resolve()
      .then(() => port(ask))
      .catch(() => null);
    if (found === null) {
      answerLookup(ask.requestId, { known: false, found: false });
      return;
    }
    // Spread rather than naming `record`: `exactOptionalPropertyTypes` is on, and an explicit
    // `record: undefined` is a different thing from a key that was never there.
    answerLookup(ask.requestId, { known: true, ...found });
  };

  /** One place where a confirmation stops being open, so the two refs cannot
   *  drift apart. */
  const settle = () => {
    sending.value = false;
    pending.value = null;
  };

  const receive = incoming({ nonce, config, pending, answer, answerLookup, look, greet, notice: (report) => ports.notice?.(report) });

  const accept = async () => {
    const request = pending.value;
    if (request === null || sending.value) {
      return;
    }
    sending.value = true;
    // A THROW here is the dangerous case, not a failed write: the write may
    // already have succeeded and the refresh that follows it may be what
    // failed. Without this the confirmation would stay open and disabled
    // forever, over a booking that went through.
    const outcome = await ports.submit(request).catch((err: unknown) => ({ ok: false, error: messageOf(err) }));
    settle();
    answer(request.requestId, outcome.ok, outcome.error);
    // Either it took something or it learned somebody else had; both make the
    // view's picture older than the truth.
    sendState();
  };

  const decline = () => {
    // NOT while a write is in flight. The buttons are disabled then, but
    // Escape is not a button: cancelling here would answer the view
    // "cancelled" while the record is still being written, and a booking that
    // then succeeds would have been reported as declined. There is no way to
    // recall a Firestore write, so the honest thing is to make the visitor
    // wait for the answer they already asked for.
    const request = pending.value;
    if (request === null || sending.value) {
      return;
    }
    settle();
    answer(request.requestId, false, "cancelled");
  };

  /** Everything that belongs to ONE rendered view. Called when the HTML is
   *  replaced: a confirmation still open refers to a page the visitor can no
   *  longer see, and the `ready` count belongs to the frame that is going. */
  const restart = () => {
    settle();
    forget();
  };

  // The cells are NOT returned. The host made them and already holds them;
  // handing them back would only invite a second name for one cell.
  return { receive, accept, decline, sendState, restart };
};
