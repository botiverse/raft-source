import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Builds the publishable delegation-shim form of @slock-ai/daemon into
// shim-dist/ (rename migration block ③, #proj-aiax:4c235f84).
//
// The legacy npm name keeps publishing, but as a thin wrapper over the
// canonical @botiverse/raft-daemon. Invariant: `latest` on the legacy name
// must always stay runnable — machine-level consumers reach this package two
// ways and the shim must preserve both:
//   1. the `slock-daemon` bin (installers / service definitions / scripts)
//   2. the `./core` export (installed @botiverse/raft-computer does a runtime
//      `import("@slock-ai/daemon/core")` to spawn per-server daemons)

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function buildShimPackage(outDir = join(root, "shim-dist")) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const shimPkg = {
    name: "@slock-ai/daemon",
    version: pkg.version,
    description:
      "Renamed to @botiverse/raft-daemon. This package is a compatibility shim that delegates to it; existing `slock-daemon` invocations and the ./core export keep working.",
    type: "module",
    bin: { "slock-daemon": "index.js" },
    exports: { "./core": "./core.js", "./package.json": "./package.json" },
    repository: pkg.repository,
    publishConfig: { access: "public" },
    dependencies: { "@botiverse/raft-daemon": `^${pkg.version}` },
  };

  const indexJs = `#!/usr/bin/env node
// Compatibility shim: @slock-ai/daemon -> @botiverse/raft-daemon.
await import("@botiverse/raft-daemon/dist/slock-daemon.js");
`;

  const coreJs = `// Compatibility re-export: @slock-ai/daemon/core -> @botiverse/raft-daemon/core.
export * from "@botiverse/raft-daemon/core";
`;

  const readme = `# @slock-ai/daemon

**This package has been renamed to [@botiverse/raft-daemon](https://www.npmjs.com/package/@botiverse/raft-daemon).**

From the shim versions onward, @slock-ai/daemon is a compatibility wrapper
that depends on @botiverse/raft-daemon: the \`slock-daemon\` bin delegates to
it and the \`./core\` export re-exports it, so existing installs, service
definitions, and auto-upgrade scripts keep working unchanged. New installs
should use @botiverse/raft-daemon directly.
`;

  writeFileSync(join(outDir, "package.json"), JSON.stringify(shimPkg, null, 2) + "\n");
  writeFileSync(join(outDir, "index.js"), indexJs);
  chmodSync(join(outDir, "index.js"), 0o755);
  writeFileSync(join(outDir, "core.js"), coreJs);
  writeFileSync(join(outDir, "README.md"), readme);
  return outDir;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const outDir = buildShimPackage();
  console.log(`@slock-ai/daemon delegation shim written to ${outDir}`);
}
