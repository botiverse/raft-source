import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import {
  SHARED_HOST_MAX_WORKERS,
  forkHeapExecArgv,
  isCi,
  localMaxWorkers,
  localWorkerCapPlugin,
  runRecordPlugin,
} from "../../scripts/vitest/localRunLimits";
import { holdTestSlotForThisRun } from "../../scripts/vitest/testSlot";
import { useDevRunEnv } from "../../scripts/dev/raftdev-cache";

// Local runs: 1 worker (RAFT_TEST_MAX_WORKERS raises it; a CLI --maxWorkers
// above it is clamped), 4096 MiB fork heap, run record (scripts/vitest).
// CI sizing is unchanged (CPU-derived workers, no heap flag).
const ci = isCi();

// A Vitest started directly (`pnpm exec vitest run <files>`) waits for one of
// the host's test slots and holds it until it exits; `pnpm test` already runs
// in one (scripts/vitest/testSlot.ts). Nothing in CI or in watch mode.
await holdTestSlotForThisRun();
// TMPDIR and NODE_COMPILE_CACHE on disk for this run and its workers, not on a
// tmpfs /tmp; reuses the runner's when under one. Nothing in CI.
useDevRunEnv();
const worktree = fileURLToPath(new URL("../..", import.meta.url));
const localWorkers = localMaxWorkers(process.env, SHARED_HOST_MAX_WORKERS);

export default defineConfig({
  plugins: ci
    ? []
    : [
        runRecordPlugin({ packageName: "@botiverse/raft-server", dom: false, worktree }),
        localWorkerCapPlugin({ label: "server", cap: localWorkers }),
      ],
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // One migrated PGlite template file per run, restored by every in-memory
    // test database (src/test/setup/pgliteTemplate.ts).
    globalSetup: ["src/test/setup/pgliteTemplate.global.ts"],
    // CI has no RisingWave (a hard dependency of the server): install the
    // test-only Postgres references of the RisingWave-served reads.
    setupFiles: ["src/test/setup/risingWaveReadReference.ts", "src/test/setup/readPositionSettle.ts", "src/test/setup/artifactsDeployment.ts"],
    pool: "forks",
    ...(ci ? {} : { maxWorkers: localWorkers, execArgv: forkHeapExecArgv() }),
    // The previous Node runner imposed no per-test or per-hook timeout. Keep
    // that contract and let the existing shard/job watchdogs bound hangs.
    testTimeout: 0,
    hookTimeout: 0,
  },
});
