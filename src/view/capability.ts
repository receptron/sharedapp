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
   *  Unlike the transitions it is NOT inferred from the projection's silence: a
   *  participant may transition their own row because the rules answer from the
   *  record, but a deletion is allowed only where the declaration named the
   *  statuses. Nothing to infer it from.
   *
   *  The roster tier always, and the member tier for every reader who is not a
   *  WRITER of this collection — `ownRow` in the rules never asked which tier
   *  the reader was on, so a member who submitted a row may withdraw it, and a
   *  `viewer` or `assignee` keeps that even where staff also delete by role. */
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
   *  The two never both answer yes FOR ONE READER, and the reason is the reader
   *  rather than the collection: a writer on a `writerDelete` collection gets
   *  this one and an emptied list, everybody else gets the list. One document
   *  can carry both declarations and hand its two readers different answers,
   *  which is what the rules do (`isWriter(r) || selfDelete(...)`). */
  withdrawAny: boolean;
  /** Statuses no delete succeeds from, whichever of the two permissions above
   *  the reader holds (`collections[cid].sealed`).
   *
   *  A LIST beside a boolean, and the asymmetry is the rules': `withdrawAny` is
   *  answered from the ROLE with no status condition, so it cannot express
   *  this, and `sealedNow` is a separate refusal that binds the owner as well.
   *  A page holding `withdrawAny` draws its control on every row it can see —
   *  which is right — and must not draw it on a row whose status is in here,
   *  because that button can only ever fail.
   *
   *  Empty for a collection that seals nothing, which is nearly all of them. */
  sealed: string[];
  /** `{ <current status>: [<field>...] }` — the fields this reader may CORRECT in a row they
   *  submitted, while it holds that status (`public.submit[cid].selfUpdate`).
   *
   *  A map rather than a list, for the reason `withdrawFrom` is a list rather than a boolean: the
   *  rules read the row's CURRENT status before consulting it, so a caller holding only "may edit"
   *  would offer the correction on a row the desk has since approved and be refused when it acted.
   *
   *  Empty for a writer, and that is the same shape as `withdrawFrom`: the writer's permission is
   *  answered from the ROLE with no status condition and no field list at all, so a list beside it
   *  would describe a narrowing the rules do not apply.
   *
   *  Nothing here GRANTS the edit — `selfWriteOk` in the rules does, and answers last. What it
   *  buys is a refusal that can name the field and the status. */
  correctFrom: Record<string, string[]>;
  /** This reader may correct ANY field of ANY row here, because their ROLE says so
   *  (`isWriter` in `updateWith`).
   *
   *  A boolean beside the map, and the pair is `withdrawAny` / `withdrawFrom` again — the same
   *  asymmetry, from the same place. The rules answer a writer's update from the role alone: no
   *  status condition, no field list, nothing about the record. So there is nothing to enumerate,
   *  and enumerating anyway would hide edits the rules allow.
   *
   *  It is what makes the OWNER's edit expressible at all. `correctFrom` is `selfUpdate`, which an
   *  ordinary blog never declares — nobody but the author writes there — so a page reading only
   *  that map would conclude the author may change nothing about their own article, while the
   *  rules let them rewrite every field but the frozen ones.
   *
   *  What it does NOT reach: `ProjectedViewWrite.frozen`. Frozen means frozen, owner included. */
  correctAny: boolean;
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
const NOTHING = {
  transitionAny: false,
  transitionOwn: false,
  assign: false,
  assignees: [] as string[],
  withdrawFrom: [] as string[],
  withdrawAny: false,
  sealed: [] as string[],
  correctFrom: {} as Record<string, string[]>,
  correctAny: false,
};

const has = (addresses: string[] | undefined, address: string): boolean => (addresses ?? []).includes(address);

/** The row-owner field, attached only where it means something. */
const assignedField = (write: ProjectedViewWrite): { assigneeField?: string } => {
  if (write.assigneeField === undefined) {
    return {};
  }
  return { assigneeField: write.assigneeField };
};

/** The statuses a withdrawal is allowed from.
 *
 *  THE READER CHOOSES, NOT THE COLLECTION. `writerDelete` is declared per
 *  collection and being a writer is a fact about the person, so this asks
 *  `writer` and not merely whether the key is present. The reader who deletes
 *  by ROLE gets none of these: that is any row in any status, and a list beside
 *  it would draw a control whose refusal names the wrong reason. Everybody else
 *  admitted to the tier — a `viewer`, an `assignee`, a member of a collection
 *  no role writes — gets the submitter's half, because `ownRow` in the rules
 *  compares `emailField` against the caller's address and never asks which tier
 *  they were standing on. Reading `writerDelete` alone took the own-row delete
 *  away from exactly the people who had no other one.
 *
 *  The status field has to be there either way — the rules read the CURRENT
 *  status off the record before consulting the list — and it now travels with
 *  `selfDelete` rather than only with the transition table. */
const withdrawable = (write: ProjectedViewWrite, tier: WriteTier, writer: boolean): string[] => {
  if (write.statusField === undefined) {
    return [];
  }
  if (tier === "member" && writer && write.writerDelete === true) {
    return [];
  }
  return write.selfDelete ?? [];
};

/** The fields a correction may touch, per status.
 *
 *  The same shape as `withdrawable` beside it and answered the same way round: a WRITER gets
 *  nothing, because `isWriter` in the rules carries no status condition and no field list, so a
 *  map handed to them would describe a narrowing that is not applied. Everybody else gets the
 *  submitter's half, which `ownRow` + `selfWriteOk` answer from the record without asking which
 *  tier the reader was standing on. */
const correctable = (write: ProjectedViewWrite, tier: WriteTier, writer: boolean): Record<string, string[]> => {
  if (write.statusField === undefined || (tier === "member" && writer)) {
    return {};
  }
  return write.selfUpdate ?? {};
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
        withdrawFrom: withdrawable(write, tier, false),
        withdrawAny: false,
        sealed: write.sealed ?? [],
        correctFrom: correctable(write, tier, false),
        // No roles are named here at all, so nobody is a writer on this
        // projection — see the branch above.
        correctAny: false,
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
    withdrawFrom: withdrawable(write, tier, writer),
    correctFrom: correctable(write, tier, writer),
    // The role, and ONLY the role — as the rules have it. No `movable`
    // companion the way `transitionAny` has one: a transition needs a table to
    // read a destination out of, and a correction needs nothing but the field
    // names the caller sends.
    //
    // THE TIER IS ASKED for `withdrawAny`'s reason, spelled out below it: the
    // staff roles are compiled into the staff document only, and a `writers`
    // list appearing in a roster document — hand-written, or left by a build
    // that is not this one — must not hand a participant's page an edit-any
    // control.
    correctAny: tier === "member" && writer,
    // The role, and only the role, and only on the tier the role belongs to.
    //
    // A projection that names no writers never reaches here (see `namesRoles`
    // above), so an app published before this key existed answers no rather
    // than everybody — the same fail-closed direction as the rest of this tier.
    //
    // THE TIER IS ASKED even though this package only ever compiles
    // `writerDelete` into the staff document. What is read back is a DOCUMENT,
    // and the roster's is a different one; a `writerDelete` appearing in it —
    // written by hand, left by an older build, produced by a publisher that is
    // not this one — would otherwise hand a delete-anything control to a page
    // whose readers are participants. `withdrawable` asks the same question in
    // the same direction one field above.
    withdrawAny: tier === "member" && write.writerDelete === true && writer,
    sealed: write.sealed ?? [],
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
