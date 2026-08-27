/** Runs the decision in `overrides-report.ts` against the real linter.
 *
 *  Everything here is the I/O half: load the flat config, ask ESLint one question per override,
 *  print, and exit non-zero when an override silences nothing. The judgement of what counts as an
 *  override, and what the answer means, lives next door with tests. */

import { ESLint } from "eslint";

import { type Probe, probesFor, renderReport, silencingOverrides, deadProbes } from "./overrides-report.js";

const CONFIG = new URL("../eslint.config.js", import.meta.url).href;

/** Forced to `error` on exactly the files the override names, with the rest of the config intact:
 *  the parser, the plugin and the type information all still come from the real config, so a typed
 *  rule answers the same way it would in `yarn lint`. `overrideConfig` is appended, and the last
 *  matching entry wins, so this beats the override being measured. */
const reportsFor = async (files: readonly string[], rule: string): Promise<number> => {
  const eslint = new ESLint({ overrideConfig: [{ files: [...files], rules: { [rule]: "error" } }] });
  const results = await eslint.lintFiles([...files]);
  return results.reduce((total, result) => total + result.messages.filter((message) => message.ruleId === rule).length, 0);
};

/** A dynamic import is typed `any`, so it is read through `unknown` and narrowed rather than
 *  asserted: a config that stopped exporting an array should say so here, not fail later inside
 *  the probe loop where the message would be about something else. */
const loaded: unknown = await import(CONFIG);
const config: unknown = typeof loaded === "object" && loaded !== null && "default" in loaded ? loaded.default : undefined;
if (!Array.isArray(config)) {
  console.error(`${CONFIG} did not export an array`);
  process.exit(2);
}

const probes: Probe[] = [];
for (const probe of probesFor(silencingOverrides(config))) {
  probes.push({ ...probe, reports: await reportsFor(probe.files, probe.rule) });
}

console.log(renderReport(probes));
process.exit(deadProbes(probes).length === 0 ? 0 : 1);
