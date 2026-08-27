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
 *  The measurement is deliberately NOT "delete the block and re-lint the repo". That is slower,
 *  and it cannot be done at all for the block that supplies the type-aware parser — removing it
 *  crashes every typed rule, which measures the harness rather than the config. Forcing one rule
 *  back to `error` over the files the override names asks the same question directly.
 *
 *  Split from the runner so the decisions have tests: everything here is a function of plain
 *  data, and `scripts/lint-overrides.ts` supplies the linting. */

/** A hand-written per-file override: the files it names, and the rules it silences on them. */
export type Override = { readonly files: readonly string[]; readonly rules: readonly string[] };

/** One rule of one override, and how many reports that rule makes on those files with the
 *  override's silencing forced off. Zero means the override silences nothing. */
export type Probe = { readonly files: readonly string[]; readonly rule: string; readonly reports: number };

/** Compared as text, so the numeric spellings (`0`, `1`) are the same answer as the words. Held
 *  as strings rather than a mixed set because `Set.has` is identity: a set holding the NUMBER 0
 *  answers false for `String(0)`, and the block written `{ x: 0 }` would then be skipped in
 *  silence — which is the failure this whole check exists to catch. */
const SILENCED = new Set(["off", "0", "warn", "1"]);

const isStrings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** A rule's severity, whether it was written bare (`"warn"`) or with options (`["warn", {...}]`). */
const severityOf = (setting: unknown): unknown => (Array.isArray(setting) ? setting[0] : setting);

/** SILENCING: it names files and every rule in it is `off` or `warn`. A block that raises a rule,
 *  or sets one with an `error` ceiling, is a gate rather than an exemption — its liveness is a
 *  different question (does the ceiling still bind?) and this check does not answer it.
 *
 *  Nothing else is required of the block, and that is deliberate. An earlier version also demanded
 *  it carry no `languageOptions`, which was a leftover from measuring by DELETING the block —
 *  necessary there, because deleting the block that supplies the parser crashes every typed rule.
 *  Forcing one rule back on deletes nothing, so the condition only excluded a real exemption: the
 *  `scripts/` block declares node globals AND silences two rules with written reasons, and it was
 *  the one block the check could not see.
 *
 *  Nor is a preset excluded by name. Presets do name themselves and hand-written blocks here do
 *  not, but a hand-written block that gained a `name` would then drop out SILENTLY — the failure
 *  this whole check exists to catch. A preset that were ever all-silencing would instead show up
 *  as loud DEAD rows nobody wrote, which is a failure that gets fixed. */
export const silencingOverrideOf = (element: unknown): Override | null => {
  if (typeof element !== "object" || element === null) return null;
  const { files, rules }: Record<string, unknown> = { ...element };
  if (!isStrings(files) || files.length === 0) return null;
  if (typeof rules !== "object" || rules === null) return null;
  const settings = Object.entries({ ...rules });
  if (settings.length === 0 || !settings.every(([, setting]) => SILENCED.has(String(severityOf(setting))))) return null;
  return { files, rules: settings.map(([rule]) => rule) };
};

/** Every silencing override in a flat config, in the order the config declares them. */
export const silencingOverrides = (config: readonly unknown[]): Override[] =>
  config.flatMap((element) => {
    const override = silencingOverrideOf(element);
    return override === null ? [] : [override];
  });

/** One probe per (override, rule): an override silencing two rules can be dead in one and live in
 *  the other, and reporting the block as a whole would hide the dead half. */
export const probesFor = (overrides: readonly Override[]): { files: readonly string[]; rule: string }[] =>
  overrides.flatMap((override) => override.rules.map((rule) => ({ files: override.files, rule })));

export const deadProbes = (probes: readonly Probe[]): Probe[] => probes.filter((probe) => probe.reports === 0);

const line = (probe: Probe): string => `${probe.reports === 0 ? "DEAD" : "live"}  ${probe.rule}  <-  ${probe.files.join(", ")}`;

/** The whole report, dead entries last so the actionable half is what a truncated log keeps. */
export const renderReport = (probes: readonly Probe[]): string => {
  const dead = deadProbes(probes);
  const lines = [...probes.filter((probe) => probe.reports > 0), ...dead].map(line);
  const verdict =
    dead.length === 0
      ? `\nall ${probes.length} silencing overrides still suppress something`
      : `\n${dead.length} of ${probes.length} silencing overrides suppress NOTHING and should be deleted from eslint.config.js`;
  return [...lines, verdict].join("\n");
};
