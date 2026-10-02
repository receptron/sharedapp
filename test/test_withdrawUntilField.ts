// `window.withdrawUntilField`: a deadline on the submitter's own cancellation. The rules (receptron/
// mulmoserver#303) read it off the record the stored row points at; this is the gate and the projection.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { CollectionSchema } from "@mulmoclaude/core/collection";

import { AuthoredAppZ } from "../src/publishManifest.js";
import { publishProblems, schemaRefProblems } from "../src/publishChecks.js";
import { projectApp, type PublishStamp } from "../src/publishProject.js";

const OWNER = "owner@dance.jp";
const CIDS = [
  { cid: "bookings", primaryKey: "id" },
  { cid: "seats", primaryKey: "id" },
];
const STAMP: PublishStamp = { uid: "uid_owner", email: OWNER, publishedAt: 1_760_000_000_000, commit: "abc123def456" };
const DEADLINE = { ref: "seat", collection: "seats", field: "cancelUntil" };

/** A seat booking a visitor may cancel up to the seat's `cancelUntil`. */
const booking = (submit: Record<string, unknown> = {}) =>
  AuthoredAppZ.parse({
    aid: "app_dance",
    members: { [OWNER]: { "*": "owner" } },
    collections: { bookings: { submitOnly: true, statusField: "status", transitions: { initial: ["booked"] } }, seats: { mirrorOf: "bookings" } },
    public: {
      enabled: true,
      read: ["seats"],
      submit: {
        bookings: {
          auth: "verifiedEmail",
          emailField: "email",
          createFields: ["seat", "email", "status"],
          initialStatus: "booked",
          idFrom: "field",
          idField: "seat",
          idIn: { collection: "seats", where: { field: "state", equals: "open" } },
          mirror: "seats",
          window: { withdrawUntilField: DEADLINE },
          selfDelete: ["booked"],
          ...submit,
        },
      },
    },
  });

const refuses = (problems: string[], fragment: string): void => {
  assert.ok(
    problems.some((line) => line.includes(fragment)),
    `expected a problem mentioning ${JSON.stringify(fragment)}, got:\n${problems.join("\n") || "(none)"}`,
  );
};

const at = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined);

const seatSchema = (cancelUntilType: "number" | "string"): CollectionSchema => ({
  title: "Seats",
  icon: "event_seat",
  primaryKey: "id",
  fields: {
    id: { type: "string", label: "ID", primary: true },
    state: { type: "enum", label: "State", values: ["open", "taken"] },
    cancelUntil: { type: cancelUntilType, label: "Cancel until" },
  },
});

const bookingSchema: CollectionSchema = {
  title: "Bookings",
  icon: "how_to_reg",
  primaryKey: "id",
  fields: {
    id: { type: "string", label: "ID", primary: true },
    seat: { type: "string", label: "Seat" },
    email: { type: "email", label: "Email" },
    status: { type: "enum", label: "Status", values: ["booked"] },
  },
};

test("publishes a cancellation deadline beside selfDelete", () => {
  assert.deepEqual(
    publishProblems(booking(), CIDS, OWNER).filter((line) => line.includes("withdrawUntilField")),
    [],
  );
});

test("projects the deadline where the rules read it", () => {
  const projected = projectApp(booking(), [], STAMP, null);
  const window = at(at(at(at(projected.app, "public"), "submit"), "bookings"), "window");
  assert.deepEqual(at(window, "withdrawUntilField"), DEADLINE);
});

test("refuses a deadline on a collection the rules cannot find", () => {
  refuses(
    publishProblems(booking({ window: { withdrawUntilField: { ...DEADLINE, collection: "ghosts" } } }), CIDS, OWNER),
    "window.withdrawUntilField.collection names 'ghosts'",
  );
});

test("refuses a deadline whose ref the stored row never carries", () => {
  refuses(
    publishProblems(booking({ window: { withdrawUntilField: { ...DEADLINE, ref: "whenever" } } }), CIDS, OWNER),
    "window.withdrawUntilField.ref names 'whenever'",
  );
});

test("refuses a deadline with no selfDelete for it to bind", () => {
  refuses(publishProblems(booking({ selfDelete: undefined }), CIDS, OWNER), "withdrawUntilField is declared but selfDelete is not");
});

test("checks the deadline field against the target schema, as the closing bound is checked", () => {
  const schemas = (cancelUntilType: "number" | "string") => [
    { cid: "seats", schema: seatSchema(cancelUntilType) },
    { cid: "bookings", schema: bookingSchema },
  ];
  assert.deepEqual(
    schemaRefProblems(booking(), schemas("number")).filter((line) => line.includes("withdrawUntilField")),
    [],
  );
  refuses(schemaRefProblems(booking(), schemas("string")), "window.withdrawUntilField.field");
});
