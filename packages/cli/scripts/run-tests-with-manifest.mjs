import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedManifestPath = resolve(packageRoot, "test-execution-manifest.json");
const resultsDir = resolve(packageRoot, "test-results");
const eventLogPath = resolve(resultsDir, "cli-test-execution-events.ndjson");
const observedManifestPath = resolve(resultsDir, "cli-test-execution-observed.json");
const reporterPath = resolve(packageRoot, "scripts", "test-execution-reporter.mjs");
const updateManifest = process.argv.includes("--update-manifest");

function toPosixPath(path) {
  return path.split(sep).join("/");
}

function listTestFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) {
    const absolute = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTestFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(toPosixPath(relative(packageRoot, absolute)));
    }
  }
  return files;
}

function normalizeEventFile(file) {
  if (typeof file !== "string" || file.length === 0) {
    return null;
  }
  return toPosixPath(relative(packageRoot, resolve(file)));
}

function readObservedEvents() {
  if (!existsSync(eventLogPath)) {
    throw new Error(`CLI test execution reporter did not write ${toPosixPath(relative(packageRoot, eventLogPath))}`);
  }

  return readFileSync(eventLogPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`Invalid test execution event JSON on line ${index + 1}: ${err.message}`);
      }
    });
}

function buildManifest(testFiles, events) {
  const byFile = new Map(testFiles.map((file) => [file, []]));
  for (const event of events) {
    const file = normalizeEventFile(event.file);
    if (!file || !byFile.has(file)) {
      throw new Error(`Reporter emitted a test case for an unexpected file: ${event.file ?? "<missing>"}`);
    }
    // Identity is the case name only. Do NOT pin event.line/event.column: the
    // reporter sees tsx-transpiled positions (line 1 + a character offset),
    // which shift on any edit above a test and across toolchain versions —
    // pure false-red churn with no added protection. Duplicate names within a
    // file are still caught via the count and the ordered name list.
    byFile.get(file).push({
      name: event.name,
    });
  }

  const files = [...byFile.entries()].map(([file, cases]) => ({
    file,
    count: cases.length,
    cases,
  }));
  const total = files.reduce((sum, file) => sum + file.count, 0);
  return {
    // v2: case entries dropped the transpiled line/column offsets (see
    // buildManifest) — regenerate with `pnpm --filter @botiverse/raft
    // test:update-manifest` when the reporter shape changes.
    schemaVersion: 2,
    package: "@botiverse/raft",
    runner: "node --import tsx --test",
    testFileGlob: "src/**/*.test.ts",
    fileCount: files.length,
    total,
    files,
  };
}

function assertSameManifest(expected, observed) {
  const expectedText = JSON.stringify(expected, null, 2);
  const observedText = JSON.stringify(observed, null, 2);
  if (expectedText === observedText) {
    return;
  }

  const expectedByFile = new Map(expected.files.map((file) => [file.file, file]));
  const observedByFile = new Map(observed.files.map((file) => [file.file, file]));
  const missingFiles = expected.files.map((file) => file.file).filter((file) => !observedByFile.has(file));
  const extraFiles = observed.files.map((file) => file.file).filter((file) => !expectedByFile.has(file));
  const countMismatches = [];
  const identityMismatches = [];
  for (const file of expected.files) {
    const observedFile = observedByFile.get(file.file);
    if (observedFile && observedFile.count !== file.count) {
      countMismatches.push(`${file.file}: expected ${file.count}, observed ${observedFile.count}`);
    } else if (observedFile && JSON.stringify(observedFile.cases) !== JSON.stringify(file.cases)) {
      identityMismatches.push(file.file);
    }
  }

  const details = [
    `expected total ${expected.total}, observed ${observed.total}`,
    missingFiles.length ? `missing files: ${missingFiles.join(", ")}` : null,
    extraFiles.length ? `extra files: ${extraFiles.join(", ")}` : null,
    countMismatches.length ? `count mismatches: ${countMismatches.join("; ")}` : null,
    identityMismatches.length ? `case identity mismatches: ${identityMismatches.join(", ")}` : null,
    `observed manifest: ${toPosixPath(relative(packageRoot, observedManifestPath))}`,
  ].filter(Boolean);
  throw new Error(`CLI test execution manifest mismatch\n${details.join("\n")}`);
}

mkdirSync(resultsDir, { recursive: true });
writeFileSync(eventLogPath, "");

const testFiles = listTestFiles(resolve(packageRoot, "src"));
const result = spawnSync(process.execPath, [
  "--import",
  "tsx",
  "--test",
  "--test-reporter=tap",
  "--test-reporter-destination=stdout",
  "--test-reporter",
  reporterPath,
  "--test-reporter-destination",
  eventLogPath,
  ...testFiles,
], {
  cwd: packageRoot,
  encoding: "utf8",
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}

const observedManifest = buildManifest(testFiles, readObservedEvents());
if (observedManifest.total === 0) {
  throw new Error("CLI test execution reporter emitted no test cases");
}
writeFileSync(observedManifestPath, `${JSON.stringify(observedManifest, null, 2)}\n`);

if (updateManifest) {
  writeFileSync(expectedManifestPath, `${JSON.stringify(observedManifest, null, 2)}\n`);
  console.log(`Updated ${toPosixPath(relative(packageRoot, expectedManifestPath))}: ${observedManifest.fileCount} files / ${observedManifest.total} test cases`);
} else {
  if (!existsSync(expectedManifestPath)) {
    throw new Error(`Missing ${toPosixPath(relative(packageRoot, expectedManifestPath))}; run pnpm --filter @botiverse/raft test:update-manifest`);
  }
  const expectedManifest = JSON.parse(readFileSync(expectedManifestPath, "utf8"));
  assertSameManifest(expectedManifest, observedManifest);
  console.log(`Verified ${toPosixPath(relative(packageRoot, observedManifestPath))}: ${observedManifest.fileCount} files / ${observedManifest.total} test cases`);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
