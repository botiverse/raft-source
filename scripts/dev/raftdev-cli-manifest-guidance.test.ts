import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const updateCommand = "pnpm --filter @botiverse/raft test:update-manifest";
type Cases = Record<string, string[]>;

// Exercise the package's actual runner and reporter, including the exit code
// and update advice, without changing the repository's execution manifest.
function fixture(before: Cases, after: Cases) {
  const root = mkdtempSync(join(tmpdir(), "raft-cli-manifest-"));
  try {
    mkdirSync(join(root, "scripts"));
    symlinkSync(join(projectDir, "node_modules"), join(root, "node_modules"), "junction");
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    for (const file of ["run-tests-with-manifest.ts", "test-execution-reporter.ts"]) {
      copyFileSync(join(projectDir, "packages/cli/scripts", file), join(root, "scripts", file));
    }
    const writeCases = (files: Cases) => {
      rmSync(join(root, "src"), { recursive: true, force: true });
      mkdirSync(join(root, "src"));
      for (const [file, names] of Object.entries(files)) {
        writeFileSync(join(root, "src", file), 'import { test } from "vitest";\n'
          + names.map((name) => `test(${JSON.stringify(name)}, () => {});\n`).join(""));
      }
    };
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = (...args: string[]) => spawnSync(process.execPath,
      ["--import", "@oxc-node/core/register", join(root, "scripts/run-tests-with-manifest.ts"), ...args],
      { cwd: root, encoding: "utf8", env });
    writeCases(before);
    const seed = run("--update-manifest");
    assert.equal(seed.status, 0, seed.stderr || seed.error?.message);
    const manifestPath = join(root, "test-execution-manifest.json");
    const baseline = readFileSync(manifestPath, "utf8");
    writeCases(after);
    const result = run();
    assert.ifError(result.error);
    assert.equal(readFileSync(manifestPath, "utf8"), baseline, "validation must not rewrite the baseline");
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const original = { "example.test.ts": ["one", "two"] };

test("CLI manifest matching cases still pass", () => {
  const result = fixture(original, original);
  assert.equal(result.status, 0, result.stderr);
});

const removalScenarios: Array<{ name: string; before: Cases; after: Cases }> = [
  { name: "removal hidden by net growth", before: original,
    after: { "example.test.ts": ["one", "new-a", "new-b"] } },
  { name: "duplicate removal hidden by net growth",
    before: { "example.test.ts": ["same", "same"] },
    after: { "example.test.ts": ["same", "new-a", "new-b"] } },
  { name: "case moved between existing files",
    before: { "example.test.ts": ["one", "two"], "other.test.ts": ["three"] },
    after: { "example.test.ts": ["one"], "other.test.ts": ["three", "two"] } },
];
for (const scenario of removalScenarios) {
  test(`CLI manifest refuses update advice for ${scenario.name}`, () => {
    const result = fixture(scenario.before, scenario.after);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /removed cases:/);
    assert.match(result.stderr, /added cases:/);
    assert.match(result.stderr, /Do not update the manifest/);
    assert.ok(!result.stderr.includes(updateCommand), result.stderr);
  });
}

test("CLI manifest additions suggest an update only after review", () => {
  const result = fixture(original, { "example.test.ts": ["one", "two", "three"] });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /No recorded cases disappeared\. Review the additions; if intentional/);
  assert.ok(result.stderr.includes(updateCommand), result.stderr);
  assert.doesNotMatch(result.stderr, /removed cases:/);
});

test("CLI manifest ordering drift does not suggest accepting new cases", () => {
  const result = fixture(original, { "example.test.ts": ["two", "one"] });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Review ordering and manifest metadata/);
  assert.doesNotMatch(result.stderr, /removed cases:|added cases:/);
  assert.ok(!result.stderr.includes(updateCommand), result.stderr);
});
