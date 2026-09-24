import {
  agentMigrationUpdatedPayloadSchema,
  clearClockTimeout,
  setClockTimeout,
} from "@botiverse/raft-shared";

export interface AgentMigrationNotice {
  agentId: string;
  migrationRef: string;
  state: string;
  revision: number;
  sourceMachineId?: string;
  targetMachineId?: string;
  failureReason?: string | null;
  abortReason?: string | null;
  transportErrorCode?: string | null;
  transportErrorMessage?: string | null;
  transportLostAt?: string | null;
  transportProvisionFailedAt?: string | null;
  transportProvisionedAt?: string | null;
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

function isActiveMigrationState(state: string): boolean {
  return [
    "provisioning",
    "prep",
    "ready",
    "in_transit",
    "arriving",
    "starting",
    "cancel_requested_pre_flip",
    "cancel_requested_post_flip",
  ].includes(state.toLowerCase());
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
