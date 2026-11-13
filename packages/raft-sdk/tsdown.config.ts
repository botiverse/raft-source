import { defineConfig } from "tsdown";

// Three build configs produce the published layout exactly (each also emits
// `agent.*` for the `./agent` entry, plus shared chunks):
//   1. ESM bundle → dist/esm/index.js
//   2. CJS bundle → dist/cjs/index.cjs (node platform keeps the .cjs
//      fixed extension, which matches package.json `main`/`exports.require`)
//   3. Bundled declarations only → dist/index.d.ts
//
// `@botiverse/raft-shared` is a private source-only workspace package and MUST
// be inlined into both the JS bundles and the d.ts (scripts/
// check-packed-artifact.ts rejects any `@botiverse/raft-shared` leak).
// `zod` is a runtime `dependencies` entry but the rslib build bundled it
// (autoExternal: false), so keep it inlined to preserve the artifact contract.
// Regexes, not bare names: tsdown matches alwaysBundle against the full
// specifier, so a bare "zod" would leave `zod/v4/...` subpath imports external.
const alwaysBundle = [/^zod(\/|$)/, /^@botiverse\/raft-shared(\/|$)/];

// Three public entries, `.` (program layer), `./agent` (agent layer) and
// `./continuations` (experimental), built
// together in each config so code they share lands in one shared chunk: a
// class or Symbol (RaftSdkConfigurationError, SeenFrontier, the
// raftbenchFailedReport brand) is then the same value from either entry.
// `./app` (a Raft App's client with Server context, RFC 079) is built beside
// them the same way.
const entry = {
  index: "src/index.ts",
  agent: "src/agent.ts",
  continuations: "src/continuations.ts",
  app: "src/app.ts",
};

export default defineConfig([
  {
    entry,
    format: "esm",
    platform: "node",
    outDir: "dist/esm",
    // node platform defaults ESM output to .mjs; exports.import points at .js.
    fixedExtension: false,
    clean: true,
    dts: false,
    deps: { alwaysBundle },
  },
  {
    entry,
    format: "cjs",
    platform: "node",
    outDir: "dist/cjs",
    clean: false,
    dts: false,
    deps: { alwaysBundle },
  },
  {
    entry,
    format: "esm",
    platform: "node",
    outDir: "dist",
    clean: false,
    // node platform defaults ESM declarations to .d.mts; exports.types points
    // at dist/index.d.ts, so keep the plain extension.
    fixedExtension: false,
    // Declarations only — the JS bundles above own the runtime artifacts.
    // tsconfig.dts.json maps the source-only workspace packages to their real
    // source paths: tsc skips declaration emit for files reached through a
    // bare node_modules specifier (treated as external library inputs), which
    // otherwise silently empties the virtual barrel (MISSING_EXPORT at bundle
    // time). `onlyBundle: []` is the guard: NOTHING from node_modules may be
    // inlined into the published type file — the build fails naming the
    // offending package. `onlyImport: ["zod"]` explicitly allows the one
    // legitimate external type reference (zod is a declared runtime
    // dependency); everything else — notably zod-openapi, whose global
    // `declare module 'zod/v4'` augmentation rewrites consumers' own zod
    // typing — fails the build.
    dts: { emitDtsOnly: true, resolver: "tsc", tsconfig: "tsconfig.dts.json" },
    deps: {
      alwaysBundle: [/^@botiverse\/raft-shared(\/|$)/],
      onlyBundle: [],
      onlyImport: ["zod"],
    },
  },
]);
