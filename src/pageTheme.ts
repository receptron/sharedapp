// `theme`: how an app's public page looks — the bar, the ground behind the app, an icon, a ticker, a
// banner (receptron/mulmoserver#336). As loud as the author likes, and safe whatever they write:
//
//   - colours are `#rgb` / `#rrggbb` and nothing else, so no CSS reaches the page;
//   - the icon and the ticker are text, drawn as text;
//   - the banner is a picture shown through `<img>` — where even an SVG's script does not run — and
//     the host writes its bytes to `config/banner` at publish, so the page needs no URL and no bucket.

import type { AuthoredApp } from "./publishManifest.js";

export const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/u;
/** One file directly in `views/`, of a kind `<img>` draws without running anything. */
export const BANNER_PATH = /^views\/[A-Za-z0-9][A-Za-z0-9_-]*\.(?:png|jpe?g|webp|svg)$/u;
export const BANNER_SHAPE = "is one PNG, JPEG, WebP or SVG file directly inside views/ (e.g. views/banner.svg)";
/** Where the host writes the banner's bytes, beside `config/public`. */
export const BANNER_DOC = "banner";
/** The largest banner, in bytes before base64 — a document holds 1 MiB, and the page reads it on every open. */
export const BANNER_MAX_BYTES = 300_000;
/** The banner kinds, by extension, and the media type the page's `data:` URI carries. */
export const BANNER_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
};
export const TICKER_MAX_CHARS = 120;
export const MAX_GRADIENT_STOPS = 3;

export const isOneCharacter = (text: string): boolean => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length === 1;

/** What `config/public.theme` carries: the declaration less the banner's path, which only the host needs. */
export interface PageTheme {
  hue?: number;
  bar?: string[];
  barText?: string;
  background?: string[];
  icon?: string;
  ticker?: string;
  banner?: true;
}

const BANNER_FLAG: { banner: true } = { banner: true };

/** Key by key, so an absent one stays absent — never written as `undefined`. */
export const pageThemeProjection = (app: AuthoredApp): { theme?: PageTheme } => {
  const theme = app.theme;
  if (theme === undefined) return {};
  return {
    theme: {
      ...(theme.hue === undefined ? {} : { hue: theme.hue }),
      ...(theme.bar === undefined ? {} : { bar: theme.bar }),
      ...(theme.barText === undefined ? {} : { barText: theme.barText }),
      ...(theme.background === undefined ? {} : { background: theme.background }),
      ...(theme.icon === undefined ? {} : { icon: theme.icon }),
      ...(theme.ticker === undefined ? {} : { ticker: theme.ticker }),
      ...(theme.banner === undefined ? {} : BANNER_FLAG),
    },
  };
};
