import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/native/*.test.mjs"],
    pool: "forks",
    // The previous Node runner imposed no per-test or per-hook timeout. Keep
    // that contract and let the existing job watchdogs bound hangs.
    testTimeout: 0,
    hookTimeout: 0,
  },
});
