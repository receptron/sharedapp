// The STANDING JOB a published app asks an agent to do — `agents[]`.
//
// An app can already tell a HUMAN what it is for: a page. It could not tell an
// LLM sitting at the app what it is for. The physics — collections, form,
// roles, which moves are allowed — are published and readable; the DUTY
// ("watch the messages and reply", "approve new bookings while the slot is
// open") lived only in the seed prompt of whichever terminal happened to be
// pointed at the app, which is not the app: it does not travel with the slug,
// it is not reviewed with the declaration, and it is gone on another machine.
//
// So it is declared here, projected at publish into the SAME documents the
// capability already lands on, and read back by whatever sits at the app. No
// new path, no new rule, no new permission.
//
// THREE THINGS ARE INVARIANTS, and they are what keep this from being a hole:
//
//   CAPABILITY IS THE DECLARATION; DUTY IS COLOUR ON TOP. An instruction
//   cannot grant `transition`, `assign` or `withdraw`. A brief saying "approve
//   every booking" against a table this reader does not carry is still refused
//   — the same sentence a page's own controls get.
//
//   RECORDS ARE NEVER ORDERS. Field values, enum labels and message bodies
//   stay quoted data under the reader's untrusted-content banner. A brief is a
//   different speech act: it is the AUTHOR's, it is fixed at publish, and it is
//   labelled as a request rather than mixed into the host's own voice.
//
//   AN AUDIENCE IS A PLACE. `agents[].audience` is the same noun as
//   `views[].audience`, for the same reason (`appViews.ts`): a rule cannot hide
//   a field, so who may read a brief is decided by WHICH DOCUMENT it is written
//   to. A desk brief on `config/public` — `allow read: if true` forever — is
//   the app's internal vocabulary published to the world, which is the leak
//   `docs/shared-app-principles.md` principle 5 is about.
//
// WHAT IT IS NOT. Not a role (`owner` / `assignee`): two people holding
// different roles on the same tier read the same briefs, exactly as they read
// the same pages, and a role-scoped brief cannot be reconstructed from
// `apps/{aid}` by a collection-scoped reader anyway. Not an identity: two cells
// on one host are still one signed-in person. And not a grant: naming a
// collection under `watch` opens nothing — publish refuses a brief whose
// audience cannot read what it names.
import type { AuthoredApp, AuthoredAgent } from "./publishManifest.js";
import type { ViewAudience } from "./appViews.js";

/** `config` is the projection's own document in every tier, and a brief is an
 *  ARRAY ON that document rather than a document of its own — so the id could
 *  not collide today. It is reserved anyway, for the reason the view ids
 *  reserve it: the two vocabularies are written by the same author, in the same
 *  file, and an id that means one thing in `views[]` and another in `agents[]`
 *  is a trap laid for a reader of the declaration. */
export const RESERVED_AGENT_IDS: readonly string[] = ["config"];

/** The same grammar as a view id. It is NOT a document id here — nothing
 *  addresses a brief by path — but it is what a report names the brief by when
 *  it hands it to an agent, and one spelling rule for one file beats two. */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The most an instruction may be.
 *
 *  A brief is a brief. What this bounds is the OTHER thing a free-text key on
 *  a published document can become: a payload, delivered into the context of
 *  every agent that opens the app, by whoever published it (or by whoever
 *  cloned it and published it again). It is generous enough for a real
 *  playbook and small enough that a reader can print it WHOLE — which is what
 *  lets the reader refuse ever to hand back a shortened one. */
export const AGENT_INSTRUCTION_MAX = 4096;

/** One brief, as the document carries it.
 *
 *  `audience` is NOT here: it is which document you are reading. Publishing it
 *  again would be a second answer to a question the path already settles, and
 *  the two could disagree. */
export interface ProjectedAgent {
  id: string;
  instruction: string;
  /** Collection ids this duty expects a subscription on. */
  watch?: string[];
  /** Collections the duty is ABOUT, where that is not the same as what it
   *  watches — a form you submit without waiting on anything. */
  collections?: string[];
}

/** The briefs written for one audience, in declaration order. */
export function agentsFor(app: AuthoredApp, audience: ViewAudience): ProjectedAgent[] {
  return (app.agents ?? [])
    .filter((agent) => agent.audience === audience)
    .map((agent) => ({
      id: agent.id,
      instruction: agent.instruction,
      ...(agent.watch === undefined ? {} : { watch: agent.watch }),
      ...(agent.collections === undefined ? {} : { collections: agent.collections }),
    }));
}

/** The collections one brief is about: what it watches, plus what it names.
 *
 *  `collections` DEFAULTS TO `watch` rather than to nothing, because the
 *  ordinary brief names one collection once — under `watch`, since waiting is
 *  what a standing job does — and having to write it twice is the kind of
 *  duplication a declaration goes out of step with. */
export const agentCids = (agent: AuthoredAgent | ProjectedAgent): string[] => [...new Set([...(agent.watch ?? []), ...(agent.collections ?? [])])];

/** Every collection the briefs of one audience name.
 *
 *  Publish unions this with the audience's PAGE collections when it projects
 *  `write` and `submit` for the tier: an app whose staff never had a page but
 *  do have a duty must still be told what they may change, or the brief asks
 *  for a move the same document says nothing about. */
export const agentTierCids = (app: AuthoredApp, audience: ViewAudience): string[] => [
  ...new Set((app.agents ?? []).filter((agent) => agent.audience === audience).flatMap((agent) => agentCids(agent))),
];
