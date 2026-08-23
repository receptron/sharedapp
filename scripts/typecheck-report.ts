/** The typecheck report, as a pure function of what the compiler said.
 *
 *  Two questions, and they only mean something together. "Is this file typechecked AT ALL" —
 *  a file in no `tsconfig` is checked by nobody, and nothing about a green `yarn typecheck`
 *  says otherwise, because the check never looked. "How much of what IS checked has a real
 *  type" — a file full of `any` passes every compiler flag this repository sets while proving
 *  nothing. Either number alone flatters: an unchecked file cannot lower a type-coverage
 *  percentage, and a fully-`any` file counts as covered.
 *
 *  Kept free of I/O so the shapes that make a report wrong — a file in two projects, a file in
 *  none, an empty repository, a path holding a `|` — are testable without running a compiler.
 *  The runner beside this file owns every spawn and every read. */

const BAR_WIDTH = 24;
const TOP_ANY_FILES = 10;
const FILE_PERCENT_DIGITS = 1;
// Two digits, because the number is meant to be defended: at this size one identifier moves the
// third digit, and a drop of 0.02 is thirteen of them.
const TYPE_PERCENT_DIGITS = 2;
const UNCHECKED = "checked by nothing";
const PROJECT_JOIN = " + ";

export type AnyLocation = { readonly file: string; readonly line: number; readonly text: string };
export type ProjectFiles = { readonly project: string; readonly files: readonly string[] };
export type ProjectCoverage = {
  readonly project: string;
  readonly correctCount: number;
  readonly totalCount: number;
  readonly anys: readonly AnyLocation[];
};
export type CandidateFile = { readonly path: string; readonly lines: number };
export type ReportInput = {
  readonly candidates: readonly CandidateFile[];
  readonly projects: readonly ProjectFiles[];
  readonly coverage: readonly ProjectCoverage[];
};

const percent = (part: number, whole: number, digits: number): string => (whole === 0 ? (100).toFixed(digits) : ((part * 100) / whole).toFixed(digits));

/** A rule id, a path and a compiler's own text all reach a table cell, and any of them can hold
 *  a `|` that ends the cell or a backtick that ends the code span around it. */
const cell = (value: string): string => `\`${value.replaceAll("`", "'").replaceAll("|", "\\|").replaceAll("\n", " ")}\``;

/** Mermaid ends a slice label at the first quote, so a label carrying one silently truncates the
 *  rest of the chart. Labels here are built from tsconfig paths, which a caller chooses. */
const label = (value: string): string => value.replaceAll('"', "'").replaceAll("\n", " ");

const bar = (count: number, max: number): string => (max === 0 ? "" : "█".repeat(Math.max(1, Math.round((count / max) * BAR_WIDTH))));

const pie = (title: string, slices: readonly (readonly [string, number])[]): string[] => [
  "```mermaid",
  `pie showData title ${label(title)}`,
  ...slices.map(([name, count]) => `  "${label(name)}" : ${count}`),
  "```",
];

/** Which projects check this file — the empty answer is the finding. */
const checkedBy = (projects: readonly ProjectFiles[], path: string): string[] => projects.filter((p) => p.files.includes(path)).map((p) => p.project);

const bucketOf = (names: readonly string[]): string => (names.length === 0 ? UNCHECKED : names.join(PROJECT_JOIN));

const descending = (counts: ReadonlyMap<string, number>): [string, number][] => [...counts.entries()].sort((a, b) => b[1] - a[1]);

const tally = (entries: readonly string[]): Map<string, number> =>
  entries.reduce((counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1), new Map<string, number>());

const fileHeadline = (checked: number, total: number): string =>
  `## Typecheck coverage — ${checked}/${total} files (${percent(checked, total, FILE_PERCENT_DIGITS)}%)`;

const projectTable = (projects: readonly ProjectFiles[]): string[] => {
  const max = projects.reduce((most, p) => Math.max(most, p.files.length), 0);
  return ["| project | files | |", "|---|--:|---|", ...projects.map((p) => `| ${cell(p.project)} | ${p.files.length} | ${bar(p.files.length, max)} |`)];
};

const uncheckedTable = (unchecked: readonly CandidateFile[]): string[] => {
  if (unchecked.length === 0) return ["Every file is in a project."];
  const max = unchecked.reduce((most, file) => Math.max(most, file.lines), 0);
  return ["| file | lines | |", "|---|--:|---|", ...unchecked.map((file) => `| ${cell(file.path)} | ${file.lines} | ${bar(file.lines, max)} |`)];
};

const anyTable = (anys: readonly AnyLocation[]): string[] => {
  const byFile = descending(tally(anys.map((location) => location.file)));
  const shown = byFile.slice(0, TOP_ANY_FILES);
  const max = shown.reduce((most, [, count]) => Math.max(most, count), 0);
  const hidden = byFile.length - shown.length;
  return [
    "| file | any | |",
    "|---|--:|---|",
    ...shown.map(([file, count]) => `| ${cell(file)} | ${count} | ${bar(count, max)} |`),
    ...(hidden > 0 ? ["", `${hidden} more files not shown.`] : []),
  ];
};

const coverageSection = (measured: ProjectCoverage): string[] => {
  const anyCount = measured.totalCount - measured.correctCount;
  return [
    `### ${cell(measured.project)} — ${percent(measured.correctCount, measured.totalCount, TYPE_PERCENT_DIGITS)}% typed (${anyCount} of ${measured.totalCount} any)`,
    "",
    ...pie(`Typed vs any — ${measured.project}`, [
      ["typed", measured.correctCount],
      ["any", anyCount],
    ]),
    ...(anyCount === 0 ? [] : ["", ...anyTable(measured.anys)]),
  ];
};

export const renderReport = (input: ReportInput): string => {
  const buckets = input.candidates.map((file) => bucketOf(checkedBy(input.projects, file.path)));
  const unchecked = input.candidates.filter((file) => checkedBy(input.projects, file.path).length === 0);
  const checked = input.candidates.length - unchecked.length;
  return [
    fileHeadline(checked, input.candidates.length),
    "",
    ...pie("Files by project", descending(tally(buckets))),
    "",
    ...projectTable(input.projects),
    "",
    `### Checked by nothing — ${unchecked.length}`,
    "",
    ...uncheckedTable(unchecked),
    "",
    "## Type coverage",
    "",
    ...input.coverage.flatMap((measured) => [...coverageSection(measured), ""]),
  ].join("\n");
};
