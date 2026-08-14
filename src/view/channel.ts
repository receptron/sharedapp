import { VIEW_MESSAGE } from "./protocol.js";
import type { Channel } from "./bridge.js";

// The private channel between the page and ONE rendered view.
//
// Its own module because both frames need it and neither should pull the other
// in, and because it is the one part with a DOM in it — everything about WHEN
// data may travel on the channel is in the bridge, where it can be tested
// without an iframe.
//
// WHY A PORT AT ALL. `event.source` proves a message came from this FRAME, and
// a per-render nonce proves the `ready` came from the document we injected —
// but neither says anything about who RECEIVES the reply. `contentWindow`
// survives a navigation, so a fragment that calls the public `ready()` and
// navigates in the same tick has the answer land in whatever loaded next. A
// port belongs to the document that received it: once that document is gone,
// nothing can answer on it, and the parent sends nothing.

/** Take a host's reactivity off a message before the browser copies it.
 *
 *  Injected rather than done here, because it is the one step that knows which
 *  framework the host is built on: Vue's `toRaw` is not this package's to
 *  import (see the note in `bridge.ts` about two copies of Vue), and a host
 *  that has no proxies at all passes the identity function.
 *
 *  What crosses this boundary is copied by the browser, and structured clone
 *  refuses exactly one thing here: a PROXY. Datasets that reach a Vue host
 *  through a ref arrive reactive — `DataCloneError: #<Object> could not be
 *  cloned`, thrown at the send, leaving the view at "loading…" with the failure
 *  only in the console.
 *
 *  It must not round-trip through JSON. That was the first fix in mulmoserver
 *  and it was lossy in a way nothing would have reported: Firestore stores
 *  doubles, so `NaN` and `±Infinity` are real values in a member's records, and
 *  `JSON.stringify` turns all three into `null` — a chart would have drawn a
 *  zero where the data said "no measurement". Structured clone carries them,
 *  and `undefined`, and a Date. */
export type Cloneable = (message: Record<string, unknown>) => Record<string, unknown>;

/** For a host with nothing to unwrap. */
export const asIs: Cloneable = (message) => message;

/** Open a channel to the frame's CURRENT document and hand it the far end.
 *
 *  The handover message carries the port and no data. */
export const portChannel = (frame: HTMLIFrameElement | null, cloneable: Cloneable = asIs): Channel => {
  const channel = new MessageChannel();
  channel.port1.start();
  // "*" is not laxity: a sandboxed srcdoc frame has an OPAQUE origin, so no
  // origin string would address it. What makes this safe is that the message
  // carries nothing — everything else waits for an answer on the port.
  frame?.contentWindow?.postMessage({ type: VIEW_MESSAGE.channel }, "*", [channel.port2]);
  return {
    post: (message) => channel.port1.postMessage(cloneable(message)),
    onMessage: (handler) => {
      channel.port1.onmessage = (event: MessageEvent) => handler(event.data);
    },
    close: () => channel.port1.close(),
  };
};
