# feat: window.withdrawUntilField (#95)

The publishing half of receptron/mulmoserver#302 (rules in receptron/mulmoserver#303, deployed).

- Manifest: `public.submit[cid].window.withdrawUntilField: { ref, collection, field }`
- Projection: passed through beside `fromField` / `untilField`; dropping it would lift the deadline
- Gate: the same reference checks as the closing bound (collection exists, `ref` in `createFields`,
  the target field is a number), plus a deadline declared without `selfDelete` is refused
- `max-lines` ratchet for `src/publishChecks.ts` raised in this change, per the ratchet note

Verification: `test/test_withdrawUntilField.ts`; removing each of the four additions fails it.
