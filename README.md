# sharedapp

The shared-app compiler: **`app.json` in, Firestore documents out** — and what publish
refuses before it writes any of them.

```
app.json ──► projectApp        ──► apps/{aid}, apps/{aid}/config/public, schemas
         ├─► projectPublish    ──► the same document data, for the caller's write order
         ├─► projectAppViews   ──► apps/{aid}/{member,roster}/config
         └─► publishProblems   ──► the refusals, before anything is written
```

## Why this is its own repository

It used to live in `@mulmoclaude/core`. That meant every change to a shared app — a new
key in `app.json`, a new check in the publish gate, a new field in a projected document —
was a change to MulmoClaude, a CI run, a merge, and a **human npm publish** before the
work could continue. In the 90 days before the split, **24 commits went that way**, and
MulmoClaude itself used none of this code: it neither writes nor reads a shared
collection.

```json
"@receptron/sharedapp": "^0.1.0"
```

## Why npm, when the point was to escape a publish

It was going to be a git-ref dependency — pin a sha, `prepare` builds on install, nobody
publishes anything. That does not work here, and the reason is MulmoTerminal: **it is
itself an npm package** (`npx mulmoterminal`) and it ships `server/`, which imports this at
runtime. A git dependency would make every end user clone this repository and run `tsc`
before their terminal starts.

So this is published — but the gate it replaces is not the one it escapes. Releasing this
is ONE package with no dependents to bump, no plugin peer ranges, no changelog check and no
e2e suite. Releasing `@mulmoclaude/core` was eight packages and a full CI matrix, and every
`app.json` key paid it.

## What is NOT here

The collection **runtime** — discovery, the store, the Firestore backend, the host seam —
stays in `@mulmoclaude/core`, because MulmoClaude does use those. The line is
*declaration to document*: anything that reads or writes a live collection is on the other
side of it.

`@mulmoclaude/core` is a **peer** dependency, for three things that have other users over
there and would circle back if they moved: `isValidCollectionName`,
`isSafeCustomViewPath`, and the `CollectionSchema` types. Depending on core does not undo
the point — those parts do not change, so they do not ask for a release.

## Who uses it

| | |
| --- | --- |
| **MulmoTerminal** | compiles a repository's `app.json` and writes the documents. Deploy / publish / unpublish are ITS operations, including their write order |
| **MulmoServer** | feeds this output to the Firestore rules emulator — the only test in either repository proving that what publish writes is what `firestore.rules` allows |

## Nothing here grants anything

`firestore.rules` is the authority. These documents tell a page what exists so it can draw
the controls that work, and let a refusal name itself instead of arriving as a bare
permission error. A projection that disagrees with the rules is a bug in the projection,
never a loosening of the rules.

## Working on it

```
yarn install     # runs prepare -> tsc
yarn typecheck   # src and test
yarn test        # node:test via tsx
yarn lint
yarn format
```

Design notes live in MulmoTerminal: `plans/refactor-shared-app-module.md`, and the
decisions behind the shared-app design are `plans/feat-shareable-collections.md` (D1–D10)
and `docs/shared-app-principles.md`.
