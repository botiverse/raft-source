// Delete old drizzle snapshots (packages/server/drizzle/meta/NNNN_snapshot.json)
// from this checkout. Which ones are old is scripts/ci/migration-snapshot-retention.mjs,
// the rule the open-PR parent gate applies to a PR that only deletes snapshots:
// outside the journal's newest SNAPSHOT_KEEP_NEWEST and last touched on --ref
// more than SNAPSHOT_KEEP_DAYS ago. Only a prefix is deleted (everything below
// the oldest snapshot that must stay), so the journal check sees no gap.
//
//   node --import @oxc-node/core/register scripts/dev/prune-drizzle-snapshots.ts [--write] [--ref REF]
//
// Dry run by default: prints what would go and the sizes. Both modes check
// that `drizzle-kit generate` against the kept snapshots alone (a temp copy;
// no database) reports no schema changes. --write then deletes the files and
// runs scripts/ci/check-migration-journal.sh, putting the files back from git
// if it fails. --ref (default origin/staging) is the branch whose history
// dates the snapshots; fetch it first. Commit the deletions alone, in a PR of
// their own (docs/development/migration-numbering.md, "Pruned snapshots").
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isSnapshotPrunable, SNAPSHOT_KEEP_DAYS, SNAPSHOT_KEEP_NEWEST } from "../ci/migration-snapshot-retention.mjs";

export const META_DIR = "packages/server/drizzle/meta";
const SNAPSHOT_FILE = /^(\d{4})_snapshot\.json$/;

export interface Snapshot {
  number: number;
  file: string;
  bytes: number;
}

/** `git log --format=%x00%cI --name-only` output → committer date (ms) of the
 *  newest commit touching each snapshot, by number. */
export function lastTouchedFromGitLog(log: string): Map<number, number> {
  const touched = new Map<number, number>();
  let date = Number.NaN;
  for (const line of log.split("\n")) {
    if (line.startsWith("\0")) {
      date = Date.parse(line.slice(1));
      continue;
    }
    const match = SNAPSHOT_FILE.exec(path.basename(line.trim()));
    if (match && line.trim().startsWith(`${META_DIR}/`) && Number.isFinite(date) && !touched.has(Number(match[1]))) {
      touched.set(Number(match[1]), date);
    }
  }
  return touched;
}

/** The snapshots to delete: those below the oldest present one that the
 *  retention rule keeps. */
export function selectPrunable(snapshots: Snapshot[], latest: number, touched: Map<number, number>, now: number): { prune: Snapshot[]; keep: Snapshot[] } {
  const sorted = [...snapshots].sort((a, b) => a.number - b.number);
  const firstKept = sorted.findIndex((s) => !isSnapshotPrunable({ number: s.number, latest, touchedAt: touched.get(s.number), now }));
  const cut = firstKept === -1 ? sorted.length : firstKept;
  return { prune: sorted.slice(0, cut), keep: sorted.slice(cut) };
}

export function formatSize(snapshots: Snapshot[]): string {
  const bytes = snapshots.reduce((sum, s) => sum + s.bytes, 0);
  return `${snapshots.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function run(command: string, args: string[], cwd: string): { status: number | null; output: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error) : ""}` };
}

function listSnapshots(repo: string): Snapshot[] {
  const dir = path.join(repo, META_DIR);
  return readdirSync(dir).flatMap((file) => {
    const match = SNAPSHOT_FILE.exec(file);
    return match ? [{ number: Number(match[1]), file: path.join(META_DIR, file), bytes: statSync(path.join(dir, file)).size }] : [];
  });
}

// `drizzle-kit generate` (as check-migrations.yml runs it, no database) on a
// copy of the migrations holding only the kept snapshots.
export function generateReportsNoChanges(repo: string, keep: Snapshot[]): { ok: boolean; output: string } {
  const server = path.join(repo, "packages/server");
  const scratch = mkdtempSync(path.join(tmpdir(), "prune-drizzle-snapshots-"));
  try {
    const out = path.join(scratch, "drizzle");
    mkdirSync(path.join(out, "meta"), { recursive: true });
    for (const file of readdirSync(path.join(server, "drizzle"))) {
      if (file.endsWith(".sql")) copyFileSync(path.join(server, "drizzle", file), path.join(out, file));
    }
    copyFileSync(path.join(server, "drizzle/meta/_journal.json"), path.join(out, "meta/_journal.json"));
    for (const s of keep) copyFileSync(path.join(repo, s.file), path.join(out, "meta", path.basename(s.file)));
    const before = readdirSync(out, { recursive: true }).length;
    // drizzle-kit reads `out` relative to the working directory.
    const config = path.join(scratch, "drizzle.config.ts");
    writeFileSync(config, `import config from ${JSON.stringify(path.join(server, "drizzle.config.ts"))};\nexport default { ...config, out: ${JSON.stringify(path.relative(server, out))} };\n`);
    const result = run(path.join(server, "node_modules/.bin/drizzle-kit"), ["generate", "--config", config], server);
    const after = readdirSync(out, { recursive: true }).length;
    return { ok: result.status === 0 && before === after && /No schema changes/.test(result.output), output: result.output };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(argv: string[]): number {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\nimport ")[0].replace(/^\/\/ ?/gm, ""));
    return 0;
  }
  const write = argv.includes("--write");
  const refAt = argv.indexOf("--ref");
  const ref = refAt === -1 ? "origin/staging" : argv[refAt + 1];
  const unknown = argv.filter((arg, i) => !["--write", "--ref"].includes(arg) && !(refAt !== -1 && i === refAt + 1));
  if (!ref || unknown.length) {
    console.error(`prune-drizzle-snapshots: unknown arguments ${unknown.join(" ")} (--help)`);
    return 64;
  }
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  if (run("git", ["rev-parse", "--is-shallow-repository"], repo).output.trim() !== "false") {
    console.error("prune-drizzle-snapshots: needs full git history to date the snapshots (not a shallow clone)");
    return 1;
  }
  const log = run("git", ["log", "--format=%x00%cI", "--name-only", ref, "--", `${META_DIR}/`], repo);
  if (log.status !== 0) {
    console.error(`prune-drizzle-snapshots: cannot read the history of ${ref}: ${log.output}`);
    return 1;
  }
  const latest = (JSON.parse(readFileSync(path.join(repo, META_DIR, "_journal.json"), "utf8")) as { entries: unknown[] }).entries.length - 1;
  const snapshots = listSnapshots(repo);
  const { prune, keep } = selectPrunable(snapshots, latest, lastTouchedFromGitLog(log.output), Date.now());
  const name = (s: Snapshot | undefined) => (s ? path.basename(s.file) : "none");
  console.log(`retention: keep the newest ${SNAPSHOT_KEEP_NEWEST} (journal ends at ${String(latest).padStart(4, "0")}) and any touched on ${ref} in the last ${SNAPSHOT_KEEP_DAYS} days`);
  console.log(`now:   ${formatSize(snapshots)}`);
  console.log(`prune: ${formatSize(prune)} (${name(prune[0])} .. ${name(prune.at(-1))})`);
  console.log(`after: ${formatSize(keep)} (from ${name(keep[0])})`);
  if (!prune.length) return 0;
  const generate = generateReportsNoChanges(repo, keep);
  if (!generate.ok) {
    console.error(`drizzle-kit generate with only the kept snapshots did not report "No schema changes":\n${generate.output}`);
    return 1;
  }
  console.log("drizzle-kit generate with only the kept snapshots: no schema changes");
  if (!write) {
    console.log("dry run; --write deletes them");
    return 0;
  }
  for (const s of prune) unlinkSync(path.join(repo, s.file));
  const check = run("bash", ["scripts/ci/check-migration-journal.sh"], repo);
  if (check.status !== 0) {
    run("git", ["checkout", "HEAD", "--", ...prune.map((s) => s.file)], repo);
    console.error(`check-migration-journal.sh failed after pruning; the files are back:\n${check.output}`);
    return 1;
  }
  console.log(check.output.trim());
  console.log(`deleted ${prune.length} snapshots; commit them alone`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
