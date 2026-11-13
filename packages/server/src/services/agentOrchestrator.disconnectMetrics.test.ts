import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";

import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { users } from "../db/schema";
import { machineCloseCodeLabel, machineConnectionLifetimeLabel, machineDisconnectsTotal } from "../metrics";
import { AgentOrchestrator } from "./agentOrchestrator";
import { registerMachine } from "./machineService";
import type { ReplicaStateStore } from "./replicaStateStore";
import { createServer } from "./serverService";

// Why machines reconnect so often (#440, #proj-o11y:d32a682c): the close code
// was only in a log line that is not kept in full. Every connection that ends
// is counted once, with its cause, close code and how long it lived.

afterEach(async () => {
  await closeTestDatabase();
});

async function disconnects(labels: Record<string, string>): Promise<number> {
  const metric = await machineDisconnectsTotal.get();
  return metric.values
    .filter((value) => Object.entries(labels).every(([key, want]) => value.labels[key as keyof typeof value.labels] === want))
    .reduce((sum, value) => sum + value.value, 0);
}

function makeFakeMachineWs() {
  return {
    readyState: 1,
    OPEN: 1,
    send: () => {},
    close() {
      this.readyState = 3;
    },
    terminate() {
      this.readyState = 3;
    },
  };
}

function makeReplicaStateStore(): ReplicaStateStore {
  let statusVersion = 0;
  return {
    isAvailable: () => true,
    registerMachineReplica: async () => "test-generation",
    restoreMachineReplicaGeneration: async () => {},
    unregisterMachineReplica: async () => {},
    refreshMachineReplica: async () => {},
    hasMachineReplica: async () => true,
    getMachineReplicaOwner: async () => "test-replica",
    bumpMachineStatusVersion: async () => {
      statusVersion += 1;
      return statusVersion;
    },
    getMachineStatusVersion: async () => statusVersion,
    acquireWakeLock: async () => true,
    releaseWakeLock: async () => {},
    setAgentActivity: async () => {},
    getAgentActivity: async () => null,
    getWakeCrashLoopState: async () => null,
    compareAndSetWakeCrashLoopState: async () => true,
    setAgentRuntimeError: async () => {},
    getAgentRuntimeError: async () => null,
    setAgentContextViewAvailability: async () => {},
    getAgentContextViewAvailability: async () => null,
    clearAgentContextViewAvailability: async () => {},
    setMachineMeta: async () => {},
    getMachineMeta: async () => null,
    clearMachineMeta: async () => {},
  };
}

async function seedMachine() {
  const [user] = await getDb()
    .insert(users)
    .values({ email: "disconnect-metrics@slock.test", name: "disconnect-metrics", passwordHash: "hash", emailVerified: true })
    .returning();
  const server = await createServer("Disconnect metrics", "disconnect-metrics", user!.id);
  const { machine } = await registerMachine(server.id, user!.id, "disconnect-machine");
  return { serverId: server.id, machineId: machine.id };
}

test("a connection that ends is counted once, with its cause and close code, and the span carries the code", async ({ db: _db }) => {
  const { serverId, machineId } = await seedMachine();
  const sink = new MemoryTraceSink();
  const orchestrator = new AgentOrchestrator(makeReplicaStateStore(), undefined, new BasicTracer({ sink }));
  const labels = { cause: "heartbeat_timeout", close_code: "none", shutdown_reason: "none", daemon_version: "unknown", conn_age: "<30s" };
  const before = await disconnects(labels);
  const closesBefore = await disconnects({ cause: "socket_close" });

  const ws = makeFakeMachineWs();
  await orchestrator.registerMachine(machineId, serverId, ws as never);
  // The server times the heartbeat out, then the same socket's close fires.
  await orchestrator.handleMachineDisconnect(machineId, ws as never, { cause: "heartbeat_timeout" });
  await orchestrator.handleMachineDisconnect(machineId, ws as never, { cause: "socket_close", closeCode: 1006 });

  // Never sent ready, so no daemon version; lived well under 30 seconds.
  assert.equal((await disconnects(labels)) - before, 1);
  assert.equal((await disconnects({ cause: "socket_close" })) - closesBefore, 0, "the duplicate close of the same socket is not a second disconnect");

  const ws2 = makeFakeMachineWs();
  const codeBefore = await disconnects({ cause: "socket_close", close_code: "1006" });
  await orchestrator.registerMachine(machineId, serverId, ws2 as never);
  await orchestrator.handleMachineDisconnect(machineId, ws2 as never, { cause: "socket_close", closeCode: 1006 });
  assert.equal((await disconnects({ cause: "socket_close", close_code: "1006" })) - codeBefore, 1);

  const spans = sink.getAllSpans().filter((span) => span.name === "server.machine.connection.disconnect");
  assert.ok(spans.some((span) => span.attrs?.close_code === 1006), "the disconnect span carries the close code value");
  orchestrator.shutdown();
});

test("close codes and connection lifetimes map to closed label sets", () => {
  assert.equal(machineCloseCodeLabel(undefined), "none");
  assert.equal(machineCloseCodeLabel(1000), "1000");
  assert.equal(machineCloseCodeLabel(1005), "1005");
  assert.equal(machineCloseCodeLabel(1006), "1006");
  assert.equal(machineCloseCodeLabel(4002), "4002");
  assert.equal(machineCloseCodeLabel(4999), "other");
  assert.equal(machineCloseCodeLabel(3000), "other");
  assert.equal(machineCloseCodeLabel(1000.5), "other");

  assert.equal(machineConnectionLifetimeLabel(undefined), "unknown");
  assert.equal(machineConnectionLifetimeLabel(29_999), "<30s");
  assert.equal(machineConnectionLifetimeLabel(30_000), "30-60s");
  assert.equal(machineConnectionLifetimeLabel(90_000), "1-2m");
  assert.equal(machineConnectionLifetimeLabel(140_000), "2-5m");
  assert.equal(machineConnectionLifetimeLabel(7 * 60_000), "5-10m");
  assert.equal(machineConnectionLifetimeLabel(20 * 60_000), "10-60m");
  assert.equal(machineConnectionLifetimeLabel(2 * 3_600_000), "1-6h");
  assert.equal(machineConnectionLifetimeLabel(7 * 3_600_000), ">6h");
});
