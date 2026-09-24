import { z } from "zod";

export const EXTERNAL_AGENT_COMMS_PROTOCOL_VERSION = "agent-comms-core.v1" as const;
export const EXTERNAL_AGENT_PROOF_SCHEMA_VERSION = "agent-proof.v1" as const;
export const EXTERNAL_RUNTIME_INTEGRATION_MANIFEST_SCHEMA = "slock-external-runtime-integration.v1" as const;
export const EXTERNAL_AGENT_WAKE_EVENT_SCHEMA = "slock-external-agent-wake-event.v1" as const;

export const externalAgentCommsModeValues = ["spawn-core", "attach-core", "import-core"] as const;
export type ExternalAgentCommsMode = typeof externalAgentCommsModeValues[number];

export const externalAgentIntegrationPatternValues = ["external-harness-plugin", "integrated-runtime"] as const;
export type ExternalAgentIntegrationPattern = typeof externalAgentIntegrationPatternValues[number];

export const externalAgentIsolationValues = ["profile-scoped", "session-scoped"] as const;
export type ExternalAgentIsolation = typeof externalAgentIsolationValues[number];

export const externalAgentWakeAdapterKindValues = ["raft-channel", "hermes-in-process"] as const;
export type ExternalAgentWakeAdapterKind = typeof externalAgentWakeAdapterKindValues[number];

export const externalAgentWakeProofLevelValues = [
  "server_delivered",
  "harness_accepted",
  "wake_injected",
] as const;
export type ExternalAgentWakeProofLevel = typeof externalAgentWakeProofLevelValues[number];

export const externalAgentProofLevelValues = [
  ...externalAgentWakeProofLevelValues,
  "model_seen",
] as const;
export type ExternalAgentProofLevel = typeof externalAgentProofLevelValues[number];

export const externalAgentCursorAdvancingProofLevels = ["model_seen"] as const;
export type ExternalAgentCursorAdvancingProofLevel = typeof externalAgentCursorAdvancingProofLevels[number];

export const externalAgentCommsLifecycleStateValues = [
  "unbound",
  "bound_stopped",
  "starting",
  "connected_replaying",
  "listening_idle",
  "handoff_pending",
  "degraded_backoff",
  "stopping",
  "stopped",
  "auth_revoked",
] as const;
export type ExternalAgentCommsLifecycleState = typeof externalAgentCommsLifecycleStateValues[number];

export const externalAgentLifecycleSourceValues = ["server_core", "comms_core", "wake_adapter", "server"] as const;
export type ExternalAgentLifecycleSource = typeof externalAgentLifecycleSourceValues[number];

export const externalAgentLifecycleProvenanceValues = [
  "slock_core",
  "adapter_observed",
  "agent_reported",
] as const;
export type ExternalAgentLifecycleProvenance = typeof externalAgentLifecycleProvenanceValues[number];

export const externalAgentAdapterFailureValues = [
  "no_session",
  "busy",
  "injection_failed",
  "protocol_mismatch",
  "auth_revoked",
] as const;
export type ExternalAgentAdapterFailure = typeof externalAgentAdapterFailureValues[number];

export const externalAgentWakeEventOutcomeValues = ["ok", "failed"] as const;
export type ExternalAgentWakeEventOutcome = typeof externalAgentWakeEventOutcomeValues[number];

export const externalAgentServerApiModeValues = ["interim-agent-api-events", "agent-inbox-protocol"] as const;
export type ExternalAgentServerApiMode = typeof externalAgentServerApiModeValues[number];

const nonEmptyStringSchema = z.string().min(1);
const isoTimestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "must be a parseable timestamp",
});

export const externalRuntimeIntegrationManifestSchema = z.object({
  schema: z.literal(EXTERNAL_RUNTIME_INTEGRATION_MANIFEST_SCHEMA),
  runtimeId: nonEmptyStringSchema,
  integrationPattern: z.enum(externalAgentIntegrationPatternValues),
  commsMode: z.enum(externalAgentCommsModeValues),
  commsProtocolVersion: z.literal(EXTERNAL_AGENT_COMMS_PROTOCOL_VERSION),
  proofSchemaVersion: z.literal(EXTERNAL_AGENT_PROOF_SCHEMA_VERSION),
  minSlockCliVersion: nonEmptyStringSchema,
  multiplex: z.boolean(),
  agentIsolation: z.enum(externalAgentIsolationValues),
  bridgeLifecycle: z.object({
    explicitStartOnly: z.literal(true),
    oneShotCommandsBridgeIndependent: z.literal(true),
    requiresBridgeFailureCodes: z.array(z.enum(["BRIDGE_NOT_RUNNING", "NO_CORE_SESSION"])).min(1),
    autoStartDefault: z.literal(false),
  }).strict(),
  serverApi: z.object({
    mode: z.enum(externalAgentServerApiModeValues),
    deliveryOnly: z.boolean(),
    cursorAuthority: z.literal("model_seen_only"),
  }).strict(),
  wakeAdapter: z.object({
    kind: z.enum(externalAgentWakeAdapterKindValues),
    protocol: nonEmptyStringSchema,
    requiresInteractiveSession: z.boolean().optional(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (!value.bridgeLifecycle.requiresBridgeFailureCodes.includes("BRIDGE_NOT_RUNNING")) {
    ctx.addIssue({
      code: "custom",
      path: ["bridgeLifecycle", "requiresBridgeFailureCodes"],
      message: "bridge-dependent surfaces must include BRIDGE_NOT_RUNNING",
    });
  }
  if (!value.bridgeLifecycle.requiresBridgeFailureCodes.includes("NO_CORE_SESSION")) {
    ctx.addIssue({
      code: "custom",
      path: ["bridgeLifecycle", "requiresBridgeFailureCodes"],
      message: "bridge-dependent surfaces must include NO_CORE_SESSION",
    });
  }
  if (value.serverApi.mode === "interim-agent-api-events" && value.serverApi.deliveryOnly !== true) {
    ctx.addIssue({
      code: "custom",
      path: ["serverApi", "deliveryOnly"],
      message: "interim agent-api events mode must be delivery-only",
    });
  }
});

export type ExternalRuntimeIntegrationManifest = z.infer<typeof externalRuntimeIntegrationManifestSchema>;

const externalAgentWakeEventBaseSchema = z.object({
  schema: z.literal(EXTERNAL_AGENT_WAKE_EVENT_SCHEMA),
  eventId: nonEmptyStringSchema,
  attemptId: nonEmptyStringSchema,
  messageId: nonEmptyStringSchema,
  agentId: nonEmptyStringSchema,
  profile: nonEmptyStringSchema,
  coreSessionId: nonEmptyStringSchema,
  adapterInstance: nonEmptyStringSchema,
  runtimeSession: nonEmptyStringSchema.nullable(),
  occurredAt: isoTimestampSchema,
  lifecycleState: z.enum(externalAgentCommsLifecycleStateValues),
  authority: z.object({
    source: z.enum(externalAgentLifecycleSourceValues),
    provenance: z.enum(externalAgentLifecycleProvenanceValues),
  }).strict(),
}).strict();

export const externalAgentProofEventEnvelopeSchema = externalAgentWakeEventBaseSchema.extend({
  kind: z.literal("proof"),
  proofLevel: z.enum(externalAgentWakeProofLevelValues),
  outcome: z.literal("ok"),
  failureMeta: z.undefined().optional(),
  reason: z.string().optional(),
});

export const externalAgentFailedWakeEventEnvelopeSchema = externalAgentWakeEventBaseSchema.extend({
  kind: z.literal("wake_attempt"),
  proofLevel: z.undefined().optional(),
  outcome: z.literal("failed"),
  failureMeta: z.object({
    failureClass: z.enum(externalAgentAdapterFailureValues),
    retryAfterMs: z.number().int().positive().optional(),
  }).strict(),
  reason: nonEmptyStringSchema,
});

export const externalAgentWakeEventEnvelopeSchema = z.discriminatedUnion("kind", [
  externalAgentProofEventEnvelopeSchema,
  externalAgentFailedWakeEventEnvelopeSchema,
]);

export type ExternalAgentProofEventEnvelope = z.infer<typeof externalAgentProofEventEnvelopeSchema>;
export type ExternalAgentFailedWakeEventEnvelope = z.infer<typeof externalAgentFailedWakeEventEnvelopeSchema>;
export type ExternalAgentWakeEventEnvelope = z.infer<typeof externalAgentWakeEventEnvelopeSchema>;

export interface ExternalAgentWakeAttemptInput {
  eventId: string;
  attemptId: string;
  messageId: string;
  agentId: string;
  profile: string;
  coreSessionId: string;
  adapterInstance: string;
  runtimeSession: string | null;
  occurredAt: string;
}

export interface ExternalAgentWakeAdapter {
  readonly manifest: ExternalRuntimeIntegrationManifest;
  wake(input: ExternalAgentWakeAttemptInput): Promise<ExternalAgentWakeEventEnvelope>;
}

export function validateExternalRuntimeIntegrationManifest(value: unknown): ExternalRuntimeIntegrationManifest {
  return externalRuntimeIntegrationManifestSchema.parse(value);
}

export function validateExternalAgentWakeEventEnvelope(value: unknown): ExternalAgentWakeEventEnvelope {
  const event = externalAgentWakeEventEnvelopeSchema.parse(value);
  assertExternalAgentWakeEventAuthority(event);
  return event;
}

export function isExternalAgentCursorAdvancingProofLevel(
  proofLevel: ExternalAgentProofLevel,
): proofLevel is ExternalAgentCursorAdvancingProofLevel {
  return (externalAgentCursorAdvancingProofLevels as readonly ExternalAgentProofLevel[]).includes(proofLevel);
}

export function assertExternalAgentWakeEventAuthority(event: ExternalAgentWakeEventEnvelope): void {
  if (event.outcome === "failed") {
    if (event.authority.source !== "wake_adapter") {
      throw new Error("failed wake_attempt events must be sourced by wake_adapter");
    }
    return;
  }

  if (event.proofLevel === "server_delivered" && event.authority.source !== "server_core") {
    throw new Error("server_delivered proof must be sourced by server_core");
  }
  if (event.proofLevel === "harness_accepted" && event.authority.source !== "comms_core") {
    throw new Error("harness_accepted proof must be sourced by comms_core");
  }
  if (event.proofLevel === "wake_injected" && event.authority.source !== "wake_adapter") {
    throw new Error("wake_injected proof must be sourced by wake_adapter");
  }
}
