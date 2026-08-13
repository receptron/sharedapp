# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
yarn install        # runs prepare -> tsc
yarn build          # tsc -p tsconfig.json  (emits dist/)
yarn typecheck      # src AND test (two tsconfigs — test/ has its own)
yarn test           # tsx --test ./test/test_*.ts
yarn lint
yarn format         # prettier, printWidth 160
yarn format:check   # what CI runs
```

Single test file: `npx tsx --test test/test_publishChecks.ts`
Single test case: `npx tsx --test --test-name-pattern "submitOnly" test/test_publishChecks.ts`

CI runs `format:check`, `lint`, `typecheck`, `test` on Node 22 and 24, plus a `consumable`
job that `yarn pack`s and asserts `dist/index.js` and `dist/index.d.ts` are in the tarball.
Consumers never build this — they get `dist/` from the published tarball — so a `files` or
`prepublishOnly` regression would ship an empty package and break on `npx mulmoterminal`
rather than here.

Commit messages in this repository are Conventional Commits with a Japanese subject.

## What this package is

`app.json` in, Firestore documents out — plus the refusals that happen before anything is
written. It is a **pure projection library**: no I/O, no Firestore client, no clock. Every
function takes the authored declaration (and a `PublishStamp` threaded in by the caller) and
returns plain documents. Callers — MulmoTerminal (deploy/publish/unpublish, including write
order) and MulmoServer (rules-emulator round trip) — own all writes.

The line against `@mulmoclaude/core` is *declaration to document*. The collection **runtime**
(discovery, store, Firestore backend, host seam) stays in core. Core is a **peer** dependency
for exactly three things: `isValidCollectionName`, `isSafeCustomViewPath`, and the
`CollectionSchema` types.

**Nothing here grants anything.** `firestore.rules` (in MulmoServer) is the authority. These
documents tell a page what exists so it can draw controls that work, and let a refusal name
itself instead of arriving as a bare permission error. A projection that disagrees with the
rules is a bug in the projection, never a loosening of the rules.

## Module map (src/, ~2400 lines, all re-exported from index.ts)

| file | role |
| --- | --- |
| `publishManifest.ts` | the AUTHORED shape — zod schema for everything in `app.json` except `aid` (which is parsed via core's `parseAppManifest`, so one field has one statement). `AuthoredAppZ` is `.strict()` **on purpose**: a misspelled declaration key is not a broken app, it is a silently permissive one. |
| `publishProject.ts` | the compiler: authored → published. **Every** difference between what a human writes and what the rules read is in this file or is a bug (ISO window → epoch millis, derived `memberEmails`, publisher stamps). Also owns all Firestore path helpers. |
| `appViews.ts` | which document a view's HTML lands on, per audience: `public` → `apps/{aid}/config/*`, `member` → `.../member/*`, `participant` → `.../roster/*`. A rule cannot hide a field, so audience is a *place*, not a filter. The declaration is projected per tier, never published once and shared. |
| `publishChecks.ts` | `publishProblems` / `promotedRoleProblems` — the gate. |

## Conventions that are load-bearing

- **The header comments are the design docs.** Each `src/*.ts` opens with a long block
  explaining why the module exists and which alternatives were rejected. Read the header
  before changing a module; if a change invalidates a stated reason, update the header in the
  same commit.
- **Two kinds of refusal in `publishChecks.ts`**, and both matter equally: *security
  invariants* (the rules do exactly as told, but that is not what the author meant — e.g.
  `submitOnly`) and *fail-closed traps* (the rules refuse every write the declaration was
  meant to allow, silently — e.g. `initialStatus` without `statusField`). A denial carries no
  explanation to whoever hits it, and that person is not the author.
- **Every refusal test is paired with an acceptance test.** A file of refusal assertions is
  satisfied by `publishProblems = () => ["no"]`. Test fixtures build declarations through the
  real `AuthoredAppZ` so no fixture can assert about a shape publish would have rejected
  earlier.
- **Problems are returned as arrays of actionable lines, never thrown.** Publish is a manual
  step; stopping at the first problem makes it N round trips.
- **Projections stay pure.** Time and identity arrive via `PublishStamp` so tests can assert on
  an exact document.
- **Names in `APP_ROLES` and the published document shapes are permanent** — the deployed
  rules compare those strings directly and they live in committed `app.json` files, so a
  rename is a migration over published apps.
- `tsconfig` is strict plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`;
  `src/` must not need `@types/node` (only `test/tsconfig.json` pulls it in).

## Related repositories

Design notes live in MulmoTerminal: `plans/refactor-shared-app-module.md`,
`plans/feat-shareable-collections.md` (D1–D10), `docs/shared-app-principles.md`.
The rules round-trip test is MulmoServer's `test/rules/rules_publish.ts` — the only test in
either repository proving that what publish writes is what `firestore.rules` allows.
