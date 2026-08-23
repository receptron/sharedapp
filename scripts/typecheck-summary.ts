/** Runs the compiler twice per project — once for WHICH files it looked at, once for how much of
 *  what it saw has a real type — and renders the report beside this file.
 *
 *  Every spawn and every read is here, because the report itself is a pure function and stays
 *  testable that way. `--listFiles` rather than a glob over `include`: a project's real file set
 *  is the transitive import graph, and a file can be pulled in by an import from three
 *  directories away without appearing in any pattern.
 *
 *  `yarn typecheck` decides whether the types are RIGHT. This decides whether they are still as
 *  COMPLETE as they were: each project carries a floor, set at the value it stood at, and falling
 *  through one exits non-zero. A number nobody defends drifts — this repository has the receipt one
 *  file up, where a lint rule left at warn collected two new violations in the shadow of a note
 *  saying to raise it. The summary itself is still garnish: one that cannot be WRITTEN must not
 *  fail the run that produced it. */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  floorFailures,
  renderReport,
  type AnyLocation,
  type CandidateFile,
  type ProjectCoverage,
  type ProjectFiles,
  type ReportInput,
} from "./typecheck-report.js";

/** The floor is today's value, so the only way past it is to type what you added. Raise an entry
 *  when a project climbs; lowering one is a decision that belongs in a pull request with a reason,
 *  which is the whole point of it being written down here rather than inferred.
 *
 *  Three decimals on the test project, and not for tidiness: its denominator is ~17,000, where one
 *  new `any` moves the percentage by 0.006. A floor of `99.60` would sit BELOW the value a single
 *  regression lands on and wave it through. */
const PROJECTS: readonly { readonly project: string; readonly floor: number }[] = [
  { project: "tsconfig.json", floor: 99.92 }, //         the shipped package — 5 any, all in DOM event handlers
  { project: "test/tsconfig.json", floor: 99.605 }, //   src re-checked plus the suite
  { project: "scripts/tsconfig.json", floor: 100 }, //   nothing untyped here yet, and no reason for the first
];
const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const TIMEOUT_MS = 300_000;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const ROOT = process.cwd();

const run = (command: string, args: readonly string[]): string => {
  const result = spawnSync(command, [...args], { encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES, cwd: ROOT });
  if (result.error) throw new Error(`${command} ${args.join(" ")} failed to start: ${result.error.message}`);
  // A non-zero status is not a failure to REPORT — `type-coverage` exits 1 under `--at-least`,
  // and the counts it printed are still the answer.
  if (typeof result.stdout !== "string") throw new Error(`${command} ${args.join(" ")} produced no output`);
  return result.stdout;
};

const binary = (name: string): string => resolve(ROOT, "node_modules", ".bin", name);

/** Repo-relative, and only the files that belong to the repo — `--listFiles` includes every
 *  `lib.*.d.ts` and every dependency the graph reaches. */
const insideRepo = (paths: readonly string[]): string[] =>
  paths.map((path) => relative(ROOT, path)).filter((path) => path !== "" && !path.startsWith("..") && !path.split("/").includes("node_modules"));

/** `--listFilesOnly`, not `--listFiles`: `tsc` writes its DIAGNOSTICS to stdout, so a project with
 *  a type error prints `src/a.ts(5,3): error TS2322: …` into the middle of the file list, and a
 *  reader that treats every line as a path counts that as a file. The report runs on `always()`,
 *  which means it is read most often exactly when a project is failing to compile — the one
 *  condition under which the old flag was wrong. `--listFilesOnly` stops before type checking, so
 *  it emits nothing else and needs no `--noEmit`. */
const projectFiles = (project: string): ProjectFiles => ({
  project,
  files: insideRepo(run(binary("tsc"), ["-p", project, "--listFilesOnly"]).split("\n").filter(Boolean)),
});

const isAnyLocation = (value: unknown): value is { filePath: string; line: number; text: string } =>
  typeof value === "object" &&
  value !== null &&
  "filePath" in value &&
  typeof value.filePath === "string" &&
  "line" in value &&
  typeof value.line === "number" &&
  "text" in value &&
  typeof value.text === "string";

const isCoverageResult = (value: unknown): value is { correctCount: number; totalCount: number; details: unknown[] } =>
  typeof value === "object" &&
  value !== null &&
  "correctCount" in value &&
  typeof value.correctCount === "number" &&
  "totalCount" in value &&
  typeof value.totalCount === "number" &&
  "details" in value &&
  Array.isArray(value.details);

const located = (details: readonly unknown[]): AnyLocation[] =>
  details.filter(isAnyLocation).map((detail) => ({ file: relative(ROOT, detail.filePath), line: detail.line, text: detail.text }));

const floorFor = (project: string): number | null => PROJECTS.find((entry) => entry.project === project)?.floor ?? null;

const projectCoverage = (project: string): ProjectCoverage => {
  const output = run(binary("type-coverage"), ["-p", project, "--strict", "--detail", "--json-output"]);
  const parsed: unknown = JSON.parse(output);
  if (!isCoverageResult(parsed)) throw new Error(`type-coverage -p ${project} did not report counts: ${output.slice(0, 200)}`);
  return { project, correctCount: parsed.correctCount, totalCount: parsed.totalCount, anys: located(parsed.details), floor: floorFor(project) };
};

/** Tracked files only. An untracked scratch file is not something the repository is failing to
 *  check, and `git ls-files` is also what keeps `node_modules` and `dist` out without a rule. */
const candidates = (): CandidateFile[] =>
  // `-z`: without it `git ls-files` QUOTES a path holding a newline, a tab or a backslash, and the
  // quoted text is not the name of any file — so the one tracked source file that needs reporting
  // most is the one this would crash on.
  run("git", ["ls-files", "-z"])
    .split("\0")
    .filter((path) => SOURCE_EXTENSIONS.test(path))
    .map((path) => ({ path, lines: readFileSync(resolve(ROOT, path), "utf8").split("\n").length }));

const publish = (report: string): void => {
  process.stdout.write(report);
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath === undefined) return;
  try {
    appendFileSync(summaryPath, report);
  } catch (error) {
    process.stderr.write(`typecheck summary not written to ${summaryPath}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
};

const named = process.argv.slice(2);
const projects = named.length > 0 ? named : PROJECTS.map((entry) => entry.project);
const input: ReportInput = {
  candidates: candidates(),
  projects: projects.map(projectFiles),
  coverage: projects.map(projectCoverage),
};
publish(renderReport(input));

// Named on stderr as well as in the report: the summary is a page someone has to open, and this
// line is what a failed job shows in the log where the failure happened.
const failures = floorFailures(input.coverage);
failures.forEach((measured) => {
  process.stderr.write(`type coverage for ${measured.project} is below its floor of ${measured.floor}: ${measured.correctCount}/${measured.totalCount}\n`);
});
if (failures.length > 0) process.exitCode = 1;
