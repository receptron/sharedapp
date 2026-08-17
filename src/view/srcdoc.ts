import { NOTICE_DETAIL_LIMIT } from "./message.js";
import { GESTURE_MARK, VIEW_MESSAGE } from "./protocol.js";

// What the sandboxed frame is handed: our bootstrap, then the author's HTML.
//
// Its own module because it is the one part of the bridge with no Vue in it —
// a string builder — and because both the page and its tests want it without
// pulling Firestore in behind it.

/** The bootstrap the parent injects above the author's HTML.
 *
 *  Deliberately NOT named `__MC_VIEW`: that is the HOST's contract, where the
 *  view is handed a capability token and fetches its own data. A view written
 *  against one and rendered by the other reads `undefined` and draws nothing,
 *  and the two are told apart by name so that the mistake is visible in the
 *  source rather than at runtime.
 *
 *  `__MC_APP_VIEW` is its name; `__MC_PUBLIC_VIEW` is the same object under the
 *  name it shipped with. The public page is no longer the only thing that
 *  renders a view -- `/m/{slug}` uses this same bootstrap -- so the old name
 *  says something untrue. Both are set for one release: pages published against
 *  the old name are already out there, the runtime ships independently of them,
 *  and a view that reads `undefined` draws a blank page and reports nothing.
 *
 *  Kept small on purpose. Everything it can do, the parent can refuse.
 *
 *  The closing tag is written PLAINLY. `<" + "/script>` is the idiom for a
 *  string that will itself sit inside an HTML `<script>` block; this module is
 *  compiled JavaScript that nothing inlines, so the idiom bought nothing and
 *  cost everything — the characters landed in the document verbatim, the
 *  script never closed, and the author's page was parsed as code.
 *
 *  THE NONCE BINDS `ready` TO THE DOCUMENT WE INJECTED, rather than to this
 *  frame. `event.source` proves only the latter — a sandboxed frame may
 *  navigate its own browsing context and `contentWindow` survives it. Counting
 *  `load` events catches that afterwards but not DURING the initial parse: a
 *  script that assigns `location` before the srcdoc document loads means the
 *  ORIGINAL never fires `load`, the replacement's is counted as the first, and
 *  the replacement then says `ready` and is handed the datasets.
 *
 *  Two things are done so the value is not simply readable back. The script
 *  element removes ITSELF before the author's HTML is parsed, so the literal is
 *  not in the DOM; and `ready` closes over it rather than carrying it in its
 *  own source, so `__MC_APP_VIEW.ready.toString()` yields the identifier and
 *  not the UUID.
 *
 *  `onState` receives a SECOND argument, `{ me, can }`: the reader's own
 *  address, and what they may do per collection with the roles already
 *  resolved by the parent (`{ transitionAny, transitionOwn, assign, assignees,
 *  assigneeField, withdrawFrom }`). A page draws its buttons from that and never sees a role
 *  name — branching on "editor" would be the rules written a second time, in
 *  the one place nobody reviews.
 *
 *  `me` is there because `transitionOwn` alone is not actionable: it says the
 *  reader may move SOME rows, and only `row[assigneeField] === me` says which.
 *  Without it a page must draw the control on every row (most of which are
 *  refused) or on none. The write-time check applies the same comparison.
 *
 *  A page written before this argument existed simply ignores it.
 *
 *  WHAT A VIEW MAY ASK FOR, and what it may not name. `submit` creates a
 *  record; `transition` and `assign` change one that exists — approve this
 *  booking, hand it to somebody else, cancel my own; `withdraw` takes the
 *  reader's own row away, which is how a slot the record was holding goes back
 *  on the grid (`can.withdrawFrom` names the statuses it is allowed from, and
 *  the parent reopens the projection in the same batch). Each names a KIND and
 *  at most one value: which FIELD a transition moves is the
 *  projection's answer, and which NOTICE goes out with it is the transition's.
 *  A page that could choose either could mail "your booking is approved" about
 *  a booking it had just rejected.
 *
 *  They also go through one `request` helper, so a second kind of ask
 *  cannot grow a second way of being left unresolved — which on a phone is a
 *  button that does nothing.
 *
 *  WHAT THIS DOES NOT DO, said plainly: it is not a defence against the
 *  AUTHOR. Their script shares this realm, and a page written to relay the
 *  nonce (or the data itself) to somewhere else can do so — which is the
 *  boundary the design already accepts, because the view is the app owner's and
 *  so is the data. What it defends against is content the author did not
 *  intend: a fragment that navigates the frame, an injected `<meta refresh>`,
 *  a page assembled from a template nobody read closely. Those cannot guess
 *  this value, and after this change they cannot read it either. */
/** The half that answers the parent: the private channel, and what arrives on
 *  it. Its own string so neither piece grows past what a reader will follow. */
const channelScript = (): string => `
  const receive = (data) => {
    if (!data || typeof data !== "object") return;
    if (data.type === ${JSON.stringify(VIEW_MESSAGE.state)}) { onState(data.collections || {}, data.viewer || {}); return; }
    if (data.type === ${JSON.stringify(VIEW_MESSAGE.result)}) {
      const settle = pending.get(data.requestId);
      if (settle) { pending.delete(data.requestId); settle({ ok: data.ok === true, error: data.error }); }
    }
  };
  window.addEventListener("message", (event) => {
    // Only the page that embedded us. The sandbox's origin is opaque, so
    // event.origin cannot draw this boundary -- and without the check, any
    // window holding a handle to this frame could forge a submitResult and
    // resolve an outstanding submit before the real write answers, or feed
    // this view a state that never came from Firestore.
    if (event.source !== parent) return;
    const data = event.data;
    if (data && typeof data === "object" && data.type === ${JSON.stringify(VIEW_MESSAGE.channel)} && event.ports && event.ports[0]) {
      // The private channel. It carries no data yet: the parent sends nothing
      // until we answer on it with the name only this document knows, which is
      // what proves the port reached the document the handshake started from.
      // A port belongs to the document that received it, so once this one is
      // replaced the channel goes with it.
      channel = event.ports[0];
      channel.onmessage = (message) => receive(message.data);
      channel.postMessage({ nonce });
      return;
    }
    receive(data);
  });
`;

/** The most messages ONE document can send, the overflow marker INCLUDED.
 *
 *  A page whose `onState` throws on every row sends one per row; a loop that
 *  throws sends one per turn. The first few say what is wrong and the rest say
 *  it again, so there is a cap — and the host is told when it was reached
 *  (`notices-dropped`) rather than left with a list that looks complete.
 *
 *  THE MARKER COUNTS AGAINST IT, which is the whole reason this is phrased as a
 *  maximum rather than as a budget for ordinary notices. A host sizing a buffer
 *  to a number that excluded the marker would drop exactly the line that says
 *  the list is incomplete — an incomplete list, silently, which is the failure
 *  the marker exists to prevent. One number, and it is the true ceiling.
 *
 *  A host that merely EXPLAINS `notices-dropped` to a reader should not quote
 *  this figure: the runtime deploys separately from anything that republished
 *  the page, so a number copied into prose is one that can be out of date while
 *  looking authoritative.
 *
 *  PART OF THE CONTRACT rather than a tuning knob, which is why it is exported
 *  at all: a host that keeps notices has to bound its own storage against an
 *  untrusted page, and the only alternative to reading this is guessing — a
 *  guess one too small drops the marker, which is the one message that says the
 *  list is incomplete.
 *
 *  IT MUST BE AT LEAST 2. One is spent on the marker, so a value of 1 reports
 *  nothing but "the rest were not sent" and a value of 0 reports nothing at
 *  all, silently — which is the failure this whole file exists to remove. */
export const MAX_NOTICES = 20;

/** The half that reports the frame to the parent: the failures a sandbox
 *  swallows.
 *
 *  Every one of these is invisible today, and each is invisible in its own way.
 *  An uncaught error and a rejected promise stop at the frame boundary, so the
 *  author sees a page that stopped halfway and nothing else. `alert`,
 *  `confirm` and `prompt` do not even fail: without `allow-modals` the browser
 *  ignores the call, `confirm` answers false, and the page carries on as though
 *  the visitor had said no. That last one cost a real app a release — the
 *  static check in MulmoTerminal (`modalCall.ts`) exists because of it, and it
 *  can only catch spellings it knows. This catches the CALL.
 *
 *  The modals are REPLACED rather than watched, which is the only way to see
 *  them, and the replacements return exactly what the sandbox returns:
 *  `undefined`, `false`, `null`. A page cannot tell the difference, and it must
 *  not be able to — a preview that behaved better here than production would be
 *  worth less than none.
 *
 *  `detail` for a modal is the FUNCTION NAME and never the message. The author
 *  greps their own HTML for `confirm(` and finds the line; the text inside it
 *  is a sentence the page wrote, and this payload is built to be copied out of
 *  the host and pasted somewhere else. Give it no more untrusted surface than
 *  the diagnosis needs.
 *
 *  BOUNDED, both ways. A page in an error loop would otherwise post until the
 *  parent gave up, so a fixed number go out and the rest are dropped — the
 *  first ones are the ones that explain the others. */
const noticeScript = (): string => `
  const post = (code, detail) => {
    parent.postMessage({ type: ${JSON.stringify(VIEW_MESSAGE.notice)}, nonce, code, detail: String(detail).slice(0, ${NOTICE_DETAIL_LIMIT}) }, "*");
  };
  let noticesLeft = ${MAX_NOTICES};
  // The LAST one is spent on saying the rest were dropped, so the total can
  // never exceed the maximum a host sized its buffer to. A list that stops
  // without saying so reads as the whole of what happened.
  const notify = (code, detail) => {
    if (noticesLeft > 1) { noticesLeft -= 1; post(code, detail); return; }
    if (noticesLeft === 1) { noticesLeft = 0; post("notices-dropped", "one page may report ${MAX_NOTICES} times; the rest were not sent"); }
  };
  window.addEventListener("error", (event) => {
    const line = typeof event.lineno === "number" && event.lineno > 0 ? " (line " + event.lineno + ")" : "";
    notify("error", (event.message || "an error with no message") + line);
  });
  window.addEventListener("unhandledrejection", (event) => {
    // NOT String(reason). A promise may be rejected with anything, and the
    // common non-Error case -- an object -- stringifies to "[object Object]",
    // which costs a debugging round to learn nothing. Say what it WAS instead.
    const reason = event.reason;
    if (reason && typeof reason.message === "string" && reason.message !== "") { notify("unhandled-rejection", reason.message); return; }
    if (typeof reason === "string" && reason !== "") { notify("unhandled-rejection", reason); return; }
    notify("unhandled-rejection", "rejected with a " + (reason === null ? "null" : typeof reason) + " carrying no message");
  });
  window.alert = () => { notify("modal-ignored", "alert"); };
  window.confirm = () => { notify("modal-ignored", "confirm"); return false; };
  window.prompt = () => { notify("modal-ignored", "prompt"); return null; };
`;

/** The half that knows whether the VISITOR caused what the page just asked for.
 *
 *  It ASKS, and schedules nothing. The DOM resets an event's `eventPhase` to
 *  `NONE` when its dispatch is over -- the last steps of the dispatch algorithm,
 *  alongside clearing `currentTarget` -- so an event object held from the
 *  capture phase IS the answer, read at the moment the page submits. Inside the
 *  dispatch it reports a phase; after it, zero. Nothing has to observe the end.
 *
 *  TWO EARLIER DESIGNS FAILED, and both failed by trying to CLOSE a window:
 *
 *  1. Closed on the window's bubble phase. A listener added to the window during
 *     the click sits after ours, and there is a microtask checkpoint between
 *     listeners, so ours ran first and the page's submission came out false. The
 *     same premature close hit activation behaviour, which runs after the
 *     dispatch: `onchange` on a checkbox -- an ordinary control -- was reported
 *     as nobody's doing.
 *
 *  2. Closed by queueing a task in each of the timer, posted-message and
 *     port-message sources, on the theory that a source is FIFO so a close
 *     queued first cannot be overtaken. It is FIFO WITHIN a source, and that is
 *     all: work queued BEFORE the click -- a state message on the parent's port,
 *     an expired timer -- may be selected first, and an `onState` submission
 *     then read a window still open. Animation-frame callbacks beat all three
 *     outright, because rendering happens before the next task is chosen.
 *
 *  Both were found by review rather than by tests, and the tests passed in both
 *  cases: a model of the event loop agrees with whoever wrote it. Reading
 *  `eventPhase` needs no model of the event loop at all, which is the argument
 *  for it -- a timer, an animation frame, a message, a promise settled in a
 *  later turn and a task queued before the click are ALL simply outside the
 *  dispatch, by the same one fact, with nothing to order.
 *
 *  `click` AND NOTHING ELSE, and `change` in particular is not held -- which
 *  costs something real and is still right. The cost: activation behaviour runs
 *  after the click's dispatch has ended, so `onchange: () => view.submit(...)`
 *  on a checkbox -- a save-on-toggle control -- comes out `false`, and a host
 *  gating writes on this mark writes nothing for it. That is the fail-closed
 *  side, and it is reported rather than silent.
 *
 *  Why it cannot simply be admitted: `element.click()` from script runs the
 *  ACTIVATION BEHAVIOUR, and the `input` and `change` the UA fires there are
 *  fired by the UA -- so they are TRUSTED, though nobody touched anything. A
 *  page could then submit with a visitor's mark from a timer, three turns after
 *  the page loaded, by calling `.click()` on a checkbox of its own. `isTrusted`
 *  is the whole of what this can check, and on `change` it does not mean what
 *  it means on `click`.
 *
 *  `input` is out for a second reason as well: it fires per keystroke, so it
 *  would mark submissions made while a form was merely being filled in -- and
 *  the automated visitor this is for fills forms before it presses anything.
 *
 *  READ AT BOTH ENDS. Holding only trusted events is not enough on its own: a
 *  page may keep the Event object of a real click and hand it back to
 *  `dispatchEvent()` later, which the DOM marks untrusted while giving it a live
 *  `eventPhase` -- so the held object would report itself mid-dispatch with
 *  nobody touching anything. `isTrusted` is therefore read again at the moment
 *  the answer is given, where it describes the dispatch in progress.
 *
 *  UNTRUSTED EVENTS ARE IGNORED rather than refused, and nothing has to untangle
 *  the nesting any more: a page dispatching its own click is not held, and the
 *  real click it may have been dispatched inside is still mid-dispatch and still
 *  answers for itself.
 *
 *  IT IS NOT A DEFENCE against the author, for the reason the file says higher
 *  up: their script shares this realm. A page that submits from inside a handler
 *  for a click the visitor really made is marked, and should be. What this tells
 *  apart is a page that acts when a control is used from one that acts on its
 *  own -- the question an automated visitor has and a human one does not. */
const gestureScript = (): string => `
  // The event we are inside, if any. HELD rather than reduced to a flag: the
  // flag would need taking away, and taking it away at the right moment is the
  // thing that cannot be done. See the note above for the two attempts.
  let held = null;
  // isTrusted is read at BOTH ends, and the second read is not a belt on a
  // brace. A page may keep the very Event object of a real click and later hand
  // it back to dispatchEvent(): the DOM sets isTrusted to false for that
  // redispatch and gives it a live eventPhase, so the object we are holding
  // reports itself mid-dispatch while nobody has touched anything.
  const causedByVisitor = () => held !== null && held.isTrusted === true && held.eventPhase !== 0;
  const hold = (event) => { if (event.isTrusted === true) held = event; };
  // Click only. A trusted \`change\` can be produced by script -- see the note
  // above -- and there is nothing else here that could tell the two apart.
  window.addEventListener("click", hold, true);
`;

export const publicViewBootstrap = (nonce: string): string => `
<script>
(() => {
  // FIRST, before the author's HTML is parsed: take this script's own source
  // out of the document. What follows closes over the value, so from here it
  // exists only in a closure -- not in the DOM, and not in the source of any
  // function the page can reach. See the note above for what this buys.
  const self = document.currentScript;
  if (self && self.parentNode) self.parentNode.removeChild(self);
  const nonce = ${JSON.stringify(nonce)};
  const pending = new Map();
  let onState = () => {};
  let channel = null;
${channelScript()}
${noticeScript()}
${gestureScript()}
  const send = (message) => { if (channel) channel.postMessage(message); else parent.postMessage(message, "*"); };
  const request = (message) => {
    const requestId = String(Date.now()) + ":" + String(Math.random());
    return new Promise((resolve) => {
      pending.set(requestId, resolve);
      // The mark goes on LAST and is always present, never omitted when false.
      // Absent then means "the runtime predates this" and false means "this
      // runtime says no", which a host gating on it has to tell apart -- and
      // last, so nothing a caller passes in can supply its own answer.
      send({ ...message, requestId, [${JSON.stringify(GESTURE_MARK)}]: causedByVisitor() });
    });
  };
  const bridge = {
    onState(callback) { onState = callback; },
    ready() { parent.postMessage({ type: ${JSON.stringify(VIEW_MESSAGE.ready)}, nonce }, "*"); },
    submit(cid, values) {
      return request({ type: ${JSON.stringify(VIEW_MESSAGE.submit)}, cid, values });
    },
    transition(cid, itemId, to) {
      return request({ type: ${JSON.stringify(VIEW_MESSAGE.intent)}, kind: "transition", cid, itemId, to });
    },
    assign(cid, itemId, to) {
      return request({ type: ${JSON.stringify(VIEW_MESSAGE.intent)}, kind: "assign", cid, itemId, to });
    },
    withdraw(cid, itemId) {
      return request({ type: ${JSON.stringify(VIEW_MESSAGE.intent)}, kind: "withdraw", cid, itemId });
    },
  };
  // TWO names for ONE object, for one release. The contract is not the public
  // page's any more -- a member view uses the same bridge -- but a page already
  // published reads the old name, and the runtime deploys separately from
  // anything that republished it. Dropping the old name here would blank an
  // existing /a/{slug} the moment this shipped, with nothing said to its author.
  window.__MC_APP_VIEW = bridge;
  window.__MC_PUBLIC_VIEW = bridge;
})();
</script>
`;

/** The document the iframe renders: our bootstrap, then the author's HTML.
 *
 *  The CSP is deliberately NOT the host's. That one allows several CDNs and
 *  `img-src https:` because it renders the author's own view on the author's
 *  own machine. Here the same HTML runs in a STRANGER's browser, so anything
 *  it loads is a third party learning that this visitor opened this page.
 *  Start closed; widen with a reason. */
export const publicViewSrcdoc = (html: string, nonce: string): string =>
  [
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline'; connect-src 'none'">`,
    publicViewBootstrap(nonce),
    html,
  ].join("\n");

/** A fresh, unguessable name for ONE rendered document.
 *
 *  Per render rather than per component: the iframe is keyed on the HTML, so a
 *  republish (or the route being reused for another app) mounts a new document,
 *  and reusing the previous name would let the OLD document — which may be the
 *  one that navigated away — go on answering. */
export const viewNonce = (): string => crypto.randomUUID();
