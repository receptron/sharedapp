# Changelog

## 0.37.0 — 2026-10-02

### Selective publish: `collections[cid].publishField` + `public.readPublished` (#94, closes #93)

An owner can now show visitors only the rows they chose to publish — a question box whose answered
questions appear on the public page, while everything else stays private.

- `collections[cid].publishField` names the boolean that marks a row published.
- `public.readPublished: [cid]` makes those rows world-readable. MulmoServer's rules list only
  `where(publishField == true)` queries, open only published rows, refuse a submitter writing the
  flag on create or update, and leave publishing to the owner (and writers) alone.
- Projection: the app document carries `public.readPublished` and each collection's `publishField`;
  `config/public.readPublished` maps each cid to its field so a page view knows which filter to apply.
  Omitted entirely when unused, so existing apps project exactly as before.
- Publish gate refuses: a `readPublished` cid without `publishField`, one also in `public.read`, the
  field in `createFields` or any `selfUpdate` list, and the field colliding with the status / assignee
  / stamp / id / uid / email field. Public views may be handed `readPublished` collections; public
  agents stay on `public.read` (their watch reads unfiltered, which the rules refuse).

### Cancellation deadline: `public.submit[cid].window.withdrawUntilField` (#96, closes #95)

"Cancel up to the day before" for bookings. `{ ref, collection, field }` — the submitter's
`selfDelete` is accepted only while the time is before the referenced record's `field` (epoch
millis). The desk's own delete is not bound.

- Projected beside `fromField` / `untilField`.
- Gate: the same reference checks as the closing bound (collection exists, `ref` in `createFields`,
  target field is a number), a deadline without `selfDelete` is refused, and so is a `selfUpdate`
  list containing the `ref` — the rules read the deadline off the stored row, so a movable ref would
  let a submitter retarget a later deadline. (The same shape for `fromField` / `untilField` is #98.)

### Test guards on `view/` (#89 closes #87, #90)

- The `view/` self-containment guard treated `import { type A } from "…"` as erased; under
  `verbatimModuleSyntax` it is not. The scan now reads the syntax tree (`test/importScan.ts`, shared
  with `test_coreCompat.ts`) and has its own tests.
- `view/` must also stay flat: MulmoTerminal's headless preview serves only top-level `.js` files, so a
  nested module 404s even when it imports nothing.

### Maintenance (#91, #92, #97)

- Plan follow-ups recorded as done (#91).
- devDependencies: `@mulmoclaude/core` ^5.8.0, `typescript-eslint` ^8.71.0, `@types/node`,
  `eslint-plugin-security`, `eslint-plugin-sonarjs`, `prettier`, `type-coverage` (#92, #97). The core
  peer range is unchanged (`^5.4.0`).

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
