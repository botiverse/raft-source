import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node20",
  platform: "node",
  splitting: false,
  clean: true,
  shims: true,
  // The Computer app copies this single file into
  // `<app>/Contents/Resources/cli/index.js` and executes it with Electron's
  // Node runtime. That sidecar has no package root, so runtime deps must be
  // inlined rather than resolved from ambient node_modules. `commander` is CJS
  // and still requires Node built-ins, so the ESM bundle also needs a
  // createRequire shim.
  noExternal: ["commander", "undici"],
  banner: {
    js:
      "#!/usr/bin/env node\n" +
      "import { createRequire as __raftCreateRequire } from \"node:module\";\n" +
      "const require = __raftCreateRequire(import.meta.url);",
  },
});
