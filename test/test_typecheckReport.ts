/** The report is a pure function, so the shapes that make it wrong are testable without a
 *  compiler: a file two projects both check, a file nobody checks, a repository with nothing in
 *  it, and a path carrying the characters that end a table cell or a chart label. */
import test from "node:test";
import assert from "node:assert";
import { renderReport, type ReportInput } from "../scripts/typecheck-report.js";

const input = (overrides: Partial<ReportInput> = {}): ReportInput => ({
  candidates: [{ path: "src/a.ts", lines: 10 }],
  projects: [{ project: "tsconfig.json", files: ["src/a.ts"] }],
  coverage: [{ project: "tsconfig.json", correctCount: 100, totalCount: 100, anys: [] }],
  ...overrides,
});

test("a file no project holds is the finding, and a file a project holds is not", () => {
  const report = renderReport(
    input({
      candidates: [
        { path: "src/a.ts", lines: 10 },
        { path: "scripts/loose.mjs", lines: 87 },
      ],
    }),
  );
  // Both halves matter: a report that lists everything as unchecked would pass an assertion
  // about the unchecked one alone.
  assert.match(report, /### Checked by nothing — 1/);
  assert.match(report, /\| `scripts\/loose\.mjs` \| 87 \|/);
  assert.ok(!report.includes("| `src/a.ts` | 10 |"), "a checked file must not appear in the unchecked table");
  assert.match(report, /"checked by nothing" : 1/);
});

test("the headline counts each file once, however many projects check it", () => {
  const report = renderReport(
    input({
      candidates: [
        { path: "src/a.ts", lines: 10 },
        { path: "test/t.ts", lines: 20 },
      ],
      projects: [
        { project: "tsconfig.json", files: ["src/a.ts"] },
        { project: "test/tsconfig.json", files: ["src/a.ts", "test/t.ts"] },
      ],
    }),
  );
  assert.match(report, /## Typecheck coverage — 2\/2 files \(100\.0%\)/);
  // The bucket names the whole answer rather than the first project found: "which of these two
  // is the one checking it" is not a question with an answer.
  assert.match(report, /"tsconfig\.json \+ test\/tsconfig\.json" : 1/);
  assert.match(report, /"test\/tsconfig\.json" : 1/);
});

test("a partly-checked repository reports the fraction, not a verdict", () => {
  const candidates = Array.from({ length: 46 }, (_unused, index) => ({ path: `src/f${index}.ts`, lines: 1 }));
  const report = renderReport(
    input({
      candidates,
      projects: [{ project: "tsconfig.json", files: candidates.slice(0, 43).map((file) => file.path) }],
    }),
  );
  assert.match(report, /## Typecheck coverage — 43\/46 files \(93\.5%\)/);
});

test("an empty repository reports 100%, not NaN", () => {
  const report = renderReport(input({ candidates: [], projects: [], coverage: [] }));
  assert.match(report, /## Typecheck coverage — 0\/0 files \(100\.0%\)/);
  assert.ok(!report.includes("NaN"), "a division by zero must not reach the report");
  assert.match(report, /Every file is in a project\./);
});

test("a path that would end a table cell is escaped instead", () => {
  const report = renderReport(input({ candidates: [{ path: "src/we|ird`.ts", lines: 3 }], projects: [] }));
  const row = report.split("\n").find((line) => line.includes("we")) ?? "";
  assert.ok(row.includes("we\\|ird'"), `expected the pipe escaped and the backtick replaced, got ${row}`);
  // A row is only readable as a row if it still has the columns the header promised.
  assert.equal(row.split("|").length - row.split("\\|").length + 1, 5);
});

test("a project name that would truncate a chart label is disarmed", () => {
  const report = renderReport(input({ projects: [{ project: 'a"b', files: ["src/a.ts"] }] }));
  const slice = report.split("\n").find((line) => line.trim().startsWith('"a')) ?? "";
  assert.equal(slice.trim(), `"a'b" : 1`);
});

test("type coverage reports two decimals, because one identifier moves the third", () => {
  const report = renderReport(input({ coverage: [{ project: "tsconfig.json", correctCount: 6458, totalCount: 6463, anys: [] }] }));
  assert.match(report, /99\.92% typed \(5 of 6463 any\)/);
});

test("a project with no any gets the headline and no table of them", () => {
  const report = renderReport(input());
  assert.match(report, /100\.00% typed \(0 of 100 any\)/);
  assert.ok(!report.includes("| file | any | |"), "there is nothing to tabulate");
});

test("the any table ranks files and says how many it left out", () => {
  const anys = Array.from({ length: 12 }, (_unused, index) => ({ file: `src/f${index}.ts`, line: 1, text: "x" }));
  const report = renderReport(
    input({
      coverage: [
        {
          project: "tsconfig.json",
          correctCount: 88,
          totalCount: 100,
          // The first file gets three, so ranking is visible rather than incidental order.
          anys: [...anys, { file: "src/f0.ts", line: 2, text: "y" }, { file: "src/f0.ts", line: 3, text: "z" }],
        },
      ],
    }),
  );
  const rows = report.split("\n").filter((line) => line.startsWith("| `src/f"));
  assert.equal(rows.length, 10);
  assert.match(rows[0] ?? "", /`src\/f0\.ts` \| 3 \|/);
  assert.match(report, /2 more files not shown\./);
});
