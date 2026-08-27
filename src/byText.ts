/** `.sort()`'s own order, spelled out.
 *
 *  A bare `.sort()` on strings is correct — the default converts to string and compares UTF-16
 *  code units, which is what `>` and `<` do on strings too — but the lint rule asking for an
 *  explicit comparator cannot tell a string array from a number one, where the default really
 *  is wrong. Passing this preserves the order EXACTLY, which matters because these sorts feed
 *  the refusal messages `publishChecks` returns and the tests assert on them verbatim. */
export const byText = (a: string, b: string): number => Number(a > b) - Number(a < b);
