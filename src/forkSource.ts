// The copy a visitor forks from — `apps/{aid}/config/fork` — and the app it becomes.
//
// THE AUTHORED DECLARATION, NOT THE PUBLISHED DOCUMENTS. Copying what publish wrote would copy the
// people: the app document carries `members`, `memberEmails`, `publishedBy` and `previousPublished`
// (an earlier roster, whole), and every schema document carries `publishedBy`. So the source is the
// declaration with the keys that name WHO taken out, and the forker's browser runs the same
// projection the publisher runs, with the forker as the only member.
//
// `agents[]` is not copied either, and an app that has one cannot declare `forkable` at all
// (`forkProblems` in `forkCheck.ts`): a standing job is somebody's agent doing paid work, and a copy would hand that
// cost to an app nobody priced.
import { z } from "zod";
import type { CollectionSchema } from "@mulmoclaude/core/collection";

import { APP_PROTOCOL, protocolFor, protocolOf } from "./appProtocol.js";
import { normalizeViews } from "./appViews.js";
import { publishProblems, schemaRefProblems } from "./publishChecks.js";
import { AuthoredAppZ, type AuthoredApp } from "./publishManifest.js";

/** The document id under `apps/{aid}/config` — world-readable, owner-written, like `public`. */
export const FORK_SOURCE_DOC = "fork";
/** One page's HTML, beside the source. Separate documents because a single Firestore document is
 *  capped at 1 MiB and an app's pages together can pass it. */
export const forkViewDocId = (viewId: string): string => `fork:view:${viewId}`;

const ForkableAppZ = AuthoredAppZ.omit({ aid: true, slug: true, aidEnv: true, owner: true, members: true, agents: true });
export type ForkableApp = z.infer<typeof ForkableAppZ>;

export interface ForkSourceDoc extends Record<string, unknown> {
  /** The contract the source was written against; a reader refuses a newer major than it knows. */
  protocol: string;
  app: ForkableApp;
  /** Keyed by cid. */
  schemas: Record<string, CollectionSchema>;
  /** The view ids whose HTML sits at {@link forkViewDocId}. */
  views: string[];
  publishedAt: number;
}

export function projectForkSource(authored: AuthoredApp, schemas: { cid: string; schema: CollectionSchema }[], publishedAt: number): ForkSourceDoc {
  const normalized = normalizeViews(authored);
  if (!normalized.ok) throw new Error(`fork source: views declaration is not publishable (${normalized.problems.join(" ")})`);
  const { aid: __aid, slug: __slug, aidEnv: __aidEnv, owner: __owner, members: __members, agents: __agents, ...app } = authored;
  return {
    protocol: protocolFor(authored),
    app,
    schemas: Object.fromEntries(schemas.map(({ cid, schema }) => [cid, schema])),
    views: normalized.views.map((view) => view.id),
    publishedAt,
  };
}

/** Who the source names, wherever the author wrote it: an address on the roster or the owner's uid in
 *  an app name, a label, an enum value or a page's HTML would be published to anyone by `config/fork`.
 *  The host runs this before writing the source, with every page it is about to copy, and refuses
 *  `forkable` while one is found. Matched case-insensitively, as addresses are. */
export function forkSourceProblems(authored: AuthoredApp, source: ForkSourceDoc, pages: { id: string; html: string }[]): string[] {
  const identities = [...Object.keys(authored.members), ...(authored.owner === undefined ? [] : [authored.owner])].map((identity) => identity.toLowerCase());
  const places = [
    { where: "the declaration or a schema", text: JSON.stringify(source) },
    ...pages.map((page) => ({ where: `the page '${page.id}'`, text: page.html })),
  ];
  return places.flatMap(({ where, text }) => {
    const lowered = text.toLowerCase();
    const found = identities.filter((identity) => lowered.includes(identity));
    return found.length === 0
      ? []
      : [`\`forkable\` would publish ${found.join(", ")} (written in ${where}) to anyone who opens the public page. Remove it there, or drop \`forkable\`.`];
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Down to each field's `type` and `values` — what the gate reads. Not the core validator, which this
// package does not import at runtime; a deeper fault breaks only a copy of the source owner's own app,
// and `forkFrom` turns anything the gate throws on into a refusal.
const isStringList = (value: unknown): boolean => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const isFieldSpec = (value: unknown): boolean =>
  isRecord(value) && typeof value.type === "string" && (value.values === undefined || isStringList(value.values));
const isCollectionSchema = (value: unknown): value is CollectionSchema =>
  isRecord(value) && typeof value.primaryKey === "string" && isRecord(value.fields) && Object.values(value.fields).every(isFieldSpec);

function protocolReadable(protocol: unknown): string[] {
  const stated = typeof protocol === "string" ? protocolOf(protocol) : null;
  const known = protocolOf(APP_PROTOCOL);
  if (stated === null || known === null) return [`the fork source states no readable protocol (${JSON.stringify(protocol)}).`];
  return stated.major <= known.major ? [] : [`the fork source is protocol ${String(protocol)}, newer than this build (${APP_PROTOCOL}).`];
}

function schemasOf(value: unknown): { cid: string; schema: CollectionSchema }[] | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  const schemas = entries.flatMap(([cid, schema]) => (isCollectionSchema(schema) ? [{ cid, schema }] : []));
  return schemas.length === entries.length ? schemas : null;
}

export interface ForkRequest {
  /** The new app's id, chosen by the forker's client. */
  aid: string;
  /** The forker — the copy's only member, as its owner. */
  email: string;
  name?: string | undefined;
  slug?: string | undefined;
}

export type ForkResult =
  { ok: true; app: AuthoredApp; schemas: { cid: string; schema: CollectionSchema }[]; views: string[] } | { ok: false; problems: string[] };

/** Read a fork source and make the forker's app of it — checked by the same gate publish runs, so a
 *  copy can never be a declaration the publisher would have refused. */
export function forkFrom(data: unknown, request: ForkRequest): ForkResult {
  if (!isRecord(data)) return { ok: false, problems: ["the fork source is not a document."] };
  const protocol = protocolReadable(data.protocol);
  if (protocol.length > 0) return { ok: false, problems: protocol };
  const source = ForkableAppZ.safeParse(data.app);
  const schemas = schemasOf(data.schemas);
  const views =
    Array.isArray(data.views) && data.views.every((id) => typeof id === "string") ? data.views.filter((id): id is string => typeof id === "string") : null;
  if (!source.success || schemas === null || views === null) return { ok: false, problems: ["the fork source is malformed."] };
  const parsed = AuthoredAppZ.safeParse({
    ...source.data,
    aid: request.aid,
    members: { [request.email]: { "*": "owner" } },
    ...(request.name === undefined ? {} : { name: request.name }),
    ...(request.slug === undefined ? {} : { slug: request.slug }),
  });
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
  const problems = gateProblems(parsed.data, schemas, request.email);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, app: parsed.data, schemas, views };
}

/** The publish gate, with a throw read as a refusal: the source is another person's document, and
 *  the gate was written for declarations the author's own host had already parsed. */
function gateProblems(app: AuthoredApp, schemas: { cid: string; schema: CollectionSchema }[], email: string): string[] {
  const collections = schemas.map(({ cid, schema }) => ({ cid, primaryKey: schema.primaryKey }));
  try {
    return [...publishProblems(app, collections, email), ...schemaRefProblems(app, schemas)];
  } catch (error) {
    return [`the fork source could not be checked: ${error instanceof Error ? error.message : String(error)}`];
  }
}
