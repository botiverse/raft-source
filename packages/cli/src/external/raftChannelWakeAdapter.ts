import {
  EXTERNAL_AGENT_COMMS_PROTOCOL_VERSION,
  EXTERNAL_AGENT_PROOF_SCHEMA_VERSION,
  EXTERNAL_RUNTIME_INTEGRATION_MANIFEST_SCHEMA,
  validateExternalAgentWakeEventEnvelope,
  validateExternalRuntimeIntegrationManifest,
  type ExternalAgentAdapterFailure,
  type ExternalAgentWakeAdapter,
  type ExternalAgentWakeAttemptInput,
  type ExternalAgentWakeEventEnvelope,
  type ExternalRuntimeIntegrationManifest,
} from "@botiverse/raft-shared";

export const RAFT_CHANNEL_WAKE_PROTOCOL = "raft-channel.v0" as const;

export const raftChannelWakeManifest: ExternalRuntimeIntegrationManifest =
  validateExternalRuntimeIntegrationManifest({
    schema: EXTERNAL_RUNTIME_INTEGRATION_MANIFEST_SCHEMA,
    runtimeId: "claude",
    integrationPattern: "external-harness-plugin",
    commsMode: "spawn-core",
    commsProtocolVersion: EXTERNAL_AGENT_COMMS_PROTOCOL_VERSION,
    proofSchemaVersion: EXTERNAL_AGENT_PROOF_SCHEMA_VERSION,
    minSlockCliVersion: "0.0.3",
    multiplex: false,
    agentIsolation: "session-scoped",
    bridgeLifecycle: {
      explicitStartOnly: true,
      oneShotCommandsBridgeIndependent: true,
      requiresBridgeFailureCodes: ["BRIDGE_NOT_RUNNING", "NO_CORE_SESSION"],
      autoStartDefault: false,
    },
    serverApi: {
      mode: "interim-agent-api-events",
      deliveryOnly: true,
      cursorAuthority: "model_seen_only",
    },
    wakeAdapter: {
      kind: "raft-channel",
      protocol: RAFT_CHANNEL_WAKE_PROTOCOL,
      requiresInteractiveSession: true,
    },
  });

export interface RaftChannelWakeAdapterOptions {
  endpointUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

interface ClaudeCodeChannelWakeResponse {
  ok?: boolean;
  runtimeSession?: string;
  failureClass?: ExternalAgentAdapterFailure;
  reason?: string;
  retryAfterMs?: number;
}

export function createRaftChannelWakeAdapter(
  options: RaftChannelWakeAdapterOptions = {},
): ExternalAgentWakeAdapter {
  return {
    manifest: raftChannelWakeManifest,
    async wake(input) {
      if (!options.endpointUrl) {
        return buildRaftChannelWakeFailedEvent(input, {
          failureClass: "no_session",
          reason: "Claude Code Raft channel plugin endpoint is not configured; start Claude Code with the Raft channel plugin and pass its localhost wake endpoint to the bridge.",
        });
      }

      const request = options.fetchImpl ?? fetch;
      let response: Response;
      try {
        response = await request(options.endpointUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.token ? { "x-raft-bridge-token": options.token } : {}),
          },
          body: JSON.stringify({
            schema: "raft-channel-wake.v1",
            attemptId: input.attemptId,
            eventId: input.eventId,
            messageId: input.messageId,
            agentId: input.agentId,
            profile: input.profile,
            coreSessionId: input.coreSessionId,
            adapterInstance: input.adapterInstance,
            occurredAt: input.occurredAt,
          }),
        });
      } catch (err) {
        return buildRaftChannelWakeFailedEvent(input, {
          failureClass: "no_session",
          reason: err instanceof Error && err.message
            ? `Claude Code Raft channel plugin endpoint is unreachable: ${err.message}`
            : "Claude Code Raft channel plugin endpoint is unreachable",
        });
      }

      const body = await parseWakeResponse(response);
      if (!response.ok || body.ok === false) {
        return buildRaftChannelWakeFailedEvent(input, {
          failureClass: body.failureClass ?? statusFailureClass(response.status),
          reason: body.reason ?? `Claude Code Raft channel plugin rejected wake attempt with HTTP ${response.status}`,
          ...(typeof body.retryAfterMs === "number" ? { retryAfterMs: body.retryAfterMs } : {}),
        });
      }

      const runtimeSession = body.runtimeSession ?? input.runtimeSession;
      if (!runtimeSession) {
        return buildRaftChannelWakeFailedEvent(input, {
          failureClass: "protocol_mismatch",
          reason: "Claude Code Raft channel plugin accepted wake but did not return runtimeSession",
        });
      }

      return buildRaftChannelWakeInjectedEvent({
        ...input,
        runtimeSession,
      });
    },
  };
}

export function buildRaftChannelWakeInjectedEvent(
  input: ExternalAgentWakeAttemptInput & { runtimeSession: string },
): ExternalAgentWakeEventEnvelope {
  return validateExternalAgentWakeEventEnvelope({
    ...input,
    schema: "slock-external-agent-wake-event.v1",
    kind: "proof",
    proofLevel: "wake_injected",
    outcome: "ok",
    lifecycleState: "handoff_pending",
    authority: {
      source: "wake_adapter",
      provenance: "adapter_observed",
    },
  });
}

async function parseWakeResponse(response: Response): Promise<ClaudeCodeChannelWakeResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return {};
  try {
    return await response.json() as ClaudeCodeChannelWakeResponse;
  } catch {
    return {};
  }
}

function statusFailureClass(status: number): ExternalAgentAdapterFailure {
  if (status === 401 || status === 403) return "auth_revoked";
  if (status === 409 || status === 429) return "busy";
  if (status === 426 || status === 501) return "protocol_mismatch";
  if (status === 404 || status === 410) return "no_session";
  return "injection_failed";
}

export function buildRaftChannelWakeFailedEvent(
  input: ExternalAgentWakeAttemptInput,
  failure: {
    failureClass: ExternalAgentAdapterFailure;
    reason: string;
    retryAfterMs?: number;
  },
): ExternalAgentWakeEventEnvelope {
  return validateExternalAgentWakeEventEnvelope({
    ...input,
    schema: "slock-external-agent-wake-event.v1",
    kind: "wake_attempt",
    outcome: "failed",
    failureMeta: {
      failureClass: failure.failureClass,
      ...(failure.retryAfterMs ? { retryAfterMs: failure.retryAfterMs } : {}),
    },
    reason: failure.reason,
    lifecycleState: "degraded_backoff",
    authority: {
      source: "wake_adapter",
      provenance: "adapter_observed",
    },
  });
}
