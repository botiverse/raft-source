import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { forkHeapExecArgv, isCi, localMaxWorkers, runRecordPlugin } from "../../scripts/vitest/localRunLimits";
import { holdTestSlotForThisRun } from "../../scripts/vitest/testSlot";
import { useDevRunEnv } from "../../scripts/dev/raftdev-cache";
import { defaultTestIncludes } from "./scripts/testLocations";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const dom = process.env.RAFT_WEB_TEST_DOM === "1";

function testIncludes(): string[] {
  const raw = process.env.RAFT_WEB_TEST_INCLUDE;
  // tests/ and src/features/<feature>/tests/ (scripts/testLocations.ts).
  if (!raw) return defaultTestIncludes(dom);

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("RAFT_WEB_TEST_INCLUDE must be a JSON string array");
  }
  return parsed;
}

// Local runs: 2 workers, 4096 MiB fork heap, run record (scripts/vitest).
// CI keeps its CPU-derived worker sizing; the heap cap applies there too.
const ci = isCi();

// A Vitest started directly (`pnpm exec vitest related ... --run`) waits for
// one of the host's test slots and holds it until it exits; the `test` runner
// already holds one (scripts/vitest/testSlot.ts). Nothing in CI or in watch mode.
await holdTestSlotForThisRun();
// TMPDIR and NODE_COMPILE_CACHE on disk for this run and its workers, not on a
// tmpfs /tmp; reuses the runner's when under one. Nothing in CI.
useDevRunEnv();

function maxWorkers(): number | string | undefined {
  if (ci) return dom ? "50%" : undefined;
  return localMaxWorkers();
}

const resolvedMaxWorkers = maxWorkers();

const runRecord = runRecordPlugin({ packageName: "@botiverse/raft-web", dom, worktree: resolve(webRoot, "../..") });

const domSetup = resolve(webRoot, "tests/helpers/domSetup.ts");
const timersReset = resolve(webRoot, "tests/helpers/realTimersAfterEach.ts");
const localeCatalogs = resolve(webRoot, "tests/helpers/registerLocaleCatalogs.ts");
const privacyModeOff = resolve(webRoot, "tests/helpers/privacyModeOff.ts");
// The Artifacts fake data source answers in tests: artifactSource.ts imports
// a slot that is null in every build, and only the tests point it at the fake.
// It loads with artifactSource.ts (after each test file's DOM, stubs and mocks),
// never from a global setup file; the production build has no reference to it.
// (artifactSource.ts is the slot's one importer: src/apps/artifacts/fakeArtifactSourceSlot.ts.)
const testFakeArtifactSourceSlot = resolve(webRoot, "tests/helpers/fakeArtifactSourceSlot.ts");

// Every node:assert import form in test code resolves to a guard that keeps
// the real comparison but fails with bounded output: a failing node:assert
// otherwise inspects its operands at depth 1000 (a jsdom node with its React
// fiber tree grew one worker past 10 GiB). tests/helpers/assertGuard.ts;
// guard tests/assertGuard.test.ts. Packages outside web are not affected.
const assertAliases = [
  { find: /^(?:node:)?assert$/, replacement: resolve(webRoot, "tests/helpers/assertGuardLegacy.ts") },
  { find: /^(?:node:)?assert\/strict$/, replacement: resolve(webRoot, "tests/helpers/assertGuardStrict.ts") },
];

export default defineConfig({
  root: webRoot,
  plugins: ci ? [] : [runRecord],
  resolve: {
    alias: [{ find: /^\.\/fakeArtifactSourceSlot$/, replacement: testFakeArtifactSourceSlot }, ...assertAliases],
  },
  test: {
    globals: true,
    environment: "node",
    include: testIncludes(),
    setupFiles: dom
      ? [resolve(webRoot, "tests/helpers/compileCacheSetup.ts"), timersReset, localeCatalogs, privacyModeOff, domSetup]
      : [timersReset, localeCatalogs, privacyModeOff],
    // node:test restored per-test mocks automatically; keep that contract for vi.spyOn.
    restoreMocks: true,
    pool: "forks",
    isolate: true,
    execArgv: forkHeapExecArgv(),
    // DOM teardown can log while Vitest 5 closes its console RPC (#11153).
    // Keep stdout/stderr visible through the fork's native streams instead;
    // assertions and unhandled errors retain their normal failure behavior.
    disableConsoleIntercept: dom,
    // DOM collection is memory-heavy. At the default worker count, the
    // heaviest files can starve their one-second RTL waits under host load.
    // (Vitest 4 removed `minWorkers`; it is derived automatically outside watch mode.)
    // CI keeps that 50% DOM cap (CPU default otherwise); local runs use maxWorkers().
    ...(resolvedMaxWorkers === undefined ? {} : { maxWorkers: resolvedMaxWorkers }),
    resolveSnapshotPath: (testPath) => `${testPath}.snapshot`,
    // The previous Node runner imposed no per-test or per-hook timeout. Keep
    // that contract and let the existing CI job watchdog bound hangs.
    testTimeout: 0,
    hookTimeout: 0,
    // expect() failure output only (the values are still formatted in full):
    // pin chai's 40-character value previews (its default, restated so a chai
    // upgrade or a local override cannot silently raise it), and cut the reporter's
    // diff of err.actual / err.expected at 200 lines (unbounded by default).
    chaiConfig: { truncateThreshold: 40 },
    diff: { truncateThreshold: 200 },
  },
});
