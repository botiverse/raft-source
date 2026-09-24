import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";

export interface ReconnectAwareSocket {
  on(event: "connect", listener: () => void): void;
  off(event: "connect", listener: () => void): void;
}

export interface ActivityAwareSocket {
  on(event: "agent:activity", listener: (payload: AgentActivityReloadPayload) => void): void;
  off(event: "agent:activity", listener: (payload: AgentActivityReloadPayload) => void): void;
}

export interface AgentActivityReloadPayload {
  agentId?: string;
  entries?: unknown[];
  isHeartbeat?: boolean;
  isRefreshOnly?: boolean;
}

interface RegisterActivityTrajectoryReconnectReloadOptions {
  socket: ReconnectAwareSocket;
  agentId: string;
  loadTrajectoryLog: (agentId: string, limit?: number) => Promise<void>;
  limit?: number;
  debounceMs?: number;
}

/**
 * Keep the durable activity tab self-healing across socket reconnects.
 *
 * The live `agent:activity` stream only appends trajectory entries while the
 * socket stays healthy. If the socket disconnects while the activity tab is
 * open, we need an explicit reconnect reload to fill any missed durable
 * entries back from `/agents/:id/activity-log`.
 */
export function registerActivityTrajectoryReconnectReload({
  socket,
  agentId,
  loadTrajectoryLog,
  limit,
  debounceMs = 500,
}: RegisterActivityTrajectoryReconnectReloadOptions) {
  let isFirstConnect = true;
  let inFlight = false;
  let debounceTimer: unknown | null = null;

  const runReload = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await loadTrajectoryLog(agentId, limit);
    } finally {
      inFlight = false;
    }
  };

  const handleReconnect = () => {
    if (isFirstConnect) {
      isFirstConnect = false;
      return;
    }
    if (debounceTimer) {
      clearClockTimeout(debounceTimer);
    }
    debounceTimer = setClockTimeout(() => {
      debounceTimer = null;
      void runReload();
    }, debounceMs);
  };

  socket.on("connect", handleReconnect);

  return () => {
    socket.off("connect", handleReconnect);
    if (debounceTimer) {
      clearClockTimeout(debounceTimer);
      debounceTimer = null;
    }
  };
}

interface RegisterActivityTrajectoryLiveReloadOptions {
  socket: ActivityAwareSocket;
  agentId: string;
  loadTrajectoryLog: (agentId: string, limit?: number) => Promise<void>;
  limit?: number;
  debounceMs?: number;
}

/**
 * Fill the active durable activity tab when live status frames omit trajectory
 * entries. Frames with entries are already appended by the main socket bridge;
 * heartbeat/probe refresh frames only refresh the current status snapshot.
 */
export function registerActivityTrajectoryLiveReload({
  socket,
  agentId,
  loadTrajectoryLog,
  limit,
  debounceMs = 250,
}: RegisterActivityTrajectoryLiveReloadOptions) {
  let inFlight = false;
  let pending = false;
  let debounceTimer: unknown | null = null;

  const runReload = async () => {
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    try {
      await loadTrajectoryLog(agentId, limit);
    } finally {
      inFlight = false;
      if (pending) {
        pending = false;
        void runReload();
      }
    }
  };

  const scheduleReload = () => {
    if (debounceTimer) {
      clearClockTimeout(debounceTimer);
    }
    debounceTimer = setClockTimeout(() => {
      debounceTimer = null;
      void runReload();
    }, debounceMs);
  };

  const handleActivity = (payload: AgentActivityReloadPayload) => {
    if (payload?.agentId !== agentId) return;
    if (payload.isHeartbeat === true || payload.isRefreshOnly === true) return;
    if (Array.isArray(payload.entries) && payload.entries.length > 0) return;
    scheduleReload();
  };

  socket.on("agent:activity", handleActivity);

  return () => {
    socket.off("agent:activity", handleActivity);
    if (debounceTimer) {
      clearClockTimeout(debounceTimer);
      debounceTimer = null;
    }
  };
}
