import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";

import { BasicTracer, DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RECONCILE_V1, MemoryTraceSink } from "@botiverse/raft-shared";
import { inArray } from "drizzle-orm";

import { getDb } from "../db/index";
import { agentCredentials, agents, users } from "../db/schema";
import { AgentOrchestrator } from "./agentOrchestrator";
import { RUNNER_NOT_HELD_REVOKE_REASON } from "./agentCredentialService";
import { createFeatureFlag, RUNNER_CREDENTIAL_RECONCILE_FEATURE_FLAG_KEY } from "./featureFlagService";
import { registerMachine } from "./machineService";
import type { ReplicaStateStore } from "./replicaStateStore";
import { createServer } from "./serverService";

// #wg-rbac:#27: a connection's first `ready` with runner-credential-reconcile:v1
// revokes this Machine's runner credentials it does not list; later readies
// on the same connection, and readies without the capability, revoke nothing.

afterEach(async () => {
  await closeTestDatabase();
});

const store = {
  isAvailable: () => true,
  registerMachineReplica: async () => "generation-1",
  restoreMachineReplicaGeneration: async () => {},
  unregisterMachineReplica: async () => {},
  refreshMachineReplica: async () => "refreshed",
  hasMachineReplica: async () => true,
  getMachineReplicaOwner: async () => "replica-1",
  bumpMachineStatusVersion: async () => 1,
  getMachineStatusVersion: async () => 1,
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
} as ReplicaStateStore;

function fakeWs() {
  return { readyState: 1, OPEN: 1, send: () => {}, close() { this.readyState = 3; }, terminate() { this.readyState = 3; } };
}

async function seed(label: string) {
  const [user] = await getDb()
    .insert(users)
    .values({ email: `reconcile-${label}@slock.test`, name: `reconcile-${label}`, passwordHash: "hash", emailVerified: true })
    .returning();
  const server = await createServer(`Reconcile ${label}`, `reconcile-${label}`, user!.id);
  const { machine } = await registerMachine(server.id, user!.id, `reconcile-${label}-machine`);
  const [agent] = await getDb().insert(agents).values({ serverId: server.id, name: `r-${label}`, machineId: machine.id }).returning();
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  const mint = async () => (await getDb().insert(agentCredentials).values({
    agentId: agent!.id,
    apiKeyHash: "x",
    apiKeyPrefix: "sk_agent_x",
    scopes: ["send"],
    name: "runner:claude:00000000",
    issuedVia: "computer",
    issuedByMachineId: machine.id,
    createdAt: hourAgo,
  }).returning({ id: agentCredentials.id }))[0]!.id;
  return { serverId: server.id, machineId: machine.id, mint };
}

async function reasons(ids: string[]) {
  const rows = await getDb().select({ id: agentCredentials.id, reason: agentCredentials.revokedReason })
    .from(agentCredentials).where(inArray(agentCredentials.id, ids));
  return Object.fromEntries(rows.map((row) => [row.id, row.reason]));
}

async function reconciled(sink: MemoryTraceSink, count: number) {
  const events = () => [...sink.getAllLogEvents(), ...sink.getAllSpans().flatMap((span) => span.events)]
    .filter((event) => event.name === "server.machine.runner_credentials.reconciled");
  for (let i = 0; i < 200 && events().length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  return events();
}

const ready = (extra: Record<string, unknown>) => ({ type: "ready", runtimes: [], runningAgents: [], daemonVersion: "1.0.64", ...extra });

test("the first ready revokes the unlisted ones; a second ready on the connection revokes nothing", async ({ db: _db }) => {
  const { serverId, machineId, mint } = await seed("first");
  await createFeatureFlag({ key: RUNNER_CREDENTIAL_RECONCILE_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  const [held, orphan] = [await mint(), await mint()];
  const sink = new MemoryTraceSink();
  const orchestrator = new AgentOrchestrator(store, undefined, new BasicTracer({ sink }));
  const ws = fakeWs();
  await orchestrator.registerMachine(machineId, serverId, ws as never);

  await orchestrator.handleMachineMessage(machineId, ready({
    capabilities: [DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RECONCILE_V1],
    runnerCredentialIds: [held],
  }) as never, ws as never);
  const [event] = await reconciled(sink, 1);
  assert.equal(event?.attrs?.revoked_count, 1);
  assert.deepEqual(await reasons([held, orphan]), { [held]: null, [orphan]: RUNNER_NOT_HELD_REVOKE_REASON });

  // A start dispatched after the first ready: its key is not yet listed.
  const later = await mint();
  await orchestrator.handleMachineMessage(machineId, ready({
    capabilities: [DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RECONCILE_V1],
    runnerCredentialIds: [held],
  }) as never, ws as never);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await reconciled(sink, 2)).length, 1, "only the first ready reconciles");
  assert.deepEqual(await reasons([later]), { [later]: null });
  await orchestrator.shutdown();
});

test("a ready without the capability makes no claim and revokes nothing", async ({ db: _db }) => {
  const { serverId, machineId, mint } = await seed("old");
  await createFeatureFlag({ key: RUNNER_CREDENTIAL_RECONCILE_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  const orphan = await mint();
  const sink = new MemoryTraceSink();
  const orchestrator = new AgentOrchestrator(store, undefined, new BasicTracer({ sink }));
  const ws = fakeWs();
  await orchestrator.registerMachine(machineId, serverId, ws as never);

  await orchestrator.handleMachineMessage(machineId, ready({ runnerCredentialIds: [] }) as never, ws as never);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await reconciled(sink, 1)).length, 0);
  assert.deepEqual(await reasons([orphan]), { [orphan]: null });
  await orchestrator.shutdown();
});

test("with the switch off (or missing), a claiming ready logs per Machine what it would revoke and revokes nothing", async ({ db: _db }) => {
  const { serverId, machineId, mint } = await seed("count");
  const [held, orphan] = [await mint(), await mint()];
  const sink = new MemoryTraceSink();
  const orchestrator = new AgentOrchestrator(store, undefined, new BasicTracer({ sink }));
  const ws = fakeWs();
  await orchestrator.registerMachine(machineId, serverId, ws as never);

  await orchestrator.handleMachineMessage(machineId, ready({
    capabilities: [DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RECONCILE_V1],
    runnerCredentialIds: [held],
  }) as never, ws as never);
  const [event] = await reconciled(sink, 1);
  assert.equal(event?.attrs?.outcome, "count_only");
  assert.equal(event?.attrs?.machine_id, machineId);
  assert.equal(event?.attrs?.would_revoke_count, 1);
  assert.deepEqual(await reasons([held, orphan]), { [held]: null, [orphan]: null });
  await orchestrator.shutdown();
});
