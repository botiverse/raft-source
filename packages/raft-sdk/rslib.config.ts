import { defineConfig } from "@rslib/core";

const bundledPackages = ["@botiverse/raft-shared"];

export default defineConfig({
  lib: [
    {
      format: "esm",
      bundle: true,
      autoExternal: false,
      dts: {
        bundle: { bundledPackages },
        distPath: "./dist",
      },
      output: {
        distPath: "./dist/esm",
      },
    },
    {
      format: "cjs",
      bundle: true,
      autoExternal: false,
      output: {
        distPath: "./dist/cjs",
      },
    },
  ],
});
