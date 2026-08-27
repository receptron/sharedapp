// The tarball is the whole contract. Consumers never build this package — they get `dist/`
// from what `npm publish` uploaded — so a `files` list or a `prepublishOnly` that stopped
// emitting ships a package that fails at `import`, in MulmoTerminal's `server/` or in
// MulmoServer's front end, rather than here.
//
// This checks every entry point the package DECLARES, derived from `exports` (plus `main`
// and `types`), instead of a hand-written list of paths. The previous check named
// `dist/index.js` and `dist/index.d.ts` literally, so `./view` — which MulmoTerminal's
// headless preview and MulmoServer's `AppViewFrame.vue` both import — could vanish from the
// tarball and still pass. A list that is written out by hand reopens that hole the day a
// third subpath is added; a list that is derived cannot.
//
// Usage: yarn check:pack <tarball>

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { byText } from "../src/byText.js";

/** An object, for walking. Arrays pass too, which is what we want: an `exports` value may be
 *  either, and the walk below treats both the same way. A type guard rather than a cast,
 *  because a cast asserts what the compiler could not prove and this value came from
 *  `JSON.parse` — the one place in this script where nothing is known. */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const tarball = process.argv[2];
if (tarball === undefined || tarball === "") {
  console.error("usage: yarn check:pack <tarball>");
  process.exit(2);
}

const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (!isRecord(manifest)) {
  console.error("package.json did not parse as an object");
  process.exit(1);
}

/** Every relative path an entry point resolves to. `exports` nests conditions ("types",
 *  "default", "import", ...) to arbitrary depth and a subpath may also be a bare string, so
 *  walk the whole tree and keep the leaves that look like package-relative files.
 *
 *  `exports` leaves are always `./`-prefixed, but `main` and `types` are just as often bare
 *  (`dist/index.js`), so anything that is not absolute counts. Dropping a path we did not
 *  recognise would fail OPEN — an unchecked entry point is exactly what this script exists
 *  to catch — so the rule is deliberately permissive. */
const collect = (node: unknown, out: Set<string>): Set<string> => {
  if (typeof node === "string") {
    const path = node.replace(/^\.\//, "");
    if (path !== "" && !path.startsWith("/") && !path.startsWith("../")) out.add(path);
    return out;
  }
  if (isRecord(node)) {
    Object.values(node).forEach((value) => collect(value, out));
  }
  return out;
};

const declared = collect(manifest.exports ?? {}, new Set<string>());
[manifest.main, manifest.types].forEach((field) => collect(field, declared));

if (declared.size === 0) {
  console.error("no entry points found in package.json — exports/main/types are all empty");
  process.exit(1);
}

const listed = new Set(
  execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    // npm/yarn pack prefixes everything with `package/`; directory entries end in `/`.
    .map((line) => (line.startsWith("package/") ? line.slice("package/".length) : line)),
);

const escapeRegExp = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** An export TARGET holding `*` (`"./view/*": "./dist/view/*.js"` — the right-hand side is what
 *  reaches here, because `collect` walks values) names a SET of files, not one file.
 *  Checking it literally would fail a tarball that is perfectly correct, and this script
 *  exists to be added to without being re-read — the day someone declares a pattern, it must
 *  not be CI refusing a good publish. `*` in an exports pattern may span `/`, so it maps to
 *  `.*`; at least one packed FILE (tar lists directories with a trailing slash) has to match. */
const satisfied = (path: string): boolean => {
  if (!path.includes("*")) return listed.has(path);
  const pattern = new RegExp(`^${path.split("*").map(escapeRegExp).join(".*")}$`);
  return [...listed].some((entry) => !entry.endsWith("/") && pattern.test(entry));
};
const missing = [...declared].sort(byText).filter((path) => !satisfied(path));
for (const path of [...declared].sort(byText)) {
  console.log(`${missing.includes(path) ? "MISSING" : "ok     "} ${path}`);
}

if (missing.length > 0) {
  console.error(`\n${tarball} is missing ${missing.length} declared entry point(s): ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`\nall ${declared.size} declared entry points are in ${tarball}`);
