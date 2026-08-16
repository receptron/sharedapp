// The member's parent: the handshake, and what happens to an ask.
//
// Written without an iframe, which is the point of the module being separate
// from the host component — `event.source` is the only part that needs a DOM.
//
// The two properties worth a test are the two that were divergent before this
// module existed. STATE CARRIES THE VIEWER: MulmoTerminal's pane used the
// public bridge, whose state message has no `viewer` key, so `data.viewer || {}`
// in the injected runtime handed every previewed roster page an empty object.
// AND AN ASK IS ANSWERED: a view left waiting on a promise is, to the person
// holding the phone, a button that does nothing.

import { test } from "node:test";
import assert from "node:assert/strict";

import { memberBridge } from "../src/view/memberBridge.js";
import { VIEW_MESSAGE } from "../src/view/protocol.js";
import type { Channel } from "../src/view/bridge.js";
import type { Viewer } from "../src/view/capability.js";
import type { PerformIntent } from "../src/view/memberBridge.js";

const NONCE = "nonce-1";

const viewer: Viewer = {
  me: "desk@gym.jp",
  can: { bookings: { cid: "bookings", transitionAny: true, transitionOwn: false, assign: false, assignees: [], withdrawFrom: [] } },
};

/** A channel that records what the parent posted and lets a test play the
 *  document's part. */
const fakeChannel = () => {
  const posted: Record<string, unknown>[] = [];
  let handler: ((data: unknown) => void) | null = null;
  let closed = false;
  const channel: Channel = {
    post: (message) => posted.push(message),
    onMessage: (fn) => {
      handler = fn;
    },
    close: () => {
      closed = true;
    },
  };
  return { channel, posted, send: (data: unknown) => handler?.(data), wasClosed: () => closed };
};

const ready = { type: VIEW_MESSAGE.ready, nonce: NONCE };

test("the data waits for an answer ON the port, and then carries the viewer", () => {
  const far = fakeChannel();
  const bridge = memberBridge({ channel: () => far.channel, state: () => ({ bookings: [{ id: "a" }] }), viewer: () => viewer }, () => NONCE);

  bridge.receive(ready);
  // Nothing yet: a `ready` is answered with a CHANNEL and nothing else.
  assert.equal(far.posted.length, 0);

  far.send({ nonce: NONCE });
  assert.equal(far.posted.length, 1);
  assert.equal(far.posted[0]?.type, VIEW_MESSAGE.state);
  assert.deepEqual(far.posted[0]?.viewer, viewer);
});

test("a document that only INHERITED the frame never gets the records", () => {
  const far = fakeChannel();
  const bridge = memberBridge({ channel: () => far.channel, state: () => ({ bookings: [] }), viewer: () => viewer }, () => NONCE);
  bridge.receive(ready);
  far.send({ nonce: "guessed" });
  assert.equal(far.posted.length, 0);
});

test("an ask is answered on the channel it arrived on", async () => {
  const far = fakeChannel();
  const answers: unknown[] = [];
  const bridge = memberBridge(
    {
      channel: () => far.channel,
      state: () => ({}),
      viewer: () => viewer,
      perform: () => (data) => {
        answers.push(data);
        return Promise.resolve({ requestId: "r1", ok: true });
      },
    },
    () => NONCE,
  );
  bridge.receive(ready);
  far.send({ nonce: NONCE });
  far.send({ type: VIEW_MESSAGE.intent, requestId: "r1", kind: "transition", cid: "bookings", itemId: "x", to: "approved" });
  await Promise.resolve();
  assert.equal(answers.length, 1);
  assert.equal(far.posted.at(-1)?.type, VIEW_MESSAGE.result);
  assert.equal(far.posted.at(-1)?.ok, true);
});

test("the handler is read when the intent arrives, not when the bridge is built", async () => {
  // A host holding `perform` in a reactive prop can have it replaced — by a
  // route change to another app, which is the case that would otherwise judge
  // app B's request with app A's ids.
  const far = fakeChannel();
  const seen: string[] = [];
  let current: PerformIntent = () => Promise.resolve({ requestId: "old", ok: true });
  const bridge = memberBridge({ channel: () => far.channel, state: () => ({}), viewer: () => viewer, perform: () => current }, () => NONCE);
  bridge.receive(ready);
  far.send({ nonce: NONCE });
  current = (data) => {
    seen.push(isRecordLike(data) ? String(data.requestId) : "?");
    return Promise.resolve({ requestId: "new", ok: true });
  };
  far.send({ type: VIEW_MESSAGE.intent, requestId: "r9", kind: "transition", cid: "bookings", itemId: "x", to: "approved" });
  await Promise.resolve();
  assert.deepEqual(seen, ["r9"]);
  assert.equal(far.posted.at(-1)?.requestId, "new");
});

const isRecordLike = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

test("a read-only page REFUSES rather than going quiet", async () => {
  const far = fakeChannel();
  const bridge = memberBridge({ channel: () => far.channel, state: () => ({}), viewer: () => viewer }, () => NONCE);
  bridge.receive(ready);
  far.send({ nonce: NONCE });
  far.send({ type: VIEW_MESSAGE.intent, requestId: "r2", kind: "transition", cid: "bookings", itemId: "x", to: "approved" });
  await Promise.resolve();
  const last = far.posted.at(-1);
  assert.equal(last?.type, VIEW_MESSAGE.result);
  assert.equal(last?.ok, false);
  assert.equal(last?.error, "read-only");
});

test("something nobody asked about is not answered", async () => {
  const far = fakeChannel();
  const bridge = memberBridge({ channel: () => far.channel, state: () => ({}), viewer: () => viewer }, () => NONCE);
  bridge.receive(ready);
  far.send({ nonce: NONCE });
  const before = far.posted.length;
  far.send({ hello: "there" });
  await Promise.resolve();
  assert.equal(far.posted.length, before);
});

test("a second ready offers no second channel, and forget closes the first", () => {
  let made = 0;
  const far = fakeChannel();
  const bridge = memberBridge(
    {
      channel: () => {
        made += 1;
        return far.channel;
      },
      state: () => ({}),
      viewer: () => viewer,
    },
    () => NONCE,
  );
  bridge.receive(ready);
  bridge.receive(ready);
  assert.equal(made, 1);
  bridge.forget();
  assert.equal(far.wasClosed(), true);
  // After forgetting, the next `ready` is a real first one.
  bridge.receive(ready);
  assert.equal(made, 2);
});

test("the page's own report is carried BEFORE the handshake, which is when it matters most", () => {
  // A page whose script throws while the document is being parsed never reaches `ready()`. It sits
  // on its loading state with the reason sealed inside the frame, and it is the one an author
  // cannot otherwise diagnose — so this must not wait for a connection that will never come.
  const far = fakeChannel();
  const heard: string[] = [];
  const bridge = memberBridge(
    { channel: () => far.channel, state: () => ({}), viewer: () => viewer, notice: (report) => heard.push(report.code) },
    () => NONCE,
  );
  bridge.receive({ type: VIEW_MESSAGE.notice, nonce: NONCE, code: "error", detail: "boom" });
  assert.deepEqual(heard, ["error"]);
  // And it did NOT count as the handshake: no channel was offered.
  assert.equal(far.posted.length, 0);
});

test("a host that keeps no notices is not made to", () => {
  // Dropping them is the honest default: a notice is the page's own words, and a host that keeps
  // them where nobody looks has built a place for personal data to accumulate.
  const far = fakeChannel();
  const bridge = memberBridge({ channel: () => far.channel, state: () => ({}), viewer: () => viewer }, () => NONCE);
  bridge.receive({ type: VIEW_MESSAGE.notice, nonce: NONCE, code: "error", detail: "boom" });
  bridge.receive(ready);
  far.send({ nonce: NONCE });
  assert.equal(far.posted.length, 1);
});

test("the handshake is visible to a host that asks to see it", () => {
  // Not bookkeeping. MulmoTerminal's headless run puts "It NEVER answered the handshake" at the top
  // of a page's report, over a paragraph saying nothing below describes the page's behaviour — so a
  // parent with nowhere to write this reports every healthy member page as the one page an author
  // cannot diagnose any other way.
  const far = fakeChannel();
  const readied = { value: false };
  const bridge = memberBridge({ channel: () => far.channel, state: () => ({}), viewer: () => viewer, readied }, () => NONCE);
  bridge.receive(ready);
  assert.equal(readied.value, false, "a channel offered is not a handshake answered");
  far.send({ nonce: NONCE });
  assert.equal(readied.value, true);
  // A new page is a new conversation, and the next `ready` is a real first one.
  bridge.forget();
  assert.equal(readied.value, false);
});

test("a document that cannot name the injected one does not count as the handshake", () => {
  const far = fakeChannel();
  const readied = { value: false };
  const bridge = memberBridge({ channel: () => far.channel, state: () => ({}), viewer: () => viewer, readied }, () => NONCE);
  bridge.receive(ready);
  far.send({ nonce: "guessed" });
  assert.equal(readied.value, false);
});
