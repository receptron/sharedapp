/** Runs the decision in `overrides-report.ts` against the real linter.
 *
 *  Everything here is the I/O half: load the flat config, ask ESLint one question per override,
 *  print, and exit non-zero when an override silences nothing or a block could not be read. The
 *  judgement of what counts as an override, where the forced rule has to go, and what the answer
 *  means, lives next door with tests. */

import { ESLint, type Linter } from "eslint";

import { type Override, type Probe, isArray, probeConfig, renderReport, select, failed } from "./overrides-report.js";

const CONFIG = new URL("../eslint.config.js", import.meta.url).href;

/** A flat config, as far as this script needs to know: an array of blocks. It reads `files`,
 *  `rules` and `name` off them and hands the rest straight back to ESLint, so the guard checks
 *  exactly what this script relies on and claims nothing more. */
const isFlatConfig = (value: unknown): value is Linter.Config[] => isArray(value) && value.every((entry) => typeof entry === "object" && entry !== null);

/** Forced to `error` on exactly the files the override names, with the rest of the config intact:
 *  the parser, the plugin and the type information all still come from the real config, so a typed
 *  rule answers the same way it would in `yarn lint`. */
const reportsFor = async (config: readonly Linter.Config[], probe: Override): Promise<number> => {
  // `errorOnUnmatchedPattern: false`, because a `files` glob matching nothing is a real answer —
  // the override covers no file, so it silences nothing — and throwing would turn that answer
  // into a crash nobody can read.
  const forced: Linter.Config = { files: [...probe.files], rules: { [probe.rule]: "error" } };
  const eslint = new ESLint({ overrideConfigFile: true, baseConfig: probeConfig(config, probe, forced), cwd: process.cwd(), errorOnUnmatchedPattern: false });
  const results = await eslint.lintFiles([...probe.files]);
  const fatal = results.flatMap((result) => result.messages).filter((message) => message.fatal === true);
  if (fatal.length > 0) {
    // A parse failure is the harness breaking, not an override going quiet, and counting its
    // messages as "not this rule" would report the override DEAD for a reason nobody could act on.
    throw new Error(`probing ${probe.rule} over ${probe.files.join(", ")} failed to parse: ${fatal[0]?.message ?? "unknown"}`);
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

console.log(renderReport(probes, unclassified, presets));
process.exit(failed(probes, unclassified) ? 1 : 0);
