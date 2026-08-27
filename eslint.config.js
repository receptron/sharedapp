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

// Per-file entries further down come in three kinds, and the kind is the point. An `off` says the
// rule is WRONG about that file and carries the reason. A `warn` is debt: the finding stays on
// screen while a file not listed is held at error, and the entry is deleted once its file reaches
// zero — the rule then holds it there. An `error` with a ceiling is a RATCHET: the file may shrink
// and may not grow, and the number lives in the rule where CI checks it.
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
      // Every path here is one this repository's own tooling produced — argv, an env var CI sets,
      // `git ls-files`, `tsc --listFilesOnly`, `import.meta.url`, or a directory listing. None is
      // taken from the CONTENTS of a document being processed, and that is the property worth
      // holding: an `app.json` or a `schema.json` must never be able to steer a read. Stated as
      // the invariant rather than as a list of the call sites, because the list was falsified
      // twice by call sites that were perfectly safe, while the invariant only goes false when a
      // genuinely dangerous read is written.
      "security/detect-non-literal-fs-filename": "off",
      // One finding, in `check-pack.ts`'s `satisfied`. `collect` walks the VALUES of `exports`, so
      // what reaches the regexp is an export TARGET (`"dist/view/*.js"`), never the subpath key
      // that pointed at it. The literal halves go through `escapeRegExp`; the only thing not
      // escaped is the `*` the author wrote, which is the whole point of the pattern.
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
    files: ["scripts/**/*.{mjs,ts}"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", URL: "readonly" },
    },
    rules: {
      // These scripts are release gates run by a human or by CI, and what they print IS the result.
      "no-console": "off",
      // One finding, in `check-pack.ts`: it runs `tar` to list the tarball, from PATH, because
      // there is no portable absolute path for it.
      "sonarjs/no-os-command-from-path": "off",
    },
  },
  {
    // Type-aware lint, everywhere a tsconfig reaches — which is now `scripts/` too, since the
    // report that counts unchecked files must not be one. `scripts/**/*.mjs` is deliberately not
    // here: no project holds a `.mjs`, so naming it would only produce parse errors.
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      // `projectService` rather than naming each tsconfig: with an explicit `project` list,
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
  {
    // OFF, because this file's whole purpose is to call the bare `.sort()` this rule forbids and
    // assert `byText` orders identically. Satisfying the rule here would delete the comparison —
    // there is no way to check a comparator against the default without invoking the default.
    files: ["test/test_byText.ts"],
    rules: { "sonarjs/no-alphabetical-sort": "off" },
  },

  // ---------------------------------------------------------------------------------------------
  // DEBT AND RATCHETS. `warn` entries are debt: the rule is at `error` for every file not listed,
  // and the entry goes when its file reaches zero. `error` entries with a ceiling are ratchets —
  // see the note on the size guards below. No entry carries a count: the count of the day is what
  // `yarn lint` prints, and one written here is a number nothing checks.
  // ---------------------------------------------------------------------------------------------
  {
    // NOT debt, in the sense that paying it would be a bug — kept at `warn` rather than `off` only
    // so a genuinely redundant condition written later is still visible. In both files the rule is
    // right about the TYPES and wrong about the values:
    //
    // `publishChecks.ts` — every finding is `schema.fields ?? {}` or its optional chain.
    // `CollectionSchema` declares `fields` present, and these schemas are JSON read off disk from
    // an app repository. One with `fields: null` reached this gate and killed the whole run, which
    // is the crash `scripts/check-apps.ts` now contains per app. The type is a claim about the
    // data and the data has already broken it. Removing the `??` reinstates the crash.
    //
    // `parent.ts` — `closed` is set inside `written()`, a callback the HOST calls when the record
    // is written. TypeScript's control flow does not follow a mutation made through a callback it
    // handed elsewhere, so it reads `closed` as still false after the await; the host contract says
    // otherwise, and the suite drives that path. Deleting the branch would drop a real case.
    files: ["src/publishChecks.ts", "src/view/parent.ts"],
    rules: { "@typescript-eslint/no-unnecessary-condition": "warn" },
  },
  {
    // OFF for the suite, because the rule is wrong about this code rather than inconvenient. Every
    // finding is a STUB standing in for an async seam — `submit: async () => ({ ok: true })` against
    // `(pending) => Promise<{ ok }>`. The seam's type demands a promise, so `async` cannot simply be
    // dropped; `() => Promise.resolve(…)` says the same thing with more syntax and no more safety.
    // A stub that awaits nothing is what a stub IS. Still an error in `src/`, where an `async` that
    // never awaits is worth knowing about.
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
  {
    // `"1.2.3.4"` is not an address here: it is the fixture for "four numbers is not a version",
    // sitting in a list beside `"1.2"`, `"v1.2.3"` and `"beta"`. Any other quad reads as an address
    // to this rule too, so there is no fixture that both makes the point and passes.
    files: ["test/test_appProtocol.ts"],
    rules: { "sonarjs/no-hardcoded-ip": "off" },
  },
  {
    // The scanner this flags reads THIS repository's own `src/view/*.ts`, line by line, at test
    // time. Backtracking is a statement about untrusted input, and there is none — while the regexp
    // decides which imports count toward the view runtime being self-contained, so rewriting it
    // would need the whole differential proof for a property nothing here is exposed to.
    files: ["test/test_viewSelfContained.ts"],
    rules: { "sonarjs/super-linear-regex": "off" },
  },
  // The four size guards below are RATCHETS, not exemptions. Each is an `error` whose ceiling is
  // what the file measures today, so the file may shrink and may not grow — and the number is the
  // rule's own `max`, which CI checks, rather than a count in a comment that nothing checks. The
  // previous form carried `// 863` and `// 1479` beside files that measured 1301 and 1500.
  //
  // Splitting any of these is a real change rather than a move: `publishChecks.ts`'s refusals come
  // in families, its suite keeps each assertion beside the family it belongs to, and both arrows
  // are one sequence with the reasoning written between the steps. The ratchet says so without
  // pretending the split is imminent.
  {
    files: ["src/publishChecks.ts"],
    rules: { "max-lines": ["error", { max: 1301, skipBlankLines: true, skipComments: true }] },
  },
  {
    files: ["test/test_publishChecks.ts"],
    rules: { "max-lines": ["error", { max: 1500, skipBlankLines: true, skipComments: true }] },
  },
  {
    files: ["src/view/parent.ts"],
    rules: { "max-lines-per-function": ["error", { max: 181, skipBlankLines: true, skipComments: true, IIFEs: true }] },
  },
  {
    files: ["src/view/srcdoc.ts"],
    rules: { "max-lines-per-function": ["error", { max: 96, skipBlankLines: true, skipComments: true, IIFEs: true }] },
  },
);
