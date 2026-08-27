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

## The version of the contract

Every projection carries `protocol` — the version of the publish contract the documents keep
(`src/appProtocol.ts`). The renderer (mulmoserver) is released separately and runs in browsers that
may be a month behind, so this is the only thing in a document that lets such a build know it must
NOT draw it: a reader refuses a higher MAJOR, and reads a higher minor as an addition it simply does
not use.

- **MAJOR** — a change a reader must understand. An older reader refuses the app rather than drawing
  part of it, so the reader ships first.
- **MINOR** — an addition an older reader ignores safely (`views[].live` was one, and so is
  `views[].limit`: a reader that does not know it reads the whole collection, which is what every
  reader did before the key existed — expensive, never wrong).
- **PATCH** — neither.

**Every projection is stamped `APP_PROTOCOL`, which is still 1.0.0** — the contract has not moved,
and `uidField` is the reason that is worth saying. It went out as 2.0.0, then 1.1.0, then as nothing
at all, because nothing anywhere reads the difference:

- the reader's gate compares the MAJOR only, so a minor is a number it does not act on;
- a reader's behaviour switch would read one, and there is no such switch yet;
- the authored floor is checked by `protocolProblems`, which never runs for a key an older build does
  not know — the manifest schema is `.strict()`, so that build refuses `uidField` at the parse,
  earlier and more clearly than any version comparison ("Unrecognized key", with a floor declared and
  without it, the same message both times);
- and a human reading the document finds `submit.<cid>.uidField` in it, three lines from the stamp.

So **adding a key does not move the number**, and the strict schema is what makes that safe: a build
handed a key it has never heard of stops rather than dropping it. A reader that has not learnt
`uidField` refuses such an app too, on its shape — the uid is in `createFields` (the rules take no
key outside it) and never in `form.fields` (not drawing it is the feature), which the `submit`/`form`
consistency check has refused since 1.0.0.

**What would move it** is a change no schema can see: an existing key whose MEANING moves. Nothing is
unrecognised there, so the version is the only handle — the author names the contract, publish
refuses a floor above the ceiling, and if the reader must understand the change, the major goes up
and older readers refuse the app. That day the stamp goes back to being per app, so the refusal lands
on the apps that need it rather than on everything published afterwards.

A document with no `protocol` is 1.0.0. That is not a fallback: apps published before the key existed
are exactly that, and those are the documents already in Firestore.

`app.json` may declare `protocol` as a FLOOR. It never decides what is published — the documents keep
whatever produced them, and an app claiming a contract its documents do not honour is worse than one
claiming none. Publish refuses a declaration newer than the ceiling, and requires a floor for
nothing: no feature has a version of its own.

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
yarn typecheck   # src, test and scripts — one tsconfig each
yarn test        # node:test via tsx
yarn lint
yarn format
```

The two release gates are `yarn` scripts too, so there is one way to run them and it is the
way CI runs them — `yarn check:pack <tarball>` (in CI) and `yarn check:apps [path]` (by hand,
before a release: it needs the private apps checkout CI cannot have).


Design notes live in MulmoTerminal: `plans/refactor-shared-app-module.md`, and the
decisions behind the shared-app design are `plans/feat-shareable-collections.md` (D1–D10)
and `docs/shared-app-principles.md`.
