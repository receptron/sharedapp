// `views[].live` — which datasets a page WATCHES, and the fan-out publish refuses.
//
// Nobody subscribes yet. What is pinned here is the declaration, the refusal and the
// projection — the three things the host and the server read as their input, which is why
// they land first (receptron/mulmoterminal#1785).
//
// Every refusal below is paired with the neighbouring declaration that must still publish.
// A gate that refused every `live` would satisfy a file of refusals and would also make the
// feature impossible, and from inside its own suite the two look identical.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AuthoredAppZ } from "../src/publishManifest.js";
import { normalizeViews } from "../src/appViews.js";
import { publishProblems } from "../src/publishChecks.js";
import { projectApp, projectAppViews } from "../src/publishProject.js";

const OWNER = "owner@poll.jp";
const STAMP = { publishedAt: 1_700_000_000_000, email: OWNER, uid: "u-owner" };
const CIDS = [
  { cid: "questions", primaryKey: "id" },
  { cid: "votes", primaryKey: "id" },
  { cid: "slots", primaryKey: "id" },
  { cid: "bookings", primaryKey: "id" },
];

const app = (overrides: Record<string, unknown>) => AuthoredAppZ.parse({ aid: "app_live", members: { [OWNER]: { "*": "owner" } }, ...overrides });

const problemsFor = (overrides: Record<string, unknown>): string[] => publishProblems(app(overrides), CIDS, OWNER);

function refuses(problems: string[], fragment: string): void {
  const bullets = problems.map((problem) => `  - ${problem}`).join("\n");
  assert.ok(
    problems.some((problem) => problem.includes(fragment)),
    `expected a problem mentioning ${JSON.stringify(fragment)}, got:\n${bullets || "  (none)"}`,
  );
}

/** A poll: `questions` is published to the world and written by nobody but the app;
 *  `votes` is what the public submits. The interesting pair is exactly those two. */
const poll = (view: Record<string, unknown>): Record<string, unknown> => ({
  collections: { votes: { submitOnly: true, statusField: "state", transitions: { initial: ["cast"] } } },
  public: {
    enabled: true,
    read: ["questions", "votes"],
    submit: { votes: { auth: "verifiedEmail", emailField: "voter", createFields: ["choice", "voter", "state"], initialStatus: "cast" } },
  },
  views: [{ id: "public", audience: "public", path: "views/poll.html", collections: ["questions", "votes"], ...view }],
});

// --- the declaration --------------------------------------------------------

test("`live` parses, in both spellings of the same declaration", () => {
  // `.strict()` means an app.json writing this key does not parse at all until it exists,
  // which is why this comes before anything can subscribe.
  const authored = normalizeViews(app(poll({ live: ["questions"] })));
  assert.ok(authored.ok);
  assert.deepEqual(authored.views[0]?.live, ["questions"]);

  const legacy = normalizeViews(app({ public: { view: { path: "views/poll.html", collections: ["questions"], live: ["questions"] } } }));
  assert.ok(legacy.ok);
  assert.deepEqual(legacy.views[0]?.live, ["questions"]);
});

test("a view that declares no `live` normalizes without the key at all", () => {
  // Absent, not empty: the projection of an app that never wrote the key must be what it
  // was before the key existed, and `{}` vs `{live: []}` is a changed document.
  const result = normalizeViews(app(poll({})));
  assert.ok(result.ok);
  assert.equal("live" in (result.views[0] ?? {}), false);
});

test("an empty `live` is refused at the parser — it means nothing the absent key does not", () => {
  assert.throws(() => app(poll({ live: [] })));
});

// --- what publish refuses ---------------------------------------------------

test("a public page may watch a collection only the app writes", () => {
  // The acceptance this whole file exists to protect: `questions` is world-readable and
  // nobody but the author writes it, so the fan-out is N readers x (however often the
  // author edits the question), which is not a fan-out.
  assert.deepEqual(problemsFor(poll({ live: ["questions"] })), []);
});

test("refuses a public page watching a collection the public submits into", () => {
  refuses(problemsFor(poll({ live: ["questions", "votes"] })), "1,000,000 reads");
  refuses(problemsFor(poll({ live: ["votes"] })), "public.submit.votes");
});

test("the refusal names the alternative, not only the danger", () => {
  // The author declaring this is acting in good faith — they want the tally to move. A
  // refusal that does not say where the moving picture belongs just loses the feature.
  refuses(problemsFor(poll({ live: ["votes"] })), "/m/{slug}");
});

test("refuses a public page watching a MIRROR of a collection the public submits into", () => {
  // The mirror is written in the same batch as each booking, so it moves once per public
  // write exactly as the records do — N->N through the one collection put in front of them.
  const salon = (live: string[]): Record<string, unknown> => ({
    collections: { bookings: { submitOnly: true }, slots: { mirrorOf: "bookings" } },
    public: {
      enabled: true,
      read: ["slots"],
      submit: { bookings: { auth: "verifiedEmail", emailField: "who", createFields: ["slot", "who"], idFrom: "field", idField: "slot", mirror: "slots" } },
    },
    views: [{ id: "public", audience: "public", path: "views/booking.html", collections: ["slots"], live }],
  });
  refuses(problemsFor(salon(["slots"])), "mirrorOf");
  refuses(problemsFor(salon(["slots"])), "1,000,000 reads");
});

test("the roster tiers may watch anything they are handed — the roster is the bound", () => {
  // A member page watching the votes is N->1: the readers are enumerated in `members`, so
  // there is no fan-out to refuse, and the moving picture is what those pages are for.
  assert.deepEqual(
    problemsFor({
      ...poll({}),
      participantRead: ["votes"],
      views: [
        { id: "desk", audience: "member", path: "views/desk.html", collections: ["votes"], live: ["votes"] },
        { id: "mine", audience: "participant", path: "views/mine.html", collections: ["votes"], live: ["votes"] },
      ],
    }),
    [],
  );
});

test("refuses watching a dataset the view was never handed", () => {
  refuses(problemsFor(poll({ live: ["slots"] })), "which is not in views[0].collections");
  // And accepts the subset that IS handed — `live` is a subset, never a second list.
  assert.deepEqual(problemsFor(poll({ live: ["questions"] })), []);
});

// --- what publish writes ----------------------------------------------------

const projected = (overrides: Record<string, unknown>) => projectApp(app(overrides), [], STAMP, null).config;

test("the public page's `live` reaches the world-readable config, as cid names", () => {
  // The page has no other way to learn it: the app document is reader-only. What lands is
  // the cid names, which `collections` beside it already carries — nothing new is disclosed.
  assert.deepEqual(projected(poll({ live: ["questions"] })).view, { collections: ["questions", "votes"], live: ["questions"] });
});

test("an app with no `live` publishes exactly the document it published before the key existed", () => {
  assert.deepEqual(projected(poll({})).view, { collections: ["questions", "votes"] });
  assert.equal("live" in (projected(poll({})).view ?? {}), false);
});

test("each tier's projection carries its own `live`", () => {
  const tiers = projectAppViews(
    app({
      ...poll({}),
      participantRead: ["votes"],
      views: [
        { id: "desk", audience: "member", path: "views/desk.html", collections: ["questions", "votes"], live: ["votes"] },
        { id: "mine", audience: "participant", path: "views/mine.html", collections: ["votes"] },
      ],
    }),
    STAMP,
  );
  assert.deepEqual(tiers.find((tier) => tier.audience === "member")?.config.views, [
    {
      id: "desk",
      collections: [
        { cid: "questions", scope: "all" },
        { cid: "votes", scope: "all" },
      ],
      live: ["votes"],
    },
  ]);
  // The one that declared nothing keeps the shape it had before this key existed.
  assert.deepEqual(tiers.find((tier) => tier.audience === "participant")?.config.views, [{ id: "mine", collections: [{ cid: "votes", scope: "all" }] }]);
});

test("a tier drops a `live` cid it is not handed a query for", () => {
  // The scope is dropped above when the audience cannot read the collection; naming it in
  // `live` anyway would tell the page to subscribe to a query it never got.
  const tiers = projectAppViews(
    app({
      collections: { ledger: {} },
      views: [{ id: "mine", audience: "participant", path: "views/mine.html", collections: ["ledger"], live: ["ledger"] }],
    }),
    STAMP,
  );
  assert.deepEqual(tiers.find((tier) => tier.audience === "participant")?.config.views, [{ id: "mine", collections: [] }]);
});
