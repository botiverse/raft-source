// Debugging snapshot of an external agent (runtime `external`, incl. hosted
// runtime provider agents) for `GET /api/agents/:id/external-diagnostics`,
// the source of the agent panel's "Copy diagnostic info" for external agents.
// Managed-only facts (machine, daemon version, agent status) do not apply to
// them; these are the facts that do. Nothing secret is read into the view: the
// push endpoint is reduced to its host and no credential or signing secret is
// selected.
import {
  AGENT_CONNECTION_PROVIDERS,
  EXTERNAL_AGENT_ONLINE_WINDOW_MS,
  type AgentConnectionProvider,
  type ExternalAgentDiagnosticsView,
} from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agentInboxEventsPendingAcks } from "../db/schema";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { getAgentConnectionStatus, type AgentConnectionViewer } from "./agentConnectionService";
import { getAgentsLastSeenAt } from "./agentCredentialService";
import { getAgentInboxPushStatus } from "./agentInboxPushService";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { getHostedRuntimeSummary } from "./agentRuntimeProvisionService";

type DiagnosticsAgent = {
  id: string;
  serverId: string;
  runtime: string;
  statusProtocolAdoptedAt?: Date | string | null;
};

function iso(value: Date | string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Host (with port) of the registered push endpoint; never its path or query. */
export function pushEndpointHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

async function connectionDiagnostics(
  agent: DiagnosticsAgent,
  provider: AgentConnectionProvider,
  hosted: boolean,
  viewer: AgentConnectionViewer,
): Promise<ExternalAgentDiagnosticsView["connections"][number]> {
  const base = { provider, account: null, reason: null };
  if (!hosted) return { ...base, state: "not_applicable" };
  try {
    const status = await getAgentConnectionStatus(agent, provider, viewer);
    if (!status.ok) {
      const failure = status.failure;
      if (failure.kind === "not_hosted") return { ...base, state: "not_applicable" };
      if (failure.kind === "unsupported") return { ...base, state: "unsupported" };
      const reason = failure.kind === "provider_error"
        ? `provider_error:${failure.code}${failure.httpStatus ? `:${failure.httpStatus}` : ""}`
        : failure.kind === "not_active" ? `not_active:${failure.state}` : failure.kind;
      return { ...base, state: "unavailable", reason };
    }
    const view = status.value;
    if (!view.supported) return { ...base, state: "unsupported" };
    return { ...base, state: view.connected ? "connected" : "not_connected", account: view.account };
  } catch (error) {
    console.warn("[ExternalAgentDiagnostics] connection status failed", serializeErrorForLog(error));
    return { ...base, state: "unavailable", reason: "error" };
  }
}

export async function getExternalAgentDiagnostics(input: {
  agent: DiagnosticsAgent;
  agentOrchestrator: Pick<AgentOrchestrator, "getActivity" | "getLiveActivityObservedAtMs" | "listRecentActivityLog">;
  viewer: AgentConnectionViewer;
  now?: Date;
}): Promise<ExternalAgentDiagnosticsView> {
  const { agent, agentOrchestrator } = input;
  const now = input.now ?? new Date();
  const [hostedRuntime, lastSeenByAgent, activity, observedAtMs, recentLog, push, pendingAckRows] = await Promise.all([
    getHostedRuntimeSummary(agent.id),
    getAgentsLastSeenAt([agent.id]),
    agentOrchestrator.getActivity(agent.id),
    agentOrchestrator.getLiveActivityObservedAtMs(agent.id).catch(() => null),
    agentOrchestrator.listRecentActivityLog(agent.id, 1),
    getAgentInboxPushStatus({ agentId: agent.id, serverId: agent.serverId }),
    getDb().select({ seqs: agentInboxEventsPendingAcks.seqs, updatedAt: agentInboxEventsPendingAcks.updatedAt })
      .from(agentInboxEventsPendingAcks)
      .where(eq(agentInboxEventsPendingAcks.agentId, agent.id))
      .limit(1),
  ]);
  const hosted = hostedRuntime !== null && hostedRuntime.state !== "deleting" && hostedRuntime.state !== "deleted";
  const connections = await Promise.all(AGENT_CONNECTION_PROVIDERS.map((provider) =>
    connectionDiagnostics(agent, provider, hosted, input.viewer)));

  const lastSeenAt = lastSeenByAgent.get(agent.id) ?? null;
  const pendingAck = pendingAckRows[0];
  const detail = activity.activityDetail?.trim() ? activity.activityDetail : null;
  return {
    agentId: agent.id,
    runtime: agent.runtime,
    generatedAt: now.toISOString(),
    provider: hostedRuntime
      ? {
          kind: hostedRuntime.provider,
          state: hostedRuntime.state,
          providerAgentId: hostedRuntime.providerAgentId,
          syncPending: hostedRuntime.syncPending,
          lastErrorCode: hostedRuntime.lastError?.code ?? null,
          lastErrorAt: hostedRuntime.lastError?.at ?? null,
          activatedAt: hostedRuntime.activatedAt,
        }
      : null,
    presence: {
      lastSeenAt: iso(lastSeenAt),
      onlineWindowMs: EXTERNAL_AGENT_ONLINE_WINDOW_MS,
      online: lastSeenAt !== null && now.getTime() - lastSeenAt.getTime() < EXTERNAL_AGENT_ONLINE_WINDOW_MS,
    },
    status: {
      activity: activity.activity,
      detail,
      detailKind: activity.activityDetailKind ?? null,
      observedAt: iso(observedAtMs),
      lastActivityLogAt: iso(recentLog[0]?.timestamp ?? null),
      statusProtocolAdoptedAt: iso(agent.statusProtocolAdoptedAt ?? null),
    },
    push: {
      registered: push.registered,
      enabled: push.enabled,
      endpointHost: pushEndpointHost(push.url),
      disabledReason: push.disabledReason,
      disabledAt: push.disabledAt,
      consecutiveFailures: push.consecutiveFailures,
      lastAttemptAt: push.lastAttemptAt,
      lastDeliveryAt: push.lastDeliveryAt,
      lastError: push.lastError,
      nextAttemptAt: push.nextAttemptAt,
      probeStoppedAt: push.probeStoppedAt,
      recovery: push.recovery,
    },
    events: {
      lastCursorPullAt: iso(pendingAck?.updatedAt ?? null),
      pendingCursorAckCount: Array.isArray(pendingAck?.seqs) ? pendingAck.seqs.length : 0,
    },
    connections,
  };
}
