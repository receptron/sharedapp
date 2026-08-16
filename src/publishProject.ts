// authored (`app.json`) → published (`apps/{aid}`). The compilation step.
//
// THE WHOLE CONVERSION LIVES HERE. That is the point of the module, not a
// tidiness claim: the design note's D4 calls publish a compiler, and the
// failure it is guarding against is "I wrote what the sample shows and the
// rules refuse it". Every difference between what a human writes and what the
// rules read is either in this file or is a bug.
//
// What actually differs, and why:
//
//   window.from / window.until (ISO strings)  →  window.fromMs / untilMs (numbers)
//     The rules do not coerce a string to a timestamp. Comparing an ISO string
//     with `request.time` is a TYPE ERROR, and a rules type error denies. The
//     symptom is not an error message, it is "nobody can submit".
//
//   members                                   →  members + memberEmails
//     Denormalised so a client can ask "which apps am I in?" with
//     `array-contains`. It is DERIVED, never authored: `membersConsistent()`
//     refuses any write where the two disagree, so a hand-written value cannot
//     survive anyway — it can only make the whole publish fail with a
//     permission error that says nothing about the cause.
//
//   —                                         →  owner / publishedAt / publishedBy /
//                                                publishedCommit / previousPublished
//     Attribution and rollback. `owner` is a uid and the publisher's identity;
//     see `projectApp`'s parameter for why it is threaded in rather than read
//     from the declaration.
//
// WHAT DOES *NOT* CHANGE, and the temptation to make it change:
// `public.read` and `participantRead` stay ARRAYS. The rules test them with
// `cid in a.public.read`, which in the rules language means "is an element of"
// for a list and "is a key of" for a map — so a `{cid: true}` map would work
// equally well, and an earlier draft of the handoff note specified one. Two
// spellings that both work is exactly the kind of silent divergence this
// module exists to prevent, so the published form is the authored form and
// the emulator round-trip test (`../mulmoserver test/rules/rules_publish.ts`)
// pins that the rules accept it.

import type { CollectionSchema } from "@mulmoclaude/core/collection";
import {
  normalizeViews,
  participantScope,
  VIEW_CONFIG_ID,
  VIEW_TIER,
  viewDocId,
  writeFor,
  type AppViewConfigDoc,
  type NormalizedView,
  type ProjectedViewCollection,
  type ProjectedViewWrite,
  type ViewAudience,
} from "./appViews.js";
import type { AuthoredApp, AuthoredSubmit } from "./publishManifest.js";

/** Defined here rather than imported from `@mulmoclaude/common`: one line is not
 *  worth a second dependency on the monorepo this module exists to step out of. */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Who and when. Threaded in rather than read from a clock inside the
 *  projection so the projection stays pure and the tests can assert on an
 *  exact document. */
export interface PublishStamp {
  /** The publisher's Firebase uid. The rules require `owner ==
   *  request.auth.uid` on CREATE and `owner` unchanged on UPDATE, so this is
   *  used only when the app document does not exist yet. */
  uid: string;
  /** The publisher's verified email — the principal the roster is keyed by. */
  email: string;
  /** Wall-clock millis of this publish. */
  publishedAt: number;
  /** The git commit the declaration was read from, when the host could
   *  resolve one. Absent is a normal state (a dirty tree, a repository
   *  without git), and absent is more honest than a fabricated value. */
  commit?: string | undefined;
  /** Was the working tree modified when the commit was read?
   *
   *  Recorded as `publishedDirty` on the app document, because a commit that
   *  does not describe what was published is worse than no commit: it looks
   *  auditable. Publish-owned like the rest of the `published*` family — a
   *  deploy must not drop the marker, and a later CLEAN publish must clear it
   *  rather than inherit it forever. */
  dirty?: boolean | undefined;
}

/** One collection's published schema document (`apps/{aid}/collections/{cid}`).
 *
 *  The rules never read `publishedSchema` — `schemaRead` gates the whole
 *  document and stops there. It is here for the CLIENTS: a member's host
 *  renders from it, and a public webview has no other way to know the fields.
 *  The whole schema is published rather than a projection of it, because
 *  every attempt to guess "the part a view needs" is a guess about a view
 *  that has not been written yet. */
export interface PublishedSchemaDoc extends Record<string, unknown> {
  publishedSchema: CollectionSchema;
  publishedAt: number;
  publishedBy: string;
  publishedCommit?: string;
}

/** The public settings document (`apps/{aid}/config/public`).
 *
 *  `allow read: if true` — this is the one document an anonymous visitor can
 *  read, and it is the reason `apps/{aid}` itself is reader-only: a
 *  participant reading the app document would see their classmates'
 *  addresses. So the roster is NOT here, and neither is `owner`. What is here
 *  is what a public form needs in order to render itself and to tell a visitor
 *  "this closed yesterday" instead of failing a write with no explanation. */
export interface PublishedConfigDoc extends Record<string, unknown> {
  name?: string;
  enabled: boolean;
  read: string[];
  submit: Record<string, Record<string, unknown>>;
  /** That the app HAS a published view, and which datasets it asked for.
   *
   *  This is the only place the public page can learn it: the rules' app
   *  document is reader-only and deliberately carries no view, and the HTML
   *  itself lands in a SEPARATE document (`config/view`) because a 1 MiB limit
   *  applies per document. Omitted here, the page has the HTML and no idea
   *  what to send it — the feature does not work at all.
   *
   *  The authored PATH is deliberately not published. It names a file in the
   *  author's repository, which the browser cannot use and which nobody should
   *  be handed on a world-readable document; what the page needs is the
   *  dataset list, and `publishedAt` beside it is what pins this declaration
   *  to the HTML published in the same run. */
  view?: { collections: string[] };
  publishedAt: number;
}

/** Everything one publish writes. Separate documents because they live at
 *  separate paths with separate rules — and in the order given: the app
 *  document authorizes the other two, so it goes first. */
export interface PublishedApp {
  app: Record<string, unknown>;
  schemas: { cid: string; doc: PublishedSchemaDoc }[];
  config: PublishedConfigDoc;
}

/** The document id under `apps/{aid}/config`. One document, named, rather than
 *  a spread of them: a second public document is a second thing to keep in
 *  step, and nothing yet needs one. */
export const PUBLIC_CONFIG_DOC = "public";

/** Drop keys whose value is `undefined`. Firestore rejects an undefined field
 *  value outright, and `"k" in c` — which every optional key in the rules is
 *  read through — must mean "the author declared it". */
function compact(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

/** ISO → epoch millis, the one conversion the rules cannot do for themselves.
 *  The caller has already refused an unparseable string (the authored parser
 *  requires `z.iso.datetime()`), so a NaN here would be a programming error;
 *  it is still checked, because a NaN written to Firestore fails closed in the
 *  same silent way an ISO string does. */
function windowMillis(
  window:
    | {
        from?: string | undefined;
        until?: string | undefined;
        fromField?: Record<string, string> | undefined;
        untilField?: Record<string, string> | undefined;
      }
    | undefined,
): Record<string, unknown> | undefined {
  if (!window) return undefined;
  const out: Record<string, number> = {};
  if (window.from !== undefined) out.fromMs = Date.parse(window.from);
  if (window.until !== undefined) out.untilMs = Date.parse(window.until);
  if (Object.values(out).some((value) => !Number.isFinite(value))) {
    throw new Error(`publish: window bound is not a parseable timestamp (${JSON.stringify(window)})`);
  }
  // `fromField` passes through unlowered — it names a field on another record,
  // and the value it points at is already epoch millis (whoever schedules the
  // class writes it). There is nothing here to convert, and dropping it is the
  // failure this function's own comment warns about: the rules would stop
  // seeing a bound the author declared, and the window would silently be open.
  const projected: Record<string, unknown> = {
    ...out,
    ...(window.fromField === undefined ? {} : { fromField: window.fromField }),
    ...(window.untilField === undefined ? {} : { untilField: window.untilField }),
  };
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/** One `public.submit[cid]`, with its window lowered. Everything else passes
 *  through: the rules read these keys by the names the author wrote. */
function projectSubmit(submit: AuthoredSubmit): Record<string, unknown> {
  const { window, ...rest } = submit;
  return compact({ ...rest, window: windowMillis(window) });
}

/** The roster's addresses as a set, in a stable order.
 *
 *  Sorted so two publishes of the same declaration produce the same document
 *  — idempotence is a property this step is tested for, and Firestore compares
 *  arrays by ORDER. `membersConsistent()` compares as sets and would accept
 *  any order; the test that would notice is the one asserting a second publish
 *  changes nothing but `publishedAt`. */
function memberEmailsOf(members: AuthoredApp["members"]): string[] {
  return Object.keys(members).sort();
}

/** The previous document, kept for rollback, with its OWN `previousPublished`
 *  stripped.
 *
 *  One level, deliberately. Chaining would make every publish carry the entire
 *  history of the app inside a single document, which grows without bound and
 *  meets Firestore's 1 MiB document limit as a permission-shaped failure at
 *  some unpredictable publish. One level answers the question rollback
 *  actually asks — "put back what was there before I broke it" — and the
 *  further history is in git, which is where the declaration came from. */
function previousOf(existing: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!existing) return undefined;
  const { previousPublished: __dropped, ...rest } = existing;
  return rest;
}

/** Project the authored declaration into the documents publish writes.
 *
 *  `existing` is the app document as it is in Firestore right now, or null on
 *  a first publish. Two things need it, both required by the rules:
 *    - `owner` must be UNCHANGED on update. Re-stamping the publisher's uid
 *      would be refused for any app whose owner ever signed in as a different
 *      account, and would silently transfer ownership if it were not.
 *    - `previousPublished` is that document, so a rollback has something to
 *      put back.
 *
 *  Pure: no clock, no filesystem, no Firestore. Everything variable arrives as
 *  a parameter, which is what makes the conversion table testable as a table. */
export function projectApp(
  authored: AuthoredApp,
  schemas: { cid: string; schema: CollectionSchema }[],
  stamp: PublishStamp,
  existing: Record<string, unknown> | null,
): PublishedApp {
  const owner = typeof existing?.owner === "string" ? existing.owner : stamp.uid;
  const submit = Object.fromEntries(Object.entries(authored.public?.submit ?? {}).map(([cid, spec]) => [cid, projectSubmit(spec)]));
  const publicBlock = authored.public
    ? compact({
        enabled: authored.public.enabled,
        read: authored.public.read,
        submit: Object.keys(submit).length > 0 ? submit : undefined,
      })
    : undefined;

  const app = compact({
    aid: authored.aid,
    name: authored.name,
    owner,
    members: authored.members,
    memberEmails: memberEmailsOf(authored.members),
    collections: authored.collections,
    participantRead: authored.participantRead,
    public: publicBlock,
    publishedAt: stamp.publishedAt,
    publishedBy: stamp.email,
    publishedCommit: stamp.commit,
    publishedDirty: stamp.dirty === true ? true : undefined,
    previousPublished: previousOf(existing),
  });

  // Refusals belong to the gate (`publishProblems`), which has already run by
  // the time anything is projected. A declaration that cannot be normalized
  // here is a programming error, and projecting half of it would publish a
  // page with no data.
  const normalized = normalizeViews(authored);
  if (!normalized.ok) throw new Error(`publish: views declaration is not publishable (${normalized.problems.join(" ")})`);
  const publicView = normalized.views.find((view) => view.audience === "public");

  const config: PublishedConfigDoc = {
    enabled: authored.public?.enabled === true,
    read: authored.public?.read ?? [],
    submit,
    // Read through the normalization, not off `public.view`: an app that
    // declares its public page in `views[]` must publish the same document, or
    // the page has the HTML and no idea what to send it.
    ...(publicView === undefined ? {} : { view: { collections: publicView.collections } }),
    publishedAt: stamp.publishedAt,
  };
  if (authored.name !== undefined) config.name = authored.name;

  return { app, schemas: schemas.map(({ cid, schema }) => ({ cid, doc: schemaDoc(schema, stamp) })), config };
}

/** Everything `publish` writes, as one projection.
 *
 *  There is no staging half any more. `deploy` and `apps/{aid}/staging/{cid}` are gone (the design
 *  is in mulmoterminal `plans/feat-shared-app-no-staging.md`), so an app has two states rather than
 *  three: it EXISTS — created by the host's `init`, which writes exactly this minus the config and
 *  the `public` block — and it is PUBLISHED, which adds those two and flips the slug.
 *
 *  What that removes is a class of defect rather than a step. Publish used to write the roster from
 *  the manifest and the collection configuration from what a previous deploy had staged, so the app
 *  that landed was one half of each; the checks that existed to catch that combination are deleted
 *  with it, because the two halves are now the same manifest read once.
 *
 *  WRITE `public` LAST. It is the only field here that GRANTS anything, so a partial failure with
 *  it last leaves the app private (fail closed). */
export interface PublishedFace {
  /** The COMPLETE app document **without `public`** — write it with `set`, replacing.
   *
   *  Replacing (not merging) is what lets a key DISAPPEAR: withdrawing a collection's rule
   *  configuration, or taking `public` out of `app.json`, has to actually remove the field. A merge
   *  cannot delete, and every deletion here is a permission change — removing `members.<email>`
   *  revokes access, and the rules require `memberEmails` to equal the keys of `members`
   *  (`membersConsistent()`), so a merged member-removal is rejected outright. */
  app: Record<string, unknown>;
  /** The schema documents, for `apps/{aid}/collections/{cid}` — projected from the working tree,
   *  which is now the only version there is. */
  schemas: { cid: string; doc: PublishedSchemaDoc }[];
  /** `apps/{aid}/config/public` — the world-readable projection. */
  config: PublishedConfigDoc;
  /** The `public` block, to be written **LAST, as its own update** — or, when `undefined`, DELETED
   *  from the app document (that is how an app becomes private again).
   *
   *  Separate from {@link PublishedFace.app} because it is the only one of publish's writes that
   *  GRANTS anything: the rules authorize anonymous reads and submissions from `apps/{aid}.public`,
   *  never from the world-readable `config/public`. Written inside the replacement document it
   *  would open the app before the schemas and the config exist, so a failure part-way would leave
   *  anonymous access live against a half-published surface. Written last, the same failure leaves
   *  the app private.
   *
   *  A re-publish therefore passes through a moment with no `public` block. That is a brief denial
   *  for visitors, not a brief exposure. */
  public: Record<string, unknown> | undefined;
}

export function projectPublish(
  authored: AuthoredApp,
  schemas: { cid: string; schema: CollectionSchema }[],
  stamp: PublishStamp,
  existing: Record<string, unknown> | null,
): PublishedFace {
  const projected = projectApp(authored, schemas, stamp, existing);
  const { public: publicBlock, ...app } = projected.app;
  return { app, schemas: projected.schemas, config: projected.config, public: isRecord(publicBlock) ? publicBlock : undefined };
}

/** One published schema document. Written key by key rather than through
 *  `compact`, so the declared type is the type — an optional commit is the
 *  only variable part. */
function schemaDoc(schema: CollectionSchema, stamp: PublishStamp): PublishedSchemaDoc {
  const doc: PublishedSchemaDoc = { publishedSchema: schema, publishedAt: stamp.publishedAt, publishedBy: stamp.email };
  if (stamp.commit !== undefined) doc.publishedCommit = stamp.commit;
  return doc;
}

/** The app documents' parent path — the `FirestoreDocs` seam takes a
 *  collection path plus a document id, and the app document's id is the aid. */
export const APPS_COLLECTION = "apps";
/** The collection (schema) documents' parent path — what the PUBLIC page
 *  reads, written only by publish (promotion). */
export const appSchemasPath = (aid: string): string => `apps/${aid}/collections`;
/** The URL-slug reservations — `appSlugs/{slug}` → `{ aid, published }`.
 *
 *  A TOP-LEVEL collection, not a field on the app: the public page resolves a
 *  slug to an aid BEFORE it can read anything under `apps/{aid}`, and a slug
 *  has to be claimable atomically (create-if-absent) so two apps cannot hold
 *  the same URL.
 *
 *  `published` is what makes the reservation invisible until publish. The slug
 *  is human-readable, so a readable reservation would let anyone guess the URL
 *  and get the aid — and the aid is the `/staging/{aid}` entrance. The rule is
 *  `allow read: if resource.data.published == true`, which needs no `get()` and
 *  so costs nothing against the rules' expression budget. */
export const APP_SLUGS_COLLECTION = "appSlugs";

/** The reservation document. Written by deploy as `{ aid, published: false }`
 *  and flipped by publish — never re-pointed at another aid, which the rules
 *  enforce on update. */
export interface AppSlugDoc extends Record<string, unknown> {
  aid: string;
  published: boolean;
}

export const appSlugDoc = (aid: string, published: boolean): AppSlugDoc => ({ aid, published });
/** The public-config documents' parent path. */
export const appConfigPath = (aid: string): string => `apps/${aid}/config`;

/** Where one audience's pages live. `member` is read by anyone holding a role;
 *  `roster` by anyone on the roster, participants included. */
export const appViewTierPath = (aid: string, tier: "member" | "roster"): string => `apps/${aid}/${tier}`;

/** One audience's tier, as publish (or deploy) must write it.
 *
 *  Both tiers are returned even when empty, deliberately. An app that WITHDREW
 *  its member pages produces an empty tier, and a host that only ever saw the
 *  tiers with something in them would leave the previous pages live — the
 *  failure `config/view` already had, where a declaration was withdrawn and
 *  the world went on reading the page. */
export interface AppViewTier {
  tier: "member" | "roster";
  audience: Exclude<ViewAudience, "public">;
  /** The projection document, for `{tier}/live:config` or `{tier}/staged:config`.
   *  Meaningless when `views` is empty — the host deletes the tier instead. */
  config: AppViewConfigDoc;
  /** The views to publish, in declaration order. The host reads each `path`
   *  and writes it to `{tier}/live:{id}`. */
  views: NormalizedView[];
}

/** What one audience may see of one collection.
 *
 *  For `member` this is always the whole collection: every read branch a role
 *  opens (`readerOf`) is unscoped. Whether THIS member holds the role is not
 *  knowable here — one projection is read by every member of the tier — and is
 *  settled where it can be, by the entrance trying the read.
 *
 *  For `participant` it is the rules' own answer, which is why it can be null:
 *  a participant with neither `participantRead` nor an own-row submit path
 *  cannot read the collection at all, and a page handed it would fail rather
 *  than render less. */
function scopeFor(
  authored: AuthoredApp,
  audience: Exclude<ViewAudience, "public">,
  cid: string,
  participantRead: readonly string[],
): ProjectedViewCollection | null {
  return audience === "member" ? { cid, scope: "all" } : participantScope(authored, cid, participantRead);
}

/** Project the declaration into the per-audience documents.
 *
 *  Pure, like `projectApp`: the HTML is not here (the host reads the files),
 *  and neither is the clock. What is here is the answer to "what may this
 *  audience read, and how" — computed once, so the page never has to guess and
 *  never has to discover it from a denial. */
/** What this audience may CHANGE, per collection it draws.
 *
 *  Read straight off the manifest. It used to take a second, "promoted" configuration — what a
 *  previous DEPLOY had staged — because publish ran the rules against that rather than against the
 *  declaration, so projecting the manifest's would advertise transitions the live rules denied.
 *  Publish writes both halves from this manifest now, so there is no second answer to give. */
export function tierWrites(authored: AuthoredApp, audience: Exclude<ViewAudience, "public">, cids: string[]): ProjectedViewWrite[] {
  // Read-only collections are absent rather than present and empty: an entry
  // is what a page draws a button from.
  return cids.map((cid) => writeFor(authored, audience, cid)).filter((entry): entry is ProjectedViewWrite => entry !== null);
}

/** What this audience may READ, and how to query for it.
 *
 *  A collection with no scope is dropped rather than published as unreachable:
 *  the gate has already refused the declaration, so reaching here with one is
 *  a programming error, and a page that queries it is denied. */
export function tierViews(authored: AuthoredApp, audience: Exclude<ViewAudience, "public">, views: NormalizedView[], participantRead: readonly string[]) {
  return views.map((view) => ({
    id: view.id,
    collections: view.collections
      .map((cid) => scopeFor(authored, audience, cid, participantRead))
      .filter((scope): scope is ProjectedViewCollection => scope !== null),
  }));
}

/** One tier's projection: what this audience may read, and what it may change. */
function tierConfig(authored: AuthoredApp, audience: Exclude<ViewAudience, "public">, views: NormalizedView[], stamp: PublishStamp): AppViewConfigDoc {
  const cids = [...new Set(views.flatMap((view) => view.collections))];
  const config: AppViewConfigDoc = {
    write: tierWrites(authored, audience, cids),
    views: tierViews(authored, audience, views, authored.participantRead ?? []),
    submit: tierSubmit(authored, cids),
    publishedAt: stamp.publishedAt,
  };
  if (authored.name !== undefined) config.name = authored.name;
  return config;
}

/** The submit declarations for the collections these views draw, so a page can
 *  show what may be sent rather than discovering it from a denial. */
function tierSubmit(authored: AuthoredApp, cids: string[]): Record<string, Record<string, unknown>> {
  const declared = authored.public?.submit ?? {};
  return Object.fromEntries(
    cids.flatMap((cid) => {
      const spec = declared[cid];
      return spec === undefined ? [] : [[cid, projectSubmit(spec)] as const];
    }),
  );
}

export function projectAppViews(authored: AuthoredApp, stamp: PublishStamp): AppViewTier[] {
  const normalized = normalizeViews(authored);
  if (!normalized.ok) throw new Error(`publish: views declaration is not publishable (${normalized.problems.join(" ")})`);
  const audiences: Exclude<ViewAudience, "public">[] = ["member", "participant"];
  return audiences.map((audience) => {
    const views = normalized.views.filter((view) => view.audience === audience);
    return { tier: VIEW_TIER[audience], audience, config: tierConfig(authored, audience, views, stamp), views };
  });
}

/** The document a tier's projection is published at. Beside the views
 *  themselves, under one `match` — see `firestore.rules`. */
export const viewConfigDocId = (stage: "live" | "staged"): string => viewDocId(stage, VIEW_CONFIG_ID);
