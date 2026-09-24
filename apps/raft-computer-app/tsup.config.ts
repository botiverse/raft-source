import { defineConfig } from "tsup";
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";

// Main + preload: both run in Electron's Node context (main process / preload
// sandbox bridge). The renderer runs in the Chromium web context — no Node
// APIs, no workspace deps, just DOM + the contextBridge-exposed API.
//
// `noExternal` inlines workspace deps so Electron at runtime sees one self-
// contained `dist/main.js`. `@botiverse/raft-shared` and `@botiverse/raft-trace-client`
// are source-only TS packages (`main: src/index.ts`, no build); the
// `@botiverse/raft-computer/lib` bundle leaves shared/trace-client external,
// so leaving them external here would push the resolution to Electron, which
// tries to load the raw `.ts` source and fails on the bundler-style
// `.js`-extension internal imports. Bundling them in cuts that knot.
export default defineConfig([
  {
    entry: { main: "src/main.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    outDir: "dist",
    external: ["electron"],
    noExternal: ["@botiverse/raft-computer", "@botiverse/raft-shared", "@botiverse/raft-trace-client"],
    shims: true,
    banner: {
      js:
        "import { createRequire as __slockCreateRequire } from \"node:module\";\n" +
        "const require = __slockCreateRequire(import.meta.url);",
    },
    clean: true,
  },
  {
    // Preload must be a single self-contained CJS file — Electron's sandboxed
    // preload loader cannot resolve ESM imports or code-split chunks.
    entry: { preload: "src/preload.ts" },
    format: ["cjs"],
    target: "node20",
    platform: "node",
    outDir: "dist",
    external: ["electron"],
    clean: false,
  },
  {
    entry: { renderer: "src/renderer.tsx" },
    format: ["iife"],
    target: "es2022",
    platform: "browser",
    outDir: "dist",
    clean: false,
    noExternal: ["react", "react-dom"],
    esbuildOptions(options) {
      options.jsx = "automatic";
    },
    onSuccess: async () => {
      copyFileSync(
        resolve("src/onboarding.html"),
        resolve("dist/onboarding.html"),
      );
    },
  },
]);
