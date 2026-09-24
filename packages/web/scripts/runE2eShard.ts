/**
 * Run Playwright e2e specs for a specific shard, using the assignment in
 * `e2e-shard-manifest.json`. Used by the e2e CI job.
 *
 * Why this exists: Playwright's built-in `--shard=I/N` partitions by spec id,
 * which (combined with widely-varying per-spec durations across our 50 e2e
 * specs) produced an uneven distribution where e2e shard 4 became the
 * post-PR-#2192 wall-clock long pole. This wrapper groups specs into balanced
 * buckets by historical duration so each shard finishes in roughly the same
 * wall-clock time.
 *
 * Usage:
 *   tsx scripts/runE2eShard.ts <shard-index>
 * Example:
 *   tsx scripts/runE2eShard.ts 3        # run shard 3 from manifest
 *
 * Coverage safety: any `*.spec.ts` file present on disk but absent from the
 * manifest (added since the manifest was last refreshed) is distributed
 * deterministically across the currently lightest shards. This guarantees no
 * e2e silently drops out without turning shard 1 into the fallback long pole.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareTransportEvidence } from "../../../scripts/e2e/transportEvidence.js";

interface ShardSummary {
  shard: number;
  expectedDurationMs: number;
  files: string[];
}

interface ShardManifest {
  generatedAt: string;
  shardCount: number;
  totalFiles: number;
  totalDurationMsLocal?: number;
  shards: ShardSummary[];
}

export function assignOrphans(
  shards: ShardSummary[],
  orphans: string[],
  estimatedOrphanDurationMs: number,
): Map<string, number> {
  const assignment = new Map<string, number>();
  const load = shards.map((shard) => shard.expectedDurationMs);
  for (const orphan of [...orphans].sort()) {
    let target = 0;
    for (let index = 1; index < load.length; index++) {
      if (load[index] < load[target]) target = index;
    }
    load[target] += estimatedOrphanDurationMs;
    assignment.set(orphan, shards[target].shard);
  }
  return assignment;
}

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(WEB_DIR, "e2e-shard-manifest.json");
const SPECS_DIR = path.join(WEB_DIR, "tests/e2e/tests");

function toManifestPath(file: string): string {
  return file.split(path.sep).join("/");
}

async function listAllSpecFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile() && p.endsWith(".spec.ts")) {
        out.push(toManifestPath(path.relative(WEB_DIR, p)));
      }
    }
  }
  await walk(SPECS_DIR);
  return out;
}

async function main() {
  const arg = process.argv[2];
  const shardIndex = Number(arg);
  if (!Number.isInteger(shardIndex) || shardIndex < 1) {
    console.error("Usage: tsx scripts/runE2eShard.ts <shard-index>");
    process.exit(2);
  }

  const manifest: ShardManifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  if (shardIndex > manifest.shardCount) {
    console.error(`Shard ${shardIndex} out of range (manifest has ${manifest.shardCount}).`);
    process.exit(2);
  }

  const allOnDisk = new Set(await listAllSpecFiles());
  const claimed = new Set<string>();
  for (const s of manifest.shards) for (const f of s.files) claimed.add(f);
  const orphans = [...allOnDisk].filter((f) => !claimed.has(f)).sort();

  const myShard = manifest.shards.find((s) => s.shard === shardIndex)!;
  const myFiles = [...myShard.files];
  if (orphans.length > 0) {
    const totalMs =
      manifest.totalDurationMsLocal ??
      manifest.shards.reduce((sum, shard) => sum + shard.expectedDurationMs, 0);
    const totalFiles = manifest.totalFiles || manifest.shards.reduce((sum, shard) => sum + shard.files.length, 0);
    const averageFileMs = totalFiles > 0 ? Math.round(totalMs / totalFiles) : 0;
    const assignment = assignOrphans(manifest.shards, orphans, averageFileMs);
    const myOrphans = orphans.filter((file) => assignment.get(file) === shardIndex);

    if (shardIndex === 1) {
      console.log(
        `[runE2eShard] manifest is stale; ${orphans.length} spec file(s) not in manifest, distributing across shards (avg=${averageFileMs}ms/spec):`,
      );
      for (const [file, shard] of [...assignment].sort((a, b) => a[0].localeCompare(b[0]))) {
        console.log(`   shard ${shard}: ${file}`);
      }
    }
    if (myOrphans.length > 0) {
      console.log(`[runE2eShard] shard ${shardIndex} picking up ${myOrphans.length} orphan(s)`);
      myFiles.push(...myOrphans);
    }
  }

  // Drop manifest references that no longer exist on disk (renamed / deleted).
  const present = myFiles.filter((f) => allOnDisk.has(f));
  const missing = myFiles.filter((f) => !allOnDisk.has(f));
  if (missing.length > 0) {
    console.log(`[runE2eShard] manifest references ${missing.length} missing spec(s); skipping:`);
    for (const f of missing) console.log("  ", f);
  }

  console.log(
    `[runE2eShard] shard ${shardIndex}/${manifest.shardCount}: ${present.length} specs (expected ~${(myShard.expectedDurationMs / 1000).toFixed(1)}s)`,
  );

  // Playwright accepts multiple file args; explicit list bypasses its
  // internal --shard slicing entirely.
  const evidence = prepareTransportEvidence(path.join(WEB_DIR, "playwright-report", "transport"));
  if (evidence) console.log(`[e2e-transport] runId=${evidence.runId}`);
  const child = spawn("pnpm", ["exec", "playwright", "test", ...present], {
    cwd: WEB_DIR,
    env: {
      ...process.env, TZ: process.env.TZ || "Asia/Singapore",
      SLOCK_E2E_TRANSPORT_DIR: evidence?.directory ?? "",
      SLOCK_E2E_TRANSPORT_RUN_ID: evidence?.runId ?? "",
    },
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}

const isDirectInvocation = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectInvocation) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
