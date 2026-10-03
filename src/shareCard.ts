// `shareCard`: the text a link to one row of this app shows when it is pasted on a social network
// (receptron/mulmoserver#336). mulmoserver's `/og/` draws the declared field onto an image — and only
// for a row a visitor may already read, which it decides from the same `public` block the rules read.
//
// So the refusals here are about the declaration making sense: a collection no visitor can read has no
// row to draw, and a field that is not text has nothing to draw.

import type { CollectionSchema } from "@mulmoclaude/core/collection";

import type { AuthoredApp } from "./publishManifest.js";
import { publicReadable } from "./publishReadPublished.js";

/** Field kinds whose value is text a card can draw as written. */
const CARD_TEXT_TYPES = new Set(["string", "text", "markdown", "enum"]);

export interface ShareCard {
  collection: string;
  textField: string;
}

export function shareCardProblems(app: AuthoredApp): string[] {
  const card = app.shareCard;
  if (card === undefined || publicReadable(app, card.collection)) return [];
  return [
    `shareCard.collection is '${card.collection}', which no visitor may read (it is in neither public.read nor public.readPublished): a card is drawn only for a row the world can already see, so this one would never be drawn.`,
  ];
}

export function shareCardSchemaProblems(app: AuthoredApp, schemas: readonly { cid: string; schema: CollectionSchema }[]): string[] {
  const card = app.shareCard;
  const schema = card === undefined ? undefined : schemas.find((entry) => entry.cid === card.collection)?.schema;
  if (card === undefined || schema === undefined) return [];
  const spec = Object.hasOwn(schema.fields, card.textField) ? schema.fields[card.textField] : undefined;
  if (spec === undefined) {
    return [`shareCard.textField names '${card.textField}', which the schema of '${card.collection}' does not declare: every card would be drawn blank.`];
  }
  if (CARD_TEXT_TYPES.has(spec.type)) return [];
  return [
    `shareCard.textField names '${card.textField}', a ${spec.type} field of '${card.collection}'. A card draws text: use a string, text, markdown or enum field.`,
  ];
}

/** `config/public.shareCard` — present only when declared. */
export const shareCardProjection = (app: AuthoredApp): { shareCard?: ShareCard } =>
  app.shareCard === undefined ? {} : { shareCard: { collection: app.shareCard.collection, textField: app.shareCard.textField } };
