// What the visitor has ALREADY SUBMITTED, carried to a public view.
//
// The gap this closes: a public view is handed `public.read` and nothing else, and a collection
// people submit to is exactly the one that must not be there — one visitor would be reading every
// other visitor's answer. So a page could not tell whether the person in front of it had answered
// already. It kept that in a variable, a reload lost it, and the page then offered an action the
// rules were certain to refuse. The visitor met a permission error for behaving normally.
//
// The rows arrive PROJECTED BY THE HOST, and the two tests about absence are the ones worth
// keeping: "this host does not know" and "you have submitted nothing" are different statements,
// and a page that confuses them tells somebody they have already answered when they have not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { viewBridge, type BridgeCells, type Channel } from "../src/view/bridge.js";
import { VIEW_MESSAGE } from "../src/view/protocol.js";

const NONCE = "nonce-1";
const ready = { type: VIEW_MESSAGE.ready, nonce: NONCE };

const cells = (): BridgeCells => ({ pending: { value: null }, sending: { value: false }, readied: { value: false } });

/** A channel that records what the parent posted and lets a test play the document's part. */
const fakeChannel = () => {
  const posted: Record<string, unknown>[] = [];
  let handler: ((data: unknown) => void) | null = null;
  const channel: Channel = {
    post: (message) => posted.push(message as Record<string, unknown>),
    onMessage: (fn) => {
      handler = fn;
    },
    close: () => {},
  };
  return { channel, posted, send: (data: unknown) => handler?.(data) };
};

const MINE = { votes: [{ id: "uid-1_q1", choice: "b" }] };

test("the visitor's own rows ride with the state, on the handshake and on every update", () => {
  const far = fakeChannel();
  const bridge = viewBridge(
    { channel: () => far.channel, submit: async () => ({ ok: true }), state: () => ({ questions: [{ id: "q1" }] }), mine: () => MINE },
    () => null,
    () => NONCE,
    cells(),
  );

  bridge.receive(ready);
  far.send({ nonce: NONCE });
  assert.equal(far.posted[0]?.type, VIEW_MESSAGE.state);
  assert.deepEqual(far.posted[0]?.viewer, { mine: MINE }, "the first state a page ever sees must already say so");

  // A watched page is re-sent on every change, and the answer to "have I answered?" changes with
  // it — most obviously one tick after this visitor's own submission.
  bridge.sendState();
  assert.deepEqual(far.posted[1]?.viewer, { mine: MINE });
});

test("a host that does not offer them sends no viewer at all", () => {
  // NOT an empty object: the bootstrap hands the second argument to `onState` either way, so `{}`
  // would reach the page as "you have submitted nothing" — a statement this host never made.
  const far = fakeChannel();
  const bridge = viewBridge(
    { channel: () => far.channel, submit: async () => ({ ok: true }), state: () => ({ questions: [] }) },
    () => null,
    () => NONCE,
    cells(),
  );

  bridge.receive(ready);
  far.send({ nonce: NONCE });
  assert.equal(far.posted[0]?.type, VIEW_MESSAGE.state);
  assert.equal("viewer" in (far.posted[0] ?? {}), false);
});

test("a host that knows the visitor has submitted nothing says so, and it is not the same message", () => {
  const far = fakeChannel();
  const bridge = viewBridge(
    { channel: () => far.channel, submit: async () => ({ ok: true }), state: () => ({ questions: [] }), mine: () => ({ votes: [] }) },
    () => null,
    () => NONCE,
    cells(),
  );

  bridge.receive(ready);
  far.send({ nonce: NONCE });
  assert.deepEqual(far.posted[0]?.viewer, { mine: { votes: [] } });
});

test("a document that only INHERITED the frame gets none of it", () => {
  // The rows are this visitor's own answers. Whatever navigated the frame is not the document we
  // injected, and the nonce is the only thing that can tell them apart.
  const far = fakeChannel();
  const bridge = viewBridge(
    { channel: () => far.channel, submit: async () => ({ ok: true }), state: () => ({ questions: [] }), mine: () => MINE },
    () => null,
    () => NONCE,
    cells(),
  );

  bridge.receive(ready);
  far.send({ nonce: "guessed" });
  assert.equal(far.posted.length, 0);
});

test("a host that has not read yet says nothing, and it is not an empty answer", () => {
  // The state that made this worth a shape of its own: the page opens, the read is in flight, and
  // the honest answer is "I do not know yet". Sent as `{}` it would read as "you have not answered"
  // — and the page would draw the form, then take it away a tick later when the read landed.
  const far = fakeChannel();
  const bridge = viewBridge(
    { channel: () => far.channel, submit: async () => ({ ok: true }), state: () => ({ questions: [] }), mine: () => undefined },
    () => null,
    () => NONCE,
    cells(),
  );

  bridge.receive(ready);
  far.send({ nonce: NONCE });
  assert.equal("viewer" in (far.posted[0] ?? {}), false);
});
