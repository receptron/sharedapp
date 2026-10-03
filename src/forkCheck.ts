// `forkable` beside `agents[]` — refused at publish. A standing job is somebody's agent doing paid
// work, and a copy would run it at an app nobody priced (see `forkSource.ts`).
import type { AuthoredApp } from "./publishManifest.js";

export function forkProblems(app: AuthoredApp): string[] {
  if (app.forkable !== true || (app.agents ?? []).length === 0) return [];
  return [
    "`forkable` cannot be declared beside `agents[]`: a copy would run another person's agent at the forker's app, at a cost nobody priced. Remove one of them.",
  ];
}
