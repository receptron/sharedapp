// The contact surface with `@mulmoclaude/core`, held by RUNNING it.
//
// Core is a PEER, so the copy this package meets belongs to the host. A peer range is a claim about
// versions this repository does not choose, and the only way to keep it honest is to run against
// them. So these tests call each imported symbol and assert the ANSWER. "It resolves" is not the
// check, because the failure this guards against arrives at load time: a subpath that type-checks
// and then throws `ERR_MODULE_NOT_FOUND` when a test imports it.
//
// A change in core that breaks any assertion here is a change this package must follow. That is
// the point: it goes red HERE, on a version this repository installs, rather than in a host.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { isValidCollectionName } from "@mulmoclaude/core/collection";
import { isSafeCustomViewPath } from "@mulmoclaude/core/collection/paths";
import { parseAppManifest, type AppManifestResult } from "@mulmoclaude/core/collection/server";

import { reachesIn, UNRESOLVED, type ModuleReach } from "./importScan.js";
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

// The wiring, end to end. The not-JSON case is pinned beside its siblings in test_authoredApp.ts.
test("parseAuthoredApp carries core's missing-aid detail through as an actionable line", () => {
  const noAid = parseAuthoredApp(JSON.stringify({ name: "x" }));
  assert.equal(noAid.ok, false);
  assert.match(noAid.problems[0] ?? "", /aid/);
});

// Every test that imports `src` loads `collection/server`, and that load is this suite's evidence
// that the declared floor of core needs no `firebase` — which core declares an OPTIONAL peer. The
// evidence is empty the moment `firebase` is installed here for another reason, so it is asserted.
test("firebase is not installed, so loading collection/server shows it needs none", () => {
  assert.throws(() => createRequire(import.meta.url).resolve("firebase"), { code: "MODULE_NOT_FOUND" });
});

const CORE = "@mulmoclaude/core";

/** subpath → the names reached through it, over every reach `pick` counts. A counted reach with no
 *  names still makes its subpath a key: a bare `import "…"` loads a module all the same. */
const namesBySubpath = (reaches: readonly ModuleReach[], pick: (reach: ModuleReach) => readonly string[] | undefined): Record<string, string[]> => {
  const bySubpath = new Map<string, Set<string>>();
  reaches.forEach((reach) => {
    const names = pick(reach);
    if (names === undefined) return;
    const known = bySubpath.get(reach.specifier) ?? new Set<string>();
    names.forEach((name) => known.add(name));
    bySubpath.set(reach.specifier, known);
  });
  return Object.fromEntries([...bySubpath].map(([subpath, names]) => [subpath, [...names].sort(byText)]));
};

const SRC_DIR = new URL("../src/", import.meta.url);

const tsFilesUnder = (dir: URL): URL[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return tsFilesUnder(new URL(`${entry.name}/`, dir));
    return entry.name.endsWith(".ts") ? [new URL(entry.name, dir)] : [];
  });

// `test_importScan.ts` holds the scan's own tests, in both directions. What is pinned here is what
// `src` reaches THROUGH it.
const SRC_REACHES = tsFilesUnder(SRC_DIR)
  .flatMap((file) => reachesIn(file.pathname, readFileSync(file, "utf8")))
  .filter((reach) => reach.specifier.startsWith(CORE) || reach.specifier === UNRESOLVED);

// Which names load from which subpath is a runtime cost and a contract, not a style question.
// `collection/server` is core's server half, and reaching one name from it loads all of it, so the
// one name reached through it — `parseAppManifest`, the single statement of the `aid` rule — is
// pinned. A second name, a new subpath, or a bare or dynamic import of either goes red here.
test("src reaches core at runtime through exactly these names", () => {
  assert.deepEqual(
    namesBySubpath(SRC_REACHES, (reach) => (reach.runtime ? reach.values : undefined)),
    {
      [`${CORE}/collection`]: ["isValidCollectionName"],
      [`${CORE}/collection/paths`]: ["isSafeCustomViewPath"],
      [`${CORE}/collection/server`]: ["parseAppManifest"],
    },
  );
});

// A type-only reach costs nothing at runtime, but a type in this package's public signatures is
// emitted into its `.d.ts` and resolved by the consumer's compiler against ITS core — so a type
// from a subpath the declared range lacks is a type that consumer cannot find.
test("src reaches core's types through exactly these names", () => {
  assert.deepEqual(
    namesBySubpath(SRC_REACHES, (reach) => (reach.types.length > 0 ? reach.types : undefined)),
    {
      [`${CORE}/collection`]: ["CollectionFieldSpec", "CollectionSchema"],
      [`${CORE}/collection/server`]: ["AppManifestResult"],
    },
  );
});
