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
} as const;
