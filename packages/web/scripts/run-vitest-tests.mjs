import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const webRoot = resolve(dirname(scriptPath), "..");
const repoRoot = resolve(webRoot, "../..");
const vitestCli = createRequire(import.meta.url).resolve("vitest/vitest.mjs");

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
  "--minWorkers",
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

const includes = testArgs.length > 0
  ? testArgs
  : [dom ? "tests/**/*.test.tsx" : "tests/**/*.test.ts"];
const missing = includes.filter((arg) => !arg.includes("*") && !existsSync(resolve(webRoot, arg)));

if (missing.length > 0) {
  console.error(
    `run-vitest-tests: these paths do not exist:\n${missing.map((item) => `  ${item}`).join("\n")}\n` +
      "Refusing to run a partial green test selection.",
  );
  process.exit(1);
}

const result = spawnSync(
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
