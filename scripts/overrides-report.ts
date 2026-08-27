/** Which per-file eslint overrides are still doing something, as a pure decision.
 *
 *  `eslint.config.js` silences rules per file in two forms: a DEBT entry at `warn`, and an `off`
 *  with a written reason. Both are checked in ONE direction only. `yarn lint` proves an entry that
 *  was DELETED is at zero — the rule is an error everywhere else, so it would go red. Nothing
 *  proves the opposite: that an entry still KEPT silences anything at all.
 *
 *  A kept entry whose findings have since been fixed tells two lies. It reads as "this file still
 *  has that problem", and it hides that the rule quietly stopped being an error there. Both were
 *  live in this repository: a `no-nested-conditional` entry survived the rewrite of the file it
 *  named, and the PR that pruned the ledger of zeroed entries left that one behind.
 *
 *  NOTHING IS SKIPPED IN SILENCE. That is the shape of this module and it was arrived at the hard
 *  way: three separate versions of the predicate quietly dropped a block it did not recognise —
 *  one excluded anything carrying `languageOptions` and so could not see the `scripts/` exemptions
 *  at all; one held its severities in a mixed `Set` so a rule written `0` compared false; one took
 *  a block to be silencing only if EVERY rule in it was, so `{ x: "off", y: "error" }` vanished
 *  whole. Each was a false LIVE, which is the failure this check exists to catch, wearing the
 *  check's own uniform. So the rule is inverted: every block naming `files` and `rules` is
 *  classified rule by rule, and a shape this module cannot classify is REPORTED, never skipped.
 *
 *  The measurement is deliberately NOT "delete the block and re-lint the repo". That is slower,
 *  and it cannot be done at all for the block that supplies the type-aware parser — removing it
 *  crashes every typed rule, which measures the harness rather than the config. Forcing one rule
 *  back to `error` asks the same question directly, PROVIDED it is forced in the right place: see
 *  {@link probeConfig}.
 *
 *  Split from the runner so the decisions have tests: everything here is a function of plain data,
 *  and `scripts/lint-overrides.ts` supplies the linting. */

/** A rule silenced for a set of files, and WHERE in the config array it was silenced. The index is
 *  not decoration — {@link probeConfig} needs it, and an earlier version that discarded it got the
 *  wrong answer whenever two blocks silenced one rule over the same file. */
export type Override = { readonly index: number; readonly files: readonly string[]; readonly rule: string };

/** A block this module could not classify. Reported rather than skipped: a shape nobody thought of
 *  is exactly how a real exemption stops being measured without anyone noticing. */
export type Unclassified = { readonly index: number; readonly why: string };

export type Selection = { readonly overrides: Override[]; readonly unclassified: Unclassified[]; readonly presets: number };

/** One override's answer: how many reports its rule makes on its files with the silencing forced
 *  off. Zero means the override silences nothing. */
export type Probe = Override & { readonly reports: number };

const SILENCING = new Set(["off", "0", "warn", "1"]);
const ENFORCING = new Set(["error", "2"]);

/** `Array.isArray` alone narrows `unknown` to `any[]`, and every element read off it is then an
 *  `any` that spreads — four of them, the first time this module was written, into a project whose
 *  type-coverage floor is 100. This says the same thing and keeps the elements `unknown`. */
export const isArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

/** A rule's severity, whether written bare (`"warn"`) or with options (`["warn", {...}]`). */
const severityOf = (setting: unknown): string => String(isArray(setting) ? setting[0] : setting);

const asRecord = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null ? { ...value } : null);

/** Every silencing override THIS REPOSITORY wrote, plus every block whose shape could not be read,
 *  plus a count of the preset blocks deliberately left unmeasured.
 *
 *  A block with no `files` or no `rules` is not a per-file exemption at all — that is the base
 *  config — and is passed over rather than reported.
 *
 *  A NAMED block is a preset. ESLint's convention is that shared configs name themselves and this
 *  repository's hand-written blocks do not, so the name is the only runtime signal separating "an
 *  exemption someone here wrote and must maintain" from "a default a dependency ships". Measuring
 *  presets is not merely noise: `typescript-eslint/eslint-recommended` turns off twenty-three core
 *  rules because the compiler covers them, every one of which reports nothing and would arrive as
 *  a DEAD row telling a maintainer to delete something they do not own.
 *
 *  They are COUNTED rather than dropped, so "not measured" is a number in the report instead of an
 *  absence. If this repository ever names its own blocks, that count moves and the footer says so
 *  — which is the loud version of the failure this module exists to prevent. */
export const select = (config: readonly unknown[]): Selection => {
  const overrides: Override[] = [];
  const unclassified: Unclassified[] = [];
  let presets = 0;
  config.forEach((element, index) => {
    const block = asRecord(element);
    const rules = block === null ? null : asRecord(block["rules"]);
    if (block === null || block["files"] === undefined || rules === null) return;
    if (block["name"] !== undefined) {
      presets += 1;
      return;
    }
    const files = block["files"];
    if (!isArray(files) || files.length === 0 || files.some((entry) => typeof entry !== "string")) {
      // Includes ESLint's AND form, `files: [["src/*", "**/*.ts"]]`. Legal, unsupported here, and
      // reported rather than dropped so nobody has to notice its absence from the count.
      unclassified.push({ index, why: `files is ${JSON.stringify(files)}; only an array of plain patterns is supported` });
      return;
    }
    const named: string[] = files.filter((entry): entry is string => typeof entry === "string");
    Object.entries(rules).forEach(([rule, setting]) => {
      const severity = severityOf(setting);
      if (SILENCING.has(severity)) overrides.push({ index, files: named, rule });
      else if (!ENFORCING.has(severity)) unclassified.push({ index, why: `rule ${rule} has severity ${severity}, which is neither silencing nor enforcing` });
    });
  });
  return { overrides, unclassified, presets };
};

/** The config to lint with, to ask whether `override` silences anything.
 *
 *  The forced block goes IMMEDIATELY AFTER the block being measured, never at the end. In a flat
 *  config the last matching entry wins, so an appended block also beats every LATER block — and a
 *  later block silencing the same rule over the same files is exactly what makes the measured one
 *  dead. Appending reported such a block as live; measured on a three-block config over one file,
 *  appending gave 1 report where deleting the block gave 0. */
export const probeConfig = <Block>(config: readonly Block[], override: Override, forced: Block): Block[] => [
  ...config.slice(0, override.index + 1),
  forced,
  ...config.slice(override.index + 1),
];

export const deadProbes = (probes: readonly Probe[]): Probe[] => probes.filter((probe) => probe.reports === 0);

const line = (probe: Probe): string => `${probe.reports === 0 ? "DEAD" : "live"}  ${probe.rule}  <-  ${probe.files.join(", ")}`;

/** The whole report. Dead entries and unreadable blocks come last, so the actionable half is what a
 *  truncated log keeps. */
export const renderReport = (probes: readonly Probe[], unclassified: readonly Unclassified[], presets: number): string => {
  const dead = deadProbes(probes);
  const lines = [...probes.filter((probe) => probe.reports > 0), ...dead].map(line);
  const unread = unclassified.map((block) => `UNREAD  eslint.config.js element ${block.index}: ${block.why}`);
  const footer = `(${presets} named block(s) are presets and were not measured)`;
  if (dead.length === 0 && unclassified.length === 0) {
    return [...lines, `\nall ${probes.length} silencing overrides still suppress something ${footer}`].join("\n");
  }
  const unreadable = unclassified.length === 0 ? "" : `, and ${unclassified.length} block(s) could not be read, so they were never measured`;
  const verdict = `\n${dead.length} of ${probes.length} silencing overrides suppress NOTHING and should be deleted from eslint.config.js${unreadable} ${footer}`;
  return [...lines, ...unread, verdict].join("\n");
};

export const failed = (probes: readonly Probe[], unclassified: readonly Unclassified[]): boolean => deadProbes(probes).length > 0 || unclassified.length > 0;
