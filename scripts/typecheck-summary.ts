/** Runs the compiler twice per project — once for WHICH files it looked at, once for how much of
 *  what it saw has a real type — and renders the report beside this file.
 *
 *  Every spawn and every read is here, because the report itself is a pure function and stays
 *  testable that way. `--listFiles` rather than a glob over `include`: a project's real file set
 *  is the transitive import graph, and a file can be pulled in by an import from three
 *  directories away without appearing in any pattern.
 *
 *  Report-only. `yarn typecheck` is the gate that decides whether the types are right; this
 *  decides nothing, and a summary that cannot be written must not fail the run that produced it. */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { renderReport, type AnyLocation, type CandidateFile, type ProjectCoverage, type ProjectFiles, type ReportInput } from "./typecheck-report.js";

const DEFAULT_PROJECTS = ["tsconfig.json", "test/tsconfig.json", "scripts/tsconfig.json"];
const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const TIMEOUT_MS = 300_000;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const ROOT = process.cwd();

const run = (command: string, args: readonly string[]): string => {
  const result = spawnSync(command, [...args], { encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES, cwd: ROOT });
  if (result.error) throw new Error(`${command} ${args.join(" ")} failed to start: ${result.error.message}`);
  // A non-zero status is not a failure to REPORT: `tsc` exits 1 on a type error and still lists
  // every file it read, which is exactly the question being asked here.
  if (typeof result.stdout !== "string") throw new Error(`${command} ${args.join(" ")} produced no output`);
  return result.stdout;
};

const binary = (name: string): string => resolve(ROOT, "node_modules", ".bin", name);

/** Repo-relative, and only the files that belong to the repo — `--listFiles` includes every
 *  `lib.*.d.ts` and every dependency the graph reaches. */
const insideRepo = (paths: readonly string[]): string[] =>
  paths.map((path) => relative(ROOT, path)).filter((path) => path !== "" && !path.startsWith("..") && !path.split("/").includes("node_modules"));

const projectFiles = (project: string): ProjectFiles => ({
  project,
  files: insideRepo(run(binary("tsc"), ["-p", project, "--noEmit", "--listFiles"]).split("\n").filter(Boolean)),
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

const projectCoverage = (project: string): ProjectCoverage => {
  const output = run(binary("type-coverage"), ["-p", project, "--strict", "--detail", "--json-output"]);
  const parsed: unknown = JSON.parse(output);
  if (!isCoverageResult(parsed)) throw new Error(`type-coverage -p ${project} did not report counts: ${output.slice(0, 200)}`);
  return { project, correctCount: parsed.correctCount, totalCount: parsed.totalCount, anys: located(parsed.details) };
};

/** Tracked files only. An untracked scratch file is not something the repository is failing to
 *  check, and `git ls-files` is also what keeps `node_modules` and `dist` out without a rule. */
const candidates = (): CandidateFile[] =>
  run("git", ["ls-files"])
    .split("\n")
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

const projects = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_PROJECTS;
const input: ReportInput = {
  candidates: candidates(),
  projects: projects.map(projectFiles),
  coverage: projects.map(projectCoverage),
};
publish(renderReport(input));
