import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The oldest Vite the web dev server may run on. `./raftdev start` puts that dev
 * server on a public quick tunnel by default, and Vite before 8.3.7 lets one HTTP
 * request to it inject code through its `__vite-browser-external:` virtual module
 * ids (GHSA-p4f5-76q4-ffq7, critical). Pulling a newer commit does not replace the
 * Vite in a worktree's node_modules; only `pnpm install` does, so start checks the
 * installed one (#proj-frontend:#75).
 */
export const WEB_VITE_FLOOR = "8.3.7";

/** Whether `version` (x.y.z, any pre-release tag counts as before its release) is older than `floor`. */
export function versionBelow(version: string, floor: string): boolean {
  const parse = (v: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(v.trim());
    if (!match) return null;
    return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] !== undefined };
  };
  const a = parse(version);
  const b = parse(floor);
  // An unreadable version is never trusted as new enough.
  if (!a || !b) return true;
  for (let i = 0; i < 3; i += 1) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] < b.parts[i];
  }
  return a.pre && !b.pre;
}

/**
 * The installed web Vite's version when it is older than WEB_VITE_FLOOR (or can't
 * be read), with what to do; null when it may run.
 */
export function webViteFloorProblem(projectDir: string, floor = WEB_VITE_FLOOR): string | null {
  const manifest = join(projectDir, "packages", "web", "node_modules", "vite", "package.json");
  let version: string;
  try {
    version = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown }).version as string;
    if (typeof version !== "string") throw new Error("no version field");
  } catch {
    return `packages/web has no readable installed Vite (${manifest}). Run \`pnpm install\` in this worktree, then start again.`;
  }
  if (!versionBelow(version, floor)) return null;
  return `packages/web has Vite ${version} installed, older than ${floor} (GHSA-p4f5-76q4-ffq7: its dev server can be made to run code by one request, and start puts it on a public tunnel). Run \`pnpm install\` in this worktree, then start again.`;
}
