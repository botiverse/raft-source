import assert from "node:assert/strict";
import { AGENT_MIGRATION_CAPABILITY, AGENT_MIGRATION_TARGET_IGNORE_SOURCES_CAPABILITY } from "@botiverse/raft-shared";
import { AgentOrchestrator } from "./agentOrchestrator";

// .raftbackupignore (#wg-agent-migration:7746de27): the target validates the
// source's summary with its own strict schema, so the source lease says whether
// the target accepts `excludedIgnoredBySource`.

type LeaseMessage = Parameters<AgentOrchestrator["sendAgentMigrationTransportLease"]>[1];

function harness(transports: Record<string, string[] | null>) {
  const sent: Array<{ machineId: string; message: LeaseMessage }> = [];
  const h = {
    sent,
    getMachineMigrationTransport: async (machineId: string) => {
      const capabilities = transports[machineId];
      return capabilities === undefined ? null : { capabilities };
    },
    sendRequiredToMachine: async (machineId: string, message: LeaseMessage) => {
      sent.push({ machineId, message });
    },
  };
  Object.assign(h, {
    withTargetIgnoreSourcesAcceptance: (AgentOrchestrator.prototype as unknown as {
      withTargetIgnoreSourcesAcceptance: (msg: LeaseMessage) => Promise<LeaseMessage>;
    }).withTargetIgnoreSourcesAcceptance,
  });
  return h;
}

function lease(role: "source" | "target", targetMachineId = "target-1"): LeaseMessage {
  return {
    type: "machine:migration_transport:lease",
    agentId: "agent-1",
    migrationId: "migration-1",
    migrationRef: "mig_AAAAAAAAAAAAAAAAAAAAAA",
    migrationGeneration: "generation-1",
    sessionId: "session-1",
    role,
    provider: "object_store",
    transferKind: role === "source" ? "upload" : "download",
    leaseSource: "server",
    bearerToken: "token",
    expiresAt: "2026-11-05T05:00:00.000Z",
    maxBytes: 1,
    controlUrl: "/internal/computer/agent-migrations/by-id/migration-1/resumable",
    leaseId: "lease-1",
    transportGeneration: "transport-1",
    sourceMachineId: "source-1",
    targetMachineId,
    expectedMigrationRevision: 1,
  };
}

const send = (h: ReturnType<typeof harness>, machineId: string, message: LeaseMessage) =>
  AgentOrchestrator.prototype.sendAgentMigrationTransportLease.call(h as never, machineId, message);

test("the source lease says the target accepts ignore sources only when the target advertises it", async () => {
  const h = harness({
    "target-new": [AGENT_MIGRATION_CAPABILITY, AGENT_MIGRATION_TARGET_IGNORE_SOURCES_CAPABILITY],
    "target-old": [AGENT_MIGRATION_CAPABILITY],
    "target-unknown": null,
  });

  await send(h, "source-1", lease("source", "target-new"));
  await send(h, "source-1", lease("source", "target-old"));
  await send(h, "source-1", lease("source", "target-unknown"));
  await send(h, "source-1", lease("source", "hosted:target"));
  await send(h, "target-new", lease("target", "target-new"));

  assert.deepEqual(h.sent.map((entry) => entry.message.targetAcceptsIgnoreSources), [true, undefined, undefined, undefined, undefined]);
  assert.deepEqual(h.sent[0]!.message, { ...lease("source", "target-new"), targetAcceptsIgnoreSources: true });
  assert.ok(!("targetAcceptsIgnoreSources" in h.sent[1]!.message), "an older target's source lease is unchanged");
  assert.deepEqual(h.sent.map((entry) => entry.machineId), ["source-1", "source-1", "source-1", "source-1", "target-new"]);
});
