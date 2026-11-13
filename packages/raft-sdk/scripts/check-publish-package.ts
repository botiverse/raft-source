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
assert(pkg.exports?.["./agent"]?.import === "./dist/esm/agent.js", "exports ./agent import must select ESM");
assert(pkg.exports?.["./agent"]?.require === "./dist/cjs/agent.cjs", "exports ./agent require must select CJS");
assert(pkg.exports?.["./agent"]?.types === "./dist/agent.d.ts", "exports ./agent types must select declarations");
assert(pkg.exports?.["./app"]?.import === "./dist/esm/app.js", "exports ./app import must select ESM");
assert(pkg.exports?.["./app"]?.require === "./dist/cjs/app.cjs", "exports ./app require must select CJS");
assert(pkg.exports?.["./app"]?.types === "./dist/app.d.ts", "exports ./app types must select declarations");
assert(Array.isArray(pkg.files) && pkg.files.includes("dist"), "published package must include dist/");
assert(pkg.files.includes("operations.json"), "published package must include operations.json");
assert(pkg.files.includes("CHANGELOG.md"), "published package must include CHANGELOG.md");
assert(pkg.exports?.["./operations.json"] === "./operations.json", "exports must expose ./operations.json");
assert(!pkg.dependencies?.["@botiverse/raft-shared"], "published SDK must not depend on unpublished shared");
assert(
  pkg.devDependencies?.["@botiverse/raft-shared"] === "workspace:*",
  "@botiverse/raft-shared must remain a workspace-only bundled build input",
);
assert(pkg.devDependencies?.["tsdown"], "tsdown must remain an explicit build dependency");

console.log("@botiverse/raft-sdk publish metadata is valid.");
