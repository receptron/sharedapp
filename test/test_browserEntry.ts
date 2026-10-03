// `@receptron/sharedapp/browser` must load in a browser: its runtime import graph may reach `zod`
// and core's browser-safe subpaths, and nothing else — above all not `collection/server`, which
// drags Node built-ins and native bindings into a page bundle and fails its build (#332).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { reachesIn } from "./importScan.js";

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const ALLOWED = new Set(["zod", "@mulmoclaude/core/collection", "@mulmoclaude/core/collection/paths"]);

/** Every bare specifier the module graph from `entry` loads at runtime. */
const bareReaches = (entry: string): string[] => {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const reach of reachesIn(file, readFileSync(file, "utf8")).filter((each) => each.runtime)) {
      if (reach.specifier.startsWith(".")) visit(path.join(path.dirname(file), reach.specifier.replace(/\.js$/u, ".ts")));
      else bare.add(reach.specifier);
    }
  };
  visit(path.join(srcDir, entry));
  return [...bare].sort();
};

test("the browser entry loads nothing but zod and core's browser-safe subpaths", () => {
  assert.deepEqual(
    bareReaches("browser.ts").filter((specifier) => !ALLOWED.has(specifier)),
    [],
  );
});

test("the scan sees the server half where it is — the main entry reaches it", () => {
  assert.equal(bareReaches("index.ts").includes("@mulmoclaude/core/collection/server"), true);
});
