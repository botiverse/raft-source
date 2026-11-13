// `cli.draft.resolved`: how a held send's local draft ended. One span per
// draft (one idempotency key), written to the CLI trace file the daemon ships
// (transportTrace.ts). Baseline for comparing held drafts with continuations;
// it never changes what the command does.
//
// `cli.draft.held`: a send the server held saved its draft. One span per hold
// (a `--send-draft` held again repeats the draft's `draft_id` with a higher
// `rehold_count`), so the drafts that never end, which no `resolved` span
// shows, are the held ones without a later `resolved` of the same `draft_id`:
// the same measure as a continuation created and never answered.
//
// A draft counts as held once the server has held its send (`reholdCount` >= 1,
// carried over when a normal send replaces it). The pre-send copy every send
// writes, and a failed send's leftover, are not held drafts and emit nothing.
// A send whose outcome is unknown (failure, ambiguity) emits nothing either, so
// every count read from this span is a lower bound.
//
// `cause` says why the draft that ended was waiting. A thread-context
// confirmation saves the new send as the target's draft and inherits the
// rehold count of the held draft it replaces, so it counts as held without the
// server having held it: `thread_confirmation` tells those apart. A draft saved
// without a cause (older CLIs) is `held`.
//
// Two rare paths end one draft twice (dedupe on `draft_id`, first span wins):
// - an expired draft whose delete fails is reported `expired` again on the
//   next lookup (shared seenPolicy/drafts.ts, best-effort delete);
// - when the pre-send save fails, a replacing send that commits reports the
//   old draft `replaced_and_sent` although it stays saved and can end again.
import { createHash } from "node:crypto";
import { parseAgentTaskRef } from "@botiverse/raft-shared/src/agentCliSurface";

import { cliTraceRuntime, emitCliTraceSpan } from "../../transportTrace";
import { getParentTargetForThread } from "./_consumedSeqState";
import type { SavedDraftCause } from "./_continueDraftState";

export type DraftResolvedOutcome =
  /** `--send-draft` sent it. */
  | "sent_unchanged"
  /** A normal send to the same target replaced it and was sent. */
  | "replaced_and_sent"
  /** A normal send replaced it and was held again: the new draft replaces this one. */
  | "superseded"
  /** `--discard-draft` deleted it. */
  | "discarded"
  /** A lookup found it past its TTL (lazy: only when the target's draft is next read). */
  | "expired";

export type CliTraceTargetKind = "channel" | "dm" | "thread" | "task" | "unknown";

/** The draft fields this span reads: never its body, attachments or mentions. */
export interface ResolvedDraft {
  idempotencyKey?: string;
  savedAt: number;
  reholdCount: number;
  cause?: SavedDraftCause;
}

export interface DraftTraceScope {
  agentId: string;
  serverId?: string | null;
  env: NodeJS.ProcessEnv;
  /** Classified into `target_kind`; the target itself is never written. */
  target: string;
}

export function isHeldDraft(draft: Pick<ResolvedDraft, "reholdCount">): boolean {
  return draft.reholdCount >= 1;
}

/**
 * Stable per-draft id derived from the idempotency key. Not the key itself:
 * the key, with its target, reconciles to the sent message's id through the
 * agent API, so the raw key would carry a message id in all but name.
 */
export function draftTraceId(idempotencyKey: string): string {
  return createHash("sha256").update(`cli.draft:${idempotencyKey}`, "utf8").digest("hex").slice(0, 16);
}

export function traceTargetKind(target: string): CliTraceTargetKind {
  if (parseAgentTaskRef(target)) return "task";
  if (getParentTargetForThread(target) !== null) return "thread";
  if (target.startsWith("dm:")) return "dm";
  if (target.startsWith("#")) return "channel";
  return "unknown";
}

/** A send the server held saved its draft (`draft.reholdCount` is this hold's count). */
export function emitDraftHeld(scope: DraftTraceScope, draft: ResolvedDraft): void {
  try {
    if (!isHeldDraft(draft)) return;
    emitCliTraceSpan(
      "cli.draft.held",
      {
        producer: "cli",
        cause: draft.cause ?? "held",
        draft_id: draft.idempotencyKey ? draftTraceId(draft.idempotencyKey) : undefined,
        target_kind: traceTargetKind(scope.target),
        rehold_count: draft.reholdCount,
        runtime: cliTraceRuntime(scope.env),
        serverId: scope.serverId,
        agentId: scope.agentId,
      },
      { status: "ok", kind: "internal" },
      scope.env,
    );
  } catch {
    // Tracing must never affect the user-visible CLI command result.
  }
}

export function emitDraftResolved(
  scope: DraftTraceScope,
  draft: ResolvedDraft,
  outcome: DraftResolvedOutcome,
  nowMs: number = Date.now(),
): void {
  try {
    if (!isHeldDraft(draft)) return;
    emitCliTraceSpan(
      "cli.draft.resolved",
      {
        producer: "cli",
        outcome,
        cause: draft.cause ?? "held",
        draft_id: draft.idempotencyKey ? draftTraceId(draft.idempotencyKey) : undefined,
        target_kind: traceTargetKind(scope.target),
        // Since the draft was last saved: a `--send-draft` that is held again
        // re-saves the same draft, so a re-held draft counts from its last hold.
        held_ms: Math.max(0, Math.round(nowMs - draft.savedAt)),
        rehold_count: draft.reholdCount,
        runtime: cliTraceRuntime(scope.env),
        serverId: scope.serverId,
        agentId: scope.agentId,
      },
      { status: "ok", kind: "internal" },
      scope.env,
    );
  } catch {
    // Tracing must never affect the user-visible CLI command result.
  }
}
