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
// CI sizing is unchanged (two workers, no heap flag; see below).
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
        runRecordPlugin({ packageName: "@botiverse/raft-daemon", dom: false, worktree }),
        localWorkerCapPlugin({ label: "daemon", cap: localWorkers }),
      ],
  test: {
    globals: true,
    // Local runs regenerate snapshots for review; CI only checks committed output.
    update: !ci,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Unit tests never reach the network; see src/testing/networkGuard.ts.
    // clearAgentEnv: no test sees the launching agent's Raft home or identity.
    setupFiles: ["../../scripts/vitest/clearAgentEnv.ts", "./src/testing/networkGuard.ts"],
    pool: "forks",
    // CI runners (blacksmith-4vcpu, 16 GB) intermittently OOM-kill this suite
    // (exit 137, no test failure — runs 38031513722 / 38023257486): one fork per
    // CPU each carries a Node heap plus spawned CLI children from the APM tests.
    // Cap CI at two workers; peak memory halves and the suite stays well inside
    // the 20-minute step ceiling.
    // vitest 5.x takes the cap as top-level maxWorkers (poolOptions.forks does
    // not exist in this version's config types).
    maxWorkers: ci ? 2 : localWorkers,
    ...(ci ? {} : { execArgv: forkHeapExecArgv() }),
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
