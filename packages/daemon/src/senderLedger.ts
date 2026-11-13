// Sender descriptions shown once per model context, daemon side (passive
// resource "sender", policy "once"; PR #7583 rfcs/072-progressive-ax.md).
//
// The agent's ledger (`<raft home>/agent-state/<agentId>/state.db`) belongs to
// the raft CLI: it owns the schema and the `meta.version` chain, and ships on
// a different cadence than this daemon. The daemon is a foreign writer:
// - no DDL and no migration; it never creates the file;
// - before writing it checks `meta.version` is one it knows and that
//   `observations` has `context_id`; otherwise it writes nothing and every
//   description is shown in full;
// - it only writes `type = 'sender'` rows, with the CLI's own claim statement
//   (one `INSERT … ON CONFLICT … WHERE` whose `changes()` says "first"), so a
//   CLI read and a live delivery cannot both decide "first";
// - any error means "show it in full"; the ledger never delays or drops a
//   delivery.
//
// The handle never waits for a lock (busy_timeout 0): it runs synchronously on
// the daemon's main thread. Per delivery it costs one open, one version read,
// one statement per new sender and a close: about 1.2 ms per delivery measured
// on an arm64 single-board machine (500 deliveries, WAL ledger). A handle
// cached per agent and contextId would cut that; not needed yet.
//
// Known windows where a description can be skipped in a context (all rare,
// all accepted): a delivery between a compaction and the daemon writing the
// new context id still uses the old id; a CLI read that saw this delivery's
// claim before its stdin write failed and was released.
//
// A claim counts once the stdin write succeeded (`settle(true)`); a failed
// write releases the rows it claimed. Most runtimes have no per-message "the
// model read it" receipt, so a crash right after the write can hide one
// description in that context; the next spawn is a new context and shows it
// again.
import { existsSync } from "node:fs";
import path from "node:path";

import {
  type AgentMessage,
  elideSeenSenderDescriptions,
  type SenderClaim,
} from "@botiverse/raft-shared";

import { logger } from "./logger";

/** Ledger versions whose `observations` shape this writer knows. */
export const KNOWN_LEDGER_VERSIONS: ReadonlySet<string> = new Set(["1"]);

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
export type SqliteModule = { DatabaseSync: new (file: string) => SqliteDatabase };

export function loadSqlite(): SqliteModule | undefined {
  try {
    // Not a static import: a host without node:sqlite must still load the
    // daemon, and simply shows every description in full.
    const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    return getBuiltin?.("node:sqlite") as SqliteModule | undefined;
  } catch {
    return undefined;
  }
}

export function senderLedgerPath(raftHome: string, agentId: string): string | undefined {
  // Same identity guard as the CLI: the id becomes a path segment.
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) return undefined;
  return path.join(path.resolve(raftHome), "agent-state", agentId, "state.db");
}

export interface SenderLedger {
  claim: SenderClaim;
  release: (claimed: ReadonlyArray<{ id: string; rev: string }>) => void;
  close: () => void;
}

/** Opens the CLI's ledger as a foreign writer, or `undefined` when it cannot be trusted. */
export function openSenderLedger(dbPath: string, contextId: string, deps: { sqlite?: SqliteModule } = {}): SenderLedger | undefined {
  if (!existsSync(dbPath)) return undefined;
  const sqlite = deps.sqlite ?? loadSqlite();
  if (!sqlite) return undefined;
  let db: SqliteDatabase | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath);
    // No waiting: this runs synchronously on the daemon's main thread, so a
    // lock held by the agent's CLI must never stall delivery for every agent
    // on the machine. SQLITE_BUSY throws, and a throwing claim answers
    // "show it in full" without recording anything.
    db.exec("PRAGMA busy_timeout = 0");
    const version = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: unknown } | undefined;
    if (typeof version?.value !== "string" || !KNOWN_LEDGER_VERSIONS.has(version.value)) {
      db.close();
      return undefined;
    }
    db.prepare("SELECT type, id, rev, context_id, seen_at FROM observations LIMIT 0").all();
  } catch (error) {
    logger.warn(`[sender-ledger] ledger not usable, descriptions shown in full: ${error instanceof Error ? error.message : String(error)}`);
    try { db?.close(); } catch { /* already unusable */ }
    return undefined;
  }
  const open = db;
  return {
    claim: (id, rev) => {
      try {
        const result = open.prepare(`INSERT INTO observations (type, id, rev, context_id, seen_at) VALUES ('sender', ?, ?, ?, ?)
          ON CONFLICT (type, id) DO UPDATE SET rev = excluded.rev, context_id = excluded.context_id, seen_at = excluded.seen_at
          WHERE observations.rev IS NOT excluded.rev OR observations.context_id IS NOT excluded.context_id`)
          .run(id, rev, contextId, Date.now());
        return Number(result.changes) === 1;
      } catch {
        return true;
      }
    },
    release: (claimed) => {
      for (const { id, rev } of claimed) {
        try {
          open.prepare("DELETE FROM observations WHERE type = 'sender' AND id = ? AND rev = ? AND context_id = ?").run(id, rev, contextId);
        } catch {
          // Best-effort: a leftover only hides the description once in this context.
        }
      }
    },
    close: () => {
      try { open.close(); } catch { /* nothing to do */ }
    },
  };
}

/** One sender mention in display order: the thread-join parent, its recent replies, then the message. */
interface SenderRef {
  type: string;
  name: string;
  description: string | null | undefined;
  timezone: string | null | undefined;
  drop: () => void;
}

/**
 * Drops descriptions already shown in this context from `messages`, in the
 * order the runtime input renders them. Returns new message objects; the
 * inputs are not mutated (they stay queued for a retry).
 */
export function elideSeenSendersInMessages(
  messages: readonly AgentMessage[],
  claim: SenderClaim,
): { messages: AgentMessage[]; claimed: Array<{ id: string; rev: string }> } {
  const copies = messages.map((message) => {
    const copy: AgentMessage = { ...message };
    if (message.thread_join_context) {
      copy.thread_join_context = {
        ...message.thread_join_context,
        parent_message: { ...message.thread_join_context.parent_message },
        recent_messages: message.thread_join_context.recent_messages.map((m) => ({ ...m })),
      };
    }
    return copy;
  });
  const refs: SenderRef[] = [];
  for (const copy of copies) {
    const join = copy.thread_join_context;
    if (join) {
      for (const m of [join.parent_message, ...join.recent_messages]) {
        refs.push({ type: m.sender_type, name: m.sender_name, description: m.sender_description, timezone: m.sender_timezone, drop: () => { m.sender_description = null; m.sender_timezone = null; } });
      }
    }
    refs.push({ type: copy.sender_type, name: copy.sender_name, description: copy.sender_description, timezone: copy.sender_timezone, drop: () => { copy.sender_description = null; copy.sender_timezone = null; } });
  }
  const { claimed } = elideSeenSenderDescriptions(
    refs,
    {
      get: (ref) => ({ type: ref.type, name: ref.name, description: ref.description, timezone: ref.timezone }),
      withoutDescription: (ref) => {
        ref.drop();
        return ref;
      },
    },
    claim,
  );
  return { messages: copies, claimed };
}
