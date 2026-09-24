import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { main: "src/app/index.ts" },
    format: "esm",
    platform: "node",
    target: "node20",
    outDir: "dist",
    clean: false,
    external: ["electron", "electron-updater"],
    // The raft-computer host code (and the source-only shared/trace packages it
    // pulls in) must be INLINED — they ship as TypeScript, and raft-computer's
    // own bundle leaves shared/trace external, so Electron would otherwise try to
    // load raw .ts. Same requirement as apps/raft-computer-app.
    noExternal: ["@botiverse/raft-computer", "@botiverse/raft-shared", "@botiverse/raft-trace-client"],
    // raft-computer's service.ts uses createRequire(import.meta.url); provide it
    // in the ESM bundle banner.
    banner: {
      js: 'import { createRequire as __raftCreateRequire } from "node:module";\nconst require = __raftCreateRequire(import.meta.url);',
    },
  },
  {
    // Sandboxed preloads must be single-file CJS: they cannot resolve ESM or chunks.
    entry: { "app-preload": "src/app/preload.ts" },
    format: "cjs",
    platform: "node",
    target: "node20",
    outDir: "dist",
    external: ["electron"],
  },
]);
