// `theme` for the whole public page (receptron/mulmoserver#336): what parses, and what the page is told.
import { test } from "node:test";
import assert from "node:assert/strict";

import { AuthoredAppZ } from "../src/publishManifest.js";
import { projectApp, type PublishStamp } from "../src/publishProject.js";
import { PublicThemeZ } from "../src/pageTheme.js";

const STAMP: PublishStamp = { uid: "u", email: "o@x.jp", publishedAt: 1 };
const parses = (theme: unknown) => AuthoredAppZ.safeParse({ aid: "a", members: {}, theme }).success;
const configOf = (theme: unknown) => projectApp(AuthoredAppZ.parse({ aid: "a", members: {}, theme }), [], STAMP, null).config;

test("colours are #rgb or #rrggbb, and a gradient has one to three", () => {
  assert.equal(parses({ bar: ["#f39"], barText: "#ffffff", background: ["#fff0f8", "#e0f7ff", "#abc"] }), true);
  for (const theme of [
    { bar: [] },
    { bar: ["#f39", "#f39", "#f39", "#f39"] },
    { bar: ["red"] },
    { bar: ["#ff33991"] },
    { barText: "url(javascript:alert(1))" },
    { background: ["#fff; background: url(x)"] },
  ]) {
    assert.equal(parses(theme), false, JSON.stringify(theme));
  }
});

test("icon is one character, ticker is short text, banner is one picture in views/", () => {
  assert.equal(parses({ icon: "🌸", ticker: "★ 本日オープン ★", banner: "views/banner.svg" }), true);
  for (const theme of [
    { icon: "🌸🌸" },
    { icon: "" },
    { ticker: "" },
    { ticker: "x".repeat(121) },
    { banner: "views/../x.svg" },
    { banner: "views/a/b.png" },
    { banner: "views/x.gif" },
    { banner: "https://x/y.png" },
  ]) {
    assert.equal(parses(theme), false, JSON.stringify(theme));
  }
  assert.equal(parses({ glitter: true }), false, "strict");
});

test("config/public.theme carries what was declared, the banner only as a flag, and no undefined", () => {
  assert.deepEqual(configOf({ bar: ["#f39"], icon: "🌸", banner: "views/banner.svg" }).theme, { bar: ["#f39"], icon: "🌸", banner: true });
  assert.deepEqual(configOf({ hue: 200 }).theme, { hue: 200 });
  assert.equal(Object.hasOwn(configOf(undefined), "theme"), false);
  assert.equal(JSON.stringify(configOf({ ticker: "x" }).theme).includes("views/"), false);
});

test("what the publisher projects, the page's schema reads back — one grammar for both", () => {
  for (const theme of [{ hue: 200 }, { bar: ["#f39", "#fc0"], barText: "#fff", background: ["#abc"], icon: "🌸", ticker: "★", banner: "views/b.svg" }, {}]) {
    assert.equal(PublicThemeZ.safeParse(configOf(theme).theme).success, true, JSON.stringify(theme));
  }
  for (const bad of [{ bar: ["red"] }, { banner: "views/b.svg" }, { glitter: 1 }, { barText: "#fff; x" }]) {
    assert.equal(PublicThemeZ.safeParse(bad).success, false, JSON.stringify(bad));
  }
});
