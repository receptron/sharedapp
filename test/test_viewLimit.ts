// `views[].limit` — the LATEST N of a dataset, instead of every record there is.
//
// The key exists for the collection that grows forever: a chat room's page is handed every
// message ever posted to draw the last twenty, and the bill grows with the app's age. Capping
// what the page DRAWS does not help — the read already happened.
//
// What is pinned here is the declaration, the three refusals and the projection. Each refusal
// is paired with the neighbouring declaration that must still publish: a gate that refused
// every `limit` would satisfy a file of refusals and would also make the feature impossible,
// and from inside its own suite the two look identical.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AuthoredAppZ } from "../src/publishManifest.js";
import { normalizeViews } from "../src/appViews.js";
import { publishProblems } from "../src/publishChecks.js";
import { projectApp, projectAppViews } from "../src/publishProject.js";

const OWNER = "owner@chat.jp";
const STAMP = { publishedAt: 1_700_000_000_000, email: OWNER, uid: "u-owner" };
const CIDS = [
  { cid: "messages", primaryKey: "id" },
  { cid: "notes", primaryKey: "id" },
  { cid: "votes", primaryKey: "id" },
];

const app = (overrides: Record<string, unknown>) => AuthoredAppZ.parse({ aid: "app_limit", members: { [OWNER]: { "*": "owner" } }, ...overrides });

const problemsFor = (overrides: Record<string, unknown>): string[] => publishProblems(app(overrides), CIDS, OWNER);

function refuses(problems: string[], fragment: string): void {
  const bullets = problems.map((problem) => `  - ${problem}`).join("\n");
  assert.ok(
    problems.some((problem) => problem.includes(fragment)),
    `expected a problem mentioning ${JSON.stringify(fragment)}, got:\n${bullets || "  (none)"}`,
  );
}

/** A members-only chat room: every message is bound to the member who posted it, and the
 *  rules stamp `postedAt` themselves. That stamp is what a cap is ordered by. */
const chat = (view: Record<string, unknown>, submit: Record<string, unknown> = {}): Record<string, unknown> => ({
  collections: { messages: { submitOnly: true, statusField: "status" } },
  public: {
    submit: {
      messages: {
        auth: "verifiedEmail",
        emailField: "author",
        createFields: ["author", "body", "status", "postedAt"],
        initialStatus: "posted",
        stampField: "postedAt",
        ...submit,
      },
    },
  },
  views: [{ id: "room", audience: "member", path: "views/room.html", collections: ["messages"], live: ["messages"], ...view }],
});

// --- the declaration --------------------------------------------------------

test("`limit` parses, and normalizes as the author wrote it", () => {
  // `.strict()` means an app.json writing this key does not parse at all until it exists.
  const authored = normalizeViews(app(chat({ limit: { messages: 200 } })));
  assert.ok(authored.ok);
  assert.deepEqual(authored.views[0]?.limit, { messages: 200 });
});

test("a view that declares no `limit` normalizes without the key at all", () => {
  const authored = normalizeViews(app(chat({})));
  assert.ok(authored.ok);
  assert.equal("limit" in (authored.views[0] ?? {}), false);
});

test("a cap that is not a whole number of rows is refused at the parser", () => {
  // Nothing downstream would have to decide what half a row means.
  for (const rows of [0, -1, 1.5]) {
    assert.throws(() => app(chat({ limit: { messages: rows } })));
  }
});

// --- what publish refuses ---------------------------------------------------

test("refuses a cap on a dataset the view was never handed", () => {
  refuses(problemsFor(chat({ limit: { notes: 20 } })), "which is not in views[0].collections");
  assert.deepEqual(problemsFor(chat({ limit: { messages: 20 } })), []);
});

test("refuses a cap on a collection with no stampField — the trap that looks like it works", () => {
  // Unordered, Firestore falls back to the document id: an arbitrary N, and a new message
  // sorts wherever its id falls, so the page would never receive another one. Nothing errors.
  const problems = problemsFor(chat({ limit: { messages: 20 } }, { stampField: undefined }));
  refuses(problems, "declares no public.submit.messages.stampField");
  refuses(problems, "a NEW record never reaches it");
  // And the same declaration WITH the stamp publishes.
  assert.deepEqual(problemsFor(chat({ limit: { messages: 20 } })), []);
});

test("refuses a cap above the ceiling, and accepts the ceiling itself", () => {
  refuses(problemsFor(chat({ limit: { messages: 1001 } })), "above the 1000 this key is for");
  assert.deepEqual(problemsFor(chat({ limit: { messages: 1000 } })), []);
});

test("refuses a cap on a participant's OWN rows — that query cannot be ordered today", () => {
  // The read already carries a where on the field that makes it readable, so a sort field as
  // well needs a composite index the deployment does not declare: the read FAILS rather than
  // returning fewer rows, and a participant's page is blank.
  const own = (limit: Record<string, number>) => ({
    ...chat({}),
    views: [{ id: "mine", audience: "participant", path: "views/mine.html", collections: ["messages"], limit }],
  });
  refuses(problemsFor(own({ messages: 20 })), "composite index");
  // The same collection, capped on the page that reads it whole, is exactly what the key is for.
  assert.deepEqual(problemsFor(chat({ limit: { messages: 20 } })), []);
});

// --- what publish writes ----------------------------------------------------

test("a tier's projection carries the cap AND the field it is ordered by", () => {
  // Both halves or neither: `rows` alone is a limit over the document-id order, which is the
  // one thing this key exists to prevent.
  const tiers = projectAppViews(app(chat({ limit: { messages: 200 } })), STAMP);
  assert.deepEqual(tiers.find((tier) => tier.audience === "member")?.config.views, [
    { id: "room", collections: [{ cid: "messages", scope: "all", limit: { rows: 200, field: "postedAt" } }], live: ["messages"] },
  ]);
});

test("an app with no `limit` publishes exactly the document it published before the key existed", () => {
  const tiers = projectAppViews(app(chat({})), STAMP);
  assert.deepEqual(tiers.find((tier) => tier.audience === "member")?.config.views, [
    { id: "room", collections: [{ cid: "messages", scope: "all" }], live: ["messages"] },
  ]);
});

test("an own-row scope is never handed a cap, whatever the declaration says", () => {
  // The gate refuses this declaration; the projection must not describe the read even so. A
  // projection that promises a query the host would be DENIED is worse than one that omits it.
  const tiers = projectAppViews(
    app({
      ...chat({}),
      views: [{ id: "mine", audience: "participant", path: "views/mine.html", collections: ["messages"], limit: { messages: 20 } }],
    }),
    STAMP,
  );
  assert.deepEqual(tiers.find((tier) => tier.audience === "participant")?.config.views, [
    { id: "mine", collections: [{ cid: "messages", scope: "own", emailField: "author" }] },
  ]);
});

test("the public page's cap reaches the world-readable config, keyed by cid", () => {
  // A public page's `collections` is a list of NAMES with nowhere to hang a per-collection
  // value, so the caps ride beside it as a map.
  const poll = {
    collections: { votes: { submitOnly: true } },
    public: {
      enabled: true,
      read: ["votes"],
      submit: { votes: { auth: "verifiedEmail", emailField: "voter", createFields: ["choice", "voter", "castAt"], stampField: "castAt" } },
    },
    views: [{ id: "public", audience: "public", path: "views/poll.html", collections: ["votes"], limit: { votes: 50 } }],
  };
  assert.deepEqual(problemsFor(poll), []);
  assert.deepEqual(projectApp(app(poll), [], STAMP, null).config.view, {
    collections: ["votes"],
    limit: { votes: { rows: 50, field: "castAt" } },
  });
});
