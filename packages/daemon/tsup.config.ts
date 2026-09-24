import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/core.ts"],
  format: "esm",
  target: "node20",
  platform: "node",
  splitting: true,
  clean: true,
});
