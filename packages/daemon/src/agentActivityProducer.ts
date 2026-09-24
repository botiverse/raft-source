import {
  type AgentActivityDetailKind,
  type AgentActivityKind,
  type DaemonTrajectoryEntry,
  isAgentActivityDetailKind,
  type MachineToServerMessage,
  type RuntimeErrorActivityDiagnostic,
  type TrajectoryEntry,
} from "@botiverse/raft-shared";

export type DaemonActivityInput = {
  agentId: string;
  activityKind: AgentActivityKind;
  detail: string;
  detailKind: AgentActivityDetailKind | string | undefined;
  entries?: readonly TrajectoryEntry[];
  launchId?: string;
  daemonInstanceId?: string;
  probeId?: string;
  clientSeq?: number;
  producerFactId?: string;
  observedAtMs?: number;
  isHeartbeat: boolean;
  runtimeError?: RuntimeErrorActivityDiagnostic;
};

export type DaemonActivityDrop = {
  agentId: string;
  activity: AgentActivityKind;
  detailKind: string;
  reason: "unknown_activity_detail_kind" | "non_fact_activity_detail_kind";
  isHeartbeat: boolean;
};

export type RuntimeTrajectoryKind = "thinking" | "text";

export type DaemonActivityBuildResult =
  | { ok: true; message: Extract<MachineToServerMessage, { type: "agent:activity" }>; entries?: DaemonTrajectoryEntry[] }
  | { ok: false; drop: DaemonActivityDrop };

const NON_FACT_ACTIVITY_DETAIL_KINDS = new Set<AgentActivityDetailKind>([
  "none",
  "daemon_activity",
  "external_activity",
  "slock_action",
  "other",
]);

export function normalizeDaemonActivityEntries(entries: readonly TrajectoryEntry[]): DaemonTrajectoryEntry[] {
  return entries.map((entry) => {
    if (entry.kind !== "status") return entry;
    const { activity: _activity, activityKind: _activityKind, ...rest } = entry;
    return rest;
  });
}

export function daemonActivityDropTraceAttrs(drop: DaemonActivityDrop): Record<string, unknown> {
  return {
    agentId: drop.agentId,
    activity: drop.activity,
    detail_kind: drop.detailKind,
    reason: drop.reason,
    is_heartbeat: drop.isHeartbeat,
  };
}

export function trajectoryActivityProjection(kind: RuntimeTrajectoryKind): {
  activityKind: AgentActivityKind;
  detailKind: AgentActivityDetailKind;
} {
  return kind === "thinking"
    ? { activityKind: "thinking", detailKind: "thinking_started" }
    : { activityKind: "working", detailKind: "model_response_started" };
}

export function runtimeEventEndsThinking(kind: string): boolean {
  return kind === "text"
    || kind === "tool_call"
    || kind === "tool_output"
    || kind === "compaction_started"
    || kind === "compaction_finished"
    || kind === "review_started"
    || kind === "review_finished"
    || kind === "turn_end"
    || kind === "error";
}

export function buildDaemonActivityMessage(input: DaemonActivityInput): DaemonActivityBuildResult {
  const detailKind = input.detailKind;
  if (typeof detailKind !== "string" || !isAgentActivityDetailKind(detailKind)) {
    return {
      ok: false,
      drop: {
        agentId: input.agentId,
        activity: input.activityKind,
        detailKind: typeof detailKind === "string" ? detailKind : "non_string",
        reason: "unknown_activity_detail_kind",
        isHeartbeat: input.isHeartbeat,
      },
    };
  }
  if (NON_FACT_ACTIVITY_DETAIL_KINDS.has(detailKind)) {
    return {
      ok: false,
      drop: {
        agentId: input.agentId,
        activity: input.activityKind,
        detailKind,
        reason: "non_fact_activity_detail_kind",
        isHeartbeat: input.isHeartbeat,
      },
    };
  }

  const entries = input.entries ? normalizeDaemonActivityEntries(input.entries) : undefined;
  return {
    ok: true,
    entries,
    message: {
      type: "agent:activity",
      agentId: input.agentId,
      detail: input.detail,
      detailKind,
      ...(entries ? { entries } : {}),
      ...(input.launchId ? { launchId: input.launchId } : {}),
      ...(input.daemonInstanceId ? { daemonInstanceId: input.daemonInstanceId } : {}),
      ...(input.probeId ? { probeId: input.probeId } : {}),
      ...(typeof input.clientSeq === "number" ? { clientSeq: input.clientSeq } : {}),
      ...(input.producerFactId ? { producerFactId: input.producerFactId } : {}),
      ...(typeof input.observedAtMs === "number" ? { observedAtMs: input.observedAtMs } : {}),
      isHeartbeat: input.isHeartbeat,
      ...(input.runtimeError ? { runtimeError: input.runtimeError } : {}),
    },
  };
}
