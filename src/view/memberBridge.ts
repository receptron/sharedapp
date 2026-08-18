import { isReady, isRecord, readNotice, type ViewDataset, type ViewNotice } from "./message.js";
import { VIEW_MESSAGE } from "./protocol.js";
import type { Channel, Signal } from "./bridge.js";
import type { Viewer } from "./capability.js";
import type { IntentAnswer } from "./intent.js";

// The parent's side of the conversation with a MEMBER's view — the roster
// (`/m/`) and participant (`/p/`) pages, and the author's preview of both.
//
// It is a second bridge rather than a flag on `viewBridge`, because the two
// differ in what a request MEANS. On the public page a submission is a stranger
// proposing a new record, so it becomes a confirmation the visitor presses; the
// parent draws it and nothing is written until they do. Here the reader is on
// the owner's roster and the record already exists — approve this booking, hand
// it to somebody else, cancel my own — so the ask is an INTENT, judged against
// the projection and performed. Folding both into one factory would put the
// confirmation machinery in front of a member's button (a second press for
// something they already pressed) or make `pending` mean two things.
//
// WHAT IS SHARED IS THE HANDSHAKE, and it is shared by being identical rather
// than by being called: `ready` with the right nonce is answered with a CHANNEL
// and nothing else, and the data waits until the document that received the
// port answers on it. Every reason for that is in `bridge.ts` and applies here
// unchanged — a window is addressed through `contentWindow`, which survives a
// navigation, so a fragment that calls `ready()` and navigates in the same tick
// would otherwise be handed the app's records.
//
// NO FRAMEWORK, for `bridge.ts`'s reason: this package is a compiler and the
// two hosts resolve Vue separately. The host owns the DOM and passes the parts
// in.
//
// A VIEW LEFT WAITING LOOKS LIKE A DEAD BUTTON. So a message this parent will
// not act on is REFUSED rather than dropped — including on a page that passes
// no `perform` at all, which is genuinely read-only and says so in one word,
// and including a `perform` that REJECTS. A host is supposed to turn a failed
// write into an answer, so a rejection arriving here is a defect rather than
// something a member did — but a defect that drops the rejection is a promise
// in the view that never settles again, which is the dead button with no way
// left to find out why. It is answered with a fixed code instead, and the
// reason goes to the host.

/** What this parent does about an intent. Null means "not something anybody
 *  asked to be answered"; anything else is answered on the channel it arrived
 *  on. */
export type PerformIntent = (data: unknown) => Promise<IntentAnswer | null>;

/** With no handler, every request is refused in one word. Not silence: see the
 *  note above. */
export const refuseEverything: PerformIntent = (data) => {
  if (!isRecord(data) || typeof data.requestId !== "string") {
    return Promise.resolve(null);
  }
  return Promise.resolve({ requestId: data.requestId, ok: false, error: "read-only" });
};

/** What a view is told when `perform` broke instead of answering.
 *
 *  ONE FIXED WORD, and never the exception. The page is the author's; why the
 *  host failed is not — a message off a Firestore client or a stack from a
 *  parent the author never wrote is internal detail arriving in a document that
 *  can put it on screen or post it anywhere. It is also not actionable: nothing
 *  a member can press fixes it. So the view learns that this request will not
 *  be answered any other way, in a name it can match on, and the reason goes to
 *  the host through `defect`.
 *
 *  PERMANENT, like the rest of the wire vocabulary: published pages compare
 *  this string. */
export const HOST_ERROR = "host-error";

/** The id an answer would go back on, or null when the message carries none —
 *  in which case nobody is waiting on a reply and posting one would be
 *  answering something nobody asked. Same rule as {@link refuseEverything}. */
const answerId = (data: Record<string, unknown>): string | null => (typeof data.requestId === "string" && data.requestId !== "" ? data.requestId : null);

/** What a view is told about a request this parent has no answer for.
 *
 *  Distinct from {@link HOST_ERROR}, which says the host BROKE: this one says
 *  the request was understood well enough to know nobody here serves it — a
 *  bootstrap call a member page may make and a roster does not implement.
 *  Dropping it instead left the page on a promise that never settles, which is
 *  a button that does nothing with no way left to find out why. Also
 *  PERMANENT, and for the same reason: published pages compare it. */
export const UNSUPPORTED_REQUEST = "unsupported-request";

/** `perform` as a promise even when it throws on the way to returning one — a
 *  host that throws synchronously would otherwise take the channel's message
 *  handler down with it, which is the same lost request by a shorter route.
 *  No extra turn: the returned promise is passed straight through. */
const performed = (perform: PerformIntent, data: unknown): Promise<IntentAnswer | null> => {
  try {
    return perform(data);
  } catch (error) {
    return Promise.reject(error);
  }
};

export interface MemberBridgePorts {
  /** Create the channel and hand its far end to the frame. Called ONCE, in
   *  reply to a `ready` whose nonce checked out, and carrying NO data — see
   *  the header. */
  channel: () => Channel;
  /** The records this page was handed, by collection. */
  state: () => Record<string, ViewDataset>;
  /** WHO this reader is and what they may change, with the roles already
   *  resolved — so the page draws the buttons that exist and no others, on the
   *  rows they apply to.
   *
   *  The page is NOT trusted to obey it. The same answer is applied again to
   *  every intent, and the rules answer after that. */
  viewer: () => Viewer;
  /** The document in the frame has answered on the channel, for a host that needs to SEE it.
   *
   *  Optional and owned by the host, exactly as `BridgeCells.readied` is for the public bridge —
   *  and it is not bookkeeping. Both of this package's previewing hosts report the handshake:
   *  MulmoTerminal's pane logs it, and its headless run puts "It NEVER answered the handshake" at
   *  the top of a page's report, above a paragraph saying nothing below describes the page's
   *  behaviour. Without somewhere to write this, every healthy member page is reported that way —
   *  a false red about the one thing an author cannot check any other way. */
  readied?: Signal<boolean> | undefined;
  /** Somewhere to put what the frame says about itself — an uncaught error, a rejected promise,
   *  a modal the sandbox ignored.
   *
   *  A HOOK, and optional, exactly as `BridgePorts.notice` is: the notice is the page's own words
   *  and only worth carrying where the host has somewhere a person will read it. mulmoserver drops
   *  them (a member on a phone cannot act on a stack trace); MulmoTerminal's pane keeps them,
   *  because its reader is the author who is trying to fix the page.
   *
   *  It is not a nicety. The notices that matter most arrive BEFORE the handshake — a page whose
   *  script throws while the document is being parsed never reaches `ready()` — and that page,
   *  stuck on its loading state with the reason sealed inside the frame, is the one nobody can
   *  otherwise diagnose. */
  notice?: ((notice: ViewNotice) => void) | undefined;
  /** What to do about an intent. Omitted, the page is read-only.
   *
   *  A GETTER, like the two above and for the same reason: a host holding this
   *  in a reactive prop can have it replaced under the bridge, and a handler
   *  captured once would judge a later intent with the app that was on screen
   *  before. */
  perform?: (() => PerformIntent | undefined) | undefined;
  /** Where a defect of the HOST'S OWN goes: `perform` rejected, or threw before
   *  it returned a promise.
   *
   *  Not `notice`, which carries what the FRAME said about itself and is the
   *  author's to read. This is the other direction — the parent failed, in code
   *  the author did not write — so it is a separate hook whose reader is
   *  whoever runs the host: a log line, a Sentry event, a failing test.
   *
   *  REQUIRED, alone among the optional ports here, and that is the whole
   *  point of the port. `notice` and `readied` are optional because a host with
   *  nowhere to put them is making a real choice — a notice is the page's own
   *  words, and keeping them where nobody looks builds a place for personal
   *  data to sit. This one is the opposite: it is the host's own bug, and a
   *  host that never thought about it is exactly the host this bridge used to
   *  drop the exception for. Optional, it would compile unchanged everywhere
   *  and the defect would go on being invisible — the second half of what this
   *  port exists to end, once the promise settles. A host that genuinely wants
   *  to discard it writes `defect: () => {}` and has then SAID so.
   *
   *  Nothing is done with the error here: this package has no console and no
   *  clock, and the view is answered before this is called either way.
   *
   *  `requestId` is the id the answer went back on, or null when the message
   *  carried none and nothing could be answered. */
  defect: (error: unknown, requestId: string | null) => void;
}

export const memberBridge = (ports: MemberBridgePorts, nonce: () => string) => {
  let open: Channel | null = null;
  let offered: Channel | null = null;

  const sendState = (): void => {
    open?.post({ type: VIEW_MESSAGE.state, collections: ports.state(), viewer: ports.viewer() });
  };

  const answered = (channel: Channel, data: unknown): void => {
    if (!isRecord(data)) {
      return;
    }
    // The name only the injected document knows, echoed on the port it was
    // handed. A document that merely INHERITED the frame cannot send it.
    if (data.nonce === nonce()) {
      open = channel;
      if (ports.readied !== undefined) ports.readied.value = true;
      sendState();
      return;
    }
    /** THE ONE REQUEST THIS PARENT ANSWERS BY ITSELF, and the only one it can:
     *  `view.mine(cid, key)`.
     *
     *  One bootstrap serves both pages, so a member view holds the public view's
     *  whole vocabulary — a lookup among it. There is no port here that performs
     *  one (`bridge.ts` has `lookup`; this module has `perform`, which reads
     *  INTENTS), so the honest answer is `known: false`: nobody looked.
     *
     *  ANSWERED BEFORE `perform` IS CONSULTED, and that placement is the whole
     *  fix rather than a shortcut. Every handler this parent can be given answers
     *  in the INTENT shape — `refuseEverything` says `{ ok: false, error:
     *  "read-only" }`, and a host's own handler returns an `IntentAnswer` — so
     *  routing a lookup through any of them settles `mine()` with an object that
     *  has no `known` on it at all. The page cannot tell that from "nobody
     *  looked", which is the one answer that must never be guessed: read as "you
     *  have already answered", it takes the action away from somebody entitled to
     *  it. Settling it here means the shape does not depend on which handler the
     *  host happened to pass, or on whether it passed one.
     *
     *  A request id is still required. Without one nobody is waiting, and posting
     *  would be answering something nobody asked. */
    if (data.type === VIEW_MESSAGE.lookup) {
      const asked = answerId(data);
      if (asked !== null) {
        channel.post({ type: VIEW_MESSAGE.lookupResult, requestId: asked, known: false, found: false });
      }
      return;
    }
    const perform = ports.perform?.() ?? refuseEverything;
    performed(perform, data).then(
      (answer) => {
        // The channel the request arrived on, not `open`: the two are the same
        // channel today, and answering the one that asked is the property worth
        // keeping if that ever stops being true.
        if (answer !== null) {
          channel.post({ type: VIEW_MESSAGE.result, ...answer });
          return;
        }
        // Null means `perform` did not recognise it — not that nobody is
        // waiting. A request id says somebody is, and the only way they learn
        // otherwise is if we say so. See {@link UNSUPPORTED_REQUEST}.
        const requestId = answerId(data);
        if (requestId !== null) {
          channel.post({ type: VIEW_MESSAGE.result, requestId, ok: false, error: UNSUPPORTED_REQUEST });
        }
      },
      (error: unknown) => {
        const requestId = answerId(data);
        if (requestId !== null) {
          channel.post({ type: VIEW_MESSAGE.result, requestId, ok: false, error: HOST_ERROR });
        }
        // AFTER the answer, so a host whose hook throws in turn cannot be the
        // reason the view is left waiting — the thing this branch exists to
        // prevent.
        ports.defect(error, requestId);
      },
    );
  };

  const receive = (data: unknown): void => {
    // BEFORE the handshake is even considered, and read first: a page that never readied is
    // exactly the one whose notice is worth having, and judging it as a `ready` first would drop
    // it.
    const reported = readNotice(data, nonce());
    if (reported !== null) {
      ports.notice?.(reported);
      return;
    }
    // The window carries exactly one thing this parent acts on. Everything the
    // view asks for arrives on the channel.
    if (!isReady(data, nonce()) || open !== null || offered !== null) {
      return;
    }
    const channel = ports.channel();
    offered = channel;
    channel.onMessage((answer) => answered(channel, answer));
  };

  /** A new page, or a frame that navigated: the next `ready` is a real first
   *  one. The previous channel is closed — whatever holds its far end is a
   *  document we are no longer talking to. */
  const forget = (): void => {
    offered?.close();
    open = null;
    offered = null;
    if (ports.readied !== undefined) ports.readied.value = false;
  };

  return { receive, sendState, forget };
};
