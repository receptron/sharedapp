// The authored → published conversion, tested AS A TABLE.
//
// Every row of the design note's conversion table gets an assertion here, and
// the reason it is worth this much attention is that each conversion's failure
// mode is silence. An ISO string that reaches Firestore does not error: it
// makes `inWindow` a type error, which denies, so the app's symptom is "nobody
// can submit" with nothing anywhere saying why. Same for `memberEmails` — a
// stale one is refused by `membersConsistent()` as a bare permission error.
//
// The projection is pure, so this file needs no filesystem, no Firestore and
// no clock: the stamp is a parameter.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AuthoredAppZ, type AuthoredApp } from "../src/publishManifest.js";
import { projectApp, projectAppViews, type PublishStamp } from "../src/publishProject.js";
import { APP_PROTOCOL, APP_PROTOCOL_BASE } from "../src/appProtocol.js";
import type { CollectionSchema } from "@mulmoclaude/core/collection";
import { byText } from "../src/byText.js";

const STAMP: PublishStamp = { uid: "uid_owner", email: "owner@salon.jp", publishedAt: 1_760_000_000_000, commit: "abc123def456" };

const SCHEMA = { title: "Bookings", icon: "event", primaryKey: "id", fields: { id: { type: "string", primary: true } } } as unknown as CollectionSchema;

/** The S1 declaration, trimmed to the keys under test. Parsed through the real
 *  zod schema rather than cast, so a fixture cannot drift from what publish
 *  would actually accept. */
function authored(overrides: Record<string, unknown> = {}): AuthoredApp {
  return AuthoredAppZ.parse({
    aid: "app_salon_7f3a",
    name: "Sakura Hair",
    members: {
      "owner@salon.jp": { "*": "owner" },
      "stylist-a@salon.jp": { bookings: "editor" },
    },
    collections: {
      bookings: {
        statusField: "status",
        submitOnly: true,
        transitions: { initial: ["pending"], pending: ["approved", "cancelled"], approved: [], cancelled: [] },
      },
    },
    public: {
      enabled: true,
      read: ["services"],
      submit: {
        bookings: {
          auth: "verifiedEmail",
          emailField: "customerEmail",
          createFields: ["customerEmail", "status"],
          initialStatus: "pending",
          window: { from: "2026-09-01T00:00:00Z", until: "2026-09-30T23:59:59Z" },
        },
      },
    },
    ...overrides,
  });
}

/** The published `public.submit[cid]` block, or a failure naming what was
 *  missing — an assertion on `undefined.window` says nothing about which half
 *  of the projection broke. */
function publishedSubmit(app: Record<string, unknown>, cid: string): Record<string, unknown> {
  const publicBlock = app.public;
  assert.ok(publicBlock !== null && typeof publicBlock === "object", "the app document has no `public` block");
  const submits = (publicBlock as { submit?: Record<string, Record<string, unknown>> }).submit;
  const submit = submits?.[cid];
  assert.ok(submit, `the app document has no public.submit.${cid}`);
  return submit;
}

test("the submit window is lowered to epoch millis", () => {
  // THE conversion. The rules do not coerce a string to a timestamp; comparing
  // an ISO string with request.time is a type error, and a rules type error
  // denies. A published `window.from` is the bug, not a stylistic difference.
  const { app } = projectApp(authored(), [], STAMP, null);
  const submit = publishedSubmit(app, "bookings");
  assert.deepEqual(submit.window, { fromMs: Date.parse("2026-09-01T00:00:00Z"), untilMs: Date.parse("2026-09-30T23:59:59Z") });
  assert.deepEqual(Object.keys(submit.window as object).sort(byText), ["fromMs", "untilMs"], "the ISO form must not survive alongside the millis");
});

test("a submit that declares no window publishes NO window key, not an empty one", () => {
  // `{}` and absent are different documents to the rules: a present `window` says a window was
  // declared, and one carrying neither bound reads as a declaration with nothing in it. The
  // projection drops the key by returning `undefined` into `compact`, and returning `{}` there
  // instead left the whole suite green — so this pins the ABSENCE rather than the shape.
  const app = authored({
    public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["customerEmail"] } } },
  });
  const projected = projectApp(app, [], STAMP, null);
  const submit = publishedSubmit(projected.app, "bookings");
  assert.equal("window" in submit, false, "an undeclared window must not appear as an empty object");
});

test("a one-sided window publishes only the bound that was declared", () => {
  // `inWindow` defaults the missing bound (0 / MAX_SAFE_INTEGER). Publishing a
  // zero for an undeclared `from` would work by accident today and break the
  // moment the default changes.
  const app = authored({
    public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["customerEmail"], window: { until: "2026-12-31T23:59:59Z" } } } },
  });
  const projected = projectApp(app, [], STAMP, null);
  const submit = publishedSubmit(projected.app, "bookings");
  assert.deepEqual(submit.window, { untilMs: Date.parse("2026-12-31T23:59:59Z") });
});

test("a per-record window bound survives the lowering that has nothing to lower", () => {
  // `fromField` names a field on ANOTHER record and the value it points at is
  // already epoch millis, so there is no conversion — which is exactly how a
  // key gets dropped by a function whose job is converting. Dropped, the rules
  // stop seeing a bound the author declared and the window is silently OPEN.
  const app = authored({
    public: {
      submit: {
        bookings: {
          auth: "verifiedEmail",
          createFields: ["customerEmail", "classId"],
          window: { until: "2026-12-31T23:59:59Z", fromField: { ref: "classId", collection: "services", field: "opensAt" } },
        },
      },
    },
  });
  const submit = publishedSubmit(projectApp(app, [], STAMP, null).app, "bookings");
  assert.deepEqual(submit.window, {
    untilMs: Date.parse("2026-12-31T23:59:59Z"),
    fromField: { ref: "classId", collection: "services", field: "opensAt" },
  });
});

test("BOTH per-record bounds survive it, and the closing one is the easier to lose", () => {
  // `untilField` arrived after `fromField` and reads identically, which is
  // precisely how the second one gets left out of a function that names the
  // first. Dropped, the desk that opens per slot never closes: every slot goes
  // on taking bookings after its deadline, and the declaration says otherwise.
  const app = authored({
    public: {
      submit: {
        bookings: {
          auth: "verifiedEmail",
          createFields: ["customerEmail", "slot"],
          idFrom: "field",
          idField: "slot",
          idIn: { collection: "slots", where: { field: "state", equals: "open" } },
          mirror: "slots",
          window: {
            fromField: { ref: "slot", collection: "slots", field: "opensAt" },
            untilField: { ref: "slot", collection: "slots", field: "closesAt" },
          },
        },
      },
    },
  });
  const submit = publishedSubmit(projectApp(app, [], STAMP, null).app, "bookings");
  assert.deepEqual(submit.window, {
    fromField: { ref: "slot", collection: "slots", field: "opensAt" },
    untilField: { ref: "slot", collection: "slots", field: "closesAt" },
  });
  // The keys the rules read for exclusivity pass through untouched — there is
  // nothing to lower, and dropping any of them turns "one booking per slot"
  // into "any string a submitter likes" with no error anywhere.
  assert.equal(submit.idFrom, "field");
  assert.equal(submit.idField, "slot");
  assert.deepEqual(submit.idIn, { collection: "slots", where: { field: "state", equals: "open" } });
  assert.equal(submit.mirror, "slots");
});

test("the public view reaches the CONFIG document, and only that one", () => {
  // Two halves of one requirement, which is why they are one test. The rules'
  // app document is read on every single write and has no use for a view, so
  // it must not carry one. The world-readable config document is the ONLY
  // place the public page can learn that a view exists and what to send it —
  // omit it there and the page has HTML it cannot feed, which is the feature
  // not working at all rather than a missing extra.
  const app = authored({
    public: { enabled: true, read: ["slots"], view: { path: "views/booking.html", collections: ["slots"] } },
  });
  const projected = projectApp(app, [], STAMP, null);
  assert.deepEqual((projected.app as Record<string, Record<string, unknown>>).public, { enabled: true, read: ["slots"] });
  assert.deepEqual(projected.config.view, { collections: ["slots"] });
  // The authored PATH names a file in the author's repository. The browser
  // cannot use it and nobody should be handed it on a document whose rule is
  // `allow read: if true`.
  assert.equal(JSON.stringify(projected.config).includes("views/booking.html"), false);
});

test("memberEmails is derived from members, and a hand-written one is overwritten", () => {
  // `membersConsistent()` refuses any write where the two disagree, so an
  // authored value could only ever turn publish into a bare permission error.
  const { app } = projectApp(authored(), [], STAMP, null);
  assert.deepEqual(app.memberEmails, ["owner@salon.jp", "stylist-a@salon.jp"]);
  assert.deepEqual(Object.keys(app.members as object).sort(byText), app.memberEmails);
});

test("public.read stays a list — the shape the rules were tested against", () => {
  // `cid in list` and `cid in map` both work in the rules language. Two
  // spellings that both work is how the two repositories drift, so the
  // published form is the authored form, and the emulator test pins it.
  const { app } = projectApp(authored(), [], STAMP, null);
  assert.deepEqual((app.public as Record<string, unknown>).read, ["services"]);
});

test("owner is stamped on create and carried forward on update", () => {
  // The rules require `owner == request.auth.uid` on create and `owner`
  // UNCHANGED on update. Re-stamping the publisher would make every publish by
  // a second owner-role account fail, and would silently transfer ownership if
  // it did not.
  const created = projectApp(authored(), [], STAMP, null);
  assert.equal(created.app.owner, "uid_owner");

  const updated = projectApp(authored(), [], { ...STAMP, uid: "uid_someone_else" }, { owner: "uid_owner", members: {} });
  assert.equal(updated.app.owner, "uid_owner");
});

test("the previous document is kept for rollback, one level deep", () => {
  // Chaining would carry the app's whole history inside one document and meet
  // Firestore's 1 MiB limit as an unexplained failure at some later publish.
  const first = projectApp(authored(), [], STAMP, null);
  const second = projectApp(authored(), [], { ...STAMP, publishedAt: STAMP.publishedAt + 1000 }, first.app);
  const previous = second.app.previousPublished as Record<string, unknown>;
  assert.equal(previous.publishedAt, STAMP.publishedAt);
  assert.equal("previousPublished" in previous, false);

  const third = projectApp(authored(), [], { ...STAMP, publishedAt: STAMP.publishedAt + 2000 }, second.app);
  const thirdPrevious = third.app.previousPublished as Record<string, unknown>;
  assert.equal("previousPublished" in thirdPrevious, false, "the chain must not grow");
});

test("publishing the same declaration twice changes only the timestamp", () => {
  // Idempotence. If this fails, `previousPublished` grows, or a map/array
  // ordering is unstable, and every publish is a diff for readers watching the
  // document.
  const first = projectApp(authored(), [{ cid: "bookings", schema: SCHEMA }], STAMP, null);
  const second = projectApp(authored(), [{ cid: "bookings", schema: SCHEMA }], { ...STAMP, publishedAt: STAMP.publishedAt + 5 }, first.app);
  const { publishedAt: __firstAt, previousPublished: __firstPrev, ...firstRest } = first.app;
  const { publishedAt: __secondAt, previousPublished: __secondPrev, ...secondRest } = second.app;
  assert.deepEqual(secondRest, firstRest);
});

test("undeclared keys are absent, not present-and-undefined", () => {
  // Every optional key in the rules is read through `"k" in c`, so a key
  // written with an undefined value would flip a check the author never made.
  // Firestore rejects undefined outright as well.
  const bare = AuthoredAppZ.parse({ aid: "app_bare", members: { "owner@salon.jp": { "*": "owner" } } });
  const { app } = projectApp(bare, [], { ...STAMP, commit: undefined }, null);
  for (const key of ["name", "collections", "participantRead", "public", "publishedCommit", "previousPublished"]) {
    assert.equal(key in app, false, `${key} must be absent`);
  }
});

test("the schema is published whole, beside the config the rules read", () => {
  // The rules never read `publishedSchema` — clients do, and a public webview
  // has no other way to learn the fields.
  const { schemas } = projectApp(authored(), [{ cid: "bookings", schema: SCHEMA }], STAMP, null);
  assert.equal(schemas.length, 1);
  const [only] = schemas;
  assert.ok(only);
  assert.equal(only.cid, "bookings");
  assert.deepEqual(only.doc.publishedSchema, SCHEMA);
  assert.equal(only.doc.publishedBy, "owner@salon.jp");
});

test("the public config document carries no roster", () => {
  // `apps/{aid}/config/{docId}` is `allow read: if true`. It exists so a
  // public form can render itself; the roster is the reason `apps/{aid}`
  // itself is reader-only.
  const { config } = projectApp(authored(), [], STAMP, null);
  assert.equal("members" in config, false);
  assert.equal("memberEmails" in config, false);
  assert.equal("owner" in config, false);
  assert.equal(config.enabled, true);
  assert.deepEqual(config.read, ["services"]);
  // The window a visitor's form needs is the lowered one, same as the app doc.
  const { bookings } = config.submit;
  assert.ok(bookings);
  assert.deepEqual(bookings.window, { fromMs: Date.parse("2026-09-01T00:00:00Z"), untilMs: Date.parse("2026-09-30T23:59:59Z") });
});

test("every projection states the contract it was written against", () => {
  // The reader (mulmoserver) is released separately from this compiler and runs in browsers that may
  // be a month behind. This number is the only thing in the documents that lets such a build know it
  // must NOT draw them — so it rides in the public config and in every tier, from one publish.
  const app = authored();
  const { config } = projectApp(app, [], STAMP, null);
  assert.equal(config.protocol, APP_PROTOCOL_BASE);
  for (const tier of projectAppViews(app, STAMP)) {
    assert.equal(tier.config.protocol, APP_PROTOCOL_BASE, `${tier.tier} states no contract`);
  }
});

test("an app using uidField is stamped the same contract as one that does not", () => {
  // Deliberately not a version of its own. Adding a key an older reader may IGNORE does not move
  // the number (see `appProtocol.ts`), and stamping uid apps apart would have refused them on every
  // older reader — which they already refuse, on the shape, through the submit/form consistency
  // check. Contrast the article view below, which an older reader cannot ignore: it would draw the
  // generated form in the page's place.
  const app = AuthoredAppZ.parse({
    ...authored(),
    public: { enabled: true, submit: { claims: { auth: "verifiedEmail", uidField: "uid", createFields: ["taskId", "uid"] } } },
  });
  assert.equal(projectApp(app, [], STAMP, null).config.protocol, APP_PROTOCOL_BASE);
  for (const tier of projectAppViews(app, STAMP)) {
    assert.equal(tier.config.protocol, APP_PROTOCOL_BASE, `${tier.tier} states the wrong contract`);
  }
});

test("an app with an article view is stamped the newer contract, and it alone", () => {
  // The reader must UNDERSTAND `views[].type` to be correct — without it there is no HTML to find,
  // so an older build concludes the app publishes no view and draws the generated form. That is a
  // different app on the visitor's screen with nothing erroring, which is what the major is for.
  const app = AuthoredAppZ.parse({
    ...authored(),
    public: { enabled: true, read: ["articles"], submit: {} },
    views: [{ id: "public", audience: "public", type: "article", collections: ["articles"], article: { title: "title", body: "body" } }],
  });
  assert.equal(projectApp(app, [], STAMP, null).config.protocol, APP_PROTOCOL);
  assert.notEqual(APP_PROTOCOL, APP_PROTOCOL_BASE);
  // The app next to it in the same deployment is untouched. This is the whole reason the stamp is
  // computed per app rather than bumped as a constant.
  assert.equal(projectApp(authored(), [], STAMP, null).config.protocol, APP_PROTOCOL_BASE);
});

test("the app's hue reaches the drawn page, and leaves the protocol alone", () => {
  // ON THE VIEW, because what reads it is the runtime drawing that page — a colour parked at the
  // top of the document would be one more place every reader has to look.
  const withHue = AuthoredAppZ.parse({
    ...authored(),
    theme: { hue: 200 },
    public: { enabled: true, read: ["articles"], submit: {} },
    views: [{ id: "public", audience: "public", type: "article", collections: ["articles"], article: { title: "title", body: "body" } }],
  });
  const config = projectApp(withHue, [], STAMP, null).config;
  assert.equal(config.view?.hue, 200);
  // NOT a protocol move, and the asymmetry is the point: a reader too old to know `hue` draws the
  // page in its own colours, which is still the page. One too old to know `type` draws the
  // generated form in a magazine's place, which is not — so that one moves the major and this
  // does not. Pinned here because the two keys arrive on the same document.
  assert.equal(config.protocol, APP_PROTOCOL);
});

test("an app that declares no hue publishes the document it published before the key existed", () => {
  const config = projectApp(
    AuthoredAppZ.parse({
      ...authored(),
      public: { enabled: true, read: ["articles"], submit: {} },
      views: [{ id: "public", audience: "public", type: "article", collections: ["articles"], article: { title: "title", body: "body" } }],
    }),
    [],
    STAMP,
    null,
  ).config;
  assert.equal("hue" in (config.view ?? {}), false);
});

test("what is published is the contract this compiler emits, not the author's declaration", () => {
  // The authored `protocol` is a FLOOR (see `protocolProblems`), and the documents keep whatever
  // produced them. Publishing the author's number instead would let an app claim a contract its
  // documents do not honour, under a version a reader believes.
  const declared = AuthoredAppZ.parse({ ...authored(), protocol: "1.0.0" });
  assert.equal(projectApp(declared, [], STAMP, null).config.protocol, APP_PROTOCOL_BASE);
  // And the other direction, which is the one the floor makes tempting: an author who names a
  // contract they use nothing from has not made their app need a newer reader, so the documents
  // must not say they do — the stamp is a statement about the documents.
  const asked = AuthoredAppZ.parse({ ...authored(), protocol: "1.0.0" });
  assert.equal(projectApp(asked, [], STAMP, null).config.protocol, APP_PROTOCOL_BASE);
});

test("the public config says what a visitor may change about their own row", () => {
  // It goes on the world-readable document because that is where the public page reads its
  // declaration, and it is safe to put there for the reason it exists: the moves are the ones
  // `firestore.rules` already grants any authenticated submitter over `ownRow`, declared by the
  // author under `public.submit[cid]`. Nothing here grants anything — it tells the page which
  // buttons exist, so a control is drawn where the rules would allow it and nowhere else.
  const cancellable = authored({
    public: {
      enabled: true,
      read: ["services"],
      submit: {
        bookings: {
          auth: "verifiedEmail",
          emailField: "customerEmail",
          createFields: ["customerEmail", "status"],
          initialStatus: "pending",
          selfTransitions: { pending: ["cancelled"] },
        },
      },
    },
  });
  const { config } = projectApp(cancellable, [], STAMP, null);
  const bookings = config.write?.find((entry) => entry.cid === "bookings");
  assert.ok(bookings, "a collection with self-writes must be projected to the page that submits to it");
  assert.equal(bookings.statusField, "status");
  assert.deepEqual(bookings.transitions, { pending: ["cancelled"] });
  // And NOT the staff half: no roster travels on a world-readable document.
  assert.equal(bookings.writers, undefined);
  assert.equal(bookings.assigneeField, undefined);
});

test("an app with nothing a visitor may change carries no write key at all", () => {
  // Absent rather than empty, like every other projection here: an entry is what a page draws a
  // button from, and `[]` would be a claim where silence is the truth. It is also what every
  // document published before this key existed looks like, which `projectedWritesOf` reads back as
  // "nothing writable" — the same answer those apps have today.
  const readOnly = AuthoredAppZ.parse({
    ...authored(),
    collections: { bookings: { statusField: "status" } },
    public: { enabled: true, read: ["services"], submit: {} },
  });
  assert.equal("write" in projectApp(readOnly, [], STAMP, null).config, false);
});
