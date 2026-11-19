/**
 * #proj-runtime:#62: what an enforced repeated-wake trip does, on the real
 * start and stop paths with real DB rows; only the machine socket and the
 * inbox-chain source (RisingWave) are stubbed (as in
 * agentOrchestrator.startFailureCatchup.test.ts).
 *
 * - Both ends of the exclusion's lifetime: an automatic start leaves the
 *   message out of its catch-up; a person's start carries it again and clears
 *   the exclusion.
 * - The trip: with `agent_repeated_wake_guard` off it only records; on, it
 *   leaves the message out and stops the process (the agent stays startable).
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";

import type { ServerToMachineMessage } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { agents, machines, serverMembers, servers, users } from "../db/schema";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { AgentOrchestrator } from "./agentOrchestrator";
import { repeatedWakeExclusion, resetRepeatedWakeStoreForTests, setRepeatedWakeExclusion } from "./agentRepeatedWakeStore";
import * as channelService from "./channelService";
import { AGENT_REPEATED_WAKE_GUARD_FEATURE_FLAG_KEY, createFeatureFlag } from "./featureFlagService";
import { createMessage } from "./messageService";

afterEach(async () => {
  resetRepeatedWakeStoreForTests();
  await closeTestDatabase();
});

class CapturingOrchestrator extends AgentOrchestrator {
  readonly sent: ServerToMachineMessage[] = [];

  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    this.sent.push(msg);
    return true;
  }

  protected override async selectResumeInbox(agentId: string): Promise<channelService.AgentInboxChainSelection> {
    return { source: "chain", rows: await referenceAgentInboxChain(agentId) } as channelService.AgentInboxChainSelection;
  }

  starts(): Array<Extract<ServerToMachineMessage, { type: "agent:start" }>> {
    return this.sent.filter((msg): msg is Extract<ServerToMachineMessage, { type: "agent:start" }> => msg.type === "agent:start");
  }
}

async function seed(suffix: string, status: "inactive" | "active" = "inactive") {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `repeated-wake-${suffix}@example.com`,
    name: "Loop Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: "Loop", slug: `repeated-wake-${suffix}`, ownerId: owner!.id }).returning();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
  const [machine] = await db.insert(machines).values({
    serverId: server!.id,
    userId: owner!.id,
    name: "loop-box",
    apiKeyHash: `hash-${suffix}`,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "grokker",
    status,
    runtime: "kimi-sdk",
    model: "devin/swe-2",
    executionMode: "byoc",
    machineId: machine!.id,
    sessionId: `session-${suffix}`,
    creatorType: "user",
    creatorId: owner!.id,
  }).returning();
  const dm = await channelService.findOrCreateDM(server!.id, owner!.id, agent!.id);
  assert.ok(dm);
  const message = await createMessage(dm.id, "user", owner!.id, "please summarise the doc");
  return { owner: owner!, server: server!, machine: machine!, agent: agent!, dm: dm!, message };
}

function bindMachine(orchestrator: AgentOrchestrator, machineId: string, serverId: string): void {
  (orchestrator as any).machineConnections.set(machineId, {
    ws: { readyState: 1, send: () => {} },
    machineId,
    serverId,
    principalKind: "computer",
    connectionEpochId: `epoch-${machineId}`,
    heartbeatTimer: null,
    runtimeAccountUsageTimer: null,
    lastPong: Date.now(),
    lastIngressAt: Date.now(),
    daemonVersion: "1.0.42",
    capabilities: new Set<string>(),
    runtimes: ["kimi-sdk"],
    migrationTransport: null,
    shutdownIntent: null,
    computerVersion: "1.0.42",
  });
}

function carried(start: Extract<ServerToMachineMessage, { type: "agent:start" }>): string[] {
  return [...(start.wakeMessage ? [start.wakeMessage] : []), ...(start.resumeMessages ?? [])]
    .map((m) => m.message_id)
    .filter((id): id is string => typeof id === "string");
}

for (const [label, options] of [["a retry", { startCause: "start_failure_retry" as const }], ["a start with no person's control", {}]] as const) {
test(`#62: ${label} leaves the excluded message out of its catch-up; it stays unread`, async ({ db: _db }) => {
  const { machine, server, agent, dm, message } = await seed(label === "a retry" ? "auto" : "nocontrol");
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id);
    await setRepeatedWakeExclusion(agent.id, message.id);
    const started = await orchestrator.startAgent(agent.id, options);
    assert.equal(started.outcome, "dispatched");
    const [start] = orchestrator.starts();
    assert.ok(start);
    assert.ok(!carried(start).includes(message.id), `left out; got ${JSON.stringify(carried(start))}`);
    assert.equal(await repeatedWakeExclusion(agent.id), message.id, "an automatic start keeps the exclusion");
    assert.equal(await channelService.getAgentLegacyReadCursor(agent.id, dm.id), 0, "still unread");
  } finally {
    await orchestrator.shutdown();
  }
});
}

test("#62: a person's start carries the excluded message again and clears the exclusion", async ({ db: _db }) => {
  const { machine, server, agent, message } = await seed("human");
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id);
    await setRepeatedWakeExclusion(agent.id, message.id);
    // The Start button's start (routes/agents.ts): `human_start`. A start
    // with no control (an auto-start, a migration) is not a person's.
    const started = await orchestrator.startAgent(agent.id, { control: "human_start" });
    assert.equal(started.outcome, "dispatched");
    const [start] = orchestrator.starts();
    assert.ok(start);
    assert.ok(carried(start).includes(message.id), `carried again; got ${JSON.stringify(carried(start))}`);
    assert.equal(await repeatedWakeExclusion(agent.id), null);
  } finally {
    await orchestrator.shutdown();
  }
});

test("#62: a trip on turns no frame from this replica named stops the process only", async ({ db: _db }) => {
  const { machine, server, agent } = await seed("trip-unnamed", "active");
  await createFeatureFlag({ key: AGENT_REPEATED_WAKE_GUARD_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id);
    const cached = await (orchestrator as any).getCachedAgent(agent.id);
    await (orchestrator as any).onRepeatedWakeTrip(cached, machine.id, "1.0.42", {
      input: { key: "", excludeId: null, messageId: null, channelId: null },
      emptyTurns: 10,
      toolStarts: 0,
      streakStartedAtMs: Date.now() - 300_000,
    });
    assert.equal(orchestrator.sent.filter((msg) => msg.type === "agent:stop").length, 1);
    assert.equal(await repeatedWakeExclusion(agent.id), null, "nothing named, nothing left out");
  } finally {
    await orchestrator.shutdown();
  }
});

for (const enforced of [false, true]) {
  test(`#62: a trip ${enforced ? "with the flag on stops the process and leaves the message out" : "with the flag off only records"}`, async ({ db: _db }) => {
    const { machine, server, agent, dm, message } = await seed(enforced ? "trip-on" : "trip-off", "active");
    if (enforced) {
      await createFeatureFlag({ key: AGENT_REPEATED_WAKE_GUARD_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
    }
    const orchestrator = new CapturingOrchestrator();
    try {
      bindMachine(orchestrator, machine.id, server.id);
      const cached = await (orchestrator as any).getCachedAgent(agent.id);
      assert.ok(cached);
      await (orchestrator as any).onRepeatedWakeTrip(cached, machine.id, "1.0.42", {
        input: { key: message.id, excludeId: message.id, messageId: message.id, channelId: dm.id },
        emptyTurns: 10,
        toolStarts: 0,
        streakStartedAtMs: Date.now() - 300_000,
      });
      const stops = orchestrator.sent.filter((msg) => msg.type === "agent:stop");
      assert.equal(stops.length, enforced ? 1 : 0);
      assert.equal(await repeatedWakeExclusion(agent.id), enforced ? message.id : null);
      const [row] = await getDb().select({ status: agents.status }).from(agents).where(eq(agents.id, agent.id));
      assert.notEqual(row?.status, "stopped", "the agent stays on: only its process ends");
    } finally {
      await orchestrator.shutdown();
    }
  });
}
