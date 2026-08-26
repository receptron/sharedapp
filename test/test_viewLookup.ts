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
import vm from "node:vm";

import { viewBridge, type BridgeCells, type Channel } from "../src/view/bridge.js";
import { readLookupMessage } from "../src/view/message.js";
import { VIEW_MESSAGE } from "../src/view/protocol.js";
import { publicViewBootstrap } from "../src/view/srcdoc.js";

const NONCE = "nonce-1";
const ready = { type: VIEW_MESSAGE.ready, nonce: NONCE };
const CONFIG = { submit: { votes: { createFields: ["questionId", "choice"] } } };

const cells = (): BridgeCells => ({ pending: { value: null }, sending: { value: false }, readied: { value: false } });

const fakeChannel = () => {
  const posted: Record<string, unknown>[] = [];
  let handler: ((data: unknown) => void) | null = null;
  const channel: Channel = {
    post: (message) => posted.push(message),
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
  const asked: unknown[] = [];
  const { far } = open({
    lookup: async (request) => {
      asked.push(request);
      return { found: true };
    },
  });
  far.send(ask({ cid: "secrets" }));
  assert.deepEqual(await settled(far), { type: VIEW_MESSAGE.lookupResult, requestId: "r1", known: false, found: false });
  assert.deepEqual(asked, [], "and the host is never sent to look");
  assert.equal(
    far.posted.find((message) => message.type === VIEW_MESSAGE.result),
    undefined,
    "the refusal does not also arrive as a submission result",
  );
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

test("an empty key is ANSWERED, not dropped — and answered as a LOOKUP", async () => {
  // The hang this replaced: `view.mine("votes", "")` was read as "not a lookup", fell through to the
  // submission reader, was refused there with no request id — and nobody answered. A read has no
  // timeout, so the page waited forever with nothing on screen to say why.
  //
  // The second half is the shape. `mine()` reads `{ known, found }`; a `result` carrying
  // `{ ok: false }` settles the promise with no `known` on it, which a page cannot tell from
  // "nobody looked" — the author's mistake arriving as the parent's silence, one indirection later.
  const { far } = open({ lookup: async () => ({ found: true }) });
  far.send(ask({ key: "" }));
  assert.deepEqual(await settled(far), { type: VIEW_MESSAGE.lookupResult, requestId: "r1", known: false, found: false });
  assert.equal(
    far.posted.find((message) => message.type === VIEW_MESSAGE.result),
    undefined,
  );
});

test("a submission is still refused as a submission, and a message nobody waits on is not answered", async () => {
  // The acceptance side of the change above: only what READS as a lookup settles as one. A
  // submission's refusal keeps `result` — the page's `submit()` waits on `{ ok, error }` — and a
  // message with no request id is answered by nobody at all, because nobody asked.
  const { far } = open({ lookup: async () => ({ found: true }) });
  far.send({ type: VIEW_MESSAGE.submit, requestId: "r2", cid: "secrets", values: {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    far.posted.find((message) => message.type === VIEW_MESSAGE.result),
    { type: VIEW_MESSAGE.result, requestId: "r2", ok: false, error: "unknown-collection" },
  );
  assert.equal(
    far.posted.find((message) => message.type === VIEW_MESSAGE.lookupResult),
    undefined,
  );

  const quiet = open({ lookup: async () => ({ found: true }) });
  quiet.far.send({ type: VIEW_MESSAGE.lookup, cid: "", key: "" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(quiet.far.posted, [], "no request id, so nobody is waiting and nothing is posted");
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

test("a name every object has is not a collection this app declared", () => {
  // `config.submit.constructor` is a function, so a membership test written as `!== undefined`
  // called it a declared collection — and sent the host off to look up a row in a collection the
  // app never opened. Both readers use `hasOwn` now.
  for (const cid of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.deepEqual(readLookupMessage(ask({ cid }), CONFIG), { ok: false, reason: "unknown-collection", requestId: "r1" });
  }
  assert.equal(readLookupMessage(ask({}), CONFIG).ok, true, "and a real one still passes");
});

test("a request made before the channel opens is held, then answered", async () => {
  // The hang this replaced: a request sent on the WINDOW does reach the parent, and the answer
  // cannot come back — the parent replies only on the port. `ready()` followed by `mine()` in the
  // same turn was enough to lose it, silently, because a read has no timeout.
  //
  // The frame is driven here rather than the bridge: what changed is which door the request leaves
  // by, and only the bootstrap knows that.
  const posted: Record<string, unknown>[] = [];
  const listeners: ((event: Record<string, unknown>) => void)[] = [];
  const win: Record<string, unknown> = {
    addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => {
      if (type === "message") listeners.push(handler);
    },
    removeEventListener: () => {},
  };
  const context = { window: win, parent: { postMessage: (message: Record<string, unknown>) => posted.push(message) }, document: { currentScript: null } };
  vm.createContext(context);
  vm.runInContext(
    publicViewBootstrap(NONCE)
      .replace(/^\s*<script>/u, "")
      .replace(/<\/script>\s*$/u, ""),
    context,
  );

  const view = win.__MC_APP_VIEW as { ready: () => void; mine: (cid: string, key: string) => Promise<unknown> };
  view.ready();
  const answer = view.mine("votes", "q1");

  assert.deepEqual(
    posted.map((message) => message.type),
    [VIEW_MESSAGE.ready],
    "nothing but the handshake goes on the window",
  );

  const port = { postMessage: (message: Record<string, unknown>) => posted.push(message), onmessage: null as unknown };
  for (const handler of listeners) handler({ source: context.parent, data: { type: VIEW_MESSAGE.channel }, ports: [port] });

  const sent = posted.filter((message) => message.type === VIEW_MESSAGE.lookup);
  assert.equal(sent.length, 1, "the held request goes out once the port is open");
  assert.equal(sent[0]?.key, "q1");

  const onmessage = port.onmessage as (event: { data: unknown }) => void;
  onmessage({ data: { type: VIEW_MESSAGE.lookupResult, requestId: sent[0].requestId, known: true, found: true, record: { choice: "b" } } });
  // Field by field: the promise settles with an object built INSIDE the vm, and a structural
  // comparison across realms fails on the prototype rather than on anything this test is about.
  const settledAnswer = (await answer) as { known: boolean; found: boolean; record: { choice: string } };
  assert.equal(settledAnswer.known, true);
  assert.equal(settledAnswer.found, true);
  assert.equal(settledAnswer.record.choice, "b");
});
