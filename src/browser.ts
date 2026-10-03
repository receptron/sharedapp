// What a BROWSER may load: compiling a declaration into the documents publish writes, and making a
// visitor's copy of a forkable app (receptron/mulmoserver#332). The package's main entry also
// carries `parseAuthoredApp`, which reaches core's server half, so a page bundling the main entry
// fails to build; this one reaches only `zod` and core's browser-safe subpaths, which
// `test_browserEntry.ts` holds.
export { AuthoredAppZ, type AuthoredApp } from "./publishManifest.js";
export { normalizeViews, viewDocId, type NormalizedView } from "./appViews.js";
export {
  projectAppViews,
  projectPublish,
  appConfigPath,
  appSchemasPath,
  appSlugDoc,
  appViewTierPath,
  viewConfigDocId,
  APPS_COLLECTION,
  APP_SLUGS_COLLECTION,
  PUBLIC_CONFIG_DOC,
  type AppViewTier,
  type PublishedFace,
  type PublishStamp,
} from "./publishProject.js";
export {
  FORK_SOURCE_DOC,
  forkViewDocId,
  projectForkSource,
  forkFrom,
  type ForkSourceDoc,
  type ForkableApp,
  type ForkRequest,
  type ForkResult,
} from "./forkSource.js";
export { type ShareCard } from "./shareCard.js";
export { BANNER_DOC, BANNER_TYPES, HEX_COLOR, PublicThemeZ, type PageTheme } from "./pageTheme.js";
