// Shared read-state frontier contract for the three inbox unread exits
// (#632 SSOT fix — frozen in #proj-sync-core 19:14–19:19 UTC, task #384).
//
// Every server exit that reports unread state (/channels/inbox,
// /channels/unread, /channels + /channels/dm) constructs THIS type via the
// single total constructor below, and the single client helper resolves read
// state from it. Frozen semantics:
//   - kind:"absent"  = no read-cursor row exists for the scope. The client
//     must fail closed (never treat as read) — "no cursor" and "cursor at 0"
//     are different facts.
//   - kind:"present" = a real cursor row exists; readStateVersion 0 and
//     maxReadSeq "0" are legal VALUES and do not affect presence.
//   - kind:"corrupt" = a cursor row exists but its own version/seq facts are
//     unusable. NOT absent (an alarm state must stay visible and countable);
//     the client maps it to insufficient-data (keep current display). One bad
//     scope must never fail the whole response and must never demote to
//     absent.
//   - latestActivity is a same-source PAIR taken from one row; if either half
//     is missing or the seq is not a canonical decimal, the WHOLE pair is
//     null (fail closed; never assemble across sources).
//   - present.latestActivity === null means "no usable authoritative content
//     frontier right now" — it must NOT be interpreted as "everything read".
//
// The constructor is TOTAL: it never throws. There is deliberately no strict/
// response split in the public API — two entry points would let exits choose
// differently and re-break SSOT. Corruption reports go through the optional
// callback (exactly once per corrupt scope) with a stable reason/field only —
// never raw seq/id values.
import { isUInt64String } from "@botiverse/raft-sync-core";

export type InboxScopeReadFrontier =
  | { kind: "absent" }
  | { kind: "corrupt" }
  | {
      kind: "present";
      /** int4 in storage; 0 is a legal value, presence is NOT value-derived. */
      readStateVersion: number;
      /** Canonical decimal string (int8 domain travels as text, never JS number). */
      maxReadSeq: string;
      /** Same-source pair or null; see module contract above. */
      latestActivity: { messageId: string; seq: string } | null;
    };

// Decimal-string validation/ordering deliberately reuses the sync-core
// canonical primitives (isUInt64String / compareUInt64String) — an SSOT PR
// does not publish a second implementation of the same value domain.

/**
 * A real cursor row for the scope. The mapper constructs this ONLY when the
 * row exists; version/seq are its own columns (NOT coalesced), and the
 * latestActivity halves may each be SQL NULL (frontier is optional).
 */
export interface InboxScopeCursorRow {
  readStateVersion: number;
  maxReadSeq: string;
  latestActivityMessageId: string | null;
  latestActivitySeq: string | null;
}

/**
 * Stable, value-free corruption report: which field and why — never the raw
 * seq/id contents (log-safety discipline).
 */
export interface InboxScopeCursorCorruption {
  field: "readStateVersion" | "maxReadSeq";
  reason: "not_an_integer" | "negative" | "not_a_string" | "not_canonical_decimal";
}

/**
 * The single TOTAL constructor all exits use.
 *
 * - `cursor === null` → `{kind:"absent"}` (no cursor row for the scope).
 * - corrupt present row → `{kind:"corrupt"}` and `onCorrupt` called exactly
 *   once with a stable reason; never throws, never demotes to absent.
 * - frontier pair: both halves valid → pair; anything else → null.
 */
export function makeInboxScopeReadFrontier(
  cursor: InboxScopeCursorRow | null,
  onCorrupt?: (corruption: InboxScopeCursorCorruption) => void | PromiseLike<void>,
): InboxScopeReadFrontier {
  if (cursor === null) {
    return { kind: "absent" };
  }
  const corruption = classifyCursorCorruption(cursor);
  if (corruption !== null) {
    // Telemetry isolation: a failing sink must not break the batch — the
    // constructor is total INCLUDING its callback edge, for BOTH failure
    // shapes: a synchronous throw AND a returned/rejected thenable (an async
    // sink's rejection would otherwise surface as unhandledRejection next
    // tick and can kill the process). Called exactly once; returns corrupt
    // synchronously either way.
    try {
      const result = onCorrupt?.(corruption);
      if (result && typeof (result as PromiseLike<void>).then === "function") {
        void Promise.resolve(result).catch(() => {
          // Swallowed by contract; the corrupt verdict itself is the signal.
        });
      }
    } catch {
      // Swallowed by contract; the corrupt verdict itself is the signal.
    }
    return { kind: "corrupt" };
  }

  let latestActivity: { messageId: string; seq: string } | null = null;
  const { latestActivityMessageId: id, latestActivitySeq: seq } = cursor;
  if (id !== null && id !== "" && seq !== null && isUInt64String(seq)) {
    latestActivity = { messageId: id, seq };
  }
  // Any half-missing or invalid pair stays null — fail closed, no cross-source fill.

  return {
    kind: "present",
    readStateVersion: cursor.readStateVersion,
    maxReadSeq: cursor.maxReadSeq,
    latestActivity,
  };
}

/** Module-private strict classification — not exported as a second entry point. */
function classifyCursorCorruption(cursor: InboxScopeCursorRow): InboxScopeCursorCorruption | null {
  if (!Number.isInteger(cursor.readStateVersion)) {
    return { field: "readStateVersion", reason: "not_an_integer" };
  }
  if (cursor.readStateVersion < 0) {
    return { field: "readStateVersion", reason: "negative" };
  }
  if (typeof cursor.maxReadSeq !== "string") {
    return { field: "maxReadSeq", reason: "not_a_string" };
  }
  if (!isUInt64String(cursor.maxReadSeq)) {
    return { field: "maxReadSeq", reason: "not_canonical_decimal" };
  }
  return null;
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The single alarm-line shape for corrupt cursor rows (same family as
 * `seq_headroom`): one line, no ANSI/control characters, bounded, stable
 * prefix, CloudWatch-searchable. Exits wire it as
 * `console.error(formatInboxScopeCorruptionLine(scopeId, c))` inside their
 * onCorrupt; each exit's batch-isolation tooth asserts exactly one line.
 * Total: an invalid/hostile scope id is reported as `scope=invalid`, never
 * reflected raw.
 */
export function formatInboxScopeCorruptionLine(
  scopeId: string,
  corruption: InboxScopeCursorCorruption,
): string {
  const scope = typeof scopeId === "string" && CANONICAL_UUID.test(scopeId) ? scopeId : "invalid";
  return `inbox_cursor_corrupt scope=${scope} field=${corruption.field} reason=${corruption.reason}`;
}
