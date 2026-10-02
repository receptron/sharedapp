// `public.readPublished`: visitors read only the rows an owner published (`collections[cid].publishField`).
// Out of publishChecks.ts for its length, and because the whole rule is these few refusals.

import type { AuthoredApp } from "./publishManifest.js";

/** May a VISITOR's page be handed `cid`: every row (`public.read`), or the published ones
 *  (`public.readPublished`), which the page reads with the filter the rules require. */
export const publicReadable = (app: AuthoredApp, cid: string): boolean =>
  (app.public?.read ?? []).includes(cid) || (app.public?.readPublished ?? []).includes(cid);

/** `public.readPublished`: visitors read only the rows an owner published, so everything that would let
 *  a row reach them another way — or let a sender publish their own — is refused here. The rules hold
 *  the flag against the submitter on their own; these refusals are what keep the declaration honest. */
export function readPublishedProblems(app: AuthoredApp): string[] {
  return (app.public?.readPublished ?? []).flatMap((cid) => readPublishedCidProblems(app, cid));
}

function readPublishedCidProblems(app: AuthoredApp, cid: string): string[] {
  const where = `public.readPublished names '${cid}'`;
  const field = app.collections?.[cid]?.publishField;
  if (field === undefined) {
    return [`${where}, but collections.${cid}.publishField is not declared: there is no field to mark a row published, so no visitor could ever read one.`];
  }
  return [...readPublishedOverlap(app, cid, where), ...publishFieldSubmitProblems(app, cid, field), ...publishFieldCollisions(app, cid, field)];
}

function readPublishedOverlap(app: AuthoredApp, cid: string, where: string): string[] {
  if (!(app.public?.read ?? []).includes(cid)) return [];
  return [
    `${where} and public.read names it too: public.read hands EVERY row to the world, so the publish switch would hide nothing. Name it in one of the two.`,
  ];
}

/** The submitter must not be able to write the flag — on create or on a self-correction. */
function publishFieldSubmitProblems(app: AuthoredApp, cid: string, field: string): string[] {
  const submit = app.public?.submit?.[cid];
  if (submit === undefined) return [];
  const problems: string[] = [];
  if (submit.createFields.includes(field)) {
    problems.push(
      `public.submit.${cid}.createFields includes '${field}', the publish field: a sender could publish their own row on the way in. Only a writer may set it.`,
    );
  }
  const editable = Object.entries(submit.selfUpdate ?? {}).filter(([, fields]) => fields.includes(field));
  editable.forEach(([status]) => {
    problems.push(
      `public.submit.${cid}.selfUpdate.${status} includes '${field}', the publish field: a sender could publish their own row afterwards. Only a writer may set it.`,
    );
  });
  return problems;
}

/** A field that already MEANS something else cannot double as the flag: the rules pin or derive it. */
function publishFieldCollisions(app: AuthoredApp, cid: string, field: string): string[] {
  const config = app.collections?.[cid];
  const submit = app.public?.submit?.[cid];
  const taken: [string, string | undefined][] = [
    ["statusField", config?.statusField],
    ["assigneeField", config?.assigneeField],
    ["stampField", submit?.stampField],
    ["idField", submit?.idField],
    ["uidField", submit?.uidField],
    ["emailField", submit?.emailField],
  ];
  return taken
    .filter(([, name]) => name === field)
    .map(
      ([key]) =>
        `collections.${cid}.publishField is '${field}', which is also the ${key}: the publish flag must be a field of its own, a boolean only a writer sets.`,
    );
}
