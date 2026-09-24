import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function treeSha256(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort((a, b) => relative(directory, a).localeCompare(relative(directory, b)));
  const index = [];
  for (const path of files) {
    index.push(`${await sha256(path)}  ${relative(directory, path)}\n`);
  }
  return createHash("sha256").update(index.join("")).digest("hex");
}

const manifest = {
  contract: "raft.activity-sync",
  version: 1,
  status: "experimental",
  runnerProtocol: 1,
  typespecVersion: "1.14.0",
  bindingTopology: {
    typescript: "activity-sync.tsp -> TypeSpec semantic graph -> TypeScript",
    kotlin: "activity-sync.tsp -> direct Kotlin generator (semantic graph; canary by @HanXin, task #883)",
    jsonSchema: "activity-sync.tsp -> JSON Schema (parallel runtime-validation leg)",
    openApi: "activity-sync.tsp -> OpenAPI (parallel HTTP-operation leg)",
  },
  sourceSha256: await sha256(resolve(root, "activity-sync.tsp")),
  jsonSchemaTreeSha256: await treeSha256(resolve(root, "generated/json-schema")),
  openApiSha256: await sha256(resolve(root, "generated/openapi/openapi.json")),
  typescriptBindingSha256: await sha256(
    resolve(root, "generated/bindings/activity-sync.ts"),
  ),
  typescriptLegVerifierSha256: await sha256(
    resolve(root, "tools/verify-typescript-leg.mjs"),
  ),
  typescriptLegMutationSha256: await sha256(
    resolve(root, "tools/verify-typescript-leg-mutations.mjs"),
  ),
  kotlinBindingSha256: await sha256(
    resolve(root, "generated/bindings/ActivitySync.kt"),
  ),
  contractVectorsSha256: await sha256(
    resolve(root, "fixtures/activity-sync.contract-vectors.jsonl"),
  ),
  behaviorVectorsSha256: await sha256(
    resolve(root, "fixtures/activity-sync.behavior.jsonl"),
  ),
  behaviorSeedSha256: await sha256(
    resolve(root, "fixtures/activity-sync.behavior.seed.jsonl"),
  ),
  canonicalBehaviorResultSha256: null,
  compatibilityReceipt: null,
};

await writeFile(
  resolve(root, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
console.log("deterministic manifest written");
