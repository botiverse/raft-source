/**
 * The server, daemon and trace-upload-worker `dev` scripts (run by raftdev)
 * restart on source changes with `node --watch-path=...` instead of plain
 * `--watch`. Plain `--watch` follows every imported file, node_modules
 * included; those files are hard links into the shared pnpm store, so any
 * other worktree's `pnpm install` on the host restarted every dev server.
 * `--watch-path` turns import tracking off, so these lists must cover the
 * package's own src and the source of each workspace package it imports.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packagesDir = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "packages");
const DEV_PACKAGES = ["server", "daemon", "trace-upload-worker"];

type PackageJson = {
  name: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readPackage(dir: string): PackageJson {
  return JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8")) as PackageJson;
}

function packageDirsByName(): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const dir of ["cli", "shared", "sync-core", "runtime-form", "trace-client", ...DEV_PACKAGES]) {
    dirs.set(readPackage(dir).name, dir);
  }
  return dirs;
}

/** Workspace packages consumed as TypeScript source (`main`/exports in src), transitively. */
function sourceWorkspaceDeps(dir: string, byName: Map<string, string>, seen = new Set<string>()): Set<string> {
  const pkg = readPackage(dir);
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (!version.startsWith("workspace:")) continue;
    const depDir = byName.get(name);
    // @botiverse/raft (the CLI) is consumed as a built dist, not as source.
    if (!depDir || depDir === "cli" || seen.has(depDir)) continue;
    seen.add(depDir);
    sourceWorkspaceDeps(depDir, byName, seen);
  }
  return seen;
}

function watchPaths(script: string): string[] {
  return [...script.matchAll(/--watch-path=(\S+)/g)].map((match) => match[1]);
}

for (const dir of DEV_PACKAGES) {
  test(`${dir} dev script watches its own and its workspace dependencies' source, not node_modules`, () => {
    const script = readPackage(dir).scripts?.dev ?? "";
    assert.doesNotMatch(script, /--watch(?=\s)/, "plain --watch follows node_modules imports");
    const paths = watchPaths(script);
    assert.ok(paths.includes("src"), script);
    for (const path of paths) {
      assert.ok(existsSync(join(packagesDir, dir, path)), `${dir}: --watch-path=${path} does not exist`);
      assert.doesNotMatch(path, /node_modules|^\.\.?$|^\.\.\/[\w-]+$/, `${dir}: ${path} would watch node_modules`);
    }
    for (const dep of sourceWorkspaceDeps(dir, packageDirsByName())) {
      assert.ok(paths.includes(`../${dep}/src`), `${dir}: missing --watch-path=../${dep}/src`);
    }
  });
}
