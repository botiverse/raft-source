// What a `message read` (history) window records as consumed (moved from the
// CLI's commands/message/read.ts).
//
// FH-001 full-body advance contract (A), contiguous history-read slice:
// 1. A command that returns full message bodies to the current agent can
//    advance client_seen. The server marks a high-water boundary only when
//    the window joins the prior cursor without a hidden gap; otherwise each
//    returned seq is recorded exactly. Target-scoped: DM/channel/thread each
//    own their own evidence; a thread read never advances its parent.
// 2. Empty read ("No messages") does not advance or fabricate a boundary.
// 3. Monotonic forward only: browsing older seq < cursor never lowers it.
// 4. Passive receipt/wake hint/inbox preflight/thread-follow notices never
//    advance (FH-EXT-001). Only active body-returning reads advance.
// 5. Preview/snippet search is non-consuming. Full-body resolve is a
//    follow-up: a single high seq cannot safely become a max boundary
//    without contiguity or seen-set semantics.

import type { MaybePromise } from "../../maybePromise";
import { canonicalizeConsumedTarget, type ConsumedSeqLedger } from "./consumedSeqs";
import { andThen } from "./maybe";

/** The fields of a history response the recording rules read. */
export interface HistoryReadRecordInput {
  /** The target as the caller wrote it (after `--peer-kind`). */
  requestedTarget: string;
  around?: string;
  after?: string;
  data: {
    target?: unknown;
    messages?: ReadonlyArray<{ seq?: unknown }>;
    last_read_seq?: unknown;
    has_older?: unknown;
    model_seen_up_to_seq?: unknown;
  };
}

export type HistoryReadRecord =
  | { kind: "read"; seq?: number }
  | { kind: "exact"; seqs: number[] };

export interface HistoryReadPlan {
  /** Canonical evidence key the window is recorded under. */
  target: string;
  /** Typed spelling → canonical target. */
  alias: { spelling: string; canonical: string };
  /** What the window consumed. */
  record: HistoryReadRecord;
}

/**
 * The read-boundary rules as data. Null: the window has no trustworthy target
 * identity, so nothing (not even the alias) is recorded.
 */
export function planHistoryReadRecording(input: HistoryReadRecordInput): HistoryReadPlan | null {
  const { data } = input;
  const rows = data.messages ?? [];
  // Target identity comes from the resolver, never from a rendered message
  // row. History envelopes intentionally omit channel identity fields; CLI
  // 0.0.28 fed such a row to `formatTarget`, produced `#undefined`, and then
  // aliased every channel/thread/DM to that single evidence key.
  //
  // Older servers do not return `target`. Falling back to the requested
  // spelling may split two legal thread aliases, but that is fail-closed (an
  // extra freshness hold) rather than borrowing another target's evidence.
  const resolvedTarget = typeof data.target === "string" ? data.target : input.requestedTarget;
  const canonicalRecordTarget = canonicalizeConsumedTarget(resolvedTarget);
  if (!canonicalRecordTarget) return null;
  const alias = { spelling: input.requestedTarget, canonical: canonicalRecordTarget };

  const exactSeqs = rows
    .map((row) => row.seq)
    .filter((seq): seq is number => typeof seq === "number" && Number.isInteger(seq) && seq > 0);
  // `--around` is an anchored context lookup, not a read-through boundary.
  // It can expose a high seq while leaving surrounding unread context outside
  // the returned window, so retain only exact observations from it.
  if (input.around !== undefined) {
    return { target: canonicalRecordTarget, alias, record: { kind: "exact", seqs: exactSeqs } };
  }
  const minSeq = exactSeqs.length > 0 ? Math.min(...exactSeqs) : 0;
  const maxSeq = exactSeqs.length > 0 ? Math.max(...exactSeqs) : 0;
  const priorReadSeq = Math.max(0, Number(data.last_read_seq) || 0);
  const numericAfter = input.after && /^\d+$/.test(input.after)
    ? Number(input.after)
    : undefined;
  // Old servers do not return model_seen_up_to_seq. Preserve their safe
  // cases locally, but fail closed for an anchored/gapped window.
  const inferredLegacyBoundary = input.after !== undefined
    ? numericAfter !== undefined && numericAfter <= priorReadSeq ? maxSeq : null
    : !data.has_older || minSeq <= priorReadSeq ? maxSeq : null;
  const modelSeenUpToSeq = "model_seen_up_to_seq" in data
    ? data.model_seen_up_to_seq
    : inferredLegacyBoundary;
  if (typeof modelSeenUpToSeq === "number" && Number.isInteger(modelSeenUpToSeq) && modelSeenUpToSeq > 0) {
    return { target: canonicalRecordTarget, alias, record: { kind: "read", seq: modelSeenUpToSeq } };
  }
  if (exactSeqs.length === 0) {
    return { target: canonicalRecordTarget, alias, record: { kind: "read" } };
  }
  return { target: canonicalRecordTarget, alias, record: { kind: "exact", seqs: exactSeqs } };
}

/** Apply a plan: the alias first, then the consumption record. */
export function recordHistoryRead(ledger: ConsumedSeqLedger, plan: HistoryReadPlan | null): MaybePromise<void> {
  if (!plan) return;
  return andThen(ledger.recordTargetAlias(plan.alias.spelling, plan.alias.canonical), () => {
    const { record } = plan;
    if (record.kind === "exact") return ledger.recordConsumedExactSeqs({ [plan.target]: record.seqs });
    return record.seq === undefined
      ? ledger.recordConsumedRead(plan.target)
      : ledger.recordConsumedRead(plan.target, record.seq);
  });
}
