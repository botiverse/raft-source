import { defineConfig } from "vitest/config";

// Dev trace (scripts/vitest/devTraceReporter.ts): loaded lazily so that a
// problem in it can never stop this config from loading.
const devTrace = await import("../../scripts/vitest/devTraceReporter")
  .then((module) => [module.devTracePlugin("@botiverse/raft-server:scripts")])
  .catch(() => []);

export default defineConfig({
  plugins: devTrace,
  test: {
    globals: true,
    environment: "node",
    include: ["scripts/**/*.test.ts"],
    pool: "forks",
    // Script contracts were previously unbounded at the individual-test
    // level; their calling jobs remain responsible for process timeouts.
    testTimeout: 0,
    hookTimeout: 0,
  },
});
