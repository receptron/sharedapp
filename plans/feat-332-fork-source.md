# feat: fork source — `forkable` and `config/fork` (receptron/mulmoserver#332)

The sharedapp half of web forking. Design and order across repos: receptron/mulmoserver#332.

## What

- `app.json` gains `forkable: boolean` (absent = not forkable).
- `projectForkSource(authored, schemas, publishedAt)` → the `config/fork` document: the declaration
  without the keys that name WHO (`aid`, `slug`, `aidEnv`, `owner`, `members`, `agents`), the
  schemas keyed by cid, the view ids, and the protocol. The host writes each page's HTML to
  `config/fork:view:{id}` (`forkViewDocId`).
- `forkFrom(data, { aid, email, name?, slug? })` → the forker's authored app (the forker as the only
  owner), validated by `AuthoredAppZ` and run through `publishProblems` + `schemaRefProblems`, so a
  copy is never a declaration publish would refuse.
- `forkSourceProblems(authored, source, pages)`: the host runs it before writing the source and
  refuses `forkable` while a roster address or the owner uid appears anywhere in the source or the
  pages' HTML (case-insensitive).
- `config/public.forkable: true` when declared (absent otherwise), so the public page offers a copy without reading `config/fork`. The deployed reader ignores unknown top-level keys (`publicConfigFrom`).
- `forkable` beside `agents[]` is refused at publish (`forkCheck.ts`): the copy would run someone's
  agent at an app nobody priced.

## Why the declaration and not the published documents

The app document carries `members`, `memberEmails`, `publishedBy` and `previousPublished` (an earlier
roster), and schema documents carry `publishedBy`. Copying them would copy the people.

## Not here

The host write (MulmoTerminal) and the browser fork (mulmoserver).
