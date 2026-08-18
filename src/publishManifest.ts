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
    createFields: z.array(z.string().trim().min(1)).min(1),
    initialStatus: z.string().trim().min(1).optional(),
    /** `field` is the mode that makes a CONTESTED resource exclusive: the
     *  booking's document id IS the slot's id, so the second person to want
     *  that slot is writing a document that already exists — an update, which
     *  the public submission path never allows. Firestore decides that
     *  atomically, so unlike a countable capacity (see `stampField`) this is
     *  first-come ENFORCED rather than first-come read off a rank. */
    idFrom: z.enum(["auto", "auth.uid", "auth.uid+field", "field"]).optional(),
    idField: z.string().trim().min(1).optional(),
    /** Required by `idFrom: "field"` — see {@link IdInZ}. */
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
    path: z.string().trim().min(1),
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
 *  `owner` is accepted but is NOT the published value — publish stamps the
 *  publisher's uid (or carries the existing one forward, which is what the
 *  rules require on update) and refuses a declaration that disagrees. It is
 *  accepted rather than banned because the sample app.json in the design note
 *  shows it, and a hard refusal on a key the samples contain would be a worse
 *  first experience than a message naming the mismatch. */
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
export type AuthoredMail = z.infer<typeof MailZ>;

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
