# Changelog

## 0.36.0 — 2026-09-23

### `@mulmoclaude/core` is now a peer of `^5.4.0`, and the declared range is something CI runs (#85, closes #84)

`peerDependencies` said `^4.0.0` while `devDependencies` pinned `4.0.0` exactly, so every CI job
answered a question about one version and the declared range was a claim nothing ran. This
repository had never compiled against core 5. The mismatch surfaced in a consumer's dependency
audit rather than here, and the fix is the blind spot rather than the version string.

- `peerDependencies` and `devDependencies` on `@mulmoclaude/core` are both `^5.4.0`; the exact dev
  pin is gone.
- `isSafeCustomViewPath` is imported from `@mulmoclaude/core/collection/paths` rather than
  `@mulmoclaude/core/collection/server`, leaving `parseAppManifest` as the only name reached
  through core's server half. Both subpaths export the same function object, which was proved by
  running the two side by side over generated input, not by reading.
- New `test/test_coreCompat.ts`. It calls every symbol this package imports from core and asserts
  the answer, and it pins the names reached through each core subpath — separately for what loads
  at runtime and what is type-only. The import scan reads the syntax tree, so a bare `import "…"`,
  a dynamic `import()` and a clause broken over several lines all count, while a specifier inside
  a comment or a string does not. It also asserts that `firebase` is absent, because the suite
  passing is what shows the declared floor needs none.
- New `core-floor` CI job. It installs the FLOOR of the declared peer range — read out of
  `package.json`, never written in the workflow — and runs `typecheck` and `test` against it. The
  other jobs run whatever the lockfile holds, which drifts above the floor at the first routine
  upgrade.
- `README.md` and `CLAUDE.md`: the enumeration of what this package uses from core was missing
  `parseAppManifest`.

The floor is 5.4.0 rather than 5.0.0 because core's `collection/server` required `firebase` — an
optional peer of core — from somewhere in the 4.x line through 5.3.x, so a consumer without
`firebase` could not load that subpath at all (mulmoclaude#3263, fixed in #3264 and released as
core 5.4.0). Dropping the 4.x line is not an API matter: the symbols this package uses behave
identically from core 4.0.0 through 5.4.0, and its `typecheck` and `test` pass against every one of
them. It is a decision to declare only what CI keeps running.

**Consumers must move to core 5.4.0 or later before taking this version.** At the time of this
release, MulmoTerminal declares `^4.10.0` and MulmoServer pins `4.9.2`; both keep working on
`@receptron/sharedapp@0.35.0` until they upgrade, because `^0.35.0` does not pick up `0.36.0`.

### GitHub Actions bumped from v4 to v7 (#80)

`actions/checkout` and `actions/setup-node` were still on v4. Only the version lines changed; no
job content moved. The breaking changes across those majors — `setup-node`'s automatic caching
keyed off `packageManager`, and `checkout`'s refusal to check out a fork PR under
`pull_request_target` / `workflow_run` — do not apply to this repository.

### Dependency refresh (#83)

Routine upgrade of runtime and development dependencies with the lockfile regenerated: `zod`,
`@types/node`, `eslint`, `eslint-plugin-sonarjs`, `prettier`, `tsx`, `typescript-eslint`.
