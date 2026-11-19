/**
 * The owner opener ledger and the #all greeting are synthetic seq-0 messages.
 * A legacy Cursor / Antigravity / Gemini / Copilot driver exits after every
 * turn, and its daemon restarted the agent for such a message at every exit,
 * for hours. For those runtimes the server now sends them `transient` (never a
 * pending message, so never a restart wake) once the agent's process has
 * exited idle, held until then; every other runtime is unchanged.
 * Real DB rows and the real ingest/route/deliver paths; only the machine
 * socket is stubbed.
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";

import {
  DAEMON_CAPABILITY_RUNTIME_HOST_OAR,
  DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CURSOR,
  type AgentMessage,
  type MachineToServerMessage,
  type ServerToMachineMessage,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agents, machines, onboardingHeldWakes, serverMembers, servers, users } from "../db/schema";
import { AgentOrchestrator } from "./agentOrchestrator";
import * as channelService from "./channelService";
import { AGENT_RUNTIME_OAR_FEATURE_FLAG_KEYS, createFeatureFlag } from "./featureFlagService";
import {
  deliverOnboardingWake,
  expireHeldOnboardingWakes,
  ONBOARDING_HELD_WAKE_MAX_HOLD_MS,
  onboardingHeldWakeStore,
  releaseHeldOnboardingWakes,
  startOnboardingHeldWakeRelease,
} from "./onboardingHeldWakes";

afterEach(async () => {
  await closeTestDatabase();
});

function fakeIo(): SocketServer {
  const operator = { in: () => operator, to: () => operator, except: () => operator, socketsJoin: () => undefined, emit: () => true };
  return { in: () => operator, to: () => operator } as unknown as SocketServer;
}

class CapturingOrchestrator extends AgentOrchestrator {
  readonly frames: ServerToMachineMessage[] = [];

  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    this.frames.push(msg);
    return true;
  }

  /** The frames that carry this message to the agent: a direct delivery or a start that wakes with it. */
  framesFor(messageId: string): Array<{ type: string; transient: boolean }> {
    return this.frames.flatMap((frame): Array<{ type: string; transient: boolean }> => {
      if (frame.type === "agent:deliver" && frame.message.message_id === messageId) {
        return [{ type: frame.type, transient: (frame as { transient?: boolean }).transient === true }];
      }
      if (frame.type === "agent:start" && frame.wakeMessage?.message_id === messageId) {
        return [{ type: frame.type, transient: frame.wakeMessageTransient === true }];
      }
      return [];
    });
  }
}

async function seed(slug: string, runtime: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${slug}@example.com`,
    name: `Owner ${slug}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: "New", slug, ownerId: owner!.id }).returning();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
  const [machine] = await db.insert(machines).values({
    serverId: server!.id,
    userId: owner!.id,
    name: "laptop",
    apiKeyHash: `hash-${slug}`,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "cindy",
    status: "active",
    runtime,
    model: "default",
    executionMode: "byoc",
    machineId: machine!.id,
  }).returning();
  // The owner's onboarding channel, which the agent is in, as in production.
  const channel = await channelService.createChannel(server!.id, "onboarding-owner", undefined, "channel", { initialUserIds: [owner!.id], initialAgentIds: [agent!.id] });
  return { owner: owner!, server: server!, machine: machine!, agent: agent!, channelId: channel.id as string };
}

function bindMachine(orchestrator: AgentOrchestrator, machineId: string, serverId: string, capabilities: string[] = []): void {
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
    daemonVersion: "1.0.70",
    capabilities: new Set<string>(capabilities),
    runtimes: ["cursor", "antigravity", "gemini", "copilot", "claude", "codex"],
    migrationTransport: null,
    shutdownIntent: null,
    computerVersion: "1.25.0",
  });
}

let clientSeq = 0;

/** What the legacy daemon sends: "Working" during a turn, "Idle" at its end, "Process idle" once the per-turn process exited. */
function activity(agentId: string, activityKind: "working" | "online", detail: string, detailKind: "working" | "idle"): MachineToServerMessage {
  clientSeq += 1;
  return {
    type: "agent:activity",
    agentId,
    activity: activityKind,
    detail,
    detailKind,
    entries: [],
    clientSeq,
    observedAtMs: Date.now(),
    isHeartbeat: false,
  } as unknown as MachineToServerMessage;
}

function ledger(serverId: string, channelId: string): AgentMessage {
  return {
    channel_id: channelId,
    channel_name: "onboarding-owner",
    channel_type: "channel",
    sender_id: "system",
    sender_name: "system",
    sender_type: "system",
    content: "Onboarding task (system-triggered): brief",
    timestamp: new Date().toISOString(),
    seq: 0,
    message_id: `opener-v2-ledger-${serverId}`,
  };
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function heldRows(agentId: string) {
  return getDb().select().from(onboardingHeldWakes).where(eq(onboardingHeldWakes.agentId, agentId));
}

for (const runtime of ["cursor", "antigravity", "gemini", "copilot"] as const) {
  test(`${runtime} (legacy per-turn driver): a busy agent's onboarding wake waits, then goes transient exactly once at "Process idle"`, async ({ db: _db }) => {
    const { server, machine, agent, channelId } = await seed(`held-${runtime}`, runtime);
    const orchestrator = new CapturingOrchestrator();
    orchestrator.setIO(fakeIo());
    startOnboardingHeldWakeRelease({ orchestrator });
    try {
      bindMachine(orchestrator, machine.id, server.id);
      // Its first turn is running (a fresh agent, just started).
      await orchestrator.handleMachineMessage(machine.id, activity(agent.id, "working", "Working", "working"));
      const message = ledger(server.id, channelId);

      const route = await orchestrator.onboardingWakeRoute(agent.id);
      assert.equal(route, "hold");
      assert.deepEqual(await deliverOnboardingWake(orchestrator, { agentId: agent.id, kind: "owner_opener_ledger", message, route }), { kind: "held" });
      assert.deepEqual(orchestrator.framesFor(message.message_id!), [], "nothing reaches the daemon while the agent is busy");
      assert.equal((await heldRows(agent.id)).length, 1);

      // The turn ends ("Idle" comes while the process is still exiting): still held.
      await orchestrator.handleMachineMessage(machine.id, activity(agent.id, "online", "Idle", "idle"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(orchestrator.framesFor(message.message_id!), [], "a transient delivery now would be dropped as busy");

      // The process exited idle: the wake goes now, transient, so it never becomes a pending (restart) message.
      await orchestrator.handleMachineMessage(machine.id, activity(agent.id, "online", "Process idle", "idle"));
      await until(() => orchestrator.framesFor(message.message_id!).length > 0, "the held wake");
      assert.deepEqual(orchestrator.framesFor(message.message_id!).map((frame) => frame.transient), [true]);
      assert.equal((await heldRows(agent.id)).length, 0, "taken by the delivery");

      // Later idles (every turn of a per-turn runtime) send nothing again.
      await orchestrator.handleMachineMessage(machine.id, activity(agent.id, "working", "Working", "working"));
      await orchestrator.handleMachineMessage(machine.id, activity(agent.id, "online", "Process idle", "idle"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(orchestrator.framesFor(message.message_id!).length, 1, "delivered once");
    } finally {
      await orchestrator.shutdown();
    }
  });
}

test("cursor (legacy driver) already idle: the wake goes transient at once, without a hold", async ({ db: _db }) => {
  const { server, machine, agent, channelId } = await seed("held-idle-now", "cursor");
  const orchestrator = new CapturingOrchestrator();
  orchestrator.setIO(fakeIo());
  try {
    bindMachine(orchestrator, machine.id, server.id);
    await orchestrator.handleMachineMessage(machine.id, activity(agent.id, "online", "Process idle", "idle"));
    const message = ledger(server.id, channelId);
    const route = await orchestrator.onboardingWakeRoute(agent.id);
    assert.equal(route, "transient_now");
    const outcome = await deliverOnboardingWake(orchestrator, { agentId: agent.id, kind: "owner_opener_ledger", message, route });
    assert.deepEqual(outcome, { kind: "delivered", result: { status: "queued", reason: "direct_dispatch" } });
    assert.deepEqual(orchestrator.framesFor(message.message_id!).map((frame) => frame.transient), [true]);
    assert.equal((await heldRows(agent.id)).length, 0);
  } finally {
    await orchestrator.shutdown();
  }
});

/** The owner briefing as the opener trigger stamps it when its ledger is held. */
async function stampOpenerSent(serverId: string, ownerId: string, agentId: string) {
  const sentAt = new Date();
  await getDb().update(serverMembers).set({
    onboardingDmSentAt: sentAt,
    onboardingDmSentByAgentId: agentId,
    onboardingOwnerOpenerV2SentAt: sentAt,
    onboardingOwnerOpenerV2SentByAgentId: agentId,
  }).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, ownerId)));
}

async function openerSentAt(serverId: string, ownerId: string) {
  const [row] = await getDb().select({ dm: serverMembers.onboardingDmSentAt, opener: serverMembers.onboardingOwnerOpenerV2SentAt })
    .from(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, ownerId)));
  return row;
}

const longAgo = () => new Date(Date.now() - ONBOARDING_HELD_WAKE_MAX_HOLD_MS - 60_000);

test("a ledger held past the bound is not sent at a later idle, and the briefing goes back to unsent so the next activation retries", async ({ db: _db }) => {
  const { owner, server, agent, channelId } = await seed("held-expired", "cursor");
  await stampOpenerSent(server.id, owner.id, agent.id);
  await onboardingHeldWakeStore.hold(agent.id, "owner_opener_ledger", ledger(server.id, channelId), longAgo());
  const sent: AgentMessage[] = [];
  await releaseHeldOnboardingWakes({ deliverMessage: async (_agentId, wake) => { sent.push(wake); return { status: "queued", reason: "direct_dispatch" }; } }, agent.id);
  assert.deepEqual(sent, []);
  assert.equal((await heldRows(agent.id)).length, 0, "an expired hold is dropped, not kept");
  assert.deepEqual(await openerSentAt(server.id, owner.id), { dm: null, opener: null });
});

test("the periodic sweep expires a hold whose agent never goes idle (a failed start): unsent again, without any release", async ({ db: _db }) => {
  const { owner, server, agent, channelId } = await seed("held-sweep", "cursor");
  const fresh = await seed("held-sweep-fresh", "gemini");
  await stampOpenerSent(server.id, owner.id, agent.id);
  await onboardingHeldWakeStore.hold(agent.id, "owner_opener_ledger", ledger(server.id, channelId), longAgo());
  await onboardingHeldWakeStore.hold(fresh.agent.id, "owner_opener_ledger", ledger(fresh.server.id, fresh.channelId), new Date());

  const orchestrator = new CapturingOrchestrator();
  orchestrator.setIO(fakeIo());
  startOnboardingHeldWakeRelease({ orchestrator });
  try {
    orchestrator.emit("onboarding:held-wakes:sweep");
    await until(async () => (await heldRows(agent.id)).length === 0, "the expiry");
    await until(async () => (await openerSentAt(server.id, owner.id))?.opener === null, "the unstamp");
    assert.deepEqual(await openerSentAt(server.id, owner.id), { dm: null, opener: null });
    assert.equal((await heldRows(fresh.agent.id)).length, 1, "a hold within the bound stays");
    assert.equal(orchestrator.frames.length, 0, "an expired wake is never sent");
  } finally {
    await orchestrator.shutdown();
  }
});

test("a held ledger the Server drops on release is unsent again; an expired #all greeting keeps its claim (nothing retries a greeting)", async ({ db: _db }) => {
  const { owner, server, agent, channelId } = await seed("held-dropped", "copilot");
  await stampOpenerSent(server.id, owner.id, agent.id);
  await onboardingHeldWakeStore.hold(agent.id, "owner_opener_ledger", ledger(server.id, channelId), new Date());
  await releaseHeldOnboardingWakes({ deliverMessage: async () => ({ status: "dropped", reason: "agent_state_changed" }) }, agent.id);
  assert.deepEqual(await openerSentAt(server.id, owner.id), { dm: null, opener: null });

  const claimedAt = new Date();
  await getDb().update(agents).set({ allChannelIntroSentAt: claimedAt }).where(eq(agents.id, agent.id));
  await onboardingHeldWakeStore.hold(agent.id, "all_channel_greeting", { ...ledger(server.id, channelId), message_id: `all-greeting-${server.id}-${agent.id}` }, longAgo());
  await expireHeldOnboardingWakes();
  const [row] = await getDb().select({ claim: agents.allChannelIntroSentAt }).from(agents).where(eq(agents.id, agent.id));
  assert.equal(row?.claim?.getTime(), claimedAt.getTime());
  assert.equal((await heldRows(agent.id)).length, 0);
});

test("a legacy cursor agent that is not running yet (inactive) gets the wake now, transient, as the input of the start it causes", async ({ db: _db }) => {
  const { server, machine, agent, channelId } = await seed("never-ran", "cursor");
  await getDb().update(agents).set({ status: "inactive" }).where(eq(agents.id, agent.id));
  const orchestrator = new CapturingOrchestrator();
  orchestrator.setIO(fakeIo());
  try {
    bindMachine(orchestrator, machine.id, server.id);
    const route = await orchestrator.onboardingWakeRoute(agent.id);
    assert.equal(route, "transient_now");
    const message = ledger(server.id, channelId);
    await deliverOnboardingWake(orchestrator, { agentId: agent.id, kind: "owner_opener_ledger", message, route });
    assert.deepEqual(orchestrator.framesFor(message.message_id!), [{ type: "agent:start", transient: true }]);
  } finally {
    await orchestrator.shutdown();
  }
});

test("a just-created active cursor agent whose start has not reported yet is held, not sent into the start", async ({ db: _db }) => {
  const { server, machine, agent } = await seed("start-in-flight", "cursor");
  const orchestrator = new CapturingOrchestrator();
  orchestrator.setIO(fakeIo());
  try {
    bindMachine(orchestrator, machine.id, server.id);
    // No activity yet: the daemon reports "Starting…" only once it spawns, and a
    // transient delivery during the start is dropped by the daemon.
    assert.equal(await orchestrator.onboardingWakeRoute(agent.id), "hold");
  } finally {
    await orchestrator.shutdown();
  }
});

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: the onboarding wake is delivered exactly as before (no hold, no transient)`, async ({ db: _db }) => {
    const { server, machine, agent, channelId } = await seed(`unchanged-${runtime}`, runtime);
    const orchestrator = new CapturingOrchestrator();
    orchestrator.setIO(fakeIo());
    try {
      bindMachine(orchestrator, machine.id, server.id);
      await orchestrator.handleMachineMessage(machine.id, activity(agent.id, "working", "Working", "working"));
      const route = await orchestrator.onboardingWakeRoute(agent.id);
      assert.equal(route, "unchanged");
      const calls: unknown[][] = [];
      const recorder = { deliverMessage: async (...args: unknown[]) => { calls.push(args); return { status: "queued", reason: "replayable_inbox" } as const; } };
      const message = ledger(server.id, channelId);
      await deliverOnboardingWake(recorder as any, { agentId: agent.id, kind: "owner_opener_ledger", message, route });
      assert.deepEqual(calls, [[agent.id, message]], "the same call, with no options argument");
      assert.equal((await heldRows(agent.id)).length, 0);
    } finally {
      await orchestrator.shutdown();
    }
  });
}

test("cursor on the OAR host (Linux Computer with the Cursor SDK, flag on): unchanged, its live session has no per-turn exit", async ({ db: _db }) => {
  await createFeatureFlag({ key: AGENT_RUNTIME_OAR_FEATURE_FLAG_KEYS.cursor, randomizationUnit: "server", defaultEnabled: true });
  const { server, machine, agent } = await seed("oar-cursor", "cursor");
  const orchestrator = new CapturingOrchestrator();
  orchestrator.setIO(fakeIo());
  try {
    bindMachine(orchestrator, machine.id, server.id, [DAEMON_CAPABILITY_RUNTIME_HOST_OAR, DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CURSOR]);
    assert.equal(await orchestrator.onboardingWakeRoute(agent.id), "unchanged");
    // A Mac (no Cursor SDK capability) runs the legacy driver even with the flag on.
    bindMachine(orchestrator, machine.id, server.id, [DAEMON_CAPABILITY_RUNTIME_HOST_OAR]);
    assert.equal(await orchestrator.onboardingWakeRoute(agent.id), "hold");
  } finally {
    await orchestrator.shutdown();
  }
});
