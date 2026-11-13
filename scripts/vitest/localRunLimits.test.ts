// Local worker sizing (localRunLimits.ts): server and daemon default to one
// worker outside CI and hold a run to it whatever the CLI asks; web keeps 2.
// Run by hand: pnpm exec vitest run scripts/vitest/localRunLimits.test.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

import {
  LOCAL_DEFAULT_MAX_WORKERS,
  SHARED_HOST_MAX_WORKERS,
  clampWorkers,
  localMaxWorkers,
  localWorkerCapPlugin,
} from "./localRunLimits";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const moduleUrl = new URL("./localRunLimits.ts", import.meta.url).href;

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

test("web keeps 2 local workers; server and daemon default to 1; RAFT_TEST_MAX_WORKERS raises either", () => {
  expect(LOCAL_DEFAULT_MAX_WORKERS).toBe(2);
  expect(localMaxWorkers({})).toBe(2);
  expect(SHARED_HOST_MAX_WORKERS).toBe(1);
  expect(localMaxWorkers({}, SHARED_HOST_MAX_WORKERS)).toBe(1);
  expect(localMaxWorkers({ RAFT_TEST_MAX_WORKERS: "4" }, SHARED_HOST_MAX_WORKERS)).toBe(4);
  expect(() => localMaxWorkers({ RAFT_TEST_MAX_WORKERS: "0" }, SHARED_HOST_MAX_WORKERS)).toThrow(/positive integer/);
});

test("a request above the cap is clamped with one line naming the override; at or below it is kept", () => {
  expect(clampWorkers("server", 4, 1)).toEqual({
    maxWorkers: 1,
    message:
      "[raft] server tests: maxWorkers clamped 4 → 1 on a shared host; set RAFT_TEST_MAX_WORKERS=4 to allow",
  });
  expect(clampWorkers("server", 1, 1)).toEqual({ maxWorkers: 1 });
  expect(clampWorkers("daemon", 2, 4)).toEqual({ maxWorkers: 2 });
  expect(clampWorkers("daemon", undefined, 1)).toEqual({ maxWorkers: 1 });
});

test("the plugin lowers the resolved maxWorkers of Vitest and the project, and logs once", () => {
  const lines: string[] = [];
  const plugin = localWorkerCapPlugin({ label: "server", cap: 1, log: (line) => lines.push(line) });
  const vitest = { config: { maxWorkers: 4 } };
  const project = { config: { maxWorkers: 4 } };
  plugin.configureVitest({ vitest, project });
  expect(vitest.config.maxWorkers).toBe(1);
  expect(project.config.maxWorkers).toBe(1);
  expect(lines).toEqual([
    "[raft] server tests: maxWorkers clamped 4 → 1 on a shared host; set RAFT_TEST_MAX_WORKERS=4 to allow",
  ]);

  const quiet = localWorkerCapPlugin({ label: "server", cap: 4, log: (line) => lines.push(line) });
  const within = { config: { maxWorkers: 3 } };
  quiet.configureVitest({ vitest: within, project: { config: {} } });
  expect(within.config.maxWorkers).toBe(3);
  expect(lines).toHaveLength(1);
});

/** The server or daemon config as loaded outside a Vitest run (no slot taken). */
function loadConfig(pkg: string, env: NodeJS.ProcessEnv) {
  const configUrl = new URL(`../../packages/${pkg}/vitest.config.ts`, import.meta.url).href;
  const script = `const c = (await import(${JSON.stringify(configUrl)})).default;
console.log(JSON.stringify({ maxWorkers: c.test.maxWorkers ?? null, plugins: c.plugins.map((p) => p.name) }));`;
  const result = spawnSync(
    process.execPath,
    ["--import", "@oxc-node/core/register", "--input-type=module", "-e", script],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, CI: "", GITHUB_ACTIONS: "", RAFT_TEST_MAX_WORKERS: "", RAFT_TEST_SLOT_HELD: "1", ...env },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "null");
}

test.each([
  ["server", null],
  ["daemon", 2],
])("%s: one worker and the cap locally, RAFT_TEST_MAX_WORKERS raises it, CI sizing untouched", (pkg, ciWorkers) => {
  expect(loadConfig(pkg, {})).toEqual({ maxWorkers: 1, plugins: ["raft-test-run-record", "raft-test-worker-cap"] });
  expect(loadConfig(pkg, { RAFT_TEST_MAX_WORKERS: "3" }).maxWorkers).toBe(3);
  expect(loadConfig(pkg, { CI: "true" })).toEqual({ maxWorkers: ciWorkers, plugins: [] });
}, 60_000);

test("a real `vitest run --maxWorkers 4` under the plugin runs its files one at a time", () => {
  dir = mkdtempSync(join(tmpdir(), "raft-worker-cap-"));
  writeFileSync(
    join(dir, "vitest.config.mjs"),
    `import { localWorkerCapPlugin } from ${JSON.stringify(moduleUrl)};
export default { plugins: [localWorkerCapPlugin({ label: "fixture", cap: 1 })], test: { globals: true, pool: "forks", include: ["*.test.mjs"] } };`,
  );
  for (const name of ["a", "b", "c"]) {
    writeFileSync(
      join(dir, `${name}.test.mjs`),
      // Globals: a file outside the repo cannot resolve "vitest".
      `import { writeFileSync } from "node:fs";
test("${name}", async () => {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 400));
  writeFileSync(${JSON.stringify(join(dir, `${name}.json`))}, JSON.stringify([start, Date.now()]));
});`,
    );
  }
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, "node_modules/vitest/vitest.mjs"), "run", "--maxWorkers", "4"],
    { cwd: dir, encoding: "utf8", env: { ...process.env, CI: "", GITHUB_ACTIONS: "", VITEST_MAX_WORKERS: "" } },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout + result.stderr).toContain("[raft] fixture tests: maxWorkers clamped 4 → 1");
  const spans = ["a", "b", "c"]
    .map((name) => JSON.parse(readFileSync(join(dir!, `${name}.json`), "utf8")) as [number, number])
    .sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1]);
}, 60_000);
