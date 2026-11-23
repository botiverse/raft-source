import { defineConfig } from "vitest/config";

// Dev trace (scripts/vitest/devTraceReporter.ts): loaded lazily so that a
// problem in it can never stop this config from loading.
const devTrace = await import("../../scripts/vitest/devTraceReporter")
  .then((module) => [module.devTracePlugin("@botiverse/raft-computer")])
  .catch(() => []);

export default defineConfig({
  plugins: devTrace,
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/native/*.test.mjs"],
    // No test sees the launching agent's Raft home or identity.
    setupFiles: ["../../scripts/vitest/clearAgentEnv.ts"],
    pool: "forks",
    // The previous Node runner imposed no per-test or per-hook timeout. Keep
    // that contract and let the existing job watchdogs bound hangs.
    testTimeout: 0,
    hookTimeout: 0,
  },
});
