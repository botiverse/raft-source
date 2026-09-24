// RFC 057 phase A+B teeth (real PostgreSQL, opt-in gate; wired as a required
// Hosted PG17 job in test.yml).
//
// The migration runs under the ordinary migration identity (no custom database
// roles / identity gate — owner decision 2026-07-31). These teeth exercise the
// CORE widen behavior: NOWAIT per-table conflict with a failure-latency bound
// and zero-partial-state; a structurally closed S8 tail plus deterministic
// wait/recovery receipts and an isolated PostgreSQL timeout calibration;
// INSERT+UPDATE mirror positives x3 incl. the int4 cap;
// the delete-trigger knife; ledger singleton/CAS/audit with the session_user
// actor; the phase-conditional 22003 tooth; the legacy hazard reproduction
// (labeled NOT historical attribution); and the phase-B backfill keyset
// continuation, single-snapshot convergence, idempotency, seeded-divergence
// positive control, wrong-phase refusal through the real job entry, and the
// mid-run phase-flip fail-closed tooth.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import {
  WIDEN_BACKFILL_TABLES,
  convergenceReport,
  readWidenPhase,
  runReadCursorWidenBackfill,
} from "../services/readCursorWidenBackfill.js";

const REAL_PG_URL_ENV = "READ_CURSOR_WIDEN_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.READ_CURSOR_WIDEN_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const WIDEN_TAG = "0215_rfc057_widen_shadow";
const WIDEN_SQL_PATH = path.join(MIGRATIONS_FOLDER, `${WIDEN_TAG}.sql`);
const S8_LOCK_SQL =
  'LOCK TABLE "user_channel_read_cursors", "agent_channel_read_cursors", "read_mutations" IN ACCESS EXCLUSIVE MODE NOWAIT;';
const S8_GATE_SEQUENCE = "widen_test_s8_gate_seq";
const S8_PROBE_READY_SEQUENCE = "widen_test_s8_probe_ready_seq";
const S8_PHASE_NOTICE_PREFIX = "read_cursor_widen_s8_phase";
const S8_HARNESS_TIMEOUT_MS = 10_000;
const S8_CALIBRATION_LOCK_TIMEOUT_MS = 250;

const skip = !(REAL_PG_URL || REAL_PG_REQUIRED);

function errChainText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  while (cur && typeof cur === "object") {
    const e = cur as { message?: string; cause?: unknown };
    if (e.message) parts.push(e.message);
    cur = e.cause;
  }
  return parts.join(" | ");
}

function errChainHasCode(err: unknown, code: string): boolean {
  let cur: unknown = err;
  while (cur && typeof cur === "object") {
    const e = cur as { code?: unknown; cause?: unknown };
    if (String(e.code ?? "") === code) return true;
    cur = e.cause;
  }
  return false;
}

function databaseUrlFor(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

function normalizeSql(statement: string): string {
  return statement
    .replace(/^\s*--.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function s8TailStatements(): string[] {
  const migration = readFileSync(WIDEN_SQL_PATH, "utf8");
  const lockStart = migration.indexOf(S8_LOCK_SQL);
  assert.ok(lockStart >= 0, "0215 must contain the single S8 hot-table LOCK TABLE statement");
  return migration
    .slice(lockStart)
    .split(/-->\s*statement-breakpoint/)
    .map(normalizeSql)
    .filter(Boolean);
}

/**
 * Copy the real migration and append a test-only, non-transactional sequence
 * tick to the same S8 statement segment. The tick becomes visible immediately
 * after PostgreSQL grants all three AX locks, before the migrator receives the
 * S8 result or schedules its next tx.execute call.
 */
function instrumentS8Migration(migration: string, gapMs: number): string {
  assert.ok(Number.isInteger(gapMs) && gapMs >= 0, "S8 test gap must be a non-negative integer");
  assert.equal(
    migration.split(S8_LOCK_SQL).length - 1,
    1,
    "0215 must contain exactly one S8 hot-table LOCK statement",
  );
  const gapSql = gapMs > 0 ? `\nSELECT pg_sleep(${gapMs / 1000});` : "";
  return migration.replace(
    S8_LOCK_SQL,
    `SET LOCAL statement_timeout = '${S8_HARNESS_TIMEOUT_MS}ms';
${S8_LOCK_SQL}
DO $widen_test_s8_tick$
DECLARE tick_at_ms bigint;
BEGIN
  tick_at_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  PERFORM nextval('${S8_GATE_SEQUENCE}'::regclass);
  RAISE NOTICE '${S8_PHASE_NOTICE_PREFIX} phase=s8_tick at_ms=% pid=%',
    tick_at_ms,
    pg_backend_pid();
END;
$widen_test_s8_tick$;${gapSql}`,
  );
}

function makeS8InstrumentedFolder(gapMs = 0): string {
  const dir = mkdtempSync(path.join(tmpdir(), "widen-s8-instrumented-"));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const sqlPath = path.join(dir, `${WIDEN_TAG}.sql`);
  const migration = readFileSync(sqlPath, "utf8");
  const instrumented = instrumentS8Migration(migration, gapMs);
  writeFileSync(sqlPath, instrumented);
  return dir;
}

/** Copy the migrations folder, trimming the journal to everything before 0215. */
function makePre0215Folder(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "widen-pre0215-"));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const idx = journal.entries.findIndex((e) => e.tag === WIDEN_TAG);
  assert.ok(idx > 0, `journal must contain ${WIDEN_TAG}`);
  journal.entries = journal.entries.slice(0, idx);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return dir;
}

interface Scenario {
  databaseName: string;
  pool: pg.Pool;
  cleanup: () => Promise<void>;
}

function quietPool(url: string, name: string, max = 6): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, application_name: name, max });
  // DROP DATABASE ... WITH (FORCE) in cleanup races socket close; an unhandled
  // 'error' event would surface as an uncaughtException on an unrelated test.
  pool.on("error", () => {});
  return pool;
}

/** Fresh database migrated to 0214 (one row of "history" seedable before 0215). */
async function openScenario(): Promise<Scenario> {
  assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
  const databaseName = `slock_widen_${process.pid}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "widen-admin" });
  admin.on("error", () => {});
  await admin.connect();
  await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  const url = databaseUrlFor(REAL_PG_URL, databaseName);
  const pool = quietPool(url, "widen-test", 6);
  const pre0215Folder = makePre0215Folder();
  try {
    await migrate(drizzle(pool), { migrationsFolder: pre0215Folder });
  } finally {
    rmSync(pre0215Folder, { recursive: true, force: true });
  }
  const cleanup = async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end().catch(() => {});
  };
  return { databaseName, pool, cleanup };
}

/** Apply exactly 0215. */
async function apply0215(
  sc: Scenario,
  migrationsFolder = MIGRATIONS_FOLDER,
): Promise<{ startedAt: number; endedAt: number }> {
  const startedAt = Date.now();
  await migrate(drizzle(sc.pool), { migrationsFolder });
  return { startedAt, endedAt: Date.now() };
}

interface SeededIds {
  userId: string;
  agentId: string;
  channelIds: string[];
  serverId: string;
}

/** Seed the FK graph plus `cursorRows` rows per target table (pre-0215 = NULL-shadow history). */
async function seedHistoricalRows(pool: pg.Pool, cursorRows = 1): Promise<SeededIds> {
  const userId = randomUUID();
  const agentId = randomUUID();
  const serverId = randomUUID();
  const suffix = randomBytes(4).toString("hex");
  await pool.query(
    `INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'x')`,
    [userId, `widen-${suffix}@example.test`, `widen-${suffix}`],
  );
  await pool.query(
    `INSERT INTO servers (id, name, slug, owner_id) VALUES ($1, 'widen', $2, $3)`,
    [serverId, `widen-${suffix}`, userId],
  );
  await pool.query(
    `INSERT INTO agents (id, server_id, name) VALUES ($1, $2, $3)`,
    [agentId, serverId, `widen-agent-${suffix}`],
  );
  const channelIds: string[] = [];
  for (let i = 0; i < cursorRows; i += 1) {
    const channelId = randomUUID();
    channelIds.push(channelId);
    await pool.query(
      `INSERT INTO channels (id, server_id, name) VALUES ($1, $2, $3)`,
      [channelId, serverId, `widen-chan-${i}`],
    );
    await pool.query(
      `INSERT INTO user_channel_read_cursors (user_id, channel_id, last_read_seq) VALUES ($1, $2, $3)`,
      [userId, channelId, 41 + i],
    );
    await pool.query(
      `INSERT INTO agent_channel_read_cursors (agent_id, channel_id, last_read_seq) VALUES ($1, $2, $3)`,
      [agentId, channelId, 141 + i],
    );
    await pool.query(
      `INSERT INTO read_mutations (server_id, principal_type, principal_id, mutation_id, payload_hash, authority_seq, kind, scope_id, requested_through_seq)
       VALUES ($1, 'human', $2, $3, 'hash', $4, 'row_read', $5, $6)`,
      [serverId, userId, randomUUID(), i + 1, channelId, 241 + i],
    );
  }
  return { userId, agentId, channelIds, serverId };
}

async function assertNoPartial0215State(pool: pg.Pool): Promise<void> {
  const tables = await pool.query(
    `SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('read_cursor_widen_phase', 'read_cursor_widen_phase_audit')`,
  );
  assert.equal(tables.rows[0].n, 0, "no phase/audit tables may survive a failed 0215");
  const fns = await pool.query(
    `SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'read_cursor_%'`,
  );
  assert.equal(fns.rows[0].n, 0, "no widen functions may survive");
  const cols = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.columns WHERE column_name IN ('last_read_seq8', 'requested_through_seq8')`,
  );
  assert.equal(cols.rows[0].n, 0, "no shadow columns may survive");
}

async function transition(
  pool: pg.Pool,
  expectedPhase: string,
  expectedEpoch: number,
  nextPhase: string,
  note?: string,
): Promise<void> {
  await pool.query(
    `SELECT public.read_cursor_widen_transition($1, $2, $3, $4)`,
    [expectedPhase, expectedEpoch, nextPhase, note ?? null],
  );
}

test("RFC057 A: positive control — 0215 applies; INSERT+UPDATE mirror x3; cap exact; ledger seeded", { skip }, async () => {
  const sc = await openScenario();
  try {
    const seeded = await seedHistoricalRows(sc.pool);
    await apply0215(sc);

    const hist = await sc.pool.query(
      `SELECT last_read_seq8 FROM user_channel_read_cursors WHERE user_id = $1`, [seeded.userId],
    );
    assert.equal(hist.rows[0].last_read_seq8, null, "pre-0215 rows are NULL history");

    await sc.pool.query(`UPDATE user_channel_read_cursors SET last_read_seq = 51 WHERE user_id = $1`, [seeded.userId]);
    await sc.pool.query(`UPDATE agent_channel_read_cursors SET last_read_seq = 52 WHERE agent_id = $1`, [seeded.agentId]);
    await sc.pool.query(`UPDATE read_mutations SET requested_through_seq = 53 WHERE server_id = $1`, [seeded.serverId]);
    for (const [table, col8, expected] of [
      ["user_channel_read_cursors", "last_read_seq8", "51"],
      ["agent_channel_read_cursors", "last_read_seq8", "52"],
      ["read_mutations", "requested_through_seq8", "53"],
    ] as const) {
      const r = await sc.pool.query(`SELECT ${col8}::text AS v FROM ${table} LIMIT 1`);
      assert.equal(r.rows[0].v, expected, `${table} UPDATE mirror`);
    }

    const newChannel = randomUUID();
    await sc.pool.query(`INSERT INTO channels (id, server_id, name) VALUES ($1, $2, 'widen-post')`, [newChannel, seeded.serverId]);
    await sc.pool.query(
      `INSERT INTO user_channel_read_cursors (user_id, channel_id, last_read_seq) VALUES ($1, $2, 61)`,
      [seeded.userId, newChannel],
    );
    await sc.pool.query(
      `INSERT INTO agent_channel_read_cursors (agent_id, channel_id, last_read_seq) VALUES ($1, $2, 62)`,
      [seeded.agentId, newChannel],
    );
    await sc.pool.query(
      `INSERT INTO read_mutations (server_id, principal_type, principal_id, mutation_id, payload_hash, authority_seq, kind, scope_id, requested_through_seq)
       VALUES ($1, 'human', $2, $3, 'hash', 99, 'row_read', $4, 63)`,
      [seeded.serverId, seeded.userId, randomUUID(), newChannel],
    );
    for (const [table, col8, col4, expected] of [
      ["user_channel_read_cursors", "last_read_seq8", "last_read_seq", "61"],
      ["agent_channel_read_cursors", "last_read_seq8", "last_read_seq", "62"],
      ["read_mutations", "requested_through_seq8", "requested_through_seq", "63"],
    ] as const) {
      const r = await sc.pool.query(
        `SELECT ${col8}::text AS v FROM ${table} WHERE ${col4} = ${expected} LIMIT 1`,
      );
      assert.equal(r.rows[0]?.v, expected, `${table} INSERT mirror`);
    }

    await sc.pool.query(
      `UPDATE user_channel_read_cursors SET last_read_seq = 2147483647 WHERE user_id = $1 AND channel_id = $2`,
      [seeded.userId, newChannel],
    );
    const cap = await sc.pool.query(
      `SELECT last_read_seq8::text AS v FROM user_channel_read_cursors WHERE user_id = $1 AND channel_id = $2`,
      [seeded.userId, newChannel],
    );
    assert.equal(cap.rows[0].v, "2147483647", "cap value mirrors exactly");

    const phase = await readWidenPhase(sc.pool);
    assert.deepEqual(phase, { phase: "shadow_widen", epoch: 1 });
    const audit = await sc.pool.query(`SELECT count(*)::int AS n FROM read_cursor_widen_phase_audit`);
    assert.equal(audit.rows[0].n, 1, "audit seeded exactly once");
  } finally {
    await sc.cleanup();
  }
});

test("RFC057 A: phase-conditional 22003 — int4 authority still caps in shadow_widen", { skip }, async () => {
  const sc = await openScenario();
  try {
    const seeded = await seedHistoricalRows(sc.pool);
    await apply0215(sc);
    await assert.rejects(
      sc.pool.query(
        `UPDATE user_channel_read_cursors SET last_read_seq = 2147483648 WHERE user_id = $1`, [seeded.userId],
      ),
      (err: { code?: string }) => err.code === "22003",
    );
  } finally {
    await sc.cleanup();
  }
});

test("RFC057 A: per-table NOWAIT conflict teeth x3 — 55P03 within the NOWAIT latency bound, zero partial state, instant probes", { skip }, async () => {
  for (const holdTable of [
    "user_channel_read_cursors",
    "agent_channel_read_cursors",
    "read_mutations",
  ]) {
    const sc = await openScenario();
    try {
      await seedHistoricalRows(sc.pool);
      const holder = await sc.pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(`SELECT * FROM ${quoteIdentifier(holdTable)} LIMIT 1`);

        const t0 = Date.now();
        await assert.rejects(
          apply0215(sc),
          (err: unknown) => errChainText(err).includes("55P03") ||
            String((err as { cause?: { code?: string } }).cause?.code) === "55P03" ||
            String((err as { code?: string }).code) === "55P03",
          `${holdTable}: NOWAIT pre-lock must fail with 55P03`,
        );
        const failureLatency = Date.now() - t0;
        assert.ok(failureLatency < 500, `${holdTable}: failure took ${failureLatency}ms — NOWAIT must not wait`);

        for (const probeTable of [
          "user_channel_read_cursors",
          "agent_channel_read_cursors",
          "read_mutations",
        ]) {
          const p0 = Date.now();
          await sc.pool.query(`SELECT count(*) FROM ${quoteIdentifier(probeTable)}`);
          assert.ok(Date.now() - p0 < 1000, `probe on ${probeTable} stalled`);
        }
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
      }
      await assertNoPartial0215State(sc.pool);
    } finally {
      await sc.cleanup();
    }
  }
});

test("RFC057 A: S8 hot-lock tail is exactly one lock plus six metadata-only statements", () => {
  assert.deepEqual(s8TailStatements(), [
    'LOCK TABLE "user_channel_read_cursors", "agent_channel_read_cursors", "read_mutations" IN ACCESS EXCLUSIVE MODE NOWAIT;',
    'ALTER TABLE "user_channel_read_cursors" ADD COLUMN "last_read_seq8" bigint;',
    'CREATE TRIGGER "read_cursor_mirror_user_trg" BEFORE INSERT OR UPDATE ON "user_channel_read_cursors" FOR EACH ROW EXECUTE FUNCTION public.read_cursor_mirror_user_fn();',
    'ALTER TABLE "agent_channel_read_cursors" ADD COLUMN "last_read_seq8" bigint;',
    'CREATE TRIGGER "read_cursor_mirror_agent_trg" BEFORE INSERT OR UPDATE ON "agent_channel_read_cursors" FOR EACH ROW EXECUTE FUNCTION public.read_cursor_mirror_agent_fn();',
    'ALTER TABLE "read_mutations" ADD COLUMN "requested_through_seq8" bigint;',
    'CREATE TRIGGER "read_cursor_mirror_mutation_trg" BEFORE INSERT OR UPDATE ON "read_mutations" FOR EACH ROW EXECUTE FUNCTION public.read_cursor_mirror_mutation_fn();',
  ]);
});

test("RFC057 A: test-copy S8 tick stays once in the lock statement segment before metadata DDL", () => {
  const instrumented = instrumentS8Migration(readFileSync(WIDEN_SQL_PATH, "utf8"), 0);
  const tickSql = `PERFORM nextval('${S8_GATE_SEQUENCE}'::regclass);`;
  const tickNotice = `${S8_PHASE_NOTICE_PREFIX} phase=s8_tick`;
  const firstMetadataDdl = 'ALTER TABLE "user_channel_read_cursors" ADD COLUMN "last_read_seq8" bigint;';
  assert.equal(instrumented.split(S8_LOCK_SQL).length - 1, 1, "S8 lock must remain unique");
  assert.equal(instrumented.split(tickSql).length - 1, 1, "S8 sequence tick must be unique");
  assert.equal(instrumented.split(tickNotice).length - 1, 1, "S8 server receipt must be unique");

  const lockAt = instrumented.indexOf(S8_LOCK_SQL);
  const tickAt = instrumented.indexOf(tickSql);
  const noticeAt = instrumented.indexOf(tickNotice);
  const s8SegmentEnd = instrumented.indexOf("--> statement-breakpoint", lockAt);
  const firstMetadataDdlAt = instrumented.indexOf(firstMetadataDdl);
  assert.ok(
    lockAt < tickAt
      && tickAt < noticeAt
      && noticeAt < s8SegmentEnd
      && s8SegmentEnd < firstMetadataDdlAt,
    "S8 lock/tick/receipt must share one statement segment before the first metadata DDL",
  );
});

type Captured<T> = { ok: true; value: T } | { ok: false; error: unknown };

type S8BackendPhase = "s8_tick" | "s9_arrival" | "reader_lock_released" | "writer_lock_released";

interface S8BackendPhaseNotice {
  kind: "backend_phase";
  phase: S8BackendPhase;
  atMs: number;
  pid: number;
}

interface S8ProbesWaitingNotice {
  kind: "probes_waiting";
  atMs: number;
  observerPid: number;
  readerPid: number;
  writerPid: number;
}

type S8PhaseNotice = S8BackendPhaseNotice | S8ProbesWaitingNotice;

function parsePositiveInteger(value: string, field: string, message: string): number {
  const parsed = Number(value);
  assert.ok(Number.isSafeInteger(parsed) && parsed > 0, `invalid ${field}: ${message}`);
  return parsed;
}

function parseS8PhaseNotice(message: string): S8PhaseNotice | null {
  const backendMatch = message.match(
    new RegExp(`^${S8_PHASE_NOTICE_PREFIX} phase=(s8_tick|s9_arrival|reader_lock_released|writer_lock_released) at_ms=(\\d+) pid=(\\d+)$`),
  );
  if (backendMatch) {
    return {
      kind: "backend_phase",
      phase: backendMatch[1] as S8BackendPhase,
      atMs: parsePositiveInteger(backendMatch[2], "S8 phase timestamp", message),
      pid: parsePositiveInteger(backendMatch[3], "S8 phase backend pid", message),
    };
  }

  const waitingMatch = message.match(
    new RegExp(`^${S8_PHASE_NOTICE_PREFIX} phase=probes_waiting at_ms=(\\d+) observer_pid=(\\d+) reader_pid=(\\d+) writer_pid=(\\d+)$`),
  );
  if (!waitingMatch) return null;
  return {
    kind: "probes_waiting",
    atMs: parsePositiveInteger(waitingMatch[1], "probe-wait timestamp", message),
    observerPid: parsePositiveInteger(waitingMatch[2], "probe-wait observer pid", message),
    readerPid: parsePositiveInteger(waitingMatch[3], "waiting reader pid", message),
    writerPid: parsePositiveInteger(waitingMatch[4], "waiting writer pid", message),
  };
}

function uniqueS8BackendPhase(receipts: S8PhaseNotice[], phase: S8BackendPhase): S8BackendPhaseNotice | null {
  const matches = receipts.filter(
    (receipt): receipt is S8BackendPhaseNotice => receipt.kind === "backend_phase" && receipt.phase === phase,
  );
  assert.ok(matches.length <= 1, `expected at most one ${phase} receipt, got ${matches.length}`);
  return matches[0] ?? null;
}

interface S8PhaseReport {
  s8TickAtMs: number;
  s9ArrivalAtMs: number;
  readerLockReleasedAtMs: number | null;
  writerLockReleasedAtMs: number | null;
  probesWaitingAtMs: number;
  probeWaitObserverPid: number;
  migrationBackendPid: number;
  readerBackendPid: number | null;
  writerBackendPid: number | null;
  s8ToS9Ms: number;
  s9ToReaderReleaseMs: number | null;
  s9ToWriterReleaseMs: number | null;
  s8ToReaderReleaseMs: number | null;
  s8ToWriterReleaseMs: number | null;
}

function buildS8PhaseReport(
  receipts: S8PhaseNotice[],
  expected: { observerPid: number; readerPid: number; writerPid: number },
): S8PhaseReport {
  const s8TickAtMs = uniqueS8BackendPhase(receipts, "s8_tick");
  const s9ArrivalAtMs = uniqueS8BackendPhase(receipts, "s9_arrival");
  const readerLockReleasedAtMs = uniqueS8BackendPhase(receipts, "reader_lock_released");
  const writerLockReleasedAtMs = uniqueS8BackendPhase(receipts, "writer_lock_released");
  const waitingReceipts = receipts.filter(
    (receipt): receipt is S8ProbesWaitingNotice => receipt.kind === "probes_waiting",
  );
  assert.ok(s8TickAtMs !== null, "missing server-side S8 tick phase receipt");
  assert.ok(s9ArrivalAtMs !== null, "missing server-side S9 arrival phase receipt");
  assert.equal(waitingReceipts.length, 1, `expected exactly one probes-waiting receipt, got ${waitingReceipts.length}`);
  const probesWaiting = waitingReceipts[0];
  assert.equal(probesWaiting.observerPid, expected.observerPid, "probe-wait receipt came from the wrong observer backend");
  assert.equal(probesWaiting.readerPid, expected.readerPid, "probe-wait receipt named the wrong reader backend");
  assert.equal(probesWaiting.writerPid, expected.writerPid, "probe-wait receipt named the wrong writer backend");
  assert.notEqual(probesWaiting.readerPid, probesWaiting.writerPid, "reader and writer must be distinct waiting backends");
  assert.equal(
    s9ArrivalAtMs.pid,
    s8TickAtMs.pid,
    "S8 tick and S9 arrival must come from the same migration backend",
  );
  assert.ok(s9ArrivalAtMs.atMs >= s8TickAtMs.atMs, "S9 receipt must not precede S8 tick");
  assert.ok(probesWaiting.atMs >= s8TickAtMs.atMs, "probe-wait receipt must not precede S8 tick");
  assert.equal(
    readerLockReleasedAtMs === null,
    writerLockReleasedAtMs === null,
    "reader and writer must agree whether commit released their table locks",
  );
  if (readerLockReleasedAtMs !== null && writerLockReleasedAtMs !== null) {
    assert.equal(readerLockReleasedAtMs.pid, expected.readerPid, "release receipt came from the wrong reader backend");
    assert.equal(writerLockReleasedAtMs.pid, expected.writerPid, "release receipt came from the wrong writer backend");
    assert.ok(readerLockReleasedAtMs.atMs >= s9ArrivalAtMs.atMs, "reader lock release must not precede S9 arrival");
    assert.ok(writerLockReleasedAtMs.atMs >= s9ArrivalAtMs.atMs, "writer lock release must not precede S9 arrival");
    assert.ok(readerLockReleasedAtMs.atMs >= probesWaiting.atMs, "reader release must follow observed lock wait");
    assert.ok(writerLockReleasedAtMs.atMs >= probesWaiting.atMs, "writer release must follow observed lock wait");
  }

  return {
    s8TickAtMs: s8TickAtMs.atMs,
    s9ArrivalAtMs: s9ArrivalAtMs.atMs,
    readerLockReleasedAtMs: readerLockReleasedAtMs?.atMs ?? null,
    writerLockReleasedAtMs: writerLockReleasedAtMs?.atMs ?? null,
    probesWaitingAtMs: probesWaiting.atMs,
    probeWaitObserverPid: probesWaiting.observerPid,
    migrationBackendPid: s8TickAtMs.pid,
    readerBackendPid: readerLockReleasedAtMs?.pid ?? null,
    writerBackendPid: writerLockReleasedAtMs?.pid ?? null,
    s8ToS9Ms: s9ArrivalAtMs.atMs - s8TickAtMs.atMs,
    s9ToReaderReleaseMs:
      readerLockReleasedAtMs === null ? null : readerLockReleasedAtMs.atMs - s9ArrivalAtMs.atMs,
    s9ToWriterReleaseMs:
      writerLockReleasedAtMs === null ? null : writerLockReleasedAtMs.atMs - s9ArrivalAtMs.atMs,
    s8ToReaderReleaseMs:
      readerLockReleasedAtMs === null ? null : readerLockReleasedAtMs.atMs - s8TickAtMs.atMs,
    s8ToWriterReleaseMs:
      writerLockReleasedAtMs === null ? null : writerLockReleasedAtMs.atMs - s8TickAtMs.atMs,
  };
}

async function capture<T>(promise: Promise<T>): Promise<Captured<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function isLockTimeout(error: unknown): boolean {
  return errChainHasCode(error, "55P03") || errChainText(error).includes("55P03");
}

function isStatementTimeout(error: unknown): boolean {
  return errChainHasCode(error, "57014")
    && errChainText(error).includes("statement timeout");
}

function capturedFailure(label: string, error: unknown): string {
  return isStatementTimeout(error)
    ? `HARNESS_TIMEOUT: ${label} exceeded the ${S8_HARNESS_TIMEOUT_MS}ms fixture watchdog`
    : errChainText(error);
}

async function runS8WindowScenario(gapMs: number, probeLockTimeoutMs: number | null): Promise<{
  applied: Captured<{ startedAt: number; endedAt: number }>;
  read: Captured<pg.QueryResult>;
  write: Captured<pg.QueryResult>;
  phase: S8PhaseReport;
}> {
  assert.ok(
    probeLockTimeoutMs === null || (Number.isInteger(probeLockTimeoutMs) && probeLockTimeoutMs > 0),
    "probe lock timeout must be null or a positive integer",
  );
  const probeLockTimeoutSetting = probeLockTimeoutMs === null ? "0" : `${probeLockTimeoutMs}ms`;
  const sc = await openScenario();
  const url = databaseUrlFor(REAL_PG_URL!, sc.databaseName);
  const hookHolder = new pg.Client({ connectionString: url, application_name: "widen-s8-hook-holder" });
  const reader = new pg.Client({ connectionString: url, application_name: "widen-s8-reader" });
  const writer = new pg.Client({ connectionString: url, application_name: "widen-s8-writer" });
  for (const client of [hookHolder, reader, writer]) client.on("error", () => {});

  const hookKey = randomBytes(4).readUInt32BE(0);
  const migrationsFolder = makeS8InstrumentedFolder(gapMs);
  const phaseNotices: S8PhaseNotice[] = [];
  const onPhaseNotice = (notice: { message?: string }) => {
    if (!notice.message) return;
    const parsed = parseS8PhaseNotice(notice.message);
    if (parsed) phaseNotices.push(parsed);
  };
  let hookHeld = false;
  try {
    const seeded = await seedHistoricalRows(sc.pool);
    await Promise.all([hookHolder.connect(), reader.connect(), writer.connect()]);
    hookHolder.on("notice", onPhaseNotice);
    await sc.pool.query(`CREATE SEQUENCE ${S8_GATE_SEQUENCE}; CREATE SEQUENCE ${S8_PROBE_READY_SEQUENCE}`);
    await sc.pool.query(`
      CREATE FUNCTION widen_test_wait_for_s8_gate() RETURNS void LANGUAGE plpgsql AS $$
      DECLARE gate_open boolean;
      BEGIN
        PERFORM nextval('${S8_PROBE_READY_SEQUENCE}'::regclass);
        LOOP
          SELECT is_called INTO gate_open FROM ${S8_GATE_SEQUENCE};
          EXIT WHEN gate_open;
          PERFORM pg_sleep(0.0005);
        END LOOP;
        PERFORM set_config('lock_timeout', '${probeLockTimeoutSetting}', true);
      END;
      $$;

      CREATE FUNCTION widen_test_s8_read(p_user_id uuid) RETURNS integer LANGUAGE plpgsql AS $$
      DECLARE result integer;
      BEGIN
        PERFORM widen_test_wait_for_s8_gate();
        SELECT last_read_seq INTO STRICT result
          FROM user_channel_read_cursors
         WHERE user_id = p_user_id;
        RAISE NOTICE '${S8_PHASE_NOTICE_PREFIX} phase=reader_lock_released at_ms=% pid=%',
          floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
          pg_backend_pid();
        RETURN result;
      END;
      $$;

      CREATE FUNCTION widen_test_s8_write(p_server_id uuid) RETURNS integer LANGUAGE plpgsql AS $$
      DECLARE result integer;
      BEGIN
        PERFORM widen_test_wait_for_s8_gate();
        UPDATE read_mutations
           SET updated_at = now()
         WHERE server_id = p_server_id
         RETURNING requested_through_seq INTO STRICT result;
        RAISE NOTICE '${S8_PHASE_NOTICE_PREFIX} phase=writer_lock_released at_ms=% pid=%',
          floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
          pg_backend_pid();
        RETURN result;
      END;
      $$;
    `);

    // S9 remains a test-only finishing barrier. It guarantees the migration
    // keeps S8's locks long enough for both probes to queue. The clean journey
    // has no lock-timeout oracle; only the separate 300ms calibration enables
    // PostgreSQL's 250ms lock_timeout.
    await sc.pool.query(`
      CREATE FUNCTION widen_test_pause_after_s8() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF tg_tag = 'ALTER TABLE'
           AND current_query() LIKE '%user_channel_read_cursors%'
           AND current_query() LIKE '%ADD COLUMN%last_read_seq8%' THEN
          RAISE NOTICE '${S8_PHASE_NOTICE_PREFIX} phase=s9_arrival at_ms=% pid=%',
            floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
            pg_backend_pid();
          PERFORM set_config('lock_timeout', '0', true);
          PERFORM pg_advisory_xact_lock(${hookKey});
        END IF;
      END;
      $$;
    `);
    await sc.pool.query(
      `CREATE EVENT TRIGGER widen_test_pause_after_s8_trg ON ddl_command_start EXECUTE FUNCTION widen_test_pause_after_s8()`,
    );
    await hookHolder.query(`SELECT pg_advisory_lock($1::bigint)`, [hookKey]);
    hookHeld = true;

    const relids = await sc.pool.query(
      `SELECT oid::int FROM pg_class WHERE relname IN ('user_channel_read_cursors', 'agent_channel_read_cursors', 'read_mutations') AND relnamespace = 'public'::regnamespace ORDER BY relname`,
    );
    const oids = (relids.rows as Array<{ oid: number }>).map((r) => r.oid);
    assert.equal(oids.length, 3);
    assert.ok(oids.every(Number.isInteger));

    const hookHolderPid = Number(
      (await hookHolder.query(`SELECT pg_backend_pid()::int AS pid`)).rows[0].pid,
    );
    const readerPid = Number((await reader.query(`SELECT pg_backend_pid()::int AS pid`)).rows[0].pid);
    const writerPid = Number((await writer.query(`SELECT pg_backend_pid()::int AS pid`)).rows[0].pid);
    assert.ok(
      Number.isInteger(hookHolderPid) && Number.isInteger(readerPid) && Number.isInteger(writerPid),
    );

    const prepareProbe = async (
      client: pg.Client,
      functionName: "widen_test_s8_read" | "widen_test_s8_write",
      params: unknown[],
    ): Promise<() => Promise<pg.QueryResult>> => {
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL statement_timeout = '${S8_HARNESS_TIMEOUT_MS}ms'`);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }

      return async () => {
        try {
          const result = await client.query(`SELECT ${functionName}($1) AS value`, params);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
      };
    };

    // First synchronize both clients at the same prepared boundary so the
    // server-side ready sequence counts probe execution, not setup queries.
    const [startReader, startWriter] = await Promise.all([
      prepareProbe(reader, "widen_test_s8_read", [seeded.userId]),
      prepareProbe(writer, "widen_test_s8_write", [seeded.serverId]),
    ]);
    reader.on("notice", onPhaseNotice);
    writer.on("notice", onPhaseNotice);
    const readProbe = startReader();
    const writeProbe = startWriter();
    const readResult = capture(readProbe);
    const writeResult = capture(writeProbe);

    // Do not start the migration until each server-side probe has advanced the
    // non-transactional ready sequence exactly once and is polling the S8 gate.
    // This is fixture synchronization, not a latency oracle. PostgreSQL
    // lock_timeout is enabled only by the calibration case.
    await hookHolder.query(`SET statement_timeout = '${S8_HARNESS_TIMEOUT_MS}ms'`);
    const probesReady = hookHolder.query(`
      DO $wait_for_probes$
      DECLARE ready boolean;
      BEGIN
        LOOP
          SELECT is_called AND last_value = 2 INTO ready FROM ${S8_PROBE_READY_SEQUENCE};
          EXIT WHEN ready;
          PERFORM pg_sleep(0.001);
        END LOOP;
      END;
      $wait_for_probes$;
    `);
    const probeEndedBeforeReady = Promise.race([
      readProbe.then(
        () => {
          throw new Error("reader probe completed before both probes reached the ready barrier");
        },
        (error: unknown) => {
          throw error;
        },
      ),
      writeProbe.then(
        () => {
          throw new Error("writer probe completed before both probes reached the ready barrier");
        },
        (error: unknown) => {
          throw error;
        },
      ),
    ]);
    try {
      await Promise.race([probesReady, probeEndedBeforeReady]);
    } catch (error) {
      // The server-side readiness wait belongs to the same hook-holder session
      // that owns the finishing advisory lock. Cancel only its current query,
      // drain that rejection, and preserve the probe's original failure.
      await sc.pool.query(`SELECT pg_cancel_backend($1::int)`, [hookHolderPid]).catch(() => {});
      await probesReady.catch(() => {});
      if (isStatementTimeout(error)) {
        throw new Error(capturedFailure("probe-ready barrier", error), { cause: error });
      }
      throw error;
    }

    // Start the controller before the migration. Once the S8 sequence tick
    // releases both probes and pg_locks proves they are queued, it releases the
    // S9 hook. The clean journey only requires eventual post-commit recovery;
    // the calibration case separately proves that its artificial 300ms gap is
    // covered by PostgreSQL's 250ms lock_timeout.
    const controllerResult = capture(hookHolder.query(`
      DO $release_after_probes_queue$
      BEGIN
        LOOP
          EXIT WHEN (
            SELECT count(DISTINCT pid) = 2
              FROM pg_locks
             WHERE pid IN (${readerPid}, ${writerPid})
               AND NOT granted
               AND relation IN (${oids.join(", ")})
          );
          PERFORM pg_sleep(0.001);
        END LOOP;
        RAISE NOTICE '${S8_PHASE_NOTICE_PREFIX} phase=probes_waiting at_ms=% observer_pid=% reader_pid=% writer_pid=%',
          floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
          pg_backend_pid(),
          ${readerPid},
          ${writerPid};
        IF NOT pg_advisory_unlock(${hookKey}) THEN
          RAISE EXCEPTION 'test hook advisory lock was not held';
        END IF;
      END;
      $release_after_probes_queue$;
    `).then((result) => {
      hookHeld = false;
      return result;
    }));

    const migrationPool = quietPool(url, "widen-s8-migrator", 1);
    migrationPool.on("connect", (client) => client.on("notice", onPhaseNotice));
    const applyResult = capture((async () => {
      const startedAt = Date.now();
      try {
        await migrate(drizzle(migrationPool), { migrationsFolder });
        return { startedAt, endedAt: Date.now() };
      } finally {
        await migrationPool.end().catch(() => {});
      }
    })());
    const [applied, read, write, controller] = await Promise.all([
      applyResult,
      readResult,
      writeResult,
      controllerResult,
    ]);
    assert.equal(controller.ok, true, controller.ok ? undefined : capturedFailure("probe-wait observer", controller.error));
    const phase = buildS8PhaseReport(phaseNotices, {
      observerPid: hookHolderPid,
      readerPid,
      writerPid,
    });
    console.log(`${S8_PHASE_NOTICE_PREFIX} ${JSON.stringify({ gapMs, probeLockTimeoutMs, ...phase })}`);
    return { applied, read, write, phase };
  } finally {
    rmSync(migrationsFolder, { recursive: true, force: true });
    if (hookHeld) {
      await hookHolder.query(`SELECT pg_advisory_unlock($1::bigint)`, [hookKey]).catch(() => {});
    }
    await Promise.all([
      hookHolder.end().catch(() => {}),
      reader.end().catch(() => {}),
      writer.end().catch(() => {}),
    ]);
    await sc.pool.query(`DROP EVENT TRIGGER IF EXISTS widen_test_pause_after_s8_trg`).catch(() => {});
    await sc.cleanup();
  }
}

test("RFC057 A: S8 clean journey queues both probes and releases each exactly once after commit", { skip }, async () => {
  const { applied, read, write, phase } = await runS8WindowScenario(0, null);
  assert.equal(applied.ok, true, applied.ok ? undefined : capturedFailure("migration", applied.error));
  assert.equal(read.ok, true, read.ok ? undefined : capturedFailure("reader probe", read.error));
  assert.equal(write.ok, true, write.ok ? undefined : capturedFailure("writer probe", write.error));
  if (read.ok) assert.equal(read.value.rows[0]?.value, 41, "queued reader completes after S8 commits");
  if (write.ok) assert.equal(write.value.rows[0]?.value, 241, "queued writer completes after S8 commits");
  assert.ok(phase.readerLockReleasedAtMs !== null, "clean reader must emit one post-wait release receipt");
  assert.ok(phase.writerLockReleasedAtMs !== null, "clean writer must emit one post-wait release receipt");
});

test("RFC057 A: isolated 300ms gap calibrates the 250ms PostgreSQL lock_timeout fixture", { skip }, async () => {
  const { applied, read, write, phase } = await runS8WindowScenario(300, S8_CALIBRATION_LOCK_TIMEOUT_MS);
  assert.equal(applied.ok, true, applied.ok ? undefined : capturedFailure("calibration migration", applied.error));
  assert.equal(read.ok, false, "reader must time out while S8 still owns AX");
  assert.equal(write.ok, false, "writer must time out while S8 still owns AX");
  if (!read.ok) assert.ok(isLockTimeout(read.error), errChainText(read.error));
  if (!write.ok) assert.ok(isLockTimeout(write.error), errChainText(write.error));
  assert.ok(
    phase.s8ToS9Ms >= S8_CALIBRATION_LOCK_TIMEOUT_MS,
    `300ms calibration reached S9 after only ${phase.s8ToS9Ms}ms`,
  );
  assert.equal(phase.readerLockReleasedAtMs, null, "timed-out reader must not claim commit-boundary release");
  assert.equal(phase.writerLockReleasedAtMs, null, "timed-out writer must not claim commit-boundary release");
});

test("RFC057 A: delete-trigger knife — mirror tooth goes red without the trigger", { skip }, async () => {
  const sc = await openScenario();
  try {
    const seeded = await seedHistoricalRows(sc.pool);
    await apply0215(sc);
    await sc.pool.query(`DROP TRIGGER read_cursor_mirror_user_trg ON user_channel_read_cursors`);
    await sc.pool.query(
      `UPDATE user_channel_read_cursors SET last_read_seq = 77 WHERE user_id = $1`, [seeded.userId],
    );
    const r = await sc.pool.query(
      `SELECT (last_read_seq8 IS DISTINCT FROM last_read_seq) AS diverged FROM user_channel_read_cursors WHERE user_id = $1`,
      [seeded.userId],
    );
    assert.equal(r.rows[0].diverged, true, "without the trigger the mirror invariant must break (knife RED)");
  } finally {
    await sc.cleanup();
  }
});

test("RFC057 A: ledger + actor teeth — singleton constraint, session_user actor, CAS staleness, illegal edge", { skip }, async () => {
  const sc = await openScenario();
  try {
    await apply0215(sc);
    await assert.rejects(
      sc.pool.query(`INSERT INTO read_cursor_widen_phase (id, phase, epoch, updated_by) VALUES (true, 'backfilling', 1, 'test')`),
      (e: { code?: string }) => e.code === "23505",
    );
    await assert.rejects(
      sc.pool.query(`INSERT INTO read_cursor_widen_phase (id, phase, epoch, updated_by) VALUES (false, 'backfilling', 1, 'test')`),
      (e: { code?: string }) => e.code === "23514",
    );
    await transition(sc.pool, "shadow_widen", 1, "backfilling", "legal edge");
    const after = await readWidenPhase(sc.pool);
    assert.deepEqual(after, { phase: "backfilling", epoch: 1 });
    const audit = await sc.pool.query(`SELECT count(*)::int AS n FROM read_cursor_widen_phase_audit`);
    assert.equal(audit.rows[0].n, 2, "transition wrote its audit row atomically");
    await assert.rejects(
      transition(sc.pool, "shadow_widen", 1, "backfilling", "stale"),
      (e: { code?: string }) => e.code === "40001",
      "stale expected-phase CAS must fail with serialization_failure",
    );
    await assert.rejects(
      transition(sc.pool, "backfilling", 1, "retired", "illegal"),
      (e: { code?: string }) => e.code === "23514",
      "illegal edge must RAISE check_violation",
    );
  } finally {
    await sc.cleanup();
  }
});

test("RFC057 legacy hazard reproduction (NOT historical attribution) — in-place ALTER TYPE queues then cancels", { skip }, async () => {
  const sc = await openScenario();
  try {
    await seedHistoricalRows(sc.pool);
    const holder = await sc.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT * FROM user_channel_read_cursors LIMIT 1`);
      const runner = await sc.pool.connect();
      try {
        await runner.query("BEGIN");
        await runner.query(`SET LOCAL statement_timeout = '2s'`);
        const t0 = Date.now();
        await assert.rejects(
          runner.query(`ALTER TABLE user_channel_read_cursors ALTER COLUMN last_read_seq TYPE bigint`),
          (e: { code?: string }) => e.code === "57014",
        );
        assert.ok(Date.now() - t0 >= 1800, "it waited (queued) rather than failing fast");
        await runner.query("ROLLBACK");
      } finally {
        runner.release();
      }
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
    }
  } finally {
    await sc.cleanup();
  }
});

test("RFC057 B: keyset continuation, single-snapshot convergence, idempotency, seeded divergence, wrong-phase refusal", { skip }, async () => {
  const sc = await openScenario();
  try {
    const seeded = await seedHistoricalRows(sc.pool, 5);
    await apply0215(sc);

    await assert.rejects(
      runReadCursorWidenBackfill(sc.pool),
      /requires 'backfilling'/,
      "the real job entry must refuse outside the backfilling phase",
    );

    await transition(sc.pool, "shadow_widen", 1, "backfilling");

    const gate = await readWidenPhase(sc.pool);
    const before = await convergenceReport(sc.pool, gate);
    assert.ok(before.every((e) => e.divergentOrNull >= 5), "historical rows diverge before backfill");
    assert.equal(new Set(before.map((e) => e.checkedAtLsn)).size, 1, "single-snapshot report: one LSN");

    const report = await runReadCursorWidenBackfill(sc.pool, { batchSize: 2 });
    assert.equal(report.phase, "backfilling");
    assert.equal(report.epoch, 1);
    for (const t of report.tables) {
      assert.ok(t.batches >= 3, `${t.table}: expected keyset continuation (>=3 batches), got ${t.batches}`);
    }
    assert.ok(report.convergence.every((e) => e.divergentOrNull === 0), "backfill converges all tables");
    assert.equal(new Set(report.convergence.map((e) => e.checkedAtLsn)).size, 1, "report is single-snapshot");

    const again = await runReadCursorWidenBackfill(sc.pool, { batchSize: 2 });
    assert.ok(again.tables.every((t) => t.rowsUpdated === 0), "re-run is a no-op");

    await sc.pool.query(`ALTER TABLE user_channel_read_cursors DISABLE TRIGGER read_cursor_mirror_user_trg`);
    await sc.pool.query(
      `UPDATE user_channel_read_cursors SET last_read_seq8 = 999999 WHERE user_id = $1 AND channel_id = $2`,
      [seeded.userId, seeded.channelIds[0]],
    );
    await sc.pool.query(`ALTER TABLE user_channel_read_cursors ENABLE TRIGGER read_cursor_mirror_user_trg`);
    const broken = await convergenceReport(sc.pool, gate);
    assert.equal(
      broken.find((e) => e.table === "user_channel_read_cursors")?.divergentOrNull, 1,
      "positive control: the predicate must see the seeded divergence",
    );
    const repair = await runReadCursorWidenBackfill(sc.pool, { batchSize: 2 });
    assert.ok(repair.convergence.every((e) => e.divergentOrNull === 0), "backfill repairs the seeded divergence");
    assert.equal(WIDEN_BACKFILL_TABLES.length, 3, "spec list stays frozen at three tables");
  } finally {
    await sc.cleanup();
  }
});

test("RFC057 B: mid-run phase flip — job fails closed at the next batch, zero writes after the flip, no report", { skip }, async () => {
  const sc = await openScenario();
  try {
    const seeded = await seedHistoricalRows(sc.pool, 6);
    await apply0215(sc);
    await transition(sc.pool, "shadow_widen", 1, "backfilling");

    let resolveFirstBatch!: () => void;
    const firstBatch = new Promise<void>((resolve) => { resolveFirstBatch = resolve; });
    let batchesSeen = 0;
    const jobResult = runReadCursorWidenBackfill(sc.pool, {
      batchSize: 1,
      sleepMs: 200,
      log: () => {
        batchesSeen += 1;
        if (batchesSeen === 1) resolveFirstBatch();
      },
    });
    jobResult.catch(() => {});

    await firstBatch;
    await transition(sc.pool, "backfilling", 1, "cutover", "mid-run flip tooth");

    await assert.rejects(
      jobResult,
      (err: unknown) => errChainText(err).includes("fail-closed: phase ledger moved"),
      "the job must fail closed on the flip (no report)",
    );
    assert.ok(batchesSeen <= 2, `job must stop at the next batch after the flip (saw ${batchesSeen})`);

    const remaining = await sc.pool.query(
      `SELECT count(*)::int AS n FROM user_channel_read_cursors WHERE user_id = $1 AND last_read_seq8 IS NULL`,
      [seeded.userId],
    );
    assert.ok(remaining.rows[0].n >= 1, "rows after the stop point must remain untouched");
    const agentTouched = await sc.pool.query(
      `SELECT count(*)::int AS n FROM agent_channel_read_cursors WHERE agent_id = $1 AND last_read_seq8 IS NOT NULL`,
      [seeded.agentId],
    );
    assert.equal(agentTouched.rows[0].n, 0, "later tables must receive ZERO writes after the flip");
  } finally {
    await sc.cleanup();
  }
});
