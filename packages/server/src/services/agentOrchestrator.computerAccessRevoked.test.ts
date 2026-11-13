/**
 * Reconciler step 15 (B15, Tenny Q-7): an agent whose Computer's key was
 * revoked stays bound to it and gets no start or wake. Real DB rows and the
 * real start path; only the machine socket is stubbed. The refusal comes
 * before the wake crash-loop and terminal-failure breakers, so neither counts
 * it, and nothing is tracked for a replay the machine can never take.
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { ServerToMachineMessage } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agents, computers, machines, serverMembers, servers, users } from "../db/schema";
import { AgentOrchestrator } from "./agentOrchestrator";

afterEach(async () => {
  await closeTestDatabase();
});

class CountingOrchestrator extends AgentOrchestrator {
  readonly sent: ServerToMachineMessage[] = [];
  readonly events: Array<[string, Record<string, unknown>]> = [];
  readonly breakerCalls: string[] = [];

  constructor() {
    super();
    const recordEvent = (this as any).recordEvent.bind(this);
    (this as any).recordEvent = (name: string, attrs: Record<string, unknown> = {}) => {
      this.events.push([name, attrs]);
      return recordEvent(name, attrs);
    };
    // Every way a start reaches the two breakers.
    const crashLoop = (this as any).wakeCrashLoopBreaker;
    for (const method of ["automaticWakeHold", "recordStart"] as const) {
      const original = crashLoop[method].bind(crashLoop);
      crashLoop[method] = (...args: unknown[]) => {
        this.breakerCalls.push(`wakeCrashLoop.${method}`);
        return original(...args);
      };
    }
    for (const method of ["terminalStartGate", "claimTerminalStart"] as const) {
      const original = (this as any)[method].bind(this);
      (this as any)[method] = (...args: unknown[]) => {
        this.breakerCalls.push(`terminal.${method}`);
        return original(...args);
      };
    }
  }

  get starts() {
    return this.sent.filter((m) => m.type === "agent:start");
  }

  /** No replica holds the machine's socket: a send reports "not sent", as for an offline Computer. */
  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "agent:start") return false;
    this.sent.push(msg);
    return true;
  }

  pendingStarts(): number {
    return (this as any).pendingAgentStartAcks.size;
  }
}

async function seed(key: "revoked" | "live" | "none") {
  const tag = `b15-${randomUUID().slice(0, 8)}`;
  const db = getDb();
  const [owner] = await db.insert(users).values({ email: `${tag}@example.com`, name: tag, passwordHash: "hash", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "B15", slug: tag, ownerId: owner!.id }).returning();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
  const [machine] = await db.insert(machines).values({ serverId: server!.id, userId: owner!.id, name: "revoked-mac", apiKeyHash: `hash-${tag}` }).returning();
  if (key !== "none") {
    await db.insert(computers).values({
      serverId: server!.id,
      name: "revoked-mac",
      apiKeyHash: `computer-hash-${tag}`,
      apiKeyPrefix: `sk_computer_${tag}`.slice(0, 16),
      attachedByUserId: owner!.id,
      machineId: machine!.id,
      ...(key === "revoked" ? { revokedAt: new Date(), revokedReason: "computer_key_revoked" } : {}),
    });
  }
  const [agent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "b15-agent",
    status: "inactive",
    runtime: "claude",
    model: "sonnet",
    executionMode: "byoc",
    machineId: machine!.id,
  }).returning();
  return { server: server!, machine: machine!, agent: agent! };
}

const wakeMessage = { message_id: "m-1", channel_id: "channel-1", seq: 1, content: "hi" } as never;

test("a revoked Computer: message wakes and manual starts are refused before the breakers, with a trace", async ({ db: _db }) => {
  const { machine, agent } = await seed("revoked");
  const orchestrator = new CountingOrchestrator();
  try {
    assert.equal(await orchestrator.isMachineAccessRevoked(machine.id), true);

    assert.deepEqual(await orchestrator.startAgent(agent.id, { wakeMessage }), { outcome: "skipped", reason: "computer_access_revoked" });
    assert.deepEqual(await orchestrator.startAgent(agent.id, { control: "human_start" }), { outcome: "skipped", reason: "computer_access_revoked" });

    assert.equal(orchestrator.starts.length, 0, "no agent:start");
    assert.equal(orchestrator.pendingStarts(), 0, "no start kept for a replay the machine can never take");
    assert.deepEqual(orchestrator.breakerCalls, [], "neither breaker sees it");
    const suppressed = orchestrator.events.filter(([name]) => name === "server.agent.wake.suppressed");
    assert.deepEqual(suppressed.map(([, attrs]) => [attrs.reason, attrs.start_cause]), [
      ["computer_access_revoked", "message"],
      ["computer_access_revoked", "manual"],
    ]);
    const lifecycle = orchestrator.getRecentLifecycleEvents(agent.id).filter((event) => event.detail === "computer_access_revoked");
    assert.deepEqual(lifecycle.map((event) => [event.action, event.outcome]), [["wake", "suppressed"], ["wake", "suppressed"]]);
  } finally {
    orchestrator.shutdown();
  }
});

for (const key of ["live", "none"] as const) {
  test(`control: a ${key === "live" ? "live Computer key" : "legacy machine (no Computer row)"} that is offline is started as before`, async ({ db: _db }) => {
    const { machine, agent } = await seed(key);
    const orchestrator = new CountingOrchestrator();
    try {
      assert.equal(await orchestrator.isMachineAccessRevoked(machine.id), false);
      await assert.rejects(orchestrator.startAgent(agent.id, { control: "human_start" }), /Machine offline/);
      assert.ok(orchestrator.breakerCalls.includes("wakeCrashLoop.recordStart"), "the start went through the breakers");
      assert.equal(orchestrator.events.some(([name]) => name === "server.agent.wake.suppressed"), false);
    } finally {
      orchestrator.shutdown();
    }
  });
}

test("a revoked machine still connected here is not refused: the revoke drops its socket after commit", async ({ db: _db }) => {
  const { server, machine } = await seed("revoked");
  const orchestrator = new CountingOrchestrator();
  try {
    (orchestrator as any).machineConnections.set(machine.id, { machineId: machine.id, serverId: server.id });
    assert.equal(await orchestrator.isMachineAccessRevoked(machine.id), false);
  } finally {
    (orchestrator as any).machineConnections.delete(machine.id);
    orchestrator.shutdown();
  }
});
