// `idFrom: "pseudonym"` / `"pseudonym+field"` (#104): a per-app id that does not expose the uid.
// The value must be the one MulmoServer's rules compute — sha256(uid + ":" + aid), lowercase hex.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { AuthoredAppZ } from "../src/publishManifest.js";
import { publishProblems } from "../src/publishChecks.js";
import { ownScope } from "../src/appViews.js";
import { idOwnerOf, pseudonymOf } from "../src/view/idStrategy.js";
import { recordId } from "../src/view/submit.js";

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
