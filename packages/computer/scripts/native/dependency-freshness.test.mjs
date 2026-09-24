import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { assertBuildOutputFresh } from "./dependency-freshness.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "raft-native-deps-"));
  const sourceDir = join(root, "src");
  const source = join(sourceDir, "core.ts");
  const output = join(root, "dist", "core.js");
  await mkdir(sourceDir);
  await mkdir(join(root, "dist"));
  await writeFile(source, "export const value = 1;\n");
  await writeFile(output, "export const value = 1;\n");
  return { root, sourceDir, source, output };
}

const options = (sourceDir, output) => ({
  dependency: "@botiverse/raft-daemon",
  inputs: [sourceDir],
  output,
  recovery: "pnpm --filter @botiverse/raft-computer build:deps",
});

test("native dependency freshness accepts an output newer than its sources", async (t) => {
  const f = await fixture();
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  await utimes(f.source, 10, 10);
  await utimes(f.output, 20, 20);
  await assert.doesNotReject(
    assertBuildOutputFresh(options(f.sourceDir, f.output)),
  );
});

test("native dependency freshness rejects a missing output with recovery guidance", async (t) => {
  const f = await fixture();
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  await rm(f.output);
  await assert.rejects(
    assertBuildOutputFresh(options(f.sourceDir, f.output)),
    /build output is missing.*build:deps/,
  );
});

test("native dependency freshness rejects stale output with the newer input path", async (t) => {
  const f = await fixture();
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  await utimes(f.output, 10, 10);
  await utimes(f.source, 20, 20);
  await assert.rejects(
    assertBuildOutputFresh(options(f.sourceDir, f.output)),
    (error) => {
      assert.match(error.message, /build output is stale/);
      assert.match(error.message, /core\.ts/);
      assert.match(error.message, /build:deps/);
      return true;
    },
  );
});
