// `app.json`'s text → the authored declaration. Its own module because it is the one reach into
// core's SERVER half (`parseAppManifest`, the single statement of the `aid` rule): kept out of
// `publishManifest.ts`, everything a browser needs to compile a declaration loads without it
// (`browser.ts`).
import { parseAppManifest, type AppManifestResult } from "@mulmoclaude/core/collection/server";

import { AuthoredAppZ, authoredProblems, type AuthoredAppResult } from "./publishManifest.js";

/** Parse the authored declaration out of `app.json`'s text.
 *
 *  Returns a LIST of problems rather than throwing, for the same reason
 *  `loadAppManifest` returns a failure: the caller is a gate whose entire job
 *  is to hand the author something to act on. Every problem is reported at
 *  once — publish is a manual step, and a parser that stops at the first key
 *  makes it N round trips. */
export function parseAuthoredApp(raw: string): AuthoredAppResult {
  // Reuse the one-field parse so `aid`'s rule has a single statement, and so a
  // file that is not even JSON says so in the same words discovery uses.
  const manifest: AppManifestResult = parseAppManifest(raw);
  if (!manifest.ok) return { ok: false, problems: [manifest.kind === "missing" ? "app.json is missing" : manifest.detail] };
  const parsed = AuthoredAppZ.safeParse(JSON.parse(raw));
  if (!parsed.success) return { ok: false, problems: authoredProblems(parsed.error) };
  return { ok: true, app: parsed.data };
}
