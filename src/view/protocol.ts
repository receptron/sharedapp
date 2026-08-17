/** The names on the wire between the public page and a sandboxed view.
 *
 *  Their own module because both ends need them and neither should pull the
 *  other in: the srcdoc builder is a string function with no Vue and no
 *  Firestore, and the bridge is the opposite.
 *
 *  The view never types these — it calls the helpers the bootstrap defines —
 *  but the tests do, and so does anybody reading a captured message. */
export const VIEW_MESSAGE = {
  ready: "mc-public-view:ready",
  /** The parent handing over the private channel everything else travels on.
   *  Carries a `MessagePort` and no data. */
  channel: "mc-public-view:channel",
  state: "mc-public-view:state",
  submit: "mc-public-view:submit",
  /** A member's or a participant's view asking to CHANGE an existing record —
   *  approve this booking, hand it to somebody else, cancel my own.
   *
   *  Under the same `mc-public-view:` prefix as the rest, which by now names
   *  nobody: the prefix is what the first published pages were built against
   *  and the wire keeps it, exactly as `__MC_PUBLIC_VIEW` survives beside
   *  `__MC_APP_VIEW`. A new prefix here would answer an intent with a
   *  differently-named result, for a distinction only this file can see. */
  intent: "mc-public-view:intent",
  /** The answer to a `submit` OR an `intent` — one name, because the view
   *  settles both from the same map keyed by `requestId`. */
  result: "mc-public-view:submitResult",
  /** The frame reporting something about ITSELF that the browser would
   *  otherwise swallow: an uncaught error, a rejected promise nobody handled,
   *  a modal the sandbox ignores.
   *
   *  It travels on the WINDOW rather than the private channel, and that is the
   *  whole point. The worst of these happen before `ready` — a script that
   *  throws while the document is being parsed never calls it — so a notice
   *  that waited for the port would be lost in exactly the case an author most
   *  needs it. Nothing of the app's travels with it: it is page to parent, one
   *  way, carrying only a fixed code and a short string. */
  notice: "mc-public-view:notice",
} as const;

/** The field a `submit` (or an `intent`) carries when a CLICK caused it.
 *
 *  `true` means the page called `submit()` in the TASK a trusted click was
 *  dispatched in — the dispatch itself, the activation behaviour that follows
 *  it (a checkbox's `change`), or any microtask of either. Everything else is
 *  `false`: a timer, an animation frame, `onState`, a promise that settled in a
 *  later turn, a click the page synthesised itself.
 *
 *  The task rather than the dispatch, because the two ends of a dispatch are
 *  not both observable — see `gestureScript` in `srcdoc.ts` for what went wrong
 *  when this was drawn tighter.
 *
 *  It exists because CAUSATION CANNOT BE MEASURED FROM OUTSIDE. A host that
 *  presses a button and then counts submissions learns only that one turned up
 *  while it was pressing, and a page may submit on a timer, on load, or from a
 *  promise settling. Four attempts to draw that line from elapsed time were
 *  defeated in review (MulmoTerminal `plans/feat-headless-preview-parity.md`,
 *  D-2c); the only place the answer is a FACT is the realm the event is
 *  dispatched in, which is this bootstrap.
 *
 *  The mark travels on the RAW message and is deliberately not carried into
 *  `PendingSubmit`: what a parent needs to draw a confirmation is unchanged,
 *  and a host that gates on this reads it off the wire.
 *
 *  IT IS NOT A PERMISSION. Nothing here grants anything (see CLAUDE.md), and
 *  the author's own script shares this realm — a page written to submit from
 *  inside a click handler it dispatched itself is not prevented from doing so.
 *  What it distinguishes is a page that acts when a control is used from one
 *  that acts on its own, which is the question an automated visitor has and a
 *  human one does not. */
export const GESTURE_MARK = "gesture";
