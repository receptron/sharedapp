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
import { protocolFor } from "./appProtocol.js";
import {
  limitFor,
  normalizeViews,
  participantScope,
  type ArticleFields,
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
import { agentsFor, agentTierCids, type ProjectedAgent } from "./appAgents.js";
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
   *  later CLEAN publish must clear it rather than inherit it forever. */
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
  /** The version of the publish contract these documents keep — see `appProtocol.ts`. A reader
   *  refuses a MAJOR above its own rather than drawing it, which is the whole reason it is here. */
  protocol: string;
  name?: string;
  enabled: boolean;
  read: string[];
  submit: Record<string, Record<string, unknown>>;
  /** What a VISITOR may change about their own row here — the same shape every tier config carries,
   *  and for the same purpose: it tells the page which buttons exist, so a control is drawn where
   *  the rules would allow it and nowhere else.
   *
   *  It is here because `ownRow` in the rules asks for `authed()` and nothing else. The person who
   *  submitted through this page may move their own row along `selfTransitions` and take it away
   *  along `selfDelete` — declared, as those keys say, on the PUBLIC submit — with no role and no
   *  membership anywhere. That was projected to the participant tier and not to the page the
   *  submission came from, so a public page could not offer a cancellation the rules were waiting
   *  to allow; it could ask, and nothing could answer.
   *
   *  Absent where nothing is writable, and absent entirely on every document published before this
   *  key existed — which reads back as "nothing writable" (`projectedWritesOf`), the same answer
   *  those apps have today. It is a key, not a contract: see `appProtocol.ts` on why adding one
   *  does not move the number. */
  write?: ProjectedViewWrite[];
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
  view?: {
    collections: string[];
    live?: string[];
    limit?: Record<string, { rows: number; field: string }>;
    /** A page the RUNTIME draws from the declaration, instead of the HTML this document is paired
     *  with — `views[].type`. Declared here as well as emitted, because a consumer that has to cast
     *  to reach a key is a consumer that will read it wrong: this is the type the published
     *  document actually has. */
    type?: "article" | undefined;
    /** Which field of an article is which, for `type: "article"`. */
    article?: ArticleFields | undefined;
  };
  /** The publisher's standing instructions for whoever sits at the PUBLIC face
   *  — see `appAgents.ts`.
   *
   *  Only the public ones. This document is `allow read: if true` forever, so a
   *  member's brief here would publish the app's internal vocabulary (when to
   *  approve, when to delete) to anybody who asks — the same leak as publishing
   *  the staff page here would be. The gate refuses a public brief that names a
   *  collection this audience can neither read nor write, so the cids that
   *  remain are `public.read` and `public.submit` — both of which this document
   *  already carries. */
  agents?: ProjectedAgent[];
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
  const publicAgents = agentsFor(authored, "public");
  const publicWrite = Object.keys(submit)
    .map((cid) => writeFor(authored, "public", cid))
    .filter((entry): entry is ProjectedViewWrite => entry !== null);

  const config: PublishedConfigDoc = {
    // WHICH CONTRACT THESE DOCUMENTS KEEP — the number a reader compares before drawing them.
    // Never the author's `protocol`, which is a floor: the documents keep what produced them, and
    // an app claiming a contract its documents do not honour is worse than one claiming none.
    //
    // PER APP, not one constant: an app that declares nothing a reader must understand keeps the
    // contract every deployed reader already knows, and only the ones that do move up. See
    // `protocolFor`.
    protocol: protocolFor(authored),
    enabled: authored.public?.enabled === true,
    read: authored.public?.read ?? [],
    submit,
    // The submit cids and only those: a self-write is declared inside `public.submit[cid]`, so a
    // collection nobody may submit to has nothing here to say. Absent rather than empty for the
    // reason every other projection is — an entry is what a page draws a button from, and `[]`
    // would be a claim where silence is the truth.
    ...(publicWrite.length === 0 ? {} : { write: publicWrite }),
    // Read through the normalization, not off `public.view`: an app that
    // declares its public page in `views[]` must publish the same document, or
    // the page has the HTML and no idea what to send it.
    // `live` rides with `collections` and only when the author declared it: an
    // app that never wrote the key must publish the document it published
    // before this key existed. What lands here is world-readable, and it is
    // the cid NAMES ONLY — the same names `collections` beside it already
    // carries, so the projection tells the world nothing new (principle 5).
    ...(publicView === undefined ? {} : { view: publicViewProjection(authored, publicView) }),
    // The public briefs and only those (see `PublishedConfigDoc.agents`). Absent
    // rather than empty, so an app that declares none publishes the document it
    // published before this key existed.
    ...(publicAgents.length === 0 ? {} : { agents: publicAgents }),
    publishedAt: stamp.publishedAt,
  };
  if (authored.name !== undefined) config.name = authored.name;

  return { app, schemas: schemas.map(({ cid, schema }) => ({ cid, doc: schemaDoc(schema, stamp) })), config };
}

/** The public page's declaration, as the world-readable document carries it.
 *
 *  `live` rides beside `collections` and ONLY when the author wrote it: an app
 *  that never declared one must publish the document it published before this
 *  key existed, byte for byte. What lands is cid NAMES — the same names
 *  `collections` beside it already carries, so nothing new is disclosed by
 *  publishing it (principle 5). The gate has already refused the fan-out cases
 *  (`viewLiveProblems`), so what is here is a subset of `public.read` that
 *  nobody but the app itself writes.
 *
 *  `limit` rides the same way, and a public page is the one audience where
 *  every scope is `all` — a stranger reads what `public.read` names or nothing
 *  at all — so the cap is never the own-row case the projection omits. */
function publicViewProjection(
  app: AuthoredApp,
  view: NormalizedView,
): {
  collections: string[];
  live?: string[];
  limit?: Record<string, { rows: number; field: string }>;
  type?: "article" | undefined;
  article?: ArticleFields | undefined;
} {
  const capped = view.collections.map((cid) => ({ cid, limit: limitFor(app, view, { cid, scope: "all" }).limit }));
  const limit = Object.fromEntries(capped.flatMap((entry) => (entry.limit === undefined ? [] : [[entry.cid, entry.limit]])));
  return {
    collections: view.collections,
    // WHAT DRAWS THE PAGE, when it is not the HTML at `config/view`. A reader
    // older than this contract does not know these two keys — which is why an
    // app carrying them is stamped a higher major and refused whole, rather
    // than drawn as the generated form (`protocolFor`).
    ...(view.type === undefined ? {} : { type: view.type }),
    ...(view.article === undefined ? {} : { article: view.article }),
    ...(view.live === undefined ? {} : { live: view.live }),
    // Keyed by cid rather than riding on each entry, because a public page's
    // `collections` is a list of NAMES: it has no per-collection object to
    // hang anything on, and turning it into one would change a document every
    // deployed public runtime already reads.
    ...(Object.keys(limit).length === 0 ? {} : { limit }),
  };
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
 *  and learn the aid of an app whose author has not published it. (While
 *  `/staging/{aid}` existed, it also handed over that entrance.) The rule is
 *  `allow read: if resource.data.published == true`, which needs no `get()` and
 *  so costs nothing against the rules' expression budget. */
export const APP_SLUGS_COLLECTION = "appSlugs";

/** The reservation document. Written as `{ aid, published: false }` when the
 *  name is claimed and flipped by publish — never re-pointed at another aid,
 *  which the rules enforce on update. */
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

/** One audience's tier, as publish must write it.
 *
 *  Both tiers are returned even when empty, deliberately. An app that WITHDREW
 *  its member pages produces an empty tier, and a host that only ever saw the
 *  tiers with something in them would leave the previous pages live — the
 *  failure `config/view` already had, where a declaration was withdrawn and
 *  the world went on reading the page. */
export interface AppViewTier {
  tier: "member" | "roster";
  audience: Exclude<ViewAudience, "public">;
  /** The projection document, for `{tier}/live:config` — the only prefix there
   *  is now (`viewDocId`).
   *
   *  WHEN THE HOST WRITES IT: `views.length > 0 || agents.length > 0`. Pages
   *  were never the question — "does this audience exist" was — and an
   *  agent-only desk needs the `write` / `submit` this document carries, or its
   *  brief asks for a move nothing can say is legal. When BOTH are empty the
   *  document says nothing and the host deletes the tier, which is what stops a
   *  withdrawn page staying readable by everyone the tier admits. */
  config: AppViewConfigDoc;
  /** The views to publish, in declaration order. The host reads each `path`
   *  and writes it to `{tier}/live:{id}`. */
  views: NormalizedView[];
  /** The standing instructions published for this audience — carried out
   *  separately from `config` because the HOST decides from it whether the tier
   *  exists at all: a tier is kept when it has pages OR agents, and deleted
   *  only when it has neither (see {@link AppViewTier.config}). */
  agents: ProjectedAgent[];
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
 *  than render less.
 *
 *  WHICH ROWS, NOT HOW MANY. A member's `all` is whole-collection in the sense
 *  that the rules place no filter on it — and `tierViews` then puts every scope
 *  through `limitFor`, so a member page that declared a cap is projected one
 *  and reads the latest N of that collection. The two are not the same
 *  question: the scope is what the RULES grant, the cap is what the page ASKED
 *  for, and the one place they meet is `scope: "own"`, where a cap cannot be
 *  ordered and `limitFor` omits it. */
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
  return views.map((view) => {
    const collections = view.collections
      .map((cid) => scopeFor(authored, audience, cid, participantRead))
      .filter((scope): scope is ProjectedViewCollection => scope !== null)
      .map((scope) => limitFor(authored, view, scope));
    // Narrowed to what this tier is actually handed, for the reason the scopes
    // are: a collection this audience cannot read is dropped above, and naming
    // it here would tell the page to subscribe to a query it never got. Absent
    // rather than empty when nothing survives — see `NormalizedView.live`.
    const live = (view.live ?? []).filter((cid) => collections.some((scope) => scope.cid === cid));
    return { id: view.id, collections, ...(view.live === undefined || live.length === 0 ? {} : { live }) };
  });
}

/** One tier's projection: what this audience may read, and what it may change. */
function tierConfig(authored: AuthoredApp, audience: Exclude<ViewAudience, "public">, views: NormalizedView[], stamp: PublishStamp): AppViewConfigDoc {
  // THE PAGES' COLLECTIONS AND THE BRIEFS', in one set. An app whose staff have
  // a duty and no page would otherwise publish a brief beside a `write` that
  // says nothing — the agent is asked to approve rows against a document that
  // does not carry the transition table. A page was never what made staff
  // exist; it was only what happened to be read.
  const cids = [...new Set([...views.flatMap((view) => view.collections), ...agentTierCids(authored, audience)])];
  const agents = agentsFor(authored, audience);
  const config: AppViewConfigDoc = {
    // Every tier carries it, for the reason `projectApp` gives beside the public one: one publish
    // writes them all, and a reader that can draw one and not another is a half-drawn app.
    protocol: protocolFor(authored),
    write: tierWrites(authored, audience, cids),
    views: tierViews(authored, audience, views, authored.participantRead ?? []),
    submit: tierSubmit(authored, cids),
    ...(agents.length === 0 ? {} : { agents }),
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
    return { tier: VIEW_TIER[audience], audience, config: tierConfig(authored, audience, views, stamp), views, agents: agentsFor(authored, audience) };
  });
}

/** The document a tier's projection is published at. Beside the views
 *  themselves, under one `match` — see `firestore.rules`. */
export const viewConfigDocId = (): string => viewDocId(VIEW_CONFIG_ID);
