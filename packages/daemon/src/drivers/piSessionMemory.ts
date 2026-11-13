import { statSync } from "node:fs";

// How much transcript the pi sessions in this process hold (pi and Built-in run
// in-process), for the `daemon.process.memory` event. pi keeps every entry of a
// session in memory, including entries a compaction has already summarized, so
// a long-lived session grows with its whole history (pi#10642). These attrs let
// the fleet line session size up against heapUsed before anything acts on it.
//
// Only counts and sizes leave this module, never entry contents or file paths.
// Sessions are held weakly: counting a session must never keep it alive.

/** The parts of pi's SessionManager read here. */
export interface PiSessionMemorySource {
  getEntryCount(): number;
  getSessionFile(): string | undefined;
  getHeader(): { timestamp: string } | null;
}

const liveSessions = new Set<WeakRef<{ readonly sessionManager: PiSessionMemorySource }>>();

/**
 * Count a pi session until the returned function is called (on dispose). Takes
 * the AgentSession rather than its SessionManager, so a manager it swaps in
 * later is the one measured.
 */
export function trackPiSessionMemory(session: { readonly sessionManager: PiSessionMemorySource }): () => void {
  const ref = new WeakRef(session);
  liveSessions.add(ref);
  return () => {
    liveSessions.delete(ref);
  };
}

export const PI_SESSION_MEMORY_TRACE_ATTRS = [
  "pi_session_count",
  "pi_session_entry_count",
  "pi_session_kb",
  "pi_largest_session_entry_count",
  "pi_largest_session_kb",
  "pi_oldest_session_age_ms",
] as const;

type PiSessionMemoryAttr = (typeof PI_SESSION_MEMORY_TRACE_ATTRS)[number];

/**
 * Totals over the live pi sessions. Size is the session's JSONL file, which pi
 * appends one line per entry; a session that has not written its file yet (pi
 * defers it to the first message) counts as 0 KB. The largest session is the
 * largest by size. Age runs from the session header's creation time, which a
 * resume keeps, not from when this process opened it. After a rotation, the
 * age counts from the rotation time (the rotated file's header is new).
 */
export function piSessionMemoryAttrs(
  nowMs: number,
  fileSize: (file: string) => number = (file) => statSync(file).size,
): Partial<Record<PiSessionMemoryAttr, number>> {
  let count = 0;
  let entries = 0;
  let bytes = 0;
  let largestBytes = -1;
  let largestEntries = 0;
  let oldestCreatedMs = Number.POSITIVE_INFINITY;
  for (const ref of liveSessions) {
    const session = ref.deref();
    if (!session) {
      liveSessions.delete(ref);
      continue;
    }
    try {
      const manager = session.sessionManager;
      const sessionEntries = manager.getEntryCount();
      let sessionBytes = 0;
      const file = manager.getSessionFile();
      if (file) {
        try {
          sessionBytes = fileSize(file);
        } catch {
          // Not written yet, or removed under us: no size to report.
        }
      }
      count++;
      entries += sessionEntries;
      bytes += sessionBytes;
      if (sessionBytes > largestBytes) {
        largestBytes = sessionBytes;
        largestEntries = sessionEntries;
      }
      const createdMs = Date.parse(manager.getHeader()?.timestamp ?? "");
      if (Number.isFinite(createdMs) && createdMs < oldestCreatedMs) oldestCreatedMs = createdMs;
    } catch {
      // A session mid-dispose must not break the memory event.
    }
  }
  if (count === 0) return { pi_session_count: 0 };
  return {
    pi_session_count: count,
    pi_session_entry_count: entries,
    pi_session_kb: Math.round(bytes / 1024),
    pi_largest_session_entry_count: largestEntries,
    pi_largest_session_kb: Math.round(largestBytes / 1024),
    ...(Number.isFinite(oldestCreatedMs) ? { pi_oldest_session_age_ms: Math.max(0, nowMs - oldestCreatedMs) } : {}),
  };
}
