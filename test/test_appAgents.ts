// `agents[]` — the standing job a published app asks an agent sitting at it to do.
//
// Three questions are pinned here, and they are the three the design turns on:
//
//   IT PARSES AT ALL. `AuthoredAppZ` is `.strict()`, so a committed `agents` key made the
//   whole file unparseable until it existed — which is why the schema half lands before
//   anything reads a brief.
//
//   IT IS PUBLISHED WHERE THE AUDIENCE IS. A member's brief must not reach `config/public`
//   (`allow read: if true` forever), and a public brief must not be on the member tier
//   pretending to be internal. That is principle 5, asserted in both directions.
//
//   A TIER CAN EXIST WITHOUT PAGES. An app whose staff have a duty and no HTML has to
//   publish its `write` projection somewhere, or the brief is a job with no table behind it.
//
// Every refusal below is paired with the neighbouring declaration that must still publish:
// a gate refusing every brief would satisfy a file of refusals and make the feature
// impossible, and from inside the suite the two look identical.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AuthoredAppZ } from "../src/publishManifest.js";
import { agentsFor, AGENT_INSTRUCTION_MAX } from "../src/appAgents.js";
import { agentWarnings, publishProblems } from "../src/publishChecks.js";
import { projectApp, projectAppViews } from "../src/publishProject.js";

const OWNER = "owner@salon.jp";
const STAMP = { publishedAt: 1_700_000_000_000, email: OWNER, uid: "u-owner" };
const CIDS = [
  { cid: "bookings", primaryKey: "id" },
  { cid: "slots", primaryKey: "id" },
  { cid: "messages", primaryKey: "id" },
];

const app = (overrides: Record<string, unknown>) => AuthoredAppZ.parse({ aid: "app_agents", members: { [OWNER]: { "*": "owner" } }, ...overrides });

const problemsFor = (overrides: Record<string, unknown>): string[] => publishProblems(app(overrides), CIDS, OWNER);

function refuses(problems: string[], fragment: string): void {
  const bullets = problems.map((problem) => `  - ${problem}`).join("\n");
  assert.ok(
    problems.some((problem) => problem.includes(fragment)),
    `expected a problem mentioning ${JSON.stringify(fragment)}, got:\n${bullets || "  (none)"}`,
  );
}

/** A booking desk: staff move `bookings` along a table, the world submits into it. */
const desk = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  collections: { bookings: { submitOnly: true, statusField: "state", transitions: { initial: ["pending"], pending: ["approved", "rejected"] } } },
  public: {
    enabled: true,
    read: ["slots"],
    submit: { bookings: { auth: "verifiedEmail", emailField: "who", createFields: ["who", "slot", "state"], initialStatus: "pending" } },
  },
  ...overrides,
});

const DESK_BRIEF = { id: "desk", audience: "member", watch: ["bookings"], instruction: "pending の予約は、枠が空いていれば承認し、埋まっていれば却下する。" };

// --- the declaration --------------------------------------------------------

test("`agents` parses, and carries the keys the reader is handed", () => {
  const parsed = app(desk({ agents: [DESK_BRIEF] }));
  assert.deepEqual(agentsFor(parsed, "member"), [{ id: "desk", instruction: DESK_BRIEF.instruction, watch: ["bookings"] }]);
  // The audience is NOT projected: it is which document you are reading, and a second
  // answer to that question is one that can disagree with the path.
  assert.equal("audience" in (agentsFor(parsed, "member")[0] ?? {}), false);
  assert.deepEqual(agentsFor(parsed, "public"), []);
});

test("an unknown audience, an unknown key and an empty instruction are refused at the parser", () => {
  assert.throws(() => app(desk({ agents: [{ ...DESK_BRIEF, audience: "staff" }] })));
  assert.throws(() => app(desk({ agents: [{ ...DESK_BRIEF, path: "views/desk.html" }] })));
  assert.throws(() => app(desk({ agents: [{ ...DESK_BRIEF, instruction: "   " }] })));
});

test("a brief that declares no watch parses, and is not projected as an empty one", () => {
  const parsed = app(desk({ agents: [{ id: "desk", audience: "member", instruction: "来た予約を見て、必要なら承認する。" }] }));
  assert.equal("watch" in (agentsFor(parsed, "member")[0] ?? {}), false);
});

// --- what publish refuses ---------------------------------------------------

test("the desk brief publishes", () => {
  assert.deepEqual(problemsFor(desk({ agents: [DESK_BRIEF] })), []);
});

test("an id that is duplicated, reserved or misspelt is refused", () => {
  refuses(problemsFor(desk({ agents: [DESK_BRIEF, DESK_BRIEF] })), "already uses");
  refuses(problemsFor(desk({ agents: [{ ...DESK_BRIEF, id: "config" }] })), "reserved");
  refuses(problemsFor(desk({ agents: [{ ...DESK_BRIEF, id: "Front Desk" }] })), "an agent id must be lowercase");
});

test("an instruction above the cap is refused, and one at the cap is not", () => {
  refuses(problemsFor(desk({ agents: [{ ...DESK_BRIEF, instruction: "x".repeat(AGENT_INSTRUCTION_MAX + 1) }] })), "above the 4096");
  assert.deepEqual(problemsFor(desk({ agents: [{ ...DESK_BRIEF, instruction: "x".repeat(AGENT_INSTRUCTION_MAX) }] })), []);
});

test("a brief naming a collection this repository does not have is refused", () => {
  refuses(problemsFor(desk({ agents: [{ ...DESK_BRIEF, watch: ["bookinggs"] }] })), "not a shared collection");
});

test("a public brief may watch only what public.read publishes", () => {
  const publicBrief = { id: "greeter", audience: "public", watch: ["bookings"], instruction: "予約を見て挨拶する。" };
  refuses(problemsFor(desk({ agents: [publicBrief] })), "cannot read");
  // The same brief over the collection the world genuinely reads, and it publishes — the
  // pair is what stops this being a check that refuses every public brief.
  assert.deepEqual(problemsFor(desk({ agents: [{ ...publicBrief, watch: ["slots"], collections: ["bookings"] }] })), []);
});

test('a "public" brief with no public block has nowhere to be published that is not an accident', () => {
  const problems = publishProblems(
    app({
      collections: { messages: { statusField: "state" } },
      agents: [{ id: "greeter", audience: "public", instruction: "こんにちは。" }],
    }),
    CIDS,
    OWNER,
  );
  refuses(problems, "declares no `public` block");
});

test("a participant brief over a collection with no own row is refused", () => {
  const parsed = {
    collections: { messages: { statusField: "state" } },
    public: { enabled: false, submit: { messages: { auth: "verifiedEmail", createFields: ["body", "state"] } } },
    agents: [{ id: "mine", audience: "participant", watch: ["messages"], instruction: "自分の行を見る。" }],
  };
  refuses(problemsFor(parsed), "cannot read");
});

test("a duty over collections this audience can do nothing to is refused", () => {
  // `slots` is world-readable and nobody may write it: a member watching it can only ever
  // wake up, read and be refused.
  refuses(problemsFor(desk({ agents: [{ ...DESK_BRIEF, watch: ["slots"] }] })), "can do nothing to any of them");
  // Reading one dataset in order to act on another is fine, which is the pair.
  assert.deepEqual(problemsFor(desk({ agents: [{ ...DESK_BRIEF, watch: ["slots"], collections: ["bookings"] }] })), []);
});

test("a brief with no watch is a warning, not a refusal", () => {
  const declared = desk({ agents: [{ id: "desk", audience: "member", collections: ["bookings"], instruction: "頼まれたら承認する。" }] });
  assert.deepEqual(problemsFor(declared), []);
  assert.ok(agentWarnings(app(declared))[0]?.includes("no `watch`"));
  assert.deepEqual(agentWarnings(app(desk({ agents: [DESK_BRIEF] }))), []);
});

test("an instruction carrying markup is a warning — a brief is not a page", () => {
  const declared = desk({ agents: [{ ...DESK_BRIEF, instruction: "<form>で承認してください</form>" }] });
  assert.deepEqual(problemsFor(declared), []);
  assert.ok(agentWarnings(app(declared)).some((warning) => warning.includes("markup")));
});

// --- where it is published --------------------------------------------------

test("a member brief lands on the member tier and NOWHERE near config/public", () => {
  const parsed = app(desk({ agents: [DESK_BRIEF] }));
  const projected = projectApp(parsed, [], STAMP, null);
  assert.equal("agents" in projected.config, false);

  const member = projectAppViews(parsed, STAMP).find((tier) => tier.tier === "member");
  assert.deepEqual(member?.config.agents, [{ id: "desk", instruction: DESK_BRIEF.instruction, watch: ["bookings"] }]);
});

test("a public brief lands on config/public and not on the member tier", () => {
  const parsed = app(desk({ agents: [{ id: "greeter", audience: "public", watch: ["slots"], collections: ["bookings"], instruction: "枠を見て案内する。" }] }));
  const projected = projectApp(parsed, [], STAMP, null);
  assert.deepEqual(projected.config.agents, [{ id: "greeter", instruction: "枠を見て案内する。", watch: ["slots"], collections: ["bookings"] }]);

  const member = projectAppViews(parsed, STAMP).find((tier) => tier.tier === "member");
  assert.equal("agents" in (member?.config ?? {}), false);
});

test("an app with no agents projects the documents it projected before this key existed", () => {
  const parsed = app(desk({}));
  assert.equal("agents" in projectApp(parsed, [], STAMP, null).config, false);
  for (const tier of projectAppViews(parsed, STAMP)) {
    assert.equal("agents" in tier.config, false);
    assert.deepEqual(tier.agents, []);
  }
});

test("a tier with a duty and NO pages still carries the write projection the duty needs", () => {
  const parsed = app(desk({ agents: [DESK_BRIEF] }));
  const member = projectAppViews(parsed, STAMP).find((tier) => tier.tier === "member");
  assert.deepEqual(member?.views, []);
  // The host keeps the tier because of this, not because of the (absent) pages.
  assert.equal(member?.agents.length, 1);
  assert.deepEqual(
    member?.config.write.map((entry) => entry.cid),
    ["bookings"],
  );
  assert.deepEqual(member?.config.write[0]?.transitions, { initial: ["pending"], pending: ["approved", "rejected"] });
  // And the submit declaration for it, so the brief's collection can be written to at all.
  assert.deepEqual(Object.keys(member?.config.submit ?? {}), ["bookings"]);
});
