import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Publish guard for the generated @slock-ai/cli delegation shim (shim-dist/).
// Mirrors check-publish-package.mjs conventions: every assertion here encodes
// a migration red-line from the rename plan (#proj-aiax:4c235f84).

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shimDir = join(root, "shim-dist");
const pkg = JSON.parse(readFileSync(join(shimDir, "package.json"), "utf8"));
const workspacePkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const indexJs = readFileSync(join(shimDir, "index.js"), "utf8");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(pkg.name === "@slock-ai/cli", "shim must publish under the legacy name @slock-ai/cli");
assert(workspacePkg.name === "@botiverse/raft", "workspace package must be the canonical @botiverse/raft");
assert(pkg.version === workspacePkg.version, "shim version must stay in lockstep with the canonical package version");
assert(pkg.private !== true, "shim must not be private");
assert(pkg.publishConfig?.access === "public", "shim publishConfig.access must be public");
assert(pkg.bin?.slock === "index.js", "shim must keep the slock bin so existing invocations keep working");
assert(!pkg.bin?.raft, "legacy shim must not expose the raft bin");
assert(pkg.dependencies?.["@botiverse/raft"] === `^${pkg.version}`, "shim must depend on @botiverse/raft with a caret range tracking the paired release");
assert(Object.keys(pkg.dependencies ?? {}).length === 1, "shim must have no dependencies besides @botiverse/raft");
assert(!pkg.devDependencies, "shim must not carry devDependencies");
assert(!Object.values(pkg.dependencies ?? {}).some((v) => String(v).startsWith("workspace:")), "shim must not leak workspace protocol dependencies");

assert(indexJs.startsWith("#!/usr/bin/env node"), "shim bin must keep the node shebang");
assert(indexJs.includes('await import("@botiverse/raft/dist/slock.js")'), "shim bin must delegate to the @botiverse/raft slock entry");
assert(indexJs.includes("SLOCK_CLI_RENAME_NOTICE"), "shim notice must be suppressible via SLOCK_CLI_RENAME_NOTICE=0");
assert(indexJs.includes("renamed to @botiverse/raft"), "shim must print the rename notice");
assert(indexJs.indexOf("await import(\"@botiverse/raft/dist/slock.js\")") > indexJs.indexOf("catch"), "delegation must run even when the notice block fails");

console.log("@slock-ai/cli delegation shim package is valid.");
