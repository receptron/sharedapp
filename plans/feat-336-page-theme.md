# feat: `theme` dresses the whole public page (receptron/mulmoserver#336)

"Like an old mobile site": loud, and safe whatever the author writes.

| key | what | rule |
|---|---|---|
| `hue` | as before (article pages), and the default bar colour | 0–359 |
| `bar` | the top bar, 1–3 colours (a gradient) | `#rgb` / `#rrggbb` only |
| `barText` | the bar's text | one colour |
| `background` | the ground behind the app, 1–3 colours | colours only |
| `icon` | beside the app's name (and on the share card) | one character |
| `ticker` | a marquee under the bar | ≤ 120 chars, text |
| `banner` | a picture under the bar | `views/<name>.(png|jpg|jpeg|webp|svg)` |

- Colours are hex only, so no CSS reaches the page. The banner is shown through `<img>`, where even an
  SVG runs nothing; the host writes its bytes to `config/banner` (base64, ≤ `BANNER_MAX_BYTES`), and
  `config/public.theme` says only `banner: true`.
- The old refusal of a `theme` on an app with no article page is removed: the theme now dresses every
  public page.
