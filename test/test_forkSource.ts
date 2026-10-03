// The fork source (`config/fork`) and the forker's app made of it (receptron/mulmoserver#332).
import { test } from "node:test";
import assert from "node:assert/strict";

import type { CollectionSchema } from "@mulmoclaude/core/collection";

import { AuthoredAppZ } from "../src/publishManifest.js";
import { publishProblems } from "../src/publishChecks.js";
import { projectApp, type PublishStamp } from "../src/publishProject.js";
import { forkFrom, forkSourceProblems, projectForkSource } from "../src/forkSource.js";
import { protocolFor } from "../src/appProtocol.js";
import * as entry from "../src/index.js";

const OWNER = "owner@tally.jp";
const STAFF = "staff@tally.jp";
const FORKER = "forker@example.com";
const PUBLISHED_AT = 1_760_000_000_000;

const voteSchema: CollectionSchema = {
  title: "Votes",
  icon: "how_to_vote",
  primaryKey: "id",
  fields: {
    id: { type: "string", label: "ID", primary: true },
    choice: { type: "enum", label: "Choice", values: ["red", "blue"] },
    status: { type: "enum", label: "Status", values: ["voted"] },
  },
};
const SCHEMAS = [{ cid: "votes", schema: voteSchema }];

const authored = (extra: Record<string, unknown> = {}) =>
  AuthoredAppZ.parse({
    aid: "app_tally",
    name: "Which colour?",
    slug: "tally",
    owner: "uid_owner",
    forkable: true,
    members: { [OWNER]: { "*": "owner" }, [STAFF]: { votes: "viewer" } },
    collections: { votes: { submitOnly: true, statusField: "status" } },
    views: [
      { id: "public", audience: "public", path: "views/vote.html", collections: ["votes"] },
      { id: "desk", audience: "member", path: "views/desk.html", collections: ["votes"] },
    ],
    public: {
      enabled: true,
      read: ["votes"],
      submit: { votes: { auth: "anonymous", idFrom: "pseudonym", createFields: ["choice", "status"], initialStatus: "voted" } },
    },
    ...extra,
  });

const source = () => projectForkSource(authored(), SCHEMAS, PUBLISHED_AT);
const roundTrip = (data: unknown): unknown => JSON.parse(JSON.stringify(data));
const REQUEST = { aid: "app_copy", email: FORKER };

test("the source names nobody: no roster, owner, id or URL name", () => {
  const { app } = source();
  for (const key of ["aid", "slug", "aidEnv", "owner", "members", "agents"]) assert.equal(Object.hasOwn(app, key), false, key);
  const text = JSON.stringify(source());
  assert.equal(text.includes(OWNER), false);
  assert.equal(text.includes(STAFF), false);
  assert.equal(text.includes("uid_owner"), false);
});

test("the source carries the declaration, the schemas, every page id and its protocol", () => {
  const doc = source();
  assert.equal(doc.app.forkable, true);
  assert.deepEqual(doc.schemas, { votes: voteSchema });
  assert.deepEqual(doc.views, ["public", "desk"]);
  assert.equal(doc.protocol, protocolFor(authored()));
  assert.equal(doc.publishedAt, PUBLISHED_AT);
});

test("forking makes the forker the only member, under the new id, and keeps the app forkable", () => {
  const forked = forkFrom(roundTrip(source()), { ...REQUEST, name: "Mine", slug: "mine" });
  assert.equal(forked.ok, true);
  assert.equal(forked.app.aid, "app_copy");
  assert.deepEqual(forked.app.members, { [FORKER]: { "*": "owner" } });
  assert.equal(forked.app.name, "Mine");
  assert.equal(forked.app.slug, "mine");
  assert.equal(forked.app.forkable, true);
  assert.deepEqual(forked.views, ["public", "desk"]);
  assert.deepEqual(forked.schemas, SCHEMAS);
});

test("without a name or slug the copy keeps the source's name and has no URL name", () => {
  const forked = forkFrom(roundTrip(source()), REQUEST);
  assert.equal(forked.ok && forked.app.name, "Which colour?");
  assert.equal(forked.ok && Object.hasOwn(forked.app, "slug"), false);
});

test("what the forker publishes carries none of the source's people", () => {
  const forked = forkFrom(roundTrip(source()), REQUEST);
  assert.equal(forked.ok, true);
  const stamp: PublishStamp = { uid: "uid_forker", email: FORKER, publishedAt: PUBLISHED_AT };
  const text = JSON.stringify(projectApp(forked.app, forked.schemas, stamp, null));
  assert.equal(text.includes(OWNER), false);
  assert.equal(text.includes(STAFF), false);
  assert.equal(text.includes("uid_owner"), false);
});

test("a source of a newer major is refused; a newer minor of the same major is read", () => {
  const doc = source();
  assert.equal(forkFrom({ ...doc, protocol: "99.0.0" }, REQUEST).ok, false);
  assert.equal(forkFrom({ ...doc, protocol: "3.9.0" }, REQUEST).ok, true);
  assert.equal(forkFrom({ ...doc, protocol: "not a version" }, REQUEST).ok, false);
  const { protocol: __dropped, ...withoutProtocol } = doc;
  assert.equal(forkFrom(withoutProtocol, REQUEST).ok, false);
});

test("a malformed source is refused rather than half-read", () => {
  const doc = source();
  for (const bad of [
    null,
    "text",
    [],
    { ...doc, schemas: { votes: { title: "no fields" } } },
    { ...doc, views: "desk" },
    { ...doc, views: [1] },
    { ...doc, app: "x" },
  ]) {
    assert.equal(forkFrom(bad, REQUEST).ok, false, JSON.stringify(bad));
  }
});

test("a source that smuggles people or agents in is refused, not merged", () => {
  const doc = source();
  assert.equal(forkFrom({ ...doc, app: { ...doc.app, members: { "evil@x.jp": { "*": "owner" } } } }, REQUEST).ok, false);
  assert.equal(forkFrom({ ...doc, app: { ...doc.app, owner: "uid_evil" } }, REQUEST).ok, false);
  const agents = [{ id: "helper", audience: "member", collections: ["votes"], instruction: "Read the votes." }];
  assert.equal(forkFrom({ ...doc, app: { ...doc.app, agents } }, REQUEST).ok, false);
});

test("the copy goes through the publish gate: what publish would refuse, a fork refuses", () => {
  const doc = source();
  const votes = { auth: "anonymous", idFrom: "pseudonym", uidForm: "pseudonym", createFields: ["choice", "status"], initialStatus: "voted" };
  const forked = forkFrom({ ...doc, app: { ...doc.app, public: { ...doc.app.public, submit: { votes } } } }, REQUEST);
  assert.equal(forked.ok, false);
  assert.equal(
    forked.problems.some((problem) => problem.includes("uidForm")),
    true,
  );
});

test("forkable beside agents[] is refused at publish; either alone is not", () => {
  const agents = [{ id: "helper", audience: "member", collections: ["votes"], instruction: "Read the votes." }];
  const problemsOf = (extra: Record<string, unknown>) => publishProblems(authored(extra), [{ cid: "votes", primaryKey: "id" }], OWNER);
  assert.equal(
    problemsOf({ agents }).some((problem) => problem.includes("forkable")),
    true,
  );
  assert.equal(
    problemsOf({ agents, forkable: false }).some((problem) => problem.includes("forkable")),
    false,
  );
  assert.equal(
    problemsOf({}).some((problem) => problem.includes("forkable")),
    false,
  );
});

test("a source that names a member or the owner anywhere is refused before it is written", () => {
  const clean = authored();
  assert.deepEqual(forkSourceProblems(clean, source(), [{ id: "desk", html: "<p>Votes</p>" }]), []);
  const named = authored({ name: `Ask ${OWNER.toUpperCase()}` });
  assert.equal(forkSourceProblems(named, projectForkSource(named, SCHEMAS, PUBLISHED_AT), []).length, 1);
  const labelled: CollectionSchema = {
    ...voteSchema,
    fields: { ...voteSchema.fields, choice: { type: "enum", label: `Ask ${STAFF}`, values: ["red", "blue"] } },
  };
  assert.equal(forkSourceProblems(clean, projectForkSource(clean, [{ cid: "votes", schema: labelled }], PUBLISHED_AT), []).length, 1);
  assert.equal(forkSourceProblems(clean, source(), [{ id: "desk", html: `<p>owner uid_owner</p>` }]).length, 1);
});

test("a schema whose fields are not field specs is refused, never thrown on", () => {
  const doc = source();
  for (const field of [null, 1, "x", { label: "no type" }, { type: "enum", values: [1] }]) {
    const bad = { ...doc, schemas: { votes: { ...voteSchema, fields: { ...voteSchema.fields, choice: field } } } };
    assert.equal(forkFrom(bad, REQUEST).ok, false, JSON.stringify(field));
  }
});

test("the app's own protocol floor survives the fork and is held by the gate", () => {
  const doc = source();
  assert.equal(forkFrom({ ...doc, app: { ...doc.app, protocol: "3.0.0" } }, REQUEST).ok, true);
  assert.equal(forkFrom({ ...doc, app: { ...doc.app, protocol: "4.0.0" } }, REQUEST).ok, false);
});

test("an address is found whatever its case on the roster and in the text", () => {
  const mixed = authored({ members: { "Mixed@Tally.jp": { "*": "owner" } }, name: "Ask mixed@tally.jp" });
  assert.equal(forkSourceProblems(mixed, projectForkSource(mixed, SCHEMAS, PUBLISHED_AT), []).length, 1);
});

test("the host and the browser reach every fork function through the package entry", () => {
  for (const name of ["projectForkSource", "forkSourceProblems", "forkFrom", "forkViewDocId"] as const) assert.equal(typeof entry[name], "function", name);
  assert.equal(entry.FORK_SOURCE_DOC, "fork");
});

test("the public config says forkable only when the app is, and never writes false", () => {
  const stamp: PublishStamp = { uid: "uid_owner", email: OWNER, publishedAt: PUBLISHED_AT };
  assert.equal(projectApp(authored(), SCHEMAS, stamp, null).config.forkable, true);
  assert.equal(Object.hasOwn(projectApp(authored({ forkable: false }), SCHEMAS, stamp, null).config, "forkable"), false);
  assert.equal(Object.hasOwn(projectApp(authored({ forkable: undefined }), SCHEMAS, stamp, null).config, "forkable"), false);
});
