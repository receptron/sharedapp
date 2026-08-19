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
import type { Viewer } from "./capability.js";
import type { IntentAnswer } from "./intent.js";
import type { BridgeCells, Channel } from "./bridge.js";

// ONE parent, for every page a shared app has.
//
// There used to be two — `viewBridge` in front of `/a/{slug}`, `memberBridge` in front of `/m/` and
// `/p/` — and the split was drawn around what an ask MEANS: a stranger proposing a record versus a
// member moving one that exists. That distinction is real and it survives here (a submission still
// becomes a confirmation; an intent still does not). What did not survive is the SHAPE it was given.
//
// The bootstrap is one document (`srcdoc.ts`), so every page can call all five —
// `submit`, `transition`, `assign`, `withdraw`, `mine` — whoever is reading it. Two parents meant
// each answered a subset and the other half went nowhere:
//
//   - an intent posted to the PUBLIC parent was read as "not a submission" with no request id, and
//     dropped. The page's promise never settled. Both old modules open with a paragraph about a
//     view left waiting being a dead button, and this was one, on the app's most public page.
//   - a submission posted to the MEMBER parent came back `unsupported-request`.
//   - `view.mine()` was answered `known: false` on every member page — not because nothing could be
//     read, but because that parent had nowhere to route the read.
//
// None of those three is a rule. `ownRow` in mulmoserver's `firestore.rules` asks for `authed()` and
// nothing else — no role, no tier, an anonymous uid will do — and `selfWriteOk` / `selfDelete` are
// declared in `public.submit[cid]`, which is the PUBLIC page's own declaration. So the visitor on
// `/a` and the participant on `/p` have exactly the same rights over their own row, and the only
// thing that stopped the public page acting on them was which factory its host had called.
//
// THE RULE THIS MODULE NOW HOLDS: the audience decides the ANSWERS, never the vocabulary. Every ask
// is answered on every page — performed, or refused by name. A host that cannot serve one says so
// in a word the page can match on. Nothing is dropped.
//
// What a host may still leave out is a PORT, and absence is answered honestly rather than silently:
// no `perform` is `read-only`, no `lookup` is `known: false` (nobody looked — never "you have not
// answered"). The one thing a host must not do is offer `submit` without drawing the confirmation
// the cells describe: the write waits for `accept()`, and a host with no dialog leaves the visitor
// waiting on a button nobody can press.
//
// NO FRAMEWORK, and the host owns the cells — both for `bridge.ts`'s reasons, which are unchanged.

/** What this parent does about an intent. Null means "not something anybody asked to be answered";
 *  anything else is answered on the channel it arrived on. */
export type PerformIntent = (data: unknown) => Promise<IntentAnswer | null>;

/** What a page is told when the host serves no writes at all.
 *
 *  PERMANENT, like the rest of the wire vocabulary: published pages compare this string. It is the
 *  same word for a missing `submit` and a missing `perform`, because it is the same statement — this
 *  page may look and not touch — and a page drawing a disabled control does not care which half of
 *  the host is missing. */
export const READ_ONLY = "read-only";

/** With no handler, every intent is refused in one word. Not silence: see the header. */
export const refuseEverything: PerformIntent = (data) => {
  if (!isRecord(data) || typeof data.requestId !== "string") {
    return Promise.resolve(null);
  }
  return Promise.resolve({ requestId: data.requestId, ok: false, error: READ_ONLY });
};

/** What a view is told when `perform` broke instead of answering.
 *
 *  ONE FIXED WORD, and never the exception. The page is the author's; why the host failed is not —
 *  a message off a Firestore client or a stack from a parent the author never wrote is internal
 *  detail arriving in a document that can put it on screen or post it anywhere. It is also not
 *  actionable: nothing a member can press fixes it. So the view learns that this request will not be
 *  answered any other way, in a name it can match on, and the reason goes to the host through
 *  `defect`. PERMANENT for the same reason as {@link READ_ONLY}. */
export const HOST_ERROR = "host-error";

/** What a view is told about a request this parent has no answer for.
 *
 *  Distinct from {@link HOST_ERROR}, which says the host BROKE: this one says the request was
 *  understood well enough to know nobody here serves it — a bootstrap call this host does not
 *  implement. Dropping it instead left the page on a promise that never settles, which is a button
 *  that does nothing with no way left to find out why. Also PERMANENT. */
export const UNSUPPORTED_REQUEST = "unsupported-request";

/** The id an answer would go back on, or null when the message carries none — in which case nobody
 *  is waiting and posting one would be answering something nobody asked. */
const answerId = (data: Record<string, unknown>): string | null =>
  isRecord(data) && typeof data.requestId === "string" && data.requestId !== "" ? data.requestId : null;

/** `perform` as a promise even when it throws on the way to returning one — a host that throws
 *  synchronously would otherwise take the channel's message handler down with it, which is the same
 *  lost request by a shorter route. No extra turn: the returned promise is passed straight
 *  through. */
const performed = (perform: PerformIntent, data: unknown): Promise<IntentAnswer | null> => {
  try {
    return perform(data);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
};

/** The error, as a string, without deciding what to do about it. */
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface ViewParentPorts {
  /** Create the channel and hand its far end to the frame. Called ONCE, in reply to a `ready` whose
   *  nonce checked out, and carrying NO data — see `bridge.ts` for why that is the whole of the
   *  handshake. */
  channel: () => Channel;
  /** The records this page was handed, by collection. */
  state: () => Record<string, ViewDataset>;
  /** WHO this reader is and what they may change, with the roles already resolved.
   *
   *  Sent inside the state message's `viewer`, beside `mine`. The page is NOT trusted to obey it;
   *  the same answer is applied again to every intent, and the rules answer after that.
   *
   *  OPTIONAL, and a host that omits it says nothing about the reader rather than saying the reader
   *  may do nothing — which is why it is omitted from the message entirely rather than sent as
   *  `{ me: null, can: {} }`. A page reading a `can` that is not there draws no controls; a page
   *  reading one that is there and empty draws none either, but the second is a CLAIM.
   *
   *  A GETTER that may itself answer `undefined`, like `mine`: a host holding this in a reactive
   *  prop has a moment before the projection has been read, and "not yet" says the same thing as
   *  "this host does not say" — neither of which is "you may do nothing". */
  viewer?: (() => Viewer | undefined) | undefined;
  /** THE VISITOR'S OWN ROWS, per collection — what they have already submitted through this page,
   *  projected by the host to the fields a page in this position could have SENT.
   *
   *  Why it exists, why the host projects rather than the bridge, and why absence is UNKNOWN rather
   *  than "nothing was submitted" are all in `bridge.ts`'s original note, unchanged. What is new is
   *  that it is offered on EVERY page: `readWith` in the rules ends in `ownRow`, so a reader on
   *  `/m` or `/p` can read their own row exactly as a visitor on `/a` can, and the member parent
   *  answering `known: false` to all of them was a gap rather than a policy. */
  mine?: (() => Record<string, ViewDataset> | undefined) | undefined;
  /** Write the record a confirmation was accepted for.
   *
   *  OPTIONAL — a host that reads and never writes (MulmoTerminal's headless run) leaves it out and
   *  every submission is refused {@link READ_ONLY}. A host that offers it MUST draw the
   *  confirmation: nothing is written until `accept()`. */
  submit?: ((pending: PendingSubmit) => Promise<{ ok: boolean; error?: string }>) | undefined;
  /** "Have I already got this row?", for ONE key the page names — the half that works where `mine`
   *  cannot, because a composite id is `uid + "_" + <field>` and only the page knows the field.
   *
   *  OPTIONAL, and a host without it answers `known: false`. Absence is "nobody looked", never "you
   *  have not answered". */
  lookup?: ((ask: LookupAsk) => Promise<{ found: boolean; record?: Record<string, unknown> }>) | undefined;
  /** What to do about an intent. Omitted, every one is refused {@link READ_ONLY}.
   *
   *  A GETTER: a host holding this in a reactive prop can have it replaced under the parent, and a
   *  handler captured once would judge a later intent with the app that was on screen before. */
  perform?: (() => PerformIntent | undefined) | undefined;
  /** Somewhere to put what the frame says about itself — an uncaught error, a rejected promise, a
   *  modal the sandbox ignored. Optional: a notice is the page's own words, and a host with nowhere
   *  a person will read them is making a real choice rather than forgetting one. */
  notice?: ((notice: ViewNotice) => void) | undefined;
  /** Where a defect of the HOST'S OWN goes: a port rejected, or threw before it returned a promise.
   *
   *  REQUIRED, alone among the optional ports, and that is the point of it: this is the host's own
   *  bug, and a host that never thought about it is exactly the host that used to drop the
   *  exception. A host that genuinely wants to discard it writes `defect: () => {}` and has then
   *  SAID so. `requestId` is the id the answer went back on, or null when the message carried
   *  none. */
  defect: (error: unknown, requestId: string | null) => void;
}

/** The state message, built once so the two send sites cannot disagree.
 *
 *  `viewer` carries BOTH halves now — who the reader is (`me`, `can`) and what they have already
 *  submitted (`mine`) — and the key is omitted entirely when the host offers neither. Omitted, not
 *  empty: the bootstrap hands `data.viewer || {}` to `onState`, so an empty object reaches the page
 *  as "you may do nothing and you have submitted nothing", which are two claims a host with no ports
 *  has no business making. */
const stateMessage = (ports: ViewParentPorts): Record<string, unknown> => {
  const collections = ports.state();
  const viewer = ports.viewer?.();
  const mine = ports.mine?.();
  if (viewer === undefined && mine === undefined) {
    return { type: VIEW_MESSAGE.state, collections };
  }
  return { type: VIEW_MESSAGE.state, collections, viewer: { ...(viewer ?? {}), ...(mine === undefined ? {} : { mine }) } };
};

export const viewParent = (ports: ViewParentPorts, config: () => ViewSubmitConfig | null, nonce: () => string, cells: BridgeCells) => {
  const { pending, sending, readied } = cells;
  /** The channel, once the document that received it has answered on it. */
  let open: Channel | null = null;
  /** Offered and not yet answered. Kept so a second `ready` does not offer another one — a frame
   *  that navigated keeps answering to `event.source`. */
  let offered: Channel | null = null;

  const post = (message: Record<string, unknown>) => open?.post(message);
  const answer = (requestId: string, ok: boolean, error?: string) => {
    post({ type: VIEW_MESSAGE.result, requestId, ok, error });
  };
  /** The answer to a `lookup`. Its own message name, because `{ known, found }` answers a different
   *  question from `{ ok, error }` and a page settling one as the other would read "not found" as
   *  "refused". */
  const answerLookup = (requestId: string, found: { known: boolean; found: boolean; record?: Record<string, unknown> }) => {
    post({ type: VIEW_MESSAGE.lookupResult, requestId, ...found });
  };

  const sendState = () => {
    // Nothing before the document has answered on the channel — and the channel belongs to the
    // document that answered, so nothing reaches one that replaced it.
    if (!readied.value) {
      return;
    }
    post(stateMessage(ports));
  };

  /** Answer "have I already got this row?" — with a READ, and never with a guess.
   *
   *  Three outcomes and only one of them is "no": the host offers no port (nobody looked), the read
   *  threw (nobody knows), or the read came back. */
  const look = async (ask: LookupAsk) => {
    const port = ports.lookup;
    if (port === undefined) {
      answerLookup(ask.requestId, { known: false, found: false });
      return;
    }
    // Called inside a promise so a host that throws SYNCHRONOUSLY is caught here too. Without it the
    // throw escapes as an unhandled rejection and the page is never answered.
    const found = await Promise.resolve()
      .then(() => port(ask))
      .catch((error: unknown) => {
        ports.defect(error, ask.requestId);
        return null;
      });
    if (found === null) {
      answerLookup(ask.requestId, { known: false, found: false });
      return;
    }
    // Spread rather than naming `record`: `exactOptionalPropertyTypes` is on, and an explicit
    // `record: undefined` is a different thing from a key that was never there.
    answerLookup(ask.requestId, { known: true, ...found });
  };

  /** A submission the frame sent, once it is known to be one.
   *
   *  `busy` is the one refusal that is not about the message: a second request while a confirmation
   *  is open would swap the values under the visitor's cursor, so the click they are about to make
   *  would land on a different write. */
  const offer = (read: SubmitRead) => {
    if (!read.ok) {
      // A refusal with a request id is an authoring mistake in the HTML; one without is not a
      // submission at all, and answering it would be answering something nobody asked.
      if (read.requestId !== "") {
        answer(read.requestId, false, read.reason);
      }
      return;
    }
    if (pending.value !== null) {
      answer(read.pending.requestId, false, "busy");
      return;
    }
    // A host that writes nothing says so HERE rather than by drawing a confirmation nobody can
    // accept: the cells belong to the host, and one that passed no `submit` has no dialog either.
    if (ports.submit === undefined) {
      answer(read.pending.requestId, false, READ_ONLY);
      return;
    }
    pending.value = read.pending;
  };

  /** An intent, handed to the host to judge and perform. This parent judges nothing: which moves a
   *  reader may make is the projection's answer and then the rules', and both live where the
   *  records are. */
  const act = (data: Record<string, unknown>) => {
    const perform = ports.perform?.() ?? refuseEverything;
    const channel = open;
    void performed(perform, data).then(
      (result) => {
        if (result !== null) {
          // The channel the request arrived on, not whatever is open now: the two are the same
          // channel today, and answering the one that asked is the property worth keeping if that
          // ever stops being true.
          channel?.post({ type: VIEW_MESSAGE.result, ...result });
          return;
        }
        // Null means `perform` did not recognise it — not that nobody is waiting. A request id says
        // somebody is, and the only way they learn otherwise is if we say so.
        const requestId = answerId(data);
        if (requestId !== null) {
          channel?.post({ type: VIEW_MESSAGE.result, requestId, ok: false, error: UNSUPPORTED_REQUEST });
        }
      },
      (error: unknown) => {
        const requestId = answerId(data);
        if (requestId !== null) {
          channel?.post({ type: VIEW_MESSAGE.result, requestId, ok: false, error: HOST_ERROR });
        }
        // AFTER the answer, so a host whose hook throws in turn cannot be the reason the view is
        // left waiting — the thing this branch exists to prevent.
        ports.defect(error, requestId);
      },
    );
  };

  /** Everything that arrives on the CHANNEL, in the order the three readers must run.
   *
   *  A lookup is judged first: the two are told apart by their type, and a lookup put through
   *  `readSubmitMessage` would come back as "not a submission" and be answered by nobody — a promise
   *  the page waits on forever, which is the failure a read has no timeout to escape.
   *
   *  An intent is judged LAST and by elimination, which is the arrangement that ends the drop: a
   *  message with a request id that is neither a lookup nor a submission is somebody waiting, and it
   *  goes to `act`, whose worst answer is a named refusal. */
  const dispatch = (data: unknown) => {
    if (!isRecord(data)) {
      return;
    }
    const asked = readLookupMessage(data, config());
    if (asked.ok) {
      void look(asked.ask);
      return;
    }
    if (asked.reason !== "not-a-lookup") {
      // ANSWERED AS A LOOKUP, not as a result: the page is waiting in `mine()`, which settles on
      // `lookupResult` and reads `{ known, found }`. A `result` carrying `{ ok: false }` reaches it
      // with no `known` at all — the shape it cannot tell apart from "nobody looked". Both refusals
      // mean the same thing to the page: nothing was read, so nothing is known.
      answerLookup(asked.requestId, { known: false, found: false });
      return;
    }
    if (data.type === VIEW_MESSAGE.submit) {
      offer(readSubmitMessage(data, config()));
      return;
    }
    if (answerId(data) !== null) {
      act(data);
    }
  };

  /** A `ready` whose nonce checked out. The reply is the CHANNEL and nothing else; the data waits
   *  for an answer on it. */
  const greet = () => {
    if (readied.value || offered !== null) {
      return;
    }
    const channel = ports.channel();
    offered = channel;
    channel.onMessage((data) => {
      if (!isRecord(data)) {
        return;
      }
      if (open === channel) {
        dispatch(data);
        return;
      }
      // The name only the injected document knows, echoed on the port it was handed. A document that
      // merely INHERITED the frame cannot send it.
      if (data.nonce !== nonce()) {
        return;
      }
      open = channel;
      readied.value = true;
      channel.post(stateMessage(ports));
    });
  };

  /** A message already proven to come from our frame's WINDOW.
   *
   *  Two things act here and nothing else: a notice, and the handshake. Everything a page ASKS for
   *  travels on the channel — the bootstrap holds its outbox until it has one — so a submission
   *  arriving on the window is not our document's, and acting on it would be answering a request
   *  from something that never proved which document it is. The public parent used to route the
   *  window through the same dispatch as the port; this is the member parent's rule, kept because it
   *  is the stricter of the two. */
  const receive = (data: unknown) => {
    // BEFORE the handshake is even considered, because the notices that matter most arrive before
    // it: a page whose script throws while the document is being parsed never reaches `ready()`, and
    // that page — stuck on its loading state, with the reason inside the frame — is the one an
    // author cannot otherwise diagnose.
    const notice = readNotice(data, nonce());
    if (notice !== null) {
      ports.notice?.(notice);
      return;
    }
    if (isReady(data, nonce())) {
      greet();
    }
  };

  /** One place where a confirmation stops being open, so the two cells cannot drift apart. */
  const settle = () => {
    sending.value = false;
    pending.value = null;
  };

  const accept = async () => {
    const request = pending.value;
    const write = ports.submit;
    if (request === null || sending.value || write === undefined) {
      return;
    }
    sending.value = true;
    // THE CHANNEL THIS CONFIRMATION BELONGS TO, taken before the await rather than read after it.
    // `restart()` can happen while a write is in flight — the host published a new view, or the
    // reader navigated — and `open` is then somebody else's channel. Answering on it would post the
    // OLD request's result to a page that never made it.
    const channel = open;
    // A THROW is the dangerous case, not a failed write: the write may already have succeeded and
    // the refresh that follows it may be what failed. Without this the confirmation would stay open
    // and disabled forever, over a booking that went through.
    //
    // Called INSIDE a promise so a host that throws SYNCHRONOUSLY is caught here too — `.catch()`
    // alone reaches only a rejection, and a `submit` port that threw on its way to returning a
    // promise took the exception straight out of `accept`, leaving `sending` true, the dialog open
    // over a write nobody could retry, and the page's promise unsettled. The lookup path was
    // written this way from the start; this one was not.
    const outcome = await Promise.resolve()
      .then(() => write(request))
      .catch((err: unknown) => {
        ports.defect(err, request.requestId);
        return { ok: false, error: messageOf(err) };
      });
    // STILL THE ONE ON SCREEN? A restart during the write clears the cells, and a new page may have
    // opened a confirmation of its own since. Settling unconditionally would close THAT one — the
    // new visitor's dialog vanishing under their cursor, their own request left unanswered for ever
    // — over a write that belongs to a page nobody is looking at.
    const current = pending.value === request;
    if (current) {
      settle();
    }
    // ANSWERED EITHER WAY, and on the channel it arrived on. Somebody was waiting on that promise
    // and the write really happened; if that document has gone, its port is closed and the post is
    // a no-op. What must not happen is the answer landing on the page that replaced it.
    channel?.post({ type: VIEW_MESSAGE.result, requestId: request.requestId, ok: outcome.ok, error: outcome.error });
    // Either it took something or it learned somebody else had; both make the view's picture older
    // than the truth. Only for the view that asked: a page that replaced it gets its own state on
    // its own handshake, and is holding nothing this write made older.
    if (current) {
      sendState();
    }
  };

  const decline = () => {
    // NOT while a write is in flight. The buttons are disabled then, but Escape is not a button:
    // cancelling here would answer the view "cancelled" while the record is still being written, and
    // a booking that then succeeds would have been reported as declined.
    const request = pending.value;
    if (request === null || sending.value) {
      return;
    }
    settle();
    answer(request.requestId, false, "cancelled");
  };

  /** A new view was published, or the page moved to another app. The frame is replaced, so the
   *  conversation starts again: the next `ready` is a real first one and must be answered, or the
   *  new view sits there with no data. The previous channel is closed — whatever holds its far end
   *  is a document we are no longer talking to. */
  const forget = () => {
    offered?.close();
    open = null;
    offered = null;
    readied.value = false;
  };

  /** Everything that belongs to ONE rendered view: a confirmation still open refers to a page the
   *  visitor can no longer see. */
  const restart = () => {
    settle();
    forget();
  };

  // The cells are NOT returned. The host made them and already holds them; handing them back would
  // only invite a second name for one cell.
  return { receive, accept, decline, sendState, restart, forget };
};
