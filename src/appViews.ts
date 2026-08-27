// The pages a published app shows, per AUDIENCE.
//
// One declaration (`views[]`), three audiences, and a different place to put
// each — because a Firestore rule cannot hide a field, so who may read a page
// is decided by which DOCUMENT it lands on:
//
//   public       apps/{aid}/config/*     allow read: if true
//   member       apps/{aid}/member/*     staffOf  — holds a role, anywhere
//   participant  apps/{aid}/roster/*     listedIn — on the roster at all
//
// Three things here are decisions rather than plumbing.
//
//   `views[]` REPLACES `public.view`, and the reason is timing rather than
//   vocabulary. Renaming a key an author has written is a migration the moment
//   one app publishes it; nothing has yet, so the generalisation is free
//   today and is not free next month. The old shape keeps parsing for one
//   release and normalizes into this one.
//
//   THE ID IS THE ADDRESS. `views[].id` becomes the document id `live:{id}` /
//   `live:{id}`, which is why it carries a grammar rather than merely being
//   unique: a `/` in it would address a different path, and a withdrawal would
//   then tidy somewhere else entirely.
//
//   THE DECLARATION IS PROJECTED PER TIER, not published once and read by
//   everyone. `apps/{aid}` is reader-only (a participant reading it would see
//   their classmates' addresses), so a participant's page cannot learn the
//   view's datasets, let alone the field its own row is found by. And a single
//   shared projection cannot serve both: handed the staff datasets, a
//   participant's page builds a query the rules refuse — it does not render
//   less, it fails.
import type { AuthoredApp, AuthoredMail, AuthoredSubmit } from "./publishManifest.js";
import { statusFieldOf } from "./statusField.js";
import type { ProjectedAgent } from "./appAgents.js";
import { byText } from "./byText.js";

/** The audiences a view may be written for. A CLOSED set: each one names a
 *  tier with a rule behind it, so an unknown value has nowhere to be
 *  published to and is refused before it gets there. */
export const VIEW_AUDIENCES = ["public", "member", "participant"] as const;
export type ViewAudience = (typeof VIEW_AUDIENCES)[number];

/** Where each audience's documents live under `apps/{aid}`. `public` is not
 *  here: it keeps `config/public` + `config/view`, which are already published
 *  and already read by a deployed runtime. */
export const VIEW_TIER: Readonly<Record<Exclude<ViewAudience, "public">, "member" | "roster">> = {
  member: "member",
  participant: "roster",
};

/** The id `public.view` normalizes to. Fixed rather than derived, so two
 *  implementations of the same normalization cannot pick different ones. */
export const PUBLIC_VIEW_ID = "public";

/** `config` is the projection's own document in every tier (`live:config`),
 *  so a view may not be called that — the two would be the same document. */
export const RESERVED_VIEW_IDS: readonly string[] = ["config"];

/** What an id may be.
 *
 *  Narrow on purpose: this value is written by the author, and it becomes a
 *  Firestore document id under a `live:` prefix. Excluding `:`
 *  keeps the prefix and the id from running together; excluding `/`, `.` and
 *  `__…__` keeps it a legal document id that addresses the path it says. */
export const VIEW_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VIEW_ID_SHAPE = "must be lowercase letters, digits and hyphens, start with a letter or digit, and be at most 64 characters (e.g. front-desk)";

/** A view as the author wrote it, once normalized: one shape, whichever of
 *  the two declarations it came from. `where` is the path it was written at,
 *  carried only so a refusal names the key the author can go and edit. */
/** Which field of an article is which. See `ViewZ.article`. */
export interface ArticleFields {
  title: string;
  body: string;
  /** `| undefined` explicitly, as everywhere else here: this repository builds with
   *  `exactOptionalPropertyTypes`, under which "absent" and "present and undefined" are different
   *  types — and the zod parse produces the second. */
  summary?: string | undefined;
  /** The field carrying who wrote it. A byline the author typed — see `ViewZ.article.byline` for
   *  why it cannot be the identity the rules hold. */
  byline?: string | undefined;
}

export interface NormalizedView {
  id: string;
  audience: ViewAudience;
  /** Absent exactly when `type` is present — see {@link NormalizedView.type}. */
  path?: string | undefined;
  /** A page the PLATFORM draws, instead of the author's HTML at `path`. */
  type?: "article" | undefined;
  /** Present with `type: "article"` and never without it. */
  article?: ArticleFields | undefined;
  collections: string[];
  /** The subset of `collections` this page WATCHES rather than reads once.
   *
   *  Absent, not empty, when the author declared nothing: a page that watches
   *  nothing and a page whose author never considered the question are the
   *  same page, and the projection of an app with no `live` must be byte-for-
   *  byte what it was before this key existed. */
  live?: string[];
  /** `{ <cid>: <rows> }` over a subset of `collections`: read only the LATEST
   *  `rows` records of that dataset. See `ViewZ.limit` for why it is the
   *  latest and never the first.
   *
   *  Absent, not empty, for the reason `live` is: an app that never declared
   *  one must project the document it projected before this key existed.
   *
   *  Only the `views[]` spelling carries it. `public.view` is the older
   *  spelling, kept parsing for one release and not extended — a key added to
   *  a declaration on its way out is one more shape to migrate. */
  limit?: Record<string, number>;
  where: string;
}

export type NormalizedViewsResult = { ok: true; views: NormalizedView[] } | { ok: false; problems: string[] };

/** Both declarations of the same thing, in one file.
 *
 *  Refused rather than merged or preferred: whichever way it were resolved,
 *  the author would have written two answers and been shown neither. */
const BOTH_FORMS =
  "app.json declares both `views` and `public.view`. These are the same thing — `public.view` is the older spelling — and publishing would have to choose one silently. " +
  'Move the `public.view` entry into `views` as { id: "public", audience: "public", … } and delete it.';

/** The two declarations, as one list, or the refusal that they are both there.
 *
 *  `public.view` becomes an entry under the reserved id, so everything
 *  downstream reads one shape and "which spelling was used" is decided once. */
function declaredViews(app: AuthoredApp): NormalizedViewsResult {
  const legacy = app.public?.view;
  const authored = app.views;
  if (legacy !== undefined && authored !== undefined) return { ok: false, problems: [BOTH_FORMS] };

  const views: NormalizedView[] = (authored ?? []).map((view, index): NormalizedView => ({
    id: view.id,
    audience: view.audience,
    ...(view.path === undefined ? {} : { path: view.path }),
    ...(view.type === undefined ? {} : { type: view.type }),
    ...(view.article === undefined ? {} : { article: view.article }),
    collections: view.collections,
    ...(view.live === undefined ? {} : { live: view.live }),
    ...(view.limit === undefined ? {} : { limit: view.limit }),
    where: `views[${index}]`,
  }));
  // Past here `views` is EMPTY: the pair is refused above, so a legacy entry
  // means nothing was authored under `views` at all. There is nothing to
  // collide with the reserved id, and the branch that checked for it could not
  // run — a refusal that never fires is one nobody can trust is right.
  if (legacy === undefined) return { ok: true, views };
  const legacyView: NormalizedView = {
    id: PUBLIC_VIEW_ID,
    audience: "public",
    path: legacy.path,
    collections: legacy.collections,
    ...(legacy.live === undefined ? {} : { live: legacy.live }),
    where: "public.view",
  };
  return { ok: true, views: [...views, legacyView] };
}

/** WHAT DRAWS THIS PAGE, and the four ways of not saying it.
 *
 *  A view is either HTML the author wrote (`path`) or a page the platform draws
 *  from the declaration (`type`). Neither leaves publish nothing to write;
 *  both leaves it two things and no way to choose, which — like the two
 *  spellings of `views` above — would be the author writing two answers and
 *  being shown neither.
 *
 *  `article` without `type` is the quiet one, and it is refused for the reason
 *  `idIn` beside the wrong `idFrom` is: nothing reads it there, so the author
 *  believes they have named the title field and the page they get is the
 *  generated form. */
function viewSourceProblems(view: NormalizedView): string[] {
  if (view.path !== undefined && view.type !== undefined) {
    return [
      `${view.where} declares both \`path\` and \`type\`: a view is either HTML you wrote or a page the platform draws, and publishing would have to ` +
        `choose one silently. Delete \`path\` to keep the ${view.type} page, or delete \`type\` to keep your own HTML.`,
    ];
  }
  if (view.path === undefined && view.type === undefined) {
    return [
      `${view.where} declares neither \`path\` nor \`type\`, so there is nothing to draw. Name the HTML file with \`path\`, or ask for \`"type": "article"\`.`,
    ];
  }
  if (view.type === "article" && view.article === undefined) {
    return [
      `${view.where} is \`"type": "article"\` but declares no \`article\` block, so nothing says which field is the title and which is the body. ` +
        `Add "article": { "title": "title", "body": "body" }.`,
    ];
  }
  if (view.type === undefined && view.article !== undefined) {
    return [
      `${view.where} declares an \`article\` block but no \`type\`: that block is read only by \`"type": "article"\`, so as written nothing names the ` +
        `title or the body and the page drawn is the generated form. Add \`"type": "article"\`, or delete the block.`,
    ];
  }
  return [];
}

/** An article view's collection: exactly one, because one page shows one
 *  running order.
 *
 *  `collections` is a LIST for the HTML case, where a page may draw from
 *  several — and an article page cannot: which of three collections held the
 *  article at `/a/{slug}/{id}` would have no answer, and the id could name a
 *  row in more than one of them. */
function articleCollectionProblems(view: NormalizedView): string[] {
  if (view.type === "article" && view.audience !== "public") {
    // The public face only, for now. The member and roster tiers draw their
    // pages through a different bridge with its own intents, and an article
    // page there would be a second reader to keep in step for an audience that
    // has not asked for one. Refused rather than half-published: publishing it
    // to a tier whose runtime ignores `type` would leave the staff looking at
    // an empty page.
    return [
      `${view.where} is \`"type": "article"\` with audience "${view.audience}". Platform-drawn pages are published for the PUBLIC face only; ` +
        `give this view \`"audience": "public"\`, or write the page yourself with \`path\`.`,
    ];
  }
  if (view.type !== "article" || view.collections.length === 1) return [];
  return [
    `${view.where} is \`"type": "article"\` and names ${view.collections.length} collections. An article page shows ONE running order, and an article's ` +
      `URL is \`/a/{slug}/{id}\` with nothing in it to say which collection the id is in. Name just the one that holds the articles.`,
  ];
}

/** Whether one id may be used, and what to say when it may not. */
function viewIdProblems(view: NormalizedView): string[] {
  if (RESERVED_VIEW_IDS.includes(view.id)) {
    return [`${view.where}.id is '${view.id}', which is reserved: each audience's own declaration is published at that document id.`];
  }
  if (!VIEW_ID_PATTERN.test(view.id)) {
    // The id becomes a document id, so this is not style. A `/` in it
    // addresses a different path — publish writes one place and a withdrawal
    // tidies another, and neither says anything.
    return [`${view.where}.id is '${view.id}': a view id ${VIEW_ID_SHAPE}. It becomes the document id this view is published at.`];
  }
  if (view.id === PUBLIC_VIEW_ID && view.audience !== "public") {
    return [`${view.where}.id is '${PUBLIC_VIEW_ID}' with audience '${view.audience}': that id belongs to the public page.`];
  }
  return [];
}

/** ONE public page per app, and the reason is the wire rather than taste.
 *
 *  The public runtime reads a single `config/view` document and a single
 *  `config/public.view` declaration beside it. A second `audience: "public"`
 *  entry would pass every other check and then be published nowhere — and
 *  which of the two became the live page would depend on declaration order,
 *  silently. The member tiers have no such limit: `id` is their address, and
 *  each one gets its own document.
 *
 *  The refusal is here rather than "one day we will support it" precisely
 *  because the failure is invisible: nothing errors, and the author sees a
 *  successful publish of a page nobody is served. */
function singlePublicProblems(views: NormalizedView[]): string[] {
  const [first, ...rest] = views.filter((view) => view.audience === "public");
  if (first === undefined) return [];
  return rest.map(
    (view) =>
      `${view.where} is a second audience "public" view, after ${first.where}. The public page is published at ONE document (config/view), so only one of ` +
      'them could ever be served — and which, would depend on the order they were written in. Give the others audience "member" or "participant", ' +
      "which are addressed by id and may have as many as the app needs.",
  );
}

/** The one shape everything downstream reads.
 *
 *  Every caller — the publish gate, the projection, the host that writes the
 *  documents — goes through this, so "which declaration was used" is decided
 *  exactly once. */
export function normalizeViews(app: AuthoredApp): NormalizedViewsResult {
  const declared = declaredViews(app);
  if (!declared.ok) return declared;
  const problems: string[] = [...singlePublicProblems(declared.views)];
  const seen = new Map<string, string>();
  for (const view of declared.views) {
    problems.push(...viewIdProblems(view), ...viewSourceProblems(view), ...articleCollectionProblems(view));
    const first = seen.get(view.id);
    if (first === undefined) {
      seen.set(view.id, view.where);
      continue;
    }
    problems.push(
      `${view.where}.id is '${view.id}', which ${first} already uses. The id is the document a view is published at, so two of them are one page — ` +
        "whichever was written second would silently replace the first.",
    );
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, views: declared.views };
}

/** How one audience reaches one collection's records.
 *
 *  The parent page builds the query from this; the view never touches
 *  Firestore. `own` is not a filter the rules apply for the reader — an
 *  unscoped `list` on an own-row collection is DENIED, not narrowed — so the
 *  scope has to travel with the declaration or the page fails. */
export interface ProjectedViewCollection {
  cid: string;
  scope: "all" | "own";
  /** `scope: "own"` — the field carrying the reader's verified address. */
  emailField?: string;
  /** `scope: "own"` — the field carrying the reader's uid. The same query as
   *  `emailField` against a different token claim, and the only one an app
   *  that never collects an address can be narrowed by. A reader that does not
   *  know this key sees `scope: "own"` with neither of the other two and must
   *  refuse the view rather than draw it unnarrowed. */
  uidField?: string;
  /** `scope: "own"` — the row is the document whose id is the reader's uid. */
  ownDocId?: "auth.uid";
  /** Read only the LATEST `rows` records, ordered by `field` DESCENDING.
   *
   *  Both halves or neither, and the reader is bound by both: `rows` without
   *  the order is a limit over Firestore's document-id ordering, which returns
   *  an arbitrary N and never delivers a new record — see `ViewZ.limit`. A
   *  reader that honours one and not the other is worse than one that honours
   *  neither, because the page it draws looks right.
   *
   *  A READER THAT DOES NOT KNOW THIS KEY reads the whole collection, exactly
   *  as it did before the key existed. That is a cost, not a permission: the
   *  rows were always readable by this audience, so an older host is expensive
   *  rather than wrong, and it is why adding this does not move
   *  `APP_PROTOCOL`.
   *
   *  Never projected onto `scope: "own"`. That query already carries a
   *  `where`, so ordering it needs a COMPOSITE INDEX that no deployment has —
   *  the read would fail rather than narrow. The gate refuses the pair
   *  (`viewLimitProblems`); this omits it, so a projection can never promise a
   *  read that errors. */
  limit?: { rows: number; field: string };
}

/** How a participant reaches `cid`, or null if they cannot.
 *
 *  Mirrors the rules' read branches for someone holding no role: `publicRead` (the collection is
 *  open to the world, so a participant reads it as anybody does), `partRead` (the whole collection,
 *  by `participantRead`) and `ownRow` (their own record, found by the submit declaration's
 *  `emailField` or `uidField`, or by a uid-derived id).
 *
 *  `uidField` is here because `ownRow` grants it — a projection that said "a participant cannot
 *  read this" about a row the rules hand over would be a bug in the projection, which is the one
 *  direction this file is not allowed to be wrong in.
 *
 *  The PUBLIC branch is not an afterthought: a booking app publishes its slots to the world and
 *  lists them again on the participant's own page, so leaving it out refuses the most ordinary
 *  declaration there is — and refuses it with "a participant cannot read this", about a collection
 *  every stranger can.
 *
 *  `participantRead` is a PARAMETER rather than read off the manifest, from when publish promoted
 *  a value the manifest could have moved past. Publish writes the manifest now, so the caller
 *  passes the manifest's own — but the signature stays: the SET IN FORCE is what decides, and
 *  making that explicit is what kept the two apart when they could differ. */
export function participantScope(app: AuthoredApp, cid: string, participantRead: readonly string[]): ProjectedViewCollection | null {
  if (participantRead.includes(cid)) return { cid, scope: "all" };
  if (app.public?.enabled === true && (app.public.read ?? []).includes(cid)) return { cid, scope: "all" };
  const submit: AuthoredSubmit | undefined = app.public?.submit?.[cid];
  if (submit?.emailField !== undefined) return { cid, scope: "own", emailField: submit.emailField };
  if (submit?.uidField !== undefined) return { cid, scope: "own", uidField: submit.uidField };
  if (submit?.idFrom === "auth.uid") return { cid, scope: "own", ownDocId: "auth.uid" };
  return null;
}

/** The LATEST-N cap this view declared for `cid`, as the projection carries
 *  it — or nothing, which is every collection an app never capped.
 *
 *  THE ORDER FIELD IS NOT THE AUTHOR'S TO CHOOSE. It is
 *  `public.submit[cid].stampField`, the one field the rules pin to the server
 *  clock on create and freeze afterwards, so every record has one and nobody
 *  can write themself to the top of the window. An author-named field would be
 *  neither: a record MISSING the ordered field is not sorted last by Firestore,
 *  it is excluded from the query entirely — a row that exists, that the page
 *  is entitled to, and that no query it issues will ever return.
 *
 *  Silent where it cannot be honoured (no cap declared, no stamp field, or an
 *  own-row scope). The gate refuses those declarations with an explanation;
 *  what must not happen is a PROJECTION that describes a read the host would
 *  be denied — see {@link ProjectedViewCollection.limit}. */
export function limitFor(app: AuthoredApp, view: NormalizedView, scope: ProjectedViewCollection): ProjectedViewCollection {
  // `Object.hasOwn` before the lookup, and it is not defensive habit: `constructor`, `toString`
  // and `hasOwnProperty` are all valid collection names (`isValidCollectionName`), so a plain
  // index into a map that does not mention this cid reaches Object.prototype and hands back a
  // FUNCTION. It would pass the gate — which reads the declared entries, not this lookup — and
  // then be projected as `limit: { rows: <function>, field: … }`, which Firestore cannot write.
  const rows = view.limit !== undefined && Object.hasOwn(view.limit, scope.cid) ? view.limit[scope.cid] : undefined;
  const field = app.public?.submit?.[scope.cid]?.stampField;
  if (rows === undefined || field === undefined || scope.scope === "own") return scope;
  return { ...scope, limit: { rows, field } };
}

/** The declaration as one non-public audience may see it — the document
 *  published at `apps/{aid}/{tier}/live:config`.
 *
 *  The roster is NOT here, and neither is anything about another member: this
 *  is read by everyone the tier admits, which for `roster` includes every
 *  participant. */
export interface AppViewConfigDoc extends Record<string, unknown> {
  /** The version of the publish contract these documents keep — see `appProtocol.ts`. */
  protocol: string;
  name?: string;
  views: { id: string; collections: ProjectedViewCollection[]; live?: string[] }[];
  /** The submit declarations for the collections these views draw, so the page
   *  can show what may be sent rather than discovering it from a denial. */
  submit: Record<string, Record<string, unknown>>;
  /** What this audience may CHANGE about those collections — see
   *  {@link writeFor}. One entry per collection that has anything writable, in
   *  the order the views declare them; absent entries mean "read only", which
   *  is what a page with no buttons is drawn from. */
  write: ProjectedViewWrite[];
  /** The publisher's STANDING INSTRUCTIONS for whoever sits at this app as this
   *  audience — see `appAgents.ts`. Absent when the app declared none for this
   *  tier, which is every app published before the key existed: silence means
   *  "no published duty", never "invent one".
   *
   *  It rides on the tier config rather than on a document of its own for the
   *  reason everything else here does: the reader has already obtained this
   *  document by being admitted to the tier, so the brief is readable by
   *  exactly the audience it is addressed to and by nobody else. */
  agents?: ProjectedAgent[];
  publishedAt: number;
}

/** The document id one view is written at. The `live:` prefix and the id are
 *  separated by `:`, which the declared id grammar excludes, so the two never
 *  run together — and a single `match` covers the projection and every view.
 *
 *  The prefix outlived what it distinguished: there was a `staged:` set beside
 *  it, written by deploy and read at `/staging/{aid}`. It STAYS, because every
 *  published app on disk carries these ids and dropping the prefix would make
 *  their pages unreadable for the sake of five characters. */
export const viewDocId = (viewId: string): string => `live:${viewId}`;
export const VIEW_CONFIG_ID = "config";

// ---------------------------------------------------------------------------
// What an audience may CHANGE
//
// mulmoterminal plans/feat-shared-app-member-write.md. The rules already allow
// every write below — `isWriter`, the assignee branch, `ownRow` + `selfWriteOk`
// — so nothing here grants anything. What it does is tell the page which
// buttons exist, and let the parent name a refusal the rules would answer with
// a bare permission error.
//
// THE VOCABULARY IS CLOSED: a transition moves one declared status field, an
// assignment moves one declared assignee field, a withdrawal takes a row away,
// and a correction rewrites the fields the declaration names — and there is no
// fifth thing. A general patch would be no less safe (the rules bind either
// way) and two things worse: a bug in the page reaches as far as the member's
// role does, and nothing above can say what happened.
//
// The correction is the one that carries field names, so what bounds it is
// everything this file projects for it: `selfUpdate` and the roles for who may,
// `frozen` for what nobody may touch once the record exists, `maxBytes` for how
// long a value may be — and the two fields the other asks own, which a
// correction may never name (`view/intent.ts` refuses them for every reader,
// because reaching them here would go round the transition table and the
// assignee check).
//
// AND IT IS PROJECTED PER TIER, because "which transitions" is a different
// question for each audience. Staff move `pending → approved`
// (`collections[cid].transitions`); the person who booked moves
// `pending → cancelled` (`public.submit[cid].selfTransitions`). Publishing one
// table to both draws an approve button on a participant's page that the rules
// refuse when pressed — declaration and enforcement disagreeing, which is the
// one failure this whole mechanism exists to prevent.

/** What one audience may change about one collection.
 *
 *  An entry exists only where something is actually writable; a collection a
 *  tier may only read is absent rather than present and empty. */
export interface ProjectedViewWrite {
  cid: string;
  /** The field a transition moves. Without it there are no transitions. */
  statusField?: string;
  /** `{ <current status>: [<status>...] }`, for THIS audience. */
  transitions?: Record<string, string[]>;
  /** The field naming the member a row belongs to. `member` tier only. */
  assigneeField?: string;
  /** Who may write EVERY row here — the `owner` / `editor` holders. `member`
   *  tier only, and it is what makes the tier's one shared document honest:
   *  see {@link writersOf}. */
  writers?: string[];
  /** Who may write only the rows ASSIGNED to them — the `assignee` holders.
   *  Present with `assigneeField`, since without one the role grants nothing.
   *
   *  The assignment CANDIDATES are these two lists together, and are left to
   *  be derived rather than published a third time: a separate list would be
   *  one more thing that can disagree with the two the rules actually read. */
  rowWriters?: string[];
  /** `member` tier only: the rules let only a writer (or the row's own
   *  assignee) queue mail, so a participant handed this could only be refused. */
  mail?: AuthoredMail;
  /** The statuses a submitter may DELETE their own row from
   *  (`public.submit[cid].selfDelete`). `roster` tier only: the rules answer a
   *  withdrawal from the RECORD, and staff already delete by role.
   *
   *  It rides beside `transitions` rather than inside it because it is not a
   *  move — there is no `to`. A page reading it draws "withdraw" where the
   *  transitions draw "cancel", and the difference the reader is being asked
   *  about is real: the row is gone afterwards, and with `mirror` the slot is
   *  back on the grid. */
  selfDelete?: string[];
  /** `{ <current status>: [<field>...] }` — the fields a SUBMITTER may edit in
   *  their own row while it holds that status (`public.submit[cid].selfUpdate`).
   *
   *  ON EVERY TIER, including `member`, and that is the same answer `selfDelete`
   *  gives one field above. `ownRow` + `selfWriteOk` in the rules compare the
   *  caller's address against the record and never ask which tier the reader was
   *  standing on — so a `viewer`, an `assignee`, or a member of a collection no
   *  role writes may correct a row they submitted, exactly as they may withdraw
   *  one. Dropping it here took that away from precisely the people who had no
   *  other permission, and where nothing else was writable it made `writeFor`
   *  return null and the collection vanish from the projection entirely.
   *
   *  The reader who does NOT get it is the WRITER, and that narrowing belongs
   *  one layer down (`correctable` in `view/capability.ts`): `isWriter` carries
   *  no status condition and no field list, so a map handed to them would
   *  describe a restriction the rules do not apply. Per READER, not per tier.
   *
   *  It is a MAP and not a list for the reason `transitions` is: "may edit
   *  while pending" and "may edit after the desk approved it" are different
   *  promises, and a collection that flattened them would offer a control that
   *  works on some rows and is refused on others.
   *
   *  Rides with `statusField`, like `selfDelete` above and for the identical
   *  reason: the rules read the CURRENT status off the record before consulting
   *  the map, so a projection without the field describes an edit nobody can
   *  perform. */
  selfUpdate?: Record<string, string[]>;
  /** The statuses NO ONE may delete a row from (`collections[cid].sealed`).
   *
   *  It travels for BOTH halves of a withdrawal and for BOTH tiers, which none
   *  of the neighbours do, because it is not a permission — it is a property of
   *  the RECORD. `writerDelete` says a writer may remove any row and the rules
   *  agree, right up until the row is in a sealed status, where `sealedNow`
   *  refuses it whoever asked. A projection without this hands the page a
   *  control that is drawn on every row and fails on some of them, which is
   *  precisely the declaration-and-enforcement disagreement the projection
   *  exists to stop.
   *
   *  Rides with `statusField` for the same reason `selfDelete` does: the rules
   *  read the current status off the record before consulting the list. */
  sealed?: string[];
  /** A writer may delete ANY row here (`collections[cid].writerDelete`).
   *  `member` tier only, and the counterpart of `selfDelete` rather than a
   *  variant of it: that one names the statuses a SUBMITTER may take their own
   *  row away from and the rules read the list; this one is the role branch,
   *  which the rules answer with `isWriter` and no status at all.
   *
   *  Which is why it is a flag and not a list. A page told "these statuses" for
   *  a check the rules do not make would hide a button the rules would have
   *  allowed, and the reader has no way to find that out.
   *
   *  WHO the writers are is `writers` beside it — the capability resolves the
   *  two together, so a `viewer` on the same tier is offered nothing. */
  writerDelete?: boolean;
  /** The projection collection the withdrawal must reopen IN THE SAME BATCH
   *  (`public.submit[cid].mirror`). Rides with `selfDelete` and only with it:
   *  the rules refuse a delete that leaves the mirror saying `taken`, so a page
   *  handed the permission and not the collection name can only ever produce a
   *  refusal. Absent when the app declares no mirror, which is the ordinary
   *  case for anything that is not a contested slot. */
  withdrawMirror?: string;
  /** The fields NO ONE may write once the record exists — the values the rules
   *  DERIVED an identity from and froze for the life of the row: the stamp
   *  (`stampHeld`), the field an id was built out of (`idHeld`) and the uid
   *  (`uidHeld`).
   *
   *  It rides with the correction for the reason `sealed` rides with the
   *  withdrawal: it is not a permission and narrows BOTH halves. A writer may
   *  rewrite any field their role reaches — and `publishedAt` is not one of
   *  them, whoever asks. A page that sends it gets a bare permission denial
   *  naming no field, which is the one outcome this layer exists to prevent.
   *
   *  Absent where the declaration froze nothing, which is one `includes` never
   *  reached rather than a special case. */
  frozen?: string[];
  /** The per-field byte caps the app declared (`public.submit[cid].maxBytes`).
   *
   *  THE RULES DO NOT CARRY THIS ONE, and that is what makes projecting it
   *  necessary rather than convenient. `maxBytes` appears nowhere in
   *  `firestore.rules` — the cap is charged at publish, where `limit x total`
   *  can be computed from the declaration alone, and held afterwards by
   *  whoever writes. The public submit path holds it because `SubmitSpec`
   *  carries it; a correction is the OTHER write of the same field, and a cap
   *  a second write escapes is not a cap.
   *
   *  So this is the only key here that is not a description of something the
   *  rules already enforce. Every other entry narrows a page to what the rules
   *  would allow; this one is the enforcement. */
  maxBytes?: Record<string, number>;
}

/** The role a member holds on one collection, by the rules' own resolution:
 *  the per-collection entry, else the `*` fallback, else none. */
function roleOn(app: AuthoredApp, address: string, cid: string): string | undefined {
  const held = app.members[address];
  if (held === undefined) return undefined;
  return held[cid] ?? held["*"];
}

/** The addresses holding one of `roles` on `cid`.
 *
 *  Sorted, for the same reason `memberEmails` is: a second publish of an
 *  unchanged declaration must produce an unchanged document. */
function holdersOf(app: AuthoredApp, cid: string, roles: readonly string[]): string[] {
  return Object.keys(app.members)
    .filter((address) => roles.includes(roleOn(app, address, cid) ?? ""))
    .sort(byText);
}

/** Who may write every row of `cid`, and who may write only their own.
 *
 *  WHY ADDRESSES ARE PUBLISHED AT ALL. One `member/config` document is read by
 *  everyone the tier admits, and the tier only establishes that somebody holds
 *  SOME role SOMEWHERE — so a `viewer`, or a stylist scoped to another
 *  collection, reads the same entry as the front desk. Without these lists the
 *  page would draw approve and reassign for all of them and the rules would
 *  refuse when pressed, which is the declaration/enforcement mismatch this
 *  whole mechanism exists to prevent.
 *
 *  It cannot be answered per principal instead: the document is written once
 *  at publish and read by many, and the reader cannot look their own role up —
 *  `apps/{aid}` is `readerOf(a, '*')`, and a stylist carrying only
 *  `{bookings: "editor"}` holds no `*` role. So the ROSTER'S ANSWER travels
 *  with the declaration and the page compares its own address to it.
 *
 *  The cost is that staff addresses are visible to staff. That is already true
 *  of the approval mail they send each other, and participants read the
 *  `roster` tier, which never carries these.
 *
 *  A SNAPSHOT, like everything else published: a member added since the last
 *  publish is absent until the next one. The rules are the authority either
 *  way — this only decides which buttons are drawn.
 *
 *  EXPORTED for `publishChecks`, which refuses a `writerDelete` that names a
 *  role nobody holds. One reading of "who is a writer here", so the check and
 *  the projection cannot disagree about the app they are both looking at. */
export function writersOf(app: AuthoredApp, cid: string): string[] {
  return holdersOf(app, cid, ["owner", "editor"]);
}

/** The transition half: which table applies, and the field it moves.
 *
 *  Both halves or neither. A status field with no table would offer every
 *  value; a table with no field has nothing to write it to. */
function transitionPart(app: AuthoredApp, audience: ViewAudience, cid: string): Partial<ProjectedViewWrite> {
  const config = app.collections?.[cid];
  const transitions = audience === "member" ? config?.transitions : app.public?.submit?.[cid]?.selfTransitions;
  const statusField = statusFieldOf(config);
  if (config === undefined || statusField === undefined || transitions === undefined) return {};
  const part: Partial<ProjectedViewWrite> = { statusField, transitions };
  // The rules let only a writer (or the row's own assignee) queue mail, so a
  // participant handed this could only ever be refused.
  if (audience === "member" && config.mail !== undefined) part.mail = config.mail;
  return part;
}

/** The assignment half. `member` only — see {@link writersOf}.
 *
 *  `rowWriters` rides here rather than beside `writers`, because the
 *  `assignee` role grants nothing at all without a field to compare against
 *  (`isAssigned` in the rules requires one, and publish refuses the pair). */
/** The withdrawal half. `roster` only, and only where the collection has a
 *  status field to read it against — the rules take the CURRENT status off the
 *  record before consulting the list, so a collection without one grants
 *  nothing however the key is written (publish refuses that pair). */
/** The mirror a delete has to reopen in the same batch, wherever the delete
 *  comes from.
 *
 *  It rides with BOTH halves below, and it has to: `deleteWith` asks
 *  `mirrorReleased` before it asks who is deleting, so a staff page handed the
 *  permission and not the collection name can only ever produce a refusal — the
 *  same trap the participant's half documents. */
function withdrawMirrorPart(app: AuthoredApp, cid: string): Partial<ProjectedViewWrite> {
  const mirror = app.public?.submit?.[cid]?.mirror;
  return mirror === undefined ? {} : { withdrawMirror: mirror };
}

/** What may take a row of `cid` away, for this audience.
 *
 *  TWO DIFFERENT PERMISSIONS, and they are not two spellings of one. The staff
 *  half is a ROLE (`isWriter`, any row, any status); the participant's half is
 *  the RECORD (`ownRow` plus the statuses `selfDelete` names, which the rules
 *  read). So they are projected from different declarations to different tiers,
 *  and neither is inferred from the other.
 *
 *  The staff half was missing entirely until now, and its absence did not read
 *  as one: `withdrawFrom` came back empty on a member's page exactly as it does
 *  for a collection nobody may delete from, so the answer to "the owner cannot
 *  delete here" was "declare it somewhere else" — which meant moving the page
 *  to `participant` and giving up assignment, the staff transitions and the
 *  roster's answer about who is who.
 *
 *  A MEMBER GETS THE PARTICIPANT'S HALF TOO, where the collection declares no
 *  staff one. It reads like a tier violation and it is not: `ownRow` in
 *  `firestore.rules` asks `authed()` and compares `emailField` — it never asks
 *  what tier the reader is standing on — so a member who SUBMITTED a row has
 *  always been allowed to withdraw it. What was missing was any way to say so.
 *  Projecting nothing here made `writeFor` return null for the whole
 *  collection, and a page asking got `unknown-collection`: not "you may not",
 *  but "there is no such collection", about one it was reading from.
 *
 *  That is the shape of a members-only app whose records are BOUND to their
 *  submitter — a group chat, an anonymous suggestion box, minutes each member
 *  files for themself. `submitOnly` + `emailField` is what binds them, and it
 *  is exactly what leaves the member tier with no role-based write to project.
 *
 *  BOTH DECLARATIONS TRAVEL, and the reader is what chooses between them.
 *  `writerDelete` is a property of the COLLECTION; being a writer is a property
 *  of the PERSON. Emitting only the staff half took the submitter's own delete
 *  away from every `viewer` and `assignee` on a board that also let staff
 *  delete — while the rules read `isWriter(r) || selfDelete(...)`, which grants
 *  it. `capabilityOf` makes the choice per reader; this only carries them.
 *
 *  `statusField` RIDES WITH `selfDelete` and not only with the transition
 *  table. The rules read the CURRENT status off the record before consulting
 *  the list, so a projection without it describes a withdrawal nobody can
 *  perform — and a collection that is posted and deleted, never moved, declares
 *  no transitions at all and so used to lose the field. That is the whole of
 *  the group-chat case: `withdrawPart` emitted `selfDelete`, and the reader got
 *  a document the capability could make nothing of. */
function withdrawPart(app: AuthoredApp, audience: ViewAudience, cid: string): Partial<ProjectedViewWrite> {
  const config = app.collections?.[cid];
  const byRole = audience === "member" && config?.writerDelete === true ? { writerDelete: true } : {};
  const selfDelete = app.public?.submit?.[cid]?.selfDelete;
  const statusField = statusFieldOf(config);
  const own = selfDelete !== undefined && statusField !== undefined ? { selfDelete, statusField } : {};
  if (Object.keys(byRole).length === 0 && Object.keys(own).length === 0) return {};
  // The seal is not one of the two halves — it overrides both — so it is added
  // after the "is there anything to project?" test rather than counting
  // towards it. A collection that seals every status and grants no delete
  // still projects nothing, which is correct: there is no control to draw.
  const sealed = config?.sealed !== undefined && statusField !== undefined ? { sealed: config.sealed, statusField } : {};
  return { ...byRole, ...own, ...sealed, ...withdrawMirrorPart(app, cid) };
}

/** The fields a submitter may correct in their own row, per status.
 *
 *  The counterpart of `withdrawPart`'s `selfDelete` half, and projected on exactly the same terms
 *  — which is to say WITHOUT ASKING THE AUDIENCE. That half does not either, and for the reason
 *  the rules give: `ownRow` compares the caller's address against the record, so it answers the
 *  same for a participant and for a `viewer` who happens to hold a role elsewhere in the app.
 *  Narrowing it here by tier took the correction away from every member who submitted something,
 *  and where the collection had nothing else writable it made `writeFor` return null — so the
 *  collection left the projection altogether and the page could draw no control at all.
 *
 *  The narrowing that IS right is per reader and lives in `correctable` (`view/capability.ts`): a
 *  writer gets an empty map, because `isWriter` carries no status condition and no field list.
 *
 *  WHY IT IS PROJECTED AT ALL, when nothing drew a control from it before: `useSharedApp update`
 *  in MulmoTerminal is an agent correcting a record as the person who submitted it, and without
 *  this it has no way to know which fields that is — so it would either send everything and be
 *  refused with a bare permission error, or send nothing. The rules already carry the branch
 *  (`selfWriteOk`); this only says what it is. */
function correctPart(app: AuthoredApp, cid: string): Partial<ProjectedViewWrite> {
  const selfUpdate = app.public?.submit?.[cid]?.selfUpdate;
  const statusField = statusFieldOf(app.collections?.[cid]);
  if (selfUpdate === undefined || statusField === undefined) return {};
  return { selfUpdate, statusField };
}

/** The submit block this collection's corrections are judged by, or undefined.
 *
 *  `Object.hasOwn` before the lookup, for the reason `limitFor` gives above: a collection name is
 *  something an AUTHOR wrote, and `constructor` is a legal one. */
function submitOf(app: AuthoredApp, cid: string): AuthoredSubmit | undefined {
  const submit = app.public?.submit;
  if (submit === undefined || !Object.hasOwn(submit, cid)) return undefined;
  return submit[cid];
}

/** The fields the rules freeze for the life of the record.
 *
 *  Three, and each of them is a value a rule DERIVED a decision from on create: the server clock
 *  a queue is ranked by (`stampHeld`), the field the document id was built out of (`idHeld` —
 *  and only under the two id modes that read a field), and the uid that says whose row it is
 *  (`uidHeld`). Frozen means frozen: the owner is refused too.
 *
 *  Read off the SUBMIT block rather than the collection, because that is where the rules read
 *  them — `sub(a, cid)` — and a projection derived from somewhere else would be describing a
 *  different document than the one being enforced. */
function frozenFields(submit: AuthoredSubmit): string[] {
  const built = submit.idFrom === "field" || submit.idFrom === "slug" ? submit.idField : undefined;
  return [submit.stampField, built, submit.uidField].filter((field): field is string => typeof field === "string" && field !== "");
}

/** What a correction may NOT touch, and how long its values may be.
 *
 *  Both halves narrow a correction without granting one, and neither is about who is asking —
 *  which is why they are attached in `writeFor` AFTER the "is anything writable here?" test rather
 *  than counting towards it. A collection whose only declared key were a byte cap has no control
 *  to draw; letting these decide the question would put it into the projection, and a page asking
 *  about it would stop getting `unknown-collection` and start getting a refusal that implies there
 *  was something there to refuse.
 *
 *  `maxBytes` is the one key in the whole projection that the rules do NOT also enforce — see
 *  {@link ProjectedViewWrite.maxBytes}. */
function correctCapsPart(app: AuthoredApp, cid: string): Partial<ProjectedViewWrite> {
  const submit = submitOf(app, cid);
  if (submit === undefined) return {};
  const frozen = frozenFields(submit);
  return {
    ...(frozen.length === 0 ? {} : { frozen }),
    ...(submit.maxBytes === undefined ? {} : { maxBytes: submit.maxBytes }),
  };
}

function assignPart(app: AuthoredApp, audience: ViewAudience, cid: string): Partial<ProjectedViewWrite> {
  const assigneeField = app.collections?.[cid]?.assigneeField;
  if (audience !== "member" || assigneeField === undefined) return {};
  return { assigneeField, rowWriters: holdersOf(app, cid, ["assignee"]) };
}

/** Does the DECLARATION say anything about changing `cid` from this audience?
 *
 *  `writeFor` answers a wider question — it keeps an entry alive for the blanket "a writer may
 *  rewrite any record here", which is true of every collection in every app and therefore
 *  distinguishes nothing. This is the narrow one, and it is what a check about the AUTHOR's
 *  declaration wants: is there a transition, an assignment, a withdrawal, a correction the
 *  submitter may make.
 *
 *  Exported for `publishChecks`, which refuses an agent's duty over collections its audience can do
 *  nothing to. Asking `writeFor` there would have made every duty actionable the moment the
 *  correction landed — the owner can always rewrite a row — and a gate that never fires is one
 *  nobody can trust is right. */
export function declaresMoves(app: AuthoredApp, audience: ViewAudience, cid: string): boolean {
  const write: ProjectedViewWrite = {
    cid,
    ...transitionPart(app, audience, cid),
    ...assignPart(app, audience, cid),
    ...withdrawPart(app, audience, cid),
    ...correctPart(app, cid),
  };
  return Object.keys(write).length > 1;
}

/** What `audience` may change about `cid`, or null when the answer is nothing.
 *
 *  The audiences differ in WHICH transition table applies, in whether
 *  assignment exists at all, and in whether the roster's answer travels with
 *  it; they agree that the status field is the collection's, since the rules
 *  read one field either way.
 *
 *  `public` AND `participant` ARE THE SAME ANSWER, and that is a statement about the rules rather
 *  than a shortcut here. Both are `ownRow` in `firestore.rules` — which asks for `authed()` and
 *  nothing else: no role, no tier, an anonymous uid will do — and both read their moves out of
 *  `public.submit[cid]` (`selfTransitions`, `selfDelete`). So the visitor on `/a` who booked a slot
 *  and the participant on `/p` who booked the same slot may do exactly the same things to it, and
 *  projecting for one and not the other is how the public page ended up unable to offer a
 *  cancellation the rules would have allowed. The page could ask; nothing could answer.
 *
 *  What `public` never gets is the staff half — no `writers`, no assignment — for the same reason
 *  `participant` does not. */
export function writeFor(app: AuthoredApp, audience: ViewAudience, cid: string): ProjectedViewWrite | null {
  const write: ProjectedViewWrite = {
    cid,
    ...transitionPart(app, audience, cid),
    ...assignPart(app, audience, cid),
    ...withdrawPart(app, audience, cid),
    ...correctPart(app, cid),
  };
  // Only the staff tier: a participant writes their own row, which the rules
  // answer from the record rather than from a role, and publishing the roster's
  // writers to them would be an address list for nothing.
  const writers = audience === "member" ? writersOf(app, cid) : [];
  // HAVING WRITERS IS ITSELF A CONTROL, and this is the half that is easy to
  // lose. `updateWith` in the rules has `isWriter(r)` beside the submitter's
  // branch, carrying no status condition and no field list — so a writer may
  // rewrite any field of any row HERE even where the declaration says nothing
  // else about this collection. That is the ordinary blog exactly: no
  // transitions, no assignment, no `selfUpdate`, because nobody but the author
  // writes there. Dropped for having one key, the collection leaves the
  // projection, `capabilityOf` never sees a `writers` list to resolve
  // `correctAny` from, and the page's own `correct()` comes back
  // `unknown-collection` about a row the rules would let the owner rewrite.
  //
  // `writerDelete` is the same shape and was given the same treatment for the
  // same reason (see `withdrawPart`): a collection whose only writable thing is
  // the writer's own permission still gets an entry.
  if (Object.keys(write).length === 1 && writers.length === 0) return null;
  if (audience === "member") write.writers = writers;
  Object.assign(write, correctCapsPart(app, cid));
  return write;
}
