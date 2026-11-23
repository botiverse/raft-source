import { defineConfig } from "vitest/config";

// Dev trace (scripts/vitest/devTraceReporter.ts): loaded lazily so that a
// problem in it can never stop this config from loading.
const devTrace = await import("../../scripts/vitest/devTraceReporter")
  .then((module) => [module.devTracePlugin("@botiverse/raft-perf")])
  .catch(() => []);

export default defineConfig({
  plugins: devTrace,
  test: {
    globals: true,
    environment: "node",
    // The pure parts only; src/measure.ts drives a browser against a deployed web and has no unit test.
    include: ["src/**/*.test.ts"],
  },
});
