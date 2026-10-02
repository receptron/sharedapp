# feat: idFrom "pseudonym" / "pseudonym+field" (#104, receptron/mulmoserver#325)

A public row whose id is the anonymous uid can be joined to the same person's rows in another app
(the uid is shared across a project's apps). The rules accept per-app ids
(receptron/mulmoserver#326): sha256(uid + ":" + aid) lowercase hex, and that + "_" + idField.

- `src/view/idStrategy.ts` (self-contained): `idFromSubmitter` / `idFromSubmitterAndField` — one
  predicate each, so every check that treats `auth.uid` as binding the submitter treats `pseudonym`
  the same; `pseudonymOf(uid, aid)` (Web Crypto) and `idOwnerOf(idFrom, uid, aid)` for hosts
- `recordId(submit, owner, …)`: `owner` is the uid or the pseudonym, as `idOwnerOf` returned
- manifest enum; publish checks (submitter binding → submitOnly, idField required, self-write owner,
  idField frozen against selfUpdate); projection `ownDocId: "pseudonym"` for a member page's own row
- `max-lines` ratchet for publishChecks 1370 → 1371

Hosts (mulmoserver, MulmoTerminal) adopt it after a release: compute `idOwnerOf` before building an
id or looking up an own row.
