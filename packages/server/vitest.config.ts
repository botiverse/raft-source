import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    // The previous Node runner imposed no per-test or per-hook timeout. Keep
    // that contract and let the existing shard/job watchdogs bound hangs.
    testTimeout: 0,
    hookTimeout: 0,
  },
});
