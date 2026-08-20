import type { ProjectedViewWrite } from "../appViews.js";

// What THIS reader may change, as against what the collection allows.
//
// The distinction is the whole module. `member/config` is one document written
// at publish and read by everybody `staffOf` admits — the receptionist, a
// stylist scoped to their own rows, and an observer who may write nothing all
// get the same entry. Handing that to a page unchanged draws approve for all
// three, and the rules refuse two of them the moment it is pressed: declaration
// and enforcement disagreeing, which is the failure the whole feature exists to
// prevent.
//
// So the projection carries the ROSTER'S ANSWER (`writers`, `rowWriters`) and
// the parent — which knows the reader's address — reduces it to a capability
// here. Three things about that are decisions rather than plumbing.
//
//   THE VIEW NEVER SEES A ROLE NAME. It is handed `{ transitionAny, assign, … }`
//   per collection, already resolved. A page branching on "editor" would be
//   encoding the rules a second time, in the one place nobody reviews.
//
//   ABSENCE IS ANSWERED BY THE TIER, and this is the one to get right. The
//   `roster` tier never carries lists — a participant's permission comes from
//   the RECORD (`ownRow`), not from a role — so there, absence means the rules
//   decide and the page draws its buttons. On the `member` tier absence means
//   REFUSE: a projection written by a publisher that did not emit the lists
//   cannot tell a receptionist from an observer, and treating that as "no
//   opinion" hands the staff controls to everybody the tier admits. That is
//   not a narrow legacy case either — it is every projection in the world
//   until its app is republished, which is exactly why it has to fail closed
//   (principle 8: do not turn the direction of a fail-closed check around).
//   The cost is a staff page that is read-only until the owner republishes,
//   and the publish output says so.
//
//   THIS IS NOT THE AUTHORITY. The rules are, and they answer against the live
//   record with the live roster. A member added since the last publish is
//   missing from these lists and is refused here where the rules would have
//   allowed them — the same snapshot every published declaration is, corrected
//   by the next publish.
//
// It lives in this package rather than in either host because BOTH parents
// answer it: mulmoserver for the live `/m/` and `/p/`, MulmoTerminal for the
// author's preview of those same pages. A second implementation would agree on
// the easy cases and diverge on this file's whole subject — see `index.ts`.

/** What one reader may do to one collection, with the roles already resolved. */
export interface ViewCapability {
  cid: string;
  /** May move the status field on ANY row here. */
  transitionAny: boolean;
  /** May move it on the rows assigned to them. */
  transitionOwn: boolean;
  /** May hand a row to somebody else. Writers only: the rules refuse an
   *  assignee's handover, requiring `assignedBefore` AND `assignedAfter`. */
  assign: boolean;
  /** Who may be named, for a page drawing a picker. The two role sets
   *  together: `viewer` and `participant` are in neither, and naming one
   *  writes a row NOBODY may touch afterwards. */
  assignees: string[];
  /** The field a row carries its owner's address in — the other half of
   *  `transitionOwn`, and useless without it.
   *
   *  A page holding `transitionOwn` knows it may move SOME rows and, without
   *  this and the reader's own address, cannot tell WHICH. It would have to
   *  draw the control on every row (most of which answer `not-permitted` —
   *  the mismatch this whole mechanism exists to avoid) or on none, which
   *  takes the feature away from the person it was built for. So the page
   *  compares `row[assigneeField] === viewer.me`, and the write-time check
   *  applies exactly the same comparison. */
  assigneeField?: string;
  /** The statuses this reader may take their OWN row away from, and an empty
   *  list where they may not.
   *
   *  Not reduced to a boolean: a page has to draw the control on the rows that
   *  are actually in one of those statuses, and "may withdraw" with no list
   *  puts a button on a booking the desk already closed — refused when
   *  pressed, which is the mismatch this whole mechanism exists to avoid.
   *
   *  The roster tier only, and unlike the transitions it is NOT inferred from
   *  the projection's silence: a participant may transition their own row
   *  because the rules answer from the record, but a deletion is allowed only
   *  where the declaration named the statuses. Nothing to infer it from. */
  withdrawFrom: string[];
  /** May take ANY row here away — the staff half, and a different permission
   *  rather than a wider setting of the one above.
   *
   *  `withdrawFrom` is the submitter's, answered from the RECORD: their own
   *  row, in one of the statuses `selfDelete` names, which the rules read. This
   *  is answered from the ROLE, which `deleteWith` resolves with `isWriter` and
   *  no status condition at all — so it carries no list, and a page holding it
   *  draws the control on every row it can see.
   *
   *  The two never both answer yes: `writerDelete` is projected to the staff
   *  tier and `selfDelete` to the roster's, so whichever page a reader is on,
   *  exactly one of these describes them. */
  withdrawAny: boolean;
}

/** Which tier's projection this is — the answer to what ABSENCE means. */
export type WriteTier = "member" | "roster";

/** What a page is handed beside its datasets: who the reader is, and what they
 *  may change per collection.
 *
 *  `me` travels with it because `transitionOwn` is not actionable alone — it
 *  says the reader may move SOME rows, and only `row[assigneeField] === me`
 *  says which. It is null for a reader with no verified address, which is a
 *  member of nothing. */
export interface Viewer {
  me: string | null;
  can: Record<string, ViewCapability>;
}

/** Does this projection say anything about WHO at all? */
const namesRoles = (write: ProjectedViewWrite): boolean => write.writers !== undefined || write.rowWriters !== undefined;

/** Nothing, said explicitly. The staff tier's answer when the projection
 *  carries no roles: see the header for why it is this way round. */
const NOTHING = { transitionAny: false, transitionOwn: false, assign: false, assignees: [] as string[], withdrawFrom: [] as string[], withdrawAny: false };

const has = (addresses: string[] | undefined, address: string): boolean => (addresses ?? []).includes(address);

/** The row-owner field, attached only where it means something. */
const assignedField = (write: ProjectedViewWrite): { assigneeField?: string } => {
  if (write.assigneeField === undefined) {
    return {};
  }
  return { assigneeField: write.assigneeField };
};

/** The statuses a withdrawal is allowed from, on the tier that has them.
 *
 *  A staff page gets none even where the declaration carries them: an owner or
 *  editor deletes by role, through no vocabulary of ours, and offering them a
 *  participant's control would draw a button whose refusal names the wrong
 *  reason. The status field has to be there too — the rules read the CURRENT
 *  status off the record before consulting the list. */
const withdrawable = (write: ProjectedViewWrite, tier: WriteTier): string[] => {
  if (tier !== "roster" || write.statusField === undefined) {
    return [];
  }
  return write.selfDelete ?? [];
};

/** One collection's capability for one address. */
export const capabilityOf = (write: ProjectedViewWrite, address: string, tier: WriteTier): ViewCapability => {
  const movable = write.statusField !== undefined && write.transitions !== undefined;
  const assignable = write.assigneeField !== undefined;
  if (!namesRoles(write)) {
    // The participant's own row: the rules answer from the record, so there is
    // no role to be missing. The staff tier's absence is the other case.
    if (tier === "roster") {
      return {
        cid: write.cid,
        transitionAny: movable,
        transitionOwn: false,
        assign: false,
        assignees: [],
        withdrawFrom: withdrawable(write, tier),
        withdrawAny: false,
      };
    }
    return { cid: write.cid, ...NOTHING };
  }
  const owned = assignedField(write);
  const writer = has(write.writers, address);
  return {
    cid: write.cid,
    transitionAny: movable && writer,
    // The assignee branch needs a field to compare against; without one the
    // role grants nothing, exactly as `isAssigned` in the rules has it.
    transitionOwn: movable && assignable && has(write.rowWriters, address),
    assign: assignable && writer,
    ...owned,
    // Sorted for the picker only. The DOCUMENT's order is the compiler's
    // business (it sorts by code point so a second publish of an unchanged
    // declaration produces an unchanged document); what a person reads is a
    // different job.
    assignees: [...(write.writers ?? []), ...(write.rowWriters ?? [])].sort((left, right) => left.localeCompare(right)),
    withdrawFrom: withdrawable(write, tier),
    // The role, and only the role. A projection that names no writers never
    // reaches here (see `namesRoles` above), so an app published before this
    // key existed answers no rather than everybody — the same fail-closed
    // direction as the rest of this tier.
    withdrawAny: write.writerDelete === true && writer,
  };
};

/** May this reader move THIS record's status?
 *
 *  The row matters for an assignee and not for a writer, so the record is a
 *  parameter: null means the page is holding no such row, and an assignee is
 *  then left to the rules rather than refused on a guess. */
export const mayTransition = (capability: ViewCapability, write: ProjectedViewWrite, record: Record<string, unknown> | null, address: string): boolean => {
  if (capability.transitionAny) {
    return true;
  }
  if (!capability.transitionOwn) {
    return false;
  }
  if (record === null || write.assigneeField === undefined) {
    return true;
  }
  return record[write.assigneeField] === address;
};

/** Every capability this reader has across the page's collections, keyed by
 *  cid — the shape the view is handed beside its datasets, so it can draw the
 *  buttons that exist and no others. */
export const capabilitiesFor = (write: ProjectedViewWrite[], address: string, tier: WriteTier): Record<string, ViewCapability> =>
  Object.fromEntries(write.map((entry) => [entry.cid, capabilityOf(entry, address, tier)]));

/** The whole `viewer` a parent posts. One function so the two hosts cannot
 *  disagree about the SHAPE — the capabilities were already shared and the
 *  envelope around them was not, which is how a page ended up branching on
 *  `viewer.can.transitionAny` (undefined for every app, because `can` is keyed
 *  by collection). */
export const viewerFor = (write: ProjectedViewWrite[], address: string | null, tier: WriteTier): Viewer => ({
  me: address,
  can: capabilitiesFor(write, address ?? "", tier),
});

/** WHICH TIER THE PUBLIC PAGE IS JUDGED AS, and it is not a third one.
 *
 *  `roster` means "there are no roles here; the rules answer from the RECORD" — which is exactly
 *  what a public visitor is. `ownRow` in `firestore.rules` asks for `authed()` and nothing else: no
 *  role, no membership, an anonymous uid will do. So the visitor on `/a` who booked a slot and the
 *  participant on `/p` who booked the same slot are the same reader as far as their own row is
 *  concerned, and giving the public page a tier of its own would only be a second name for this
 *  answer — one that could drift from it.
 *
 *  Named rather than spelled at each call site, because the two hosts (mulmoserver's live page,
 *  MulmoTerminal's preview of it) must not be able to disagree about it. */
export const PUBLIC_WRITE_TIER: WriteTier = "roster";

/** NOTE ON `me` FOR A PUBLIC PAGE: both hosts pass NULL, and it is a decision rather than a gap.
 *
 *  Nothing on this tier reads it. `capabilityOf`'s roster branch answers from the declaration
 *  alone, and `judgeWithdraw` says outright that whose row it is "is the rules' to answer" —
 *  `ownRow` compares an address the projection deliberately does not carry. So the address would
 *  reach the page for no purpose.
 *
 *  And this is the page where "for no purpose" decides it. The HTML is the app owner's, running in
 *  a STRANGER's browser, and a sandboxed document can navigate its own context once — enough to
 *  carry off what it holds. The visitor's address reaches a published page nowhere else:
 *  `viewer.mine` is projected to the fields the page could have SENT, and the address is one the
 *  host fills in, so it is dropped there.
 *
 *  Which rows are the reader's own is answered by `viewer.mine` and `view.mine(cid, key)` — reads
 *  made against the reader's own credentials — rather than by a comparison the page performs. That
 *  is the honest way round: the rules identify an own row by the uid or the verified address ON THE
 *  RECORD, neither of which a page can be trusted to hold.
 *
 *  A MEMBER's page keeps its address, and the asymmetry is about DISCLOSURE rather than capability:
 *  a member is identified to the app by that address — it is how they got in and what the roster
 *  lists — and their page shows it back to them. What a reader may DO is the same on all three.
 *
 *  There is deliberately no `publicViewerFor` wrapper to encode any of this. Every host builds the
 *  viewer the one way — `viewerFor(writes, address, PUBLIC_WRITE_TIER)` — because a second entry
 *  point is a second place for the two hosts to disagree, which is what this module exists to
 *  prevent. What each host passes as the address is the host's own answer, and both pass null here
 *  for the reasons above. */
