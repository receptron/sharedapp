// THE VERSION OF THE CONTRACT this compiler emits.
//
// A published app is read by another program, released separately: mulmoserver draws
// `apps/{aid}/…` in a stranger's browser that may be running any build — a home-screen PWA that has
// not reloaded in a month included. So the day a change here breaks that reader, the reader has to
// be able to tell, from the document alone, that it must not draw it.
//
// That is what this number is. It rides in every projection (`protocol`), and mulmoserver refuses a
// higher MAJOR rather than drawing it.
//
//   MAJOR  a breaking change: a key whose meaning moved, or one a reader must understand to be
//          correct. Bumping it makes every older reader REFUSE every app published afterwards, so
//          it is not done casually — and when it is, the reader ships first.
//   MINOR  an addition an older reader ignores safely. `views[].live` was exactly this: a reader
//          that knows nothing about it reads the collections once, as it always did.
//   PATCH  neither.
//
// A DOCUMENT WITH NO `protocol` IS 1.0.0, and that is not a fallback: every app published before
// this key existed is one, and those documents are the ones in Firestore right now. Which is also
// why this starts at 1.0.0 rather than 0.1.0 — the first contract already shipped.

/** THE VERSION IS PER APP, not per build of this compiler.
 *
 *  It started as one constant — what this build writes — and `uidField` is what showed that to be
 *  wrong in the one direction that matters. A reader compares the MAJOR and nothing else
 *  (mulmoserver's `protocolDrawable`), so a minor bump is a number no reader acts on: an old
 *  browser reading a uid-bearing app accepts the document, ignores the key it does not know, draws
 *  a box asking the visitor to type their uid, and every submission is refused by `uidOk` with
 *  nothing to explain it. An authored floor does not help — it is checked by the PUBLISHER, and the
 *  reader is somebody else's cached tab.
 *
 *  So a feature a reader must UNDERSTAND is emitted as a new major, and only by the apps that use
 *  it. An app that declares no such key is stamped exactly what it was stamped before, so every
 *  reader in the wild goes on drawing every app it could already draw, and refuses precisely the
 *  ones it would get wrong.
 *
 *  What this build can emit is {@link APP_PROTOCOL}; what a given declaration IS emitted as is
 *  {@link protocolFor}. */

/** What an app using nothing newer than the first contract is stamped. Apps published before the
 *  key existed carry no version and are read as this — they are the documents in Firestore now. */
export const BASE_PROTOCOL = "1.0.0";

/** `public.submit.<cid>.uidField` — the submitter's identity in a FIELD rather than in the document
 *  id, for the app whose id is spent on exclusivity (a claim whose id is the task's).
 *
 *  A MAJOR because the reader has to do something it was not doing: fill that field from the
 *  session and keep it out of the form, exactly as it already does for `emailField`. A reader that
 *  has not learnt it must refuse the app rather than draw a form that cannot be submitted — and
 *  refusing is what a major buys. */
export const UID_FIELD_PROTOCOL = "2.0.0";

/** The newest contract this build can emit — the ceiling an authored floor is checked against. */
export const APP_PROTOCOL = UID_FIELD_PROTOCOL;

/** The contract THIS declaration's documents keep.
 *
 *  Derived from what the declaration contains, never from what the author asked for: the stamp is
 *  a statement about the documents, and an author who names a floor they do not use has not made
 *  their app need a newer reader. */
export function protocolFor(app: { public?: { submit?: Record<string, { uidField?: string | undefined }> | undefined } | undefined }): string {
  const submits = Object.values(app.public?.submit ?? {});
  return submits.some((submit) => submit.uidField !== undefined) ? UID_FIELD_PROTOCOL : BASE_PROTOCOL;
}

const SHAPE = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/u;

export interface ProtocolVersion {
  major: number;
  minor: number;
  patch: number;
}

/** A version, or null when the text is not one. Null is never treated as 1.0.0 anywhere: an
 *  unreadable version is most likely a NEWER writer than whoever is reading, and guessing low is
 *  the direction in which every decision then goes wrong quietly. */
export function protocolOf(text: string): ProtocolVersion | null {
  const stated = SHAPE.exec(text);
  if (stated?.groups === undefined) return null;
  return { major: Number(stated.groups.major), minor: Number(stated.groups.minor), patch: Number(stated.groups.patch) };
}

/** Is `stated` no newer than `emitted`?
 *
 *  What the gate asks of an authored `protocol`: an app declaring a contract this compiler does not
 *  implement cannot be published by it — the projection would carry a version whose promises the
 *  documents do not keep, which is worse than refusing, because the reader would believe it. */
export function protocolWithin(stated: ProtocolVersion, emitted: ProtocolVersion): boolean {
  if (stated.major !== emitted.major) return stated.major < emitted.major;
  if (stated.minor !== emitted.minor) return stated.minor < emitted.minor;
  return stated.patch <= emitted.patch;
}
