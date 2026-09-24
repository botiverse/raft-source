import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Publish guard for the generated @slock-ai/daemon delegation shim
// (shim-dist/). Every assertion encodes a migration red-line from
// #proj-aiax:4c235f84: the legacy name must stay runnable for machine-level
// consumers (bin) AND keep the ./core export alive for installed
// @botiverse/raft-computer's runtime import.

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shimDir = join(root, "shim-dist");
const pkg = JSON.parse(readFileSync(join(shimDir, "package.json"), "utf8"));
const workspacePkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const indexJs = readFileSync(join(shimDir, "index.js"), "utf8");
const coreJs = readFileSync(join(shimDir, "core.js"), "utf8");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(pkg.name === "@slock-ai/daemon", "shim must publish under the legacy name @slock-ai/daemon");
assert(pkg.version === workspacePkg.version, "shim version must stay in lockstep with the workspace daemon version");
assert(pkg.private !== true, "shim must not be private");
assert(pkg.publishConfig?.access === "public", "shim publishConfig.access must be public");
assert(pkg.bin?.["slock-daemon"] === "index.js", "shim must keep the slock-daemon bin so services and scripts keep working");
assert(!pkg.bin?.["raft-daemon"], "legacy shim must not expose the raft-daemon bin");
assert(pkg.exports?.["./core"] === "./core.js", "shim must keep the ./core export for installed @botiverse/raft-computer");
assert(pkg.dependencies?.["@botiverse/raft-daemon"] === `^${pkg.version}`, "shim must depend on @botiverse/raft-daemon with a caret range tracking the paired release");
assert(Object.keys(pkg.dependencies ?? {}).length === 1, "shim must have no dependencies besides @botiverse/raft-daemon");
assert(!pkg.devDependencies, "shim must not carry devDependencies");

assert(indexJs.startsWith("#!/usr/bin/env node"), "shim bin must keep the node shebang");
assert(indexJs.includes('await import("@botiverse/raft-daemon/dist/slock-daemon.js")'), "shim bin must delegate to the @botiverse/raft-daemon slock-daemon entry");
assert(coreJs.includes('export * from "@botiverse/raft-daemon/core"'), "shim core must re-export @botiverse/raft-daemon/core");

console.log("@slock-ai/daemon delegation shim package is valid.");
