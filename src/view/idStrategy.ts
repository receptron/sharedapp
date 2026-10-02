// Which id strategies build the document id from the SUBMITTER, asked in one place: every check that
// treats `auth.uid` as "this row is the submitter's" must treat `pseudonym` the same, and a site that
// spells the list out is the one that forgets the new value.
//
// `pseudonym` is `auth.uid` without the uid: the id is sha256(uid + ":" + aid), so a public row cannot
// be joined to the same person's rows in another app of the project (the anonymous uid is shared
// across them). The rules compute the same value (`pseudonym` in MulmoServer's firestore.rules).

/** The id is the submitter alone — one row per person. */
export const idFromSubmitter = (idFrom: string | undefined): boolean => idFrom === "auth.uid" || idFrom === "pseudonym";

/** The id is the submitter joined to `idField` — one row per person per thing. */
export const idFromSubmitterAndField = (idFrom: string | undefined): boolean => idFrom === "auth.uid+field" || idFrom === "pseudonym+field";

/** The id is built from a pseudonym rather than from the uid itself. */
export const usesPseudonym = (idFrom: string | undefined): boolean => idFrom === "pseudonym" || idFrom === "pseudonym+field";

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** The submitter's id for one app: lowercase hex SHA-256 of `uid + ":" + aid`, the value the rules
 *  compare a document id to. Async because Web Crypto is. */
export const pseudonymOf = async (uid: string, aid: string): Promise<string> =>
  hex(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${uid}:${aid}`)));

/** What `recordId` builds this submitter's id from: the pseudonym for a pseudonym strategy, the uid
 *  for every other. A host calls this once per submission and passes the answer as `owner`. */
export const idOwnerOf = async (idFrom: string | undefined, uid: string, aid: string): Promise<string> => (usesPseudonym(idFrom) ? pseudonymOf(uid, aid) : uid);
