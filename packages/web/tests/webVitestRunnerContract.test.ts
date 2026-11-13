import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { resolve } from "node:path";
import { defaultTestIncludes } from "../scripts/testLocations";
import { OXC_NODE_ARGS } from "./helpers/oxcNode";

const webRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(webRoot, "../..");
const runner = resolve(webRoot, "scripts/run-vitest-tests.ts");
const target = "tests/richTextChunkKeys.test.ts";

function runRunner(args: string[], cwd = webRoot) {
  return spawnSync(process.execPath, [...OXC_NODE_ARGS, runner, ...args], {
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

test("the Vitest runner applies the same JSX transform from repo root and package cwd", () => {
  // Vitest 5's default reporter no longer lists passing files when not attached to a TTY;
  // ask for the verbose reporter so the probe file is named in the output.
  const rootResult = runRunner(["packages/web/tests/fixtures/jsxTransformProbe.tsx", "--reporter=verbose"], repoRoot);
  const webResult = runRunner(["tests/fixtures/jsxTransformProbe.tsx", "--reporter=verbose"]);

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
  assert.match(rootResult.stdout + rootResult.stderr, /✓ tests\/fixtures\/jsxTransformProbe\.tsx > /);
  assert.match(webResult.stdout + webResult.stderr, /✓ tests\/fixtures\/jsxTransformProbe\.tsx > /);
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

test("the default selection covers tests/ and src/features/<feature>/tests/, unit and DOM apart", () => {
  const selected = (dom: boolean) => new Set(defaultTestIncludes(dom).flatMap((pattern) => globSync(pattern, { cwd: webRoot })));
  const unit = selected(false);
  const dom = selected(true);
  assert.ok(unit.has(target), "tests/ unit test");
  assert.ok(unit.has("src/features/computer/tests/computerBetaCommand.test.ts"), "feature unit test");
  assert.ok(dom.has("src/features/computer/tests/computerSidePanel.behavior.test.tsx"), "feature DOM test");
  assert.ok(![...unit].some((file) => file.endsWith(".tsx")), "no DOM test in the unit selection");
  assert.ok(![...dom].some((file) => file.endsWith(".ts")), "no unit test in the DOM selection");
});
