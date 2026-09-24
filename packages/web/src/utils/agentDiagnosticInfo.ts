import type { IntlShape } from "react-intl";
import type { Agent, AgentActivityState, ActivityLogEntry } from "../store/agentStore";
import type { Machine } from "../store/machineStore";

type DiagnosticAgent = Pick<Agent, "id" | "machineId" | "sessionId" | "runtime" | "model" | "status">;
type DiagnosticMachine = Pick<Machine, "id" | "daemonVersion" | "computerVersion">;

export interface BuildAgentDiagnosticInfoOptions {
  agent: DiagnosticAgent;
  serverId: string | null | undefined;
  machine: DiagnosticMachine | null | undefined;
  activityState: AgentActivityState | null | undefined;
  activityLog: ActivityLogEntry[];
  errorMessage?: string | null | undefined;
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

export function buildAgentDiagnosticInfo({
  agent,
  serverId,
  machine,
  activityState,
  activityLog,
  errorMessage,
  reportedAt = new Date(),
  formatMessage,
}: BuildAgentDiagnosticInfoOptions): string {
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
