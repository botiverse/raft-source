// Runs the refusal ratchet (scripts/ci/refusal-ratchet.ts) with this
// package's tests, which unit-fast runs on every PR: a new direct
// res.status(4xx) in server code should fail before merge (Tenny, #wg-ax:#13),
// and the any-ratchet job only runs on push and in the merge queue. An agent
// can't add a workflow step (Stamp's workflow-path guard), so it rides here;
// a step in unit-fast would do the same job.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("the server's direct 4xx answers don't grow past scripts/ci/refusal-baseline.json", () => {
  for (const args of [["--self-test"], []]) {
    const run = spawnSync(process.execPath, ["--import", "@oxc-node/core/register", "scripts/ci/refusal-ratchet.ts", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `refusal-ratchet ${args.join(" ")}\n${run.stdout}\n${run.stderr}`);
  }
}, 120_000);
