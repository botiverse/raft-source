import assert from "node:assert/strict";
import test from "node:test";

import {
  EXTERNAL_AGENT_COMMS_PROTOCOL_VERSION,
  EXTERNAL_AGENT_PROOF_SCHEMA_VERSION,
  EXTERNAL_RUNTIME_INTEGRATION_MANIFEST_SCHEMA,
  isExternalAgentCursorAdvancingProofLevel,
  validateExternalAgentWakeEventEnvelope,
  validateExternalRuntimeIntegrationManifest,
  type ExternalAgentProofLevel,
} from "./externalAgentIntegration.js";

const baseEvent = {
  schema: "slock-external-agent-wake-event.v1",
  eventId: "evt-1",
  attemptId: "attempt-1",
  messageId: "msg-1",
  agentId: "agent-1",
  profile: "profile-1",
  coreSessionId: "core-1",
  adapterInstance: "adapter-1",
  runtimeSession: "runtime-1",
  occurredAt: "2026-06-08T05:00:00.000Z",
};

test("external runtime integration manifest pins comms and proof schema versions", () => {
  const manifest = validateExternalRuntimeIntegrationManifest({
    schema: EXTERNAL_RUNTIME_INTEGRATION_MANIFEST_SCHEMA,
    runtimeId: "claude",
    integrationPattern: "external-harness-plugin",
    commsMode: "spawn-core",
    commsProtocolVersion: EXTERNAL_AGENT_COMMS_PROTOCOL_VERSION,
    proofSchemaVersion: EXTERNAL_AGENT_PROOF_SCHEMA_VERSION,
    minSlockCliVersion: "0.0.3",
    multiplex: false,
    agentIsolation: "profile-scoped",
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
      protocol: "raft-channel.v0",
      requiresInteractiveSession: true,
    },
  });

  assert.equal(manifest.runtimeId, "claude");
  assert.equal(manifest.wakeAdapter.kind, "raft-channel");
});

test("external runtime integration manifest fails closed on protocol mismatch", () => {
  assert.throws(
    () => validateExternalRuntimeIntegrationManifest({
      schema: EXTERNAL_RUNTIME_INTEGRATION_MANIFEST_SCHEMA,
      runtimeId: "claude",
      integrationPattern: "external-harness-plugin",
      commsMode: "spawn-core",
      commsProtocolVersion: "parallel-cursor-core.v0",
    proofSchemaVersion: EXTERNAL_AGENT_PROOF_SCHEMA_VERSION,
    minSlockCliVersion: "0.0.3",
    multiplex: false,
    agentIsolation: "profile-scoped",
    bridgeLifecycle: {
      explicitStartOnly: true,
      oneShotCommandsBridgeIndependent: true,
      requiresBridgeFailureCodes: ["BRIDGE_NOT_RUNNING"],
      autoStartDefault: false,
    },
    serverApi: {
      mode: "interim-agent-api-events",
      deliveryOnly: true,
      cursorAuthority: "model_seen_only",
    },
    wakeAdapter: {
      kind: "raft-channel",
      protocol: "raft-channel.v0",
      },
    }),
    /agent-comms-core\.v1/,
  );
});

test("manifest pins bridge lifecycle as explicit-start and bridge-free one-shot commands", () => {
  const manifest = validateExternalRuntimeIntegrationManifest({
    schema: EXTERNAL_RUNTIME_INTEGRATION_MANIFEST_SCHEMA,
    runtimeId: "claude",
    integrationPattern: "external-harness-plugin",
    commsMode: "spawn-core",
    commsProtocolVersion: EXTERNAL_AGENT_COMMS_PROTOCOL_VERSION,
    proofSchemaVersion: EXTERNAL_AGENT_PROOF_SCHEMA_VERSION,
    minSlockCliVersion: "0.0.3",
    multiplex: false,
    agentIsolation: "profile-scoped",
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
      protocol: "raft-channel.v0",
    },
  });

  assert.equal(manifest.bridgeLifecycle.explicitStartOnly, true);
  assert.equal(manifest.bridgeLifecycle.oneShotCommandsBridgeIndependent, true);
  assert.equal(manifest.bridgeLifecycle.autoStartDefault, false);
  assert.deepEqual(manifest.bridgeLifecycle.requiresBridgeFailureCodes, [
    "BRIDGE_NOT_RUNNING",
    "NO_CORE_SESSION",
  ]);
});

test("manifest requires both bridge-not-running failure codes", () => {
  assert.throws(
    () => validateExternalRuntimeIntegrationManifest({
      schema: EXTERNAL_RUNTIME_INTEGRATION_MANIFEST_SCHEMA,
      runtimeId: "claude",
      integrationPattern: "external-harness-plugin",
      commsMode: "spawn-core",
      commsProtocolVersion: EXTERNAL_AGENT_COMMS_PROTOCOL_VERSION,
      proofSchemaVersion: EXTERNAL_AGENT_PROOF_SCHEMA_VERSION,
      minSlockCliVersion: "0.0.3",
      multiplex: false,
      agentIsolation: "profile-scoped",
      bridgeLifecycle: {
        explicitStartOnly: true,
        oneShotCommandsBridgeIndependent: true,
        requiresBridgeFailureCodes: ["BRIDGE_NOT_RUNNING"],
        autoStartDefault: false,
      },
      serverApi: {
        mode: "interim-agent-api-events",
        deliveryOnly: true,
        cursorAuthority: "model_seen_only",
      },
      wakeAdapter: {
        kind: "raft-channel",
        protocol: "raft-channel.v0",
      },
    }),
    /NO_CORE_SESSION/,
  );
});

test("interim server API mode is delivery-only and cannot claim cursor authority", () => {
  const manifest = validateExternalRuntimeIntegrationManifest({
    schema: EXTERNAL_RUNTIME_INTEGRATION_MANIFEST_SCHEMA,
    runtimeId: "claude",
    integrationPattern: "external-harness-plugin",
    commsMode: "spawn-core",
    commsProtocolVersion: EXTERNAL_AGENT_COMMS_PROTOCOL_VERSION,
    proofSchemaVersion: EXTERNAL_AGENT_PROOF_SCHEMA_VERSION,
    minSlockCliVersion: "0.0.3",
    multiplex: false,
    agentIsolation: "profile-scoped",
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
      protocol: "raft-channel.v0",
    },
  });

  assert.equal(manifest.serverApi.mode, "interim-agent-api-events");
  assert.equal(manifest.serverApi.deliveryOnly, true);
  assert.equal(manifest.serverApi.cursorAuthority, "model_seen_only");
});

test("interim server API mode cannot drop delivery-only marker", () => {
  assert.throws(
    () => validateExternalRuntimeIntegrationManifest({
      schema: EXTERNAL_RUNTIME_INTEGRATION_MANIFEST_SCHEMA,
      runtimeId: "claude",
      integrationPattern: "external-harness-plugin",
      commsMode: "spawn-core",
      commsProtocolVersion: EXTERNAL_AGENT_COMMS_PROTOCOL_VERSION,
      proofSchemaVersion: EXTERNAL_AGENT_PROOF_SCHEMA_VERSION,
      minSlockCliVersion: "0.0.3",
      multiplex: false,
      agentIsolation: "profile-scoped",
      bridgeLifecycle: {
        explicitStartOnly: true,
        oneShotCommandsBridgeIndependent: true,
        requiresBridgeFailureCodes: ["BRIDGE_NOT_RUNNING", "NO_CORE_SESSION"],
        autoStartDefault: false,
      },
      serverApi: {
        mode: "interim-agent-api-events",
        deliveryOnly: false,
        cursorAuthority: "model_seen_only",
      },
      wakeAdapter: {
        kind: "raft-channel",
        protocol: "raft-channel.v0",
      },
    }),
    /delivery-only/,
  );
});

test("proof levels declare model_seen as the only cursor boundary concept", () => {
  const levels: ExternalAgentProofLevel[] = [
    "server_delivered",
    "harness_accepted",
    "wake_injected",
    "model_seen",
  ];

  assert.deepEqual(
    levels.filter(isExternalAgentCursorAdvancingProofLevel),
    ["model_seen"],
  );
});

test("wake event envelope excludes model_seen until server cursor result schema exists", () => {
  assert.throws(
    () => validateExternalAgentWakeEventEnvelope({
      ...baseEvent,
      kind: "proof",
      proofLevel: "model_seen",
      outcome: "ok",
      lifecycleState: "handoff_pending",
      authority: {
        source: "server",
        provenance: "agent_reported",
      },
    }),
    /proofLevel[\s\S]*wake_injected/,
  );
});

test("server_delivered proof is server-core-authored", () => {
  const event = validateExternalAgentWakeEventEnvelope({
    ...baseEvent,
    kind: "proof",
    proofLevel: "server_delivered",
    outcome: "ok",
    lifecycleState: "connected_replaying",
    authority: {
      source: "server_core",
      provenance: "slock_core",
    },
  });

  assert.equal(event.proofLevel, "server_delivered");
  assert.equal(event.authority.source, "server_core");

  assert.throws(
    () => validateExternalAgentWakeEventEnvelope({
      ...baseEvent,
      kind: "proof",
      proofLevel: "server_delivered",
      outcome: "ok",
      lifecycleState: "connected_replaying",
      authority: {
        source: "comms_core",
        provenance: "slock_core",
      },
    }),
    /server_delivered proof must be sourced by server_core/,
  );
});

test("wake_injected proof is accepted from wake_adapter but does not advance cursor", () => {
  const event = validateExternalAgentWakeEventEnvelope({
    ...baseEvent,
    kind: "proof",
    proofLevel: "wake_injected",
    outcome: "ok",
    lifecycleState: "handoff_pending",
    authority: {
      source: "wake_adapter",
      provenance: "adapter_observed",
    },
  });

  assert.equal(event.kind, "proof");
  assert.equal(event.proofLevel, "wake_injected");
  assert.equal(isExternalAgentCursorAdvancingProofLevel(event.proofLevel), false);
});

test("adapter cannot upgrade wake events into model_seen", () => {
  assert.throws(
    () => validateExternalAgentWakeEventEnvelope({
      ...baseEvent,
      kind: "proof",
      proofLevel: "model_seen",
      outcome: "ok",
      lifecycleState: "handoff_pending",
      authority: {
        source: "wake_adapter",
        provenance: "adapter_observed",
      },
    }),
    /proofLevel[\s\S]*wake_injected/,
  );
});

test("comms core cannot claim wake_injected proof", () => {
  assert.throws(
    () => validateExternalAgentWakeEventEnvelope({
      ...baseEvent,
      kind: "proof",
      proofLevel: "wake_injected",
      outcome: "ok",
      lifecycleState: "handoff_pending",
      authority: {
        source: "comms_core",
        provenance: "slock_core",
      },
    }),
    /wake_injected proof must be sourced by wake_adapter/,
  );
});

test("adapter failure is explicit outcome metadata and not a proof level", () => {
  const event = validateExternalAgentWakeEventEnvelope({
    ...baseEvent,
    kind: "wake_attempt",
    outcome: "failed",
    failureMeta: {
      failureClass: "no_session",
      retryAfterMs: 1000,
    },
    reason: "Claude Code interactive session is not attached",
    lifecycleState: "degraded_backoff",
    authority: {
      source: "wake_adapter",
      provenance: "adapter_observed",
    },
  });

  assert.equal(event.kind, "wake_attempt");
  assert.equal(event.outcome, "failed");
  assert.equal(event.failureMeta.failureClass, "no_session");
  assert.equal("proofLevel" in event, false);
});

test("failed wake cannot carry proofLevel", () => {
  assert.throws(
    () => validateExternalAgentWakeEventEnvelope({
      ...baseEvent,
      kind: "wake_attempt",
      proofLevel: "model_seen",
      outcome: "failed",
      failureMeta: {
        failureClass: "injection_failed",
      },
      reason: "local log is not model-visible consumption",
      lifecycleState: "degraded_backoff",
      authority: {
        source: "wake_adapter",
        provenance: "adapter_observed",
      },
    }),
    /expected undefined, received string/,
  );
});

test("pre-injection events can omit runtimeSession without losing attempt partition", () => {
  const event = validateExternalAgentWakeEventEnvelope({
    ...baseEvent,
    runtimeSession: null,
    kind: "proof",
    proofLevel: "harness_accepted",
    outcome: "ok",
    lifecycleState: "handoff_pending",
    authority: {
      source: "comms_core",
      provenance: "slock_core",
    },
  });

  assert.equal(event.runtimeSession, null);
  assert.equal(event.attemptId, "attempt-1");
});
