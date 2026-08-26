/** Shared by the suites, not by `src/`. The runner globs `test/test_*.ts`, so this file is a
 *  module the tests import rather than a suite of its own. */

/** `.sort()`'s own order, spelled out: the rule that asks for a comparator cannot tell a string
 *  array from a number one, where the default really is wrong. Same order as the default, which
 *  matters where the expected value was produced by a bare `.sort()` in `src/`. */
export const byText = (a: string, b: string): number => Number(a > b) - Number(a < b);
