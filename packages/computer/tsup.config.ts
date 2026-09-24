import { defineConfig } from "tsup";

// Two build configs share one tsup invocation:
//   1. CLI bin (`src/index.ts` → `dist/index.js`) — keeps the shebang +
//      createRequire shim banner so the `raft-computer` bin is directly
//      executable.
//   2. Library subpath (`src/lib/index.ts` → `dist/lib/index.{js,d.ts}`)
//      — NO banner: this entry is `import`-only via the §3 sub-path
//      export `@botiverse/raft-computer/lib`. A shebang on a library entry is
//      a smell (Node tolerates it but consumers shouldn't see it), and
//      the lib surface (re-exports of type-pin v2 + closed-set tuples)
//      has no runtime use for the bundled-dep createRequire shim.
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: "esm",
    target: "node20",
    platform: "node",
    splitting: false,
    clean: true,
    shims: true,
    // Inline CLI/runtime helper deps so basic surfaces keep working even
    // when the install root is moved by the upgrade swap before npm has
    // populated ambient node_modules. The daemon package stays external:
    // it ships the bundled slock CLI runtime asset that must remain in a real
    // package root, so the upgrade flow hydrates it into the staged install
    // before swap.
    //
    // `@botiverse/raft-shared` + `@botiverse/raft-trace-client` MUST be inlined: they are
    // `private: true` source-only TS workspace packages (`main: src/index.ts`,
    // no build, bundler-style `.js` ESM specifiers). Left external, the bundled
    // CLI / SEA / npm-published artifact resolves `import "@botiverse/raft-shared"` to
    // a non-existent compiled file at runtime (ERR_MODULE_NOT_FOUND). tsx-based
    // typecheck/test hide it via TS-aware resolution; only real ESM Node import
    // / SEA runtime / npm install expose it (#3223 follow-up).
    //
    // `@botiverse/k-carrier` intentionally publishes TypeScript source as its
    // package export. Native Node refuses to strip types under node_modules, so
    // leaving it external makes the otherwise-valid npm dist fail before even
    // `raft-computer --version` can run. The SEA builder already bundles every
    // dependency; keep the ordinary published bin equivalent by inlining K here.
    noExternal: [
      "commander",
      "proper-lockfile",
      "undici",
      "@botiverse/raft-shared",
      "@botiverse/raft-trace-client",
      "@botiverse/k-carrier",
    ],
    banner: {
      js:
        "#!/usr/bin/env node\n" +
        "import { createRequire as __slockCreateRequire } from \"node:module\";\n" +
        "const require = __slockCreateRequire(import.meta.url);",
    },
  },
  {
    entry: { "lib/index": "src/lib/index.ts" },
    format: "esm",
    target: "node20",
    platform: "node",
    splitting: false,
    // `clean: false` — the bin config above already cleaned `dist/`; if
    // both ran `clean: true` they would race and one would wipe the other.
    clean: false,
    dts: true,
    // Same as the bin entry: inline the source-only workspace tracing packages
    // so the `@botiverse/raft-computer/lib` subpath bundle is self-contained for
    // its `import`-only consumers (menu-bar app, direct node, future SDK). Left
    // external, `createComputerApi`/`createComputerTracer` throw
    // ERR_MODULE_NOT_FOUND on `@botiverse/raft-shared` at runtime.
    noExternal: ["@botiverse/raft-shared", "@botiverse/raft-trace-client"],
  },
]);
