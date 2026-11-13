// Glimpse layer 2, daemon side: what the agent's raft CLI printed of passive
// AX (packages/shared/src/agentOps/passiveRenderCounts.ts). When a turn ends
// the daemon takes the CLI's counts out of the agent's ledger, clears them,
// and puts them on that turn's `daemon.runtime.turn` span, next to its token
// counts, so one row answers "how much of this turn's input was passive AX".
//
// A foreign writer on the CLI's ledger, like senderLedger.ts: no DDL, never
// creates the file, only a `meta.version` it knows, and it never waits for a
// lock (busy_timeout 0, on the main thread). A ledger it cannot take from now
// keeps its counts for the next turn end, and the span says why.
import { existsSync } from "node:fs";

import {
  isPassiveRenderKind,
  PASSIVE_RENDER_COUNTS_TABLE,
  PASSIVE_RENDER_KINDS,
  type PassiveRenderKind,
} from "@botiverse/raft-shared";

import { KNOWN_LEDGER_VERSIONS, loadSqlite, type SqliteDatabase, type SqliteModule } from "./senderLedger";

export interface PassiveRenderCount {
  contextId: string;
  kind: string;
  renders: number;
  chars: number;
  bytes: number;
}

export type PassiveRenderTakeOutcome =
  /** Counts were taken and cleared. */
  | "taken"
  /** Nothing was printed since the last take. */
  | "empty"
  /**
   * No counts table (or no ledger at all): the agent's CLI predates the
   * counts, so "nothing printed" cannot be told from "not counted".
   */
  | "no_counter"
  /** The CLI was writing the ledger: the counts stay for the next turn end. */
  | "ledger_busy"
  /** A ledger version this daemon does not know: neither read nor cleared. */
  | "unknown_version"
  /** No ledger path, no `node:sqlite`, or a ledger that could not be read. */
  | "unavailable";

export interface PassiveRenderTake {
  outcome: PassiveRenderTakeOutcome;
  counts: PassiveRenderCount[];
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

function isLockError(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && ((code & 0xff) === SQLITE_BUSY || (code & 0xff) === SQLITE_LOCKED);
}

/** Take every counted row and clear the table in one write transaction. */
export function takePassiveRenderCounts(dbPath: string | undefined, deps: { sqlite?: SqliteModule } = {}): PassiveRenderTake {
  // A CLI that counts creates the ledger and the table on its first open.
  if (dbPath && !existsSync(dbPath)) return { outcome: "no_counter", counts: [] };
  const sqlite = deps.sqlite ?? loadSqlite();
  if (!dbPath || !sqlite) return { outcome: "unavailable", counts: [] };
  let db: SqliteDatabase | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 0");
    const version = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: unknown } | undefined;
    if (typeof version?.value !== "string" || !KNOWN_LEDGER_VERSIONS.has(version.value)) return { outcome: "unknown_version", counts: [] };
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(PASSIVE_RENDER_COUNTS_TABLE)) return { outcome: "no_counter", counts: [] };
    // Reading first keeps a turn that printed nothing off the write lock.
    if (!db.prepare(`SELECT 1 FROM ${PASSIVE_RENDER_COUNTS_TABLE} LIMIT 1`).get()) return { outcome: "empty", counts: [] };
    // WAL with synchronous = NORMAL: the commit does not wait for an fsync
    // (a checkpoint, e.g. on close, still may). A power cut can then lose the
    // last turn's counts, which only under-reports.
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("BEGIN IMMEDIATE");
    let rows: unknown[];
    try {
      rows = db.prepare(`SELECT context_id, kind, renders, chars, bytes FROM ${PASSIVE_RENDER_COUNTS_TABLE}`).all();
      db.prepare(`DELETE FROM ${PASSIVE_RENDER_COUNTS_TABLE}`).run();
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* the transaction is gone already */ }
      throw error;
    }
    const counts = rows.flatMap((row) => {
      const r = row as Record<string, unknown>;
      const count = {
        contextId: typeof r.context_id === "string" ? r.context_id : "",
        kind: typeof r.kind === "string" ? r.kind : "",
        renders: Number(r.renders),
        chars: Number(r.chars),
        bytes: Number(r.bytes),
      };
      return [count.renders, count.chars, count.bytes].every((n) => Number.isSafeInteger(n) && n >= 0) ? [count] : [];
    });
    return { outcome: "taken", counts };
  } catch (error) {
    return { outcome: isLockError(error) ? "ledger_busy" : "unavailable", counts: [] };
  } finally {
    try { db?.close(); } catch { /* nothing to do */ }
  }
}

type KindAttrs = Record<`passive_render_${PassiveRenderKind}_${"render" | "byte"}_count`, number>;

/**
 * The turn span's `passive_render_*` attributes. Totals and per-kind counts
 * are what was printed in the model context the turn ended in; counts booked
 * under another context (a compaction during the turn, or counts a turn end
 * never took) are reported apart. `carried_over`: the last take on this
 * process failed, so this turn's counts can include earlier turns'.
 *
 * Every key must survive the daemon's local trace sink, which drops keys
 * ending in `_id` unless allowlisted (trace-client `localTraceSink.ts`
 * `DIAGNOSTIC_ID_ATTRS`, where `model_context_id` is listed).
 */
export function passiveRenderTraceAttrs(take: PassiveRenderTake, currentContextId: string | null, carriedOver: boolean) {
  const kinds = Object.fromEntries(
    PASSIVE_RENDER_KINDS.flatMap((kind) => [[`passive_render_${kind}_render_count`, 0], [`passive_render_${kind}_byte_count`, 0]]),
  ) as KindAttrs;
  const current = { renders: 0, chars: 0, bytes: 0 };
  const other = { renders: 0, chars: 0, bytes: 0 };
  let unknownKindRenders = 0;
  for (const count of take.counts) {
    const bucket = count.contextId === currentContextId ? current : other;
    bucket.renders += count.renders;
    bucket.chars += count.chars;
    bucket.bytes += count.bytes;
    if (bucket !== current) continue;
    if (isPassiveRenderKind(count.kind)) {
      kinds[`passive_render_${count.kind}_render_count`] += count.renders;
      kinds[`passive_render_${count.kind}_byte_count`] += count.bytes;
    } else {
      unknownKindRenders += count.renders;
    }
  }
  return {
    passive_render_outcome: take.outcome,
    passive_render_carried_over: carriedOver,
    ...(currentContextId ? { model_context_id: currentContextId } : {}),
    passive_render_count: current.renders,
    passive_render_char_count: current.chars,
    passive_render_byte_count: current.bytes,
    ...kinds,
    passive_render_unknown_kind_render_count: unknownKindRenders,
    passive_render_other_context_render_count: other.renders,
    passive_render_other_context_char_count: other.chars,
    passive_render_other_context_byte_count: other.bytes,
  };
}
