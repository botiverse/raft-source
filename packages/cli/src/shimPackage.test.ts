import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Red-green pins for the @slock-ai/cli delegation shim (rename migration P1,
// #proj-aiax:4c235f84). The migration invariant under test: the legacy npm
// name must keep producing a runnable `slock` that delegates to
// @botiverse/raft, with the rename notice on stderr only and never able to
// break delegation.

// @ts-expect-error -- plain .mjs build script, no type declarations
const { buildShimPackage } = await import("../scripts/build-shim-package.mjs");

function buildIntoTemp(): { dir: string; pkg: any; indexJs: string } {
  const dir = mkdtempSync(join(tmpdir(), "slock-cli-shim-"));
  buildShimPackage(dir);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const indexJs = readFileSync(join(dir, "index.js"), "utf8");
  return { dir, pkg, indexJs };
}

test("shim package keeps the legacy name, slock bin, and a single raft dependency", () => {
  const { dir, pkg } = buildIntoTemp();
  try {
    assert.equal(pkg.name, "@slock-ai/cli");
    assert.equal(pkg.bin.slock, "index.js");
    assert.equal(pkg.bin.raft, undefined);
    assert.deepEqual(Object.keys(pkg.dependencies), ["@botiverse/raft"]);
    assert.equal(pkg.dependencies["@botiverse/raft"], `^${pkg.version}`);
    assert.equal(pkg.devDependencies, undefined);
    assert.equal(pkg.publishConfig.access, "public");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shim bin delegates to the raft slock entry and survives notice failures", () => {
  const { dir, indexJs } = buildIntoTemp();
  try {
    assert.ok(indexJs.startsWith("#!/usr/bin/env node"));
    const delegation = indexJs.indexOf('await import("@botiverse/raft/dist/slock.js")');
    assert.ok(delegation >= 0, "must delegate to @botiverse/raft/dist/slock.js");
    // The notice block is wrapped in try/catch BEFORE the delegation import,
    // so a broken notice (unwritable state dir, etc.) can never block the CLI.
    const catchPos = indexJs.indexOf("catch");
    assert.ok(catchPos >= 0 && catchPos < delegation, "notice try/catch must precede delegation");
    assert.match(indexJs, /SLOCK_CLI_RENAME_NOTICE/);
    assert.match(indexJs, /renamed to @botiverse\/raft/);
    assert.match(indexJs, /process\.stderr\.write/);
    assert.ok(!indexJs.includes("console.log"), "notice must go to stderr, never stdout");
    const mode = statSync(join(dir, "index.js")).mode & 0o111;
    assert.ok(mode !== 0, "shim bin must be executable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
