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

Before a release, against a real apps checkout (NOT in CI — `../apps` is a private working
checkout, so a job depending on it would be red for reasons nobody here could act on):

```
yarn check:apps [path-to-apps-checkout]                  # default ../apps
```

It needs a full `yarn install`, devDependencies included — it imports `src/`, which imports
`@mulmoclaude/core` for values (`isValidCollectionName`, `parseAppManifest`,
`isSafeCustomViewPath`), and that package is a peer dependency carried here only as a dev one.
That was already true when the command was spelled `npx tsx`; `npx` could fetch the runner but
never the peer, so the failure just arrived one import later.

It runs `publishProblems` + `schemaRefProblems` over the ten apps that already publish, reading
each app's real collections from `<app>/.claude/skills/<cid>/schema.json` (an app IS a
repository, so its schemas are committed beside its `app.json`) — without them the field-name,
enum and bound checks would be skipped while still printing a pass. A `schema.json` missing any
of `title`, `icon`, `primaryKey` or `fields` is a FAILURE naming the absent keys, not a skip: it
is not a schema the host would promote, and the four are what `CollectionSchema` requires. An app it cannot read is a
FAILURE, not a skip: ten minus the missing ones is a weaker claim that looks identical going
past. It is the counterweight to a gate tested one rule at a time: a tightened check is judged
against the fixture written to provoke it, and the app it newly refuses is in another
repository.
`test/test_publishBaseline.ts` carries three shapes representing those ten so CI has the same
question without the sibling checkout.

Single test file: `npx tsx --test test/test_publishChecks.ts`
Single test case: `npx tsx --test --test-name-pattern "submitOnly" test/test_publishChecks.ts`

CI runs `format:check`, `lint`, `typecheck`, `test` on Node 22 and 24, plus a `consumable`
job that `yarn pack`s and asserts every entry point the package DECLARES is in the tarball —
derived from `exports` plus `main` and `types`, not a hand-written list. A list written out by
hand reopens the hole the day a third subpath is added: the check named `dist/index.js` and
`dist/index.d.ts` literally once, and `./view` — which MulmoTerminal's headless preview and
MulmoServer's `AppViewFrame.vue` both import — could have vanished and still passed.
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

## Module map (src/, ~5100 lines, all re-exported from index.ts)

| file | role |
| --- | --- |
| `publishManifest.ts` | the AUTHORED shape — zod schema for everything in `app.json` except `aid` (which is parsed via core's `parseAppManifest`, so one field has one statement). `AuthoredAppZ` is `.strict()` **on purpose**: a misspelled declaration key is not a broken app, it is a silently permissive one. |
| `publishProject.ts` | the compiler: authored → published. **Every** difference between what a human writes and what the rules read is in this file or is a bug (ISO window → epoch millis, derived `memberEmails`, publisher stamps). Also owns all Firestore path helpers. |
| `appViews.ts` | which document a view's HTML lands on, per audience: `public` → `apps/{aid}/config/*`, `member` → `.../member/*`, `participant` → `.../roster/*`. A rule cannot hide a field, so audience is a *place*, not a filter. The declaration is projected per tier, never published once and shared. |
| `appAgents.ts` | the standing job an app asks an AGENT sitting at it to do (`agents[]`): the same audience-is-a-place rule as `appViews.ts`, projected onto the tier document the audience already reads. Capability is still the declaration — a brief grants nothing. |
| `publishChecks.ts` | the gate: `publishProblems` (what publish refuses, see the two kinds below), `schemaRefProblems` (which live records a schema change would break), `bindsSubmitterIdentity`. |
| `appProtocol.ts` | the contract version these documents are stamped with, and whether an authored floor may ask for it. A reader decides from the stamp whether it may draw what it is looking at. |
| `view/` | the parent's half of the conversation with a sandboxed view — `bridge.ts` (the public page: a message from the frame is a REQUEST, and a write waits for the visitor's own click), `memberBridge.ts` (the roster: an intent, judged and performed), `message.ts` / `intent.ts` (what a message must be before it is one), `srcdoc.ts` (the bootstrap injected into the frame, and its CSP). No DOM anywhere in it: `event.source` belongs to the host component. |

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
