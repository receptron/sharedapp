import { viewParent, type PerformIntent } from "./parent.js";
import type { ViewDataset, ViewNotice } from "./message.js";
import type { BridgeCells, Channel, Signal } from "./bridge.js";
import type { Viewer } from "./capability.js";

// The MEMBER's parent — the roster (`/m/`) and participant (`/p/`) pages, and the author's preview
// of them.
//
// AN ADAPTER NOW, like `viewBridge` beside it. It was a second factory because a member's ask is an
// intent against a record that exists rather than a stranger's proposal, and that distinction is
// still true — but it was drawn as two PARENTS, and the shape is what went wrong: one bootstrap
// serves every page, so a member view could call `submit` and `mine` and this parent had nowhere to
// route either. `view.mine()` came back `known: false` on every member page for no better reason
// than that. The rules say otherwise — `readWith` ends in `ownRow` — so it was a gap, not a policy.
//
// Everything now lives in `parent.ts`, which answers the whole vocabulary and lets the AUDIENCE
// decide the answers. This name and this port shape are kept because published hosts call them; a
// host that wants a member page to submit, or to read its own rows, takes `viewParent` and passes
// the ports.
//
// The three wire words below are re-exported rather than moved, for the same reason: published
// pages compare them.
export { HOST_ERROR, READ_ONLY, UNSUPPORTED_REQUEST, refuseEverything, type PerformIntent } from "./parent.js";

export interface MemberBridgePorts {
  /** Create the channel and hand its far end to the frame. Called ONCE, in reply to a `ready` whose
   *  nonce checked out, and carrying NO data. */
  channel: () => Channel;
  /** The records this page was handed, by collection. */
  state: () => Record<string, ViewDataset>;
  /** WHO this reader is and what they may change, with the roles already resolved — so the page
   *  draws the buttons that exist and no others, on the rows they apply to.
   *
   *  The page is NOT trusted to obey it. The same answer is applied again to every intent, and the
   *  rules answer after that. */
  viewer: () => Viewer;
  /** The document in the frame has answered on the channel, for a host that needs to SEE it.
   *
   *  Optional and owned by the host, exactly as `BridgeCells.readied` is — and it is not
   *  bookkeeping. Both of this package's previewing hosts report the handshake: MulmoTerminal's pane
   *  logs it, and its headless run puts "It NEVER answered the handshake" at the top of a page's
   *  report. Without somewhere to write this, every healthy member page is reported that way. */
  readied?: Signal<boolean> | undefined;
  /** Somewhere to put what the frame says about itself — an uncaught error, a rejected promise, a
   *  modal the sandbox ignored. */
  notice?: ((notice: ViewNotice) => void) | undefined;
  /** What to do about an intent. Omitted, the page is read-only and is told so in one word.
   *
   *  A GETTER: a host holding this in a reactive prop can have it replaced under the bridge, and a
   *  handler captured once would judge a later intent with the app that was on screen before. */
  perform?: (() => PerformIntent | undefined) | undefined;
  /** Where a defect of the HOST'S OWN goes. REQUIRED — see `ViewParentPorts.defect`. */
  defect: (error: unknown, requestId: string | null) => void;
}

/** The cells this adapter owns because its callers never had any.
 *
 *  A member host draws no confirmation, so `pending` and `sending` are never read by anybody — and
 *  they stay unread, because no `submit` port is passed either and the parent refuses a submission
 *  before a confirmation could open. `readied` is the host's when it offered one, so a preview goes
 *  on seeing the handshake it reports on. */
const cellsFor = (ports: MemberBridgePorts): BridgeCells => ({
  pending: { value: null },
  sending: { value: false },
  readied: ports.readied ?? { value: false },
});

export const memberBridge = (ports: MemberBridgePorts, nonce: () => string) => {
  const parent = viewParent(
    {
      channel: ports.channel,
      state: ports.state,
      viewer: ports.viewer,
      ...(ports.perform === undefined ? {} : { perform: ports.perform }),
      ...(ports.notice === undefined ? {} : { notice: ports.notice }),
      defect: ports.defect,
    },
    // NO SUBMIT DECLARATION, which is what makes a submission from a member page refusable rather
    // than writable here: the parent judges one against this, and with nothing declared there is no
    // collection to write to. A host that wants member submissions passes `viewParent` a real one.
    () => null,
    nonce,
    cellsFor(ports),
  );
  const { receive, sendState, forget } = parent;
  return { receive, sendState, forget };
};
