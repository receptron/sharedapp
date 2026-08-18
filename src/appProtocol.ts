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

/** The contract this build of the compiler writes. */
export const APP_PROTOCOL = "1.0.0";

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
