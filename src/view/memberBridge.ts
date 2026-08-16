import { isReady, isRecord, readNotice, type ViewDataset, type ViewNotice } from "./message.js";
import { VIEW_MESSAGE } from "./protocol.js";
import type { Channel } from "./bridge.js";
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
// no `perform` at all, which is genuinely read-only and says so in one word.

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

/** A rejection that has already been reported: `perform` turns a failed write
 *  into an ANSWER, so anything reaching here is a defect in the host rather
 *  than something to show a member. Named so it is visibly handled. */
const ignore = (): undefined => undefined;

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
      sendState();
      return;
    }
    const perform = ports.perform?.() ?? refuseEverything;
    perform(data).then((answer) => {
      // The channel the request arrived on, not `open`: the two are the same
      // channel today, and answering the one that asked is the property worth
      // keeping if that ever stops being true.
      if (answer !== null) {
        channel.post({ type: VIEW_MESSAGE.result, ...answer });
      }
    }, ignore);
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
  };

  return { receive, sendState, forget };
};
