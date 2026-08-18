// The RUNTIME half of a shared app: what a parent page puts in front of a
// sandboxed view, and the vocabulary the two speak.
//
// The rest of this package is the COMPILER — authored declaration in, written
// documents out. This subpath is the other end of the same contract, and it is
// here for one reason: a shared app has more than one parent now. mulmoserver
// draws `/a/{slug}`, `/m/{slug}` and `/p/{slug}`; MulmoTerminal draws the
// author's local preview of exactly those pages before anything is published.
//
// A preview whose parent is a SECOND implementation is not a preview. It agrees
// with production on the easy things and diverges on the ones that matter — a
// message dropped on the port, a confirmation that is not drawn, a modal that
// the sandbox ignores here and not there — and every divergence manufactures
// "it worked on my machine". So the parent is shared code, and the hosts keep
// only their own chrome: what the confirmation looks like, where the diagnostic
// strip sits.
//
// Design: mulmoterminal `plans/feat-shared-app-preview.md`, section 1.
export { GESTURE_MARK, VIEW_MESSAGE } from "./protocol.js";
export { MAX_NOTICES, publicViewBootstrap, publicViewSrcdoc, viewNonce } from "./srcdoc.js";
export {
  isReady,
  isRecord,
  readLookupMessage,
  NOTICE_DETAIL_LIMIT,
  readNotice,
  readSubmitMessage,
  VIEW_NOTICE_CODES,
  type LookupAnswer,
  type LookupAsk,
  type LookupRead,
  type LookupRefusal,
  type PendingSubmit,
  type SubmitRead,
  type SubmitRefusal,
  type SubmitDeclaration,
  type ViewDataset,
  type ViewNotice,
  type ViewNoticeCode,
  type ViewSubmitConfig,
} from "./message.js";
export { viewBridge, type BridgeCells, type BridgePorts, type Channel, type Signal } from "./bridge.js";
// The MEMBER's parent — the roster and participant pages, and the author's
// preview of them. Separate from `viewBridge` because a member's ask is an
// intent against a record that exists, not a stranger's proposal; see
// `memberBridge.ts`.
export { HOST_ERROR, memberBridge, refuseEverything, type MemberBridgePorts, type PerformIntent } from "./memberBridge.js";
export { capabilityOf, capabilitiesFor, mayTransition, viewerFor, type ViewCapability, type Viewer, type WriteTier } from "./capability.js";
export {
  readIntentMessage,
  type AskedIntent,
  type IntentAnswer,
  type IntentKind,
  type IntentRead,
  type IntentRefusal,
  type JudgedIntent,
  type RecordLookup,
  type Who,
} from "./intent.js";
export { mailFor, type QueuedMail } from "./intentMail.js";
export { portChannel, asIs, type Cloneable } from "./channel.js";
export {
  MIRROR_OPEN,
  MIRROR_TAKEN,
  missingRequired,
  needsAccount,
  plannedWrite,
  recordId,
  recordOf,
  writableFields,
  type DrawnForm,
  type PlannedWrite,
  type ServerTime,
  type SubmitSpec,
  type Submitter,
  type WritableField,
} from "./submit.js";

// The `write` half of a projection, READ BACK — the parent's own job, which is why it is on this
// subpath and NOT on the root, and why the module sits INSIDE this directory.
//
// The root entry reaches the compiler, and the compiler imports `@mulmoclaude/core/collection/server`
// at runtime. A host that pulled this from there would drag core's server half — DuckDB and all —
// into a browser bundle, which is not a size regression but a build failure: rolldown cannot load a
// `.node` binary. mulmoserver's frontend does exactly this, and CI caught it.
//
// Inside the directory because MulmoTerminal's headless preview serves `dist/view` and nothing
// else, so a re-export reaching a sibling of it 404s and takes the whole runtime down with it.
// Its own tests could not see that; the browser was the only thing that could.
export { projectedWriteOf, projectedWritesOf } from "./writeRead.js";
