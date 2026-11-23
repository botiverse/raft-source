import { defineConfig } from "vitest/config";

// Dev trace (scripts/vitest/devTraceReporter.ts): loaded lazily so that a
// problem in it can never stop this config from loading.
const devTrace = await import("../../scripts/vitest/devTraceReporter")
  .then((module) => [module.devTracePlugin("@botiverse/raft-trace-upload-worker")])
  .catch(() => []);

export default defineConfig({
  plugins: devTrace,
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    // These suites ran on node:test, which imposes no per-test or per-hook timeout.
    testTimeout: 0,
    hookTimeout: 0,
  },
});
