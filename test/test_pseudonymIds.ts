// `idFrom: "pseudonym"` / `"pseudonym+field"` (#104): a per-app id that does not expose the uid.
// The value must be the one MulmoServer's rules compute — sha256(uid + ":" + aid), lowercase hex.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { AuthoredAppZ } from "../src/publishManifest.js";
import { publishProblems } from "../src/publishChecks.js";
import { ownScope } from "../src/appViews.js";
import { projectApp, projectAppViews } from "../src/publishProject.js";
import { idOwnerOf, pseudonymOf } from "../src/view/idStrategy.js";
import { recordId, recordOf, type DrawnForm, type SubmitSpec, type WritableField } from "../src/view/submit.js";
import { protocolFor, APP_PROTOCOL, APP_PROTOCOL_BASE } from "../src/appProtocol.js";

const OWNER = "owner@poll.jp";
const CIDS = [{ cid: "votes", primaryKey: "id" }];
const UID = "u-abcdef0123456789";
const AID = "app_poll";
const nodeHash = (text: string): string => createHash("sha256").update(text).digest("hex");

const poll = (submit: Record<string, unknown> = {}, collection: Record<string, unknown> = { submitOnly: true, statusField: "status" }) =>
  AuthoredAppZ.parse({
    aid: AID,
    members: { [OWNER]: { "*": "owner" } },
    collections: { votes: collection },
    public: {
      enabled: true,
      submit: {
        votes: {
          auth: "anonymous",
          idFrom: "pseudonym",
          createFields: ["choice", "status"],
          initialStatus: "voted",
          selfUpdate: { voted: ["choice"] },
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

test("pseudonymOf is the rules' value: sha256 of uid:aid, lowercase hex", async () => {
  assert.equal(await pseudonymOf(UID, AID), nodeHash(`${UID}:${AID}`));
  assert.match(await pseudonymOf(UID, AID), /^[0-9a-f]{64}$/);
});

test("pseudonymOf differs per app and per person", async () => {
  assert.notEqual(await pseudonymOf(UID, AID), await pseudonymOf(UID, "app_other"));
  assert.notEqual(await pseudonymOf(UID, AID), await pseudonymOf("u-someone-else", AID));
});

test("idOwnerOf hands recordId the pseudonym for the pseudonym strategies and the uid otherwise", async () => {
  assert.equal(await idOwnerOf("pseudonym", UID, AID), nodeHash(`${UID}:${AID}`));
  assert.equal(await idOwnerOf("pseudonym+field", UID, AID), nodeHash(`${UID}:${AID}`));
  assert.equal(await idOwnerOf("auth.uid", UID, AID), UID);
  assert.equal(await idOwnerOf(undefined, UID, AID), UID);
});

test("recordId builds the pseudonym ids the rules accept", () => {
  const owner = nodeHash(`${UID}:${AID}`);
  assert.equal(recordId({ createFields: ["choice"], idFrom: "pseudonym" }, owner, { choice: "red" }, "unused"), owner);
  assert.equal(recordId({ createFields: ["pollId"], idFrom: "pseudonym+field", idField: "pollId" }, owner, { pollId: "p1" }, "unused"), `${owner}_p1`);
  assert.throws(() => recordId({ createFields: ["pollId"], idFrom: "pseudonym+field", idField: "pollId" }, owner, { pollId: " " }, "unused"));
});

test("publishes a pseudonym collection whose submitter corrects their own row", () => {
  assert.deepEqual(publishProblems(poll(), CIDS, OWNER), []);
});

test("binds the submitter, so a writer may not pad the collection", () => {
  refuses(
    publishProblems(poll({}, { statusField: "status" }), CIDS, OWNER),
    'collections.votes.submitOnly must be true: public.submit.votes binds each record to its submitter (idFrom: "pseudonym")',
  );
});

test("refuses pseudonym+field without the field the id is built from", () => {
  refuses(publishProblems(poll({ idFrom: "pseudonym+field" }), CIDS, OWNER), 'idFrom is "pseudonym+field" but no idField is declared');
});

test("refuses a selfUpdate that rewrites the field a pseudonym+field id was built from", () => {
  refuses(
    publishProblems(
      poll({ idFrom: "pseudonym+field", idField: "pollId", createFields: ["pollId", "choice", "status"], selfUpdate: { voted: ["pollId"] } }),
      CIDS,
      OWNER,
    ),
    "the field the document id was built from",
  );
});

test("refuses a uidField beside a pseudonym: it would write the uid the pseudonym hides into the row", () => {
  refuses(publishProblems(poll({ uidField: "voterUid", createFields: ["choice", "voterUid", "status"] }), CIDS, OWNER), "names uidField 'voterUid'");
  refuses(
    publishProblems(
      poll({ idFrom: "pseudonym+field", idField: "pollId", uidField: "voterUid", createFields: ["pollId", "choice", "voterUid", "status"] }),
      CIDS,
      OWNER,
    ),
    "names uidField 'voterUid'",
  );
  assert.deepEqual(
    publishProblems(poll({ idFrom: "auth.uid", uidField: "voterUid", createFields: ["choice", "voterUid", "status"] }), CIDS, OWNER).filter((line) =>
      line.includes("names uidField"),
    ),
    [],
  );
});

test("projects the reader's own row by pseudonym for a member page", () => {
  assert.deepEqual(ownScope(poll(), "votes"), { cid: "votes", scope: "own", ownDocId: "pseudonym" });
});

test("uidForm pseudonym: the field holds the pseudonym, and the app needs protocol 3", async () => {
  const declared: SubmitSpec = { createFields: ["taskId", "holder"], uidField: "holder", uidForm: "pseudonym" };
  const drawn: DrawnForm = { fields: {} };
  const typed: WritableField[] = [{ name: "taskId", label: "Task", required: true }];
  const pseudonym = nodeHash(`${UID}:${AID}`);
  const written = recordOf(typed, drawn, declared, { taskId: "t1", holder: "forged" }, { uid: UID, email: null, pseudonym }, () => "now");
  assert.equal(written.holder, pseudonym);
  // Without the pseudonym the field is left empty — the rules refuse — rather than given the uid.
  const missing = recordOf(typed, drawn, declared, { taskId: "t1" }, { uid: UID, email: null }, () => "now");
  assert.equal(Object.hasOwn(missing, "holder"), false);
  assert.equal(protocolFor({ public: { submit: { claims: { uidForm: "pseudonym" } } } }), APP_PROTOCOL);
  assert.equal(protocolFor({ public: { submit: { claims: {} } } }), APP_PROTOCOL_BASE);
});

test("uidForm pseudonym publishes beside a pseudonym id, and is refused without a uidField", () => {
  assert.deepEqual(publishProblems(poll({ uidField: "voter", uidForm: "pseudonym", createFields: ["choice", "voter", "status"] }), CIDS, OWNER), []);
  refuses(publishProblems(poll({ idFrom: "auth.uid", uidForm: "pseudonym" }), CIDS, OWNER), 'uidForm is "pseudonym" but no uidField is declared');
});

test("projects uidForm onto the own-row selector, so a reader queries by the pseudonym", () => {
  const app = poll({ idFrom: "auto", uidField: "voter", uidForm: "pseudonym", createFields: ["choice", "voter", "status"], selfUpdate: { voted: ["choice"] } });
  assert.deepEqual(ownScope(app, "votes"), { cid: "votes", scope: "own", uidField: "voter", uidForm: "pseudonym" });
});

test("the published submit blocks carry uidForm, so a host writes and queries the pseudonym", () => {
  // The wire, not a hand-built spec: if projection ever dropped uidForm, a host would fall back to
  // writing the raw uid into the field.
  const app = poll({ idFrom: "auto", uidField: "voter", uidForm: "pseudonym", createFields: ["choice", "voter", "status"], selfUpdate: { voted: ["choice"] } });
  const stamp = { uid: "uid_owner", email: OWNER, publishedAt: 1, commit: "c" };
  const { config } = projectApp(app, [], stamp, null);
  assert.equal(config.protocol, "3.0.0");
  assert.deepEqual([config.submit.votes?.uidField, config.submit.votes?.uidForm], ["voter", "pseudonym"]);
  const withDesk = AuthoredAppZ.parse({ ...app, views: [{ id: "desk", audience: "member", path: "views/desk.html", collections: ["votes"] }] });
  const tiers = projectAppViews(withDesk, stamp).filter((tier) => tier.views.length > 0);
  assert.equal(tiers.length, 1);
  tiers.forEach((tier) => {
    const submit = (tier.config.submit ?? {})["votes"];
    assert.deepEqual([submit?.uidField, submit?.uidForm, tier.config.protocol], ["voter", "pseudonym", "3.0.0"], tier.tier);
  });
});
