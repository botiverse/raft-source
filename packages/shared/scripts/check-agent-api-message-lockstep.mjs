import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(packageRoot, "src/agentApiMessageContract.ts");
const source = readFileSync(sourcePath, "utf8");
const originalField = "  target?: string;";
const incompatibleField = "  target?: number;";

assert.equal(
  source.split(originalField).length - 1,
  1,
  "lockstep verifier requires one exact target field in the public known-field projection",
);

const fixture = mkdtempSync(join(packageRoot, ".lockstep-"));
try {
  const mutantPath = join(fixture, "agentApiMessageContract.ts");
  writeFileSync(mutantPath, source.replace(originalField, incompatibleField));
  writeFileSync(join(fixture, "tsconfig.json"), `${JSON.stringify({
    extends: join(packageRoot, "tsconfig.json"),
    compilerOptions: {
      noEmit: true,
      rootDir: packageRoot,
    },
    files: [mutantPath],
  }, null, 2)}\n`);

  const result = spawnSync(
    process.execPath,
    [join(packageRoot, "node_modules/typescript/bin/tsc"), "--project", join(fixture, "tsconfig.json")],
    { cwd: packageRoot, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0, "incompatible public projection must fail TypeScript compilation");
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Type 'false' does not satisfy the constraint 'true'/,
    "mutation must fail because the schema/projection equality gate turned false",
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log("agent-api message request lockstep mutation self-test passed");
