import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const daemonRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(daemonRoot, "../..");
const packageJsonPath = join(daemonRoot, "package.json");
const receiptPath = join(daemonRoot, "runtime-sdk-release-preflight.json");

const SDK_TARGETS = [
  { packageName: "@earendil-works/pi-ai", distTag: "latest" },
  { packageName: "@earendil-works/pi-coding-agent", distTag: "latest" },
  { packageName: "@botiverse/kimi-code-sdk", distTag: "botiverse" },
];

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function readRegistryVersion(packageName, distTag) {
  const raw = execFileSync("npm", ["view", `${packageName}@${distTag}`, "version", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "string" || parsed.length === 0) {
    throw new Error(`npm returned an invalid version for ${packageName}@${distTag}: ${raw}`);
  }
  return parsed;
}

function runPnpm(args) {
  execFileSync("pnpm", args, { cwd: repoRoot, stdio: "inherit" });
}

function writeReceipt({ decision, reason, rows, selectedVersions }) {
  const receipt = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    daemonVersionBeforeBranchCut: pkg.version,
    decision,
    reason,
    packages: rows.map((row) => ({
      packageName: row.packageName,
      distTag: row.distTag,
      pinned: row.pinned,
      registry: row.registry,
      selected: selectedVersions[row.packageName],
    })),
  };
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`Wrote auditable release preflight receipt: ${receiptPath}`);
}

const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const rows = SDK_TARGETS.map((target) => {
  const pinned = pkg.dependencies?.[target.packageName];
  if (typeof pinned !== "string" || pinned.length === 0) {
    throw new Error(`packages/daemon/package.json must pin ${target.packageName}`);
  }
  if (/^[~^<>=*]/.test(pinned)) {
    throw new Error(`${target.packageName} must use an exact pin, found ${pinned}`);
  }
  return { ...target, pinned, registry: readRegistryVersion(target.packageName, target.distTag) };
});

console.log("Daemon runtime SDK release preflight (pinned vs registry dist-tag):");
for (const row of rows) {
  const state = row.pinned === row.registry ? "current" : "OUTDATED";
  console.log(`- ${row.packageName}: pinned=${row.pinned} ${row.distTag}=${row.registry} [${state}]`);
}

const decision = readFlag("--decision") ?? process.env.RAFT_RUNTIME_SDK_DECISION;
const holdReason = readFlag("--reason") ?? process.env.RAFT_RUNTIME_SDK_HOLD_REASON;
if (decision !== "bump" && decision !== "hold") {
  throw new Error(
    "Release owner decision required before branch cut: set RAFT_RUNTIME_SDK_DECISION=bump, " +
      "or RAFT_RUNTIME_SDK_DECISION=hold with RAFT_RUNTIME_SDK_HOLD_REASON. " +
      "For a standalone check, pass --decision bump|hold [--reason ...].",
  );
}

if (decision === "hold") {
  if (typeof holdReason !== "string" || holdReason.trim().length === 0) {
    throw new Error("RAFT_RUNTIME_SDK_HOLD_REASON (or --reason) is required for an explicit hold decision");
  }
  const reason = holdReason.trim();
  writeReceipt({
    decision: "hold",
    reason,
    rows,
    selectedVersions: Object.fromEntries(rows.map((row) => [row.packageName, row.pinned])),
  });
  console.log(`SDK decision: HOLD — ${reason}`);
  process.exit(0);
}

const changed = rows.filter((row) => row.pinned !== row.registry);
if (changed.length === 0) {
  writeReceipt({
    decision: "bump",
    reason: "All tracked runtime SDK pins were already current.",
    rows,
    selectedVersions: Object.fromEntries(rows.map((row) => [row.packageName, row.pinned])),
  });
  console.log("SDK decision: BUMP — all tracked SDK pins are already current; no files changed.");
  process.exit(0);
}

for (const row of changed) {
  pkg.dependencies[row.packageName] = row.registry;
}
writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);

runPnpm(["install", "--no-frozen-lockfile"]);
runPnpm(["--filter", "@botiverse/raft-daemon", "generate:pi-builtin-models"]);
runPnpm(["--filter", "@botiverse/raft-shared", "generate:runtime-provider-display-names"]);

writeReceipt({
  decision: "bump",
  reason: "Updated every tracked runtime SDK that differed from its registry dist-tag.",
  rows,
  selectedVersions: Object.fromEntries(rows.map((row) => [row.packageName, row.registry])),
});

console.log("SDK decision: BUMP — updated exact pins, lockfile, Pi builtin models, and provider display names.");
console.log("Review and commit these branch-cut changes before freezing a carrier or creating a tag.");
