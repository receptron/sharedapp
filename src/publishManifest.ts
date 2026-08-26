// The AUTHORED app declaration — everything in `<root>/app.json` that is not
// `aid`.
//
// WHY THIS IS NOT IN `appManifest.ts`. That module reads ONE field, and its
// header says why: every key added there is a key `publish` and the discovery
// loader could disagree about. Discovery needs to know which app a collection
// belongs to; it has no business knowing who is on the roster. So the roster
// and the public config are read HERE, by the only thing that consumes them.
// `aid` is still read through `parseAppManifest` — one parse of one field, not
// a second opinion about it.
//
// AUTHORED, NOT PUBLISHED. What this module produces is the shape a human
// wrote. The Firestore document is derived from it by `publishProject.ts`
// (epoch-millis windows, a derived `memberEmails`, publisher stamps). The two
// are deliberately different and the difference is written down in exactly one
// place — see that module's header.
//
// WHERE `collections[cid]` COMES FROM. From this file, authored by hand, as the
// samples in `mulmoterminal plans/feat-shareable-collections.md` (S1-S4) write
// it. The design note also describes deriving it from each collection's
// `schema.json` (`actions[].then.email` → `mail`, `require`/`set` →
// `transitions`), and that remains the intent — but the schema keys it would
// read DO NOT EXIST yet: `schemaZ.ts` has `require` and `set` and no `then`,
// no `immutable`, no `peerVisibility`, no `submitOnly`. Adding them is
// blocked behind the `.strict()` decision (implementation order 10), because
// today an unknown key is stripped per-variant and would vanish silently.
// Deriving from a source that cannot hold the declaration would mean inventing
// the source first. So: authored here, projected and CHECKED by publish, and
// when the schema can hold it the derivation replaces this arm rather than
// joining it.
//
// STRICT ON PURPOSE. Unlike `schemaZ`, this parser refuses unknown keys. The
// failure mode it prevents is the one the design note keeps warning about: a
// misspelled declaration key is not a broken app, it is a SILENTLY PERMISSIVE
// one — `submitOnl: true` publishes a collection anyone may write to, with
// nothing red anywhere. A schema key that vanishes costs a feature; a
// declaration key that vanishes costs the guarantee.

import { z } from "zod";
import { isValidCollectionName } from "@mulmoclaude/core/collection";
import { parseAppManifest, type AppManifestResult } from "@mulmoclaude/core/collection/server";
// Values only; `appViews` imports nothing but types from here, so the pair is
// not a runtime cycle.
import { VIEW_AUDIENCES } from "./appViews.js";

/** A collection id / app id, held to the one name rule (`SAFE_SLUG_PATTERN`)
 *  that `sharedCollectionKey` applies. Stated once so a path built later
 *  cannot be a way around it. */
const NameZ = z.string().refine(isValidCollectionName, { message: "is not a valid id (letters, digits, '-' and '_' only)" });

/** An address on the roster. Not validated as an email beyond "has an @":
 *  the rules compare it to `request.auth.token.email` verbatim, so any
 *  narrowing here would refuse addresses Firebase itself accepts. */
const EmailZ = z.string().trim().min(3).includes("@");

/** The roles the deployed rules understand.
 *
 *  Two of them are row-scoped, in opposite directions, and the pair is what
 *  the four-way split could not express:
 *
 *    `participant` — the layer that is NAMED but reads only its OWN rows (the
 *    rows it submitted). See `readerOf` vs `listedIn`.
 *
 *    `assignee` — reads EVERY row and writes only the rows ASSIGNED to it. The
 *    stylist who approves their own bookings and not a colleague's; the marker
 *    who grades their own students. Which rows are theirs is
 *    `collections[cid].assigneeField`, a field on the record holding the
 *    member's address. Reads are deliberately unscoped: a stylist needs the
 *    whole day's schedule, and scoping the read makes the app unusable.
 *
 *  The names are permanent. The deployed rules compare these strings directly
 *  and they are written into `app.json` files people commit, so a rename is a
 *  migration over published apps rather than an edit. */
export const APP_ROLES = ["owner", "editor", "viewer", "participant", "assignee"] as const;
const RoleZ = z.enum(APP_ROLES);

/** `{ email: { "*" | cid: role } }`. The `"*"` key is the app-wide role; a
 *  member may hold per-collection roles only (the stylist who is editor of
 *  bookings and viewer of everything else). */
const MembersZ = z.record(EmailZ, z.record(z.union([z.literal("*"), NameZ]), RoleZ));

/** The declarative mail queue, as the rules re-derive it: a transition of the
 *  status field, a recipient read off the RECORD, and a fixed template. */
const MailZ = z
  .object({
    toField: z.string().trim().min(1),
    on: z.record(z.string().trim().min(1), z.object({ from: z.array(z.string().trim().min(1)).min(1), to: z.string().trim().min(1) }).strict()),
    dataFields: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

/** `idIn` asked of a REF FIELD instead of the document id — and declared on the
 *  COLLECTION rather than under `public.submit`, which is the whole point.
 *
 *  What it says: a row of this collection may be created only while the record
 *  its `ref` field names is in the given state. A message may be posted only
 *  while its topic says `open`.
 *
 *  Why not `idIn`. That one pins the record through the DOCUMENT ID, so it fits
 *  a collection whose id IS the thing being claimed (one booking per slot). A
 *  thread cannot spend its id that way — every message needs its own — so the
 *  parent is named by an ordinary field, and the rules build the path from
 *  `request.resource.data[ref]` exactly as a per-record window bound does.
 *
 *  Why on the collection. Every other cross-record check lives under
 *  `public.submit` and therefore binds the VISITOR and says nothing to a
 *  writer. The apps this exists for are the ones whose writers are the problem:
 *  an app that seats AI agents hands them the owner's own sign-in, so to
 *  Firestore every agent is an `owner`, and the create branch asks a writer
 *  nothing at all. Declared here, the rules hold the owner to it too.
 *
 *  CREATE only, deliberately. A closed thread must take no new message; editing
 *  one already in it is the host's business, and refusing that would leave a
 *  bad record with no way back. The other half of the guarantee is
 *  `transitions`, which already binds writers on update: an app that means
 *  "closed is final" declares no way out of `closed`, and then the state this
 *  reads cannot be walked back to reopen the thread. Either half alone is
 *  advice — see the `refIn` note in publishChecks. */
const RefInZ = z
  .object({
    /** The field on the record BEING WRITTEN that names the parent. */
    ref: z.string().trim().min(1),
    /** The collection segment of the parent's path, fixed here in the
     *  declaration. Only that segment is fixed: the DOCUMENT id comes from the
     *  written record's `ref` field, so the writer chooses which parent it
     *  points at — deliberately, that being the whole question the check asks.
     *  What the declaration buys is that no writer can aim the lookup at
     *  another COLLECTION. */
    collection: NameZ,
    /** Omitted, the check degenerates to "the parent must exist" — which the
     *  lookup performs on its own, a missing document being an evaluation
     *  error that denies. */
    where: z
      .object({ field: z.string().trim().min(1), equals: z.union([z.string(), z.number(), z.boolean()]) })
      .strict()
      .optional(),
  })
  .strict();

/** What the rules read out of `collections[cid]`. NOT the schema — the schema
 *  is published beside it, untouched, for clients to render from. */
const CollectionConfigZ = z
  .object({
    statusField: z.string().trim().min(1).optional(),
    /** `{ initial: [...], <status>: [<status>...] }`. Binds writers too, and
     *  binds `create` — that is the point of publishing it. */
    transitions: z.record(z.string().trim().min(1), z.array(z.string().trim().min(1))).optional(),
    immutable: z.boolean().optional(),
    submitOnly: z.boolean().optional(),
    /** A WRITER may take a row of this collection away.
     *
     *  The rules already allow it — `deleteWith`'s first branch is
     *  `isWriter(r)`, with no status condition — and nothing here grants it.
     *  What was missing was the DECLARATION: `selfDelete` is projected to the
     *  roster tier only, so a staff page had no way to ask for a deletion the
     *  rules were waiting to allow, and an author who wanted one had to move
     *  the page to `participant` and lose the staff half of its projection.
     *
     *  A BOOLEAN, unlike `selfDelete`'s list of statuses, and the difference is
     *  which side reads it. `selfDelete` is read by the rules
     *  (`s.get("selfDelete", [])`), so its statuses are enforced; the writer
     *  branch reads nothing, so a list here would be a narrowing only the page
     *  believes in — declaration and enforcement disagreeing, which is what
     *  this whole projection exists to prevent. An app that wants a writer
     *  stopped in some status says so with `immutable`, or not at all.
     *
     *  It needs no `statusField`: a writer may delete a row that has no status,
     *  which is the ordinary case for a roster of names. */
    writerDelete: z.boolean().optional(),
    /** The field naming the member a row belongs to, for the `assignee` role.
     *
     *  Holds an ADDRESS, because that is the only thing the rules can compare
     *  a member against (`request.auth.token.email`). A `ref` to a staff
     *  collection stores the target's primary-key slug, not an address, so it
     *  cannot be this field — declare a plain field beside the ref and let the
     *  ref stay the thing the UI renders. The alternative, having the rules
     *  `get()` the staff record to read an address off it, costs a document
     *  access on every write and puts a second document between an
     *  authorization decision and its answer.
     *
     *  Only meaningful with a member holding `assignee` on this cid; a
     *  declaration with the role and no field is refused (`assigneeProblems`),
     *  because that member would silently hold nothing. */
    assigneeField: z.string().trim().min(1).optional(),
    /** This collection is the public projection of `mirrorOf` — the other
     *  half of `public.submit[...].mirror`, declared here because the rules
     *  read it when the PROJECTION is written rather than when the record is.
     *
     *  What it buys: `state` may be written by anybody, and only to the value
     *  the authority actually says, so a visitor who was refused a slot can
     *  repair the stale row that offered it to them. */
    mirrorOf: NameZ.optional(),
    /** The parent record's state, checked on every create — writers included.
     *  See {@link RefInZ}. */
    refIn: RefInZ.optional(),
    /** Statuses a row may not be DELETED from, by anybody — the owner
     *  included.
     *
     *  `deleteWith` asks a writer nothing (`writerDelete` above is read by the
     *  PAGES; the rules never look at it), so a record whose state is supposed
     *  to be permanent can be deleted and written again in its initial state.
     *  Where anything hangs off that record — a `refIn` naming it — the whole
     *  guarantee comes back with it: delete the closed topic, recreate it
     *  `open`, and the gate correctly reports an open topic.
     *
     *  Per status rather than a flag, exactly like `selfDelete`: "may be taken
     *  away while it is pending" and "may be taken away once it is history"
     *  are different promises. A collection where NO state may be removed is
     *  spelled by declaring every one of them.
     *
     *  DELETE only — a sealed record's other fields can still be corrected.
     *  What it cannot do is stop existing. */
    sealed: z.array(z.string().trim().min(1)).optional(),
    peerVisibility: z.enum(["public", "hidden"]).optional(),
    revealGated: z.boolean().optional(),
    gatedFrom: NameZ.optional(),
    revealBy: z.string().trim().min(1).optional(),
    mail: MailZ.optional(),
    /** Which fields an aggregate groups by. Declared here rather than in the
     *  schema for the same reason as everything else in this file — the schema
     *  has no `aggregate` key yet — and it is here at all because the
     *  invariant that guards it ("every aggregation key is a CHECKED field")
     *  is about `public.submit`, which is an app-level declaration. Published
     *  as-is; the rules never read it. */
    aggregate: z
      .object({ by: z.array(z.string().trim().min(1)).min(1) })
      .strict()
      .optional(),
  })
  .strict();

/** An authored submit window. ISO strings, because `app.json` is JSON and a
 *  Firestore `Timestamp` has no JSON form. Publish lowers it to epoch millis —
 *  the rules do not coerce strings, so an ISO string reaching Firestore is a
 *  type error that fails CLOSED (`inWindow` refuses every submission and the
 *  author sees "nobody can submit", not an error). */
/** A window bound that lives on ANOTHER record, read at write time.
 *
 *  `window.from` is one absolute instant for the whole collection, which is
 *  enough for a survey and useless for anything recurring: "each class opens
 *  three days before it starts, at 08:00" is a bound PER RECORD. So the bound
 *  is not computed in the rules — they have no usable date arithmetic and
 *  `request.time` is UTC, which is the wrong answer for "08:00" — it is
 *  computed by whoever schedules the class, stored on the class record as
 *  epoch millis, and merely COMPARED here.
 *
 *  `ref` is the field on the record being written that names the target
 *  (`classId`); `collection` is the cid the target lives in, fixed in the
 *  declaration so that a path is never built out of a value a submitter wrote;
 *  `field` is the epoch-millis field on the target.
 *
 *  Not spelled `in` — that is an operator in the rules language, and
 *  `w.fromField.in` does not parse there. */
const WindowRefZ = z.object({ ref: z.string().trim().min(1), collection: NameZ, field: z.string().trim().min(1) }).strict();

/** The closing bound's per-record twin, and it ships WITH `fromField` rather
 *  than as a symmetric extra: a booking desk that opens per slot and never
 *  closes is not a booking desk. Same shape, opposite comparison — and
 *  EXCLUSIVE where `fromField` is inclusive, so one slot's closing instant and
 *  the next one's opening instant may be the same number. */
const WindowZ = z
  .object({
    from: z.iso.datetime().optional(),
    until: z.iso.datetime().optional(),
    fromField: WindowRefZ.optional(),
    untilField: WindowRefZ.optional(),
  })
  .strict();

/** Which record a `field` document id must name, and what state it must be in.
 *
 *  `idFrom: "field"` alone only stops the same string being written twice —
 *  nothing stops a client bypassing the page and inventing a slot, so the
 *  rules check the referenced record themselves. `exists()` is a FLOOR: a
 *  cancelled slot and a slot nobody may book any more exist too, which is what
 *  `where` is for.
 *
 *  Always the object form, never a bare collection name. Two shapes for one
 *  key is the kind of thing a generator gets right once and wrong afterwards,
 *  and the rules read `s.idIn.collection` either way. */
const IdInZ = z
  .object({
    collection: NameZ,
    where: z
      .object({ field: z.string().trim().min(1), equals: z.union([z.string(), z.number(), z.boolean()]) })
      .strict()
      .optional(),
  })
  .strict();

const ValidateZ = z
  .object({
    required: z.array(z.string().trim().min(1)).optional(),
    /** Capped at two by the rules themselves: rules have no iteration, so
     *  `keyFieldsOk` is unrolled. A third would be accepted here and silently
     *  unchecked there. */
    keyFields: z
      .array(z.object({ field: z.string().trim().min(1), values: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1) }).strict())
      .optional(),
  })
  .strict();

const SubmitZ = z
  .object({
    auth: z.enum(["none", "anonymous", "verifiedEmail"]),
    emailField: z.string().trim().min(1).optional(),
    /** The submitter's UID, in a field — the same binding as `emailField` and
     *  the only one available when the document id is spent on exclusivity.
     *
     *  A claim whose id IS the task's id is what stops two people taking one
     *  task, so identity cannot also live in the id; it has to be a field. The
     *  field version there was is `emailField`, and a board that shows who is
     *  working on what publishes the whole row (a rule cannot hide a field —
     *  the boundary is the document), so the address goes out with the name.
     *  A uid says the same thing and carries no address.
     *
     *  Rules-side: `ownRow` reads it, `uidOk` pins it to the writer's own uid
     *  on the public create, and `uidHeld` freezes it afterwards for EVERYONE
     *  — so unlike an address, staff cannot correct it and reassignment is
     *  delete-and-retake. Nobody can type a uid, so there was no reassignment
     *  UI to keep. */
    uidField: z.string().trim().min(1).optional(),
    createFields: z.array(z.string().trim().min(1)).min(1),
    initialStatus: z.string().trim().min(1).optional(),
    /** `field` is the mode that makes a CONTESTED resource exclusive: the
     *  booking's document id IS the slot's id, so the second person to want
     *  that slot is writing a document that already exists — an update, which
     *  the public submission path never allows. Firestore decides that
     *  atomically, so unlike a countable capacity (see `stampField`) this is
     *  first-come ENFORCED rather than first-come read off a rank. */
    /** How the document id is chosen.
     *
     *  `slug` is the one that is a NAME rather than a claim, and the pair is
     *  worth reading together. `field` says the record is FOR another one — a
     *  slot, a seat, an asset — so the id is a claim on something that must
     *  exist, and `idIn` is required to check it. `slug` says the record is
     *  CALLED that, which is a claim about nothing but itself: there is
     *  nothing to point `idIn` at, and what stands in its place is a GRAMMAR
     *  the rules enforce (`slugOk`), because the value becomes a path segment
     *  and is handed back out as a URL.
     *
     *  Both are frozen after create (`idHeld`), and for `slug` that is what
     *  keeps a published link resolving: the id is the URL, and the id cannot
     *  follow a renamed field. */
    idFrom: z.enum(["auto", "auth.uid", "auth.uid+field", "field", "slug"]).optional(),
    idField: z.string().trim().min(1).optional(),
    /** Required by `idFrom: "field"`, and meaningless for every other mode
     *  including `slug` — see {@link IdInZ}. */
    idIn: IdInZ.optional(),
    /** The collection holding this record's PUBLIC PROJECTION, one row per
     *  contested thing, sharing its document id.
     *
     *  A booking carries a name, an address and a phone number, and Firestore
     *  rules cannot hide a field, so the public page must not read bookings at
     *  all. It reads the projection instead, whose `state` is a copy of "does
     *  a booking with this id exist" — and the rules accept the two writes
     *  only as one batch, in both directions, so the copy cannot drift into
     *  advertising a slot that is gone. */
    mirror: NameZ.optional(),
    validate: ValidateZ.optional(),
    window: WindowZ.optional(),
    /** A field the rules PIN to the server clock on create: the record must
     *  carry `request.time` in it, and may never change it afterwards.
     *
     *  What it buys is an order nobody can jump. A first-come app takes its
     *  capacity from rank rather than from a count — the rules cannot count
     *  documents, so "the first 8" can only ever be a reading of the rows —
     *  and a rank is only as honest as the timestamp it sorts by. `idFrom`
     *  stops a person holding two places; nothing else stops them writing
     *  yesterday's date into the field that decides who got there first.
     *
     *  Binds EVERY create, the writer branch included, so a staff-entered row
     *  cannot be back-dated into the queue either. */
    stampField: z.string().trim().min(1).optional(),
    /** Per CURRENT STATUS, never a flat list: a flat list lets a customer move
     *  an approved booking's `startAt` without anyone re-approving it. */
    selfUpdate: z.record(z.string().trim().min(1), z.array(z.string().trim().min(1))).optional(),
    selfTransitions: z.record(z.string().trim().min(1), z.array(z.string().trim().min(1))).optional(),
    /** The statuses a submitter may DELETE their own row from.
     *
     *  Per status like the two above, and for a sharper reason: with
     *  `idFrom: "field"` the record's id IS the exclusivity, so a cancelled
     *  booking goes on holding the slot it no longer wants. This is the only
     *  declaration that gives the slot back without an operator.
     *
     *  What it spends is the record. The row is gone — no history of who
     *  withdrew and when, and no `mail` can be bound to the move, because the
     *  queue rule reads the document AFTER the write and there is none. An app
     *  that would rather keep the record names no status here and sends its
     *  members to the desk. */
    selfDelete: z.array(z.string().trim().min(1)).optional(),
    /** The longest value, in characters, this collection accepts in a field:
     *  `{ <field>: <chars> }`.
     *
     *  NOT A RULE, and the one place in this file where that is a design
     *  decision rather than an omission. A length test on `items` create and
     *  update is paid by EVERY app that writes a record (principle 10), and
     *  what it would buy is a bound against somebody the owner INVITED — the
     *  only people who write a long field are the participants a roster
     *  carries, and `article` collections are refused any other audience at
     *  the gate. So the cap is enforced where the writing happens: publish
     *  checks the declaration, and the host refuses the value before sending
     *  it. A participant writing straight to Firestore is not bound by it, and
     *  that is the accepted cost.
     *
     *  What it is FOR is the index, not the record. Rules cannot project a
     *  field away (principle 5), so a page reading the latest N articles
     *  downloads N BODIES — and a cap here is the only number publish can
     *  multiply by `views[].limit` to know what a reader pays on every open.
     *  See `articleBoundProblems`. */
    maxLen: z.record(z.string().trim().min(1), z.number().int().positive()).optional(),
    finalize: z.boolean().optional(),
    audience: z.literal("participant").optional(),
    gateOn: z
      .object({ phase: z.string().trim().min(1), match: z.string().trim().min(1) })
      .strict()
      .optional(),
  })
  .strict();

const PublicZ = z
  .object({
    /** The master switch. Anonymous submission (`auth: "none"`) needs it as
     *  well as its own declaration. */
    enabled: z.boolean().optional(),
    read: z.array(NameZ).optional(),
    /** The page the public sees, instead of the generated form.
     *
     *  A form is enough to ANSWER something and not enough to CHOOSE from
     *  what is available — a stylist-by-hour grid is not the far end of a
     *  table. So the app may name one HTML file, which the host publishes to
     *  `config/view` and the public page renders in a sandboxed iframe.
     *
     *  `submit` stays declared alongside: the view sends an INTENT, and the
     *  page it is embedded in performs the write against these rules.
     *
     *  `collections` is declared rather than inferred from `read`. Inferring
     *  it produces the worst failure this feature has — the view renders, the
     *  data it wanted was never sent, and it draws an empty grid with no error
     *  anywhere. */
    view: z
      .object({ path: z.string().trim().min(1), collections: z.array(NameZ).min(1), live: z.array(NameZ).min(1).optional() })
      .strict()
      .optional(),
    submit: z.record(NameZ, SubmitZ).optional(),
  })
  .strict();

/** One page the app shows, and who it is for.
 *
 *  Generalised from `public.view` (which is still accepted, and normalizes
 *  into this — see `appViews.ts`). The audience is what decides which document
 *  the HTML is published to, and therefore who may read it: a rule cannot hide
 *  a field, so "the front desk sees this" is a place, not a filter.
 *
 *  `id` is not decoration. It becomes the document id the page is published
 *  at, which is what lets one audience have more than one page — the front
 *  desk and the stock room — and what lets a withdrawn view be found and
 *  deleted. Its grammar is enforced at the gate, not here, so the refusal can
 *  say what the value is used for.
 *
 *  `collections` is declared rather than inferred, for the reason `public.view`
 *  gives: an inferred list renders a perfect page with no data in it, and
 *  nothing anywhere says why. */
const ViewZ = z
  .object({
    id: z.string().trim().min(1),
    audience: z.enum(VIEW_AUDIENCES),
    /** The HTML file this page is drawn from, relative to the repository root.
     *
     *  Optional since `type` exists, and EXACTLY ONE of the two is required —
     *  a view is either a page the author wrote or a page the platform draws.
     *  The pair is refused by `normalizeViews` rather than by zod, so the
     *  refusal can say which key to delete in the author's own words. */
    path: z.string().trim().min(1).optional(),
    /** A page the PLATFORM draws from the declaration, instead of HTML.
     *
     *  `article` is the first and, today, the only one: the collection named in
     *  `collections` holds articles, `article` below says which field is the
     *  title and which is the markdown body, and the runtime renders them —
     *  index at `/a/{slug}`, one article at `/a/{slug}/{id}`.
     *
     *  IT IS NOT A SECOND DRAWING PATH. The prohibition in
     *  mulmoterminal's `plans/feat-shared-app-platform.md` is against a naive
     *  rendering of `public.read` living beside declared views; this is a
     *  DECLARED view, judged by the same gate, published to the same document,
     *  and an app that wants a bespoke index still writes `path` and gets the
     *  sandbox. What separates them is which side authored the page, which is
     *  the distinction that has always decided this.
     *
     *  A reader that does not know this key would find no HTML and draw the
     *  GENERATED FORM in a magazine's place, so it moves the app's protocol
     *  major — see `protocolFor`. */
    type: z.literal("article").optional(),
    /** Which field of an article is which, for `type: "article"`.
     *
     *  The DATE is deliberately absent: an article is ordered and dated by
     *  `public.submit[cid].stampField`, the one field the rules pin to the
     *  server clock on create and freeze afterwards. An author-named date
     *  field would be a value the writer types, and a magazine whose running
     *  order can be typed is not one. */
    article: z
      .object({
        // FIELD NAMES, and so the same shape every other field-name key here has
        // (`emailField`, `uidField`, `stampField`, `statusField`) rather than `NameZ`.
        //
        // `NameZ` is the COLLECTION-ID grammar — letters, digits, `-` and `_` — and a schema's
        // fields are under no such rule: `headline.text`, `Article Title` and a Japanese name are
        // all legal fields that an author may reasonably want to draw an article from. Narrowing
        // them here would refuse declarations the rules and the runtime both handle, and the
        // refusal would be about a grammar that governs something else entirely.
        title: z.string().trim().min(1),
        body: z.string().trim().min(1),
        summary: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    collections: z.array(NameZ).min(1),
    /** The subset of `collections` this page watches LIVE (`onSnapshot`)
     *  instead of reading once.
     *
     *  Declared rather than left to the page, because the cost of the choice
     *  is not the page's to pay: a subscription is a read per document per
     *  change, so a public page watching a collection the public also submits
     *  into is N readers × N writers — 1000 visitors watching 1000 votes is
     *  1,000,000 reads, and each new vote is another 1000. That fan-out is
     *  refused at the gate for `audience: "public"` (see `publishChecks.ts`);
     *  the roster tiers are bounded by the roster itself and are not.
     *
     *  A SUBSET of `collections`, never a replacement for it: the datasets a
     *  view is handed are still declared once, and `live` only says which of
     *  them keep moving. */
    live: z.array(NameZ).min(1).optional(),
    /** The most recent N records of a dataset, instead of every record there
     *  is: `{ <cid>: <rows> }`, over a subset of `collections`.
     *
     *  WHAT IT IS FOR is the collection that grows forever. A view is handed
     *  its datasets whole, so a chat room's page reads every message ever
     *  posted to draw the last twenty — a bill and a payload that grow with
     *  the app's age and are paid by every reader, on every open, for rows
     *  nobody looks at. Capping what the PAGE DRAWS does not help: the read
     *  already happened.
     *
     *  IT IS THE LATEST N, NEVER THE FIRST N, and that is not a preference —
     *  it is what makes the key safe. Firestore's default order is the
     *  document id, so a bare limit returns an arbitrary N and a NEW record
     *  sorts wherever its id falls: on a chat, the page would pin itself to
     *  rows nobody chose and never show another message. So the cap travels
     *  with an ORDER, and the order is the collection's own
     *  `public.submit[cid].stampField` — the field the rules pin to the server
     *  clock on every create and freeze afterwards. A collection without one
     *  is refused the key rather than ordered by something a submitter can
     *  write (`viewLimitProblems`).
     *
     *  Which is also why the rows arrive NEWEST FIRST. A page that wants them
     *  the other way up sorts them; a page that sorts by the stamp anyway —
     *  which is every page that shows a sequence — notices nothing.
     *
     *  WHAT IT IS NOT is a permission. The rules cannot cap a read, so anybody
     *  with their own SDK reads the whole collection exactly as before; what
     *  is bounded here is what THE PLATFORM'S OWN PAGES fetch. Nor is it
     *  history: the older rows are still there, and nothing here pages back
     *  to them. */
    limit: z.record(NameZ, z.number().int().min(1)).optional(),
  })
  .strict();

/** The STANDING JOB the publisher asks an agent sitting at this app to do.
 *
 *  See `appAgents.ts` for what this is and what it deliberately is not. In
 *  short: `audience` is the same noun as `views[]` — which document the brief
 *  is published to, and therefore who may read it — and `instruction` is prose
 *  from the AUTHOR, carried to the reader labelled as a request rather than as
 *  data a stranger wrote into a record.
 *
 *  AN AGENT IS NOT A PAGE and must not borrow `path`: there is no HTML, and
 *  nothing is read off disk for it. It is also not a permission — `watch`
 *  naming a collection opens nothing, and publish refuses a brief whose
 *  audience cannot read what it names.
 *
 *  `id` carries a grammar for the same reason a view's does, and it is checked
 *  at the gate rather than here so the refusal can say what the value is for. */
const AgentZ = z
  .object({
    id: z.string().trim().min(1),
    audience: z.enum(VIEW_AUDIENCES),
    /** Plain text. Empty is refused here; oversized is refused at the gate,
     *  where the refusal can say what the cap is for. */
    instruction: z.string().trim().min(1),
    /** Collection ids this duty expects a subscription on. A subset of what
     *  this audience may READ — publish refuses the rest. */
    watch: z.array(NameZ).min(1).optional(),
    /** Collections the duty is about, when that is not what it watches.
     *  Absent, not empty, for the reason every other optional list here is:
     *  the document an app that never declared one publishes must be the
     *  document it published before this key existed. */
    collections: z.array(NameZ).min(1).optional(),
  })
  .strict();

/** The URL name an app is handed out under: `https://<host>/{slug}`.
 *
 *  A SEPARATE name from the `aid`, and that separation is the point (design
 *  D2b). `apps/{aid}` is a shelf every user of the deployment shares and the
 *  rules' `allow create` asks only that you name yourself owner — so a
 *  memorable aid is first-come-first-served, cannot be checked for
 *  availability, and frees up again when an app is deleted. The aid is
 *  therefore a UUID, and the thing people can fight over is moved to the name
 *  that costs nothing to change.
 *
 *  Declared here rather than kept beside `app.json` because a RESERVATION has
 *  to travel with the repository: `appSlugs/{slug}` is unreadable until the app
 *  is published (`allow read: if resource.data.published == true`), so nothing
 *  can recover which slug an app holds by asking Firestore. A second file to
 *  keep in step with the declaration is the alternative, and it is the kind of
 *  pair that goes out of step silently.
 *
 *  The shape is stricter than `NameZ` on purpose: it is BOTH a URL path
 *  segment people read aloud and a Firestore document id. Lowercase
 *  alphanumerics separated by single hyphens covers both without a case rule
 *  that would make two slugs collide in one place and not the other.
 *
 *  Which slug an app ended up with is the HOST's business — a wanted slug can
 *  be taken, and the host writes the one it reserved back here. Nothing in this
 *  package reads the key; it is declared so that writing it back does not make
 *  the file unparseable. */
const SLUG_SHAPE = "must be lowercase letters, digits and single hyphens, and must not start or end with one (e.g. sakura-hair)";

const SlugZ = z
  .string()
  .trim()
  .max(64)
  // Two checks rather than the obvious `^[a-z0-9]+(?:-[a-z0-9]+)*$`: that one nests a quantifier
  // inside a quantifier, which the ReDoS lint rejects. Split, neither part backtracks.
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, SLUG_SHAPE)
  .refine((slug) => !slug.includes("--"), SLUG_SHAPE);

/** The whole authored declaration.
 *
 *  `owner` is accepted and then IGNORED: the published value is the existing
 *  document's owner where there is one, and the publisher's uid otherwise
 *  (`projectApp` — the rules require it unchanged on update, so re-stamping
 *  would refuse every app whose owner once signed in as another account). The
 *  authored value is never read, never compared, and never refused. It is
 *  accepted rather than banned because the sample app.json in the design note
 *  shows it, and refusing a key the samples contain would be a worse first
 *  experience than quietly not needing it. It is also a uid rather than an
 *  address, so an author has nothing to write here that publish does not
 *  already know. */
export const AuthoredAppZ = z
  .object({
    aid: NameZ,
    name: z.string().trim().min(1).optional(),
    /** The wanted (or reserved) URL name — see {@link SlugZ}. */
    slug: SlugZ.optional(),
    /** Per-worktree app id (design D6, implementation order 7). Accepted so a
     *  repository already carrying it parses; nothing reads it yet. */
    aidEnv: z.string().trim().min(1).optional(),
    owner: z.string().trim().min(1).optional(),
    members: MembersZ,
    collections: z.record(NameZ, CollectionConfigZ).optional(),
    participantRead: z.array(NameZ).optional(),
    public: PublicZ.optional(),
    /** The app's pages, per audience. See {@link ViewZ}; `public.view` is the
     *  older spelling of the `public` one and normalizes into this list. */
    views: z.array(ViewZ).optional(),
    /** The standing jobs this app asks the agents sitting at it to do, per
     *  audience. See {@link AgentZ} and `appAgents.ts`. */
    agents: z.array(AgentZ).optional(),
    /** The version of the PUBLISH CONTRACT this app is written against — see
     *  `appProtocol.ts`. Optional, and it does not decide what is published:
     *  the projection always carries the version this compiler EMITS, because
     *  that is the one the documents keep. What declaring it does is state a
     *  FLOOR, which publish refuses to go below (`protocolProblems`): an app
     *  written for a newer contract, compiled by an older publisher, would be
     *  published as documents that quietly do not keep the promises the author
     *  relied on. */
    protocol: z.string().trim().min(1).optional(),
  })
  .strict();

export type AuthoredApp = z.infer<typeof AuthoredAppZ>;
export type AuthoredCollectionConfig = z.infer<typeof CollectionConfigZ>;
export type AuthoredSubmit = z.infer<typeof SubmitZ>;
export type AuthoredAgent = z.infer<typeof AgentZ>;
export type AuthoredMail = z.infer<typeof MailZ>;
/** One entry of `views[]` as the author wrote it. Named because the checks reach into it — the
 *  `article` block is a set of field names, and whether they exist is a fact about the SCHEMA. */
export type AuthoredView = z.infer<typeof ViewZ>;

export type AuthoredAppResult = { ok: true; app: AuthoredApp } | { ok: false; problems: string[] };

/** Parse the authored declaration out of `app.json`'s text.
 *
 *  Returns a LIST of problems rather than throwing, for the same reason
 *  `loadAppManifest` returns a failure: the caller is a gate whose entire job
 *  is to hand the author something to act on. Every problem is reported at
 *  once — publish is a manual step, and a parser that stops at the first key
 *  makes it N round trips. */
export function parseAuthoredApp(raw: string): AuthoredAppResult {
  // Reuse the one-field parse so `aid`'s rule has a single statement, and so a
  // file that is not even JSON says so in the same words discovery uses.
  const manifest: AppManifestResult = parseAppManifest(raw);
  if (!manifest.ok) return { ok: false, problems: [manifest.kind === "missing" ? "app.json is missing" : manifest.detail] };
  const parsed = AuthoredAppZ.safeParse(JSON.parse(raw));
  if (!parsed.success) return { ok: false, problems: authoredProblems(parsed.error) };
  return { ok: true, app: parsed.data };
}

/** zod issues as one actionable line each: `public.submit.responses.auth: …`. */
export function authoredProblems(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join(".") : "app.json";
    return `${where}: ${issue.message}`;
  });
}
