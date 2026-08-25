// ONE PARENT, and the property that made it worth merging two: every ask is ANSWERED on every
// page.
//
// The bug this file exists to keep out is not a wrong answer — it is no answer. A page's `submit`,
// `transition`, `assign`, `withdraw` and `mine` all return promises with no timeout, so a parent
// that drops one leaves a button that does nothing and nothing anywhere that says why. That is what
// the two old parents did to each other's half of the vocabulary: an intent posted to the public
// page was read as "not a submission" with no request id and dropped, and a submission posted to a
// member page came back `unsupported-request` however the app was declared.
//
// So the table below is the test. Every ask, against a host that serves nothing, and against a host
// that serves everything — and the assertion in both columns is that SOMETHING came back, addressed
// to the request that was made.

import { test } from "node:test";
import assert from "node:assert/strict";

import { viewParent, HOST_ERROR, READ_ONLY, UNSUPPORTED_REQUEST, type ViewParentPorts } from "../src/view/parent.js";
import { VIEW_MESSAGE } from "../src/view/protocol.js";
import type { BridgeCells, Channel } from "../src/view/bridge.js";
import type { ViewSubmitConfig } from "../src/view/message.js";

const NONCE = "nonce-1";
const ready = { type: VIEW_MESSAGE.ready, nonce: NONCE };

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

/** Let every port's promise chain finish. A lookup settles through two `then`s, an intent through
 *  one, and a test that awaited a fixed number of them would pass or fail on that count rather than
 *  on the behaviour. */
const settle = async () => {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
  }
};

const config: ViewSubmitConfig = { submit: { bookings: { createFields: ["note"] } } };

/** Every ask the bootstrap can make, each addressed to somebody waiting. */
const ASKS = [
  { name: "submit", message: { type: VIEW_MESSAGE.submit, requestId: "r-submit", cid: "bookings", values: { note: "x" } } },
  { name: "lookup", message: { type: VIEW_MESSAGE.lookup, requestId: "r-lookup", cid: "bookings", key: "slot-1" } },
  { name: "transition", message: { type: VIEW_MESSAGE.intent, requestId: "r-transition", kind: "transition", cid: "bookings", itemId: "i", to: "cancelled" } },
  { name: "assign", message: { type: VIEW_MESSAGE.intent, requestId: "r-assign", kind: "assign", cid: "bookings", itemId: "i", to: "a@example.com" } },
  { name: "withdraw", message: { type: VIEW_MESSAGE.intent, requestId: "r-withdraw", kind: "withdraw", cid: "bookings", itemId: "i" } },
] as const;

const opened = (ports: Omit<ViewParentPorts, "channel">, far: ReturnType<typeof fakeChannel>, cell = cells()) => {
  const parent = viewParent(
    { channel: () => far.channel, ...ports },
    () => config,
    () => NONCE,
    cell,
  );
  parent.receive(ready);
  far.send({ nonce: NONCE });
  far.posted.length = 0; // the state message; not what these tests are about
  return parent;
};

test("a host that serves nothing still answers every ask", async () => {
  // The read-only page: no `submit`, no `perform`, no `lookup`. Every one of the five is refused BY
  // NAME. Nothing is dropped — which is the whole difference between a disabled control and a
  // broken one.
  for (const ask of ASKS) {
    const far = fakeChannel();
    opened({ state: () => ({}), defect: () => {} }, far);
    far.send(ask.message);
    await settle();
    const answer = far.posted.at(-1);
    assert.equal(answer?.requestId, ask.message.requestId, `${ask.name} was dropped`);
    if (ask.name === "lookup") {
      // A lookup settles in its OWN shape. A `result` would reach `mine()` with no `known` on it,
      // which a page cannot tell from "nobody looked" — and "no" is the one answer a parent must
      // never make up.
      assert.deepEqual(answer, { type: VIEW_MESSAGE.lookupResult, requestId: "r-lookup", known: false, found: false });
      continue;
    }
    assert.equal(answer?.ok, false);
    assert.equal(answer?.error, READ_ONLY, `${ask.name} should say the host writes nothing`);
  }
});

test("a host that serves everything performs every ask, whatever page it is", async () => {
  // The same five, on ONE parent with every port wired — which is the shape a public page and a
  // member page now both get. The public page used to have no `perform` at all, so its three
  // intents went nowhere; the member page had no `submit` and no `lookup`.
  for (const ask of ASKS) {
    const far = fakeChannel();
    const parent = opened(
      {
        state: () => ({}),
        submit: async () => ({ ok: true }),
        lookup: async () => ({ found: true, record: { id: "slot-1" } }),
        perform: () => async (data) => ({ requestId: (data as { requestId: string }).requestId, ok: true }),
        defect: () => {},
      },
      far,
    );
    far.send(ask.message);
    await settle();
    if (ask.name === "submit") {
      // A submission is a CONFIRMATION first, on every page: the ask kind decides that, not the
      // audience. Nothing is posted until the host's dialog is answered.
      assert.deepEqual([...far.posted], [], "a submission must not be written before it is accepted");
      await parent.accept();
      assert.equal(far.posted.at(-1)?.type, VIEW_MESSAGE.state, "the state is re-sent after a write");
      assert.equal(far.posted.at(0)?.requestId, "r-submit");
      assert.equal(far.posted.at(0)?.ok, true);
      continue;
    }
    await settle();
    const answer = far.posted.at(-1);
    assert.equal(answer?.requestId, ask.message.requestId, `${ask.name} was dropped`);
    if (ask.name === "lookup") {
      assert.deepEqual(answer, { type: VIEW_MESSAGE.lookupResult, requestId: "r-lookup", known: true, found: true, record: { id: "slot-1" } });
      continue;
    }
    assert.equal(answer?.ok, true);
  }
});

test("the viewer carries both halves, and neither half is invented", () => {
  // `mine` and `{ me, can }` used to belong to different parents, so a page could have one or the
  // other. They travel together now — and a host offering neither sends no `viewer` key at all,
  // because the bootstrap hands `data.viewer || {}` to `onState` and `{}` would reach the page as
  // "you may do nothing and you have submitted nothing". Two claims a silent host has not made.
  const both = fakeChannel();
  viewParent(
    {
      channel: () => both.channel,
      state: () => ({}),
      viewer: () => ({
        me: null,
        can: {
          bookings: { cid: "bookings", transitionAny: true, transitionOwn: false, assign: false, assignees: [], withdrawFrom: ["pending"], withdrawAny: false, sealed: [] },
        },
      }),
      mine: () => ({ bookings: [{ id: "b1" }] }),
      defect: () => {},
    },
    () => config,
    () => NONCE,
    cells(),
  ).receive(ready);
  both.send({ nonce: NONCE });
  const viewer = both.posted[0]?.viewer as Record<string, unknown>;
  assert.equal(viewer.me, null);
  assert.deepEqual(viewer.mine, { bookings: [{ id: "b1" }] });
  assert.equal((viewer.can as Record<string, { transitionAny: boolean }>).bookings?.transitionAny, true);

  const neither = fakeChannel();
  viewParent(
    { channel: () => neither.channel, state: () => ({}), defect: () => {} },
    () => config,
    () => NONCE,
    cells(),
  ).receive(ready);
  neither.send({ nonce: NONCE });
  assert.equal(Object.hasOwn(neither.posted[0] ?? {}, "viewer"), false);
});

test("only the handshake and a notice are acted on from the WINDOW", async () => {
  // Everything a page asks for travels on the private channel — the bootstrap holds its outbox
  // until it has one — so an ask arriving on the window is not our document's. The public parent
  // used to route the window through the same dispatch as the port; this is the stricter of the two
  // old rules, and the one that survived.
  const far = fakeChannel();
  const notices: string[] = [];
  const parent = viewParent(
    { channel: () => far.channel, state: () => ({}), submit: async () => ({ ok: true }), notice: (n) => notices.push(n.code), defect: () => {} },
    () => config,
    () => NONCE,
    cells(),
  );
  parent.receive(ready);
  far.send({ nonce: NONCE });
  far.posted.length = 0;
  parent.receive({ type: VIEW_MESSAGE.submit, requestId: "r-window", cid: "bookings", values: { note: "x" } });
  await settle();
  assert.deepEqual([...far.posted], []);
  parent.receive({ type: VIEW_MESSAGE.notice, nonce: NONCE, code: "error", detail: "boom" });
  assert.deepEqual(notices, ["error"]);
});

test("a port that breaks answers the page first and tells the host second", async () => {
  // Both directions of the same rule: the view is never left waiting on a host's own bug, and the
  // bug is never swallowed. `defect` is required for exactly this.
  const far = fakeChannel();
  const defects: (string | null)[] = [];
  opened(
    {
      state: () => ({}),
      perform: () => () => Promise.reject(new Error("boom")),
      lookup: () => Promise.reject(new Error("also boom")),
      defect: (_error, requestId) => defects.push(requestId),
    },
    far,
  );
  far.send({ type: VIEW_MESSAGE.intent, requestId: "r-1", kind: "withdraw", cid: "bookings", itemId: "i" });
  await settle();
  assert.equal(far.posted.at(-1)?.error, HOST_ERROR);

  far.send({ type: VIEW_MESSAGE.lookup, requestId: "r-2", cid: "bookings", key: "k" });
  await settle();
  // A failed READ is `known: false` — nobody looked — and never `found: false`, which would tell
  // the visitor they have not answered.
  assert.deepEqual(far.posted.at(-1), { type: VIEW_MESSAGE.lookupResult, requestId: "r-2", known: false, found: false });
  assert.deepEqual(defects, ["r-1", "r-2"]);
});

test("an ask nobody is waiting on is not answered, and an unrecognised one is", async () => {
  const far = fakeChannel();
  const performed: unknown[] = [];
  opened(
    {
      state: () => ({}),
      perform: () => async (data) => {
        performed.push(data);
        return null;
      },
      defect: () => {},
    },
    far,
  );
  far.send({ hello: "there" });
  await settle();
  assert.deepEqual([...far.posted], [], "no request id is nobody waiting");
  assert.deepEqual(performed, [], "and the host is not asked about it either");

  far.send({ type: "mc-public-view:something-else", requestId: "r-3" });
  await settle();
  assert.equal(far.posted.at(-1)?.error, UNSUPPORTED_REQUEST);
});

test("a submit port that throws SYNCHRONOUSLY still answers, and still reports", async () => {
  // `.catch()` alone reaches a rejected promise and not an exception thrown on the way to returning
  // one. Without this the throw left `accept` altogether: `sending` stayed true, the dialog stayed
  // open over a write nobody could retry, the page's promise never settled, and the host was told
  // nothing. Every other port in this file was already written the careful way; this one was not.
  const far = fakeChannel();
  const defects: (string | null)[] = [];
  const cell = cells();
  const parent = opened(
    {
      state: () => ({}),
      submit: () => {
        throw new Error("the host blew up before it returned a promise");
      },
      defect: (_error, requestId) => defects.push(requestId),
    },
    far,
    cell,
  );
  far.send(ASKS[0].message);
  await settle();
  await parent.accept();
  await settle();

  assert.deepEqual(cell.pending.value, null, "the confirmation must not be left open");
  assert.equal(cell.sending.value, false, "and it must not be left disabled");
  // The RESULT, not the last message: the state is re-sent behind it, because as far as this parent
  // knows the write may have landed before the host threw.
  const answered = far.posted.find((message) => message.type === VIEW_MESSAGE.result);
  assert.equal(answered?.requestId, "r-submit");
  assert.equal(answered?.ok, false);
  assert.deepEqual(defects, ["r-submit"], "the host's own bug is reported, after the view is answered");
});

test("a write that lands after a restart answers its OWN page, and settles nobody else's", async () => {
  // A view is republished, or the reader navigates, while a write is in flight. The cells are the
  // host's and `restart()` clears them — so by the time the write resolves, the confirmation they
  // hold may be a DIFFERENT visitor's, on a different page, on a different channel.
  //
  // Settling unconditionally closed that one: the dialog vanished under their cursor and their own
  // request was never answered. Answering on `open` posted the old request's result to a page that
  // never made it.
  const first = fakeChannel();
  const second = fakeChannel();
  let next = first;
  const cell = cells();
  // Assigned inside the promise executor, and the executor runs synchronously — so by the time the
  // write is awaited this is the real `resolve`. Initialised rather than left null because control
  // flow cannot see that from here, and a test that silently skipped the release would pass by
  // never testing anything.
  let release: (outcome: { ok: boolean }) => void = () => {
    throw new Error("the write was released before it started");
  };
  const parent = viewParent(
    {
      channel: () => next.channel,
      state: () => ({}),
      submit: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      defect: () => {},
    },
    () => config,
    () => NONCE,
    cell,
  );
  parent.receive(ready);
  first.send({ nonce: NONCE });
  first.posted.length = 0;
  first.send(ASKS[0].message);
  await settle();
  const writing = parent.accept();

  // The page goes. A new one arrives, asks for its own write, and is waiting on its own dialog.
  parent.restart();
  next = second;
  parent.receive(ready);
  second.send({ nonce: NONCE });
  second.posted.length = 0;
  second.send({ type: VIEW_MESSAGE.submit, requestId: "r-second", cid: "bookings", values: { note: "y" } });
  await settle();
  assert.equal(cell.pending.value?.requestId, "r-second", "the new page's confirmation is open");

  release({ ok: true });
  await writing;
  await settle();

  assert.equal(cell.pending.value?.requestId, "r-second", "and it is still open afterwards");
  assert.deepEqual([...second.posted], [], "nothing from the old write reaches the new page");
  assert.equal(first.posted.at(-1)?.requestId, "r-submit", "the page that asked is answered on its own channel");
});

// --- `written()`: the confirmation is about the RECORD, not about the host's follow-up work ------
//
// A host that refreshes after a write held the dialog open while it did — a modal over the page for
// two more round trips, and for ever if a read hung. It was hidden for as long as MulmoServer's
// member page happened to refresh by remounting the frame, which took the dialog with it; the day
// that stopped, the dialog stayed up on every post.

test("the host may close the confirmation when the record lands, and keep working behind it", async () => {
  const far = fakeChannel();
  const cell = cells();
  // Initialised to a throw rather than to null: assigned inside the port, TypeScript narrows a
  // nullable to `null` at the call below, and a test that has not started its write should say so
  // loudly anyway.
  let release: (outcome: { ok: boolean }) => void = () => {
    throw new Error("the write was released before it started");
  };
  const parent = opened(
    {
      state: () => ({}),
      // The shape a refreshing host has: write, SAY SO, then read back.
      submit: (_request, written) => {
        written();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      defect: () => {},
    },
    far,
    cell,
  );
  far.send(ASKS[0].message);
  await settle();
  assert.equal(cell.pending.value?.requestId, "r-submit", "the confirmation opened");

  const writing = parent.accept();
  await settle();
  assert.equal(cell.pending.value, null, "and closed on the write, with the port still outstanding");
  assert.equal(cell.sending.value, false);
  // What has NOT happened yet: the page is answered when the port settles, so a host that refreshes
  // first still sends the fresh state after the answer rather than before it.
  assert.deepEqual([...far.posted], [], "nobody has been answered yet");

  release({ ok: true });
  await writing;
  assert.equal(far.posted.at(0)?.requestId, "r-submit");
  assert.equal(far.posted.at(0)?.ok, true);
  assert.equal(far.posted.at(-1)?.type, VIEW_MESSAGE.state, "and the state that follows is the refreshed one");
});

test("a host that ignores `written` is unchanged: the dialog closes when the write does", async () => {
  const far = fakeChannel();
  const cell = cells();
  // Initialised to a throw rather than to null: assigned inside the port, TypeScript narrows a
  // nullable to `null` at the call below, and a test that has not started its write should say so
  // loudly anyway.
  let release: (outcome: { ok: boolean }) => void = () => {
    throw new Error("the write was released before it started");
  };
  const parent = opened(
    {
      state: () => ({}),
      submit: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      defect: () => {},
    },
    far,
    cell,
  );
  far.send(ASKS[0].message);
  await settle();
  const writing = parent.accept();
  await settle();
  assert.equal(cell.pending.value?.requestId, "r-submit", "still open while the port is outstanding");

  release({ ok: true });
  await writing;
  assert.equal(cell.pending.value, null);
});

test("closing early does not close the confirmation the NEXT page opened", async () => {
  // The same property the in-flight test above pins, on the new path: `written` may arrive after a
  // restart, and the cells then belong to somebody else. The write still gets its answer, on the
  // channel it came in on.
  const first = fakeChannel();
  const cell = cells();
  let written: () => void = () => {
    throw new Error("the port was never called");
  };
  // Initialised to a throw rather than to null: assigned inside the port, TypeScript narrows a
  // nullable to `null` at the call below, and a test that has not started its write should say so
  // loudly anyway.
  let release: (outcome: { ok: boolean }) => void = () => {
    throw new Error("the write was released before it started");
  };
  const parent = viewParent(
    {
      channel: () => first.channel,
      state: () => ({}),
      submit: (_request, say) => {
        written = say;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      defect: () => {},
    },
    () => config,
    () => NONCE,
    cell,
  );
  parent.receive(ready);
  first.send({ nonce: NONCE });
  first.posted.length = 0;
  first.send(ASKS[0].message);
  await settle();
  const writing = parent.accept();

  // The reader navigates; a new page opens a confirmation of its own.
  parent.restart();
  cell.pending.value = { requestId: "r-second", cid: "bookings", values: { note: "y" } };

  written();
  assert.equal(cell.pending.value?.requestId, "r-second", "the new page's dialog is untouched");

  release({ ok: true });
  await writing;
  assert.equal(cell.pending.value?.requestId, "r-second", "and still untouched afterwards");
  assert.equal(first.posted.at(-1)?.requestId, "r-submit", "the write that asked is still answered");
});

test("a write that closed early and finished behind a REPLACED page tells only the page that asked", async () => {
  // The half `closed` alone gets wrong. It says the cells are not ours to read any more — which a
  // restart makes true just as surely as the host reporting the write does — so a write still
  // running when the reader navigates would have pushed its state onto the page that replaced it.
  // The answer was always scoped to the channel it arrived on; this is the same test for the state.
  const first = fakeChannel();
  const second = fakeChannel();
  let next = first;
  const cell = cells();
  let written: () => void = () => {
    throw new Error("the port was never called");
  };
  let release: (outcome: { ok: boolean }) => void = () => {
    throw new Error("the write was released before it started");
  };
  const parent = viewParent(
    {
      channel: () => next.channel,
      state: () => ({}),
      submit: (_request, say) => {
        written = say;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      defect: () => {},
    },
    () => config,
    () => NONCE,
    cell,
  );
  parent.receive(ready);
  first.send({ nonce: NONCE });
  first.posted.length = 0;
  first.send(ASKS[0].message);
  await settle();
  const writing = parent.accept();
  written();
  assert.equal(cell.pending.value, null, "the host said the record landed, so the dialog went");

  // The reader navigates, and the page that replaces them completes its own handshake.
  parent.restart();
  next = second;
  parent.receive(ready);
  second.send({ nonce: NONCE });
  second.posted.length = 0;

  release({ ok: true });
  await writing;
  await settle();

  assert.deepEqual([...second.posted], [], "the replacement page hears nothing about a write it did not make");
  assert.equal(first.posted.at(-1)?.requestId, "r-submit", "and the page that asked is still answered");
  assert.equal(first.posted.at(-1)?.ok, true);
});
