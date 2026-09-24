import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(join(projectDir, "RELEASE_SOURCE"));
const workflowPath = join(projectDir, ".github", "workflows", "test.yml");
const cliPackagePath = join(projectDir, "packages", "cli", "package.json");
const cliManifestPath = join(projectDir, "packages", "cli", "test-execution-manifest.json");
const cliManifestRunnerPath = join(projectDir, "packages", "cli", "scripts", "run-tests-with-manifest.mjs");

type CliExecutionManifest = {
  schemaVersion: number;
  package: string;
  runner: string;
  testFileGlob: string;
  fileCount: number;
  total: number;
  files: Array<{
    file: string;
    count: number;
    cases: Array<{
      name: string;
    }>;
  }>;
};

const expectedCliCaseCounts = new Map([
  ["src/client.test.ts", 24],
  ["src/commands/action/prepare.test.ts", 21],
  ["src/commands/message/_format.test.ts", 39],
  ["src/commands/task/_format.test.ts", 25],
  ["src/parserOutput.test.ts", 10],
]);

function unitFastBody(workflow: string): string {
  const header = /^  unit-fast:\s*$/m.exec(workflow);
  assert.ok(header, "test.yml must define the required unit-fast job");

  const bodyStart = header.index + header[0].length;
  const following = workflow.slice(bodyStart);
  const nextJob = /^  [A-Za-z0-9_-]+:\s*$/m.exec(following);
  return following.slice(0, nextJob?.index ?? following.length);
}

function assertCliPackageInUnitFastLoop(workflow: string): void {
  const body = unitFastBody(workflow);
  const loops = [...body.matchAll(/^\s*for pkg in ([^;\n]+); do\s*$/gm)];
  assert.equal(loops.length, 1, "unit-fast must have exactly one package test loop");
  assert.match(
    body,
    /^\s*pnpm --fail-if-no-match --filter "\$pkg" test &\s*$/m,
    "unit-fast package loop must run each package-owned test command",
  );

  const packages = loops[0]![1]!.trim().split(/\s+/);
  assert.ok(
    packages.includes("@botiverse/raft"),
    "unit-fast package loop must include @botiverse/raft",
  );
}

function readCliManifest(): CliExecutionManifest {
  return JSON.parse(readFileSync(cliManifestPath, "utf8")) as CliExecutionManifest;
}

function assertCliManifestContract(manifest: CliExecutionManifest): void {
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.package, "@botiverse/raft");
  assert.equal(manifest.runner, "node --import tsx --test");
  assert.equal(manifest.testFileGlob, "src/**/*.test.ts");
  assert.equal(manifest.fileCount, 103);
  assert.equal(manifest.total, 918);
  assert.equal(manifest.files.length, manifest.fileCount);
  assert.equal(
    manifest.files.reduce((total, file) => total + file.count, 0),
    manifest.total,
  );

  const files = new Map(manifest.files.map((file) => [file.file, file]));
  for (const [filePath, expectedCount] of expectedCliCaseCounts) {
    const file = files.get(filePath);
    assert.ok(file, `manifest must include ${filePath}`);
    assert.equal(file.count, expectedCount, `${filePath} case count`);
    assert.equal(file.cases.length, expectedCount, `${filePath} case list length`);
  }
}

test("required unit-fast runs the package-owned Raft CLI suite", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  assertCliPackageInUnitFastLoop(readFileSync(workflowPath, "utf8"));
});

test("removing the Raft CLI package from unit-fast makes the contract fail", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const mutated = workflow.replace(" @botiverse/raft @botiverse/raft-sdk", " @botiverse/raft-sdk");
  if (mutated === workflow) {
    throw new Error("directed mutation could not remove the CLI package token");
  }
  assert.throws(
    () => assertCliPackageInUnitFastLoop(mutated),
    /unit-fast package loop must include @botiverse\/raft/,
  );
});

test("Raft CLI package test script validates the per-file execution manifest without force-exit", () => {
  const cliPackage = JSON.parse(readFileSync(cliPackagePath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(cliPackage.scripts?.test, "node scripts/run-tests-with-manifest.mjs");
  assert.equal(
    cliPackage.scripts?.["test:update-manifest"],
    "node scripts/run-tests-with-manifest.mjs --update-manifest",
  );

  const runner = readFileSync(cliManifestRunnerPath, "utf8");
  assert.doesNotMatch(runner, /--test-force-exit/);
  assert.match(runner, /--test-reporter-destination",\s*eventLogPath/);
  assert.match(runner, /assertSameManifest\(expectedManifest, observedManifest\)/);
});

test("Raft CLI execution manifest records exact per-file case counts", () => {
  assertCliManifestContract(readCliManifest());
});

test("Raft CLI execution manifest contract fails closed when a tail case is missing", () => {
  const manifest = readCliManifest();
  const mutated = structuredClone(manifest);
  const clientFile = mutated.files.find((file) => file.file === "src/client.test.ts");
  assert.ok(clientFile);
  const removed = clientFile.cases.pop();
  assert.ok(removed, "directed mutation must remove a client test case");

  assert.throws(
    () => assertCliManifestContract(mutated),
    /src\/client\.test\.ts case list length/,
  );
});
