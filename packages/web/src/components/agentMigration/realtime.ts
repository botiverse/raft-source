import {
  agentMigrationUpdatedPayloadSchema,
  clearClockTimeout,
  setClockTimeout,
} from "@botiverse/raft-shared";
import type {
  AgentMigrationHostedImportSummary,
  AgentMigrationSourceBuildProgress,
  AgentMigrationSourceDrain,
  AgentMigrationTargetKind,
  AgentMigrationTransferProgress,
} from "@botiverse/raft-shared";
import { isActiveMigrationState } from "./state";
import type { AgentMigrationState } from "./state";

export interface AgentMigrationNotice {
  agentId: string;
  migrationRef: string;
  state: AgentMigrationState;
  revision: number;
  sourceMachineId?: string;
  // REST only, like the deadlines below. `hosted` has no target machine.
  targetKind?: AgentMigrationTargetKind;
  targetMachineId?: string | null;
  failureReason?: string | null;
  abortReason?: string | null;
  // REST only. `GET /agents/:id/migration` sends these; the realtime payload
  // (`agentMigrationUpdatedPayloadSchema`, `.strict()`) does not, so a notice
  // refreshed over the socket can legitimately lack them. Treat as absent-able.
  prepDeadlineAt?: string | null;
  transferDeadlineAt?: string | null;
  arrivalDeadlineAt?: string | null;
  transportErrorCode?: string | null;
  transportErrorMessage?: string | null;
  transportLostAt?: string | null;
  transportProvisionFailedAt?: string | null;
  transportProvisionedAt?: string | null;
  // Source finished packing and registered the bundle; upload follows.
  transportControlRegisteredAt?: string | null;
  sourceQuiescedAt?: string | null;
  // REST only: until when the source waits for the agent to finish its current
  // work before it stops it (null once quiesced, or when it stops at once).
  sourceDrainUntil?: string | null;
  // REST only: what the draining source waits for, and until when (within
  // sourceDrainUntil). Null once quiesced or packing, or when it never reported.
  sourceDrain?: AgentMigrationSourceDrain | null;
  sourceBuildProgress?: AgentMigrationSourceBuildProgress | null;
  // REST only: what the target has downloaded while the state is ready/in_transit.
  transferProgress?: AgentMigrationTransferProgress | null;
  readyAt?: string | null;
  flippedAt?: string | null;
  arrivedAt?: string | null;
  completedAt?: string | null;
  abortedAt?: string | null;
  canceledAt?: string | null;
  cancelDisposition?: "pre_flip_source_authoritative" | "post_flip_target_authoritative" | null;
  cancelReason?: string | null;
  cancelNeedsAttention?: boolean;
  cancelDispatchAttempts?: number;
  cancelLastDispatchAt?: string | null;
  cancelAttentionDeadlineAt?: string | null;
  cancelErrorCode?: string | null;
  cancelErrorMessage?: string | null;
  cancelSourceAcknowledgedAt?: string | null;
  cancelSourceOutcome?: "cleaned" | "stopped" | "needs_attention" | null;
  cancelTargetAcknowledgedAt?: string | null;
  cancelTargetOutcome?: "cleaned" | "stopped" | "needs_attention" | null;
  createdAt?: string;
  updatedAt?: string;
  // REST only: who started it, while they are still a member of this server.
  initiatedBy?: { id: string; name: string; displayName: string | null } | null;
  // REST only, and only for a move to the cloud: the review the user confirms.
  hosted?: AgentMigrationHostedReview | null;
  // REST only: the agent's own retry of a migration that failed for size
  // (`raft migration retry`, run on behalf of its starter). Null or absent for
  // a migration a person started (and from servers before the retry).
  retryOfMigrationId?: string | null;
  triggeredByAgentId?: string | null;
  retryComparison?: AgentMigrationRetryComparison | null;
}

/**
 * For a retry: what the failed attempt measured (its entry count, or for a
 * too-large bundle the bytes packed before it stopped, a lower bound) next to
 * what this attempt packs (`final` once the bundle is registered). Mirrors the
 * server's agentMigrationRetryComparison.
 */
export interface AgentMigrationRetryComparison {
  previousFailure: {
    code: string;
    entries: number | null;
    bytes: number | null;
    bytesIsLowerBound: boolean;
  } | null;
  packed: { files: number; bytes: number; final: boolean } | null;
}

export interface AgentMigrationHostedReview {
  provider?: string;
  hostedModel?: string | null;
  reviewReadyAt: string | null;
  reviewConfirmedAt: string | null;
  importSummary: AgentMigrationHostedImportSummary | null;
}

export interface AgentMigrationStatusResponse {
  migration: AgentMigrationNotice | null;
}

export type AgentMigrationReadModel = AgentMigrationStatusResponse;

export const EMPTY_AGENT_MIGRATION_READ_MODEL: AgentMigrationReadModel = {
  migration: null,
};

export function applyAgentMigrationSnapshot(
  snapshot: AgentMigrationStatusResponse,
): AgentMigrationReadModel {
  return { migration: snapshot.migration };
}

export type AgentMigrationRealtimeSocket = {
  connected: boolean;
  on: (event: string, handler: (payload?: unknown) => void) => unknown;
  off: (event: string, handler: (payload?: unknown) => void) => unknown;
};

type TimerHandle = unknown;

export interface AgentMigrationRealtimeSync {
  start(): void;
  stop(): void;
  refreshLatestMigration(): Promise<void>;
  debugState(): {
    pollScheduled: boolean;
    requestInFlight: boolean;
    refreshQueued: boolean;
    latestRequest: number;
  };
}

export function createAgentMigrationRealtimeSync(options: {
  agentId: string;
  socket: AgentMigrationRealtimeSocket;
  readLatestMigration: () => Promise<AgentMigrationStatusResponse>;
  applySnapshot: (snapshot: AgentMigrationStatusResponse) => void;
  onError: (error: unknown) => void;
  onHealthy: () => void;
  pollMs?: number;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
}): AgentMigrationRealtimeSync {
  const pollMs = options.pollMs ?? 2_000;
  const schedule = options.schedule ?? ((callback, delayMs) => setClockTimeout(callback, delayMs));
  const cancel = options.cancel ?? clearClockTimeout;
  let stopped = true;
  let pollTimer: TimerHandle | null = null;
  let inFlight: Promise<void> | null = null;
  let refreshQueued = false;
  let requestSequence = 0;
  let latestRequest = 0;
  let pollingActive = false;

  const clearPoll = () => {
    if (pollTimer !== null) cancel(pollTimer);
    pollTimer = null;
  };

  const schedulePoll = () => {
    clearPoll();
    if (stopped) return;
    pollTimer = schedule(() => {
      pollTimer = null;
      void refreshLatestMigration();
    }, pollMs);
  };

  const runRead = async (): Promise<void> => {
    const request = ++requestSequence;
    latestRequest = request;
    try {
      const snapshot = await options.readLatestMigration();
      if (stopped || request !== latestRequest) return;
      options.applySnapshot(snapshot);
      options.onHealthy();
      pollingActive = Boolean(snapshot.migration && isActiveMigrationState(snapshot.migration.state));
      if (pollingActive) schedulePoll();
      else clearPoll();
    } catch (error) {
      if (!stopped && request === latestRequest) {
        options.onError(error);
        if (pollingActive) schedulePoll();
      }
    }
  };

  const refreshLatestMigration = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) {
      refreshQueued = true;
      await inFlight;
      return;
    }
    clearPoll();
    const cycle = (async () => {
      do {
        refreshQueued = false;
        await runRead();
      } while (!stopped && refreshQueued);
    })();
    inFlight = cycle;
    try {
      await cycle;
    } finally {
      if (inFlight === cycle) inFlight = null;
    }
  };

  const handleInvalidate = () => {
    void refreshLatestMigration();
  };
  const handleMigrationEvent = (raw: unknown) => {
    const parsed = agentMigrationUpdatedPayloadSchema.safeParse(raw);
    if (!parsed.success || parsed.data.agentId !== options.agentId) return;
    handleInvalidate();
  };

  const start = () => {
    if (!stopped) return;
    stopped = false;
    options.socket.on("connect", handleInvalidate);
    options.socket.on("rooms:joined", handleInvalidate);
    options.socket.on("agent:migration-updated", handleMigrationEvent);
    handleInvalidate();
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    latestRequest = ++requestSequence;
    refreshQueued = false;
    pollingActive = false;
    clearPoll();
    options.socket.off("connect", handleInvalidate);
    options.socket.off("rooms:joined", handleInvalidate);
    options.socket.off("agent:migration-updated", handleMigrationEvent);
  };

  return {
    start,
    stop,
    refreshLatestMigration,
    debugState: () => ({
      pollScheduled: pollTimer !== null,
      requestInFlight: inFlight !== null,
      refreshQueued,
      latestRequest,
    }),
  };
}
