// `byText` exists to satisfy a lint rule without changing an order, so the ONLY thing worth
// asserting is that it does not change it. The rule cannot tell a string array from a number
// one; these sorts are all string arrays, where the default is already right.
//
// This matters beyond tidiness: EVERY caller's order is observable — `src/byText.ts` has the
// list, and it is the only place that does, because an enumeration kept in three files is one
// that goes stale in two of them. A comparator that ordered differently — `localeCompare`, say,
// which is locale-dependent and puts "a" before "B" — would silently reorder all of them, and a
// second publish of an unchanged declaration would produce a changed document.

import { test } from "node:test";
import assert from "node:assert/strict";

import { byText } from "../src/byText.js";

/** The characters an order can disagree about: case, digits, punctuation either side of the
 *  alphabet, non-ASCII, astral pairs, and a LONE surrogate — which is not a character at all
 *  and is exactly where a comparator that decodes code POINTS parts company with one that
 *  compares code UNITS, as both `<` and the default `.sort()` do. */
const CHARS = ["a", "A", "z", "Z", "0", "9", "_", "-", ".", "/", " ", "", "é", "ß", "Ω", "あ", "漢", "🍎", "\ud800", "\udfff", " ", "￿", "~", "!", "[", "{"];

const at = (seed: number, bound: number): number => Math.floor((Math.sin(seed) * 10000 - Math.floor(Math.sin(seed) * 10000)) * bound);

const word = (seed: number, length: number): string => Array.from({ length }, (_unused, index) => CHARS[at(seed * 31 + index, CHARS.length)] ?? "").join("");

test("byText orders exactly as a bare .sort() over generated arrays", () => {
  const arrays = Array.from({ length: 2000 }, (_unused, index) => Array.from({ length: at(index, 12) }, (_u, k) => word(index * 97 + k, at(index * 7 + k, 6))));
  arrays.forEach((array) => {
    assert.deepEqual([...array].sort(byText), [...array].sort(), `diverged on ${JSON.stringify(array)}`);
  });
});

/** Every permutation, so the assertion does not depend on which order the fixture happened to
 *  be written in — the input to these sorts is `Object.keys()`, whose order is the author's. */
function permutations(values: readonly string[]): string[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) => permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [value, ...rest]));
}

test("byText orders exactly as a bare .sort() over every permutation of the real shapes", () => {
  const shapes = [
    ["draft", "submitted", "approved", "sealed"],
    ["b", "B", "a", "A"],
    ["", "0", "z", "🍎"],
    ["x@y.jp", "X@y.jp", "a@b.com"],
  ];
  shapes.forEach((shape) => {
    permutations(shape).forEach((order) => {
      assert.deepEqual([...order].sort(byText), [...order].sort(), `diverged on ${JSON.stringify(order)}`);
    });
  });
});

test("byText is a total order: 0 exactly on equal strings, and antisymmetric", () => {
  const words = Array.from({ length: 60 }, (_unused, index) => word(index, at(index, 5)));
  words.forEach((left) => {
    assert.equal(byText(left, left), 0);
    words.forEach((right) => {
      // Summed rather than negated: `assert.equal` separates 0 from -0, and `-Math.sign(0)` is -0.
      assert.equal(Math.sign(byText(left, right)) + Math.sign(byText(right, left)), 0);
    });
  });
});
