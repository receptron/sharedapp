// `shareCard`: what a link to this app shows when it is pasted on a social network (receptron/
// mulmoserver#336). Every card-carrying app gets one for itself — its `title`, or its name. With
// `collection` + `textField`, a link to one row gets its own, drawing that field — and only for a row a
// visitor may already read, which mulmoserver decides from the same `public` block the rules read.
//
// So the refusals here are about the declaration making sense: a collection no visitor can read has no
// row to draw, and a field that is not text has nothing to draw.

import type { CollectionSchema } from "@mulmoclaude/core/collection";

import type { AuthoredApp } from "./publishManifest.js";
import { publicReadable } from "./publishReadPublished.js";

/** Field kinds whose value is text a card can draw as written. */
const CARD_TEXT_TYPES = new Set(["string", "text", "markdown", "enum"]);

export interface ShareCard {
  collection?: string;
  textField?: string;
  title?: string;
  icon?: string;
  /** Present when the app ships a background image; the host writes its bytes to `config/shareImage`. */
  image?: true;
}

/** Where the host writes the card's background image, beside `config/public`: world-readable, like the
 *  card it becomes. Base64 in a document, so no Storage bucket or rule is needed. */
export const SHARE_IMAGE_DOC = "shareImage";
/** The largest background image, in bytes before encoding — a document holds 1 MiB, and base64 adds a third. */
export const SHARE_IMAGE_MAX_BYTES = 700_000;

/** The projection says THAT there is an image, not where it lives in the repository. */
const IMAGE_FLAG: { image: true } = { image: true };

export function shareCardProblems(app: AuthoredApp): string[] {
  const collection = app.shareCard?.collection;
  if (collection === undefined || publicReadable(app, collection)) return [];
  return [
    `shareCard.collection is '${collection}', which no visitor may read (it is in neither public.read nor public.readPublished): a card is drawn only for a row the world can already see, so this one would never be drawn.`,
  ];
}

export function shareCardSchemaProblems(app: AuthoredApp, schemas: readonly { cid: string; schema: CollectionSchema }[]): string[] {
  const card = app.shareCard;
  if (card?.collection === undefined || card.textField === undefined) return [];
  const { collection, textField } = card;
  const schema = schemas.find((entry) => entry.cid === collection)?.schema;
  if (schema === undefined) return [];
  const spec = Object.hasOwn(schema.fields, textField) ? schema.fields[textField] : undefined;
  if (spec === undefined) {
    return [`shareCard.textField names '${textField}', which the schema of '${collection}' does not declare: every card would be drawn blank.`];
  }
  if (CARD_TEXT_TYPES.has(spec.type)) return [];
  return [`shareCard.textField names '${textField}', a ${spec.type} field of '${collection}'. A card draws text: use a string, text, markdown or enum field.`];
}

/** `config/public.shareCard` — present only when declared, carrying only the keys that were. */
export const shareCardProjection = (app: AuthoredApp): { shareCard?: ShareCard } => {
  const card = app.shareCard;
  if (card === undefined) return {};
  return {
    shareCard: {
      ...(card.collection === undefined ? {} : { collection: card.collection }),
      ...(card.textField === undefined ? {} : { textField: card.textField }),
      ...(card.title === undefined ? {} : { title: card.title }),
      ...(card.icon === undefined ? {} : { icon: card.icon }),
      ...(card.image === undefined ? {} : IMAGE_FLAG),
    },
  };
};
