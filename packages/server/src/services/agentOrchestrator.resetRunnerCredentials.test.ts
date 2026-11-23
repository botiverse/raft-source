/**
 * A person's Restart / Reset revokes the agent's old runner credentials
 * (ResetAgentOptions.revokeRunnerCredentials) once the daemon reports the
 * stopped launch gone, off the start path: the start goes out at once, and
 * only keys created before the reset began (the database's clock) are
 * revoked, so the new launch's key stays whenever the exit report comes. Real
 * DB rows and the real reset path; only the machine socket is stubbed, and it
 * stands in for the daemon: it mints a launch's runner key when its start
 * arrives, and reports the stopped launch's `agent:process_exited` once the
 * stop arrives (after the reset's start, as a runtime takes a while to exit),
 * unless told not to (a runtime still exiting).
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";

import type { MachineToServerMessage, ServerToMachineMessage } from "@botiverse/raft-shared";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agentCredentials, agents, integrationAuditEvents, machines, serverMembers, servers, users } from "../db/schema";
import { AGENT_RESET_REVOKE_REASON } from "./agentCredentialService";
import { AgentOrchestrator } from "./agentOrchestrator";

afterEach(async () => {
  await closeTestDatabase();
});

class DaemonStandInOrchestrator extends AgentOrchestrator {
  readonly sent: ServerToMachineMessage[] = [];
  /** The runner key minted when a start reached the "daemon", in order. */
  readonly mintedOnStart: string[] = [];
  /** What reached the "daemon" and what it reported, in order. */
  readonly order: string[] = [];
  /** Whether the "daemon" reports the stopped launch's exit. */
  reportsExitOnStop = true;
  /** A launch whose exit the "daemon" reports late, while a stop is under way. */
  staleExitOnStop: string | null = null;
  readonly frames: Promise<unknown>[] = [];
  readonly events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  /** The launch the "daemon" runs (its last start's). */
  private runningLaunchId: string | null = null;

  constructor(exitTimeoutMs = 2_000) {
    super();
    this.resetStopExitTimeoutMs = exitTimeoutMs;
    const self = this as unknown as { recordEvent: (name: string, attrs?: Record<string, unknown>) => void };
    const recordEvent = self.recordEvent.bind(this);
    self.recordEvent = (name, attrs = {}) => {
      this.events.push({ name, attrs });
      recordEvent(name, attrs);
    };
  }

  /** The revokes the reset left running, and the "daemon's" frames, settled. */
  async settled(): Promise<void> {
    await Promise.allSettled(this.frames);
    await this.resetRevokesSettled();
  }

  async close(): Promise<void> {
    await this.settled();
    // What a frame set off in the background ends before the database closes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await this.shutdown();
    assert.equal(this.exitWaiterCount(), 0, "no exit waiter outlives the orchestrator");
  }

  exitWaiterCount(): number {
    const waiters = (this as unknown as { resetStopExitWaiters: Map<string, Set<unknown>> }).resetStopExitWaiters;
    return [...waiters.values()].reduce((count, set) => count + set.size, 0);
  }

  reportExit(machineId: string, agentId: string, launchId: string): Promise<void> {
    this.order.push(`exit:${launchId}`);
    return this.handleMachineMessage(machineId, {
      type: "agent:process_exited", agentId, daemonInstanceId: "daemon-1", processInstanceId: `process-${launchId}`,
      spawnLaunchId: launchId, launchId, clientSeq: 1, code: 0, signal: "SIGTERM",
    } as MachineToServerMessage);
  }

  reportInactive(machineId: string, agentId: string): Promise<void> {
    return this.handleMachineMessage(machineId, { type: "agent:status", agentId, status: "inactive" } as MachineToServerMessage);
  }

  protected override async sendToMachine(machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    // The Computer offline: nothing is sent.
    if (!(this as unknown as { machineConnections: Map<string, unknown> }).machineConnections.has(machineId)) return false;
    this.sent.push(msg);
    if (msg.type === "agent:stop") {
      this.order.push("stop");
      const stopped = this.runningLaunchId;
      this.runningLaunchId = null;
      const stale = this.staleExitOnStop;
      if (stale) this.frames.push(delay(5).then(() => this.reportExit(machineId, msg.agentId, stale)));
      // The runtime exits a while after the stop, by when the start is in.
      if (stopped && this.reportsExitOnStop) this.frames.push(delay(30).then(() => this.reportExit(machineId, msg.agentId, stopped)));
    }
    if (msg.type === "agent:start") {
      this.order.push("start");
      this.runningLaunchId = msg.launchId ?? null;
      this.mintedOnStart.push(await insertKey(msg.agentId, { machineId }));
    }
    return true;
  }

  resetCredentialEvents() {
    return this.events.filter((event) => event.name === "server.agent.reset.runner_credentials_revoked").map((event) => event.attrs);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PERSONS_RESET = (actorUserId: string) => ({ terminalControl: "human_reset" as const, revokeRunnerCredentials: { actorUserId } });

let seedCounter = 0;
async function seed() {
  const tag = `reset-revoke-${process.pid}-${seedCounter += 1}`;
  const db = getDb();
  const [owner] = await db.insert(users).values({ email: `${tag}@example.com`, name: `Owner ${tag}`, passwordHash: "hash", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "Reset", slug: tag, ownerId: owner!.id }).returning();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
  const [machine] = await db.insert(machines).values({ serverId: server!.id, userId: owner!.id, name: "reset-mac", apiKeyHash: `hash-${tag}` }).returning();
  const agentRow = (name: string) => ({
    serverId: server!.id, name, status: "active" as const, runtime: "claude", model: "sonnet", executionMode: "byoc" as const, machineId: machine!.id, sessionId: null,
  });
  const [agent] = await db.insert(agents).values(agentRow("reset-agent")).returning();
  const [other] = await db.insert(agents).values(agentRow("other-agent")).returning();
  return { owner: owner!, server: server!, machine: machine!, agent: agent!, other: other! };
}

let keyCounter = 0;
async function insertKey(agentId: string, key: { machineId?: string; issuedVia?: "computer" | "human" | "app"; createdByUserId?: string; name?: string }): Promise<string> {
  keyCounter += 1;
  const [row] = await getDb().insert(agentCredentials).values({
    agentId,
    apiKeyHash: `hash-${process.pid}-${keyCounter}`,
    apiKeyPrefix: "sk_agent_x",
    scopes: ["send"],
    name: key.name ?? `runner:claude:${agentId.slice(0, 8)}`,
    issuedVia: key.issuedVia ?? "computer",
    issuedByMachineId: key.machineId ?? null,
    createdByUserId: key.createdByUserId ?? null,
  }).returning({ id: agentCredentials.id });
  return row!.id;
}

function bindMachine(orchestrator: AgentOrchestrator, machineId: string, serverId: string): void {
  (orchestrator as any).machineConnections.set(machineId, {
    ws: {},
    machineId,
    serverId,
    principalKind: "computer",
    connectionEpochId: `epoch-${machineId}`,
    heartbeatTimer: null,
    runtimeAccountUsageTimer: null,
    lastPong: Date.now(),
    lastIngressAt: Date.now(),
    daemonVersion: "1.0.40",
    capabilities: new Set<string>(),
    runtimes: ["claude"],
    runtimeVersions: {},
    migrationTransport: null,
    shutdownIntent: null,
    computerVersion: "1.0.40",
    daemonInstanceId: null,
  });
}

async function revokedReason(credentialId: string): Promise<string | null> {
  const [row] = await getDb().select({ reason: agentCredentials.revokedReason }).from(agentCredentials).where(eq(agentCredentials.id, credentialId));
  return row!.reason;
}

async function resetAudits(agentId: string) {
  return getDb().select().from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.eventType, "agent_credential.revoked"),
    eq(integrationAuditEvents.subjectId, agentId),
  ));
}

for (const mode of ["restart", "session", "full"] as const) {
  test(`a person's ${mode} reset revokes the agent's runner keys once the stopped launch exits; its other keys, other agents' and the new launch's key stay`, async ({ db: _db }) => {
    const { owner, server, machine, agent, other } = await seed();
    const lostDelete = await insertKey(agent.id, { machineId: machine.id });
    const human = await insertKey(agent.id, { issuedVia: "human", createdByUserId: owner.id, name: "laptop" });
    const app = await insertKey(agent.id, { issuedVia: "app", name: "app-bot" });
    const othersRunner = await insertKey(other.id, { machineId: machine.id });
    const orchestrator = new DaemonStandInOrchestrator();
    try {
      bindMachine(orchestrator, machine.id, server.id);
      await orchestrator.startAgent(agent.id);
      const [running] = orchestrator.mintedOnStart;
      await orchestrator.resetAgent(agent.id, mode, PERSONS_RESET(owner.id));
      await orchestrator.settled();

      assert.equal(orchestrator.sent.filter((m) => m.type === "agent:stop").length, 1, "stopped");
      assert.equal(orchestrator.mintedOnStart.length, 2, "and restarted: the daemon minted the new launch's key");
      const newKey = orchestrator.mintedOnStart[1]!;
      assert.equal(await revokedReason(running!), AGENT_RESET_REVOKE_REASON);
      assert.equal(await revokedReason(lostDelete), AGENT_RESET_REVOKE_REASON);
      assert.equal(await revokedReason(newKey), null, "the key minted after the reset began stays");
      assert.equal(await revokedReason(human), null);
      assert.equal(await revokedReason(app), null);
      assert.equal(await revokedReason(othersRunner), null);

      const audits = await resetAudits(agent.id);
      assert.deepEqual(audits.map((event) => event.targetId).sort(), [running!, lostDelete].sort(), "one audit event per revoked key");
      for (const event of audits) {
        assert.equal(event.actorType, "human");
        assert.equal(event.actorId, owner.id);
        assert.equal((event.metadata as Record<string, unknown>).via, "reset");
      }
    } finally {
      await orchestrator.close();
    }
  });
}

test("the start goes out without waiting for the exit; the exit report, after the new key's mint, revokes the old key only", async ({ db: _db }) => {
  const { owner, server, machine, agent } = await seed();
  const orchestrator = new DaemonStandInOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id);
    await orchestrator.startAgent(agent.id);
    const firstLaunch = orchestrator.sent.find((m) => m.type === "agent:start")!;
    const [old] = orchestrator.mintedOnStart;
    await orchestrator.resetAgent(agent.id, "restart", PERSONS_RESET(owner.id));
    assert.deepEqual(orchestrator.order, ["start", "stop", "start"], "the reset returned with its start sent and no exit reported yet");
    assert.equal(await revokedReason(old!), null, "nothing revoked before the exit");

    await orchestrator.settled();
    assert.ok(firstLaunch.type === "agent:start" && firstLaunch.launchId);
    assert.deepEqual(orchestrator.order, ["start", "stop", "start", `exit:${firstLaunch.launchId}`], "the stopped launch's exit came after the new key's mint");
    assert.equal(await revokedReason(old!), AGENT_RESET_REVOKE_REASON);
    assert.equal(await revokedReason(orchestrator.mintedOnStart[1]!), null, "minted before the exit report, after the reset began: stays");
    assert.deepEqual(orchestrator.resetCredentialEvents(), [{ agent_id: agent.id, outcome: "ok", revoked_count: 1, stopped: "exit_seen" }]);
  } finally {
    await orchestrator.close();
  }
});

test("with the agent's Computer offline the stop is not delivered (a process there may still run), and the reset revokes nothing", async ({ db: _db }) => {
  const { owner, machine, agent } = await seed();
  const runner = await insertKey(agent.id, { machineId: machine.id });
  const orchestrator = new DaemonStandInOrchestrator();
  try {
    await orchestrator.resetAgent(agent.id, "restart", PERSONS_RESET(owner.id));
    await orchestrator.settled();
    assert.equal(orchestrator.sent.length, 0, "nothing reached the Computer");
    assert.equal(await revokedReason(runner), null);
    assert.deepEqual(await resetAudits(agent.id), []);
    assert.deepEqual(orchestrator.resetCredentialEvents(), [{ agent_id: agent.id, outcome: "skipped_stop_unconfirmed", reason: "computer_offline" }]);
  } finally {
    await orchestrator.close();
  }
});

test("when the daemon does not report the stopped launch's exit in time, the reset revokes nothing, and it restarted at once", async ({ db: _db }) => {
  const { owner, server, machine, agent } = await seed();
  const orchestrator = new DaemonStandInOrchestrator(50);
  orchestrator.reportsExitOnStop = false;
  try {
    bindMachine(orchestrator, machine.id, server.id);
    await orchestrator.startAgent(agent.id);
    const [old] = orchestrator.mintedOnStart;
    await orchestrator.resetAgent(agent.id, "restart", PERSONS_RESET(owner.id));
    assert.deepEqual(orchestrator.order, ["start", "stop", "start"]);
    await orchestrator.settled();
    assert.equal(await revokedReason(old!), null);
    assert.deepEqual(await resetAudits(agent.id), []);
    assert.deepEqual(orchestrator.resetCredentialEvents(), [{ agent_id: agent.id, outcome: "skipped_stop_unconfirmed", reason: "exit_not_seen", timeout_ms: 50 }]);
  } finally {
    await orchestrator.close();
  }
});

test("with the agent's Computer connected and no process of the agent on it, the reset revokes right after the stop, without waiting for an exit", async ({ db: _db }) => {
  const { owner, server, machine, agent } = await seed();
  const runner = await insertKey(agent.id, { machineId: machine.id });
  // A reset that waited for an exit would take this long.
  const orchestrator = new DaemonStandInOrchestrator(15_000);
  try {
    bindMachine(orchestrator, machine.id, server.id);
    // The daemon said the agent's process is gone.
    await orchestrator.reportInactive(machine.id, agent.id);
    const startedAt = Date.now();
    await orchestrator.resetAgent(agent.id, "restart", PERSONS_RESET(owner.id));
    assert.equal(await revokedReason(runner), AGENT_RESET_REVOKE_REASON, "revoked by the time the reset returned");
    assert.ok(Date.now() - startedAt < 5_000, `no wait for an exit (took ${Date.now() - startedAt} ms)`);
    assert.equal(await revokedReason(orchestrator.mintedOnStart[0]!), null);
    assert.deepEqual(orchestrator.resetCredentialEvents(), [{ agent_id: agent.id, outcome: "ok", revoked_count: 1, stopped: "no_process" }]);
  } finally {
    await orchestrator.close();
  }
});

test("an exit report of an earlier launch (late, after its reset gave up, or during the next reset) revokes nothing and leaves no waiter", async ({ db: _db }) => {
  const { owner, server, machine, agent } = await seed();
  const orchestrator = new DaemonStandInOrchestrator(50);
  orchestrator.reportsExitOnStop = false;
  try {
    bindMachine(orchestrator, machine.id, server.id);
    await orchestrator.startAgent(agent.id);
    const firstStart = orchestrator.sent.find((m) => m.type === "agent:start");
    assert.ok(firstStart?.type === "agent:start" && firstStart.launchId, "the start names its launch");
    await orchestrator.resetAgent(agent.id, "restart", PERSONS_RESET(owner.id));
    await orchestrator.settled();
    assert.equal(orchestrator.exitWaiterCount(), 0, "the reset that gave up left no waiter");

    // The launch the first reset stopped reports its exit only now: harmless.
    await orchestrator.reportExit(machine.id, agent.id, firstStart.launchId);
    assert.equal(orchestrator.exitWaiterCount(), 0);

    // The next reset stops the first reset's launch; a late report of the
    // earlier launch while it watches is not that launch's exit.
    orchestrator.staleExitOnStop = firstStart.launchId;
    await orchestrator.resetAgent(agent.id, "restart", PERSONS_RESET(owner.id));
    await orchestrator.settled();
    assert.equal(orchestrator.exitWaiterCount(), 0);
    for (const key of orchestrator.mintedOnStart) assert.equal(await revokedReason(key), null);
    assert.deepEqual(orchestrator.resetCredentialEvents(), [
      { agent_id: agent.id, outcome: "skipped_stop_unconfirmed", reason: "exit_not_seen", timeout_ms: 50 },
      { agent_id: agent.id, outcome: "skipped_stop_unconfirmed", reason: "exit_not_seen", timeout_ms: 50 },
    ]);
  } finally {
    await orchestrator.close();
  }
});

test("an automatic reset (no person: a settings or MCP change) revokes nothing", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const runner = await insertKey(agent.id, { machineId: machine.id });
  const orchestrator = new DaemonStandInOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id);
    await orchestrator.resetAgent(agent.id, "restart", { restartIfStopped: false });
    await orchestrator.settled();
    assert.equal(orchestrator.mintedOnStart.length, 1);
    assert.equal(await revokedReason(runner), null);
    assert.deepEqual(orchestrator.resetCredentialEvents(), []);
  } finally {
    await orchestrator.close();
  }
});
