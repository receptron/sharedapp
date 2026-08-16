// The shared-app compiler: `app.json` in, Firestore documents out — and what
// publish refuses before it writes any of them.
//
// WHY THIS IS ITS OWN REPOSITORY. It used to live in `@mulmoclaude/core`, which
// meant that every change to a shared app — a new key in `app.json`, a new
// check in the publish gate, a new field in a projected document — was a change
// to MulmoClaude, a CI run, a merge, and a HUMAN npm publish before the work
// could continue. In the 90 days before the split, 24 commits went that way,
// and MulmoClaude itself used none of this code: it neither writes nor reads a
// shared collection.
//
// WHAT IS NOT HERE: the collection RUNTIME. Discovery, the store, the Firestore
// backend and the host seam stay in `@mulmoclaude/core`, because MulmoClaude
// does use those. The line is "declaration to document"; anything that reads or
// writes a live collection is on the other side of it.
//
// WHO USES IT:
//   MulmoTerminal  compiles a repository's `app.json` and writes the documents
//                  (deploy / publish / unpublish are ITS operations, not ours)
//   MulmoServer    feeds this output to the Firestore rules emulator, which is
//                  the only test in either repository proving that what publish
//                  writes is what `firestore.rules` allows
//
// NOTHING HERE GRANTS ANYTHING. `firestore.rules` is the authority; these
// documents tell a page what exists so it can draw the controls that work, and
// let a refusal name itself instead of arriving as a bare permission error.
//
// PUBLISHED TO npm, and that is not the gate this module escaped. It was going
// to be a git ref — pin a sha, `prepare` builds on install, nobody publishes
// anything — and MulmoTerminal makes that impossible: it is itself an npm
// package (`npx mulmoterminal`) shipping `server/`, which imports this at
// runtime, so a git dependency would make every end user clone this repository
// and run `tsc` before their terminal starts. Releasing THIS is one package
// with no dependents to bump, no peer ranges and no e2e matrix; releasing
// `@mulmoclaude/core` was eight packages and a full CI run, and every
// `app.json` key paid it.
//
// Design: mulmoterminal `plans/refactor-shared-app-module.md`

// What an author may declare, and how it parses.
export {
  AuthoredAppZ,
  parseAuthoredApp,
  APP_ROLES,
  type AuthoredApp,
  type AuthoredCollectionConfig,
  type AuthoredMail,
  type AuthoredSubmit,
} from "./publishManifest.js";

// The pages an app shows, per audience: the declaration, where each audience's
// documents live, and what the parent page needs in order to query for them.
export {
  normalizeViews,
  participantScope,
  viewDocId,
  writeFor,
  PUBLIC_VIEW_ID,
  RESERVED_VIEW_IDS,
  VIEW_AUDIENCES,
  VIEW_CONFIG_ID,
  VIEW_ID_PATTERN,
  VIEW_TIER,
  type AppViewConfigDoc,
  type NormalizedView,
  type NormalizedViewsResult,
  type ProjectedViewCollection,
  type ProjectedViewWrite,
  type ViewAudience,
} from "./appViews.js";

// Authored -> written: the deploy half, the publish half, promotion, and where
// each document lives.
export {
  projectApp,
  projectAppViews,
  projectDeploy,
  projectPublish,
  stagedRuleConfig,
  promoteSchema,
  appViewTierPath,
  viewConfigDocId,
  appStagingPath,
  appConfigPath,
  appSchemasPath,
  APPS_COLLECTION,
  PUBLIC_CONFIG_DOC,
  APP_SLUGS_COLLECTION,
  appSlugDoc,
  type AppSlugDoc,
  type AppViewTier,
  type DeployedApp,
  type PublishedFace,
  type PublishStamp,
  type PublishedApp,
  type PublishedConfigDoc,
  type PublishedSchemaDoc,
  type StagedSchemaDoc,
} from "./publishProject.js";

// What publish refuses, and which live records a schema change would break.
export { publishProblems, promotedRoleProblems, bindsSubmitterIdentity, type PublishableCollection } from "./publishChecks.js";

// The `write` half of a projection, read back. Both hosts read one and neither trusts it — see
// the module header for why the two readers must not differ.
export { projectedWriteOf, projectedWritesOf } from "./viewWriteRead.js";
