// Absent and `""` are the SAME answer to "does this collection name a status field".
//
// Several sites ask that question — four checks in `publishChecks.ts` and four projection parts in
// `appViews.ts` — and they have to agree: one accepting a declaration another refuses is how an
// app publishes and then denies every write. They now ask one predicate, and this pins the answer
// it has to keep giving. The reader is what makes that answer the right one rather than a choice:
// `view/writeRead.ts` already dropped a status field, a seal, a self-delete and a self-update that
// read `""`, so a compiler emitting them was publishing controls its own reader discards.
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
import { writeFor, VIEW_AUDIENCES } from "../src/appViews.js";

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

test("the checks that read it through the predicate agree with each other", () => {
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

/** `sealed` was the one site that asked `statusField === undefined` instead, so it read `""` as a
 *  field that WAS declared and stayed silent. The reader is what settles it: `view/writeRead.ts`
 *  drops a seal whose `statusField` is `""`, so a declaration the gate waved through produced a
 *  document whose seal its own reader discarded — a control the author asked for and nobody drew,
 *  with no refusal naming it. */
test("`sealed` gives the same answer as the rest — an empty status field draws its refusal", () => {
  const sealed = { sealed: ["done"] };
  assert.deepEqual(problems("", sealed), problems(undefined, sealed));
  ["", undefined].forEach((statusField) => {
    assert.ok(
      problems(statusField, sealed).some((problem) => problem.includes("sealed names statuses")),
      `sealed must be refused for statusField ${JSON.stringify(statusField)}`,
    );
  });
});

/** `checkedFields` is the fourth reader of the predicate and the one an earlier version of this
 *  file missed — it exercised the self-write branch twice instead. It decides which field names an
 *  `aggregate.by` key is allowed to be, so `""` reading as a declared status field would make
 *  `aggregate.by: [""]` legal on a collection that declares no status at all. */
test("`aggregate.by` is judged against the same answer", () => {
  const aggregate = { aggregate: { by: ["status"] } };
  // Named for real, "status" IS a checked field, so aggregating by it is allowed.
  assert.deepEqual(
    problems("status", aggregate),
    [],
    `aggregating by the declared status field must be accepted, got: ${problems("status", aggregate).join(" | ")}`,
  );
  // Named as "", it is not — and the refusal has to be the one absence draws, not silence.
  assert.deepEqual(problems("", aggregate), problems(undefined, aggregate));
  assert.notDeepEqual(problems("", aggregate), [], "an aggregate key checked by nothing must be refused, or this proves nothing");
});

test("a status field of a different name is a different answer — the predicate reads the value, not just its presence", () => {
  assert.notDeepEqual(problems("state"), problems("status"));
});

// --- the projection half -------------------------------------------------------------------
//
// The four sites above are the GATE. `appViews` decides the same thing four more times, and those
// four are what a page actually receives. A mutation reverting them survived the whole suite when
// this file was first written — nothing anywhere noticed the compiler emitting a status field, a
// seal, a self-delete or a self-update built on a name that names nothing.

/** A declaration that would project all four parts, then `statusField` replaced post-parse. */
function projectable(statusField: string | undefined): ReturnType<typeof AuthoredAppZ.parse> {
  const parsed = AuthoredAppZ.parse({
    aid: "app_test",
    members: { [OWNER]: { "*": "owner" }, "desk@salon.jp": { bookings: "editor" } },
    collections: {
      bookings: { statusField: "status", transitions: { initial: ["draft"], draft: ["done"] }, sealed: ["done"], writerDelete: true },
    },
    public: {
      submit: {
        bookings: {
          auth: "verifiedEmail",
          createFields: ["a", "status"],
          idFrom: "auth.uid",
          initialStatus: "draft",
          selfDelete: ["draft"],
          selfUpdate: { draft: ["a"] },
          selfTransitions: { draft: ["done"] },
        },
      },
      read: ["bookings"],
    },
  });
  const collection: Record<string, unknown> = { ...parsed.collections?.["bookings"] };
  if (statusField === undefined) delete collection["statusField"];
  else collection["statusField"] = statusField;
  return { ...parsed, collections: { ...parsed.collections, bookings: collection } };
}

test("a named status field projects the transition, seal, self-delete and self-update parts", () => {
  const write = writeFor(projectable("status"), "member", "bookings");
  // `notEqual` from `node:assert/strict` narrows, so `write` is not nullable below it.
  assert.notEqual(write, null);
  assert.equal(write.statusField, "status");
  assert.deepEqual(write.sealed, ["done"]);
});

test("an empty status field projects exactly what an absent one projects — in every audience", () => {
  VIEW_AUDIENCES.forEach((audience) => {
    assert.deepEqual(
      writeFor(projectable(""), audience, "bookings"),
      writeFor(projectable(undefined), audience, "bookings"),
      `the ${audience} projection differed`,
    );
  });
});

test("and what it projects carries no status field, no seal and no self-write built on one", () => {
  VIEW_AUDIENCES.forEach((audience) => {
    const write = writeFor(projectable(""), audience, "bookings");
    assert.equal(write?.statusField, undefined, `${audience} projected a statusField`);
    assert.equal(write?.sealed, undefined, `${audience} projected a seal`);
    assert.equal(write?.selfDelete, undefined, `${audience} projected a selfDelete`);
    assert.equal(write?.selfUpdate, undefined, `${audience} projected a selfUpdate`);
    assert.equal(write?.transitions, undefined, `${audience} projected transitions`);
  });
});
