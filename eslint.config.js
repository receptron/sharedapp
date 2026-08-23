import js from "@eslint/js";
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
import security from "eslint-plugin-security";

// A preset decides WHICH rules to run; this file decides how much they matter. A warning does not
// fail CI and nothing here reads lint output, so a rule left at warn is a rule that reports a
// violation and ships it. Every preset rule is raised to error, and a rule that must not fail the
// build is turned off or downgraded BY NAME, with the reason, in one of the blocks below.
//
// Written as a transform rather than a list of rule names because the list is what rots: a preset
// that adds a warn-level rule in a future release arrives already enforced. Severity only — the
// preset's own options are preserved, and a rule it ships as `off` stays off (that was its
// decision, and a different one).
const raise = (entry) => {
  const severity = Array.isArray(entry) ? entry[0] : entry;
  if (severity !== 1 && severity !== "warn") return entry;
  return Array.isArray(entry) ? ["error", ...entry.slice(1)] : "error";
};

const enforced = (config) =>
  config.rules ? { ...config, rules: Object.fromEntries(Object.entries(config.rules).map(([id, entry]) => [id, raise(entry)])) } : config;

// The DEBT lists further down are per FILE and set a rule to `warn`, not `off`: the finding stays
// on screen and stays countable, while a file not on the list is held at error. Delete an entry
// when its file reaches zero — the rule then holds it there. The counts are from the sweep that
// introduced each list; they are the size of the debt, not a budget to spend.
export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  {
    // A disable comment that no longer suppresses anything names a rule as the reason for the code
    // below it, and that reason has stopped being true. ESLint reports these at warn by default,
    // which is how one survives; at error it has to be narrowed the day it goes stale.
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  enforced(js.configs.recommended),
  ...tseslint.configs.strict.map(enforced),
  enforced(sonarjs.configs.recommended),
  enforced(security.configs.recommended),
  {
    rules: {
      // `const { secret, ...rest } = obj` drops a field by construction — the named sibling is the
      // point, not dead code. `^__` is the same idea spelled for a positional drop.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^__", ignoreRestSiblings: true }],
      // `as` casts, which CLAUDE.md forbids ("MUST use type guards instead"). A cast asserts a type
      // the compiler could not prove; a guard PROVES it, and the difference shows up at runtime on
      // the data you least control — which here is an authored `app.json` and a message from a
      // sandboxed frame.
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      // Size and complexity guards. Counted without comments, which matters in this repo more than
      // most: the header block of a `src/*.ts` file is its design doc, so a long file here is
      // usually one that explains itself rather than one that does too much.
      "max-lines": ["error", { max: 600, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true, IIFEs: true }],
      complexity: ["error", 20],
      "max-depth": ["error", 4],
      "max-params": ["error", 6],
      "max-nested-callbacks": ["error", 4],
      // `== null` is the one loose comparison worth keeping: it asks "null or undefined" in one
      // test, which is exactly the question `exactOptionalPropertyTypes` makes worth asking.
      eqeqeq: ["error", "always", { null: "ignore" }],
      // This package is a pure projection library — no I/O, no clock, and no output. A `console`
      // call in `src/` is a leftover, not a feature. `scripts/` is the opposite; see its block.
      "no-console": "error",
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    // Rules that are WRONG about this code rather than inconvenient, off with the reason. Each is
    // global because the shape it flags is how the whole package is written.
    rules: {
      // Fires on every `fields[name]` — and reading a declared collection's schema by the field
      // name the author wrote is the job. The prototype-pollution case this rule gestures at is
      // handled where it actually lives: `Object.hasOwn` / `Map` at the lookups that take a
      // caller-supplied key (see `publishChecks.ts`), which the rule cannot tell apart from the rest.
      "security/detect-object-injection": "off",
      // The only fs in this repository is in `scripts/` and one test, and every path is one they
      // compute from a checkout root that was handed to them.
      "security/detect-non-literal-fs-filename": "off",
      // One finding: `check-pack.mjs` builds a regexp from the package's own name to find its
      // entry points in the tarball.
      "security/detect-non-literal-regexp": "off",
      // A quantifier inside a quantifier is a shape rather than a judgement call, so this one stays
      // at error where `recommended` ships it at warn.
      "security/detect-unsafe-regex": "error",
      // Duplicates `@typescript-eslint/no-unused-vars` without its options, so it re-reports the
      // `__dropped` / `__firstAt` rest-and-drop bindings that the configured `^__` pattern allows.
      // One rule owns unused bindings; this is the one that cannot be told about the convention.
      "sonarjs/no-unused-vars": "off",
    },
  },
  {
    // `src/` must not need `@types/node`, so node globals are NOT declared globally. `scripts/` is
    // the opposite: it only ever runs under `node` in CI, so declare exactly what it uses rather
    // than pull in a `globals` dependency for one file.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", URL: "readonly" },
    },
    rules: {
      // These scripts are release gates run by a human or by CI, and what they print IS the result.
      "no-console": "off",
      // `check-pack.mjs` runs `npm`/`yarn` the way every package script does — from PATH, because
      // there is no portable absolute path for them.
      "sonarjs/no-os-command-from-path": "off",
    },
  },
  {
    // Type-aware lint. Scoped to the two TypeScript projects — `scripts/**/*.mjs` belongs to
    // neither, so naming it here would only produce parse errors.
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      // `projectService` rather than naming the two tsconfigs: with an explicit `project` list,
      // `eslint --fix` CRASHES on any file where a fix was applied — the re-lint of the modified
      // text sends TypeScript 6.0.3 into `getModuleSpecifiers` with no path, and it throws from
      // inside whichever type-aware rule asked for a type name (measured: 8 files, and turning the
      // named rule off only moved the crash to the next one). The project service is the path that
      // handles a file whose content is not what is on disk, which is exactly the fix pass.
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // The promise family. A missing `await` makes a rejection vanish and the call look like it
      // succeeded; an async callback handed to an API that ignores the returned promise does the
      // same. `node:test`'s `test()` returns a promise the runner already owns, which is what the
      // allowlist says — without it this rule reports every case in the suite and nothing else.
      "@typescript-eslint/no-floating-promises": [
        "error",
        { allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test", "it", "describe", "suite"] }] },
      ],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "error",
      // The `any` family — all five at zero. They catch what `no-explicit-any` cannot: an `any`
      // that arrives from OUTSIDE (a parsed `app.json`, a message from a sandboxed frame) and then
      // type-checks against every use it reaches. Zero is the state worth defending here, because
      // untyped input is this package's entire input.
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      // A template that turns an object into the literal text "[object Object]" — a wrong value
      // that travels instead of throwing, and these documents are read by rules, not by people.
      "@typescript-eslint/no-base-to-string": "error",
      "@typescript-eslint/restrict-template-expressions": "error",
      // `??` where `||` would swallow "" and 0. A declared field name is a string that can be
      // empty, so the two are not interchangeable anywhere in this package.
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-confusing-void-expression": "error",
      // A `switch` over `APP_ROLES` or a message `type` that grows a case and does not grow its
      // handler is a projection that silently omits one.
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      // Type-aware sonarjs, all at zero and each catching something no syntactic rule can.
      "sonarjs/different-types-comparison": "error",
      "sonarjs/no-misleading-array-reverse": "error",
      "sonarjs/no-useless-intersection": "error",
      "sonarjs/deprecation": "error",
      "sonarjs/void-use": "error",
    },
  },
  {
    // Tests build values the types forbid on purpose: a malformed `app.json`, a message missing the
    // field the parser is supposed to demand, a partial stub for a big interface. Asserting there
    // is the subject of the test rather than a hole in the package — and `AuthoredAppZ` still runs
    // over every fixture that stands for a real declaration, which is the check that matters.
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/consistent-type-assertions": "off" },
  },
  {
    // "*" is not laxity: a sandboxed srcdoc frame has an OPAQUE origin, so no origin string would
    // address it. What makes it safe is that the message carries nothing — everything after the
    // handover travels on the port. The reason is written at the call site too; this rule cannot
    // see it, and no rewrite would satisfy it.
    files: ["src/view/channel.ts"],
    rules: { "sonarjs/post-message": "off" },
  },
  {
    // `performed` / `attempted` wrap a call that may throw SYNCHRONOUSLY on its way to returning a
    // promise, so the channel's message handler is not taken down by one. The rule's advice — await
    // it inside the `try` — is the one thing they must not do: the port is called in the CURRENT
    // tick, and an extra turn is the lost request they exist to prevent.
    files: ["src/view/parent.ts"],
    rules: { "sonarjs/no-try-promise": "off" },
  },
  {
    // These three run the srcdoc bootstrap under `node:vm` — evaluating the injected script IS the
    // test, and it is the only way to prove what the frame's own code does with a message.
    files: ["test/test_viewGesture.ts", "test/test_viewLookup.ts", "test/test_viewNotice.ts"],
    rules: { "sonarjs/code-eval": "off" },
  },

  // ---------------------------------------------------------------------------------------------
  // DEBT. Everything below is at `warn` for the files listed and at `error` everywhere else. The
  // number after each file is what it reported when the rule went in.
  // ---------------------------------------------------------------------------------------------
  {
    // Two `[] as string[]` on empty literals that an annotation would type instead.
    files: ["src/view/capability.ts"], // 2
    rules: { "@typescript-eslint/consistent-type-assertions": "warn" },
  },
  {
    // A guard the types already prove. In `src/` (4) it is defensive reading of a schema the caller
    // supplies; in the suite it is mostly `x !== null && x.field`, written so the compiler narrows
    // where an assertion is banned.
    files: [
      "src/publishChecks.ts", // 2
      "src/view/parent.ts", // 2
      "test/test_appProtocol.ts", // 1
      "test/test_appViews.ts", // 18
      "test/test_authoredApp.ts", // 4
      "test/test_authoredSlug.ts", // 3
      "test/test_memberBridge.ts", // 8
      "test/test_memberSelfWithdraw.ts", // 3
      "test/test_publishBaseline.ts", // 2
      "test/test_viewCapability.ts", // 1
      "test/test_viewIntent.ts", // 14
      "test/test_viewLookup.ts", // 1
      "test/test_viewOwnRows.ts", // 2
      "test/test_viewParent.ts", // 7
      "test/test_viewWriteRead.ts", // 2
    ],
    rules: { "@typescript-eslint/no-unnecessary-condition": "warn" },
  },
  {
    // `async` on a helper that never awaits — harmless in a suite, and a signature the callers read
    // as "this settles later".
    files: [
      "test/test_viewLookup.ts", // 8
      "test/test_viewNotice.ts", // 3
      "test/test_viewOwnRows.ts", // 5
      "test/test_viewParent.ts", // 5
    ],
    rules: { "@typescript-eslint/require-await": "warn" },
  },
  {
    // Four conditionals on a nullable string, where "" and absent take the same branch on purpose.
    // Worth spelling out one at a time, since an empty field name is a real authored mistake.
    files: ["src/publishChecks.ts"], // 4
    rules: { "@typescript-eslint/strict-boolean-expressions": "warn" },
  },
  {
    files: ["test/test_publishChecks.ts"], // 1
    rules: { "@typescript-eslint/no-non-null-assertion": "warn" },
  },
  {
    // Bare `.sort()` on arrays of strings — correct as written (the default IS lexicographic), but
    // the rule cannot tell those from the numeric case where the default is a bug. An explicit
    // comparator retires each entry.
    files: [
      "src/appViews.ts", // 1
      "src/publishChecks.ts", // 8
      "src/publishProject.ts", // 1
      "test/test_appViews.ts", // 4
      "test/test_authoredSlug.ts", // 1
      "test/test_publishProject.ts", // 2
    ],
    rules: { "sonarjs/no-alphabetical-sort": "warn" },
  },
  {
    files: ["test/test_viewParent.ts"], // 5 — a handler called with an argument its stub ignores
    rules: { "sonarjs/no-extra-arguments": "warn" },
  },
  {
    files: [
      "scripts/check-apps.mjs", // 1
      "src/publishChecks.ts", // 1
    ],
    rules: { "sonarjs/no-nested-conditional": "warn" },
  },
  {
    files: [
      "src/publishChecks.ts", // 1
      "test/test_authoredApp.ts", // 1
    ],
    rules: { "sonarjs/no-nested-template-literals": "warn" },
  },
  {
    // A `!==` the rule reads as always true, and a 1.2.3.4 standing in for a host in a fixture.
    files: ["test/test_appProtocol.ts"], // 1 + 1
    rules: { "sonarjs/different-types-comparison": "warn", "sonarjs/no-hardcoded-ip": "warn" },
  },
  {
    files: ["test/test_viewSelfContained.ts"], // 1 — backtracking in the fixture's own scan
    rules: { "sonarjs/super-linear-regex": "warn" },
  },
  {
    // Over the 600-line file guard. `publishChecks.ts` is 863 and the biggest single file here;
    // its refusals come in families, so a split is a real change rather than a move.
    files: [
      "src/publishChecks.ts", // 863
      "test/test_publishChecks.ts", // its suite
    ],
    rules: { "max-lines": "warn" },
  },
  {
    // One arrow of 181 lines (`parent.ts`'s message handler) and one of 81 (`srcdoc.ts`'s
    // bootstrap builder). Both are a single sequence with the reasoning written between the steps.
    files: [
      "src/view/parent.ts", // 181
      "src/view/srcdoc.ts", // 81
    ],
    rules: { "max-lines-per-function": "warn" },
  },
);
