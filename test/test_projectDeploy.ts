// The deploy / publish split of the authored -> published projection.
//
// `projectApp` (whole-app, one shot) stays because it is what mulmoserver's
// emulator rules test generates its fixtures from. These three are what a host
// needs to run the two operations SEPARATELY — a host is otherwise forced to
// re-derive which keys belong to which write, which is the kind of duplication
// that drifts.
//
// What the tests here are really pinning is the SAFETY of the split, not the
// key lists: deploy must not carry `public` (the rules authorize anonymous
// access from it, so deploying to test would publish), and promotion must
// re-stamp (the stamp answers "which version is public now").
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  projectDeploy,
  projectPublish,
  promoteSchema,
  appSchemasPath,
  appStagingPath,
  appConfigPath,
  appViewTierPath,
  viewConfigDocId,
} from "../src/publishProject.js";
import { parseAuthoredApp } from "../src/publishManifest.js";
import { CollectionSchemaZ } from "@mulmoclaude/core/collection/server";

const authored = parseAuthoredApp(
  JSON.stringify({
    aid: "3f2b8c1a-0000-4000-8000-000000000000",
    name: "Sakura Hair",
    members: { "owner@example.com": { "*": "owner" } },
    public: { enabled: true, read: ["bookings"], submit: { bookings: { auth: "verifiedEmail", createFields: ["customerName"] } } },
  }),
);
assert.equal(authored.ok, true);
const app = authored.ok
  ? authored.app
  : (() => {
      throw new Error("unreachable");
    })();

const schema = CollectionSchemaZ.parse({
  title: "Bookings",
  icon: "event",
  storage: { type: "firestore" },
  primaryKey: "id",
  fields: { id: { type: "text", label: "ID", primary: true } },
});

const deployStamp = { publishedAt: 1000, email: "owner@example.com", uid: "uid_owner", commit: "abc123", dirty: false };
const publishStamp = { publishedAt: 2000, email: "other@example.com", uid: "uid_owner", commit: "def456", dirty: false };

test("deploy carries no `public` — the block the rules authorize anonymous access from", () => {
  const { app: doc } = projectDeploy(app, [{ cid: "bookings", schema }], deployStamp, null);
  assert.equal("public" in doc, false);
  // …while everything the roster needs is there: deploying IS how an invitation
  // takes effect, so `members` must not be staged.
  assert.deepEqual(doc.members, app.members);
  assert.deepEqual(doc.memberEmails, ["owner@example.com"]);
});

test("publish carries the `public` block and the world-readable config, and nothing else", () => {
  const face = projectPublish(app, [], publishStamp, null);
  // `public` is handed back SEPARATELY, to be written last: it is the only one
  // of publish's writes that grants anything, so a failure before it must
  // leave the app private.
  assert.equal("public" in face.app, false);
  assert.deepEqual(face.public, { enabled: true, read: ["bookings"], submit: { bookings: { auth: "verifiedEmail", createFields: ["customerName"] } } });
  // A first publish (no existing document) still has to carry what CREATE
  // requires: the rules check `owner == request.auth.uid` and that
  // `memberEmails` matches the roster.
  assert.equal(face.app.aid, app.aid);
  assert.equal(face.app.owner, "uid_owner");
  assert.deepEqual(face.app.members, app.members);
  assert.deepEqual(face.app.memberEmails, ["owner@example.com"]);
  assert.equal(face.config.enabled, true);
  // The roster is NOT in the public config — a participant reading it would see
  // everyone else's address.
  assert.equal("members" in face.config, false);
  assert.equal("memberEmails" in face.config, false);
});

test("an author with no `public` block publishes nothing public", () => {
  const priv = parseAuthoredApp(JSON.stringify({ aid: app.aid, name: "Sakura Hair", members: app.members }));
  assert.equal(priv.ok, true);
  const face = projectPublish(priv.ok ? priv.app : app, [], publishStamp, null);
  assert.equal(face.public, undefined); // undefined = DELETE the field; the rules read its absence as "not public"
  assert.equal(face.config.enabled, false);
});

test("promotion re-stamps — the stamp says which version is PUBLIC, not when it was staged", () => {
  const { staging } = projectDeploy(app, [{ cid: "bookings", schema }], deployStamp, null);
  const staged = staging[0] ?? assert.fail("deploy staged nothing");
  const promoted = promoteSchema(staged.doc, publishStamp);
  assert.deepEqual(promoted.publishedSchema, staged.doc.publishedSchema); // what was tested is what ships
  assert.equal(promoted.publishedAt, 2000);
  assert.equal(promoted.publishedBy, "other@example.com");
  assert.equal(promoted.publishedCommit, "def456");
});

test("staged and published schemas live at separate paths", () => {
  // A field beside `publishedSchema` could not work: rules cannot hide a field,
  // so a draft inside a document the public page reads is a published draft.
  assert.notEqual(appStagingPath(app.aid), appSchemasPath(app.aid));
});

test("every parent under the app is a place of its own", () => {
  // These are the addresses `firestore.rules` matches on, and each one carries a
  // DIFFERENT audience: `config` is world-readable, `member` needs a role,
  // `roster` needs only to be listed, `staging` and `collections` are the draft
  // and the published schema. Two of them colliding would not fail loudly — it
  // would publish one audience's documents under another's rule.
  const parents = [
    appStagingPath(app.aid),
    appSchemasPath(app.aid),
    appConfigPath(app.aid),
    appViewTierPath(app.aid, "member"),
    appViewTierPath(app.aid, "roster"),
  ];
  assert.equal(new Set(parents).size, parents.length, `two parents collide: ${parents.join(", ")}`);
  for (const parent of parents) assert.ok(parent.startsWith(`apps/${app.aid}/`), `${parent} is not under the app`);
});

test("the staff tier and the roster tier are not the same place", () => {
  // Named separately because it is the collision that matters: a rule cannot
  // hide a field, so a staff page landing where participants read IS the leak —
  // the addresses are the only thing keeping the two audiences apart.
  assert.notEqual(appViewTierPath(app.aid, "member"), appViewTierPath(app.aid, "roster"));
});

test("a tier's projection carries the stage, so a draft never overwrites the live one", () => {
  // The projection tells a page which datasets its view may query. Publishing a
  // staged one over the live document would hand every current reader the
  // draft's answer before anyone published it.
  assert.notEqual(viewConfigDocId("live"), viewConfigDocId("staged"));
  assert.equal(viewConfigDocId("live"), "live:config");
});

test("deploy carries the live public face through, because the write REPLACES", () => {
  // A merge cannot delete, and every deletion here is a permission change
  // (dropping members.<email> revokes access). So the host replaces — which
  // means deploy has to hand back what publish owns, unchanged.
  const live = { public: { enabled: true, read: ["bookings"] }, publishedAt: 5, publishedBy: "p@example.com", collections: { bookings: { immutable: true } } };
  const { app: doc } = projectDeploy(app, [{ cid: "bookings", schema }], deployStamp, live);
  assert.deepEqual(doc.public, live.public);
  assert.deepEqual(doc.collections, live.collections);
  assert.equal(doc.publishedAt, 5);
  assert.equal(doc.publishedBy, "p@example.com");
});

test("rule-facing collection config is STAGED, not landed by deploy", () => {
  // apps/{aid}.collections[cid] is read when the rules authorize a PUBLIC
  // write, so landing it on deploy would change what anonymous visitors may do
  // before anyone published.
  const authoredWithConfig = parseAuthoredApp(
    JSON.stringify({
      aid: app.aid,
      name: "Sakura Hair",
      members: app.members,
      collections: { bookings: { immutable: true } },
      participantRead: ["bookings"],
    }),
  );
  assert.equal(authoredWithConfig.ok, true);
  const source = authoredWithConfig.ok ? authoredWithConfig.app : app;
  const { app: doc, staging } = projectDeploy(source, [{ cid: "bookings", schema }], deployStamp, null);
  assert.equal("collections" in doc, false);
  assert.equal("participantRead" in doc, false);
  const staged = staging[0] ?? assert.fail("deploy staged nothing");
  assert.deepEqual(staged.doc.config, { immutable: true });
  assert.equal(staged.doc.participantRead, true);
  // …and publish is where it lands.
  const face = projectPublish(source, staging, publishStamp, doc);
  assert.deepEqual(face.app.collections, { bookings: { immutable: true } });
  assert.deepEqual(face.app.participantRead, ["bookings"]);
});

test("publishing a declaration without `public` makes the app private", () => {
  // The regression this API exists to prevent: with a merge, taking `public`
  // out of app.json could not remove the field, so the app stayed open.
  const livePublic = { aid: app.aid, members: app.members, public: { enabled: true, read: ["bookings"] }, publishedAt: 5 };
  const priv = parseAuthoredApp(JSON.stringify({ aid: app.aid, name: "Sakura Hair", members: app.members }));
  assert.equal(priv.ok, true);
  const face = projectPublish(priv.ok ? priv.app : app, [], publishStamp, livePublic);
  assert.equal("public" in face.app, false);
  assert.equal(face.public, undefined); // the host deletes the live field
  assert.equal(face.config.enabled, false);
  // …while the roster deploy owns survives the replacing write.
  assert.deepEqual(face.app.members, app.members);
});

test("a publish that fails before the last write leaves the app private", () => {
  // The ordering is only real if the API can express it. Replay the writes in
  // order and cut them short: at every prefix, the app document must still
  // carry no `public` block, so the rules deny anonymous access.
  const live = { aid: app.aid, members: app.members, deployedAt: 1 };
  const face = projectPublish(app, [], publishStamp, live);
  const writes: (() => void)[] = [];
  let stored: Record<string, unknown> = { ...live };
  writes.push(() => (stored = { ...face.app })); // replace the app document
  writes.push(() => (stored = { ...stored, promotedSchemas: true })); // collections/{cid}
  writes.push(() => (stored = { ...stored, config: face.config })); // config/public
  for (let cut = 0; cut < writes.length; cut++) {
    stored = { ...live };
    for (let i = 0; i < cut; i++) writes[i]?.();
    assert.equal("public" in stored, false, `a failure after ${cut} write(s) must leave the app private`);
  }
  // Only the final, separate update opens it.
  assert.notEqual(face.public, undefined);
});

test("publish promotes the STAGED rule configuration, not the manifest as it reads now", () => {
  // deploy revision A, edit app.json to revision B, publish. What ships must be
  // A — the revision the roster exercised through /staging/{aid}. Taking the
  // rule config from the current manifest would publish B's authorization
  // behaviour under A's schema, which nobody tested.
  const revisionA = parseAuthoredApp(
    JSON.stringify({ aid: app.aid, members: app.members, collections: { bookings: { immutable: true } }, participantRead: ["bookings"] }),
  );
  assert.equal(revisionA.ok, true);
  const { staging } = projectDeploy(revisionA.ok ? revisionA.app : app, [{ cid: "bookings", schema }], deployStamp, null);

  const revisionB = parseAuthoredApp(JSON.stringify({ aid: app.aid, members: app.members, collections: { bookings: { immutable: false } } }));
  assert.equal(revisionB.ok, true);
  const face = projectPublish(revisionB.ok ? revisionB.app : app, staging, publishStamp, null);

  assert.deepEqual(face.app.collections, { bookings: { immutable: true } }, "A's staged rule config must be what ships");
  assert.deepEqual(face.app.participantRead, ["bookings"]);
});

test("a dirty working tree is recorded by publish, and a clean republish clears it", () => {
  // The marker is the audit trail's honesty: a commit read from a modified tree
  // does not describe what was published. It has to be publish-owned in both
  // directions — a deploy must not drop it, and a clean publish must not
  // inherit it from the document it is replacing.
  const dirty = projectPublish(app, [], { ...publishStamp, dirty: true }, null);
  assert.equal(dirty.app.publishedDirty, true);

  const clean = projectPublish(app, [], { ...publishStamp, dirty: false }, dirty.app);
  assert.equal("publishedDirty" in clean.app, false);

  // …and a deploy over a dirty app leaves the marker where it was.
  const { app: deployed } = projectDeploy(app, [{ cid: "bookings", schema }], deployStamp, dirty.app);
  assert.equal(deployed.publishedDirty, true);
});
