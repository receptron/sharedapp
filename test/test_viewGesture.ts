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
// record in somebody's app, so a false `true` is the expensive direction and every test below that
// looks like a duplicate is a separate way the window could be left open.
//
// The bootstrap is RUN rather than read, for the reason `test_viewNotice.ts` gives: a test that
// greps the generated string agrees with the implementation and not with reality. Dispatch is
// modelled by hand — window capture first, window bubble last, the listener list copied when its
// object is reached, a microtask checkpoint between handlers — because those four are the DOM
// facts the design rests on, and a model that got them wrong would be the thing under test.

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
  submit: (cid: string, values: Record<string, string>) => Promise<unknown>;
  transition: (cid: string, itemId: string, to: string) => Promise<unknown>;
}

/** The bootstrap, running, with a window that keeps every listener rather than the last one per
 *  name. The existing harness keeps one, which is enough for the notice tests and is exactly what
 *  this file cannot use: the whole mechanism is TWO listeners for `click` on one object. */
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
    // The bootstrap's own net under a dispatch that never comes back. The real one is the browser's.
    setTimeout,
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
  return { win, listeners, bridge, asked, marks };
};

type Frame = ReturnType<typeof runBootstrap>;

/** A microtask checkpoint. Several, because a chain of `await`s cascades and each link is queued
 *  during the drain of the one before it. */
const settle = async (): Promise<void> => {
  for (let n = 0; n < 5; n += 1) await Promise.resolve();
};

/** A turn of the event loop — which is where a `setTimeout` callback lands, and the side of the
 *  window a page acting on its own is on. */
const laterTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** ONE dispatch of a click, as the DOM performs it.
 *
 *  `during` stands in for everything between the two window phases — the author's handlers on the
 *  path. `reachesWindowAgain: false` is a handler that called `stopPropagation()`, which is the
 *  case the bootstrap's timer is under. */
const clickThrough = async (frame: Frame, options: { trusted?: boolean; during?: () => void | Promise<void>; reachesWindowAgain?: boolean } = {}) => {
  const event = { isTrusted: options.trusted !== false, type: "click" };
  const phase = (capture: boolean) => frame.listeners.filter((one) => one.type === "click" && one.capture === capture).slice();
  for (const one of phase(true)) one.handler(event);
  await settle();
  if (options.during !== undefined) await options.during();
  await settle();
  if (options.reachesWindowAgain !== false) for (const one of phase(false)) one.handler(event);
  await settle();
};

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

test("a submit from a handler on the window itself, on the way back up, is marked", async () => {
  // What the tail listener is registered mid-dispatch for. Registered at startup it would sit
  // BEFORE the author's own window listener — the bootstrap runs before their HTML is parsed — and
  // would close the window while the page was still handling the click.
  const frame = runBootstrap();
  (frame.win.addEventListener as (type: string, handler: () => void) => void)("click", () => void frame.bridge.submit("orders", { name: "x" }));
  await clickThrough(frame);
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

test("a submit from a timer set by the click is NOT marked", async () => {
  // The one that defeated the last timing attempt: the page waits, then submits. There is no window
  // length that catches it, because it can wait for any length.
  const frame = runBootstrap();
  await clickThrough(frame, { during: () => void setTimeout(() => void frame.bridge.submit("orders", { name: "x" }), 0) });
  await laterTurn();
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

test("a dispatch that never comes back to the window does not leave it open", async () => {
  // A handler calling stopPropagation(). Without the timer under it, `clicking` would never return
  // to zero and EVERY later submission — timers included — would be marked for ever after.
  const frame = runBootstrap();
  await clickThrough(frame, { reachesWindowAgain: false });
  await laterTurn();
  await settle();
  void frame.bridge.submit("orders", { name: "x" });
  await settle();
  assert.deepEqual(frame.marks(), [false]);
});

test("a click the page dispatches INSIDE a real one does not close the real one's window", async () => {
  // The inner dispatch reaches the window on its way back up too, and it does so BEFORE the outer
  // one does. A close that answered to any click would fire there and end the real click's window
  // while the page was still inside it — so a form whose handler calls `other.click()` first would
  // go unmarked, silently. This failed until the close was tied to its own Event object.
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
