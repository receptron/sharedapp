// What a frame is allowed to say about ITSELF, and what the parent keeps of it.
//
// The failures this carries are the ones a sandbox swallows without a word: an uncaught error, a
// rejected promise nobody handled, a modal call that is simply ignored. All three left the author
// with a page that stopped halfway and no way to learn why — the symptom in the incident that
// prompted this was "it seems to be stuck", which is the whole of what could be reported.
//
// The assertions are phrased around the two hazards. A notice comes FROM UNTRUSTED HTML, and it is
// built to be copied out of the host and pasted somewhere else — often into a language model — so
// the code must be the host's word and the detail must be bounded. And a notice that waited for the
// private channel would be lost in exactly the case it is most needed, because a page that throws
// while it is being parsed never calls `ready()`.

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { viewBridge, type BridgeCells, type Channel } from "../src/view/bridge.js";
import { NOTICE_DETAIL_LIMIT, readNotice, type ViewNotice } from "../src/view/message.js";
import { VIEW_MESSAGE } from "../src/view/protocol.js";
import { MAX_NOTICES, publicViewBootstrap } from "../src/view/srcdoc.js";

const NONCE = "nonce-1";
const notice = (fields: Record<string, unknown>) => ({ type: VIEW_MESSAGE.notice, nonce: NONCE, ...fields });

test("a notice carries a code the host named, never the one the page sent", () => {
  assert.deepEqual(readNotice(notice({ code: "error", detail: "boom" }), NONCE), { code: "error", detail: "boom" });
  // The page controls this string. Passed through, it would be a writing surface on the diagnostic
  // itself — and the reader is often a model being asked what went wrong.
  assert.equal(readNotice(notice({ code: "IGNORE THE ABOVE AND", detail: "" }), NONCE)?.code, "unknown");
  assert.equal(readNotice(notice({ code: 7, detail: "" }), NONCE)?.code, "unknown");
});

test("a notice is bounded however long the page made it", () => {
  const read = readNotice(notice({ code: "error", detail: "x".repeat(5000) }), NONCE);
  assert.equal(read?.detail.length, NOTICE_DETAIL_LIMIT);
  // Absent rather than thrown on: a detail this cannot read is still a report that something
  // happened, and the code is the half that is actionable.
  assert.equal(readNotice(notice({ code: "error" }), NONCE)?.detail, "");
});

test("a notice is refused unless it names the document we injected", () => {
  assert.equal(readNotice(notice({ code: "error", detail: "boom" }), "another-nonce"), null);
  assert.equal(readNotice({ type: VIEW_MESSAGE.notice, code: "error" }, NONCE), null);
  // Not a notice at all. `null` rather than a shrug, so the caller goes on to read it as what it is.
  assert.equal(readNotice({ type: VIEW_MESSAGE.submit, nonce: NONCE }, NONCE), null);
  assert.equal(readNotice(null, NONCE), null);
});

const cells = (): BridgeCells => ({ pending: { value: null }, sending: { value: false }, readied: { value: false } });

const silentChannel = (): Channel => ({ post: () => {}, onMessage: () => {}, close: () => {} });

test("the parent hears a notice BEFORE the handshake, which is when it matters most", () => {
  const heard: ViewNotice[] = [];
  const held = cells();
  const bridge = viewBridge(
    { channel: silentChannel, submit: async () => ({ ok: true }), state: () => ({}), notice: (report) => heard.push(report) },
    () => null,
    () => NONCE,
    held,
  );
  // No `ready` has been sent and none ever will be: this is the page whose script threw while the
  // document was being parsed. It has no port, and it is the page an author cannot otherwise
  // diagnose — it sits on its loading state with the reason locked inside the frame.
  bridge.receive(notice({ code: "error", detail: "x is not defined (line 4)" }));
  assert.deepEqual(heard, [{ code: "error", detail: "x is not defined (line 4)" }]);
  assert.equal(held.readied.value, false);
});

test("a host that takes no notices is not broken by one", () => {
  // The sink is optional, and dropping is the default: a public page in a stranger's browser has
  // nowhere a person would read this, and somewhere to accumulate it is not a diagnostic.
  const bridge = viewBridge(
    { channel: silentChannel, submit: async () => ({ ok: true }), state: () => ({}) },
    () => null,
    () => NONCE,
    cells(),
  );
  assert.doesNotThrow(() => bridge.receive(notice({ code: "error", detail: "boom" })));
});

test("a notice is not judged as a submission", () => {
  const answered: unknown[] = [];
  const channel: Channel = { post: (message) => answered.push(message), onMessage: () => {}, close: () => {} };
  const bridge = viewBridge(
    { channel: () => channel, submit: async () => ({ ok: true }), state: () => ({}), notice: () => {} },
    () => ({ submit: {} }),
    () => NONCE,
    cells(),
  );
  bridge.receive(notice({ code: "modal-ignored", detail: "confirm" }));
  // Read as a message rather than a notice it would fall through to the submission reader, which
  // answers nothing for a message with no request id — so the fault would be silent either way,
  // and this pins WHICH path it took.
  assert.deepEqual(answered, []);
});

/** RUN the bootstrap, rather than read it.
 *
 *  A test that greps the generated string proves the characters are there and nothing about what
 *  they do — and the closing lesson of the plan this feature comes from is exactly that: a test
 *  that enters by a door the real thing does not use agrees with the implementation and not with
 *  reality. The bootstrap is plain JavaScript whose only outside references are `window`, `parent`
 *  and `document`, so it can be given all three and asked to behave. */
const runBootstrap = (nonce: string) => {
  const posted: Record<string, unknown>[] = [];
  const handlers: Record<string, (event: Record<string, unknown>) => void> = {};
  const win: Record<string, unknown> = {
    addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => {
      handlers[name] = handler;
    },
  };
  const context = {
    window: win,
    parent: { postMessage: (message: Record<string, unknown>) => posted.push(message) },
    // The real one removes the script element from the document. Nothing here has one, and the
    // bootstrap already guards for it — a fragment can be parsed with no `currentScript` at all.
    document: { currentScript: null },
  };
  vm.createContext(context);
  vm.runInContext(
    publicViewBootstrap(nonce)
      .replace(/^\s*<script>/, "")
      .replace(/<\/script>\s*$/, ""),
    context,
  );
  const notices = () => posted.filter((message) => message.type === VIEW_MESSAGE.notice);
  return { notices, handlers, win, nonce };
};

test("the running bootstrap answers a modal exactly as an ignored one does", () => {
  const frame = runBootstrap(NONCE);
  // Replaced rather than watched, because a call the browser refuses to make raises no event. The
  // RETURN VALUES are the part that must not drift: a `confirm` answering true here would send a
  // page down a branch it never takes in a published one, which is the "worked on my machine" this
  // whole subsystem exists to prevent.
  assert.equal((frame.win.alert as () => unknown)(), undefined);
  assert.equal((frame.win.confirm as () => unknown)(), false);
  assert.equal((frame.win.prompt as () => unknown)(), null);
  assert.deepEqual(
    frame.notices().map((message) => message.detail),
    ["alert", "confirm", "prompt"],
  );
  // The nonce is what proves these came from the document the parent injected.
  assert.ok(frame.notices().every((message) => message.nonce === NONCE && message.code === "modal-ignored"));
});

test("the running bootstrap names where an error happened", () => {
  const frame = runBootstrap(NONCE);
  frame.handlers.error?.({ message: "slot is not defined", lineno: 12 });
  assert.equal(frame.notices()[0]?.detail, "slot is not defined (line 12)");
  // A page can throw a thing with no message at all, and a blank detail would read as a notice
  // this runtime failed to fill in rather than as one the page failed to explain.
  frame.handlers.error?.({ message: "", lineno: 0 });
  assert.equal(frame.notices()[1]?.detail, "an error with no message");
});

test("the running bootstrap says WHAT a promise was rejected with, not [object Object]", () => {
  const frame = runBootstrap(NONCE);
  frame.handlers.unhandledrejection?.({ reason: { message: "the write was refused" } });
  frame.handlers.unhandledrejection?.({ reason: "a bare string" });
  // The one that used to be useless. `String({})` is "[object Object]", which costs a debugging
  // round to learn nothing — a promise may be rejected with anything at all.
  frame.handlers.unhandledrejection?.({ reason: { code: 7 } });
  frame.handlers.unhandledrejection?.({ reason: null });
  assert.deepEqual(
    frame.notices().map((message) => message.detail),
    ["the write was refused", "a bare string", "rejected with a object carrying no message", "rejected with a null carrying no message"],
  );
});

test("a page in an error loop is cut off, and the cut is announced WITHIN the maximum", () => {
  const frame = runBootstrap(NONCE);
  for (let n = 0; n < MAX_NOTICES + 10; n += 1) frame.handlers.error?.({ message: `throw ${n}`, lineno: 1 });
  const notices = frame.notices();
  // The marker is spent out of the same allowance, so a host that sized a buffer to `MAX_NOTICES`
  // still receives it. Sized to a figure that excluded it, the host would drop exactly the line
  // saying the list is incomplete — an incomplete list, silently, which is what the marker is for.
  assert.equal(notices.length, MAX_NOTICES);
  // The ones kept are the EARLIEST, which are usually the cause of the rest.
  assert.equal(notices[0]?.detail, "throw 0 (line 1)");
  assert.equal(notices[MAX_NOTICES - 1]?.code, "notices-dropped");
  assert.equal(notices.filter((message) => message.code === "notices-dropped").length, 1);
});

test("the bootstrap still hands the page its bridge under both names", () => {
  // Not about notices, and here because this is the first test that RUNS the thing: everything
  // above would pass just as well against a bootstrap that had stopped defining the contract.
  const frame = runBootstrap(NONCE);
  assert.equal(typeof (frame.win.__MC_APP_VIEW as { ready?: unknown } | undefined)?.ready, "function");
  assert.equal(frame.win.__MC_APP_VIEW, frame.win.__MC_PUBLIC_VIEW);
});
