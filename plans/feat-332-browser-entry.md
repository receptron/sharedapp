# feat: `@receptron/sharedapp/browser` (receptron/mulmoserver#332)

mulmoserver's fork page re-projects a forkable app in the visitor's browser (`forkFrom`,
`projectPublish`, `projectAppViews`). Bundling the main entry fails the page build: `publishManifest.ts`
imported `parseAppManifest` from `@mulmoclaude/core/collection/server`, which pulls Node built-ins and
`@duckdb` native bindings.

- `parseAuthoredApp` moves, verbatim, to `src/authoredAppFile.ts` — the one reach into core's server
  half. The main entry re-exports it, so no caller changes.
- `src/browser.ts` (`exports["./browser"]`) re-exports what a browser compiles with: the projections,
  the path helpers, `normalizeViews`, `AuthoredAppZ` and the fork functions.
- `test/test_browserEntry.ts` walks the runtime import graph from `browser.ts` and allows only `zod`,
  `@mulmoclaude/core/collection` and `@mulmoclaude/core/collection/paths`.
