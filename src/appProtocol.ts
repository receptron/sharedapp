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

/** WHAT THIS BUILD STAMPS ON EVERY PROJECTION, and what a document carrying no `protocol` is read
 *  as — apps published before the key existed are exactly that, and those are the documents in
 *  Firestore now.
 *
 *  ONE constant, and `uidField` is the reason that is worth a note: it went out as a per-app version
 *  (1.0.0 for apps without it, 2.0.0 and then 1.1.0 for apps with it) and came back, because nothing
 *  anywhere reads the difference.
 *
 *  Four things could have. None do:
 *
 *    - THE READER'S GATE compares the MAJOR and nothing else (mulmoserver's `protocolDrawable`), so
 *      any minor is a number it does not act on.
 *    - A READER'S BEHAVIOUR SWITCH (`protocolAtLeast`) would, and there is not one. The guard is
 *      deliberately in place before the day it is needed, but no branch asks it anything yet.
 *    - THE AUTHORED FLOOR is checked by {@link protocolProblems}, which never runs for a key this
 *      build does not know: `SubmitZ` is `.strict()`, so an older build refuses `uidField` at the
 *      schema, earlier and more clearly than a version comparison would. Measured on the build
 *      before the key landed — "Unrecognized key" with the floor declared and without it, the same
 *      message both times.
 *    - A HUMAN OR A DIAGNOSTIC reading the published document — which carries `submit.<cid>.uidField`
 *      itself, three lines from the stamp. A number derived from the declaration, published beside
 *      the declaration, carries no information at all.
 *
 *  So a key ADDED to the contract does not move this number, and the strict schema is what makes
 *  that safe: a build handed a key it has never heard of stops, rather than dropping it.
 *
 *  WHAT WOULD MOVE IT is a change no schema can see — an existing key whose MEANING moves (the
 *  written shape of a `stampField`, say). Nothing is unrecognised there, so the version is the only
 *  handle: the author names the contract they wrote against, {@link protocolProblems} refuses to
 *  publish a floor this build cannot honour, and if the reader must understand it, the major goes
 *  up and older readers refuse the app. That day the stamp becomes per-app again, so that the
 *  refusal lands on the apps that need it rather than on everything published afterwards. */
export const APP_PROTOCOL = "2.0.0";

/** The contract MOST apps are still stamped with, and the one every deployed reader knows.
 *
 *  Named rather than written as a literal at the two stamp sites, because what it means is not
 *  "one" — it is "the contract before article views existed", which is what an app that does not
 *  use them still keeps. */
export const APP_PROTOCOL_BASE = "1.0.0";

/** THE CONTRACT THIS APP'S DOCUMENTS KEEP — which is not always the newest one this build can emit.
 *
 *  The per-app stamp is back, and this is the day `APP_PROTOCOL`'s note above said it would be. An
 *  ARTICLE DECLARATION is the first key a reader must UNDERSTAND to be correct rather than one it
 *  may safely ignore: `views[].article` turns on a second address under the app's public entrance,
 *  `/a/{slug}/{id}`, and a reader that does not know it draws the app's index there instead. Every
 *  link ever shared to an article lands on the wrong page. Nothing errors.
 *
 *  It used to be worse, and the note is kept because the difference is the whole reason the platform
 *  gave the index back: while `views[].type` REPLACED the HTML a public page was drawn from, an
 *  unknowing reader found no HTML at all, concluded the app published no view, and drew the
 *  GENERATED FORM in a magazine's place — the visitor was shown a different app.
 *
 *  So the major goes up — and it goes up ONLY FOR THE APPS THAT USE IT. Stamping every app 2.0.0
 *  would make every deployed reader refuse every app published after this build, including the ones
 *  whose documents did not change in any way. That is the failure `APP_PROTOCOL`'s own note is
 *  warning about, and it is why this function exists instead of a bumped constant.
 *
 *  The consequence for an author is stated plainly by publish: declare an article view and readers
 *  older than this contract refuse the app — they show "this build cannot draw what it published"
 *  rather than half of it. That is the intended outcome, and it is why the READER SHIPS FIRST. */
export function protocolFor(app: {
  views?: readonly { article?: unknown }[] | undefined;
  public?: { submit?: Record<string, { idFrom?: string | undefined } | undefined> | undefined } | undefined;
}): string {
  // A page the reader must know how to DRAW. `article` rather than the `type` this clause was
  // written for: the platform no longer draws the INDEX, so an unknowing reader finds the app's own
  // HTML at `/a/{slug}` and draws it — what it gets wrong is `/a/{slug}/{id}`, where every shared
  // link lands on that index instead of the article it names.
  const drawnHere = (app.views ?? []).some((view) => view.article !== undefined);
  // And an id the reader must know how to BUILD, which is the half that is easy to miss because it
  // is nowhere near a view. `recordId` in an older reader has no `slug` branch, so it falls through
  // to the random uuid it uses for `idFrom: "auto"` — while the deployed rules now require the
  // document id to EQUAL the submitted field. Every submission is then refused with a bare
  // permission error, on a page that drew itself perfectly.
  //
  // The two are independent: an app may name its records by slug and still publish its own HTML,
  // or publish an article index over records with generated ids. So this asks both rather than
  // making one imply the other — and publish does NOT require an article view beside a slug id,
  // which would couple two features that have no reason to travel together.
  const namedBySlug = Object.values(app.public?.submit ?? {}).some((submit) => submit?.idFrom === "slug");
  return drawnHere || namedBySlug ? APP_PROTOCOL : APP_PROTOCOL_BASE;
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
