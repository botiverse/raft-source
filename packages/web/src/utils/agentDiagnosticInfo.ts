import type { IntlShape } from "react-intl";
import { EXTERNAL_AGENT_ONLINE_WINDOW_MS, isExternalAgentRuntime } from "@botiverse/raft-shared";
import type { ExternalAgentDiagnosticsView } from "@botiverse/raft-shared";
import type { Agent, AgentActivityState, ActivityLogEntry } from "../store/agentStore";
import type { Machine } from "../store/machineStore";

type DiagnosticAgent = Pick<Agent, "id" | "machineId" | "sessionId" | "runtime" | "model" | "status"> & Partial<Pick<Agent, "external" | "lastSeenAt">>;
type DiagnosticMachine = Pick<Machine, "id" | "daemonVersion" | "computerVersion">;

export interface BuildAgentDiagnosticInfoOptions {
  agent: DiagnosticAgent;
  serverId: string | null | undefined;
  machine: DiagnosticMachine | null | undefined;
  activityState: AgentActivityState | null | undefined;
  activityLog: ActivityLogEntry[];
  errorMessage?: string | null | undefined;
  /**
   * External agents: `GET /api/agents/:id/external-diagnostics`. Null/absent
   * while loading or when it failed; the text then says so instead of falling
   * back to managed-only fields.
   */
  externalDiagnostics?: ExternalAgentDiagnosticsView | null;
  reportedAt?: Date;
  formatMessage: IntlShape["formatMessage"];
}

function formatIso(value: Date | number | null | undefined): string {
  if (value == null) return "unknown";
  const date = typeof value === "number" ? new Date(value) : value;
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : "unknown";
}

function valueOrUnknown(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "unknown";
}

function valueOrNull(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "null";
}

function diagnosticActivityKind(activityState: AgentActivityState | null | undefined): string {
  const detailKind = activityState?.detailKind;
  if (detailKind && detailKind !== "none" && detailKind !== "other") {
    return detailKind;
  }
  return activityState?.activity ?? "other";
}

function formatIsoString(value: string | null | undefined): string {
  return value ? formatIso(new Date(value)) : "none";
}

function externalConnectionLine(connection: ExternalAgentDiagnosticsView["connections"][number]): string {
  const suffix = connection.state === "connected" && connection.account
    ? ` (${connection.account})`
    : connection.state === "unavailable" && connection.reason
      ? ` (${connection.reason})`
      : "";
  return `${connection.provider}Connection: ${connection.state}${suffix}`;
}

/**
 * External agents run outside Raft (no Computer, daemon or managed agent
 * status), so their diagnostic text carries the external facts instead:
 * provisioning, presence, reported status, push webhook, cursor pulls and
 * account connections.
 */
function buildExternalAgentDiagnosticLines({
  agent,
  serverId,
  activityState,
  activityLog,
  externalDiagnostics: diagnostics,
  reportedAt,
}: Omit<BuildAgentDiagnosticInfoOptions, "formatMessage" | "machine" | "errorMessage"> & { reportedAt: Date }): string[] {
  const latestActivity = activityLog.at(-1);
  const lastSeenAt = diagnostics ? diagnostics.presence.lastSeenAt : agent.lastSeenAt ?? null;
  const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN;
  const windowMs = diagnostics?.presence.onlineWindowMs ?? EXTERNAL_AGENT_ONLINE_WINDOW_MS;
  const online = Number.isFinite(lastSeenMs) && reportedAt.getTime() - lastSeenMs < windowMs;
  const lines = [
    `reportedAtUtc: ${formatIso(reportedAt)}`,
    `serverId: ${valueOrUnknown(serverId)}`,
    `agentId: ${agent.id}`,
    `runtime: ${valueOrUnknown(agent.runtime)}`,
    `lastSeenAtUtc: ${formatIsoString(lastSeenAt)}`,
    `online: ${online ? "yes" : "no"} (window ${Math.round(windowMs / 1000)}s)`,
    `activity: ${valueOrUnknown(diagnostics?.status.activity ?? activityState?.activity)}`,
    `activityKind: ${diagnostics?.status.detailKind ?? diagnosticActivityKind(activityState)}`,
    `activityDetail: ${valueOrNull(diagnostics?.status.detail ?? activityState?.activityDetail)}`,
    `lastActivityAtUtc: ${formatIso(latestActivity?.timestamp)}`,
  ];
  if (!diagnostics) {
    lines.push("externalDiagnostics: unavailable");
    return lines;
  }
  const { provider, status, push, events } = diagnostics;
  lines.push(
    `statusObservedAtUtc: ${formatIsoString(status.observedAt)}`,
    `statusProtocolAdoptedAtUtc: ${status.statusProtocolAdoptedAt ? formatIsoString(status.statusProtocolAdoptedAt) : "none (hook-derived status)"}`,
    `providerKind: ${provider?.kind ?? "none"}`,
  );
  if (provider) {
    lines.push(
      `provisioningState: ${provider.state}${provider.syncPending ? " (sync pending)" : ""}`,
      `providerAgentId: ${valueOrNull(provider.providerAgentId)}`,
      `provisioningLastError: ${provider.lastErrorCode ? `${provider.lastErrorCode} at ${formatIsoString(provider.lastErrorAt)}` : "none"}`,
    );
  }
  lines.push(
    `pushWebhook: ${!push.registered ? "not_registered" : push.enabled ? "enabled" : `disabled (${push.disabledReason ?? "unknown"})`}`,
  );
  if (push.registered) {
    lines.push(
      `pushEndpointHost: ${valueOrUnknown(push.endpointHost)}`,
      `pushConsecutiveFailures: ${push.consecutiveFailures}`,
      `pushLastDeliveryAtUtc: ${formatIsoString(push.lastDeliveryAt)}`,
      `pushLastAttemptAtUtc: ${formatIsoString(push.lastAttemptAt)}`,
      `pushLastError: ${push.lastError ?? "none"}`,
      ...(push.recovery ? [`pushRecovery: ${push.recovery}`] : []),
    );
  }
  lines.push(
    `eventsLastCursorPullAtUtc: ${formatIsoString(events.lastCursorPullAt)}`,
    `eventsPendingCursorAcks: ${events.pendingCursorAckCount}`,
    ...diagnostics.connections.map(externalConnectionLine),
    `diagnosticsGeneratedAtUtc: ${formatIsoString(diagnostics.generatedAt)}`,
  );
  return lines;
}

export function buildAgentDiagnosticInfo({
  agent,
  serverId,
  machine,
  activityState,
  activityLog,
  errorMessage,
  externalDiagnostics,
  reportedAt = new Date(),
  formatMessage,
}: BuildAgentDiagnosticInfoOptions): string {
  if (agent.external === true || isExternalAgentRuntime(agent.runtime)) {
    const copiedError = activityState?.activity === "error" ? errorMessage?.trim() : "";
    return [
      formatMessage({ id: "agent.diagnosticInfo.title" }),
      ...(copiedError ? [`errorMessage: ${copiedError}`] : []),
      ...buildExternalAgentDiagnosticLines({ agent, serverId, activityState, activityLog, externalDiagnostics, reportedAt }),
    ].join("\n");
  }
  const latestActivity = activityLog.at(-1);
  const activity = activityState?.activity ?? "unknown";
  const activityKind = diagnosticActivityKind(activityState);
  const copiedErrorMessage = activity === "error" ? errorMessage?.trim() : "";

  const lines = [
    formatMessage({ id: "agent.diagnosticInfo.title" }),
    ...(copiedErrorMessage ? [`errorMessage: ${copiedErrorMessage}`] : []),
    `reportedAtUtc: ${formatIso(reportedAt)}`,
    `serverId: ${valueOrUnknown(serverId)}`,
    `agentId: ${agent.id}`,
    `machineId: ${valueOrUnknown(agent.machineId ?? machine?.id)}`,
    `sessionId: ${valueOrNull(agent.sessionId)}`,
    `runtime: ${valueOrUnknown(agent.runtime)}`,
    `model: ${valueOrUnknown(agent.model)}`,
    `computerVersion: ${valueOrUnknown(machine?.computerVersion)}`,
    `daemonVersion: ${valueOrUnknown(machine?.daemonVersion)}`,
    `agentStatus: ${valueOrUnknown(agent.status)}`,
    `activity: ${valueOrUnknown(activity)}`,
    `activityKind: ${activityKind}`,
    `lastActivityAtUtc: ${formatIso(latestActivity?.timestamp)}`,
  ];

  return lines.join("\n");
}
