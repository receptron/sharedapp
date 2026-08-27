/** Runs the decision in `overrides-report.ts` against the real linter.
 *
 *  Everything here is the I/O half: load the flat config, ask ESLint one question per override,
 *  print, and exit non-zero when an override silences nothing or a block could not be read. The
 *  judgement of what counts as an override, which exemption removing means what, and what the answer
 *  means, lives next door with tests. */

import { ESLint, type Linter } from "eslint";

import { type Override, type Probe, isArray, withoutRule, renderReport, select, failed, unexpectedPresets } from "./overrides-report.js";

const CONFIG = new URL("../eslint.config.js", import.meta.url).href;

/** A flat config, as far as this script needs to know: an array of blocks. It reads `files`,
 *  `rules` and `name` off them and hands the rest straight back to ESLint, so the guard checks
 *  exactly what this script relies on and claims nothing more. */
const isFlatConfig = (value: unknown): value is Linter.Config[] => isArray(value) && value.every((entry) => typeof entry === "object" && entry !== null);

/** With this one exemption removed and nothing else changed, how much does its rule still report
 *  over the files it named? Zero means removing it changed nothing, so it silences nothing. The
 *  parser, the plugins and the type information all still come from the real config, so a typed
 *  rule answers exactly as it would in `yarn lint`. */
const reportsFor = async (config: readonly Linter.Config[], probe: Override): Promise<number> => {
  // `errorOnUnmatchedPattern: false`, because a `files` glob matching nothing is a real answer —
  // the override covers no file, so it silences nothing — and throwing would turn that answer
  // into a crash nobody can read.
  const removed = withoutRule(config, probe);
  if (!isFlatConfig(removed)) {
    throw new Error(`removing ${probe.rule} from block ${probe.index} did not leave a config array`);
  }
  const eslint = new ESLint({ overrideConfigFile: true, baseConfig: removed, cwd: process.cwd(), errorOnUnmatchedPattern: false });
  const results = await eslint.lintFiles([probe.file]);
  const fatal = results.flatMap((result) => result.messages).filter((message) => message.fatal === true);
  if (fatal.length > 0) {
    // A parse failure is the harness breaking, not an override going quiet, and counting its
    // messages as "not this rule" would report the override DEAD for a reason nobody could act on.
    throw new Error(`probing ${probe.rule} over ${probe.file} failed to parse: ${fatal[0]?.message ?? "unknown"}`);
  }
  return results.reduce((total, result) => total + result.messages.filter((message) => message.ruleId === probe.rule).length, 0);
};

/** A dynamic import is typed `any`, so it is read through `unknown` and narrowed rather than
 *  asserted: a config that stopped exporting an array should say so here, not fail later inside
 *  the probe loop where the message would be about something else. */
const loaded: unknown = await import(CONFIG);
const exported: unknown = typeof loaded === "object" && loaded !== null && "default" in loaded ? loaded.default : undefined;
if (!isFlatConfig(exported)) {
  console.error(`${CONFIG} did not export an array of config blocks`);
  process.exit(2);
}
const config: Linter.Config[] = exported;

const { overrides, unclassified, presets } = select(config);
const probes: Probe[] = [];
for (const override of overrides) {
  probes.push({ ...override, reports: await reportsFor(config, override) });
}

unexpectedPresets(presets).forEach((preset) => {
  console.error(
    `UNEXPECTED named block ${preset.index}: ${preset.name} — named blocks are not measured, so add it to EXPECTED_PRESETS only if it really is a preset`,
  );
});
console.log(renderReport(probes, unclassified, presets));
process.exit(failed(probes, unclassified, presets) ? 1 : 0);
