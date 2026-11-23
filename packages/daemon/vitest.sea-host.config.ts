import { defineConfig } from "vitest/config";

// Dev trace (scripts/vitest/devTraceReporter.ts): loaded lazily so that a
// problem in it can never stop this config from loading.
const devTrace = await import("../../scripts/vitest/devTraceReporter")
  .then((module) => [module.devTracePlugin("@botiverse/raft-daemon:sea-host")])
  .catch(() => []);

export default defineConfig({
  plugins: devTrace,
  test: {
    globals: true,
    environment: "node",
    include: ["src/testing/seaHostHarness.sea-suite.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
