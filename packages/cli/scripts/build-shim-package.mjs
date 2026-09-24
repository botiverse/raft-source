import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Builds the publishable delegation-shim form of @slock-ai/cli into shim-dist/.
//
// Rename migration (P1, design thread #proj-aiax:4c235f84): the npm package
// @slock-ai/cli keeps publishing, but from the shim versions onward it is a
// thin wrapper that depends on @botiverse/raft and re-exports its `slock`
// entry. Invariant: `latest` on the legacy name must always stay runnable so
// auto-upgrade scripts never land on a broken install. The workspace package
// in this directory remains the real CLI core — daemon bundling and the
// @botiverse/raft build both consume its dist — only the published artifact
// changes shape.

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const NOTICE_LINES = [
  "[slock] @slock-ai/cli has been renamed to @botiverse/raft; this package now delegates to it.",
  "[slock] Please switch installs to @botiverse/raft (bins: raft, slock). Set SLOCK_CLI_RENAME_NOTICE=0 to silence this notice.",
];

export function buildShimPackage(outDir = join(root, "shim-dist")) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const shimPkg = {
    // The legacy npm name is fixed; the workspace package is the canonical
    // @botiverse/raft after the source-of-truth inversion.
    name: "@slock-ai/cli",
    version: pkg.version,
    description:
      "Renamed to @botiverse/raft. This package is a compatibility shim that delegates to @botiverse/raft; existing `slock` invocations keep working.",
    type: "module",
    bin: { slock: "index.js" },
    repository: pkg.repository,
    publishConfig: { access: "public" },
    dependencies: { "@botiverse/raft": `^${pkg.version}` },
  };

  const indexJs = `#!/usr/bin/env node
// Compatibility shim: @slock-ai/cli -> @botiverse/raft. Delegation must never
// fail because of the notice, so everything before the import is best-effort.
const NOTICE = ${JSON.stringify(NOTICE_LINES.join("\n"))};
try {
  if (process.env.SLOCK_CLI_RENAME_NOTICE !== "0") {
    const { existsSync, mkdirSync, statSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const stateDir = join(homedir(), ".slock");
    const stateFile = join(stateDir, ".cli-rename-notice");
    const DAY_MS = 24 * 60 * 60 * 1000;
    const due = !existsSync(stateFile) || Date.now() - statSync(stateFile).mtimeMs > DAY_MS;
    if (due) {
      process.stderr.write(NOTICE + "\\n");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(stateFile, "");
    }
  }
} catch {
  // Notice and rate-limit state are best-effort only.
}
await import("@botiverse/raft/dist/slock.js");
`;

  const readme = `# @slock-ai/cli

**This package has been renamed to [@botiverse/raft](https://www.npmjs.com/package/@botiverse/raft).**

From the shim versions onward, @slock-ai/cli is a compatibility wrapper that
depends on @botiverse/raft and delegates the \`slock\` bin to it, so existing
installs and auto-upgrade scripts keep working unchanged. New installs should
use @botiverse/raft directly (bins: \`raft\` and \`slock\`).
`;

  writeFileSync(join(outDir, "package.json"), JSON.stringify(shimPkg, null, 2) + "\n");
  writeFileSync(join(outDir, "index.js"), indexJs);
  chmodSync(join(outDir, "index.js"), 0o755);
  writeFileSync(join(outDir, "README.md"), readme);
  return outDir;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const outDir = buildShimPackage();
  console.log(`@slock-ai/cli delegation shim written to ${outDir}`);
}
