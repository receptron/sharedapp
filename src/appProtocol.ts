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
 *  It started as one constant — what this build writes — and stamping every app the newest number
 *  is a claim about documents that is not true of them: an app using nothing new is a 1.0.0 app,
 *  and republishing it must not change what it says it is. So the stamp is derived from the
 *  DECLARATION ({@link protocolFor}), and {@link APP_PROTOCOL} is only the ceiling of what this
 *  build could emit.
 *
 *  It matters most for a number a reader acts on. A reader compares the MAJOR and nothing else
 *  (mulmoserver's `protocolDrawable`), so a major is the one thing in a document that can make an
 *  older browser refuse it — and per-app stamping is what keeps that refusal aimed at the apps that
 *  need it rather than at every app published after the bump. Nothing needs one yet: see
 *  {@link UID_FIELD_PROTOCOL} for the addition that came close and why it did not. */

/** What an app using nothing newer than the first contract is stamped. Apps published before the
 *  key existed carry no version and are read as this — they are the documents in Firestore now. */
export const BASE_PROTOCOL = "1.0.0";

/** `public.submit.<cid>.uidField` — the submitter's identity in a FIELD rather than in the document
 *  id, for the app whose id is spent on exclusivity (a claim whose id is the task's).
 *
 *  A MINOR, and it was very nearly a major. The reader does have to do something it was not doing —
 *  fill the field from the session and keep it out of the drawn form, as it already does for
 *  `emailField` — so the question was what happens on a build that does neither. A major would make
 *  that build refuse the app. It turns out one already does, through a check it has shipped since
 *  the first contract:
 *
 *    - the rules accept only `request.resource.data.keys().hasOnly(createFields)`, so the uid field
 *      is IN `createFields` for any create to be possible at all;
 *    - the whole point of the key is that the field is not drawn, so it is NOT in the projected
 *      `form.fields`, and the host keeps the collection's form entry even when that leaves it empty;
 *    - and an old reader's `consistent`/`agrees` requires every `createFields` name it does not
 *      recognise as host-filled (it knows three: email, status, stamp) to appear in `form.fields`.
 *
 *  So the public projection of a uid-bearing app is refused as "a shape this release does not read"
 *  — the same screen a major buys, from a check that predates it. Measured against the real
 *  projection of the todo-board template, not reasoned about.
 *
 *  What the major would additionally have covered is the member/participant tiers, whose config
 *  carries `submit` and no `form` and so has nothing to disagree with. An old build draws those
 *  pages, and every uid-bound write is refused by `uidOk`/`uidHeld` and every own-scope read by the
 *  rules that expect the `where` this build now adds — buttons that do nothing, for the enrolled
 *  few, with no forged uid and nothing leaked. Not worth spending the major on.
 *
 *  The number is still load-bearing in exactly one place, which is why this is a minor rather than
 *  nothing: it is the floor an author declares, and `protocolProblems` refuses to publish a floor
 *  above what the build emits. That is what stops an OLD PUBLISHER from silently dropping the key
 *  and shipping a board where `uid` is an ordinary field anyone may write. */
export const UID_FIELD_PROTOCOL = "1.1.0";

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
