// WHETHER THE VISITOR CAUSED WHAT THE PAGE ASKED FOR, decided in the only place that can know.
//
// The mark exists because causation cannot be measured from outside the realm the event is
// dispatched in. A host that presses a button and counts submissions learns that one turned up
// while it was pressing — and a page may submit on a timer, on load, or from a promise settling
// four turns later. Four attempts to draw that line from elapsed time were defeated in review
// (MulmoTerminal `plans/feat-headless-preview-parity.md`, D-2c). This is what replaced them.
//
// A false `true` writes a record in somebody's real app for something no visitor did. A false
// `false` is a control the visitor really used, reported as not caused by them. Both are here.
//
// THE MODEL IS ONE FACT, and that is the point of the design under test. The dispatch algorithm
// resets an event's `eventPhase` to `NONE` when the dispatch is over, so this file sets the phase
// while listeners run and zeroes it afterwards, and everything else follows. Two earlier designs
// tried to CLOSE a window at the right moment and needed a model of listener ordering and of the
// event loop's task sources to test — a model which, both times, agreed with the implementation
// and not with the browser. Nothing below models a queue, because nothing in the code reads one.

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { GESTURE_MARK, VIEW_MESSAGE } from "../src/view/protocol.js";
import { publicViewBootstrap } from "../src/view/srcdoc.js";

const NONCE = "nonce-1";

interface Registered {
  type: string;
  handler: (event: Record<string, unknown>) => void;
  capture: boolean;
}

interface Bridge {
  ready: () => void;
  submit: (cid: string, values: Record<string, string>) => Promise<unknown>;
  transition: (cid: string, itemId: string, to: string) => Promise<unknown>;
}

/** The bootstrap, running, with a window that keeps every listener rather than the last one per
 *  name. The harness in `test_viewNotice.ts` keeps one per name, which is enough for notices and
 *  not for this: the mechanism registers two capture listeners and the tests add more. */
const runBootstrap = () => {
  const posted: Record<string, unknown>[] = [];
  const listeners: Registered[] = [];
  const captures = (options: unknown): boolean =>
    options === true || (typeof options === "object" && options !== null && (options as { capture?: unknown }).capture === true);
  const win: Record<string, unknown> = {
    addEventListener: (type: string, handler: (event: Record<string, unknown>) => void, options?: unknown) => {
      listeners.push({ type, handler, capture: captures(options) });
    },
    removeEventListener: (type: string, handler: (event: Record<string, unknown>) => void, options?: unknown) => {
      const at = listeners.findIndex((one) => one.type === type && one.handler === handler && one.capture === captures(options));
      if (at >= 0) listeners.splice(at, 1);
    },
  };
  const context = {
    window: win,
    parent: { postMessage: (message: Record<string, unknown>) => posted.push(message) },
    document: { currentScript: null },
  };
  vm.createContext(context);
  vm.runInContext(
    publicViewBootstrap(NONCE)
      .replace(/^\s*<script>/, "")
      .replace(/<\/script>\s*$/, ""),
    context,
  );
  const bridge = win.__MC_APP_VIEW as Bridge;
  // THE HANDSHAKE, because requests are held until the private channel exists — a reply cannot
  // reach a page that has no port, so nothing is sent on the window but `ready` itself. The mark
  // travels on the request whichever side of the handshake it was made on, and these tests are
  // about the mark, so the channel is opened once here and the tests go on as they were.
  const port = { postMessage: (message: Record<string, unknown>) => posted.push(message) };
  const open = () => {
    for (const one of listeners.filter((each) => each.type === "message")) {
      one.handler({ source: context.parent, data: { type: VIEW_MESSAGE.channel }, ports: [port] });
    }
  };
  bridge.ready();
  open();
  const asked = () => posted.filter((message) => message.type === VIEW_MESSAGE.submit || message.type === VIEW_MESSAGE.intent);
  const marks = () => asked().map((message) => message[GESTURE_MARK]);
  return { win, listeners, bridge, asked, marks };
};

type Frame = ReturnType<typeof runBootstrap>;

/** A microtask checkpoint. Several, because a chain of `await`s cascades and each link is queued
 *  during the drain of the one before it. */
const settle = async (): Promise<void> => {
  for (let n = 0; n < 5; n += 1) await Promise.resolve();
};

const CAPTURING = 1;
const AT_TARGET = 2;
const BUBBLING = 3;
const NONE = 0;

/** ONE dispatch, as the DOM performs it.
 *
 *  Three things are modelled and each is a DOM fact the design rests on: the listener list is
 *  copied when its object is REACHED (so one added mid-dispatch is still called), there is a
 *  microtask checkpoint between one listener and the next, and the phase is reset to `NONE` in the
 *  last steps of the algorithm — including when a handler stopped propagation, because stopping
 *  propagation ends the dispatch rather than abandoning it. */
const dispatch = async (frame: Frame, type: string, options: { trusted?: boolean; during?: () => void | Promise<void>; reachesWindowAgain?: boolean } = {}) => {
  const event: Record<string, unknown> = { isTrusted: options.trusted !== false, type, eventPhase: CAPTURING };
  const invoke = async (capture: boolean) => {
    for (const one of frame.listeners.filter((each) => each.type === type && each.capture === capture).slice()) {
      one.handler(event);
      await settle();
    }
  };
  await invoke(true);
  event.eventPhase = AT_TARGET;
  if (options.during !== undefined) await options.during();
  await settle();
  if (options.reachesWindowAgain !== false) {
    event.eventPhase = BUBBLING;
    await invoke(false);
  }
  await settle();
  event.eventPhase = NONE;
  await settle();
  return event;
};

/** The SAME event object, handed back to `dispatchEvent()` by the page.
 *
 *  The DOM sets `isTrusted` to false for a redispatch and gives the event a live phase again, so
 *  an object retained from a real click reports itself mid-dispatch with nobody touching anything.
 *  (It cannot be redispatched WHILE it is being dispatched — that throws — so this is only ever
 *  afterwards, which is exactly when the phase would otherwise have settled the question.) */
const redispatch = async (_frame: Frame, event: Record<string, unknown>, during: () => void) => {
  event.isTrusted = false;
  event.eventPhase = AT_TARGET;
  during();
  await settle();
  event.eventPhase = NONE;
  await settle();
};

const clickThrough = (frame: Frame, options: Parameters<typeof dispatch>[2] = {}) => dispatch(frame, "click", options);

const onWindow = (frame: Frame, type: string, handler: () => void) => {
  (frame.win.addEventListener as (type: string, handler: () => void) => void)(type, handler);
};

const submit = (frame: Frame) => void frame.bridge.submit("orders", { name: "x" });

test("a submit made inside a trusted click is marked", async () => {
  const frame = runBootstrap();
  await clickThrough(frame, {
    during: () => {
      submit(frame);
    },
  });
  assert.deepEqual(frame.marks(), [true]);
});

test("a submit from an async handler — several awaits in — is still marked", async () => {
  // The shape pages are actually written in. A runtime that said `await this.validate()` broke the
  // chain would be describing a rule nobody could follow, and every real form would go unmarked.
  const frame = runBootstrap();
  await clickThrough(frame, {
    during: async () => {
      await Promise.resolve();
      await Promise.resolve();
      submit(frame);
    },
  });
  assert.deepEqual(frame.marks(), [true]);
});

test("a submit from a window listener the click itself added is marked", async () => {
  // Closing on the window's bubble phase could not do this: the close sat BEFORE any listener added
  // while the click was in flight, and a microtask checkpoint between listeners let it run first.
  const frame = runBootstrap();
  await clickThrough(frame, {
    during: () => {
      onWindow(frame, "click", () => {
        submit(frame);
      });
    },
  });
  assert.deepEqual(frame.marks(), [true]);
});

test("a TRUSTED change does not mark, because script can produce one", async () => {
  // `element.click()` from script runs the activation behaviour, and the `input` and `change` the
  // UA fires there are fired BY THE UA — so they are trusted, though nobody touched anything. A
  // page could otherwise submit with a visitor's mark from a timer, by calling `.click()` on a
  // checkbox of its own. `isTrusted` is the whole of what this can check, and on `change` it does
  // not mean what it means on `click`.
  const frame = runBootstrap();
  await dispatch(frame, "change", {
    during: () => {
      submit(frame);
    },
  });
  assert.deepEqual(frame.marks(), [false]);
});

test("...and the price of that is an unmarked save-on-toggle, which is the fail-closed side", async () => {
  // Activation behaviour runs after the click's dispatch has ended, so `onchange` on a real
  // checkbox a real visitor really ticked comes out false and a host gating writes writes nothing.
  // Pinned rather than left to be rediscovered: it is a cost, it is known, and it errs toward
  // writing nothing rather than toward writing what nobody asked for.
  const frame = runBootstrap();
  await clickThrough(frame);
  await dispatch(frame, "change", {
    during: () => {
      submit(frame);
    },
  });
  assert.deepEqual(frame.marks(), [false]);
});

test("a submit with no event anywhere near it is NOT marked", async () => {
  // A page that submits from `onState`, or on load. This is the case the whole mark exists for:
  // from outside it is indistinguishable from a click-caused one, and it is not one.
  const frame = runBootstrap();
  submit(frame);
  await settle();
  assert.deepEqual(frame.marks(), [false]);
});

test("a click the PAGE dispatched opens nothing", async () => {
  // `el.click()` and `dispatchEvent(new MouseEvent("click"))` are a page acting on its own with a
  // click's name on it. `isTrusted` is the browser's word and cannot be set from script.
  const frame = runBootstrap();
  await clickThrough(frame, {
    trusted: false,
    during: () => {
      submit(frame);
    },
  });
  assert.deepEqual(frame.marks(), [false]);
});

test("typing does not open it either: `input` is not held", async () => {
  // A page that submits on `input` would be marked on every keystroke — and the automated visitor
  // this mark is for fills the form in before it presses anything.
  const frame = runBootstrap();
  await dispatch(frame, "input", {
    during: () => {
      submit(frame);
    },
  });
  assert.deepEqual(frame.marks(), [false]);
});

for (const later of ["a timer", "an animation frame", "a message", "a task queued before the click ever happened"]) {
  test(`a submit from ${later} is NOT marked`, async () => {
    // ONE test body for four mechanisms, and that is the argument for reading `eventPhase` rather
    // than closing a window. Two earlier designs had to reason about which of these runs first —
    // animation frames beat every task; a task queued before the click may be selected before one
    // queued during it — and each got it wrong somewhere. Here they are all simply after the
    // dispatch, by the same single fact, with nothing to order.
    const frame = runBootstrap();
    await clickThrough(frame);
    submit(frame);
    await settle();
    assert.deepEqual(frame.marks(), [false]);
  });
}

test("stopping propagation ends the dispatch rather than abandoning it", async () => {
  // The case that needed a fallback under every previous design, and needs none here: a handler
  // calling stopPropagation() still reaches the end of the algorithm, so the phase is reset like
  // any other. What it submits DURING the click counts; what it defers does not.
  const frame = runBootstrap();
  await clickThrough(frame, {
    reachesWindowAgain: false,
    during: () => {
      submit(frame);
    },
  });
  submit(frame);
  await settle();
  assert.deepEqual(frame.marks(), [true, false]);
});

test("a click the page dispatches INSIDE a real one does not take the real one's answer away", async () => {
  // The untrusted one is not held, and the real one is still mid-dispatch and still answers for
  // itself. Worth pinning: when this was a window being closed, the inner dispatch reached the
  // window FIRST and ended the real click's window while the page was still inside it.
  const frame = runBootstrap();
  await clickThrough(frame, {
    during: async () => {
      await clickThrough(frame, { trusted: false });
      submit(frame);
    },
  });
  assert.deepEqual(frame.marks(), [true]);
});

test("a real click's own Event object, handed back to dispatchEvent, does not mark", async () => {
  // Holding only trusted events is not enough: the object is retained, and a redispatch of it is
  // untrusted but has a live phase. Without reading `isTrusted` again at the moment of answering,
  // a page could keep one real click and mint visitor-caused submissions from it for ever.
  const frame = runBootstrap();
  const real = await clickThrough(frame);
  await redispatch(frame, real, () => {
    submit(frame);
  });
  assert.deepEqual(frame.marks(), [false]);
});

test("the mark is a boolean on every request, so ABSENT can only mean an older runtime", async () => {
  // A host gating writes on this has to tell "this runtime says no" from "this runtime predates the
  // mark". Omitted when false, the two would be the same message.
  const frame = runBootstrap();
  submit(frame);
  await settle();
  const message = frame.asked()[0];
  assert.ok(message !== undefined && Object.hasOwn(message, GESTURE_MARK));
  assert.equal(typeof message[GESTURE_MARK], "boolean");
});

test("an intent carries the mark too, because there is one request helper and not two", async () => {
  // Nothing reads it on an intent today. It is here so that a second kind of ask cannot grow a
  // second answer to the same question — which is the reason the helper is shared at all.
  const frame = runBootstrap();
  await clickThrough(frame, { during: () => void frame.bridge.transition("orders", "row-1", "approved") });
  assert.deepEqual(frame.marks(), [true]);
});

test("nothing a caller passes in can supply its own mark", async () => {
  // The mark is spread on LAST. A page reaches the helper only through the bridge, so this is not a
  // hole today — it is the property that keeps it from becoming one when a fourth kind of ask is
  // added and someone builds its message from a wider object.
  const frame = runBootstrap();
  const cid = { toString: () => "orders" } as unknown as string;
  void frame.bridge.submit(cid, { [GESTURE_MARK]: "true" });
  await settle();
  assert.equal(frame.asked()[0]?.[GESTURE_MARK], false);
});
