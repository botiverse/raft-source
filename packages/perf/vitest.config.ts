import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // The pure parts only; src/measure.ts drives a browser against a deployed web and has no unit test.
    include: ["src/**/*.test.ts"],
  },
});
