/** Types for `eslint.severity.js`, which is plain JS because `eslint.config.js` imports it and
 *  ESLint loads that file as-is — a `.ts` module would need `jiti` in the loader path for one
 *  function. Declared here rather than inferred so `test/` sees real types instead of `any`. */

/** A rule's configured severity, whether written bare (`"warn"`) or with options. */
export type Severity = number | string;

export type RuleEntry = Severity | [Severity, ...unknown[]];

/** Raised to `error` if the preset shipped it as a warning, returned untouched otherwise. */
export declare const raise: (entry: RuleEntry) => RuleEntry;

/** One preset config with every rule in it raised, and every other key left alone.
 *
 *  The constraint is `Record<string, unknown>` rather than a shape naming `rules`, because a flat
 *  config block carries whatever ESLint allows — `files`, `ignores`, `languageOptions`, `plugins`,
 *  `settings`, a preset's `name` — and a narrower type would reject the blocks this is FOR. */
export declare const enforced: <Block extends Record<string, unknown>>(config: Block) => Block;
