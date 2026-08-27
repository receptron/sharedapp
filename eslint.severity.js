/** How much a preset's rules matter here.
 *
 *  A preset decides WHICH rules to run; this decides how much they matter. A warning does not fail
 *  CI and nothing here reads lint output, so a rule left at `warn` is a rule that reports a
 *  violation and ships it anyway.
 *
 *  Written as a transform rather than a list of rule names because the list is what rots: a preset
 *  that adds a warn-level rule in a future release arrives already enforced.
 *
 *  IN ITS OWN FILE BECAUSE IT IS LOGIC, and `eslint.config.js` is the one file no test could reach
 *  while it lived there. Measured: replacing the body of {@link raise} with `entry => entry` left
 *  `yarn lint`, `yarn lint:overrides` and `yarn test` all green while silently dropping FOURTEEN
 *  `security/*` rules from error to warn — `detect-child-process`, `detect-eval-with-expression`,
 *  `detect-non-literal-fs-filename` and eleven more. `test/test_eslintSeverity.ts` is what makes
 *  that mutation red.
 *
 *  Plain `.js` with JSDoc types rather than `.ts`: `eslint.config.js` imports it directly, and
 *  ESLint loads that file as-is. A `.ts` module would need `jiti` in the loader path to be worth
 *  anything, which is a dependency for one function. */

/** A rule's configured severity, whether written bare (`"warn"`) or with options (`["warn", {…}]`).
 *  @typedef {number | string} Severity
 *  @typedef {Severity | [Severity, ...unknown[]]} RuleEntry */

/** Raised to `error` if the preset shipped it as a warning, and returned untouched otherwise.
 *
 *  SEVERITY ONLY. The preset's own options are preserved — a rule configured
 *  `["warn", { max: 4 }]` becomes `["error", { max: 4 }]`, never `"error"` — and a rule the preset
 *  ships as `off` stays off, because that was its decision and a different one from "this matters
 *  less". Both numeric (`1`) and word (`"warn"`) forms count, since presets use both.
 *
 *  @param {RuleEntry} entry
 *  @returns {RuleEntry} */
export const raise = (entry) => {
  const severity = Array.isArray(entry) ? entry[0] : entry;
  if (severity !== 1 && severity !== "warn") return entry;
  return Array.isArray(entry) ? ["error", ...entry.slice(1)] : "error";
};

/** One preset config with every rule in it raised. A block carrying no `rules` is returned as-is:
 *  that is where the parser, the plugins and the globals live, and rewriting it would be rewriting
 *  how the repo is linted rather than how much its findings matter.
 *
 *  @template {{ rules?: Record<string, RuleEntry> | undefined }} Block
 *  @param {Block} config
 *  @returns {Block} */
export const enforced = (config) =>
  config.rules ? { ...config, rules: Object.fromEntries(Object.entries(config.rules).map(([id, entry]) => [id, raise(entry)])) } : config;
