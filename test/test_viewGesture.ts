// WHETHER A CLICK CAUSED WHAT THE PAGE ASKED FOR, decided in the only place that can know.
//
// The mark exists because causation cannot be measured from outside the realm the event is
// dispatched in. A host that presses a button and counts submissions learns that one turned up
// while it was pressing — and a page may submit on a timer, on load, or from a promise settling
// four turns later. Four attempts to draw that line from elapsed time were defeated in review
// (MulmoTerminal `plans/feat-headless-preview-parity.md`, D-2c). This is what replaced them.
//
// So the assertions are about the WINDOW: when it opens, when it closes, and which side of it each
// way a page can call `submit()` falls on. What is written on the strength of this mark is a real
// record in somebody's app, so a false `true` is the expensive direction — and a false `false` is
// a control the visitor really used, reported as not caused by them. Both are here.
//
// The bootstrap is RUN rather than read, for the reason `test_viewNotice.ts` gives: a test that
// greps the generated string agrees with the implementation and not with reality. Two things are
// modelled by hand because the design rests on them:
//
//   DISPATCH — window capture first, window bubble last, the listener list copied when its object
//   is reached, a microtask checkpoint between handlers, and activation behaviour (a checkbox's
//   `change`) after the whole of it, in the same task.
//
//   TASK SOURCES — a timer queue, a posted-message queue and a port-message queue, each FIFO, and
//   the browser free to serve whichever it likes first. That last freedom is why the close is armed
//   in all three: `flush` takes the order, and each source gets a test where IT is served first.

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { GESTURE_MARK, VIEW_MESSAGE } from "../src/view/protocol.js";
import { publicViewBootstrap } from "../src/view/srcdoc.js";

const NONCE = "nonce-1";

type Source = "timers" | "messages" | "ports";

interface Registered {
  type: string;
  handler: (event: Record<string, unknown>) => void;
  capture: boolean;
}

interface Bridge {
  submit: (cid: string, values: Record<string, string>) => Promise<unknown>;
  transition: (cid: string, itemId: string, to: string) => Promise<unknown>;
}

/** The bootstrap, running, with a window that keeps every listener rather than the last one per
 *  name, and with the three task sources a page can defer into.
 *
 *  The existing harness in `test_viewNotice.ts` keeps one listener per name and has no queues at
 *  all, which is enough for notices and is exactly what this file cannot use. */
const runBootstrap = () => {
  const posted: Record<string, unknown>[] = [];
  const listeners: Registered[] = [];
  const queues: Record<Source, (() => void)[]> = { timers: [], messages: [], ports: [] };
  const captures = (options: unknown): boolean =>
    options === true || (typeof options === "object" && options !== null && (options as { capture?: unknown }).capture === true);
  const fire = (type: string, event: Record<string, unknown>) => {
    for (const one of listeners.filter((each) => each.type === type && !each.capture).slice()) one.handler(event);
  };
  const win: Record<string, unknown> = {
    addEventListener: (type: string, handler: (event: Record<string, unknown>) => void, options?: unknown) => {
      listeners.push({ type, handler, capture: captures(options) });
    },
    removeEventListener: (type: string, handler: (event: Record<string, unknown>) => void, options?: unknown) => {
      const at = listeners.findIndex((one) => one.type === type && one.handler === handler && one.capture === captures(options));
      if (at >= 0) listeners.splice(at, 1);
    },
    postMessage: (data: unknown) => queues.messages.push(() => fire("message", { source: win, data })),
  };
  class Channel {
    port1: { onmessage: ((event: { data: unknown }) => void) | null };
    port2: { postMessage: (data: unknown) => void };
    constructor() {
      const port1: { onmessage: ((event: { data: unknown }) => void) | null } = { onmessage: null };
      this.port1 = port1;
      this.port2 = { postMessage: (data: unknown) => queues.ports.push(() => port1.onmessage?.({ data })) };
    }
  }
  const context = {
    window: win,
    parent: { postMessage: (message: Record<string, unknown>) => posted.push(message) },
    document: { currentScript: null },
    setTimeout: (handler: () => void) => {
      queues.timers.push(handler);
      return 0;
    },
    MessageChannel: Channel,
  };
  vm.createContext(context);
  vm.runInContext(
    publicViewBootstrap(NONCE)
      .replace(/^\s*<script>/, "")
      .replace(/<\/script>\s*$/, ""),
    context,
  );
  const bridge = win.__MC_APP_VIEW as Bridge;
  const asked = () => posted.filter((message) => message.type === VIEW_MESSAGE.submit || message.type === VIEW_MESSAGE.intent);
  const marks = () => asked().map((message) => message[GESTURE_MARK]);
  /** Whatever the page deferred into, queued from INSIDE its own handler — which is the only place
   *  a page can queue from, and therefore always behind the close armed before the dispatch began. */
  const defer = (source: Source, work: () => void): void => {
    queues[source].push(work);
  };
  return { win, listeners, bridge, asked, marks, queues, defer };
};

type Frame = ReturnType<typeof runBootstrap>;

/** A microtask checkpoint. Several, because a chain of `await`s cascades and each link is queued
 *  during the drain of the one before it. */
const settle = async (): Promise<void> => {
  for (let n = 0; n < 5; n += 1) await Promise.resolve();
};

/** Later turns of the event loop, serving the sources in the order given.
 *
 *  The order is a PARAMETER because the browser's is not fixed: the event loop picks a task source,
 *  and only FIFO WITHIN one is guaranteed. Each source below gets a test where it is served first,
 *  which is what makes each of the three closes necessary rather than decorative. */
const flush = async (frame: Frame, order: Source[] = ["messages", "ports", "timers"]): Promise<void> => {
  for (const source of order) {
    while (frame.queues[source].length > 0) {
      frame.queues[source].shift()?.();
      await settle();
    }
  }
};

/** ONE dispatch of a click, as the DOM performs it.
 *
 *  `during` stands in for the handlers on the path; `after` for activation behaviour, which runs
 *  when the dispatch is over and the task is not — a checkbox's `change` is there.
 *  `reachesWindowAgain: false` is a handler that called `stopPropagation()`. */
const clickThrough = async (
  frame: Frame,
  options: { trusted?: boolean; during?: () => void | Promise<void>; after?: () => void; reachesWindowAgain?: boolean } = {},
) => {
  const event = { isTrusted: options.trusted !== false, type: "click" };
  // The list is copied when its object is REACHED, and there is a microtask checkpoint between one
  // listener and the next — the stack empties back to the browser between them. Both matter: a
  // close deferred by a microtask from an earlier listener therefore lands BEFORE a later one runs.
  const invoke = async (capture: boolean) => {
    for (const one of frame.listeners.filter((each) => each.type === "click" && each.capture === capture).slice()) {
      one.handler(event);
      await settle();
    }
  };
  await invoke(true);
  if (options.during !== undefined) await options.during();
  await settle();
  if (options.reachesWindowAgain !== false) await invoke(false);
  await settle();
  if (options.after !== undefined) options.after();
  await settle();
};

const onWindow = (frame: Frame, handler: () => void) => (frame.win.addEventListener as (type: string, handler: () => void) => void)("click", handler);

test("a submit made inside a trusted click is marked", async () => {
  const frame = runBootstrap();
  await clickThrough(frame, { during: () => void frame.bridge.submit("orders", { name: "x" }) });
  assert.deepEqual(frame.marks(), [true]);
});

test("a submit from an async handler — one await in — is still marked", async () => {
  // The shape pages are actually written in. A runtime that said `await this.validate()` broke the
  // chain would be describing a rule nobody could follow, and every real form would go unmarked.
  const frame = runBootstrap();
  await clickThrough(frame, {
    during: async () => {
      await Promise.resolve();
      await Promise.resolve();
      void frame.bridge.submit("orders", { name: "x" });
    },
  });
  assert.deepEqual(frame.marks(), [true]);
});

test("a submit from a window listener the click itself added is marked", async () => {
  // Closing on the window's bubble phase could not do this: our own close sat BEFORE any listener
  // added while the click was in flight, so it ran first and the page's submit came out false.
  const frame = runBootstrap();
  await clickThrough(frame, { during: () => onWindow(frame, () => void frame.bridge.submit("orders", { name: "x" })) });
  assert.deepEqual(frame.marks(), [true]);
});

test("a submit from activation behaviour — a checkbox's change — is marked", async () => {
  // Activation behaviour runs AFTER the dispatch and in the same task. `onchange` saving a toggle
  // is an ordinary control, and a close tied to the dispatch reported it as nobody's doing.
  const frame = runBootstrap();
  await clickThrough(frame, { after: () => void frame.bridge.submit("orders", { name: "x" }) });
  assert.deepEqual(frame.marks(), [true]);
});

test("a submit with no click anywhere near it is NOT marked", async () => {
  // A page that submits from `onState`, or on load. This is the case the whole mark exists for:
  // it looks identical to a click-caused one from outside, and it is not one.
  const frame = runBootstrap();
  void frame.bridge.submit("orders", { name: "x" });
  await settle();
  assert.deepEqual(frame.marks(), [false]);
});

test("a click the PAGE dispatched opens no window", async () => {
  // `el.click()` and `dispatchEvent(new MouseEvent("click"))` are a page acting on its own with a
  // click's name on it. `isTrusted` is the browser's word and cannot be set from script.
  const frame = runBootstrap();
  await clickThrough(frame, { trusted: false, during: () => void frame.bridge.submit("orders", { name: "x" }) });
  assert.deepEqual(frame.marks(), [false]);
});

for (const source of ["timers", "messages", "ports"] as const) {
  test(`a submit deferred into the ${source} queue is NOT marked, even when that queue is served first`, async () => {
    // One test per task source, and each is served FIRST here, because the event loop is free to
    // choose and only FIFO within a source is promised. With a close in just one of the three, a
    // page deferring into either of the others submitted into a window that was still open — which
    // is a write, in somebody's real app, for something no visitor did.
    const frame = runBootstrap();
    await clickThrough(frame, { during: () => frame.defer(source, () => void frame.bridge.submit("orders", { name: "x" })) });
    await flush(frame, [source, "timers", "messages", "ports"]);
    assert.deepEqual(frame.marks(), [false]);
  });

  test(`...and still NOT marked when the click's propagation was stopped first (${source})`, async () => {
    // stopPropagation() takes away every listener-based close there could be, so the queued ones
    // are the only ones left. This is the pairing that defeated the single timer: a handler that
    // stops the click and hops through a MessageChannel arrives before a timer in every engine.
    const frame = runBootstrap();
    await clickThrough(frame, {
      reachesWindowAgain: false,
      during: () => frame.defer(source, () => void frame.bridge.submit("orders", { name: "x" })),
    });
    await flush(frame, [source, "timers", "messages", "ports"]);
    assert.deepEqual(frame.marks(), [false]);
  });
}

test("a click whose propagation was stopped does not leave the window open for ever", async () => {
  // The counter has to come back to zero. Left at one, EVERY later submission — timers, onState,
  // load — would be marked for the rest of the document's life.
  const frame = runBootstrap();
  await clickThrough(frame, { reachesWindowAgain: false });
  await flush(frame);
  void frame.bridge.submit("orders", { name: "x" });
  await settle();
  assert.deepEqual(frame.marks(), [false]);
});

test("a click the page dispatches INSIDE a real one does not close the real one's window", async () => {
  // The inner dispatch is untrusted, so it arms nothing and closes nothing. Worth pinning: when the
  // close was a listener rather than a queued task, the inner click reached the window FIRST and
  // ended the real click's window while the page was still inside it.
  const frame = runBootstrap();
  await clickThrough(frame, {
    during: async () => {
      await clickThrough(frame, { trusted: false });
      void frame.bridge.submit("orders", { name: "x" });
    },
  });
  assert.deepEqual(frame.marks(), [true]);
});

test("the mark is a boolean on every request, so ABSENT can only mean an older runtime", async () => {
  // A host gating writes on this has to tell "this runtime says no" from "this runtime predates the
  // mark". Omitted when false, the two would be the same message.
  const frame = runBootstrap();
  void frame.bridge.submit("orders", { name: "x" });
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

test("the word the close travels on is not the nonce, which the page must never learn", async () => {
  // The self-post is readable by the author's own script — same realm, and `message` is a public
  // event. The nonce in it would hand over the one value this file spends four paragraphs
  // protecting. What a page can do with the word it does get is close its own window early.
  const frame = runBootstrap();
  const seen: unknown[] = [];
  (frame.win.addEventListener as (type: string, handler: (event: { data: unknown }) => void) => void)("message", (event) => seen.push(event.data));
  await clickThrough(frame);
  await flush(frame);
  assert.ok(seen.length > 0);
  assert.ok(seen.every((data) => typeof data === "string" && !data.includes(NONCE)));
});
