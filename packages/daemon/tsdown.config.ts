import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/core.ts", "src/bundledRaftCli.ts", "src/runtimeDetectionChild.ts", "src/agentContextView/contextViewRestoreChild.ts"],
  format: "esm",
  target: "node20",
  platform: "node",
  // platform:node defaults to .mjs fixed extensions; the bin wrappers
  // (scripts/write-dist-bins.mjs) and package.json exports reference
  // dist/index.js / dist/core.js, so keep .js.
  fixedExtension: false,
  clean: true,
  dts: false,
  // #oar-raft:#10: the Cursor SDK is a daemon dependency that OAR's child
  // imports by file URL, never bundled (native binaries; oarLoader.ts).
  deps: { neverBundle: ["@cursor/sdk"] },
});
