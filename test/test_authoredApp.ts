// The parser itself: what `app.json` may say, and what it may not say quietly.
//
// Every other test file starts from a PARSED declaration, which means none of
// them can see the one failure this parser exists to prevent. `AuthoredAppZ` is
// `.strict()` on purpose, and the reason is asymmetric: a schema key that
// vanishes costs a feature, while a DECLARATION key that vanishes costs the
// guarantee. `submitOnl: true` under a permissive parser is not a broken app —
// it is a collection anyone may write to, published, with nothing red anywhere.
//
// So the properties here are: an unknown key is refused wherever it appears,
// a refusal names the place, all of them arrive at once, and the optional keys
// a repository may already be carrying still parse.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAuthoredApp } from "../src/publishManifest.js";

const OWNER = "owner@salon.jp";
const base = { aid: "app_test", members: { [OWNER]: { "*": "owner" } } };

const parse = (overrides: Record<string, unknown> = {}): ReturnType<typeof parseAuthoredApp> => parseAuthoredApp(JSON.stringify({ ...base, ...overrides }));

const problems = (overrides: Record<string, unknown>): string[] => {
  const parsed = parse(overrides);
  assert.equal(parsed.ok, false, "expected the declaration to be refused");
  return parsed.ok ? [] : parsed.problems;
};

const refuses = (lines: string[], fragment: string): void => {
  assert.ok(
    lines.some((line) => line.includes(fragment)),
    `expected a problem mentioning ${JSON.stringify(fragment)}, got:\n${lines.map((line) => `  - ${line}`).join("\n") || "  (none)"}`,
  );
};

test("the declaration a whole app is written from parses", () => {
  // First, and not a formality: every refusal below is only meaningful against
  // a neighbour that parses.
  assert.equal(parse().ok, true);
});

test("an unknown key at the top level is refused rather than stripped", () => {
  // `membrs` under a permissive parser is an app with NO roster, published.
  refuses(problems({ membrs: { [OWNER]: { "*": "owner" } } }), `Unrecognized key: "membrs"`);
});

test("a misspelled key inside a collection is refused too — that is where the damage is", () => {
  // The archetype. `submitOnly` is the key that stops an owner fabricating
  // records in a collection whose entire meaning is "the submitter said this",
  // and a parser that stripped `submitOnl` would publish exactly that app while
  // the author read their own file and saw the guarantee written in it.
  refuses(problems({ collections: { responses: { submitOnl: true } } }), `collections.responses: Unrecognized key: "submitOnl"`);
});

test("a closed set stays closed — an unknown value is not carried through", () => {
  // `peerVisibility` reaches the rules. A value they do not understand is not a
  // stricter app, it is an unhandled branch.
  refuses(problems({ collections: { responses: { peerVisibility: "friends" } } }), "collections.responses.peerVisibility");
});

test("a problem names the path the author can go and edit", () => {
  // A gate's whole job is handing the author something to act on, and the
  // author is looking at a JSON file — so the key's address is the message.
  refuses(problems({ public: { submit: { responses: { auth: "nope", createFields: ["a"] } } } }), "public.submit.responses.auth:");
});

test("every problem arrives at once, not one per attempt", () => {
  // Publish is a manual step. A parser that stopped at the first key makes
  // fixing a declaration N round trips.
  const lines = problems({
    public: { submit: { responses: { auth: "nope", createFields: [] }, answers: { auth: "alsonope", createFields: ["a"] } } },
  });
  refuses(lines, "public.submit.responses.auth:");
  refuses(lines, "public.submit.responses.createFields:");
  refuses(lines, "public.submit.answers.auth:");
});

test("a file that is not a declaration says so in the words discovery uses", () => {
  // Routed through `parseAppManifest`, so a repository gets ONE answer to "is
  // this an app?" rather than a second opinion from the gate. Both shapes of
  // "not a declaration" are refused before zod sees anything: a file that is
  // not JSON, and a file that is JSON but is not an object.
  const broken = parseAuthoredApp("{ not json");
  assert.equal(broken.ok, false);
  refuses(broken.ok ? [] : broken.problems, "not valid JSON");

  const notAnObject = parseAuthoredApp(JSON.stringify(["app"]));
  assert.equal(notAnObject.ok, false);
  refuses(notAnObject.ok ? [] : notAnObject.problems, "is not a JSON object");
});

test("the roster is required — an app nobody is named in has no owner to publish it", () => {
  const parsed = parseAuthoredApp(JSON.stringify({ aid: "app_test" }));
  assert.equal(parsed.ok, false);
  refuses(parsed.ok ? [] : parsed.problems, "members:");
});

test("the optional keys a repository may already be carrying all parse", () => {
  // Several of these are declared ahead of the code that reads them (`aidEnv`
  // is per-worktree app ids; the reveal family is gated answers). A repository
  // that adopted one early must not stop parsing, which is the whole reason
  // they are accepted rather than merely tolerated — and being `.strict()`,
  // this file is the only place that difference is visible.
  const parsed = parse({
    aidEnv: "SHAREDAPP_AID",
    name: "Sakura Hair",
    participantRead: ["services"],
    collections: {
      responses: {
        statusField: "status",
        transitions: { initial: ["draft"], draft: ["sent"] },
        immutable: true,
        peerVisibility: "hidden",
        revealGated: true,
        gatedFrom: "responses",
        revealBy: "revealed",
        aggregate: { by: ["status"] },
        mail: { toField: "email", on: { sent: { from: ["draft"], to: "sent" } }, dataFields: ["name"] },
      },
    },
    public: {
      enabled: true,
      read: ["responses"],
      submit: {
        responses: {
          auth: "verifiedEmail",
          createFields: ["a", "status"],
          initialStatus: "draft",
          finalize: true,
          selfTransitions: { draft: ["sent"] },
          selfUpdate: { draft: ["a"] },
          gateOn: { phase: "phase", match: "a" },
          validate: { required: ["a"], keyFields: [{ field: "a", values: ["x", "y"] }] },
          stampField: "receivedAt",
        },
      },
    },
  });
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.problems.join("\n"));
});
