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
//   `staged:{id}`, which is why it carries a grammar rather than merely being
//   unique: a `/` in it would address a different path, and staging and
//   withdrawal would then tidy somewhere else entirely.
//
//   THE DECLARATION IS PROJECTED PER TIER, not published once and read by
//   everyone. `apps/{aid}` is reader-only (a participant reading it would see
//   their classmates' addresses), so a participant's page cannot learn the
//   view's datasets, let alone the field its own row is found by. And a single
//   shared projection cannot serve both: handed the staff datasets, a
//   participant's page builds a query the rules refuse — it does not render
//   less, it fails.
import type { AuthoredApp, AuthoredMail, AuthoredSubmit } from "./publishManifest.js";

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
 *  Firestore document id under a `live:` / `staged:` prefix. Excluding `:`
 *  keeps the prefix and the id from running together; excluding `/`, `.` and
 *  `__…__` keeps it a legal document id that addresses the path it says. */
export const VIEW_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VIEW_ID_SHAPE = "must be lowercase letters, digits and hyphens, start with a letter or digit, and be at most 64 characters (e.g. front-desk)";

/** A view as the author wrote it, once normalized: one shape, whichever of
 *  the two declarations it came from. `where` is the path it was written at,
 *  carried only so a refusal names the key the author can go and edit. */
export interface NormalizedView {
  id: string;
  audience: ViewAudience;
  path: string;
  collections: string[];
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

  const views: NormalizedView[] = (authored ?? []).map((view, index) => ({
    id: view.id,
    audience: view.audience,
    path: view.path,
    collections: view.collections,
    where: `views[${index}]`,
  }));
  if (legacy === undefined) return { ok: true, views };
  // Checked even though the branch above already refuses the pair: the
  // reserved id is a property of the normalization, not of the order these
  // two refusals happen to be written in.
  if (views.some((view) => view.id === PUBLIC_VIEW_ID)) {
    return { ok: false, problems: [`views declares id '${PUBLIC_VIEW_ID}', which is reserved for the older \`public.view\` spelling. ${BOTH_FORMS}`] };
  }
  return { ok: true, views: [...views, { id: PUBLIC_VIEW_ID, audience: "public", path: legacy.path, collections: legacy.collections, where: "public.view" }] };
}

/** Whether one id may be used, and what to say when it may not. */
function viewIdProblems(view: NormalizedView): string[] {
  if (RESERVED_VIEW_IDS.includes(view.id)) {
    return [`${view.where}.id is '${view.id}', which is reserved: each audience's own declaration is published at that document id.`];
  }
  if (!VIEW_ID_PATTERN.test(view.id)) {
    // The id becomes a document id, so this is not style. A `/` in it
    // addresses a different path — staging writes one place and withdrawal
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
    problems.push(...viewIdProblems(view));
    const first = seen.get(view.id);
    if (first === undefined) {
      seen.set(view.id, view.where);
      continue;
    }
    problems.push(
      `${view.where}.id is '${view.id}', which ${first} already uses. The id is the document a view is published at, so two of them are one page — ` +
        "whichever was written second would silently replace the first, in staging and again at publish.",
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
  /** `scope: "own"` — the row is the document whose id is the reader's uid. */
  ownDocId?: "auth.uid";
}

/** How a participant reaches `cid`, or null if they cannot.
 *
 *  Mirrors the rules' read branches for someone holding no role:
 *  `partRead` (the whole collection) and `ownRow` (their own record, found
 *  by the submit declaration's `emailField` or by a uid-derived id).
 *
 *  `participantRead` is a PARAMETER rather than read off the manifest, and
 *  that is the whole point of the signature. Publish does not promote the
 *  manifest's value: `projectPublish` overwrites `participantRead` with what
 *  the STAGED schemas carry, so a cid added since the last deploy is in the
 *  manifest and not in the rules. Deriving the scope from the manifest would
 *  publish `scope: "all"` for a collection the promoted rules then deny —
 *  and removing one gives the mirror-image false refusal. The caller passes
 *  the set that will actually be in force. */
export function participantScope(app: AuthoredApp, cid: string, participantRead: readonly string[]): ProjectedViewCollection | null {
  if (participantRead.includes(cid)) return { cid, scope: "all" };
  const submit: AuthoredSubmit | undefined = app.public?.submit?.[cid];
  if (submit?.emailField !== undefined) return { cid, scope: "own", emailField: submit.emailField };
  if (submit?.idFrom === "auth.uid") return { cid, scope: "own", ownDocId: "auth.uid" };
  return null;
}

/** The declaration as one non-public audience may see it — the document
 *  published at `apps/{aid}/{tier}/live:config`, and deployed at
 *  `staged:config`.
 *
 *  The roster is NOT here, and neither is anything about another member: this
 *  is read by everyone the tier admits, which for `roster` includes every
 *  participant. */
export interface AppViewConfigDoc extends Record<string, unknown> {
  name?: string;
  views: { id: string; collections: ProjectedViewCollection[] }[];
  /** The submit declarations for the collections these views draw, so the page
   *  can show what may be sent rather than discovering it from a denial. */
  submit: Record<string, Record<string, unknown>>;
  /** What this audience may CHANGE about those collections — see
   *  {@link writeFor}. One entry per collection that has anything writable, in
   *  the order the views declare them; absent entries mean "read only", which
   *  is what a page with no buttons is drawn from. */
  write: ProjectedViewWrite[];
  publishedAt: number;
}

/** The document ids one tier uses. `live:` and `staged:` are the only two
 *  prefixes, so a single `match` covers the projection and every view. */
export const viewDocId = (stage: "live" | "staged", viewId: string): string => `${stage}:${viewId}`;
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
// assignment moves one declared assignee field, and there is no third thing.
// A general patch would be no less safe (the rules bind either way) and two
// things worse: a bug in the page reaches as far as the member's role does,
// and nothing above can say what happened.
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
    .sort();
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
 *  way — this only decides which buttons are drawn. */
function writersOf(app: AuthoredApp, cid: string): string[] {
  return holdersOf(app, cid, ["owner", "editor"]);
}

/** The transition half: which table applies, and the field it moves.
 *
 *  Both halves or neither. A status field with no table would offer every
 *  value; a table with no field has nothing to write it to. */
function transitionPart(app: AuthoredApp, audience: Exclude<ViewAudience, "public">, cid: string): Partial<ProjectedViewWrite> {
  const config = app.collections?.[cid];
  const transitions = audience === "member" ? config?.transitions : app.public?.submit?.[cid]?.selfTransitions;
  if (config?.statusField === undefined || transitions === undefined) return {};
  const part: Partial<ProjectedViewWrite> = { statusField: config.statusField, transitions };
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
function assignPart(app: AuthoredApp, audience: Exclude<ViewAudience, "public">, cid: string): Partial<ProjectedViewWrite> {
  const assigneeField = app.collections?.[cid]?.assigneeField;
  if (audience !== "member" || assigneeField === undefined) return {};
  return { assigneeField, rowWriters: holdersOf(app, cid, ["assignee"]) };
}

/** What `audience` may change about `cid`, or null when the answer is nothing.
 *
 *  The two audiences differ in WHICH transition table applies, in whether
 *  assignment exists at all, and in whether the roster's answer travels with
 *  it; they agree that the status field is the collection's, since the rules
 *  read one field either way. */
export function writeFor(app: AuthoredApp, audience: Exclude<ViewAudience, "public">, cid: string): ProjectedViewWrite | null {
  const write: ProjectedViewWrite = { cid, ...transitionPart(app, audience, cid), ...assignPart(app, audience, cid) };
  if (Object.keys(write).length === 1) return null;
  // Only the staff tier: a participant writes their own row, which the rules
  // answer from the record rather than from a role, and publishing the roster's
  // writers to them would be an address list for nothing.
  if (audience === "member") write.writers = writersOf(app, cid);
  return write;
}
