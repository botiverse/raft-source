import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import Redis from "ioredis";
import { MachineResponseRelay, redisMachineReplyStore, asMachineReplyRequestId, asMachineReplyReplicaId, type MachineReplyStore, type RelayedMachineResponse } from "./machineResponseRelay.js";
import { AgentOrchestrator } from "./services/agentOrchestrator.js";
import { asMachineId, type ServerToMachineMessage } from "@botiverse/raft-shared";

function memoryStore(): MachineReplyStore {
  const rows = new Map<string, Awaited<ReturnType<MachineReplyStore["read"]>>>();
  return {
    async open(request) { rows.set(request.requestId, { ...request }); },
    async write(machineId, response, sourceReplicaId) {
      const row = rows.get(response.requestId);
      if (!row || row.machineId !== machineId || row.type !== response.type) return null;
      if (row.agentId && (!("agentId" in response) || row.agentId !== response.agentId)) return null;
      if (row.migrationId && (!("migrationId" in response) || row.migrationId !== response.migrationId)) return null;
      if (!row.response) { row.response = response; row.sourceReplicaId = sourceReplicaId; }
      return row.replyReplicaId;
    },
    async read(id) { return rows.get(id) ?? null; },
    async remove(id) { rows.delete(id); },
  };
}
const observe = () => {};
function pair(store: MachineReplyStore, notify = true) {
  const requester = new MachineResponseRelay("requester", store, async () => {}, 10);
  const owner = new MachineResponseRelay("owner", store, async (_, id) => {
    if (notify) await requester.consume(id);
  }, 10);
  return { requester, owner };
}

class Replica extends AgentOrchestrator {
  send: (machine: string, message: ServerToMachineMessage) => Promise<void> = async () => {};
  constructor(private relay: MachineResponseRelay) { super(); }
  protected override getMachineResponseRelay() { return this.relay; }
  protected override async sendRequiredToMachine(machine: string, message: ServerToMachineMessage) {
    await this.send(machine, message);
    return "cross_replica" as const;
  }
}

async function orchestratorRoundtrip(store: MachineReplyStore, relays = pair(store)) {
  const { requester, owner } = relays;
  const a = new Replica(requester);
  const b = new Replica(owner);
  a.send = async (machineId, message) => {
    if (message.type === "machine:runtime_models:detect") {
      await b.handleMachineMessage(machineId, {
        type: "machine:runtime_models:result", requestId: message.requestId,
        models: [{ id: "kimi-code/k3", label: "K3", supportedReasoningEfforts: ["high"] }],
      });
    } else if (message.type === "machine:migration:source_workspace_archive") {
      await b.handleMachineMessage(machineId, {
        type: "machine:migration:source_workspace_archive_result", requestId: message.requestId,
        agentId: message.agentId, migrationId: message.migrationId, outcome: "archived",
      });
    }
  };
  assert.deepEqual(await a.detectMachineRuntimeModels("machine-a", "kimi-sdk"), {
    kind: "live", value: { models: [{ id: "kimi-code/k3", label: "K3", supportedReasoningEfforts: ["high"] }], default: undefined },
  });
  assert.equal(await a.archiveAgentMigrationSourceWorkspace("machine-a", { agentId: "agent", migrationId: "migration" }), "archived");
  await assert.rejects(a.detectMachineRuntimeModelsWithAuthority("machine-a", "builtin"), /WebSocket not ready/);
}

test("different orchestrators return model and migration results to their exact requester", async () => {
  await orchestratorRoundtrip(memoryStore());
});

test("local connection keeps model authority and bypasses Redis reply storage", async () => {
  const store = memoryStore();
  store.open = async () => { throw new Error("local discovery must not use Redis"); };
  const { requester } = pair(store);
  const a = new Replica(requester);
  (a as unknown as { machineConnections: Map<string, unknown> }).machineConnections.set("local", {
    ws: { readyState: 1 }, connectionEpochId: "epoch", replicaGeneration: "generation",
    lastPong: Date.now(), lastIngressAt: Date.now(), daemonVersion: "1", computerVersion: "1",
  });
  a.send = async (machineId, message) => {
    if (message.type === "machine:runtime_models:detect") {
      a.emit(`machine:response:${machineId}`, { type: "machine:runtime_models:result", requestId: message.requestId,
        models: [{ id: "model", label: "Model" }] });
    }
  };
  assert.equal((await a.detectMachineRuntimeModels("local", "kimi-sdk")).kind, "live");
  assert.deepEqual((await a.detectMachineRuntimeModelsWithAuthority("local", "builtin")).authority,
    { connectionEpochId: "epoch", replicaGeneration: "generation" });
});

test("lost notification recovers from mailbox; duplicates and wrong identities cannot replace first result", async () => {
  const store = memoryStore();
  const { requester, owner } = pair(store, false);
  const id = asMachineReplyRequestId(randomUUID());
  const correct: RelayedMachineResponse = { type: "machine:migration:source_workspace_archive_result", requestId: id,
    agentId: "agent", migrationId: "migration", outcome: "archived" };
  const trace: Array<{event: string; attrs: Record<string, string | boolean>}> = [];
  const result = requester.request({ requestId: id, machineId: "machine-a", type: correct.type,
    agentId: "agent", migrationId: "migration" }, 500, async () => {
    await owner.forward("wrong-machine", correct, observe);
    await owner.forward("machine-a", { ...correct, requestId: "wrong-request" }, observe);
    await owner.forward("machine-a", { ...correct, migrationId: "wrong-migration" }, observe);
    assert.equal((await store.read(id))?.response, undefined);
    await owner.forward("machine-a", correct, observe);
    await owner.forward("machine-a", { ...correct, outcome: "error" }, observe);
  }, (event, attrs) => trace.push({event, attrs}));
  assert.deepEqual(await result, correct);
  await requester.consume(id);
  assert.equal(trace.filter(row => row.event === "consumed").length, 1);
  assert.equal(trace.find(row => row.event === "consumed")?.attrs.source_replica_id, "owner");
  assert.equal(await store.read(id), null);
});

test("deadline and send failure remove waiters; late responses cannot recreate replies", async () => {
  const store = memoryStore();
  const { requester, owner } = pair(store);
  const id = asMachineReplyRequestId(randomUUID());
  await assert.rejects(requester.request({ requestId: id, machineId: "machine", type: "machine:runtime_models:result" },
    25, async () => {}, observe), /timed out/);
  await owner.forward("machine", { type: "machine:runtime_models:result", requestId: id, models: [] }, observe);
  assert.equal(await store.read(id), null);
  const failed = asMachineReplyRequestId(randomUUID());
  await assert.rejects(requester.request({ requestId: failed, machineId: "machine", type: "machine:runtime_models:result" },
    500, async () => { throw new Error("send failed"); }, observe), /transport unavailable/);
  assert.equal(await store.read(failed), null);
});

test.skipIf(!process.env.MACHINE_REPLY_REDIS_URL)("real Redis atomic mailbox and orchestrator return path", async () => {
  const redis = new Redis(process.env.MACHINE_REPLY_REDIS_URL!);
  try {
    const store = redisMachineReplyStore(() => redis);
    const subscriber = redis.duplicate();
    const channel = `hao-test-reply:${randomUUID()}`;
    const requester = new MachineResponseRelay("requester", store, async () => {}, 250);
    let notifications = 0;
    subscriber.on("message", (_channel, id) => { notifications++; void requester.consume(id); });
    await subscriber.subscribe(channel);
    const owner = new MachineResponseRelay("owner", store, async (_target, id) => { await redis.publish(channel, id); });
    try {
      await orchestratorRoundtrip(store, { requester, owner });
      assert.equal(notifications, 2, "both real Redis notifications must arrive");
      await orchestratorRoundtrip(store, pair(store, false));
    } finally { subscriber.disconnect(); }
    const id = asMachineReplyRequestId(randomUUID());
    await store.open({ requestId: id, machineId: asMachineId("machine"), type: "machine:runtime_models:result", replyReplicaId: asMachineReplyReplicaId("requester") }, 500);
    assert.equal(await store.write("wrong", { type: "machine:runtime_models:result", requestId: id, models: [] }, asMachineReplyReplicaId("owner")), null);
    assert.equal(await store.write("machine", { type: "machine:runtime_models:result", requestId: id, models: [] }, asMachineReplyReplicaId("owner")), "requester");
    await store.remove(id);
    assert.equal(await store.write("machine", { type: "machine:runtime_models:result", requestId: id, models: [] }, asMachineReplyReplicaId("owner")), null);
  } finally { redis.disconnect(); }
});
