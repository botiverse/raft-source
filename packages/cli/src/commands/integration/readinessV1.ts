import type { AgentManifestActionV1, AgentManifestV1 } from "./manifestV1.js";
import type { ManifestObservation } from "./readiness.js";

export type IntegrationAuthStatusV1 =
  | "session_present"
  | "not_ready"
  | "not_required"
  | "unknown"
  | "accepted"
  | "rejected";
export type IntegrationAuthorityStatusV1 = "authorized" | "denied" | "unknown";
export type IntegrationInvokeStatusV1 =
  | "blocked"
  | "attemptable"
  | "accepted_unverified"
  | "verified"
  | "failed"
  | "indeterminate";
export type IntegrationTransportStatusV1 =
  | "not_attempted"
  | "not_sent"
  | "no_response"
  | "response_received"
  | "rejected";
export type IntegrationResponseSchemaStatusV1 = "not_run" | "passed" | "failed";
export type IntegrationReadbackStatusV1 =
  | "not_applicable"
  | "not_supported"
  | "not_run"
  | "passed"
  | "failed"
  | "indeterminate";
export type IntegrationOverallStatusV1 =
  | "web_only_not_configured"
  | "zero_action_manifest"
  | "manifest_missing"
  | "manifest_invalid"
  | "manifest_unavailable"
  | "manifest_unreachable"
  | "manifest_unchecked"
  | "auth_not_ready"
  | "action_undeclared"
  | "local_cli_design_blocked"
  | "attemptable_unverified"
  | "accepted_unverified"
  | "verified"
  | "failed"
  | "indeterminate";

export interface IntegrationReadinessV1 {
  schema: "raft-integration-readiness.v1";
  service_id: string;
  actor: {
    kind: "agent";
    id: string;
  };
  manifest: {
    status: ManifestObservation["status"];
    surface: ManifestObservation["surface"];
    source: ManifestObservation["source"];
    observed_at: string;
  };
  auth: {
    status: IntegrationAuthStatusV1;
  };
  action: {
    name: string | null;
    declared: boolean;
    effect: AgentManifestActionV1["effect"] | null;
    contract_status: "valid" | "invalid" | "undeclared" | "unknown";
  };
  authority: {
    status: IntegrationAuthorityStatusV1;
  };
  invoke: {
    status: IntegrationInvokeStatusV1;
  };
  transport: {
    status: IntegrationTransportStatusV1;
  };
  response_schema: {
    status: IntegrationResponseSchemaStatusV1;
  };
  readback: {
    status: IntegrationReadbackStatusV1;
  };
  overall: IntegrationOverallStatusV1;
  observed_at: string;
  source: ManifestObservation["source"];
  fault_domain: string | null;
  retryable: boolean | null;
  next_action: string;
}

function blockedObservationOverall(
  status: ManifestObservation["status"],
): IntegrationOverallStatusV1 | null {
  switch (status) {
    case "not_configured":
      return "web_only_not_configured";
    case "missing":
      return "manifest_missing";
    case "invalid":
      return "manifest_invalid";
    case "unavailable":
      return "manifest_unavailable";
    case "unreachable":
      return "manifest_unreachable";
    case "unchecked":
      return "manifest_unchecked";
    case "valid":
      return null;
  }
}

function blockedNextAction(
  observation: ManifestObservation,
  overall: IntegrationOverallStatusV1,
): string {
  if (overall === "web_only_not_configured") {
    return "Use the app on the Web; this intentional Web-only surface has no agent-callable actions.";
  }
  return observation.next_action;
}

export function buildIntegrationReadinessV1(input: {
  actorId: string;
  observation: ManifestObservation;
  manifest: AgentManifestV1 | null;
  actionName?: string;
  sessionPresent: boolean;
}): IntegrationReadinessV1 {
  const action = input.manifest?.actions.find((candidate) => candidate.name === input.actionName) ?? null;
  const base = {
    schema: "raft-integration-readiness.v1" as const,
    service_id: input.observation.service_id,
    actor: { kind: "agent" as const, id: input.actorId },
    manifest: {
      status: input.observation.status,
      surface: input.observation.surface,
      source: input.observation.source,
      observed_at: input.observation.observed_at,
    },
    auth: { status: (input.sessionPresent ? "session_present" : "not_ready") as IntegrationAuthStatusV1 },
    action: {
      name: input.actionName ?? null,
      declared: Boolean(action),
      effect: action?.effect ?? null,
      contract_status: (action ? "valid" : input.actionName ? "undeclared" : "unknown") as
        IntegrationReadinessV1["action"]["contract_status"],
    },
    authority: { status: "unknown" as const },
    transport: { status: "not_attempted" as const },
    response_schema: { status: "not_run" as const },
    readback: {
      status: (action?.readback.mode === "not_applicable"
        ? "not_applicable"
        : action?.readback.mode === "not_supported"
          ? "not_supported"
          : "not_run") as IntegrationReadbackStatusV1,
    },
    observed_at: input.observation.observed_at,
    source: input.observation.source,
    fault_domain: input.observation.fault_domain,
    retryable: input.observation.retryable,
  };

  const blocked = blockedObservationOverall(input.observation.status);
  if (blocked) {
    return {
      ...base,
      invoke: { status: "blocked" },
      overall: blocked,
      next_action: blockedNextAction(input.observation, blocked),
    };
  }
  if (input.manifest?.execution.mode === "local_cli") {
    return {
      ...base,
      invoke: { status: "blocked" },
      overall: "local_cli_design_blocked",
      next_action: "Use the documented Web surface; local CLI invocation and credential materialization are design-blocked.",
    };
  }
  if ((input.manifest?.actions.length ?? 0) === 0) {
    return {
      ...base,
      invoke: { status: "blocked" },
      overall: "zero_action_manifest",
      next_action: "Use the app on the Web; this valid manifest declares no agent-callable actions.",
    };
  }
  if (!action) {
    return {
      ...base,
      invoke: { status: "blocked" },
      overall: "action_undeclared",
      next_action: "Choose one action declared by the validated manifest.",
    };
  }
  if (!input.sessionPresent) {
    return {
      ...base,
      invoke: { status: "blocked" },
      overall: "auth_not_ready",
      retryable: false,
      fault_domain: "auth",
      next_action: `Run \`raft integration login --service ${JSON.stringify(input.observation.service_id)}\` and retry.`,
    };
  }
  return {
    ...base,
    invoke: { status: "attemptable" },
    overall: "attemptable_unverified",
    retryable: false,
    fault_domain: null,
    next_action: "Invoke the declared action; the service must still authorize the actor and resource.",
  };
}

export function formatIntegrationReadinessV1(readiness: IntegrationReadinessV1): string {
  return [
    `Readiness: ${readiness.overall}`,
    `service: ${readiness.service_id}`,
    `manifest: ${readiness.manifest.status}`,
    `action: ${readiness.action.name ?? "-"}`,
    `effect: ${readiness.action.effect ?? "-"}`,
    `auth: ${readiness.auth.status}`,
    `authority: ${readiness.authority.status}`,
    `invoke: ${readiness.invoke.status}`,
    `transport: ${readiness.transport.status}`,
    `response schema: ${readiness.response_schema.status}`,
    `readback: ${readiness.readback.status}`,
    `observed at: ${readiness.observed_at}`,
    `source: ${readiness.source}`,
    `fault domain: ${readiness.fault_domain ?? "-"}`,
    `retryable: ${readiness.retryable === null ? "unknown" : readiness.retryable ? "yes" : "no"}`,
    `next: ${readiness.next_action}`,
  ].join("\n");
}
