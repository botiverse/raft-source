import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = fileURLToPath(new URL("../../..", import.meta.url));
const probeFile = fileURLToPath(new URL("./lifecycle.probe.ts", import.meta.url));
// The nested Vitest gets the same PGlite template as the outer run (CI refuses
// the per-file migrate fallback, src/test/setup/pgliteTemplate.ts).
const templateGlobalSetup = fileURLToPath(new URL("../setup/pgliteTemplate.global.ts", import.meta.url));
// The probe boots a full integration fixture in a fresh Vitest. On a loaded
// machine that alone has taken over 30s, so the limits only bound a hang; the
// contract asserts outcomes, never timing.
const PROBE_CASE_TIMEOUT_MS = 120_000;
const PROBE_RUN_TIMEOUT_MS = 4 * PROBE_CASE_TIMEOUT_MS;

// Batch intentional failures to pay for one Vitest/app startup. Keep the
// green background probe separate: expected exit 1 must not hide its errors.
const groups = [
  { name: "failures", modes: ["assertion", "setup", "afterEach", "skip", "cleanup"], exitCode: 1 },
  { name: "background", modes: ["background"], exitCode: 0 },
] as const;

for (const group of groups) {
  test(`integration lifecycle contains ${group.name} work in its owning case`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "raft-fixture-contract-"));
    try {
      const config = path.join(dir, "config.mjs");
      const report = path.join(dir, "report.json");
      const witness = path.join(dir, "closed.txt");
      await writeFile(config, `export default ${JSON.stringify({
        test: { include: [probeFile], globalSetup: [templateGlobalSetup], globals: true, pool: "forks", maxWorkers: 1, testTimeout: PROBE_CASE_TIMEOUT_MS, hookTimeout: PROBE_CASE_TIMEOUT_MS },
      })}`);
      const outcome = await new Promise<{ code: number; output: string }>(resolve => {
        execFile(process.execPath, [path.join(serverDir, "node_modules/vitest/vitest.mjs"), "run", "--config", config, "--reporter=json", `--outputFile=${report}`], {
          cwd: serverDir, env: { ...process.env, INTEGRATION_PROBE: group.name, INTEGRATION_WITNESS: witness }, timeout: PROBE_RUN_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024,
        }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, output: stdout + stderr }));
      });
      const result: { testResults: Array<{ assertionResults: Array<{ ancestorTitles: string[]; title: string; status: string; failureMessages: string[] }> }> } = JSON.parse(await readFile(report, "utf8").catch(() => { throw new Error(outcome.output); }));
      const cases = result.testResults.flatMap(file => file.assertionResults);
      const details = JSON.stringify(cases);
      assert.deepEqual((await readFile(witness, "utf8")).trim().split("\n"), [...group.modes], details);
      assert.equal(cases.length, 2 * group.modes.length, outcome.output);
      for (const mode of group.modes) {
        const pair = cases.filter(result => result.ancestorTitles.at(-1) === mode);
        assert.deepEqual(pair.map(result => [result.title, result.status]), [
          ["predecessor", mode === "background" ? "passed" : "failed"],
          ["successor", mode === "cleanup" ? "failed" : "passed"],
        ], details);
        if (mode === "cleanup") assert.match(pair[1].failureMessages.join("\n"), /refusing to reuse/);
        if (mode === "skip") assert.match(pair[0].failureMessages.join("\n"), /Use test.skipIf/);
      }
      assert.equal(outcome.code, group.exitCode, outcome.output);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, PROBE_RUN_TIMEOUT_MS + 30_000);
}
