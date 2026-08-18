// "HAVE I ALREADY GOT THIS ROW?" — the question a page can ask and cannot answer.
//
// `mine` (see `test_viewOwnRows.ts`) rides with the state, so the host must know the answer before
// the page has said anything. For `idFrom: "auth.uid+field"` it never can: the ids are
// `uid + "_" + <field>`, and the rules grant a submitter the document they can NAME rather than a
// range of them. The key is the half the host is missing and the page has.
//
// Everything below is about ONE distinction: "no" and "nobody looked" are different answers. A page
// told "no" stops offering the action — which, told to somebody entitled to it, is the exact bug
// this port was added to fix.

import { test } from "node:test";
import assert from "node:assert/strict";

import { viewBridge, type BridgeCells, type Channel } from "../src/view/bridge.js";
import { readLookupMessage } from "../src/view/message.js";
import { VIEW_MESSAGE } from "../src/view/protocol.js";

const NONCE = "nonce-1";
const ready = { type: VIEW_MESSAGE.ready, nonce: NONCE };
const CONFIG = { submit: { votes: { createFields: ["questionId", "choice"] } } };

const cells = (): BridgeCells => ({ pending: { value: null }, sending: { value: false }, readied: { value: false } });

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

const ask = (fields: Record<string, unknown>) => ({ type: VIEW_MESSAGE.lookup, requestId: "r1", cid: "votes", key: "q1", ...fields });

/** A bridge with the handshake already done, so a test can go straight to the ask. */
const open = (ports: Partial<Parameters<typeof viewBridge>[0]>) => {
  const far = fakeChannel();
  const bridge = viewBridge(
    { channel: () => far.channel, submit: async () => ({ ok: true }), state: () => ({}), ...ports },
    () => CONFIG,
    () => NONCE,
    cells(),
  );
  bridge.receive(ready);
  far.send({ nonce: NONCE });
  far.posted.length = 0; // the state message; not what these tests are about
  return { bridge, far };
};

const settled = async (far: ReturnType<typeof fakeChannel>) => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return far.posted.find((message) => message.type === VIEW_MESSAGE.lookupResult);
};

test("the row is read on demand and handed back projected", async () => {
  const asked: unknown[] = [];
  const { far } = open({
    lookup: async (request) => {
      asked.push(request);
      return { found: true, record: { choice: "b" } };
    },
  });

  far.send(ask({}));
  assert.deepEqual(await settled(far), { type: VIEW_MESSAGE.lookupResult, requestId: "r1", known: true, found: true, record: { choice: "b" } });
  assert.deepEqual(asked, [{ requestId: "r1", cid: "votes", key: "q1" }], "the host is told which key, and builds the id itself");
});

test("a row that is not there is a real answer", async () => {
  const { far } = open({ lookup: async () => ({ found: false }) });
  far.send(ask({}));
  assert.deepEqual(await settled(far), { type: VIEW_MESSAGE.lookupResult, requestId: "r1", known: true, found: false });
});

test("a host with no port, and a read that failed, both say nobody looked", async () => {
  // The two ways to not know, and they must not arrive as "no". A page drawing this as "you have
  // not answered" takes the action away from somebody entitled to it.
  const without = open({});
  without.far.send(ask({}));
  assert.deepEqual(await settled(without.far), { type: VIEW_MESSAGE.lookupResult, requestId: "r1", known: false, found: false });

  const failing = open({
    lookup: async () => {
      throw new Error("offline");
    },
  });
  failing.far.send(ask({}));
  assert.deepEqual(await settled(failing.far), { type: VIEW_MESSAGE.lookupResult, requestId: "r1", known: false, found: false });
});

test("a collection the app never opened is refused, not looked up", async () => {
  // The id strategy comes from that declaration, so there is nothing to build an id from — and
  // "not found" would be a claim about a collection this page has no business asking after.
  const { far } = open({ lookup: async () => ({ found: true }) });
  far.send(ask({ cid: "secrets" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const refusal = far.posted.find((message) => message.type === VIEW_MESSAGE.result);
  assert.deepEqual(refusal, { type: VIEW_MESSAGE.result, requestId: "r1", ok: false, error: "unknown-collection" });
});

test("a submission is still read as a submission", () => {
  // The two are told apart by type. Before the lookup was routed first, anything that was not a
  // submission fell through to `readSubmitMessage` and was answered by nobody — a promise the page
  // waits on forever, and a read has no timeout to escape it.
  assert.equal(readLookupMessage({ type: VIEW_MESSAGE.submit, requestId: "r2", cid: "votes", values: {} }, CONFIG).ok, false);
  const read = readLookupMessage(ask({}), CONFIG);
  assert.equal(read.ok, true);
});

test("a lookup with nothing to look up is refused without an answer nobody asked for", () => {
  // No requestId means there is no promise waiting — answering it would be answering a message the
  // page never sent, and this one falls through to be read as something else.
  assert.deepEqual(readLookupMessage({ type: VIEW_MESSAGE.lookup, cid: "votes", key: "q1" }, CONFIG), {
    ok: false,
    reason: "not-a-lookup",
    requestId: "",
  });
  // A malformed one WITH a request id is a different refusal, because somebody is waiting on it.
  assert.deepEqual(readLookupMessage(ask({ key: "" }), CONFIG), { ok: false, reason: "invalid-lookup", requestId: "r1" });
  assert.deepEqual(readLookupMessage(ask({ cid: "" }), CONFIG), { ok: false, reason: "invalid-lookup", requestId: "r1" });
});

test("an empty key is ANSWERED, not dropped", async () => {
  // The hang this replaced: `view.mine("votes", "")` was read as "not a lookup", fell through to the
  // submission reader, was refused there with no request id — and nobody answered. A read has no
  // timeout, so the page waited forever with nothing on screen to say why.
  const { far } = open({ lookup: async () => ({ found: true }) });
  far.send(ask({ key: "" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    far.posted.find((message) => message.type === VIEW_MESSAGE.result),
    {
      type: VIEW_MESSAGE.result,
      requestId: "r1",
      ok: false,
      error: "invalid-lookup",
    },
  );
});

test("a host that throws SYNCHRONOUSLY is still an answer", async () => {
  // Not a hypothetical: a port that reads a ref before awaiting anything throws in the same turn,
  // and an unhandled rejection there would leave the page waiting exactly as the empty key did.
  const { far } = open({
    lookup: () => {
      throw new Error("no session");
    },
  });
  far.send(ask({}));
  assert.deepEqual(await settled(far), { type: VIEW_MESSAGE.lookupResult, requestId: "r1", known: false, found: false });
});
