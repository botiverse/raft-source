// Read-only int4 headroom tripwire (zero-DB stopgap, 2026-07-30 thread ruling).
//
// The read-cursor lane stores message seqs in int4 columns; the int64 widen is
// frozen (schema freeze) and was reverted with #5712. This tripwire exists so
// the frozen work is REOPENED BEFORE the ceiling is reachable, instead of being
// rediscovered as a production outage at seq 2147483648. It performs a single
// read-only MAX(seq) probe, throttled off the existing /health polling — no
// schema, no writes, no new infrastructure.
import { currentTimeMs } from "@botiverse/raft-shared";
import { sql } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { messages } from "../db/schema.js";

export const INT4_MAX = 2147483647;

// WARN early enough that a multi-week migration project fits comfortably in
// the remaining runway; CRITICAL is "stop and widen now".
export const SEQ_HEADROOM_WARN_RATIO = 0.5;
export const SEQ_HEADROOM_CRITICAL_RATIO = 0.8;

export type SeqHeadroomLevel = "ok" | "warn" | "critical";

export function classifySeqHeadroom(maxSeq: number): SeqHeadroomLevel {
  if (maxSeq >= INT4_MAX * SEQ_HEADROOM_CRITICAL_RATIO) return "critical";
  if (maxSeq >= INT4_MAX * SEQ_HEADROOM_WARN_RATIO) return "warn";
  return "ok";
}

const PROBE_INTERVAL_MS = 10 * 60 * 1000;
let lastProbeAtMs = 0;

/**
 * Throttled, fail-open probe. Never throws and never delays the caller's
 * response path: /health must stay a pure DB-connectivity signal. The alert
 * channel is a structured log line (CloudWatch-searchable `seq_headroom`).
 */
export function probeSeqHeadroom(nowMs: number = currentTimeMs()): void {
  if (nowMs - lastProbeAtMs < PROBE_INTERVAL_MS) return;
  lastProbeAtMs = nowMs;
  void (async () => {
    try {
      const rows = await getDb()
        .select({ maxSeq: sql<string>`COALESCE(MAX(${messages.seq}), 0)::text` })
        .from(messages);
      const maxSeq = Number(rows[0]?.maxSeq ?? "0");
      const level = classifySeqHeadroom(maxSeq);
      if (level !== "ok") {
        console.error(
          `seq_headroom level=${level} maxSeq=${maxSeq} int4Max=${INT4_MAX} ` +
            `ratio=${(maxSeq / INT4_MAX).toFixed(3)} ` +
            "action=reopen the frozen read-cursor int4->int8 widen (see #5712 revert / task #361)",
        );
      }
    } catch (err) {
      // Fail-open by contract: a broken probe must not become a health issue.
      console.warn("seq_headroom probe failed (fail-open):", (err as Error).message);
    }
  })();
}

/** Test seam: reset the throttle without reaching into module state. */
export function resetSeqHeadroomThrottleForTest(): void {
  lastProbeAtMs = 0;
}
