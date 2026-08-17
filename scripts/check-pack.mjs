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
// Usage: node scripts/check-pack.mjs <tarball>

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tarball = process.argv[2];
if (!tarball) {
  console.error("usage: node scripts/check-pack.mjs <tarball>");
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Every relative path an entry point resolves to. `exports` nests conditions ("types",
 *  "default", "import", ...) to arbitrary depth and a subpath may also be a bare string, so
 *  walk the whole tree and keep the leaves that look like package-relative files.
 *
 *  `exports` leaves are always `./`-prefixed, but `main` and `types` are just as often bare
 *  (`dist/index.js`), so anything that is not absolute counts. Dropping a path we did not
 *  recognise would fail OPEN — an unchecked entry point is exactly what this script exists
 *  to catch — so the rule is deliberately permissive. */
const collect = (node, out) => {
  if (typeof node === "string") {
    const path = node.replace(/^\.\//, "");
    if (path !== "" && !path.startsWith("/") && !path.startsWith("../")) out.add(path);
    return out;
  }
  if (node && typeof node === "object") {
    for (const value of Object.values(node)) collect(value, out);
  }
  return out;
};

const declared = collect(pkg.exports ?? {}, new Set());
for (const field of [pkg.main, pkg.types]) collect(field, declared);

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

const missing = [...declared].sort().filter((path) => !listed.has(path));
for (const path of [...declared].sort()) {
  console.log(`${missing.includes(path) ? "MISSING" : "ok     "} ${path}`);
}

if (missing.length > 0) {
  console.error(`\n${tarball} is missing ${missing.length} declared entry point(s): ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`\nall ${declared.size} declared entry points are in ${tarball}`);
