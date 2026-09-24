import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Publish guard for the canonical @botiverse/raft-daemon package
// (rename migration block ④, #proj-aiax:c1b79aaa — packages/daemon is the
// canonical source after the inversion; the legacy @slock-ai/daemon name is
// published as a generated delegation shim, guarded by check-shim-package).

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(pkg.name === "@botiverse/raft-daemon", "canonical daemon package name must be @botiverse/raft-daemon");
assert(pkg.private !== true, "package must not be private");
assert(pkg.publishConfig?.access === "public", "publishConfig.access must be public");
assert(pkg.bin?.["raft-daemon"] === "dist/raft-daemon.js", "raft-daemon bin must point at dist/raft-daemon.js");
assert(pkg.bin?.["slock-daemon"] === "dist/slock-daemon.js", "slock-daemon alias must point at dist/slock-daemon.js");
assert(pkg.exports?.["./core"]?.import === "./dist/core.js", "core export must point at dist/core.js");
// The @slock-ai/daemon delegation shim deep-imports dist/slock-daemon.js;
// with an `exports` field present, undeclared subpaths are encapsulated
// (ERR_PACKAGE_PATH_NOT_EXPORTED), so the bin wrappers must stay exported.
assert(pkg.exports?.["./dist/slock-daemon.js"] === "./dist/slock-daemon.js", "dist/slock-daemon.js must stay exported for the legacy shim's deep import");
assert(pkg.exports?.["./dist/raft-daemon.js"] === "./dist/raft-daemon.js", "dist/raft-daemon.js must stay exported");
assert(Array.isArray(pkg.files) && pkg.files.includes("dist"), "published package must include dist/");
assert(pkg.devDependencies?.["@botiverse/raft"] === "workspace:*", "daemon build should keep the canonical Raft CLI as a workspace dev dependency");
assert(pkg.devDependencies?.["@botiverse/raft-shared"] === "workspace:*", "daemon build should keep shared as a workspace dev dependency");
assert(!pkg.dependencies?.["@botiverse/raft"], "daemon publish package must not depend on the workspace CLI at runtime");
assert(!pkg.dependencies?.["@botiverse/raft-shared"], "daemon publish package must not depend on unpublished workspace shared");
assert(!Object.values(pkg.dependencies ?? {}).some((v) => String(v).startsWith("workspace:")), "runtime dependencies must not use the workspace protocol");

console.log("@botiverse/raft-daemon publish package metadata is valid.");
