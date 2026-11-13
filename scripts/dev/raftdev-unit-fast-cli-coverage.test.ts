import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(join(projectDir, "RELEASE_SOURCE"));
const workflowPath = join(projectDir, ".github", "workflows", "test.yml");
const cliPackagePath = join(projectDir, "packages", "cli", "package.json");
const cliManifestPath = join(projectDir, "packages", "cli", "test-execution-manifest.json");
const cliManifestRunnerPath = join(projectDir, "packages", "cli", "scripts", "run-tests-with-manifest.ts");

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
  ["src/client.test.ts", 29],
  ["src/commands/action/prepare.test.ts", 30],
  ["src/commands/message/_format.test.ts", 79],
  ["src/commands/task/_format.test.ts", 37],
  ["src/parserOutput.test.ts", 3],
]);

function unitFastBody(workflow: string): string {
  const header = /^  unit-fast:\s*$/m.exec(workflow);
  assert.ok(header, "test.yml must define the required unit-fast job");

  const bodyStart = header.index + header[0].length;
  const following = workflow.slice(bodyStart);
  const nextJob = /^  [A-Za-z0-9_-]+:\s*$/m.exec(following);
  return following.slice(0, nextJob?.index ?? following.length);
}

function assertPackageInUnitFastLoop(workflow: string, pkg: string): void {
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
    packages.includes(pkg),
    `unit-fast package loop must include ${pkg}`,
  );
}

function assertCliPackageInUnitFastLoop(workflow: string): void {
  assertPackageInUnitFastLoop(workflow, "@botiverse/raft");
}

/**
 * #proj-daemon task #309, follow-up to #308.
 *
 * trace-client was in NO workflow at all: `unit-fast` enumerates its packages
 * explicitly and did not list it, and `trace-client` appeared nowhere else under
 * `.github/`. Its suite had fourteen tests and nothing executed any of them,
 * which is the most likely reason a pure file-selection bug in the trace sink's
 * prune survived — the local trace sink decides whether a machine retains any
 * uploadable trace at all, and registrations were measured blind for 22-54 days.
 *
 * #308 added the package to the loop. This pins it there: adding an entry and
 * pinning the entry are separate guarantees, and only the second survives the
 * next person editing this list.
 */
function assertTraceClientPackageInUnitFastLoop(workflow: string): void {
  assertPackageInUnitFastLoop(workflow, "@botiverse/raft-trace-client");
}

function readCliManifest(): CliExecutionManifest {
  return JSON.parse(readFileSync(cliManifestPath, "utf8")) as CliExecutionManifest;
}

/**
 * CONVENTION (adopted 2026-09-21; ruled by 庄天翼 in the #8081 adjudication --
 * he wrote the ruling and executed the merge, squash eb548397e; the
 * #proj-raft-cli channel description records his design-DRI appointment.
 * Thread #proj-raft-cli:d009d816 holds the update history: since their
 * introduction in 40f1a051b (inclusive; 2026-08-31T18:56Z) the pins were
 * raised repeatedly inside ordinary commits, with two dips. Enumerating that
 * history is rename-sensitive -- this test file has had three names, recorded
 * sweeps disagree with each other, so no count is asserted here; the
 * numbers and methods live in the thread):
 * `fileCount` and `total` are MIRRORS of test-execution-manifest.json, not
 * independently-signed quotas. When a change legitimately adds or removes CLI
 * tests, regenerate the manifest (`pnpm --filter @botiverse/raft
 * test:update-manifest`; the script lives in packages/cli, not the repo root)
 * and update these two pins in the same change, stating the per-file delta in
 * the change description. The pins exist so that a manifest drift is a
 * conscious, enumerated act -- never to freeze the count.
 *
 * Known boundary (trigger surface and job gate are two different layers): the
 * Test workflow triggers on every pull_request, pushes to staging, manual
 * dispatch, and schedule; the unit-fast job gate then skips pull_request runs
 * unless the head is a same-repo `stamp-mq/` branch. Net effect: an ordinary
 * PR never runs this check, so a stale pin surfaces after merge on staging
 * (the scheduled run is a second post-merge chance: it runs on the default
 * branch to catch drift on days with no merges) -- or earlier, via a manual
 * dispatch against any ref (the PR head being the useful case) or a
 * same-repo `stamp-mq/` PR.
 * Deriving the pin from the manifest, or running this check on PRs that touch
 * CLI tests, would remove that trap -- tracked separately; this comment only
 * records the update convention.
 */
function assertCliManifestContract(manifest: CliExecutionManifest): void {
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.package, "@botiverse/raft");
  assert.equal(manifest.runner, "vitest run");
  assert.equal(manifest.testFileGlob, "src/**/*.test.ts");
  // fileCount and total are NOT pinned to literal values here. The manifest is
  // already self-consistent by the two assertions below, so a literal copy of
  // its own totals adds no verification power -- it only drifts the moment
  // anyone legitimately adds or removes a CLI test case, which is why this
  // check kept going red for a reason unrelated to any defect. Pinning exact
  // counts stays where it is load-bearing: expectedCliCaseCounts below anchors
  // specific files, which catches a case being dropped from or added to that
  // file. Derived instead of copied:
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

test("required unit-fast runs the package-owned Raft CLI suite", { skip: inSourceSnapshot }, () => {
  assertCliPackageInUnitFastLoop(readFileSync(workflowPath, "utf8"));
});

test("removing the Raft CLI package from unit-fast makes the contract fail", { skip: inSourceSnapshot }, () => {
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

test("required unit-fast runs the package-owned trace-client suite", { skip: inSourceSnapshot }, () => {
  assertTraceClientPackageInUnitFastLoop(readFileSync(workflowPath, "utf8"));
});

test("removing the trace-client package from unit-fast makes the contract fail", { skip: inSourceSnapshot }, () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const mutated = workflow.replace(" @botiverse/raft-trace-client @botiverse/raft-web", " @botiverse/raft-web");
  if (mutated === workflow) {
    throw new Error("directed mutation could not remove the trace-client package token");
  }
  assert.throws(
    () => assertTraceClientPackageInUnitFastLoop(mutated),
    /unit-fast package loop must include @botiverse\/raft-trace-client/,
  );
});

test("the trace-client package owns a test script for unit-fast to run", { skip: inSourceSnapshot }, () => {
  // `pnpm --fail-if-no-match --filter "$pkg" test` fails loudly on a missing
  // package, but a package present with no `test` script is the quieter way for
  // this coverage to evaporate.
  const pkg = JSON.parse(
    readFileSync(join(projectDir, "packages", "trace-client", "package.json"), "utf8"),
  ) as { name?: string; scripts?: Record<string, string> };
  assert.equal(pkg.name, "@botiverse/raft-trace-client", "package name must match the unit-fast loop entry");
  assert.ok(pkg.scripts?.test, "trace-client must keep a `test` script for the unit-fast loop to invoke");
});

test("Raft CLI package test script validates the per-file execution manifest without force-exit", () => {
  const cliPackage = JSON.parse(readFileSync(cliPackagePath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(cliPackage.scripts?.test, "node --import @oxc-node/core/register scripts/run-tests-with-manifest.ts");
  assert.equal(
    cliPackage.scripts?.["test:update-manifest"],
    "node --import @oxc-node/core/register scripts/run-tests-with-manifest.ts --update-manifest",
  );

  const runner = readFileSync(cliManifestRunnerPath, "utf8");
  assert.doesNotMatch(runner, /--test-force-exit/);
  // The vitest run records executed cases through the package's own reporter,
  // which writes the event log the manifest is rebuilt from.
  assert.match(runner, /`--reporter=\$\{reporterPath\}`/);
  assert.match(runner, /RAFT_CLI_TEST_EVENT_LOG: eventLogPath/);
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
