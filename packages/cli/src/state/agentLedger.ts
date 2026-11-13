// The agent ledger — one durable per-agent store for the CLI's local
// context bookkeeping (RFC 072 §1.2 / §6 R1).
//
// Storage engine: SQLite via the Node 24 built-in `node:sqlite` (the CLI
// package floor is >=24, so this costs zero dependencies). One database per
// agent at `$SLOCK_HOME/agent-state/<agentId>/state.db` — a machine-owned
// sibling of `cli-transport/`, deliberately OUTSIDE the agent's workspace
// (`agents/<id>/`): the ledger is the agent's freshness attestation record,
// and the agent it attests for must not be one careless workspace cleanup
// away from deleting or editing it. WAL journaling plus a busy timeout give
// real cross-process write safety, which the historical tmpdir JSON files
// never had.
//
// This unifies what previously lived as three tmpdir-scoped stores
// (consumed-seq cursors, saved send drafts, and the read-order counter).
// PR-A contract: ZERO behavior change. The `_consumedSeqState` and
// `_continueDraftState` modules keep their exact exported signatures and
// semantics (FH-001 / FH-EXT-001 advance rules, monotonic max merge, draft
// TTL, draft writes that fail loudly); only the storage engine underneath
// changes. Legacy JSON files are imported exactly once per database, so existing seats keep their cursors
// across the migration — the import doubles as the v0 migrator in the
// version chain recorded in `meta`. Two legacy layouts exist: the
// hardened per-user private dir (preferred — it is the newer store) and the
// original shared tmpdir; the tmpdir copy is only trusted under the same
// rules `_privateStateFile.ts` applies (regular file, owned by this user,
// bounded size, no symlink following).
//
// Forward compatibility is structural: additive change = new tables or
// ADD COLUMN, which older writers neither see nor destroy (they cannot DROP
// what they do not know); semantic breaks bump `meta.version` and add a
// migrator. Context lifetime is not tracked here: passive-resource
// observations carry the daemon's contextId (RFC 072 §7.3). New booking sources
// (hold dumps, delivered messages) and the append-only gate-event table are
// likewise out of scope here — PR-B/C behavior; this file deliberately does
// not change what gets booked, only where the books live.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  CLI_READ_STATE_FILENAME,
  CLI_READ_STATE_NAMESPACE,
  configuredCliReadStateBase,
  PASSIVE_RENDER_COUNTS_DDL,
  PASSIVE_RENDER_COUNTS_TABLE,
  PASSIVE_RENDER_COUNTS_UPSERT,
  type PassiveRenderKind,
} from "@botiverse/raft-shared/src/agentCliSurface";
import {
  isTrustedCanonicalTarget,
  MAX_EXACT_SEQS_PER_TARGET,
  normalizeExactSeqs,
} from "@botiverse/raft-shared/src/agentOps/seenPolicy/index";

import { privateStatePath, writePrivateState } from "../commands/message/_privateStateFile";
import { resolveRaftHome } from "./raftHome";

export interface LedgerStreamEntry {
  seq?: number;
  readOrder?: number;
  /** The daemon contextId the read was booked in; null when no context signal existed. */
  contextId?: string | null;
}

export interface LedgerDraftEntry {
  content: string;
  attachmentIds: string[];
  idempotencyKey?: string;
  mentions?: unknown[];
  /** RFC 082: a card message's card (`raft message send --card`); in the JSON payload, so no schema change. */
  card?: unknown;
  savedAt: number;
  reholdCount: number;
  seenUpToSeq?: number;
  seenExactSeqs?: number[];
  cause?: string;
}

const LEDGER_VERSION = 1;

// Target trust and exact-seq normalisation are the shared seen policy
// (shared/src/agentOps/seenPolicy/consumedSeqs.ts), so this ledger and the
// policy apply the same rules.
export { isTrustedCanonicalTarget, MAX_EXACT_SEQS_PER_TARGET, normalizeExactSeqs };

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Where the ledger database lives.
 *
 * Explicit override first (`SLOCK_CLI_STATE_DIR`), then the two historical
 * per-store overrides as aliases — tests and callers that isolated the old
 * stores into temp dirs stay hermetic without touching the real user-data
 * root — then the daemon-injected Raft home (rfcs/020), then `~/.slock`.
 */
export function resolveStateDbPath(agentId: string, env: NodeJS.ProcessEnv = process.env): string {
  // Same identity guard the JSON stores applied: the id becomes a path
  // segment, so it must never be able to name another agent's directory.
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new Error("Invalid local state agent identity");
  const override = env.SLOCK_CLI_STATE_DIR?.trim()
    || env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR?.trim()
    || env.SLOCK_CLI_DRAFT_STATE_DIR?.trim();
  if (override) {
    return path.join(override, "slock-cli-ledger", agentId, "state.db");
  }
  const home = resolveRaftHome(env);
  // `agent-state/` is a machine-owned sibling of `cli-transport/` —
  // deliberately outside the agent's workspace; see the header comment.
  return path.join(path.resolve(home), "agent-state", agentId, "state.db");
}

const STATE_DIR_README = `Machine-managed Raft CLI state. Do not edit or delete files here.
This directory holds the agent's local context ledger (read cursors, held
drafts, commands paused for an answer). It is written by the raft CLI only;
hand edits forge or destroy the freshness attestation and degrade sends to
conservative holds.
`;

function ensureStateDirReadme(dbPath: string): void {
  const readmePath = path.join(path.dirname(dbPath), "README");
  if (fs.existsSync(readmePath)) return;
  try {
    fs.writeFileSync(readmePath, STATE_DIR_README, "utf8");
  } catch {
    // The breadcrumb is best-effort; the ledger itself does not depend on it.
  }
}

/**
 * Candidate locations of one legacy store, newest layout first: an explicit
 * env override collapses both layouts onto the same base; otherwise the
 * hardened private layout (user-data root) precedes the original shared
 * tmpdir. Mirrors `_privateStateFile.ts` path resolution.
 */
function legacyCandidatePaths(
  overrideDir: string | undefined,
  namespace: string,
  agentId: string,
  filename: string,
  env: NodeJS.ProcessEnv,
): Array<{ filePath: string; sharedTmpdir: boolean }> {
  if (overrideDir?.trim()) {
    return [{ filePath: path.join(overrideDir.trim(), namespace, agentId, filename), sharedTmpdir: false }];
  }
  const home = resolveRaftHome(env);
  return [
    { filePath: path.join(home, namespace, agentId, filename), sharedTmpdir: false },
    { filePath: path.join(os.tmpdir(), namespace, agentId, filename), sharedTmpdir: true },
  ];
}

function legacyConsumedSeqPaths(agentId: string, env: NodeJS.ProcessEnv): Array<{ filePath: string; sharedTmpdir: boolean }> {
  return legacyCandidatePaths(env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR, "slock-cli-consumed-seq", agentId, "consumed-seqs.json", env);
}

function legacyDraftPaths(agentId: string, env: NodeJS.ProcessEnv): Array<{ filePath: string; sharedTmpdir: boolean }> {
  return legacyCandidatePaths(env.SLOCK_CLI_DRAFT_STATE_DIR, "slock-cli-attested-send", agentId, "continue-state.json", env);
}

interface LegacyConsumedSeqFile {
  targets?: Record<string, number | { seq?: number; readOrder?: number; exactSeqs?: unknown }>;
  /** Alternate spellings that resolve to the same target (`raw` → `canonical`). */
  aliases?: Record<string, string>;
  nextReadOrder?: number;
}

interface LegacyDraftFile {
  targets?: Record<string, string | LedgerDraftEntry>;
}

const LEGACY_STATE_MAX_BYTES = 1024 * 1024;

/**
 * Guarded read of one legacy JSON file. A shared-tmpdir source is only
 * trusted when it is a regular file owned by this user and small (the same
 * rules `_privateStateFile.ts` applies before importing); symlinks are never
 * followed. The import is read-only — rejected or unreadable files are left
 * alone and simply skipped.
 */
function readLegacyJsonFile<T>(filePath: string, sharedTmpdir: boolean): T | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    if (sharedTmpdir && ((process.getuid && stat.uid !== process.getuid()) || stat.size > LEGACY_STATE_MAX_BYTES)) return null;
    const parsed = JSON.parse(fs.readFileSync(fd, "utf8")) as T;
    return typeof parsed === "object" && parsed ? parsed : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * First readable candidate wins — the private layout is the newer store.
 * A shared-tmpdir source is reported in `consumedTmpdirFiles` so the caller
 * can drop it once (and only once) its content is committed to the ledger.
 */
function readFirstLegacyJsonFile<T>(
  candidates: Array<{ filePath: string; sharedTmpdir: boolean }>,
  consumedTmpdirFiles: string[],
): T | null {
  let winner: T | null = null;
  for (const candidate of candidates) {
    const parsed = readLegacyJsonFile<T>(candidate.filePath, candidate.sharedTmpdir);
    if (parsed === null) continue;
    // Every trusted shared-tmpdir copy is dropped after the import commits —
    // including one shadowed by a newer private-layout file.
    if (candidate.sharedTmpdir) consumedTmpdirFiles.push(candidate.filePath);
    if (winner === null) winner = parsed;
  }
  return winner;
}

/** Thrown when the ledger was written under a newer, incompatible schema. */
export class LedgerVersionError extends Error {
  constructor(readonly foundVersion: string) {
    super(`The agent ledger was written by a newer raft CLI (ledger version ${foundVersion}, this CLI understands ${LEDGER_VERSION}); upgrade the raft CLI.`);
    this.name = "LedgerVersionError";
  }
}

// SQLITE_CORRUPT (11) and SQLITE_NOTADB (26), including extended codes.
function isLedgerCorruptionError(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && ((code & 0xff) === 11 || (code & 0xff) === 26);
}

/**
 * Move a corrupt database (and its WAL side files) aside so the next open
 * starts fresh. The ledger is losable by contract: an empty ledger costs one
 * conservative hold, whereas a corrupt one left in place would fail every
 * read and every write forever.
 */
function quarantineCorruptDb(dbPath: string, failedIno: number | undefined): void {
  // A concurrent process may already have quarantined the corrupt file and
  // created a fresh ledger here; never move that fresh ledger aside.
  try {
    if (failedIno === undefined || fs.lstatSync(dbPath).ino !== failedIno) return;
  } catch {
    return;
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.renameSync(dbPath + suffix, `${dbPath}.corrupt${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function openDb(agentId: string, env: NodeJS.ProcessEnv): DatabaseSync {
  const dbPath = resolveStateDbPath(agentId, env);
  // Hardened-store posture carried over from the JSON stores: the ledger directory is
  // user-private and the database is never reached through a symlink — a
  // planted link must fail closed instead of redirecting attested state (or
  // WAL side files) onto a victim path.
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const dirStat = fs.lstatSync(path.dirname(dbPath));
  if (!dirStat.isDirectory() || (process.getuid && dirStat.uid !== process.getuid())) {
    throw new Error("Agent ledger directory is not owned by this user");
  }
  fs.chmodSync(path.dirname(dbPath), 0o700);
  ensureStateDirReadme(dbPath);
  let fresh = true;
  try {
    const dbStat = fs.lstatSync(dbPath);
    if (!dbStat.isFile()) throw new Error("Agent ledger path is not a regular file");
    fresh = false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const db = new DatabaseSync(dbPath);
  try {
    if (fresh) fs.chmodSync(dbPath, 0o600);
    prepareDb(db, agentId, env);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

// Additive (still version 1): the version of each passive resource (RFC 072
// registry type + id) this agent last had delivered, and the daemon's
// contextId of the model context it was delivered into.
const OBSERVATIONS_DDL = `CREATE TABLE IF NOT EXISTS observations (
      type TEXT NOT NULL,
      id TEXT NOT NULL,
      rev TEXT NOT NULL,
      context_id TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      PRIMARY KEY (type, id)
    );`;

/**
 * A development build shipped `observations` without `context_id` (never
 * released). The column is added in place, empty — and an empty contextId
 * never matches a daemon-issued one, so those rows read as "not delivered in
 * this context". No DROP on any path.
 */
function ensureObservationsShape(db: DatabaseSync): void {
  try {
    db.prepare("SELECT context_id FROM observations LIMIT 0").all();
  } catch {
    db.exec("ALTER TABLE observations ADD COLUMN context_id TEXT NOT NULL DEFAULT ''");
  }
}

function prepareDb(db: DatabaseSync, agentId: string, env: NodeJS.ProcessEnv): void {
  // busy_timeout MUST be set before any statement that can take the write
  // lock (including the WAL switch itself): concurrent first-opens otherwise
  // hit SQLITE_BUSY with a zero timeout and a best-effort write is silently
  // lost — caught by the cross-process writers test on CI.
  db.exec("PRAGMA busy_timeout = 3000");
  db.exec("PRAGMA journal_mode = WAL");
  // Version gate BEFORE any schema statement: a ledger written by a newer,
  // incompatible CLI must be neither read nor written (and not have v1
  // tables recreated inside it). Reads then fail closed to "no evidence";
  // draft writes fail loudly.
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (hasMeta) {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: string } | undefined;
    if (row && !(Number(row.value) <= LEDGER_VERSION)) throw new LedgerVersionError(row.value);
  }
  const schemaTables = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'streams', 'drafts', 'stream_exact_seqs', 'target_aliases', 'observations')",
  ).get() as { n: number | bigint };
  if (Number(schemaTables.n) < 6) db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS streams (
      target TEXT PRIMARY KEY,
      seq INTEGER,
      read_order INTEGER
    );
    CREATE TABLE IF NOT EXISTS drafts (
      target TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      saved_at INTEGER NOT NULL
    );
    -- Additive (still version 1): sparse exact-seen seqs per canonical target,
    -- stored as a JSON array; and alternate target spellings → canonical key.
    -- Old writers never touch these tables, so a downgrade is lossless for them.
    CREATE TABLE IF NOT EXISTS stream_exact_seqs (
      target TEXT PRIMARY KEY,
      seqs TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS target_aliases (
      spelling TEXT PRIMARY KEY,
      canonical TEXT NOT NULL
    );
    ${OBSERVATIONS_DDL}
  `);
  // Only write defaults when one is missing: an INSERT OR IGNORE still takes
  // the write lock, and read-only calls must not contend for it.
  const defaults = db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key IN ('version', 'nextReadOrder')").get() as { n: number | bigint };
  if (Number(defaults.n) < 2) {
    db.exec(`
      INSERT OR IGNORE INTO meta (key, value) VALUES ('version', '${LEDGER_VERSION}');
      INSERT OR IGNORE INTO meta (key, value) VALUES ('nextReadOrder', '1');
    `);
  }
  ensureThreadContextColumns(db);
  ensurePassiveRenderCountsTable(db);
  importLegacyStateOnce(db, agentId, env);
}

/**
 * Glimpse layer 2: the counts table exists from this CLI's first ledger open,
 * so the daemon can tell a CLI that counts (and printed nothing) from one that
 * predates the counts (no table). Additive (still version 1). Best-effort: a
 * ledger that cannot take the DDL right now still serves reads, and the first
 * count tries again.
 */
function ensurePassiveRenderCountsTable(db: DatabaseSync): void {
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(PASSIVE_RENDER_COUNTS_TABLE)) return;
    db.exec(PASSIVE_RENDER_COUNTS_DDL);
  } catch {
    // See above.
  }
}

/**
 * RFC 072 §7.10: thread reads are scoped to the model context they happened
 * in. Additive (still version 1): older rows get NULL, which a reader with a
 * context signal treats as "not read in this context".
 */
function ensureThreadContextColumns(db: DatabaseSync): void {
  for (const table of ["streams", "stream_exact_seqs"]) {
    try {
      db.prepare(`SELECT context_id FROM ${table} LIMIT 0`).all();
    } catch {
      db.exec(`ALTER TABLE ${table} ADD COLUMN context_id TEXT`);
    }
  }
}

/**
 * One-time import of the historical JSON stores (hardened private layout
 * first, then the original shared tmpdir) — the v0 migrator of the version
 * chain. Exactly once per database: the `legacyImported` marker is checked
 * and written inside one IMMEDIATE transaction, so concurrent first opens
 * serialize and a crash mid-import rolls back and retries on the next open.
 * The import is merge-safe (it never lowers a seq, never overwrites a newer
 * row, never rewinds the read-order counter), and the shared-tmpdir copy is
 * only removed after the import has committed.
 */
function importLegacyStateOnce(db: DatabaseSync, agentId: string, env: NodeJS.ProcessEnv): void {
  const markerQuery = "SELECT 1 FROM meta WHERE key = 'legacyImported'";
  if (db.prepare(markerQuery).get()) return;
  const consumedTmpdirFiles: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare(markerQuery).get()) {
      db.exec("ROLLBACK");
      return;
    }
    importLegacyState(db, agentId, env, consumedTmpdirFiles);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('legacyImported', ?)").run(String(Date.now()));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  // A shared-tmpdir copy is world-readable; once its content lives in the
  // private ledger the leftover is only exposure, so drop it.
  // The private-layout JSON stays: it is already private, and an older
  // CLI rolled back onto this seat can still read it.
  for (const filePath of consumedTmpdirFiles) {
    try { fs.rmSync(filePath, { force: true }); } catch { /* best-effort */ }
  }
}

function importLegacyState(db: DatabaseSync, agentId: string, env: NodeJS.ProcessEnv, consumedTmpdirFiles: string[]): void {
  const consumed = readFirstLegacyJsonFile<LegacyConsumedSeqFile>(legacyConsumedSeqPaths(agentId, env), consumedTmpdirFiles);
  let maxObservedOrder = 0;
  if (consumed?.targets) {
    // Never lower a seq a live writer already booked; keep its read order.
    const insert = db.prepare(`
      INSERT INTO streams (target, seq, read_order) VALUES (?, ?, ?)
      ON CONFLICT(target) DO UPDATE SET
        seq = CASE
          WHEN excluded.seq IS NULL THEN streams.seq
          WHEN streams.seq IS NULL OR excluded.seq > streams.seq THEN excluded.seq
          ELSE streams.seq
        END
    `);
    const insertExact = db.prepare("INSERT OR IGNORE INTO stream_exact_seqs (target, seqs) VALUES (?, ?)");
    for (const [target, value] of Object.entries(consumed.targets)) {
      // A legacy file polluted by the #8173 alias regression carries a merged
      // "#undefined" record; importing it would seed the ledger with
      // cross-target evidence. Skip it (safe direction: a conservative hold).
      if (!isTrustedCanonicalTarget(target)) continue;
      const seq = typeof value === "number" ? positiveFiniteNumber(value) : positiveFiniteNumber(value?.seq);
      const readOrder = typeof value === "number" ? undefined : positiveFiniteNumber(value?.readOrder);
      const exactSeqs = typeof value === "number" ? [] : normalizeExactSeqs(value?.exactSeqs, seq ?? 0);
      if (seq === undefined && readOrder === undefined && exactSeqs.length === 0) continue;
      if (seq !== undefined || readOrder !== undefined) insert.run(target, seq ?? null, readOrder ?? null);
      if (exactSeqs.length > 0) insertExact.run(target, JSON.stringify(exactSeqs));
      maxObservedOrder = Math.max(maxObservedOrder, readOrder ?? seq ?? 0);
    }
  }
  if (consumed?.aliases) {
    const insertAlias = db.prepare("INSERT OR IGNORE INTO target_aliases (spelling, canonical) VALUES (?, ?)");
    for (const [spelling, canonical] of Object.entries(consumed.aliases)) {
      if (isTrustedCanonicalTarget(spelling) && isTrustedCanonicalTarget(canonical) && spelling !== canonical) {
        insertAlias.run(spelling, canonical);
      }
    }
  }
  const currentOrderRow = db.prepare("SELECT value FROM meta WHERE key = 'nextReadOrder'").get() as { value: string } | undefined;
  const nextReadOrder = Math.max(
    positiveFiniteNumber(Number(currentOrderRow?.value)) ?? 1,
    positiveFiniteNumber(consumed?.nextReadOrder) ?? 1,
    maxObservedOrder + 1,
  );
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('nextReadOrder', ?)").run(String(nextReadOrder));

  const drafts = readFirstLegacyJsonFile<LegacyDraftFile>(legacyDraftPaths(agentId, env), consumedTmpdirFiles);
  if (drafts?.targets) {
    // A draft already in the ledger is newer than any legacy copy.
    const insert = db.prepare("INSERT OR IGNORE INTO drafts (target, payload, saved_at) VALUES (?, ?, ?)");
    for (const [target, value] of Object.entries(drafts.targets)) {
      if (target.length === 0 || !value || typeof value === "string") continue;
      if (typeof value.content !== "string") continue;
      const savedAt = positiveFiniteNumber(value.savedAt) ?? Date.now();
      insert.run(target, JSON.stringify(value), savedAt);
    }
  }
}

function withDb<T>(agentId: string, env: NodeJS.ProcessEnv, fn: (db: DatabaseSync) => T): T {
  const dbPath = resolveStateDbPath(agentId, env);
  let openedIno: number | undefined;
  try {
    openedIno = fs.lstatSync(dbPath).ino;
  } catch {
    // Not created yet; openDb creates it.
  }
  try {
    return withOpenDb(agentId, env, fn);
  } catch (error) {
    if (!isLedgerCorruptionError(error)) throw error;
    // Self-heal once: move the corrupt file aside and retry on a fresh ledger.
    quarantineCorruptDb(dbPath, openedIno);
    return withOpenDb(agentId, env, fn);
  }
}

function withOpenDb<T>(agentId: string, env: NodeJS.ProcessEnv, fn: (db: DatabaseSync) => T): T {
  const db = openDb(agentId, env);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Best-effort variant for write paths: bookkeeping failure must never fail
 * the command. Losing one booking degrades the next send to a conservative
 * server-side hold — the ledger's universal safe direction.
 */
function withDbBestEffort(agentId: string, env: NodeJS.ProcessEnv, fn: (db: DatabaseSync) => void): void {
  try {
    withDb(agentId, env, fn);
  } catch {
    // Swallow: see contract above.
  }
}

/**
 * The read record other tools read without the CLI: `@botiverse/raft-sdk`'s
 * `readLatestReadThread()` (Node >= 20, so no `node:sqlite`) parses the JSON
 * file at the location shared defines (`CLI_READ_STATE_*`). The ledger stays
 * the CLI's source of truth; every cursor booking re-exports its stream state
 * as that JSON view (`targets[target] = { seq, readOrder }`), so the
 * published contract keeps answering from current data. Exact-seq and alias
 * writes do not change the view and do not export.
 *
 * Written as the last step before COMMIT, while the booking holds the write
 * lock, so two processes can never publish their exports out of order. If
 * the COMMIT then fails, the view is one read ahead of the ledger — a read
 * that really happened, harmless to its readers. Best-effort: a failed export
 * only leaves external readers one booking behind; it never fails the read.
 */
let readRecordExportHookForTest: (() => void) | null = null;

/** Test seam: runs after the export snapshot is taken, before the file is written. */
export function __setReadRecordExportHookForTest(hook: (() => void) | null): void {
  readRecordExportHookForTest = hook;
}

function exportReadRecord(db: DatabaseSync, agentId: string, env: NodeJS.ProcessEnv): void {
  try {
    // Only { seq, readOrder } per target: that is all the reader uses, and
    // mirroring exact seqs (up to 2,500 per target) or aliases could push a
    // busy agent's file past the SDK's 32 MiB read cap.
    const targets: Record<string, { seq?: number; readOrder?: number }> = {};
    const streams = db.prepare("SELECT target, seq, read_order FROM streams").all() as Array<{
      target: string;
      seq: number | bigint | null;
      read_order: number | bigint | null;
    }>;
    for (const row of streams) {
      const seq = positiveFiniteNumber(Number(row.seq));
      const readOrder = positiveFiniteNumber(Number(row.read_order));
      if (seq === undefined && readOrder === undefined) continue;
      targets[row.target] = { ...(seq !== undefined ? { seq } : {}), ...(readOrder !== undefined ? { readOrder } : {}) };
    }
    const record = { targets };
    const filePath = privateStatePath(
      // Resolve from the env this call was given (shared's order: store
      // override, then Raft home), so the ledger and its view cannot diverge.
      configuredCliReadStateBase(env),
      CLI_READ_STATE_NAMESPACE,
      agentId,
      CLI_READ_STATE_FILENAME,
    );
    readRecordExportHookForTest?.();
    writePrivateState(filePath, JSON.stringify(record));
  } catch (error) {
    // Best-effort, but counted: a stale external read is then diagnosable
    // from the ledger instead of guessed at.
    try {
      const code = (error as NodeJS.ErrnoException | null)?.code ?? (error as Error | null)?.name ?? "unknown";
      db.prepare(`
        INSERT INTO meta (key, value) VALUES ('readRecordExportFailures', '1')
        ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
      `).run();
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('readRecordExportLastError', ?)").run(`${Date.now()} ${String(code)}`);
    } catch {
      // The count itself is best-effort.
    }
  }
}

// ---- streams ----

// `contextId` is only reported when set, so callers and tests that compare
// entries recorded without a context signal see the historical shape.
function withContext(entry: LedgerStreamEntry, contextId: string | null): LedgerStreamEntry {
  return contextId === null ? entry : { ...entry, contextId };
}

export function readStreamEntry(agentId: string, target: string, env: NodeJS.ProcessEnv = process.env): LedgerStreamEntry | undefined {
  try {
    return withDb(agentId, env, (db) => {
      const row = db.prepare("SELECT seq, read_order, context_id FROM streams WHERE target = ?").get(target) as
        | { seq: number | bigint | null; read_order: number | bigint | null; context_id: string | null }
        | undefined;
      if (!row) return undefined;
      const seq = positiveFiniteNumber(Number(row.seq));
      const readOrder = positiveFiniteNumber(Number(row.read_order));
      if (seq === undefined && readOrder === undefined) return undefined;
      return withContext({ seq, readOrder }, row.context_id ?? null);
    });
  } catch {
    return undefined;
  }
}

export function readAllStreamEntries(agentId: string, env: NodeJS.ProcessEnv = process.env): Record<string, LedgerStreamEntry> {
  try {
    return withDb(agentId, env, (db) => {
      const rows = db.prepare("SELECT target, seq, read_order, context_id FROM streams").all() as Array<{
        target: string;
        seq: number | bigint | null;
        read_order: number | bigint | null;
        context_id: string | null;
      }>;
      const entries: Record<string, LedgerStreamEntry> = {};
      for (const row of rows) {
        const seq = positiveFiniteNumber(Number(row.seq));
        const readOrder = positiveFiniteNumber(Number(row.read_order));
        if (seq === undefined && readOrder === undefined) continue;
        entries[row.target] = withContext({ seq, readOrder }, row.context_id);
      }
      return entries;
    });
  } catch {
    return {};
  }
}

/**
 * Book stream consumption: monotonic max on `seq` within one model context,
 * fresh `read_order` from the shared counter, one transaction per call. WAL +
 * busy_timeout serialize concurrent writers.
 *
 * A read booked in a DIFFERENT context replaces the row instead of taking the
 * max (RFC 072 §7.10): the new context has read exactly what it just read, not
 * everything an earlier, forgotten context had — keeping the max would attest
 * to messages this context never saw. Its sparse exact seqs are dropped too.
 */
export function bookStreamEntries(
  agentId: string,
  entries: Record<string, number | undefined>,
  env: NodeJS.ProcessEnv = process.env,
  contextId: string | null = null,
): void {
  const updates = Object.entries(entries).filter(([target]) => target.length > 0);
  if (updates.length === 0) return;
  withDbBestEffort(agentId, env, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const orderRow = db.prepare("SELECT value FROM meta WHERE key = 'nextReadOrder'").get() as { value: string } | undefined;
      let nextReadOrder = positiveFiniteNumber(Number(orderRow?.value)) ?? 1;
      const upsert = db.prepare(`
        INSERT INTO streams (target, seq, read_order, context_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(target) DO UPDATE SET
          seq = CASE
            WHEN streams.context_id IS NOT excluded.context_id THEN excluded.seq
            WHEN excluded.seq IS NULL THEN streams.seq
            WHEN streams.seq IS NULL OR excluded.seq > streams.seq THEN excluded.seq
            ELSE streams.seq
          END,
          read_order = excluded.read_order,
          context_id = excluded.context_id
      `);
      const readSeq = db.prepare("SELECT seq FROM streams WHERE target = ?");
      const dropOtherContextExact = db.prepare("DELETE FROM stream_exact_seqs WHERE target = ? AND context_id IS NOT ?");
      for (const [target, seq] of updates) {
        dropOtherContextExact.run(target, contextId);
        upsert.run(target, positiveFiniteNumber(seq) ?? null, nextReadOrder, contextId);
        nextReadOrder += 1;
        // A real high-water read retires exact observations it now covers.
        const row = readSeq.get(target) as { seq: number | null } | undefined;
        pruneExactSeqsBelow(db, target, positiveFiniteNumber(row?.seq) ?? 0);
      }
      db.prepare("UPDATE meta SET value = ? WHERE key = 'nextReadOrder'").run(String(nextReadOrder));
      exportReadRecord(db, agentId, env);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

function readExactSeqsRow(db: DatabaseSync, target: string): number[] {
  const row = db.prepare("SELECT seqs FROM stream_exact_seqs WHERE target = ?").get(target) as { seqs: string } | undefined;
  if (!row) return [];
  try {
    return normalizeExactSeqs(JSON.parse(row.seqs));
  } catch {
    return [];
  }
}

function pruneExactSeqsBelow(db: DatabaseSync, target: string, afterSeq: number): void {
  if (afterSeq <= 0) return;
  const kept = normalizeExactSeqs(readExactSeqsRow(db, target), afterSeq);
  if (kept.length === 0) {
    db.prepare("DELETE FROM stream_exact_seqs WHERE target = ?").run(target);
  } else {
    db.prepare("UPDATE stream_exact_seqs SET seqs = ? WHERE target = ?").run(JSON.stringify(kept), target);
  }
}

/** Sparse exact seqs whose full bodies were rendered for this target (above its high-water mark). */
export function readExactSeqs(agentId: string, target: string, env: NodeJS.ProcessEnv = process.env): number[] {
  try {
    return withDb(agentId, env, (db) => {
      const row = db.prepare("SELECT seq FROM streams WHERE target = ?").get(target) as { seq: number | null } | undefined;
      return normalizeExactSeqs(readExactSeqsRow(db, target), positiveFiniteNumber(row?.seq) ?? 0);
    });
  } catch {
    return [];
  }
}

/** Sparse exact seqs for this target and the contextId they were booked in (null: no signal). */
export function readExactSeqsWithContext(
  agentId: string,
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): { seqs: number[]; contextId: string | null } {
  try {
    return withDb(agentId, env, (db) => {
      const stream = db.prepare("SELECT seq, context_id FROM streams WHERE target = ?").get(target) as
        | { seq: number | null; context_id: string | null }
        | undefined;
      const row = db.prepare("SELECT context_id FROM stream_exact_seqs WHERE target = ?").get(target) as
        | { context_id: string | null }
        | undefined;
      const contextId = row?.context_id ?? null;
      // The high-water mark only bounds exact seqs booked in the same context.
      const floor = stream && (stream.context_id ?? null) === contextId ? positiveFiniteNumber(stream.seq) ?? 0 : 0;
      return { seqs: normalizeExactSeqs(readExactSeqsRow(db, target), floor), contextId };
    });
  } catch {
    return { seqs: [], contextId: null };
  }
}

/**
 * Merge sparse full-body observations without fabricating a high-water
 * boundary. Observations from a different context replace, not merge.
 */
export function bookExactSeqs(
  agentId: string,
  entries: Record<string, number[]>,
  env: NodeJS.ProcessEnv = process.env,
  contextId: string | null = null,
): void {
  const updates = Object.entries(entries)
    .map(([target, seqs]) => [target, normalizeExactSeqs(seqs)] as const)
    .filter(([target, seqs]) => target.length > 0 && seqs.length > 0);
  if (updates.length === 0) return;
  withDbBestEffort(agentId, env, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const readStream = db.prepare("SELECT seq, context_id FROM streams WHERE target = ?");
      const readExactContext = db.prepare("SELECT context_id FROM stream_exact_seqs WHERE target = ?");
      const upsert = db.prepare("INSERT OR REPLACE INTO stream_exact_seqs (target, seqs, context_id) VALUES (?, ?, ?)");
      for (const [target, seqs] of updates) {
        const stream = readStream.get(target) as { seq: number | null; context_id: string | null } | undefined;
        const existing = readExactContext.get(target) as { context_id: string | null } | undefined;
        const sameContext = existing !== undefined && (existing.context_id ?? null) === contextId;
        const floor = stream && (stream.context_id ?? null) === contextId ? positiveFiniteNumber(stream.seq) ?? 0 : 0;
        const merged = normalizeExactSeqs([...(sameContext ? readExactSeqsRow(db, target) : []), ...seqs], floor);
        if (merged.length > 0) upsert.run(target, JSON.stringify(merged), contextId);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

/**
 * Resolve a typed spelling to its canonical target key. Follows short alias
 * chains defensively; a cycle returns the first repeating key rather than
 * hanging on corrupt state.
 */
export function resolveCanonicalTarget(agentId: string, target: string, env: NodeJS.ProcessEnv = process.env): string {
  try {
    return withDb(agentId, env, (db) => {
      const lookup = db.prepare("SELECT canonical FROM target_aliases WHERE spelling = ?");
      let current = target;
      const seen = new Set<string>([target]);
      for (;;) {
        const row = lookup.get(current) as { canonical: string } | undefined;
        if (!row || seen.has(row.canonical) || !isTrustedCanonicalTarget(row.canonical)) return current;
        current = row.canonical;
        seen.add(current);
      }
    });
  } catch {
    return target;
  }
}

/**
 * Record that `rawSpelling` resolves to `canonicalTarget`. Idempotent; a raw
 * spelling that later resolves elsewhere is re-pointed (latest resolution wins).
 */
export function bookTargetAlias(agentId: string, rawSpelling: string, canonicalTarget: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isTrustedCanonicalTarget(rawSpelling) || !isTrustedCanonicalTarget(canonicalTarget) || rawSpelling === canonicalTarget) return;
  withDbBestEffort(agentId, env, (db) => {
    db.prepare("INSERT OR REPLACE INTO target_aliases (spelling, canonical) VALUES (?, ?)").run(rawSpelling, canonicalTarget);
  });
}

// ---- passive resource observations (RFC 072 §7.3) ----

export interface Observation {
  rev: string;
  contextId: string;
}

/** What `(type, id)` this agent last had delivered, and into which context. */
export function readObservation(agentId: string, type: string, id: string, env: NodeJS.ProcessEnv = process.env): Observation | undefined {
  try {
    return withDb(agentId, env, (db) => {
      ensureObservationsShape(db);
      const row = db.prepare("SELECT rev, context_id FROM observations WHERE type = ? AND id = ?").get(type, id) as
        | { rev: string; context_id: string }
        | undefined;
      return row ? { rev: row.rev, contextId: row.context_id } : undefined;
    });
  } catch {
    return undefined;
  }
}

/**
 * Record that `(type, id)` at `rev` was delivered into context `contextId`.
 * Best-effort: a lost observation only means the resource is delivered once
 * more. Callers that hold an action until this is recorded must first check
 * `probeLedgerWritable`, or a hold could never be released.
 */
export function recordObservation(
  agentId: string,
  type: string,
  id: string,
  rev: string,
  contextId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  withDbBestEffort(agentId, env, (db) => {
    ensureObservationsShape(db);
    db.prepare("INSERT OR REPLACE INTO observations (type, id, rev, context_id, seen_at) VALUES (?, ?, ?, ?, ?)")
      .run(type, id, rev, contextId, Date.now());
  });
}

/**
 * Atomically claim the first delivery of `(type, id)` at `rev` in context
 * `contextId`: records it and answers `true` when the ledger did not already
 * hold exactly that rev and context, `false` when it did. One statement, so a
 * concurrent writer (the daemon delivering while this CLI reads) cannot make
 * both sides think they were first. The daemon writes the same rows with the
 * same statement. `undefined` when the ledger cannot answer.
 */
export function claimObservation(
  agentId: string,
  type: string,
  id: string,
  rev: string,
  contextId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean | undefined {
  try {
    return withDb(agentId, env, (db) => {
      ensureObservationsShape(db);
      const result = db.prepare(`INSERT INTO observations (type, id, rev, context_id, seen_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (type, id) DO UPDATE SET rev = excluded.rev, context_id = excluded.context_id, seen_at = excluded.seen_at
        WHERE observations.rev IS NOT excluded.rev OR observations.context_id IS NOT excluded.context_id`)
        .run(type, id, rev, contextId, Date.now());
      return Number(result.changes) === 1;
    });
  } catch {
    return undefined;
  }
}

/**
 * Undo a claim whose output never reached the agent. Only the exact row the
 * claim wrote is removed; best-effort, a leftover only hides the full form
 * once in that context.
 */
export function releaseObservation(
  agentId: string,
  type: string,
  id: string,
  rev: string,
  contextId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  withDbBestEffort(agentId, env, (db) => {
    ensureObservationsShape(db);
    db.prepare("DELETE FROM observations WHERE type = ? AND id = ? AND rev = ? AND context_id = ?").run(type, id, rev, contextId);
  });
}

/**
 * Whether an observation could be recorded right now: opens the ledger and
 * takes and releases the write lock (`BEGIN IMMEDIATE; ROLLBACK`, bounded by
 * busy_timeout). Any failure — lock, newer ledger version, permissions,
 * corruption that could not be healed — is "not writable".
 */
export function probeLedgerWritable(agentId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return withDb(agentId, env, (db) => {
      ensureObservationsShape(db);
      // BEGIN IMMEDIATE alone is not proof: with -wal/-shm already present a
      // read-only file opens in WAL read-only mode, the lock succeeds and only
      // the first real write fails. Write a row, then roll it back.
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('writeProbe', '1')").run();
      } finally {
        db.exec("ROLLBACK");
      }
      return true;
    });
  } catch {
    return false;
  }
}

// ---- passive render counts (glimpse layer 2) ----

// Additive (still version 1): what this CLI printed of passive AX, per model
// context and kind, until the daemon takes and clears the rows when a turn
// ends (packages/shared/src/agentOps/passiveRenderCounts.ts). The table is
// created on the ledger's first open (ensurePassiveRenderCountsTable).

/** Add one printed block to its context's count; best-effort, a lost count only under-reports. */
export function countPassiveRender(
  agentId: string,
  contextId: string,
  kind: PassiveRenderKind,
  chars: number,
  bytes: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  withDbBestEffort(agentId, env, (db) => {
    db.exec(PASSIVE_RENDER_COUNTS_DDL);
    db.prepare(PASSIVE_RENDER_COUNTS_UPSERT).run(contextId, kind, chars, bytes);
  });
}

// ---- drafts ----

export function readDraftEntry(agentId: string, target: string, env: NodeJS.ProcessEnv = process.env): LedgerDraftEntry | undefined {
  try {
    return withDb(agentId, env, (db) => {
      const row = db.prepare("SELECT payload, saved_at FROM drafts WHERE target = ?").get(target) as
        | { payload: string; saved_at: number | bigint }
        | undefined;
      if (!row) return undefined;
      try {
        const parsed = JSON.parse(row.payload) as LedgerDraftEntry;
        // The column is authoritative: it is the key the TTL delete matches on.
        return typeof parsed === "object" && parsed && typeof parsed.content === "string"
          ? { ...parsed, savedAt: Number(row.saved_at) }
          : undefined;
      } catch {
        return undefined;
      }
    });
  } catch (error) {
    // A newer ledger must say "upgrade the CLI", not "draft not found".
    if (error instanceof LedgerVersionError) throw error;
    return undefined;
  }
}

/**
 * Draft mutations are NOT best-effort: a caller that is told "draft saved"
 * builds retry guidance (`--send-draft`, idempotent resend) on it, so a
 * failed write must fail the command before anything is sent — the same
 * contract the JSON store had.
 */
export function writeDraftEntry(agentId: string, target: string, draft: LedgerDraftEntry, env: NodeJS.ProcessEnv = process.env): void {
  withDb(agentId, env, (db) => {
    db.prepare("INSERT OR REPLACE INTO drafts (target, payload, saved_at) VALUES (?, ?, ?)")
      .run(target, JSON.stringify(draft), positiveFiniteNumber(draft.savedAt) ?? Date.now());
  });
}

export function deleteDraftEntry(agentId: string, target: string, env: NodeJS.ProcessEnv = process.env): void {
  withDb(agentId, env, (db) => {
    db.prepare("DELETE FROM drafts WHERE target = ?").run(target);
  });
}

/**
 * Delete the target's draft only if it is still the one saved at `savedAt`
 * (the TTL path): a fresher draft saved by a concurrent send survives.
 */
export function deleteDraftEntryIfSavedAt(agentId: string, target: string, savedAt: number, env: NodeJS.ProcessEnv = process.env): boolean {
  return withDb(agentId, env, (db) => {
    const result = db.prepare("DELETE FROM drafts WHERE target = ? AND saved_at = ?").run(target, savedAt);
    return Number(result.changes) > 0;
  });
}

/**
 * Delete the target's draft only when it carries exactly this idempotency
 * key — one atomic statement, so a draft replaced by a concurrent writer
 * between "send reconciled" and "clear" is never destroyed (#7646).
 */
export function deleteDraftEntryIfIdempotencyKeyMatches(agentId: string, target: string, idempotencyKey: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return withDb(agentId, env, (db) => {
    const result = db.prepare(
      "DELETE FROM drafts WHERE target = ? AND json_extract(payload, '$.idempotencyKey') = ?",
    ).run(target, idempotencyKey);
    return Number(result.changes) > 0;
  });
}

// ---- continuations (shared/src/continuations) ----

// Additive (still version 1): records of commands that paused to ask the
// agent something, and the content-free tombstones left of answered ones.
// The payload is the record or tombstone as JSON; `revision` and
// `delete_after` are copies the conditional update and the sweep match on.
// Created on first use: older CLIs never see these tables, and a ledger that
// never paused a command never has them.
const CONTINUATION_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS continuations (
    id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    delete_after INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS continuation_tombstones (
    id TEXT PRIMARY KEY,
    delete_after INTEGER NOT NULL,
    payload TEXT NOT NULL
  );`;

function ensureContinuationTables(db: DatabaseSync): void {
  const present = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('continuations', 'continuation_tombstones')",
  ).get() as { n: number | bigint };
  if (Number(present.n) < 2) db.exec(CONTINUATION_TABLES_DDL);
}

/**
 * Continuation rows are NOT best-effort: the runtime builds every answer it
 * gives the agent (paused, answered once, expired) on what was stored, so a
 * failed read or write throws, and the command says it could not keep the
 * continuation instead of losing it silently.
 */
function withContinuationTables<T>(agentId: string, env: NodeJS.ProcessEnv, fn: (db: DatabaseSync) => T): T {
  return withDb(agentId, env, (db) => {
    ensureContinuationTables(db);
    return fn(db);
  });
}

/** Insert a continuation; false, writing nothing, when the id is taken. */
export function insertContinuationRow(
  agentId: string,
  row: { id: string; revision: number; deleteAfter: number; payload: string },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return withContinuationTables(agentId, env, (db) => {
    const result = db.prepare(
      "INSERT INTO continuations (id, revision, delete_after, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    ).run(row.id, row.revision, row.deleteAfter, row.payload);
    return Number(result.changes) === 1;
  });
}

export function readContinuationRow(agentId: string, id: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return withContinuationTables(agentId, env, (db) => {
    const row = db.prepare("SELECT payload FROM continuations WHERE id = ?").get(id) as { payload: string } | undefined;
    return row?.payload;
  });
}

/** Replace the continuation only while its stored revision is `expectedRevision`; false when it moved on or is gone. */
export function updateContinuationRow(
  agentId: string,
  row: { id: string; revision: number; deleteAfter: number; payload: string },
  expectedRevision: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return withContinuationTables(agentId, env, (db) => {
    const result = db.prepare(
      "UPDATE continuations SET revision = ?, delete_after = ?, payload = ? WHERE id = ? AND revision = ?",
    ).run(row.revision, row.deleteAfter, row.payload, row.id, expectedRevision);
    return Number(result.changes) === 1;
  });
}

export function deleteContinuationRow(agentId: string, id: string, env: NodeJS.ProcessEnv = process.env): void {
  withContinuationTables(agentId, env, (db) => {
    db.prepare("DELETE FROM continuations WHERE id = ?").run(id);
  });
}

export function writeContinuationTombstoneRow(
  agentId: string,
  row: { id: string; deleteAfter: number; payload: string },
  env: NodeJS.ProcessEnv = process.env,
): void {
  withContinuationTables(agentId, env, (db) => {
    db.prepare("INSERT OR REPLACE INTO continuation_tombstones (id, delete_after, payload) VALUES (?, ?, ?)")
      .run(row.id, row.deleteAfter, row.payload);
  });
}

export function readContinuationTombstoneRow(agentId: string, id: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return withContinuationTables(agentId, env, (db) => {
    const row = db.prepare("SELECT payload FROM continuation_tombstones WHERE id = ?").get(id) as { payload: string } | undefined;
    return row?.payload;
  });
}

/** Delete every continuation and tombstone whose `delete_after` is before `now`, in one transaction; answers how many. */
export function deleteExpiredContinuationRows(agentId: string, now: number, env: NodeJS.ProcessEnv = process.env): number {
  return withContinuationTables(agentId, env, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const records = db.prepare("DELETE FROM continuations WHERE delete_after < ?").run(now);
      const tombstones = db.prepare("DELETE FROM continuation_tombstones WHERE delete_after < ?").run(now);
      db.exec("COMMIT");
      return Number(records.changes) + Number(tombstones.changes);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

// ---- counters ----

/** Best-effort meta counter (observability only; never read back by behaviour). */
export function incrementMetaCounter(agentId: string, key: string, env: NodeJS.ProcessEnv = process.env): void {
  withDbBestEffort(agentId, env, (db) => {
    db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, '1')
      ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
    `).run(key);
  });
}

// ---- meta (exposed for tests) ----

export function readMeta(agentId: string, key: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    return withDb(agentId, env, (db) => {
      const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
      return row?.value;
    });
  } catch {
    return undefined;
  }
}
