# feat: `shareCard` (receptron/mulmoserver#336)

The declaration half of share cards (OGP). mulmoserver's `/og/` function draws the declared field of one
row onto a 1200×630 image, for a row a visitor may already read.

- `app.json`: `"shareCard": { "collection": cid, "textField": field }` (strict).
- Refused at publish: a collection in neither `public.read` nor `public.readPublished` (no row could
  ever be drawn); a `textField` the schema lacks, or one that is not string / text / markdown / enum.
- Projected to `config/public.shareCard` (absent when not declared). The deployed reader ignores
  unknown top-level keys.
