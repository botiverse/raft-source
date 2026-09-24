import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const webRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(webRoot, "../..");
const runner = resolve(webRoot, "scripts/run-vitest-tests.mjs");
const target = "tests/richTextChunkKeys.test.ts";

function runRunner(args: string[], cwd = webRoot) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    // The assertions below regex-match the child's summary lines. Force
    // colorless output so ANSI style codes between tokens (e.g. dimmed
    // parentheses around "(1 test)") cannot break the match depending on
    // the environment's color support.
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
}

test("web test scripts use the cwd-independent Vitest runner", () => {
  const rootPackageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
  const webPackageJson = JSON.parse(readFileSync(resolve(webRoot, "package.json"), "utf8"));

  assert.equal(rootPackageJson.scripts["test:web"], "node packages/web/scripts/run-vitest-tests.mjs");
  assert.equal(
    rootPackageJson.scripts["test:web:dom"],
    "node packages/web/scripts/run-vitest-tests.mjs --dom",
  );
  assert.equal(webPackageJson.scripts.test, "node scripts/run-vitest-tests.mjs");
  assert.equal(webPackageJson.scripts["test:dom"], "node scripts/run-vitest-tests.mjs --dom");
});

test("Vitest keeps file isolation and the node:test compatibility boundary explicit", () => {
  const source = readFileSync(resolve(webRoot, "vitest.config.ts"), "utf8");

  assert.match(source, /find: \/\^node:test\$\//);
  assert.match(source, /vitestNodeTestCompat\.ts/);
  assert.match(source, /pool: "forks"/);
  assert.match(source, /isolate: true/);
  assert.match(source, /dom \? \{ minWorkers: 1, maxWorkers: "50%" \}/);
});

test("the Vitest runner applies the same JSX transform from repo root and package cwd", () => {
  const rootResult = runRunner(["packages/web/tests/fixtures/jsxTransformProbe.tsx"], repoRoot);
  const webResult = runRunner(["tests/fixtures/jsxTransformProbe.tsx"]);

  assert.equal(
    rootResult.status,
    0,
    `repo-root JSX probe should pass\nstdout:\n${rootResult.stdout}\nstderr:\n${rootResult.stderr}`,
  );
  assert.equal(
    webResult.status,
    0,
    `packages/web JSX probe should pass\nstdout:\n${webResult.stdout}\nstderr:\n${webResult.stderr}`,
  );
  assert.match(rootResult.stdout + rootResult.stderr, /jsxTransformProbe\.tsx \(1 test\)/);
  assert.match(webResult.stdout + webResult.stderr, /jsxTransformProbe\.tsx \(1 test\)/);
});

test("a missing path alongside a real one fails instead of producing a partial green", () => {
  const result = runRunner([target, "tests/__does_not_exist__.test.ts"]);
  assert.notEqual(result.status, 0, "a missing path must not exit 0");
  assert.match(`${result.stderr}${result.stdout}`, /__does_not_exist__\.test\.ts/);
});

test("a real path alone still runs", () => {
  const result = runRunner([target]);
  assert.equal(result.status, 0, `expected success, got:\n${result.stderr}`);
});

test("a Vitest flag value is not mistaken for a path", () => {
  const result = runRunner([target, "--testNamePattern", "keyed element"]);
  assert.equal(result.status, 0, `--flag <value> must keep working, got:\n${result.stderr}`);
  assert.doesNotMatch(`${result.stderr}${result.stdout}`, /do not exist/);
});

test("a glob is never path-checked", () => {
  const result = runRunner(["tests/richTextChunk*.test.ts"]);
  assert.equal(result.status, 0, `globs must pass through, got:\n${result.stderr}`);
});
