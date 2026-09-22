// The contact surface with `@mulmoclaude/core`, held by RUNNING it.
//
// This package declares core as a PEER, so the copy it meets belongs to the host, not to this
// repository. A peer range is a claim about versions nobody here installs, and the way that claim
// used to be checked was by pinning ONE version in `devDependencies` and running the suite against
// it — which answers a different question, and answered it about a major the hosts had already
// left. The mismatch surfaced in a consumer's dependency audit rather than here.
//
// So these tests call each imported symbol and assert the ANSWER. "It resolves" is not the check:
// the failure that prompted this file was a runtime one — a subpath that type-checked, imported
// cleanly in the editor, and threw `ERR_MODULE_NOT_FOUND` the moment a test loaded it.
//
// A change in core that breaks any assertion here is a change this package must follow. That is
// the point: it goes red HERE, on a version this repository installs, rather than in a host.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { isValidCollectionName } from "@mulmoclaude/core/collection";
import { isSafeCustomViewPath } from "@mulmoclaude/core/collection/paths";
import { parseAppManifest, type AppManifestResult } from "@mulmoclaude/core/collection/server";

import { parseAuthoredApp } from "../src/publishManifest.js";
import { byText } from "../src/byText.js";

test("isValidCollectionName accepts the slug shape and refuses everything that could build a path", () => {
  ["bookings", "a", "A", "x_y", "x-y"].forEach((name) => {
    assert.equal(isValidCollectionName(name), true, `should accept ${JSON.stringify(name)}`);
  });
  // The refusals are the load-bearing half: every one of these, accepted, becomes a segment in a
  // Firestore path this package builds.
  ["", "x.y", "x/y", "../x", "x y", "日本語"].forEach((name) => {
    assert.equal(isValidCollectionName(name), false, `should refuse ${JSON.stringify(name)}`);
  });
});

test("isSafeCustomViewPath refuses climbing out, a non-HTML file, and a differently-cased prefix", () => {
  assert.equal(isSafeCustomViewPath("views/booking.html"), true);
  ["views/../x.html", "views/", "views/a.js", "views/a.htm", "VIEWS/a.html", "booking.html", "/views/a.html", ""].forEach((path) => {
    assert.equal(isSafeCustomViewPath(path), false, `should refuse ${JSON.stringify(path)}`);
  });
});

// `publishChecks` pairs this predicate with its OWN segment-count guard, so the division of labour
// is worth pinning: core permits a sub-directory here and this package is what forbids it. If core
// ever tightened this, the local guard would become dead code that still reads as the thing doing
// the work; if core loosened the `..` refusal, the local guard would go on passing a climb.
test("isSafeCustomViewPath permits a sub-directory — the one-file rule belongs to this package", () => {
  assert.equal(isSafeCustomViewPath("views/sub/a.html"), true);
});

/** The failure `detail`. It exists on every failure branch EXCEPT `missing`, and that asymmetry
 *  is what `parseAuthoredApp` encodes — it substitutes its own words for `missing` and passes
 *  `detail` through for the rest. A fourth branch without `detail` would break that line. */
const detailOf = (result: AppManifestResult): string | undefined => (!result.ok && result.kind !== "missing" ? result.detail : undefined);

test("parseAppManifest reports failure as ok/kind/detail, which is what parseAuthoredApp reads", () => {
  const notJson = parseAppManifest("{ not json");
  assert.equal(notJson.ok, false);
  assert.equal(notJson.kind, "malformed");
  assert.match(detailOf(notJson) ?? "", /not valid JSON/);

  const noAid = parseAppManifest(JSON.stringify({ name: "x" }));
  assert.equal(noAid.ok, false);
  assert.equal(noAid.kind, "malformed");
  assert.match(detailOf(noAid) ?? "", /aid/);
});

test("parseAppManifest reports success with the parsed aid", () => {
  const parsed = parseAppManifest(JSON.stringify({ aid: "ok-app" }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.manifest.aid, "ok-app");
});

// The wiring, end to end: a core answer this package only ever reads through its own entry point.
test("parseAuthoredApp carries core's failure detail through as an actionable line", () => {
  const notJson = parseAuthoredApp("{ not json");
  assert.equal(notJson.ok, false);
  assert.match(notJson.problems[0] ?? "", /not valid JSON/);

  const noAid = parseAuthoredApp(JSON.stringify({ name: "x" }));
  assert.equal(noAid.ok, false);
  assert.match(noAid.problems[0] ?? "", /aid/);
});

const SRC_DIR = new URL("../src/", import.meta.url);

const tsFilesUnder = (dir: URL): URL[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return tsFilesUnder(new URL(`${entry.name}/`, dir));
    return entry.name.endsWith(".ts") ? [new URL(entry.name, dir)] : [];
  });

/** Every `@mulmoclaude/core` specifier in a file, and whether the clause importing it was
 *  type-only — read back from the LAST `import` before the specifier, so a clause broken over
 *  several lines is measured the same as a one-liner. */
const coreImportsIn = (source: string): { specifier: string; typeOnly: boolean }[] =>
  [...source.matchAll(/from\s+"(@mulmoclaude\/core[^"]*)"/g)].map((match) => {
    const before = source.slice(0, match.index);
    const clause = before.slice(before.lastIndexOf("import"));
    return { specifier: match[1] ?? "", typeOnly: /^import\s+type\b/.test(clause) };
  });

const SRC_CORE_IMPORTS = tsFilesUnder(SRC_DIR).flatMap((file) => coreImportsIn(readFileSync(file, "utf8")));

// A source-text guard that finds nothing passes every assertion about what it did not find, so the
// scan states its own catch before it states its conclusion.
test("the import scan reaches the files that import core", () => {
  assert.ok(SRC_CORE_IMPORTS.length > 0, "scanned src/ and found no core import at all — the scan is broken, not the imports");
  assert.ok(
    SRC_CORE_IMPORTS.some((found) => found.specifier === "@mulmoclaude/core/collection/server"),
    "expected the manifest parse to still come from the server entry",
  );
});

// WHICH subpaths are loaded is a runtime cost, not a style question. `collection/server` is core's
// server half, and reaching one symbol from it loads all of it. One symbol is reached through it
// (`parseAppManifest`, the single statement of the `aid` rule), and nothing else here may grow a
// second reason to reach for it without this going red.
test("src reaches core through exactly these subpaths, for values", () => {
  const forValues = [...new Set(SRC_CORE_IMPORTS.filter((found) => !found.typeOnly).map((found) => found.specifier))].sort(byText);
  assert.deepEqual(forValues, ["@mulmoclaude/core/collection", "@mulmoclaude/core/collection/paths", "@mulmoclaude/core/collection/server"]);
});

test("src reaches core through exactly these subpaths, counting type-only clauses too", () => {
  const all = [...new Set(SRC_CORE_IMPORTS.map((found) => found.specifier))].sort(byText);
  assert.deepEqual(all, ["@mulmoclaude/core/collection", "@mulmoclaude/core/collection/paths", "@mulmoclaude/core/collection/server"]);
});
