import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(pkg.name === "@botiverse/raft-sdk", "package name must be @botiverse/raft-sdk");
assert(pkg.private !== true, "package must not be private");
assert(pkg.publishConfig?.access === "public", "publishConfig.access must be public");
assert(pkg.main === "./dist/cjs/index.cjs", "main must select the CJS bundle");
assert(pkg.module === "./dist/esm/index.js", "module must select the ESM bundle");
assert(pkg.types === "./dist/index.d.ts", "types must select the bundled declaration");
assert(pkg.exports?.["."]?.import === "./dist/esm/index.js", "exports.import must select ESM");
assert(pkg.exports?.["."]?.require === "./dist/cjs/index.cjs", "exports.require must select CJS");
assert(pkg.exports?.["."]?.types === "./dist/index.d.ts", "exports.types must select declarations");
assert(Array.isArray(pkg.files) && pkg.files.includes("dist"), "published package must include dist/");
assert(!pkg.dependencies?.["@botiverse/raft-shared"], "published SDK must not depend on unpublished shared");
assert(
  pkg.devDependencies?.["@botiverse/raft-shared"] === "workspace:*",
  "@botiverse/raft-shared must remain a workspace-only bundled build input",
);
assert(pkg.devDependencies?.["@rslib/core"], "Rslib must remain an explicit build dependency");

console.log("@botiverse/raft-sdk publish metadata is valid.");
