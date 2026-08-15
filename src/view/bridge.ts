import {
  isReady,
  isRecord,
  readNotice,
  readSubmitMessage,
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

  const sendState = () => {
    // Nothing before the document has answered on the channel — and the channel
    // belongs to the document that answered, so nothing reaches one that
    // replaced it.
    if (!readied.value) {
      return;
    }
    open?.post({ type: VIEW_MESSAGE.state, collections: ports.state() });
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
      channel.post({ type: VIEW_MESSAGE.state, collections: ports.state() });
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

  return { answer, sendState, greet, forget };
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
  const dispatch = (data: unknown) => offer(readSubmitMessage(data, deps.config()));
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
  const { answer, sendState, greet, forget } = replies(ports, nonce, cells.readied);

  /** One place where a confirmation stops being open, so the two refs cannot
   *  drift apart. */
  const settle = () => {
    sending.value = false;
    pending.value = null;
  };

  const receive = incoming({ nonce, config, pending, answer, greet, notice: (report) => ports.notice?.(report) });

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
