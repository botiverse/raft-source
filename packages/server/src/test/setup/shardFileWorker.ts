/**
 * Global server test setup (vitest setupFiles): under the shard runner, record which worker process
 * runs this test file, so the per-file time limit (scripts/runServerShardWithWatchdog.ts) can stop
 * that worker alone. A file stuck in synchronous code can't time itself out (a PGlite closed under a
 * running statement spins: no timer in its process fires again). Does nothing outside the runner.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { recordFileTiming, SERVER_SHARD_TIMINGS_ENV } from "../../../scripts/serverShardTimings";

const journal = process.env[SERVER_SHARD_TIMINGS_ENV];
const testPath = expect.getState().testPath;
if (journal && testPath) {
  // As Vitest names the file in the journal (relativeModuleId): its path from the config's root, packages/server.
  const file = path.relative(fileURLToPath(new URL("../../..", import.meta.url)), testPath).split(path.sep).join("/");
  try {
    recordFileTiming(journal, { event: "worker", file, pid: process.pid });
  } catch {
    // Without the record a stuck file stops the whole shard at the limit instead; never fail the file for it.
  }
}
