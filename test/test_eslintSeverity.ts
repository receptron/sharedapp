// What a preset's severities become here, and what must survive untouched.
//
// This logic used to live inside `eslint.config.js`, where no test could reach it. That is not a
// tidiness point: with the body of `raise` replaced by `entry => entry`, `yarn lint`,
// `yarn lint:overrides` and `yarn test` all stayed green while FOURTEEN `security/*` rules
// silently dropped from error to warn — a warning fails nothing and nobody reads lint output, so
// those findings would have shipped. The last assertion below is the one that goes red for it.

import { test } from "node:test";
import assert from "node:assert/strict";

// Plain JS, typed by `eslint.severity.d.ts`: `eslint.config.js` imports it directly, so it cannot
// be TypeScript without putting `jiti` in ESLint's loader path for one function.
import { enforced, raise } from "../eslint.severity.js";

test("a warning becomes an error, in both the word and numeric forms presets use", () => {
  assert.equal(raise("warn"), "error");
  assert.equal(raise(1), "error");
});

test("everything that is not a warning is returned untouched", () => {
  assert.equal(raise("error"), "error");
  assert.equal(raise(2), 2);
  assert.equal(raise("off"), "off");
  assert.equal(raise(0), 0);
});

/** `off` is the case worth stating out loud. A preset that ships a rule disabled made a decision,
 *  and it is a different decision from "this matters less" — raising it would turn a rule the
 *  preset deliberately left alone into a build failure. */
test("a rule the preset ships as off stays off", () => {
  assert.equal(raise("off"), "off");
  assert.equal(raise(0), 0);
  assert.deepEqual(raise(["off", { allow: ["x"] }]), ["off", { allow: ["x"] }]);
});

test("options survive the raise — severity only, never the whole entry", () => {
  assert.deepEqual(raise(["warn", { max: 4 }]), ["error", { max: 4 }]);
  assert.deepEqual(raise([1, { max: 4 }, "extra"]), ["error", { max: 4 }, "extra"]);
  assert.deepEqual(raise(["error", { max: 4 }]), ["error", { max: 4 }]);
});

test("enforced raises every rule in a block and leaves the block's other keys alone", () => {
  const block = { files: ["a.ts"], languageOptions: { globals: { x: "readonly" } }, rules: { a: "warn", b: "error", c: "off", d: [1, { max: 2 }] } };
  assert.deepEqual(enforced(block), {
    files: ["a.ts"],
    languageOptions: { globals: { x: "readonly" } },
    rules: { a: "error", b: "error", c: "off", d: ["error", { max: 2 }] },
  });
});

/** A block carrying no `rules` is where the parser, the plugins and the globals live. Rewriting it
 *  would be rewriting HOW the repo is linted rather than how much its findings matter. */
test("a block with no rules is returned as-is", () => {
  const parser = { files: ["**/*.ts"], languageOptions: { parserOptions: { projectService: true } } };
  assert.deepEqual(enforced(parser), parser);
  assert.deepEqual(enforced({ ignores: ["dist/"] }), { ignores: ["dist/"] });
});

test("enforced does not mutate what it is given", () => {
  const rules = { a: "warn" };
  const block = { rules };
  enforced(block);
  assert.deepEqual(rules, { a: "warn" }, "the caller's object was rewritten in place");
});

/** THE ONE THAT CATCHES A NEUTERED TRANSFORM. The others pin the function's shape; this pins what
 *  it is FOR. `eslint-plugin-security` ships every rule at `warn`, so if `raise` stops raising,
 *  fourteen security rules quietly become advisory and CI keeps passing. Asserted against the real
 *  resolved config rather than a fixture, because a fixture would agree with a broken transform. */
test("the resolved config leaves no preset rule at warn — that is what the transform is for", async () => {
  const config: unknown = (await import("../eslint.config.js")).default;
  assert.ok(Array.isArray(config));

  const warned: string[] = [];
  config.forEach((block: unknown, index: number) => {
    if (typeof block !== "object" || block === null) return;
    const entries: Record<string, unknown> = { ...block };
    // Per-file blocks are the DEBT ledger and are warn on purpose; the presets are not.
    if (entries["files"] !== undefined) return;
    const rules = entries["rules"];
    if (typeof rules !== "object" || rules === null) return;
    Object.entries({ ...rules }).forEach(([id, entry]) => {
      const severity: unknown = Array.isArray(entry) ? entry[0] : entry;
      if (severity === "warn" || severity === 1) warned.push(`${index}:${id}`);
    });
  });

  assert.deepEqual(warned, [], `preset rules left at warn, so their findings would ship: ${warned.join(", ")}`);
});
