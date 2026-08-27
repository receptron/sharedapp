/** Types for `eslint.config.js`. It is plain JS — ESLint loads it as-is — and its default export is
 *  a flat config array whose blocks come from plugins that do not all ship types.
 *
 *  Declared as `unknown[]` on purpose. A structural type here would be this repository asserting a
 *  shape it does not control and cannot verify, which is the kind of claim the rest of this
 *  codebase spends its time deleting. Callers narrow what they read: see
 *  `scripts/overrides-report.ts`, which classifies every block and REPORTS the ones it cannot. */
declare const config: unknown[];
export default config;
