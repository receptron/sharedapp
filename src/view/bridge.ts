import type { LookupAsk, PendingSubmit, ViewDataset, ViewNotice, ViewSubmitConfig } from "./message.js";
import { viewParent } from "./parent.js";

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
  /** Where a defect of the HOST'S OWN goes — a port that rejected, or threw before it returned a
   *  promise.
   *
   *  OPTIONAL HERE and required on `ViewParentPorts`, which is the difference between a shape that
   *  already shipped and one being written now: a host calling this adapter was compiled before the
   *  hook existed, and making it required would break the callers this adapter exists for. Left
   *  out, such a defect is dropped exactly as it always was. */
  defect?: ((error: unknown, requestId: string | null) => void) | undefined;
}

/** The public page's parent, as it has always been called.
 *
 *  AN ADAPTER NOW, and nothing else: everything it used to do lives in `parent.ts`, which answers
 *  the whole vocabulary instead of the half a public page was assumed to speak. The name and the
 *  port shape are kept because published hosts call them; new wiring should take `viewParent`
 *  directly, which is the only way to reach `perform` and `viewer`.
 *
 *  ONE BEHAVIOUR CHANGED on the way through, deliberately: a request posted on the WINDOW is no
 *  longer acted on. Only the handshake and a notice are, and everything a page asks for travels on
 *  the private channel — which the bootstrap guarantees by holding its outbox until it has one. The
 *  member parent already worked that way; this is the stricter of the two rules, so it is the one
 *  that survived. */
export const viewBridge = (ports: BridgePorts, config: () => ViewSubmitConfig | null, nonce: () => string, cells: BridgeCells) => {
  const parent = viewParent(
    {
      channel: ports.channel,
      state: ports.state,
      // `exactOptionalPropertyTypes` is on: an explicit `undefined` is a different thing from a key
      // that was never there, and `ViewParentPorts` distinguishes them.
      ...(ports.mine === undefined ? {} : { mine: ports.mine }),
      ...(ports.lookup === undefined ? {} : { lookup: ports.lookup }),
      ...(ports.notice === undefined ? {} : { notice: ports.notice }),
      submit: ports.submit,
      // The old shape had nowhere to put a defect of the host's own, which is exactly what
      // `ViewParentPorts.defect` is required for. A caller that wants it takes `viewParent`.
      defect: ports.defect ?? (() => {}),
    },
    config,
    nonce,
    cells,
  );
  const { receive, accept, decline, sendState, restart } = parent;
  return { receive, accept, decline, sendState, restart };
};
