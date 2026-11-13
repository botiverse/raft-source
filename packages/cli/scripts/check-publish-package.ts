import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Publish guard for the canonical @botiverse/raft package (this directory).
// After the source-of-truth inversion (#proj-aiax:4c235f84) this workspace
// package IS the canonical Raft CLI; the legacy @slock-ai/cli name publishes
// separately as a generated delegation shim (see build-shim-package.ts).

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(pkg.name === "@botiverse/raft", "package name must be the canonical @botiverse/raft");
assert(pkg.private !== true, "package must not be private");
assert(pkg.publishConfig?.access === "public", "publishConfig.access must be public");
assert(pkg.engines?.node === ">=24", "package engines.node must declare the supported Node floor");
assert(pkg.bin?.raft === "dist/raft.js", "raft bin must point at dist/raft.js");
assert(pkg.bin?.slock === "dist/slock.js", "slock alias bin must point at dist/slock.js");
assert(pkg.bin?.cont === "dist/cont.js", "cont bin (raft __continue) must point at dist/cont.js");
assert(Array.isArray(pkg.files) && pkg.files.includes("dist"), "published package must include dist/");
assert(pkg.dependencies?.commander, "@botiverse/raft must carry the CLI commander runtime dependency");
assert(pkg.dependencies?.undici, "@botiverse/raft must carry the CLI undici runtime dependency");
assert(!pkg.dependencies?.["@botiverse/raft-shared"], "@botiverse/raft-shared is not published; keep it bundled from devDependencies");
assert(pkg.devDependencies?.["@botiverse/raft-shared"] === "workspace:*", "@botiverse/raft-shared must remain a workspace build input");
assert(
  !pkg.dependencies?.["@botiverse/raft-sdk"] && !pkg.devDependencies?.["@botiverse/raft-sdk"],
  "@botiverse/raft must share source-safe operations through @botiverse/raft-shared, not require a prebuilt SDK workspace package",
);

// npm rejects a package that contains a symbolic link (415 "Symbolic link is
// not allowed"), which is how cli-v1.0.56 failed: README.md was a symlink. npm
// always packs the root README/LICENSE/CHANGELOG, plus everything under `files`.
function symlinksUnder(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path).flatMap((name) => symlinksUnder(join(path, name)));
}
const packed = [
  "package.json",
  ...readdirSync(root).filter((name) => /^(readme|license|licence|changelog)(\.|$)/i.test(name)),
  ...pkg.files,
].map((entry) => join(root, entry)).filter((path) => existsSync(path) || lstatSync(path, { throwIfNoEntry: false }));
const links = packed.flatMap(symlinksUnder);
assert(links.length === 0, `npm refuses symbolic links in a package; replace with regular files: ${links.join(", ")}`);

console.log("@botiverse/raft publish package metadata is valid.");
