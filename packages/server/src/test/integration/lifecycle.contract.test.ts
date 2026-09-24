import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const serverDir = fileURLToPath(new URL("../../..", import.meta.url));
const probeFile = fileURLToPath(new URL("./lifecycle.probe.ts", import.meta.url));

for (const mode of ["assertion", "setup", "afterEach", "cleanup", "skip", "background"]) {
  test(`integration lifecycle contains ${mode} work/failure in its owning case`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "raft-fixture-contract-"));
    try {
      const config = path.join(dir, "config.mjs");
      const report = path.join(dir, "report.json");
      const witness = path.join(dir, "closed.txt");
      await writeFile(config, `export default ${JSON.stringify({
        test: { include: [probeFile], pool: "forks", maxWorkers: 1, minWorkers: 1, testTimeout: 30000, hookTimeout: 30000 },
      })}`);
      const outcome = await new Promise<{ code: number; output: string }>(resolve => {
        execFile(process.execPath, [path.join(serverDir, "node_modules/vitest/vitest.mjs"), "run", "--config", config, "--reporter=json", `--outputFile=${report}`], {
          cwd: serverDir, env: { ...process.env, INTEGRATION_PROBE: mode, INTEGRATION_WITNESS: witness }, timeout: 75000, maxBuffer: 2 * 1024 * 1024,
        }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, output: stdout + stderr }));
      });
      const result: { testResults: Array<{ assertionResults: Array<{ title: string; status: string; failureMessages: string[] }> }> } = JSON.parse(await readFile(report, "utf8").catch(() => { throw new Error(outcome.output); }));
      const cases = result.testResults.flatMap(file => file.assertionResults);
      const details = JSON.stringify(cases);
      assert.equal(await readFile(witness, "utf8").catch(() => "missing cleanup witness"), "closed", JSON.stringify(result));
      assert.equal(cases.length, 2, outcome.output);
      assert.equal(cases[0].status, mode === "background" ? "passed" : "failed", details);
      assert.equal(cases[1].status, mode === "cleanup" ? "failed" : "passed", details);
      if (mode === "cleanup") assert.match(cases[1].failureMessages.join("\n"), /refusing to reuse/);
      if (mode === "skip") assert.match(cases[0].failureMessages.join("\n"), /Use test.skipIf/);
      assert.equal(outcome.code, mode === "background" ? 0 : 1, outcome.output);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90000);
}
