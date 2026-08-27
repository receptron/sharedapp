// Absent and `""` are the SAME answer to "does this collection name a status field".
//
// Four checks in `publishChecks.ts` ask that question, and they have to agree: one accepting a
// declaration another refuses is how an app publishes and then denies every write. They used to
// ask it four times with a truthiness test; they now ask one predicate, and this pins the answer
// that predicate has to keep giving.
//
// `""` cannot come through `AuthoredAppZ` — `statusField` is `.trim().min(1).optional()` — so the
// fixtures below are parsed first and the field overwritten afterwards. That is not a contrivance:
// `AuthoredApp` is the zod TYPE, and MulmoTerminal and MulmoServer both build one in TypeScript
// without meeting the parser. An empty field name is also a real authored mistake, which is why
// the rules must refuse rather than look a status up under a name no record carries.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AuthoredAppZ } from "../src/publishManifest.js";
import { publishProblems } from "../src/publishChecks.js";

const OWNER = "owner@salon.jp";
const CIDS = [{ cid: "bookings", primaryKey: "id" }];

/** Parsed through the real schema, then `statusField` replaced — including with the values the
 *  schema forbids, which is the whole point of doing it in this order. */
function appWith(
  statusField: string | undefined,
  extra: Record<string, unknown> = {},
  submitExtra: Record<string, unknown> = {},
): ReturnType<typeof AuthoredAppZ.parse> {
  const parsed = AuthoredAppZ.parse({
    aid: "app_test",
    members: { [OWNER]: { "*": "owner" } },
    collections: { bookings: { submitOnly: true, statusField: "status", transitions: { initial: ["draft"], draft: ["done"] }, ...extra } },
    public: {
      submit: { bookings: { auth: "verifiedEmail", createFields: ["a", "status"], idFrom: "auth.uid", initialStatus: "draft", ...submitExtra } },
      read: ["bookings"],
    },
  });
  const collection: Record<string, unknown> = { ...parsed.collections?.["bookings"] };
  if (statusField === undefined) delete collection["statusField"];
  else collection["statusField"] = statusField;
  return { ...parsed, collections: { ...parsed.collections, bookings: collection } };
}

const problems = (statusField: string | undefined, extra?: Record<string, unknown>, submitExtra?: Record<string, unknown>): string[] =>
  publishProblems(appWith(statusField, extra, submitExtra), CIDS, OWNER);

test("a named status field is accepted — the acceptance the refusals below are measured against", () => {
  assert.deepEqual(problems("status"), []);
});

test("an empty status field is refused exactly as an absent one is", () => {
  const absent = problems(undefined);
  assert.notDeepEqual(absent, [], "the fixture must be refused without a status field, or this proves nothing");
  assert.deepEqual(problems(""), absent);
});

/** Whitespace is a NAME, not an absence, and that is deliberate rather than an oversight. `""` is
 *  the one value that cannot name anything; `"  "` names a field called two spaces, and the right
 *  refusal is the one that says so — a submission must carry that field — not the one that says no
 *  status field was declared. Pinned because it is surprising, and because a later "tidy up" that
 *  trimmed here would change which refusal an author reads. */
test("whitespace is a field NAME, so it is refused for naming a field no record carries", () => {
  const spaces = problems("  ");
  assert.notDeepEqual(spaces, problems(undefined), "whitespace must not read as an absent field");
  assert.ok(
    spaces.some((problem) => problem.includes('must include "  "')),
    `expected a refusal naming the field, got: ${spaces.join(" | ")}`,
  );
});

test("the four checks that read it through the predicate agree with each other", () => {
  const gates: { collection?: Record<string, unknown>; submit?: Record<string, unknown> }[] = [
    { collection: { mail: { toField: "a", on: { done: { from: ["draft"], to: "done" } } } } },
    { collection: { transitions: { initial: ["draft"], draft: ["done"] } } },
    { submit: { selfDelete: ["draft"] } },
    { submit: { selfTransitions: { draft: ["done"] } } },
  ];
  gates.forEach((gate) => {
    assert.deepEqual(problems("", gate.collection, gate.submit), problems(undefined, gate.collection, gate.submit), `disagreed for ${JSON.stringify(gate)}`);
  });
});

/** RECORDING A DISAGREEMENT, NOT ENDORSING ONE. `sealed`'s check asks `statusField === undefined`
 *  rather than the predicate, so it reads `""` as a field that WAS declared and stays silent,
 *  while the four above read it as none. Both answers are older than the predicate and neither
 *  changed with it.
 *
 *  It is left alone because the input cannot arrive: `parseAuthoredApp` is the way in and it runs
 *  `AuthoredAppZ.safeParse`, where `statusField` is `.trim().min(1)`. What is NOT checkable from
 *  this repository is the sibling callers — MulmoTerminal and MulmoServer build an `AuthoredApp`
 *  as a TypeScript value — so this is asserted rather than argued, and whoever makes the two
 *  agree will see this go red and find the reason. */
test("`sealed` answers the question differently, and that predates the predicate", () => {
  const sealed = { sealed: ["done"] };
  assert.notDeepEqual(problems("", sealed), problems(undefined, sealed));
  assert.ok(
    problems(undefined, sealed).some((problem) => problem.includes("sealed names statuses")),
    "an absent status field must still draw the sealed refusal",
  );
  assert.ok(
    !problems("", sealed).some((problem) => problem.includes("sealed names statuses")),
    "an empty status field currently does NOT draw it — the disagreement this test records",
  );
});

test("a status field of a different name is a different answer — the predicate reads the value, not just its presence", () => {
  assert.notDeepEqual(problems("state"), problems("status"));
});
