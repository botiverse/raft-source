/**
 * A codex agent on a computer without the Codex CLI used to fail its start on
 * every automatic wake, forever (1,413 failed starts a day, almost all from
 * Computers older than the typed start-failure reason; 97% woken by the
 * onboarding owner-facts context). The server now counts those legacy
 * failed-start frames, pauses automatic wakes at once when the computer's own
 * runtime list confirms the runtime is missing, tells the owner once, and lifts
 * the pause when the computer lists the runtime again.
 * Real DB rows and the real ingest/deliver/start paths; only the machine
 * socket, Socket.IO and the inbox-chain source are stubbed.
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import type { Server as SocketServer } from "socket.io";
import { and, eq } from "drizzle-orm";

import { BasicTracer, MemoryTraceSink, type MachineToServerMessage, type ServerToMachineMessage } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agents, machines, messages, serverMembers, servers, users } from "../db/schema";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { AgentOrchestrator } from "./agentOrchestrator";
import * as channelService from "./channelService";
import { LEGACY_RUNTIME_NOT_FOUND_DETAIL } from "./legacySpawnFailure";
import { deliverOwnerFactsContext } from "./onboardingService";

afterEach(async () => {
  await closeTestDatabase();
});

function fakeIo(): SocketServer {
  const operator = { in: () => operator, to: () => operator, except: () => operator, socketsJoin: () => undefined, emit: () => true };
  return { in: () => operator, to: () => operator } as unknown as SocketServer;
}

class CapturingOrchestrator extends AgentOrchestrator {
  readonly starts: Array<Extract<ServerToMachineMessage, { type: "agent:start" }>> = [];

  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "agent:start") this.starts.push(msg);
    return true;
  }

  protected override async selectResumeInbox(agentId: string): Promise<channelService.AgentInboxChainSelection> {
    return { source: "chain", rows: await referenceAgentInboxChain(agentId) } as channelService.AgentInboxChainSelection;
  }
}

async function seed() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "codex-owner@example.com",
    name: "newcomer",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: "First Server", slug: "first-server-test", ownerId: owner!.id }).returning();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
  const [machine] = await db.insert(machines).values({
    serverId: server!.id,
    userId: owner!.id,
    name: "old-laptop",
    apiKeyHash: "hash-codex",
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "guide",
    status: "inactive",
    runtime: "codex",
    model: "gpt-5.5",
    executionMode: "byoc",
    machineId: machine!.id,
    creatorType: "user",
    creatorId: owner!.id,
  }).returning();
  return { owner: owner!, server: server!, machine: machine!, agent: agent! };
}

function bindMachine(orchestrator: AgentOrchestrator, machineId: string, serverId: string, runtimes: string[] | null): void {
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
    daemonVersion: "1.0.25",
    capabilities: new Set<string>(),
    runtimes,
    migrationTransport: null,
    shutdownIntent: null,
    computerVersion: "1.0.26",
  });
}

/** What Computer 1.0.16–1.0.33 sends for a failed start: a kind, a fixed message, no reason. */
function kindedLegacyFailure(agentId: string, launchId: string): MachineToServerMessage {
  return {
    type: "agent:activity",
    agentId,
    launchId,
    detail: LEGACY_RUNTIME_NOT_FOUND_DETAIL,
    detailKind: "runtime_unavailable",
    observedAtMs: Date.now(),
    isHeartbeat: false,
  } as unknown as MachineToServerMessage;
}

/** What Computer 1.0.4–1.0.15 sends: an offline activity with the fixed message and no kind. */
function unkindedLegacyFailure(agentId: string, launchId: string): MachineToServerMessage {
  return {
    type: "agent:activity",
    agentId,
    launchId,
    activity: "offline",
    detail: LEGACY_RUNTIME_NOT_FOUND_DETAIL,
    observedAtMs: Date.now(),
  } as unknown as MachineToServerMessage;
}

/** The trace events with this name, standalone or on a span, as their attributes. */
function traceEvents(sink: MemoryTraceSink, name: string): Array<Record<string, unknown>> {
  return [
    ...sink.getAllLogEvents().filter((event) => event.name === name),
    ...sink.getAllSpans().flatMap((span) => span.events.filter((event) => event.name === name)),
  ].map((event) => event.attrs as Record<string, unknown>);
}

async function ownerNotices(dmId: string) {
  return getDb().select({ content: messages.content }).from(messages)
    .where(and(eq(messages.channelId, dmId), eq(messages.messageType, "system")));
}

test("a legacy failed start on a computer that does not list the runtime pauses automatic wakes, tells the owner once, and lifts when the runtime appears", async ({ db: _db }) => {
  const { owner, server, machine, agent } = await seed();
  const sink = new MemoryTraceSink();
  const orchestrator = new CapturingOrchestrator(undefined, undefined, new BasicTracer({ sink }));
  orchestrator.setIO(fakeIo());
  try {
    bindMachine(orchestrator, machine.id, server.id, ["claude"]);
    const breaker = (orchestrator as any).wakeCrashLoopBreaker;
    await breaker.recordStart(agent.id, "launch-1", Date.now());

    await orchestrator.handleMachineMessage(machine.id, kindedLegacyFailure(agent.id, "launch-1"));

    assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "runtime_not_found" }, "one failure is enough");
    const dm = await channelService.findOrCreateDM(server.id, owner.id, agent.id);
    assert.ok(dm);
    const notices = await ownerNotices(dm.id);
    assert.equal(notices.length, 1, "one notice to the owner");
    assert.match(notices[0]!.content, /@guide could not start: Codex CLI is not available on the computer "old-laptop"\./);
    assert.equal(/\binstall/i.test(notices[0]!.content), false, "neutral like the agent page: absence is not always proven");

    // The onboarding owner-facts context, re-sent on every wake, no longer starts it.
    assert.equal(await deliverOwnerFactsContext(orchestrator, server.id, agent.id), false);
    assert.equal(orchestrator.starts.length, 0, "no start while paused");

    // A person starts it anyway: it fails the same way and pauses again, without a second notice.
    assert.equal((await orchestrator.startAgent(agent.id)).outcome, "dispatched");
    await orchestrator.handleMachineMessage(machine.id, kindedLegacyFailure(agent.id, orchestrator.starts[0]!.launchId!));
    assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "runtime_not_found" });
    assert.equal((await ownerNotices(dm.id)).length, 1, "not told twice");
    // #proj-runtime:#32: the skipped notice is recorded, so a pause without one never reads as a missing notice.
    assert.deepEqual(
      traceEvents(sink, "wake.runtime_unavailable.owner_notice").map((attrs) => attrs.outcome),
      ["posted", "already_notified"],
    );

    // The owner installs Codex; the computer reports it: automatic wakes resume.
    await (orchestrator as any).enqueueCapabilitiesPersist(machine.id, {
      runtimes: ["claude", "codex"],
      hostname: "old-laptop",
      os: "linux",
      daemonVersion: "1.0.25",
      computerVersion: "1.0.26",
    });
    assert.equal(await breaker.automaticWakeHold(agent.id, Date.now()), null);
  } finally {
    await orchestrator.shutdown();
  }
});

test("a legacy failed start that cannot be confirmed as a missing runtime still counts, and five in a row pause (Computer < 1.0.16 frames too)", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  orchestrator.setIO(fakeIo());
  try {
    // No runtime list from this computer: absence cannot be confirmed.
    bindMachine(orchestrator, machine.id, server.id, null);
    const breaker = (orchestrator as any).wakeCrashLoopBreaker;
    for (let i = 1; i <= 5; i += 1) {
      assert.equal(await breaker.automaticWakeHold(agent.id, Date.now()), null, `still waking before failure ${i}`);
      await breaker.recordStart(agent.id, `launch-${i}`, Date.now());
      await orchestrator.handleMachineMessage(machine.id, unkindedLegacyFailure(agent.id, `launch-${i}`));
    }
    assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "runtime_spawn_failed" });
    // No missing-runtime claim was made, so the computer listing runtimes does not lift this block.
    await (orchestrator as any).enqueueCapabilitiesPersist(machine.id, {
      runtimes: ["codex"],
      hostname: "old-laptop",
      os: "linux",
      daemonVersion: "1.0.7",
      computerVersion: "1.0.7",
    });
    assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "runtime_spawn_failed" });
  } finally {
    await orchestrator.shutdown();
  }
});

test("the old not-found text with the runtime listed is some other failure: it counts but does not pause at once", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  orchestrator.setIO(fakeIo());
  try {
    bindMachine(orchestrator, machine.id, server.id, ["codex"]);
    const breaker = (orchestrator as any).wakeCrashLoopBreaker;
    await breaker.recordStart(agent.id, "launch-1", Date.now());
    await orchestrator.handleMachineMessage(machine.id, kindedLegacyFailure(agent.id, "launch-1"));
    assert.equal(await breaker.automaticWakeHold(agent.id, Date.now()), null);
  } finally {
    await orchestrator.shutdown();
  }
});
