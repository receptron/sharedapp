// THE PAPER THE VIEW IS PRINTED ON.
//
// A published view sets colours and, in every template this ecosystem ships, no background. With
// no canvas of its own the document is transparent, so the colour under the text is the EMBEDDER's:
// the same page read black-on-white on the public site and black-on-near-black in MulmoTerminal's
// pane, unreadable, with nothing wrong in the page.
//
// What is asserted here is the ORDER and the WEIGHT, because those are the whole of the promise.
// The floor has to be emitted before the author's HTML and has to be beatable by a plain rule of
// theirs — a sheet that landed after the page, or one written with `!important` or a heavier
// selector, would stop being a default and start being a house style with no way out of it.
//
// A real cascade cannot be run here: this package has no DOM. The three properties of the pair
// that decide it — position in the document, selector, absence of `!important` — are exactly what
// this file pins, and the page that proves the result is the author's own preview.
import { test } from "node:test";
import assert from "node:assert/strict";

import { publicViewSrcdoc } from "../src/view/srcdoc.js";

const PAGE = "<style>html { background: #101014; color: #f2f2f5; }</style>\n<p>hello</p>";

const rendered = () => publicViewSrcdoc(PAGE, "nonce-1");

test("the document declares its own canvas, its foreground and its colour scheme", () => {
  const style = /<style>([^<]*)<\/style>/u.exec(rendered())?.[1] ?? "";
  // All three, or the floor is not one: a background with no `color-scheme` still hands the UA's
  // dark widgets and scrollbars to a reader whose OS is dark, on paper that is now white.
  assert.match(style, /color-scheme:\s*light/u);
  assert.match(style, /background:\s*#ffffff/u);
  assert.match(style, /color:\s*#1c1c20/u);
});

test("it paints the ROOT, because a body-only canvas is not one", () => {
  // `html`, not `body`: the root's background is what covers the viewport. It is also why the
  // guidance to authors is to paint `html` — a background here stops the first body's from
  // propagating, so a page that paints only `body` gets its colour on the body box and this
  // white around it.
  const style = /<style>([^<]*)<\/style>/u.exec(rendered())?.[1] ?? "";
  assert.match(style, /^html\s*\{/u);
});

test("the author's page comes after it, and can beat it with a plain rule", () => {
  const document = rendered();
  const floor = document.indexOf("<style>html {");
  // Order is half of the override: same-weight rules are decided by which came last.
  assert.ok(floor !== -1 && floor < document.indexOf(PAGE), "the floor is emitted before the page");
  // And weight is the other half. `html` is 0,0,1 — lighter than `:root`, lighter than a class —
  // and nothing here is `!important`, so an author's `body { background: … }` or `html { … }`
  // wins without having to know this sheet exists.
  const style = /<style>([^<]*)<\/style>/u.exec(document)?.[1] ?? "";
  assert.equal(style.includes("!important"), false);
  assert.equal(style.includes(":root"), false);
});

test("the policy still arrives first, and the page still arrives whole", () => {
  // The canvas is inserted into a document that already had two jobs. A `<style>` is allowed by
  // `style-src 'unsafe-inline'`, and the CSP has to precede everything it governs.
  const document = rendered();
  assert.ok(document.indexOf("Content-Security-Policy") < document.indexOf("<style>html {"));
  assert.ok(document.indexOf("<style>html {") < document.indexOf("__MC_APP_VIEW"), "the floor precedes the bootstrap too");
  assert.ok(document.endsWith(PAGE), "the author's HTML is last and untouched");
});
