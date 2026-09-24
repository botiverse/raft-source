import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.ts"],
    pool: "forks",
    // Script contracts were previously unbounded at the individual-test
    // level; their calling jobs remain responsible for process timeouts.
    testTimeout: 0,
    hookTimeout: 0,
  },
});
