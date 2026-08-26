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

import { HOST_ERROR, UNSUPPORTED_REQUEST, memberBridge } from "../src/view/memberBridge.js";
import { VIEW_MESSAGE } from "../src/view/protocol.js";
import type { Channel } from "../src/view/bridge.js";
import type { Viewer } from "../src/view/capability.js";
import type { PerformIntent } from "../src/view/memberBridge.js";

const NONCE = "nonce-1";

const viewer: Viewer = {
  me: "desk@gym.jp",
  can: {
    bookings: {
      cid: "bookings",
      transitionAny: true,
      transitionOwn: false,
      assign: false,
      assignees: [],
      withdrawFrom: [],
      withdrawAny: false,
      sealed: [],
      // Nothing correctable: this reader is the DESK, and a writer is not narrowed per status —
      // `isWriter` in the rules carries no field list at all.
      correctFrom: {},
      correctAny: false,
    },
  },
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

/** A host that has SAID it wants nothing done with a defect. `defect` is
 *  required, so this is a decision written down rather than a port nobody
 *  passed — the distinction the port exists to make. Every test that is not
 *  about defects uses it. */
const noDefect = (): void => {};

test("the data waits for an answer ON the port, and then carries the viewer", () => {
  const far = fakeChannel();
  const bridge = memberBridge({ channel: () => far.channel, state: () => ({ bookings: [{ id: "a" }] }), viewer: () => viewer, defect: noDefect }, () => NONCE);

  bridge.receive(ready);
  // Nothing yet: a `ready` is answered with a CHANNEL and nothing else.
  assert.equal(far.posted.length, 0);

  far.send({ nonce: NONCE });
  assert.equal(far.posted.length, 1);
  assert.equal(far.posted[0]?.type, VIEW_MESSAGE.state);
  assert.deepEqual(far.posted[0].viewer, viewer);
});

test("a document that only INHERITED the frame never gets the records", () => {
  const far = fakeChannel();
  const bridge = memberBridge({ channel: () => far.channel, state: () => ({ bookings: [] }), viewer: () => viewer, defect: noDefect }, () => NONCE);
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
      defect: noDefect,
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
  const bridge = memberBridge({ channel: () => far.channel, state: () => ({}), viewer: () => viewer, defect: noDefect, perform: () => current }, () => NONCE);
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
  const bridge = memberBridge({ channel: () => far.channel, state: () => ({}), viewer: () => viewer, defect: noDefect }, () => NONCE);
  bridge.receive(ready);
  far.send({ nonce: NONCE });
  far.send({ type: VIEW_MESSAGE.intent, requestId: "r2", kind: "transition", cid: "bookings", itemId: "x", to: "approved" });
  await Promise.resolve();
  const last = far.posted.at(-1);
  assert.equal(last?.type, VIEW_MESSAGE.result);
  assert.equal(last.ok, false);
  assert.equal(last.error, "read-only");
});

test("something nobody asked about is not answered", async () => {
  const far = fakeChannel();
  const bridge = memberBridge({ channel: () => far.channel, state: () => ({}), viewer: () => viewer, defect: noDefect }, () => NONCE);
  bridge.receive(ready);
  far.send({ nonce: NONCE });
  const before = far.posted.length;
  far.send({ hello: "there" });
  await Promise.resolve();
  assert.equal(far.posted.length, before);
});

/** A parent whose `perform` recognises nothing — the shape a roster host has
 *  the moment a page calls something outside the intent vocabulary. */
const answersNothing = (far: ReturnType<typeof fakeChannel>) => {
  const bridge = memberBridge(
    { channel: () => far.channel, state: () => ({}), viewer: () => viewer, defect: noDefect, perform: () => () => Promise.resolve(null) },
    () => NONCE,
  );
  bridge.receive(ready);
  far.send({ nonce: NONCE });
  far.posted.length = 0; // the state message; not what these tests are about
  return bridge;
};

test("a submission from a member page is REFUSED, not dropped", async () => {
  // ONE bootstrap serves every page, so a member view holds the whole vocabulary and can call
  // `submit`. Dropped, the page sits on a promise that never settles: the dead button, with nothing
  // anywhere to say why.
  //
  // The word is `unknown-collection` rather than `unsupported-request`, and the change is the point
  // rather than a detail. A submission is now judged against the DECLARATION the host passed, on
  // whichever page it arrived — this adapter passes none, so there is no collection to write to and
  // it says exactly that. A host that wants member submissions declares them and gets a
  // confirmation, like every other page. What the refusal names is the app, not which factory the
  // host happened to call.
  const far = fakeChannel();
  answersNothing(far);
  far.send({ type: VIEW_MESSAGE.submit, requestId: "r7", cid: "bookings", values: { a: "1" } });
  await Promise.resolve();
  assert.deepEqual(far.posted, [{ type: VIEW_MESSAGE.result, requestId: "r7", ok: false, error: "unknown-collection" }]);
});

test("a request nobody serves is still refused in one word", async () => {
  // The other half: a message that IS addressed to somebody waiting and is not a lookup, not a
  // submission, and not an intent this host recognises. `perform` answers null, and null means "not
  // recognised" rather than "nobody is waiting" — so the view is told, in the word published pages
  // compare.
  const far = fakeChannel();
  answersNothing(far);
  far.send({ type: "mc-public-view:whatever", requestId: "r9" });
  await Promise.resolve();
  assert.deepEqual(far.posted, [{ type: VIEW_MESSAGE.result, requestId: "r9", ok: false, error: UNSUPPORTED_REQUEST }]);
});

test("a lookup is settled as a LOOKUP, whatever handler the host passed", async () => {
  // `view.mine()` reads `{ known, found }`. A `result` would settle its promise with no `known` on
  // it at all — which a page cannot tell from "nobody looked", and "no" is the one answer this
  // parent must never make up: a page told it stops offering the action to somebody entitled to it.
  //
  // ALL THREE HOSTS, because every handler this parent can be given answers in the INTENT shape,
  // and the shape of a lookup's answer must not depend on which one it got. The read-only page is
  // the one that hid this: `refuseEverything` answers a lookup `{ ok: false, error: "read-only" }`,
  // so it never reached the branch that settles it and the page was told a refusal instead.
  const lookup = { type: VIEW_MESSAGE.lookup, requestId: "r8", cid: "bookings", key: "q1" };
  const settled = { type: VIEW_MESSAGE.lookupResult, requestId: "r8", known: false, found: false };

  const nothing = fakeChannel();
  answersNothing(nothing);
  nothing.send(lookup);
  await Promise.resolve();
  assert.deepEqual(nothing.posted, [settled], "a perform that recognises nothing");

  // No `perform` at all — the genuinely read-only page.
  const readOnly = fakeChannel();
  const bridge = memberBridge({ channel: () => readOnly.channel, state: () => ({}), viewer: () => viewer, defect: noDefect }, () => NONCE);
  bridge.receive(ready);
  readOnly.send({ nonce: NONCE });
  readOnly.posted.length = 0;
  readOnly.send(lookup);
  await Promise.resolve();
  assert.deepEqual(readOnly.posted, [settled], "no perform at all");

  // And a host whose handler answers everything: a lookup is still not its to answer, because it
  // cannot answer one in the shape the page reads.
  const eager = fakeChannel();
  const asked: unknown[] = [];
  const answering = memberBridge(
    {
      channel: () => eager.channel,
      state: () => ({}),
      viewer: () => viewer,
      defect: noDefect,
      perform: () => (data) => {
        asked.push(data);
        return Promise.resolve({ requestId: "r8", ok: true });
      },
    },
    () => NONCE,
  );
  answering.receive(ready);
  eager.send({ nonce: NONCE });
  eager.posted.length = 0;
  eager.send(lookup);
  await Promise.resolve();
  assert.deepEqual(eager.posted, [settled], "a perform that would have answered");
  assert.deepEqual(asked, [], "and it is never asked");
});

test("an unrecognised message with nobody waiting is still not answered", async () => {
  // The acceptance beside the two above: the refusal is owed to a REQUEST ID, not to every message
  // that arrives. Without one there is no promise to settle, and posting would be answering
  // something nobody asked.
  const far = fakeChannel();
  answersNothing(far);
  far.send({ hello: "there" });
  far.send({ type: VIEW_MESSAGE.lookup, cid: "bookings", key: "q1" });
  far.send({ type: VIEW_MESSAGE.submit, requestId: "", cid: "bookings", values: {} });
  await Promise.resolve();
  assert.deepEqual(far.posted, []);

  // Including on the read-only page, which answers every ASKED question and still asks nothing of
  // a message that carries no id.
  const readOnly = fakeChannel();
  const bridge = memberBridge({ channel: () => readOnly.channel, state: () => ({}), viewer: () => viewer, defect: noDefect }, () => NONCE);
  bridge.receive(ready);
  readOnly.send({ nonce: NONCE });
  readOnly.posted.length = 0;
  readOnly.send({ type: VIEW_MESSAGE.lookup, cid: "bookings", key: "q1" });
  await Promise.resolve();
  assert.deepEqual(readOnly.posted, []);
});

test("a perform that REJECTS still answers, in one fixed word", async () => {
  // The case this exists for: a host defect used to be dropped, and the view's
  // promise for that request never settled again. A button that will not come
  // back is worse than a refused one, and nobody can see why from inside.
  const far = fakeChannel();
  const defects: { error: unknown; requestId: string | null }[] = [];
  const bridge = memberBridge(
    {
      channel: () => far.channel,
      state: () => ({}),
      viewer: () => viewer,
      perform: () => () => Promise.reject(new Error("firestore: PERMISSION_DENIED at /apps/x/secret")),
      defect: (error, requestId) => defects.push({ error, requestId }),
    },
    () => NONCE,
  );
  bridge.receive(ready);
  far.send({ nonce: NONCE });
  far.send({ type: VIEW_MESSAGE.intent, requestId: "r3", kind: "transition", cid: "bookings", itemId: "x", to: "approved" });
  await Promise.resolve();
  const last = far.posted.at(-1);
  assert.equal(last?.type, VIEW_MESSAGE.result);
  assert.equal(last.requestId, "r3");
  assert.equal(last.ok, false);
  // The page is the author's; why the host broke is not.
  assert.equal(last.error, HOST_ERROR);
  assert.equal(JSON.stringify(last).includes("PERMISSION_DENIED"), false);
  // And the reason went to the host, which is where somebody can act on it.
  assert.equal(defects.length, 1);
  assert.equal(defects[0]?.requestId, "r3");
  assert.match(String((defects[0].error as Error).message), /PERMISSION_DENIED/);
});

test("a perform that THROWS before returning a promise is the same case", async () => {
  const far = fakeChannel();
  const bridge = memberBridge(
    {
      channel: () => far.channel,
      state: () => ({}),
      viewer: () => viewer,
      defect: noDefect,
      perform: () => () => {
        throw new Error("read of undefined");
      },
    },
    () => NONCE,
  );
  bridge.receive(ready);
  far.send({ nonce: NONCE });
  // It must not take the channel's handler down with it, either.
  far.send({ type: VIEW_MESSAGE.intent, requestId: "r4", kind: "transition", cid: "bookings", itemId: "x", to: "approved" });
  await Promise.resolve();
  const last = far.posted.at(-1);
  assert.equal(last?.requestId, "r4");
  assert.equal(last.error, HOST_ERROR);
});

test("a rejection about something nobody asked is still not answered", async () => {
  // The paired acceptance for the two above: `ok: false` is not posted at a
  // message that carries no request id, because there is no promise waiting on
  // one. A host with a defect hook still hears about it.
  const far = fakeChannel();
  const defects: (string | null)[] = [];
  const bridge = memberBridge(
    {
      channel: () => far.channel,
      state: () => ({}),
      viewer: () => viewer,
      perform: () => () => Promise.reject(new Error("boom")),
      defect: (_error, requestId) => defects.push(requestId),
    },
    () => NONCE,
  );
  bridge.receive(ready);
  far.send({ nonce: NONCE });
  const before = far.posted.length;
  far.send({ hello: "there" });
  await Promise.resolve();
  assert.equal(far.posted.length, before);
  // AND THE HOST IS NEVER ASKED. A message carrying no request id is nobody waiting, so it does not
  // reach `perform` at all — which is why there is no defect to report here even though this host's
  // `perform` rejects everything it is given. It used to be handed over and rejected, and the
  // rejection was then reported as a defect of the host over a message that was never a request.
  assert.deepEqual(defects, []);
});

test("a host that DISCARDS the reason still answers the view", async () => {
  // `defect` is required, so discarding is something a host says rather than
  // something it forgets — but the view's answer must not depend on what the
  // host does with the error, which is what `noDefect` stands for here.
  const far = fakeChannel();
  const bridge = memberBridge(
    { channel: () => far.channel, state: () => ({}), viewer: () => viewer, defect: noDefect, perform: () => () => Promise.reject(new Error("boom")) },
    () => NONCE,
  );
  bridge.receive(ready);
  far.send({ nonce: NONCE });
  far.send({ type: VIEW_MESSAGE.intent, requestId: "r5", kind: "transition", cid: "bookings", itemId: "x", to: "approved" });
  await Promise.resolve();
  assert.equal(far.posted.at(-1)?.error, HOST_ERROR);
});

test("a perform that ANSWERS is untouched by any of this", async () => {
  // The acceptance that keeps the refusals honest: a host's own refusal reaches
  // the view in the host's own words, and only a defect is flattened.
  const far = fakeChannel();
  const bridge = memberBridge(
    {
      channel: () => far.channel,
      state: () => ({}),
      viewer: () => viewer,
      defect: noDefect,
      perform: () => (data) => Promise.resolve({ requestId: isRecordLike(data) ? String(data.requestId) : "?", ok: false, error: "illegal-transition" }),
    },
    () => NONCE,
  );
  bridge.receive(ready);
  far.send({ nonce: NONCE });
  far.send({ type: VIEW_MESSAGE.intent, requestId: "r6", kind: "transition", cid: "bookings", itemId: "x", to: "approved" });
  await Promise.resolve();
  assert.equal(far.posted.at(-1)?.requestId, "r6");
  assert.equal(far.posted.at(-1)?.error, "illegal-transition");
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
      defect: noDefect,
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
    { channel: () => far.channel, state: () => ({}), viewer: () => viewer, defect: noDefect, notice: (report) => heard.push(report.code) },
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
  const bridge = memberBridge({ channel: () => far.channel, state: () => ({}), viewer: () => viewer, defect: noDefect }, () => NONCE);
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
  const bridge = memberBridge({ channel: () => far.channel, state: () => ({}), viewer: () => viewer, defect: noDefect, readied }, () => NONCE);
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
  const bridge = memberBridge({ channel: () => far.channel, state: () => ({}), viewer: () => viewer, defect: noDefect, readied }, () => NONCE);
  bridge.receive(ready);
  far.send({ nonce: "guessed" });
  assert.equal(readied.value, false);
});
