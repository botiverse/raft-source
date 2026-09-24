import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Local runs regenerate snapshots for review; CI only checks committed output.
    update: !process.env.CI,
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
