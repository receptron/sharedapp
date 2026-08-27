// THE ONE WAY OUT OF THE FRAME.
//
// A view is `sandbox="allow-scripts"` and nothing else — no `allow-top-navigation`, no
// `allow-popups` — so an `<a href>` written in a page is inert. That was survivable while the
// platform drew a magazine's index itself. It is not survivable now that the index is the app's
// own HTML, because a front page is nothing but links to articles.
//
// So the page asks and the host navigates. Everything below is about the two properties that makes
// it safe to hand a sandboxed document: it names a RECORD rather than a URL, and it can only name
// the one collection this app draws articles from.

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { viewBridge, type BridgeCells, type Channel } from "../src/view/bridge.js";
import { readOpenMessage } from "../src/view/message.js";
import { VIEW_MESSAGE } from "../src/view/protocol.js";
import { publicViewBootstrap } from "../src/view/srcdoc.js";

const NONCE = "nonce-1";
const ready = { type: VIEW_MESSAGE.ready, nonce: NONCE };
const CONFIG = { submit: { articles: { createFields: ["title"] } }, articleCid: "articles" };

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

const ask = (fields: Record<string, unknown>) => ({ type: VIEW_MESSAGE.open, requestId: "r1", cid: "articles", id: "my-first-post", ...fields });

/** A bridge with the handshake already done, so a test can go straight to the ask. */
const opened = (ports: Partial<Parameters<typeof viewBridge>[0]>, config: Record<string, unknown> = CONFIG) => {
  const far = fakeChannel();
  const bridge = viewBridge(
    { channel: () => far.channel, submit: async () => ({ ok: true }), state: () => ({}), ...ports },
    () => config,
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
  return far.posted.find((message) => message.type === VIEW_MESSAGE.openResult);
};

test("the host is told which record, and builds the address itself", async () => {
  // THE PROPERTY THIS SHAPE EXISTS FOR. A page that could name a URL could send a visitor anywhere;
  // naming a record, it can only reach an article of the app they are already reading, and that is
  // a fact about the message rather than about a check somebody remembered to write.
  const asked: unknown[] = [];
  const { far } = opened({
    navigate: (request) => {
      asked.push(request);
      return true;
    },
  });

  far.send(ask({}));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(asked, [{ requestId: "r1", cid: "articles", id: "my-first-post" }]);
  // AND ANSWERED, which is this module's rule for every other ask: nothing is dropped. The reply
  // was left out at first, on the assumption that a navigation takes the document with it — wrong
  // twice over. A host may navigate WITHIN the page (mulmoserver pushes a route and the frame is
  // unmounted a tick later), and a host may believe it navigated when the router refused, which
  // leaves the page on screen waiting for ever on a headline that did nothing.
  assert.deepEqual(await settled(far), { type: VIEW_MESSAGE.openResult, requestId: "r1", opened: true });
});

test("and `opened` is the host's own word, not the fact that it was asked", async () => {
  // The distinction the answer exists to carry. `articleOpener` in mulmoserver returns whether the
  // ROUTER accepted the push, so a guard that refused it comes back here as a page that did not
  // move — and the page is told, rather than being left to conclude it from silence.
  const { far } = opened({ navigate: () => Promise.resolve(false) });
  far.send(ask({}));
  assert.deepEqual(await settled(far), { type: VIEW_MESSAGE.openResult, requestId: "r1", opened: false, reason: "no-navigation" });
});

test("a host that does not navigate says so, and it is not a refusal", async () => {
  // The author's preview pane: there is no history to push onto, and nothing about the ask was
  // wrong. A page told `no-navigation` has nothing to do about it — which is exactly why it must
  // not arrive looking like "that article does not exist".
  const without = opened({});
  without.far.send(ask({}));
  assert.deepEqual(await settled(without.far), { type: VIEW_MESSAGE.openResult, requestId: "r1", opened: false, reason: "no-navigation" });

  const declined = opened({ navigate: () => false });
  declined.far.send(ask({}));
  assert.deepEqual(await settled(declined.far), { type: VIEW_MESSAGE.openResult, requestId: "r1", opened: false, reason: "no-navigation" });
});

test("a host that throws SYNCHRONOUSLY is still an answer", async () => {
  // A port that reads a router off a ref throws in the same turn. Unhandled, the rejection escapes
  // and the page is left on a promise nothing will settle.
  const defects: unknown[] = [];
  const { far } = opened({
    navigate: () => {
      throw new Error("no router");
    },
    defect: (error) => defects.push(error),
  });
  far.send(ask({}));
  assert.deepEqual(await settled(far), { type: VIEW_MESSAGE.openResult, requestId: "r1", opened: false, reason: "no-navigation" });
  assert.equal(defects.length, 1, "and the host hears about its own bug");
});

test("a collection that is not the article one is refused, and the host is never sent", async () => {
  // `/a/{slug}/{id}` has nothing in it to say which collection an id belongs to, so a host that
  // navigated anyway would put the visitor on a page reading a record of a different collection —
  // an address that looks broken to whoever is handed the link.
  const asked: unknown[] = [];
  const { far } = opened({
    navigate: (request) => {
      asked.push(request);
      return true;
    },
  });
  far.send(ask({ cid: "notes" }));
  assert.deepEqual(await settled(far), { type: VIEW_MESSAGE.openResult, requestId: "r1", opened: false, reason: "unknown-collection" });
  assert.deepEqual(asked, []);
});

test("an app that publishes no articles has no such page to reach", async () => {
  const { far } = opened({ navigate: () => true }, { submit: { articles: { createFields: ["title"] } } });
  far.send(ask({}));
  assert.deepEqual(await settled(far), { type: VIEW_MESSAGE.openResult, requestId: "r1", opened: false, reason: "unknown-collection" });
});

test("an id that is not a path segment is refused before it reaches a URL", () => {
  // The grammar is the defence that does not depend on one host remembering to encode. A `/`
  // addresses a different route entirely, a leading `.` is a relative segment, and an empty id is
  // the index.
  for (const id of ["../secrets", "a/b", ".hidden", "", "a".repeat(129)]) {
    assert.deepEqual(readOpenMessage(ask({ id }), "articles"), { ok: false, reason: "invalid-open", requestId: "r1" }, `accepted '${id}'`);
  }
  // Wider than the slug grammar on purpose: an app whose articles carry generated ids has the same
  // claim on a link as one that names them.
  for (const id of ["my-first-post", "9f8b2c1e-4a5d-4c3b-8e7f-1a2b3c4d5e6f", "note_2026.01"]) {
    assert.equal(readOpenMessage(ask({ id }), "articles").ok, true, `refused '${id}'`);
  }
});

test("an open with nobody waiting is not answered, and one that is not an open falls through", () => {
  // No requestId, no promise: answering would be answering a message the page never sent.
  assert.deepEqual(readOpenMessage({ type: VIEW_MESSAGE.open, cid: "articles", id: "x" }, "articles"), {
    ok: false,
    reason: "not-an-open",
    requestId: "",
  });
  // And a submission stays a submission — the readers are told apart by type, and one put through
  // the wrong reader comes back refused with no request id and is answered by nobody.
  assert.deepEqual(readOpenMessage({ type: VIEW_MESSAGE.submit, requestId: "r2", cid: "articles", values: {} }, "articles"), {
    ok: false,
    reason: "not-an-open",
    requestId: "",
  });
});

test("a submission is still read as a submission once opens are routed first", async () => {
  // The dispatch order. Anything routed ahead of the submission reader has to let a submission
  // past, or the page's `submit()` is answered by nobody.
  const { far } = opened({ navigate: () => true });
  far.send({ type: VIEW_MESSAGE.submit, requestId: "r2", cid: "secrets", values: {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    far.posted.find((message) => message.type === VIEW_MESSAGE.result),
    { type: VIEW_MESSAGE.result, requestId: "r2", ok: false, error: "unknown-collection" },
  );
  assert.equal(
    far.posted.find((message) => message.type === VIEW_MESSAGE.openResult),
    undefined,
  );
});

test("the page calls it as `view.open`, and settles on the answer when one comes back", async () => {
  // Driven through the bootstrap rather than the bridge: what a page actually has is
  // `__MC_APP_VIEW`, and a verb the parent answers that the bootstrap never exposed would be a
  // feature nobody can reach.
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

  const view = win.__MC_APP_VIEW as { ready: () => void; open: (cid: string, id: string) => Promise<unknown> };
  view.ready();
  const answer = view.open("articles", "my-first-post");

  const port = { postMessage: (message: Record<string, unknown>) => posted.push(message), onmessage: null as unknown };
  for (const handler of listeners) handler({ source: context.parent, data: { type: VIEW_MESSAGE.channel }, ports: [port] });

  const sent = posted.filter((message) => message.type === VIEW_MESSAGE.open);
  assert.equal(sent.length, 1, "the held request goes out once the port is open");
  assert.equal(sent[0]?.cid, "articles");
  assert.equal(sent[0].id, "my-first-post");

  const onmessage = port.onmessage as (event: { data: unknown }) => void;
  onmessage({ data: { type: VIEW_MESSAGE.openResult, requestId: sent[0].requestId, opened: false, reason: "no-navigation" } });
  // Field by field: the object settles INSIDE the vm, and a structural comparison across realms
  // fails on the prototype rather than on anything this test is about.
  const done = (await answer) as { opened: boolean; reason: string };
  assert.equal(done.opened, false);
  assert.equal(done.reason, "no-navigation");
});
