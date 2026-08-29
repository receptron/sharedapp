// `views[].ownRead` — the opt-in that narrows ONE participant page to the reader's own rows.
//
// The default it overrides is deliberate and stays: a collection the app publishes to the world
// resolves to `scope: "all"` for a participant, because the rows are public and a page showing the
// reader less would be hiding what a stranger can read. What that default cannot express is a
// writers' desk — the page whose job is "what did I publish, so I can correct it" — where the whole
// collection is a read that grows with the archive to draw a list that does not.
//
// THE POINT TO PIN is that this narrows a QUERY and never a permission. The rows stay exactly as
// readable as they were, and the proof is that the projection contains no new vocabulary: the
// result is `scope: "own"` with the same selector every reader has honoured since the first
// release. A gate that accepted the key and projected nothing would satisfy a file of refusals and
// leave the feature doing nothing, so every refusal below is paired with the neighbouring
// declaration that must still publish, and with what the projection then says.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AuthoredAppZ } from "../src/publishManifest.js";
import { normalizeViews, participantScope, ownScope } from "../src/appViews.js";
import { publishProblems } from "../src/publishChecks.js";
import { projectAppViews } from "../src/publishProject.js";

const OWNER = "editor@journal.jp";
const STAMP = { publishedAt: 1_700_000_000_000, email: OWNER, uid: "u-owner" };
const CIDS = [
  { cid: "articles", primaryKey: "id" },
  { cid: "notes", primaryKey: "id" },
];

const app = (overrides: Record<string, unknown>) =>
  AuthoredAppZ.parse({
    aid: "app_own_read",
    members: { [OWNER]: { "*": "owner", articles: "participant" }, "writer@journal.jp": { articles: "participant" } },
    ...overrides,
  });

const problemsFor = (overrides: Record<string, unknown>): string[] => publishProblems(app(overrides), CIDS, OWNER);

function refuses(problems: string[], fragment: string): void {
  const bullets = problems.map((problem) => `  - ${problem}`).join("\n");
  assert.ok(
    problems.some((problem) => problem.includes(fragment)),
    `expected a problem mentioning ${JSON.stringify(fragment)}, got:\n${bullets || "  (none)"}`,
  );
}

/** A magazine: `articles` is published to the world AND submitted to by the roster, which is the
 *  exact shape whose participant scope widens to `all` before any own-row branch is reached. */
const magazine = (views: Record<string, unknown>[]): Record<string, unknown> => ({
  collections: { articles: { statusField: "status", submitOnly: true } },
  public: {
    enabled: true,
    read: ["articles"],
    submit: {
      articles: {
        auth: "verifiedEmail",
        audience: "participant",
        uidField: "byUid",
        createFields: ["slug", "title", "body", "byUid", "status", "publishedAt"],
        initialStatus: "published",
        idFrom: "slug",
        idField: "slug",
        stampField: "publishedAt",
      },
    },
  },
  views,
});

const desk = (view: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "write",
  audience: "participant",
  path: "views/desk.html",
  collections: ["articles"],
  ...view,
});

/** One audience's projected views, as they are published. */
const viewsOf = (overrides: Record<string, unknown>, audience: "member" | "participant") =>
  projectAppViews(app(overrides), STAMP).find((tier) => tier.audience === audience)?.config.views ?? [];

/** The scope that projection gives one collection on one page. */
const scopeIn = (views: ReturnType<typeof viewsOf>, viewId: string, cid: string) =>
  views.find((view) => view.id === viewId)?.collections.find((entry) => entry.cid === cid);

// --- the default this key overrides ----------------------------------------

test("without the key, a participant reads a PUBLIC collection whole", () => {
  // Not a quirk to route around — the second branch of `participantScope`, and the reason it is
  // there: the rows are world-readable, so narrowing them by default would hide from the writer
  // what any stranger can read.
  assert.deepEqual(participantScope(app(magazine([desk()])), "articles", []), { cid: "articles", scope: "all" });
});

test("`ownScope` answers the same question with the widening branches skipped", () => {
  // Split out of `participantScope` rather than copied: the query `ownRead` hands a page must be
  // the one the rules grant, and a second copy of those three lines is where that stops being true.
  assert.deepEqual(ownScope(app(magazine([desk()])), "articles"), { cid: "articles", scope: "own", uidField: "byUid" });
});

// --- the declaration --------------------------------------------------------

test("`ownRead` parses and survives normalization", () => {
  // `.strict()` means an app.json writing this key does not parse at all until it exists.
  const authored = normalizeViews(app(magazine([desk({ ownRead: ["articles"] })])));
  assert.ok(authored.ok);
  assert.deepEqual(authored.views[0]?.ownRead, ["articles"]);
});

test("a view that declares no `ownRead` normalizes without the key at all", () => {
  // Absent, not empty: an app that never asked for this must project byte-for-byte what it
  // projected before the key existed, and `{}` vs `{ownRead: []}` is a changed document.
  const result = normalizeViews(app(magazine([desk()])));
  assert.ok(result.ok);
  assert.ok(!("ownRead" in (result.views[0] ?? {})));
});

// --- what it projects -------------------------------------------------------

test("the opt-in narrows the participant page's query, and nothing else", () => {
  const opted = viewsOf(magazine([desk({ ownRead: ["articles"] })]), "participant");
  assert.deepEqual(scopeIn(opted, "write", "articles"), { cid: "articles", scope: "own", uidField: "byUid" });

  // NO NEW VOCABULARY. `scope: "own"` with a selector is what every reader has built a `where`
  // from since the first release, so a host that has never heard of `ownRead` narrows correctly —
  // which is why this key does not move APP_PROTOCOL.
  const plain = viewsOf(magazine([desk()]), "participant");
  assert.deepEqual(scopeIn(plain, "write", "articles"), { cid: "articles", scope: "all" });
});

test("one page may narrow while another page of the same app reads whole", () => {
  // The reason the key is on the VIEW and not on the app: a writers' desk and a directory are both
  // participant pages, and `participantRead` cannot say two different things about one collection.
  const docs = viewsOf(magazine([desk({ id: "write", ownRead: ["articles"] }), desk({ id: "directory", path: "views/all.html" })]), "participant");
  assert.deepEqual(scopeIn(docs, "write", "articles"), { cid: "articles", scope: "own", uidField: "byUid" });
  assert.deepEqual(scopeIn(docs, "directory", "articles"), { cid: "articles", scope: "all" });
});

test("the member tier is untouched by a participant page's opt-in", () => {
  // `/m/` is a different view at a different tier, and the owner's desk still reads the archive
  // whole. An opt-in that leaked across tiers would take the editor's own view away.
  const docs = viewsOf(
    magazine([desk({ ownRead: ["articles"] }), { id: "desk", audience: "member", path: "views/desk.html", collections: ["articles"] }]),
    "member",
  );
  assert.deepEqual(scopeIn(docs, "desk", "articles"), { cid: "articles", scope: "all" });
});

test("a live subscription rides the narrowed query", () => {
  // `live` is a subset of `collections`, not of the widened read, so the pair is legal — and the
  // subscription a host opens is built from the same constraints as the read.
  const problems = problemsFor(magazine([desk({ ownRead: ["articles"], live: ["articles"] })]));
  assert.deepEqual(problems, []);
  const docs = viewsOf(magazine([desk({ ownRead: ["articles"], live: ["articles"] })]), "participant");
  assert.deepEqual(scopeIn(docs, "write", "articles"), { cid: "articles", scope: "own", uidField: "byUid" });
});

// --- what it refuses --------------------------------------------------------

test("a declaration that opts in publishes", () => {
  // The pair to every refusal below. A gate that refused them all would pass its own suite.
  assert.deepEqual(problemsFor(magazine([desk({ ownRead: ["articles"] })])), []);
});

test("`ownRead` naming a dataset the view was never handed is refused", () => {
  refuses(problemsFor(magazine([desk({ ownRead: ["notes"] })])), "ownRead names 'notes', which is not in views[0].collections");
});

test("`ownRead` on a member or public page is refused", () => {
  // Neither tier has an owner to narrow to: a member reads the collection whole because that is
  // what the tier is for, and a public visitor may be nobody at all.
  refuses(
    problemsFor(magazine([{ id: "desk", audience: "member", path: "views/desk.html", collections: ["articles"], ownRead: ["articles"] }])),
    "ownRead names 'articles' on an audience of \"member\"",
  );
  refuses(
    problemsFor(magazine([{ id: "public", audience: "public", path: "views/home.html", collections: ["articles"], ownRead: ["articles"] }])),
    "ownRead names 'articles' on an audience of \"public\"",
  );
});

test("`ownRead` on a collection with no way to say whose a row is, is refused", () => {
  // THE ONE THAT WOULD BE SILENT. With no selector the scope is null, `tierViews` drops the
  // collection, and the page is handed no dataset at all — less than the whole it asked to trim.
  const anonymous = {
    collections: { articles: { statusField: "status" } },
    public: {
      enabled: true,
      read: ["articles"],
      submit: { articles: { auth: "none", createFields: ["title", "status"], initialStatus: "published" } },
    },
    views: [desk({ ownRead: ["articles"] })],
  };
  refuses(problemsFor(anonymous), "nothing in public.submit.articles says which rows are the reader's");
});

test("a cap on a page that opted in is refused, and the same cap without the opt-in is not", () => {
  // The rule already existed for a participant whose collection was private; the opt-in creates
  // the same situation on a PUBLIC one, so the check has to ask about this view rather than the
  // app. An own-row query already carries a `where`, and ordering it needs a composite index no
  // deployment declares — the read fails rather than returning fewer rows.
  refuses(problemsFor(magazine([desk({ ownRead: ["articles"], limit: { articles: 10 } })])), "which a participant reads as their OWN ROWS");
  assert.deepEqual(problemsFor(magazine([desk({ limit: { articles: 10 } })])), []);
});
