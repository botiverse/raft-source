import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runInTestSlot } from "../../../scripts/vitest/testSlot";
import { defaultTestIncludes } from "./testLocations";

const scriptPath = fileURLToPath(import.meta.url);
const webRoot = resolve(dirname(scriptPath), "..");
const repoRoot = resolve(webRoot, "../..");
// Vitest 5 no longer exports "vitest/vitest.mjs"; resolve its declared bin instead.
const vitestPackageJson = createRequire(import.meta.url).resolve("vitest/package.json");
const vitestCli = resolve(dirname(vitestPackageJson), JSON.parse(readFileSync(vitestPackageJson, "utf8")).bin.vitest);

function normalizeTestArg(arg) {
  if (arg.startsWith("packages/web/")) return arg.slice("packages/web/".length);
  if (arg === "packages/web") return ".";

  if (isAbsolute(arg)) {
    const rel = relative(webRoot, arg);
    if (rel && !rel.startsWith("..") && !rel.includes(`..${sep}`)) return rel;
    return arg;
  }

  const fromCaller = resolve(process.cwd(), arg);
  const callerRel = relative(webRoot, fromCaller);
  if (
    existsSync(fromCaller) &&
    callerRel &&
    !callerRel.startsWith("..") &&
    !callerRel.includes(`..${sep}`)
  ) {
    return callerRel;
  }

  const fromRepo = resolve(repoRoot, arg);
  const repoRel = relative(webRoot, fromRepo);
  if (
    (arg.includes("*") || existsSync(fromRepo)) &&
    repoRel &&
    !repoRel.startsWith("..") &&
    !repoRel.includes(`..${sep}`)
  ) {
    return repoRel;
  }

  return arg;
}

const valueTakingFlags = new Set([
  "-t",
  "--testNamePattern",
  "--testTimeout",
  "--hookTimeout",
  "--maxWorkers",
  "--pool",
  "--reporter",
  "--outputFile",
  "--shard",
]);

const userArgs = process.argv.slice(2);
const testArgs = [];
const vitestArgs = [];
let dom = false;

for (let index = 0; index < userArgs.length; index += 1) {
  const arg = userArgs[index];
  if (arg === "--") continue;
  if (arg === "--dom") {
    dom = true;
    continue;
  }
  if (arg.startsWith("-")) {
    vitestArgs.push(arg);
    if (valueTakingFlags.has(arg) && index + 1 < userArgs.length) {
      vitestArgs.push(userArgs[index + 1]);
      index += 1;
    }
    continue;
  }
  testArgs.push(normalizeTestArg(arg));
}

// No paths: every unit (or DOM) test, in tests/ and src/features/<feature>/tests/.
const includes = testArgs.length > 0 ? testArgs : defaultTestIncludes(dom);
const missing = includes.filter((arg) => !arg.includes("*") && !existsSync(resolve(webRoot, arg)));

if (missing.length > 0) {
  console.error(
    `run-vitest-tests: these paths do not exist:\n${missing.map((item) => `  ${item}`).join("\n")}\n` +
      "Refusing to run a partial green test selection.",
  );
  process.exit(1);
}

// Named test files are linted with the test rules before they run (the whole
// set CI's lint applies to tests, so nothing new can fail). One rule matters
// most here: raft-test/no-dom-node-in-assert. A DOM node handed to
// node:assert inside a retrying waitFor is inspected on every retry, and on
// 2026-10-23 that took a local run past 15 GiB and stalled the host; lint
// catches it in under a second, before any worker starts. Globs (CI's whole
// suite) skip this: CI lints separately.
const namedFiles = includes.filter((arg) => !arg.includes("*") && /\.test\.tsx?$/.test(arg));
if (namedFiles.length > 0 && process.env.RAFT_WEB_TEST_SKIP_LINT !== "1") {
  // Run its declared bin with this Node, as for Vitest below (no shebang or exec bit needed).
  const oxlintPackageJson = createRequire(import.meta.url).resolve("oxlint/package.json");
  const oxlintCli = resolve(dirname(oxlintPackageJson), JSON.parse(readFileSync(oxlintPackageJson, "utf8")).bin.oxlint);
  const lint = spawnSync(
    process.execPath,
    [oxlintCli, "-c", "scripts/oxlint-tests.json", "--disable-nested-config", "--max-warnings=0", ...namedFiles],
    { cwd: webRoot, stdio: "inherit" },
  );
  if (lint.error) throw lint.error;
  if (lint.status !== 0) {
    console.error("run-vitest-tests: lint the test files first (RAFT_WEB_TEST_SKIP_LINT=1 skips this).");
    process.exit(lint.status ?? 1);
  }
}

// One of the host's test slots (scripts/vitest/testSlot.ts): at most two
// local runs at once across every agent, the rest wait in turn; cancelling
// this runner kills the whole run, so no orphan keeps the slot.
const result = await runInTestSlot(
  process.execPath,
  [vitestCli, "run", "--config", resolve(webRoot, "vitest.config.ts"), ...vitestArgs],
  {
    cwd: webRoot,
    env: {
      ...process.env,
      RAFT_WEB_TEST_DOM: dom ? "1" : "0",
      RAFT_WEB_TEST_INCLUDE: JSON.stringify(includes),
    },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
