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
export { VIEW_MESSAGE } from "./protocol.js";
export { publicViewBootstrap, publicViewSrcdoc, viewNonce } from "./srcdoc.js";
export {
  isReady,
  isRecord,
  readSubmitMessage,
  type PendingSubmit,
  type SubmitRead,
  type SubmitRefusal,
  type SubmitDeclaration,
  type ViewDataset,
  type ViewSubmitConfig,
} from "./message.js";
export { viewBridge, type BridgeCells, type BridgePorts, type Channel, type Signal } from "./bridge.js";
export { portChannel, asIs, type Cloneable } from "./channel.js";
