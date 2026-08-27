import type { AuthoredCollectionConfig } from "./publishManifest.js";

/** The status field a collection actually names, or undefined where it names none.
 *
 *  Absent and `""` are the SAME answer — an empty field name names nothing, and the rules would
 *  look a status up under a name no record carries. Every site that decides this has to give the
 *  same answer, or one accepts a declaration another refuses.
 *
 *  It is the READER that settles which answer is right: `view/writeRead.ts` parses a published
 *  document and drops the status field, the seal, the self-delete and the self-update whenever it
 *  reads `""`. A compiler that emitted them anyway would be publishing controls its own reader
 *  discards, and a gate that stayed silent would let that through.
 *
 *  `AuthoredAppZ` parses `statusField` as `.trim().min(1).optional()`, so `""` cannot survive it.
 *  It is still handled rather than assumed away: `AuthoredApp` is the zod TYPE, and a caller
 *  building one in TypeScript never meets the parser. */
export function statusFieldOf(collection: AuthoredCollectionConfig | undefined): string | undefined {
  const named = collection?.statusField;
  return named === undefined || named === "" ? undefined : named;
}
