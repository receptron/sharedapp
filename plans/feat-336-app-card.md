# feat: app-only share cards (receptron/mulmoserver#336)

`shareCard` named a collection and a field: a card per row. An app that shows totals rather than rows
(tally, survey-results) wants only a card for itself. So:

- `collection` and `textField` become an optional PAIR (both or neither; Zod refine).
- `title` (optional, ≤ 200 chars) is what the app's own card draws; without it, the app's name.
- `"shareCard": {}` is therefore "a card for the app, none per row".
- The checks run only when the pair is present; the projection carries only declared keys.
