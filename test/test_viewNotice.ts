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

import { viewBridge, type BridgeCells, type Channel } from "../src/view/bridge.js";
import { NOTICE_DETAIL_LIMIT, readNotice, type ViewNotice } from "../src/view/message.js";
import { VIEW_MESSAGE } from "../src/view/protocol.js";
import { publicViewBootstrap } from "../src/view/srcdoc.js";

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

test("the bootstrap replaces the three calls the sandbox ignores, and answers as the sandbox does", () => {
  const script = publicViewBootstrap(NONCE);
  // Replaced rather than watched: there is no event for a call the browser refuses to make.
  for (const name of ["window.alert", "window.confirm", "window.prompt"]) {
    assert.ok(script.includes(`${name} = `), `${name} is not replaced`);
  }
  // And the replacements answer what an ignored modal answers. A `confirm` that returned true here
  // would make a page take a branch it never takes in production.
  assert.ok(script.includes(`notify("modal-ignored", "confirm"); return false;`));
  assert.ok(script.includes(`notify("modal-ignored", "prompt"); return null;`));
  // The two the browser does raise, and which stop at the frame boundary.
  assert.ok(script.includes(`addEventListener("error"`));
  assert.ok(script.includes(`addEventListener("unhandledrejection"`));
  // The nonce is what proves a notice came from this document, so it must be closed over here
  // exactly as `ready` is.
  assert.ok(script.includes(`type: "${VIEW_MESSAGE.notice}", nonce`));
});
