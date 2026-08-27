/** `.sort()`'s own order, spelled out.
 *
 *  A bare `.sort()` on strings is correct — the default converts to string and compares UTF-16
 *  code units, which is what `>` and `<` do on strings too — but the lint rule asking for an
 *  explicit comparator cannot tell a string array from a number one, where the default really
 *  is wrong. Passing this preserves the order EXACTLY, and every caller's order is OBSERVABLE:
 *  the refusal lines `publishChecks` returns (asserted verbatim by the suite), the
 *  `memberEmails` and writer lists the projections publish — where a second publish of an
 *  unchanged declaration must produce an unchanged document — and the ok/MISSING lines the
 *  pack and apps checks print. So it has to be the default's order, never a locale's. */
export const byText = (a: string, b: string): number => Number(a > b) - Number(a < b);
