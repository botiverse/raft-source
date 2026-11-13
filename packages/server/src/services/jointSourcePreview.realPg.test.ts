// JOINT_SOURCE_PREVIEW_REAL_PG_URL is an ADMIN url: the test creates a random
// database, migrates into it and drops it afterwards; the url's own database is
// never written. JOINT_SOURCE_PREVIEW_REAL_PG_REQUIRED=1 fails instead of skipping.
// Exercises the standalone CLI for the read-only source modes.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { openTestDatabase, closeTestDatabase } from "../test/integration/database";
import { createSeed } from "../test/integration/seed";
import { installRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { jointSourcePreviewScenario } from "../test/jointSourcePreviewScenario";
import { jointSourceRecoveryPrefilterScenario } from "../test/jointSourceRecoveryPrefilterScenario";
import { jointSourceRunReceipt } from "../../scripts/joint-human-membership-ops";

const REAL_PG_URL_ENV = "JOINT_SOURCE_PREVIEW_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.JOINT_SOURCE_PREVIEW_REAL_PG_REQUIRED === "1";

function databaseUrlFor(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

test.skipIf(!REAL_PG_URL && !REAL_PG_REQUIRED)("joint source-preview/verify CLI on PostgreSQL: scan, digests, verify, production replica refusal", async () => {
assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
const databaseName = `slock_joint_source_preview_${process.pid}_${randomBytes(4).toString("hex")}`;
const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "joint-source-preview-admin" });
await admin.connect();
let opened = false;
try {
await admin.query(`CREATE DATABASE "${databaseName}"`);
const url = databaseUrlFor(REAL_PG_URL, databaseName);
const pool = new pg.Pool({ connectionString: url, max: 1 });
try { await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) }); }
finally { await pool.end(); }
installRisingWaveReadReferences();
const db = await openTestDatabase(url);
opened = true;
const command = fileURLToPath(new URL("../../scripts/joint-human-membership-ops.ts", import.meta.url));
const cli = (args: string[]) => spawnSync(process.execPath, ["--import", "@oxc-node/core/register", command, ...args], {
  env: { ...process.env, JOINT_MEMBERSHIP_READ_DATABASE_URL: url }, encoding: "utf8", timeout: 60_000,
});
const events = (stdout: string) => stdout.split("\n").filter(line => line.startsWith("{\"event\":")).map(line => JSON.parse(line));
try {
  await jointSourcePreviewScenario({ db, seed: createSeed(db) });
  console.log("PASS PostgreSQL source preview scenario: classification, read-only, digest, guards");
  const prefilterFixture = await jointSourceRecoveryPrefilterScenario({ db, seed: createSeed(db) });
  console.log("PASS PostgreSQL recovery prefilter: a superset of joints with occurrences; clean joints skipped");

  const first = cli(["--environment", "staging", "--mode", "source-preview", "--limit", "100"]);
  assert.equal(first.status, 0, first.stderr);
  const run = events(first.stdout), end = run.at(-1);
  const joints = run.filter(event => event.event === "joint");
  assert.ok(joints.length >= 2 && joints.every(event => event.status === "previewed" && /^[a-f0-9]{64}$/.test(event.receipt.digest)));
  assert.ok(joints.every(event => typeof event.receipt.counts.computed_ch === "number" && !("candidate" in event.receipt.counts)));
  assert.equal(end.complete, true); assert.match(end.runReceipt, /^[a-f0-9]{64}$/);
  assert.ok(!first.stdout.includes("@test.invalid"));
  const second = cli(["--environment", "staging", "--mode", "source-preview", "--limit", "100"]);
  assert.equal(events(second.stdout).at(-1).runReceipt, end.runReceipt, "run receipt is stable for an unchanged snapshot");
  console.log("PASS PostgreSQL CLI: source-preview scans active joints, emits per-J digests and a stable run receipt");

  const live = joints.flatMap(event => event.receipt.tuples.live.map((tuple: { userId: string; serverId: string; generation: number }) =>
    ({ jointId: event.jointId, userId: tuple.userId, serverId: tuple.serverId, generation: tuple.generation })));
  const dir = await mkdtemp(join(tmpdir(), "joint-source-verify-"));
  const okFile = join(dir, "live.json"), badFile = join(dir, "stale.json");
  await writeFile(okFile, JSON.stringify({ tuples: live }));
  await writeFile(badFile, JSON.stringify([{ ...live[0], generation: live[0].generation + 5 }]));
  const ok = cli(["--environment", "staging", "--mode", "source-verify", "--tuples-file", okFile]);
  assert.equal(ok.status, 0, ok.stderr); assert.equal(events(ok.stdout).at(-1).complete, true);
  const bad = cli(["--environment", "staging", "--mode", "source-verify", "--tuples-file", badFile]);
  assert.equal(bad.status, 1);
  assert.ok(events(bad.stdout).some(event => event.status === "mismatch" && event.receipt.results[0].result === "generation_changed"));
  console.log("PASS PostgreSQL CLI: source-verify checks frozen tuples one by one and fails on a mismatch");

  const capped = cli(["--environment", "staging", "--mode", "source-preview", "--limit", "100", "--evidence-row-cap", "2"]);
  assert.equal(capped.status, 1);
  const cappedEvents = events(capped.stdout), cappedEnd = cappedEvents.at(-1);
  assert.equal(cappedEnd.complete, false);
  assert.ok(cappedEnd.failures.length >= 2 && cappedEnd.failures.every((row: { category: string }) => row.category === "oversized"));
  assert.ok(!cappedEvents.some(event => event.status === "previewed"), "an oversized J is never a truncated preview");
  console.log("PASS PostgreSQL CLI: an oversized J is a failure receipt, not a truncated preview");

  const scoped = cli(["--environment", "staging", "--mode", "source-preview", "--joint-id", live[0].jointId]);
  assert.equal(scoped.status, 1); assert.match(scoped.stderr, /fresh scan/);
  for (const args of [["--mode", "source-preview"], ["--mode", "source-verify", "--tuples-file", okFile]]) {
    const production = cli(["--environment", "production", ...args]);
    assert.equal(production.status, 1); assert.match(production.stderr, /requires a read replica/);
    assert.ok(!production.stderr.includes(url));
  }
  console.log("PASS PostgreSQL CLI: source modes refuse --joint-id scoping and an actual primary in production");

  // Source recovery (#wg-rbac:#23): scan -> frozen file -> file preview -> apply -> verify.
  const writeCli = (args: string[]) => spawnSync(process.execPath, ["--import", "@oxc-node/core/register", command, ...args], {
    env: { ...process.env, JOINT_MEMBERSHIP_READ_DATABASE_URL: url, JOINT_MEMBERSHIP_WRITE_DATABASE_URL: url }, encoding: "utf8", timeout: 60_000,
  });
  const scan = cli(["--environment", "staging", "--mode", "source-recovery-preview", "--limit", "100"]);
  assert.equal(scan.status, 0, scan.stderr);
  const scanEvents = events(scan.stdout), scanEnd = scanEvents.at(-1);
  const planned = scanEvents.filter(event => event.event === "joint" && event.status === "planned");
  assert.ok(planned.length >= 1 && scanEnd.summary.would_write >= 1, "the computed fixture has recoverable tuples");
  // Prefilter parity: --no-prefilter (the old behaviour) plans every joint; the
  // default scan plans the same candidates identically and skips only joints
  // whose full plan has no occurrence.
  const full = cli(["--environment", "staging", "--mode", "source-recovery-preview", "--limit", "100", "--no-prefilter"]);
  assert.equal(full.status, 0, full.stderr);
  const fullRun = events(full.stdout), fullEnd = fullRun.at(-1);
  const fullJoints = new Map(fullRun.filter(event => event.event === "joint").map(event => [event.jointId, event]));
  const scanJoints = scanEvents.filter(event => event.event === "joint");
  assert.deepEqual(scanJoints.map(event => event.jointId), [...fullJoints.keys()], "the same cursor range, in order");
  assert.equal(fullRun[0].prefilter, false); assert.equal(scanEvents[0].prefilter, true);
  assert.ok(!fullRun.some(event => event.event === "prefilter" || event.status === "skipped_no_candidate"));
  const skippedIds = scanJoints.filter(event => event.status === "skipped_no_candidate").map(event => event.jointId);
  for (const event of scanJoints) {
    const before = fullJoints.get(event.jointId)!;
    if (event.status === "skipped_no_candidate") assert.equal(before.receipt.plan.occurrences.length, 0, `skipped ${event.jointId} has occurrences`);
    else assert.deepEqual([event.status, { ...event.receipt, attempts: 0 }], [before.status, { ...before.receipt, attempts: 0 }]);
  }
  assert.ok(skippedIds.includes(prefilterFixture.ids.clean!));
  for (const key of ["r1", "r4ch", "r4inv", "r4ext"]) assert.ok(!skippedIds.includes(prefilterFixture.ids[key]!), key);
  assert.deepEqual(scanEnd.failures, fullEnd.failures); assert.deepEqual(scanEnd.summary, fullEnd.summary);
  assert.deepEqual([scanEnd.scanned, scanEnd.skipped, scanEnd.prefilterFallbacks], [scanJoints.length - skippedIds.length, skippedIds.length, 0]);
  assert.equal(scanEnd.runReceipt, jointSourceRunReceipt({ mode: "source-recovery-preview", after: null, through: scanEvents[0].through,
    joints: scanJoints.filter(event => event.status !== "skipped_no_candidate").map(event => ({ jointId: event.jointId, digest: event.receipt.planDigest })),
    failures: [], skipped: skippedIds }), "the run receipt binds the skipped ids");
  assert.equal(fullEnd.runReceipt, jointSourceRunReceipt({ mode: "source-recovery-preview", after: null, through: fullRun[0].through,
    joints: [...fullJoints.values()].map(event => ({ jointId: event.jointId, digest: event.receipt.planDigest })), failures: [] }), "--no-prefilter keeps the old receipt");
  const wide = cli(["--environment", "staging", "--mode", "source-recovery-preview", "--limit", "2000"]);
  assert.equal(wide.status, 0, wide.stderr); assert.equal(events(wide.stdout).at(-1).runReceipt, scanEnd.runReceipt);
  for (const args of [["--mode", "source-recovery-preview", "--limit", "2000", "--no-prefilter"], ["--mode", "source-recovery-preview", "--limit", "2001"],
    ["--mode", "source-preview", "--limit", "101"]]) {
    const refused = cli(["--environment", "staging", ...args]);
    assert.equal(refused.status, 1); assert.match(refused.stderr, /limit must be 1\.\.(100|2000)\b/);
  }
  const misplaced = cli(["--environment", "staging", "--mode", "source-preview", "--no-prefilter"]);
  assert.equal(misplaced.status, 1); assert.match(misplaced.stderr, /no-prefilter is only valid/);
  console.log("PASS PostgreSQL CLI: prefiltered recovery scan equals --no-prefilter for candidates, skips only zero-occurrence joints, binds skipped ids");
  const recoveryFile = join(dir, "recovery.json");
  await writeFile(recoveryFile, JSON.stringify({ format: "joint-source-recovery/v2", joints: planned.map(event => event.receipt.plan) }));
  const fileDigest = createHash("sha256").update(await readFile(recoveryFile)).digest("hex");
  const filePreview = cli(["--environment", "staging", "--mode", "source-recovery-preview", "--tuples-file", recoveryFile]);
  assert.equal(filePreview.status, 0, filePreview.stderr);
  const previewEvents = events(filePreview.stdout);
  assert.equal(previewEvents[0].tuplesFileDigest, fileDigest);
  assert.equal(previewEvents.at(-1).summary.would_write, scanEnd.summary.would_write);
  for (const args of [[], ["--run-id", "rp-1"], ["--run-id", "rp-1", "--approval-reference", "ref"]]) {
    const refused = writeCli(["--environment", "staging", "--mode", "source-recovery-apply", "--tuples-file", recoveryFile, ...args]);
    assert.equal(refused.status, 1); assert.match(refused.stderr, /run-id and --approval-reference|tuples-file-digest/);
  }
  const wrongDigest = writeCli(["--environment", "staging", "--mode", "source-recovery-apply", "--tuples-file", recoveryFile,
    "--tuples-file-digest", "0".repeat(64), "--run-id", "rp-1", "--approval-reference", "ref"]);
  assert.equal(wrongDigest.status, 1); assert.match(wrongDigest.stderr, /does not match the file/);
  const unwindowed = writeCli(["--environment", "production", "--mode", "source-recovery-apply", "--tuples-file", recoveryFile,
    "--tuples-file-digest", fileDigest, "--run-id", "rp-1", "--approval-reference", "ref"]);
  assert.equal(unwindowed.status, 1); assert.match(unwindowed.stderr, /window/);
  const productionPreview = cli(["--environment", "production", "--mode", "source-recovery-preview", "--tuples-file", recoveryFile]);
  assert.equal(productionPreview.status, 1); assert.match(productionPreview.stderr, /requires a read replica/);
  const applied = writeCli(["--environment", "staging", "--mode", "source-recovery-apply", "--tuples-file", recoveryFile,
    "--tuples-file-digest", fileDigest, "--run-id", "rp-1", "--approval-reference", "ref"]);
  assert.equal(applied.status, 0, applied.stderr);
  const appliedEvents = events(applied.stdout);
  assert.equal(appliedEvents.at(-1).summary.written, scanEnd.summary.would_write, "apply wrote what the preview said");
  const writtenTuples = appliedEvents.filter(event => event.status === "committed").flatMap(event =>
    event.receipt.receipts.admissions.map((row: { userId: string; serverId: string; generation: number }) => ({ jointId: event.jointId, ...row })));
  const writtenFile = join(dir, "written.json");
  await writeFile(writtenFile, JSON.stringify(writtenTuples.map(({ jointId, userId, serverId, generation }) => ({ jointId, userId, serverId, generation }))));
  const verified = cli(["--environment", "staging", "--mode", "source-verify", "--tuples-file", writtenFile]);
  assert.equal(verified.status, 0, verified.stderr);
  const replay = writeCli(["--environment", "staging", "--mode", "source-recovery-apply", "--tuples-file", recoveryFile,
    "--tuples-file-digest", fileDigest, "--run-id", "rp-2", "--approval-reference", "ref"]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(events(replay.stdout).at(-1).summary.written, 0, "a replay writes nothing");
  console.log("PASS PostgreSQL CLI: source recovery scan, file preview, guarded apply, verify and replay");
} finally { if (opened) await closeTestDatabase(); opened = false; }
} finally {
  if (opened) await closeTestDatabase().catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
  await admin.end();
}
}, 120_000);
