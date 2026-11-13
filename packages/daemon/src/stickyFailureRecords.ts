/**
 * Reconciler step 12 (#proj-raft-computer:#48, rows C8-C11; Tenny msg
 * 96fa8766): a failure a runtime reports after it started, which a new
 * message would only repeat. Neither host keeps a terminal record for it any
 * more (those are RFC 071's `refuseUnreliableSpawn` only): the session is
 * replaced once (C8, a compaction failure), or the agent is given back to the
 * server with a typed start-failure reason that pauses automatic wakes at the
 * first report (C9, C11, the crash-streak cap). What the daemon itself keeps
 * per agent, in the store both agent hosts share (`ExitStreaks.sticky`):
 *
 * - the session reset: the daemon started a new session after the old one no
 *   longer fit the model (input too large, a failed compaction). Until a turn
 *   of the agent completes with model output, or a person stops it, the same
 *   failure again is not met with another new session: it is handed to the
 *   server as `session_needs_reset` (a person resets it).
 * - the unusable model: the runtime said it cannot use the agent's model.
 *   The daemon does not start the agent on that runtime and model itself
 *   until its runtime or model changes, its credentials change, a turn on it
 *   produces model output, or a person stops it (as `user_model_access` on
 *   the credential ledger).
 *
 * Memory only: a daemon restart forgets it.
 */
import type { SpawnFailureReason } from "@botiverse/raft-shared";

/** Why the daemon replaced the agent's session (`agent:session:invalidate` reason). */
export type SessionResetCause = "input_too_large" | "compaction_failed";

/** The runtime and model the runtime said it cannot use. */
export interface UnusableModel {
  runtime: string;
  model: string | null;
}

export class StickyFailureRecords {
  private readonly sessionResets = new Map<string, SessionResetCause>();
  private readonly unusableModels = new Map<string, UnusableModel>();

  /** The daemon replaced the agent's session and no turn has completed in the new one yet. */
  sessionReset(agentId: string): SessionResetCause | null {
    return this.sessionResets.get(agentId) ?? null;
  }

  noteSessionReset(agentId: string, cause: SessionResetCause): void {
    this.sessionResets.set(agentId, cause);
  }

  /** A turn completed with model output, or a person stopped the agent; true if there was one. */
  endSessionReset(agentId: string): boolean {
    return this.sessionResets.delete(agentId);
  }

  noteUnusableModel(agentId: string, model: UnusableModel): void {
    this.unusableModels.set(agentId, { runtime: model.runtime, model: model.model ?? null });
  }

  /** The agent's runtime said it cannot use `model` on `runtime`. */
  isUnusableModel(agentId: string, runtime: string, model: string | null | undefined): boolean {
    const record = this.unusableModels.get(agentId);
    return Boolean(record && record.runtime === runtime && record.model === (model ?? null));
  }

  /** The agent now runs `runtime` and `model`: a record about another one goes. True if one went. */
  forgetUnusableModelUnless(agentId: string, runtime: string, model: string | null | undefined): boolean {
    if (!this.unusableModels.has(agentId) || this.isUnusableModel(agentId, runtime, model)) return false;
    return this.unusableModels.delete(agentId);
  }

  /** Model output, a credentials change, a person's stop. True if there was one. */
  forgetUnusableModel(agentId: string): boolean {
    return this.unusableModels.delete(agentId);
  }

  /** The agents with an unusable-model record (a credentials change clears those on its runtime). */
  unusableModelAgents(): Array<[agentId: string, model: UnusableModel]> {
    return [...this.unusableModels.entries()];
  }

  /** A person's stop: both go. */
  forget(agentId: string): void {
    this.sessionResets.delete(agentId);
    this.unusableModels.delete(agentId);
  }
}

/**
 * The start-failure reason a sticky failure is reported with. A server that
 * advertises SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1 counts
 * `model_unsupported` and `runtime_repeated_failure`; an older one drops a
 * reason it does not know, so it gets `runtime_spawn_failed`.
 * `session_needs_reset` is older than step 12 and always sent.
 */
export function reportedStickyFailureReason(
  reason: Extract<SpawnFailureReason, "model_unsupported" | "runtime_repeated_failure" | "session_needs_reset">,
  serverCountsStickyReasons: boolean,
): SpawnFailureReason {
  if (reason === "session_needs_reset" || serverCountsStickyReasons) return reason;
  return "runtime_spawn_failed";
}
