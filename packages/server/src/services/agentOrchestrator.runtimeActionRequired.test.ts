/**
 * A runtime error only the owner can fix (rejected model credential) stops
 * automatic wakes at once and tells the owner once, in their DM with the
 * agent. Before this, every reminder or message woke the agent into the same
 * failure and the owner never heard (WangHuning, humanverse, 2026-10-13).
 * Real DB rows and the real ingest/deliver/start paths; only the machine
 * socket, Socket.IO and the inbox-chain source are stubbed.
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import type { Server as SocketServer } from "socket.io";
import { and, eq } from "drizzle-orm";

import type { MachineToServerMessage, ServerToMachineMessage } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agents, machines, messages, serverMembers, servers, users } from "../db/schema";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { AgentOrchestrator } from "./agentOrchestrator";
import * as channelService from "./channelService";
import { createMessage, deliverMessageToAgent } from "./messageService";
import { runtimeAuthService } from "./runtimeAuthService";

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
    email: "auth-owner@example.com",
    name: "wanghuning",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: "Humanverse", slug: "humanverse-test", ownerId: owner!.id }).returning();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
  const [machine] = await db.insert(machines).values({
    serverId: server!.id,
    userId: owner!.id,
    name: "auth-box",
    apiKeyHash: "hash-auth",
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "deepseeker",
    // The daemon stops the runtime on an error that needs the owner; the
    // agent is not running when the next message or reminder arrives.
    status: "inactive",
    runtime: "kimi-sdk",
    model: "devin/swe-2",
    executionMode: "byoc",
    machineId: machine!.id,
    creatorType: "user",
    creatorId: owner!.id,
  }).returning();
  return { owner: owner!, server: server!, machine: machine!, agent: agent! };
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
    daemonVersion: "1.0.48",
    capabilities: new Set<string>(),
    runtimes: ["kimi-sdk"],
    migrationTransport: null,
    shutdownIntent: null,
    computerVersion: "1.0.48",
  });
}

const AUTH_DETAIL = "Built-in provider authentication failed. Check this agent's provider API key and region/provider selection, then retry starting this agent.";

// `null`: an older daemon's frame, without the field (an explicit `undefined`
// would take the default).
function authErrorActivity(agentId: string, launchId: string, requiredAction: "user_reauth" | null = "user_reauth"): MachineToServerMessage {
  return {
    type: "agent:activity",
    agentId,
    launchId,
    activity: "error",
    detail: AUTH_DETAIL,
    detailKind: "runtime_error",
    isHeartbeat: false,
    runtimeError: {
      errorClass: "AuthError",
      errorReason: "auth_failed",
      fingerprint: "0123456789abcdef",
      reasonProvenance: "runtime_error_event",
      ...(requiredAction ? { requiredAction } : {}),
    },
  } as unknown as MachineToServerMessage;
}

/** The stored error's message, class and reason, and requiredAction only when present. */
async function storedRuntimeError(agentId: string) {
  const [row] = await getDb().select({ lastRuntimeError: agents.lastRuntimeError }).from(agents).where(eq(agents.id, agentId));
  const error = row?.lastRuntimeError;
  if (!error) return null;
  return {
    message: error.message,
    errorClass: error.errorClass,
    errorReason: error.errorReason,
    ...("requiredAction" in error ? { requiredAction: error.requiredAction } : {}),
  };
}

async function ownerNotices(dmId: string) {
  return getDb().select({ content: messages.content }).from(messages)
    .where(and(eq(messages.channelId, dmId), eq(messages.messageType, "system")));
}

test("an AuthError from the current start pauses automatic wakes and tells the owner once", async ({ db: _db }) => {
  const { owner, server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  orchestrator.setIO(fakeIo());
  try {
    bindMachine(orchestrator, machine.id, server.id);
    const breaker = (orchestrator as any).wakeCrashLoopBreaker;
    await breaker.recordStart(agent.id, "launch-1", Date.now());

    await orchestrator.handleMachineMessage(machine.id, authErrorActivity(agent.id, "launch-1"));

    assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "user_reauth" });
    // #proj-raft-computer:#48: the stored error keeps what the owner must do, for the web.
    assert.deepEqual(await storedRuntimeError(agent.id), {
      message: AUTH_DETAIL, errorClass: "AuthError", errorReason: "auth_failed", requiredAction: "user_reauth",
    });
    const dm = await channelService.findOrCreateDM(server.id, owner.id, agent.id);
    assert.ok(dm);
    const notices = await ownerNotices(dm.id);
    assert.equal(notices.length, 1, "one notice to the owner");
    assert.match(notices[0]!.content, /@deepseeker stopped because its model credential was rejected\./);
    assert.equal(notices[0]!.content.includes(AUTH_DETAIL), false, "the runtime's error text is not copied into the DM");
    assert.ok(notices[0]!.content.includes(`/s/humanverse-test/agent/${agent.id}`), notices[0]!.content);

    // A reminder or message while paused does not start a process bound to fail.
    const message = await createMessage(dm.id, "user", owner.id, "ping");
    assert.deepEqual(await deliverMessageToAgent(orchestrator, message.id, agent.id), { status: "dropped", reason: "wake_suppressed" });
    assert.equal(orchestrator.starts.length, 0);

    // The owner starts it without fixing anything: it runs, fails the same way, pauses again, and is not told twice.
    const started = await orchestrator.startAgent(agent.id);
    assert.equal(started.outcome, "dispatched");
    const launchId = orchestrator.starts[0]!.launchId!;
    const carried = [
      ...(orchestrator.starts[0]!.wakeMessage ? [orchestrator.starts[0]!.wakeMessage] : []),
      ...(orchestrator.starts[0]!.resumeMessages ?? []),
    ];
    assert.ok(carried.some((m) => m.message_id === message.id), "the manual start carries the message that waited");
    assert.equal(
      carried.some((m) => String(m.content ?? "").includes("stopped because")),
      false,
      `the owner's notice is not carried to the agent; carried ${JSON.stringify(carried.map((m) => m.content))}`,
    );
    await orchestrator.handleMachineMessage(machine.id, authErrorActivity(agent.id, launchId));
    assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "user_reauth" });
    assert.equal((await ownerNotices(dm.id)).length, 1, "the same error is not reported again");
  } finally {
    await orchestrator.shutdown();
  }
});

test("an older daemon's AuthError (no requiredAction) still pauses; an error from an old launch does not", async ({ db: _db }) => {
  const { owner, server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  orchestrator.setIO(fakeIo());
  try {
    bindMachine(orchestrator, machine.id, server.id);
    const breaker = (orchestrator as any).wakeCrashLoopBreaker;
    await breaker.recordStart(agent.id, "launch-2", Date.now());

    await orchestrator.handleMachineMessage(machine.id, authErrorActivity(agent.id, "launch-1", null));
    assert.equal(await breaker.automaticWakeHold(agent.id, Date.now()), null, "a late error from an earlier launch is ignored");

    await orchestrator.handleMachineMessage(machine.id, authErrorActivity(agent.id, "launch-2", null));
    assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "user_reauth" });
    // Nothing invented: the web falls back to the AuthError class.
    assert.deepEqual(await storedRuntimeError(agent.id), { message: AUTH_DETAIL, errorClass: "AuthError", errorReason: "auth_failed" });
    const dm = await channelService.findOrCreateDM(server.id, owner.id, agent.id);
    assert.equal((await ownerNotices(dm!.id)).length, 1);
  } finally {
    await orchestrator.shutdown();
  }
});

test("#proj-raft-computer:#48: a plan without the model is stored with requiredAction user_model_access", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  orchestrator.setIO(fakeIo());
  try {
    bindMachine(orchestrator, machine.id, server.id);
    const breaker = (orchestrator as any).wakeCrashLoopBreaker;
    await breaker.recordStart(agent.id, "launch-1", Date.now());
    const detail = "Kimi reported that the provider plan for this agent does not include access to the configured model (devin/swe-2).";
    await orchestrator.handleMachineMessage(machine.id, {
      type: "agent:activity",
      agentId: agent.id,
      launchId: "launch-1",
      activity: "error",
      detail,
      detailKind: "runtime_error",
      isHeartbeat: false,
      runtimeError: {
        errorClass: "ModelConfigError",
        errorReason: "model_config_error",
        fingerprint: "fedcba9876543210",
        reasonProvenance: "runtime_error_event",
        requiredAction: "user_model_access",
      },
    } as unknown as MachineToServerMessage);
    assert.deepEqual(await storedRuntimeError(agent.id), {
      message: detail, errorClass: "ModelConfigError", errorReason: "model_config_error", requiredAction: "user_model_access",
    });
  } finally {
    await orchestrator.shutdown();
  }
});

test("an agent stuck on a tool call posts nothing to its owner (task #25: the owner DM was removed)", async ({ db: _db }) => {
  const { owner, server, machine, agent } = await seed();
  await getDb().update(agents).set({ status: "active" }).where(eq(agents.id, agent.id));
  const orchestrator = new CapturingOrchestrator();
  orchestrator.setIO(fakeIo());
  try {
    bindMachine(orchestrator, machine.id, server.id);
    // A running agent, as the orchestrator holds it once its process started.
    (orchestrator as any).agentStateCache.set(agent.id, {
      id: agent.id, status: "active", machineId: machine.id, sessionId: null, expectedLaunchId: null, launchGuardMode: "legacy",
      serverId: server.id, name: agent.name, displayName: null, description: null, model: agent.model, runtime: agent.runtime,
      lastRuntimeError: null, runtimeState: "running_idle", reasoningEffort: null, envVars: null,
    });
    const events: string[] = [];
    const recordEvent = (orchestrator as any).recordEvent.bind(orchestrator);
    (orchestrator as any).recordEvent = (name: string, attrs?: unknown) => {
      events.push(name);
      return recordEvent(name, attrs);
    };
    const toolStuck = { toolName: "bash", toolDetailKind: "running_command", startedAtMs: 1_000, quietSinceMs: 1_000, thresholdMs: 600_000, queuedMessages: 2 };
    const detail = "Stuck: running command, no output for 10+ min";
    await orchestrator.handleMachineMessage(machine.id, {
      type: "agent:activity",
      agentId: agent.id,
      launchId: "launch-1",
      activity: "working",
      detail,
      detailKind: "running_command",
      entries: [{ kind: "status", activity: "working", activityKind: "working", detail, detailKind: "running_command" }],
      clientSeq: 1,
      isHeartbeat: false,
      toolStuck,
    } as unknown as MachineToServerMessage);

    assert.ok(events.includes("activity.ingest.accepted"), `the stuck frame is accepted; events ${events.join(", ")}`);
    const systemMessages = await getDb().select({ id: messages.id }).from(messages).where(eq(messages.messageType, "system"));
    assert.deepEqual(systemMessages, [], "no DM or other system message about the stuck tool call");
    const dm = await channelService.findOrCreateDM(server.id, owner.id, agent.id);
    assert.equal((await ownerNotices(dm!.id)).length, 0);
  } finally {
    await orchestrator.shutdown();
  }
});

// #proj-raft-computer:#48 (reconciler step 4b): the daemon now keeps an agent
// whose credential was rejected and releases it itself (model output on the
// credential, a person stopping an agent on it, a model change, a login). It
// says so with `agent:credential:restored`, and the server lifts the wake
// block it set for that same reason only. Without the frame (an older daemon,
// or one that restarted and lost its record) a login or a person's start
// lifts it, as before. Every lift says where it came from.
function restoredFrame(agentId: string, reason: string, releaseCause = "model_output"): MachineToServerMessage {
  return { type: "agent:credential:restored", agentId, reason, releaseCause, launchId: "launch-1" } as unknown as MachineToServerMessage;
}

function captureEvents(orchestrator: AgentOrchestrator): Array<{ name: string; attrs: Record<string, unknown> }> {
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const recordEvent = (orchestrator as any).recordEvent.bind(orchestrator);
  (orchestrator as any).recordEvent = (name: string, attrs?: Record<string, unknown>) => {
    events.push({ name, attrs: attrs ?? {} });
    return recordEvent(name, attrs);
  };
  return events;
}

const lifts = (events: Array<{ name: string; attrs: Record<string, unknown> }>) => events
  .filter((event) => event.name === "wake.block_lifted").map((event) => event.attrs);

test("step 4b: the daemon's credential-restored frame lifts only a block of its reason, and the trace says daemon_frame", async ({ db: _db }) => {
  const { owner, server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  orchestrator.setIO(fakeIo());
  try {
    bindMachine(orchestrator, machine.id, server.id);
    const events = captureEvents(orchestrator);
    const breaker = (orchestrator as any).wakeCrashLoopBreaker;
    await breaker.recordStart(agent.id, "launch-1", Date.now());
    await orchestrator.handleMachineMessage(machine.id, authErrorActivity(agent.id, "launch-1"));
    assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "user_reauth" });

    // Another reason restored (a billing balance, a model's plan access), or one this server does not know: the sign-in block stays.
    for (const reason of ["billing", "user_model_access", "quota"]) {
      await orchestrator.handleMachineMessage(machine.id, restoredFrame(agent.id, reason));
      assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "user_reauth" }, reason);
    }
    assert.deepEqual(lifts(events), []);

    await orchestrator.handleMachineMessage(machine.id, restoredFrame(agent.id, "user_reauth"));
    assert.equal(await breaker.automaticWakeHold(agent.id, Date.now()), null);
    assert.deepEqual(lifts(events), [{
      cause: "credential_restored", source: "daemon_frame", release_cause: "model_output", lifted_reason: "user_reauth", launch_id_present: true,
    }]);

    // The next message wakes the agent as usual.
    const dm = await channelService.findOrCreateDM(server.id, owner.id, agent.id);
    const message = await createMessage(dm!.id, "user", owner.id, "back?");
    await deliverMessageToAgent(orchestrator, message.id, agent.id);
    assert.equal(orchestrator.starts.length, 1, "an automatic wake starts the agent again");
  } finally {
    await orchestrator.shutdown();
  }
});

test("step 4b: a plan-access block lifts on its own reason only; a frame for an agent of another Computer changes nothing", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  orchestrator.setIO(fakeIo());
  try {
    bindMachine(orchestrator, machine.id, server.id);
    const breaker = (orchestrator as any).wakeCrashLoopBreaker;
    await breaker.recordStart(agent.id, "launch-1", Date.now());
    const planError = authErrorActivity(agent.id, "launch-1") as unknown as { runtimeError: Record<string, unknown> };
    planError.runtimeError = { ...planError.runtimeError, errorClass: "ModelConfigError", errorReason: "model_config_error", requiredAction: "user_model_access" };
    await orchestrator.handleMachineMessage(machine.id, planError as unknown as MachineToServerMessage);
    assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "user_model_access" });

    await orchestrator.handleMachineMessage(machine.id, restoredFrame(agent.id, "user_reauth", "credentials_changed"));
    assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "user_model_access" });

    const [otherMachine] = await getDb().insert(machines).values({
      serverId: server.id, userId: (await getDb().select().from(users))[0]!.id, name: "other-box", apiKeyHash: "hash-other",
    }).returning();
    bindMachine(orchestrator, otherMachine!.id, server.id);
    await orchestrator.handleMachineMessage(otherMachine!.id, restoredFrame(agent.id, "user_model_access"));
    assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "user_model_access" }, "not this Computer's agent");

    await orchestrator.handleMachineMessage(machine.id, restoredFrame(agent.id, "user_model_access", "model_changed"));
    assert.equal(await breaker.automaticWakeHold(agent.id, Date.now()), null);
  } finally {
    await orchestrator.shutdown();
  }
});

test("step 4b, an older daemon (no frame): the block stays; a person's start and a manual stop lift it by themselves, and a login lifts it, each traced with its source", async ({ db: _db }) => {
  const { owner, server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  orchestrator.setIO(fakeIo());
  try {
    bindMachine(orchestrator, machine.id, server.id);
    const events = captureEvents(orchestrator);
    const breaker = (orchestrator as any).wakeCrashLoopBreaker;
    await breaker.recordStart(agent.id, "launch-1", Date.now());
    await orchestrator.handleMachineMessage(machine.id, authErrorActivity(agent.id, "launch-1"));
    const dm = await channelService.findOrCreateDM(server.id, owner.id, agent.id);
    const message = await createMessage(dm!.id, "user", owner.id, "ping");
    assert.deepEqual(await deliverMessageToAgent(orchestrator, message.id, agent.id), { status: "dropped", reason: "wake_suppressed" });

    // The Retry: a person's start lifts the block by itself.
    assert.equal((await orchestrator.startAgent(agent.id)).outcome, "dispatched");
    assert.equal(await breaker.automaticWakeHold(agent.id, Date.now()), null, "the Retry lifted the block");
    assert.deepEqual(lifts(events), [{ cause: "human_start", source: "server_retry", release_cause: "human_start", lifted_reason: "user_reauth" }]);
    const launch2 = orchestrator.starts.at(-1)!.launchId!;

    // It fails the same way; a manual stop lifts that block too.
    await orchestrator.handleMachineMessage(machine.id, authErrorActivity(agent.id, launch2));
    assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "user_reauth" });
    await orchestrator.stopAgent(agent.id, "manual");
    assert.equal(await breaker.automaticWakeHold(agent.id, Date.now()), null);
    assert.deepEqual(lifts(events).at(-1), { cause: "manual_stop", source: "server_retry", release_cause: "explicit_stop", lifted_reason: "user_reauth" });

    // A login on the Computer lifts a sign-in block of an agent on the shared sign-in.
    await getDb().update(agents).set({ runtime: "codex", model: "gpt-5.5" }).where(eq(agents.id, agent.id));
    assert.equal((await orchestrator.startAgent(agent.id)).outcome, "dispatched");
    await orchestrator.handleMachineMessage(machine.id, authErrorActivity(agent.id, orchestrator.starts.at(-1)!.launchId!));
    assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "user_reauth" });
    await (orchestrator as any).liftRuntimeCredentialBlocks(machine.id, "codex", "login");
    assert.equal(await breaker.automaticWakeHold(agent.id, Date.now()), null);
    assert.deepEqual(lifts(events).at(-1), {
      cause: "runtime_credentials_changed", source: "credentials_change", release_cause: "credentials_changed", runtime: "codex", credentials_change: "login",
    });
  } finally {
    await orchestrator.shutdown();
  }
});

// Reconciler step 15 (PR 3): after a daemon restart no record there knows of
// the sign-in pause, so a terminal sign-in reaches the server as the daemon's
// `machine:runtime_credentials:changed {runtime}` (its shared credential
// changed on disk and a fresh status query read it signed in). It lifts what
// a web login lifts for this Computer's agents on that runtime's shared
// sign-in, sign-in pauses only.
class AttachedOrchestrator extends CapturingOrchestrator {
  // A Computer with an attaching person: the status report is read for real.
  protected override async loadRuntimeAccountUsageAttacher(): Promise<string | null> {
    return "attacher";
  }
}

const credentialsChanged = (runtime: unknown): MachineToServerMessage =>
  ({ type: "machine:runtime_credentials:changed", runtime }) as unknown as MachineToServerMessage;

async function blockedCodexAgent(orchestrator: AgentOrchestrator, agentId: string, machineId: string, launchId: string): Promise<void> {
  await getDb().update(agents).set({ runtime: "codex", model: "gpt-5.5", machineId }).where(eq(agents.id, agentId));
  const breaker = (orchestrator as any).wakeCrashLoopBreaker;
  await breaker.recordStart(agentId, launchId, Date.now());
  await orchestrator.handleMachineMessage(machineId, authErrorActivity(agentId, launchId));
  assert.deepEqual(await breaker.automaticWakeHold(agentId, Date.now()), { kind: "blocked", reason: "user_reauth" });
}

test("step 15 PR 3: the daemon's runtime-credentials-changed frame lifts this Computer's sign-in pause on that runtime, and the next message wakes the agent", async ({ db: _db }) => {
  const { owner, server, machine, agent } = await seed();
  const orchestrator = new AttachedOrchestrator();
  orchestrator.setIO(fakeIo());
  try {
    bindMachine(orchestrator, machine.id, server.id);
    const events = captureEvents(orchestrator);
    const breaker = (orchestrator as any).wakeCrashLoopBreaker;
    await blockedCodexAgent(orchestrator, agent.id, machine.id, "launch-1");

    // Reverse check: a status report that reads Codex signed in (as at a
    // ready) lifts nothing; Codex reads logged_in with a revoked token.
    await orchestrator.handleMachineMessage(machine.id, {
      type: "machine:runtime_auth:status",
      report: { collectedAt: new Date().toISOString(), runtimes: { codex: { kind: "logged_in" } } },
    } as MachineToServerMessage);
    assert.equal((await runtimeAuthService.getStatus(machine.id))?.runtimes.codex?.kind, "logged_in", "the report was read");
    assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "user_reauth" }, "a status report alone never lifts");

    // Another runtime, or one this server does not know (or not a string): nothing.
    for (const runtime of ["claude", "grok", 42, undefined]) {
      await orchestrator.handleMachineMessage(machine.id, credentialsChanged(runtime));
      assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "user_reauth" }, String(runtime));
    }
    assert.deepEqual(lifts(events), []);

    await orchestrator.handleMachineMessage(machine.id, credentialsChanged("codex"));
    assert.equal(await breaker.automaticWakeHold(agent.id, Date.now()), null);
    assert.deepEqual(lifts(events), [{
      cause: "runtime_credentials_changed", source: "credentials_change", release_cause: "credentials_changed", runtime: "codex", credentials_change: "disk",
    }]);

    const dm = await channelService.findOrCreateDM(server.id, owner.id, agent.id);
    const message = await createMessage(dm!.id, "user", owner.id, "signed in again");
    await deliverMessageToAgent(orchestrator, message.id, agent.id);
    assert.equal(orchestrator.starts.length, 1, "an automatic wake starts the agent again");
  } finally {
    await orchestrator.shutdown();
  }
});

test("step 15 PR 3: a second disk change within the window lifts nothing, so a credential file that keeps changing cannot cycle the crash-loop breaker", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new AttachedOrchestrator();
  orchestrator.setIO(fakeIo());
  try {
    bindMachine(orchestrator, machine.id, server.id);
    const events = captureEvents(orchestrator);
    const breaker = (orchestrator as any).wakeCrashLoopBreaker;
    await blockedCodexAgent(orchestrator, agent.id, machine.id, "launch-1");

    await orchestrator.handleMachineMessage(machine.id, credentialsChanged("codex"));
    assert.equal(await breaker.automaticWakeHold(agent.id, Date.now()), null, "the first disk change lifts");
    assert.equal(lifts(events).length, 1);

    // The account is still unusable: the next start fails sign-in again and is paused again.
    await blockedCodexAgent(orchestrator, agent.id, machine.id, "launch-2");
    await orchestrator.handleMachineMessage(machine.id, credentialsChanged("codex"));
    assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "user_reauth" }, "a second disk change in the window lifts nothing");
    assert.equal(lifts(events).length, 1, "no second lift, so no fresh crash-loop episode");
  } finally {
    await orchestrator.shutdown();
  }
});

test("step 15 PR 3: the frame lifts sign-in pauses only, and only on the Computer that sent it", async ({ db: _db }) => {
  const { owner, server, machine, agent } = await seed();
  const orchestrator = new AttachedOrchestrator();
  orchestrator.setIO(fakeIo());
  try {
    bindMachine(orchestrator, machine.id, server.id);
    const breaker = (orchestrator as any).wakeCrashLoopBreaker;

    // A plan-access pause on a Codex agent: a sign-in in a terminal does not fix it.
    await getDb().update(agents).set({ runtime: "codex", model: "gpt-5.5" }).where(eq(agents.id, agent.id));
    await breaker.recordStart(agent.id, "launch-1", Date.now());
    const planError = authErrorActivity(agent.id, "launch-1") as unknown as { runtimeError: Record<string, unknown> };
    planError.runtimeError = { ...planError.runtimeError, errorClass: "ModelConfigError", errorReason: "model_config_error", requiredAction: "user_model_access" };
    await orchestrator.handleMachineMessage(machine.id, planError as unknown as MachineToServerMessage);
    assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "user_model_access" });
    await orchestrator.handleMachineMessage(machine.id, credentialsChanged("codex"));
    assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "user_model_access" }, "not a sign-in pause");

    // A sign-in pause on another Computer's Codex agent: this Computer's frame does not reach it.
    const [otherMachine] = await getDb().insert(machines).values({
      serverId: server.id, userId: owner.id, name: "other-box", apiKeyHash: "hash-other",
    }).returning();
    const [otherAgent] = await getDb().insert(agents).values({
      serverId: server.id, name: "elsewhere", status: "inactive", runtime: "codex", model: "gpt-5.5", executionMode: "byoc",
      machineId: otherMachine!.id, creatorType: "user", creatorId: owner.id,
    }).returning();
    bindMachine(orchestrator, otherMachine!.id, server.id);
    await blockedCodexAgent(orchestrator, otherAgent!.id, otherMachine!.id, "launch-other");
    await orchestrator.handleMachineMessage(machine.id, credentialsChanged("codex"));
    assert.deepEqual(await breaker.automaticWakeHold(otherAgent!.id, Date.now()), { kind: "blocked", reason: "user_reauth" }, "another Computer's agent");

    // No connection for the sending machine (not an authenticated daemon): nothing.
    (orchestrator as any).machineConnections.delete(otherMachine!.id);
    await orchestrator.handleMachineMessage(otherMachine!.id, credentialsChanged("codex"));
    assert.deepEqual(await breaker.automaticWakeHold(otherAgent!.id, Date.now()), { kind: "blocked", reason: "user_reauth" }, "no authenticated connection");

    // Its own Computer's frame does.
    bindMachine(orchestrator, otherMachine!.id, server.id);
    await orchestrator.handleMachineMessage(otherMachine!.id, credentialsChanged("codex"));
    assert.equal(await breaker.automaticWakeHold(otherAgent!.id, Date.now()), null);
  } finally {
    await orchestrator.shutdown();
  }
});

test("step 15 PR 3: a frame on a socket that is not the machine's current connection is dropped", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new AttachedOrchestrator();
  orchestrator.setIO(fakeIo());
  try {
    bindMachine(orchestrator, machine.id, server.id);
    const breaker = (orchestrator as any).wakeCrashLoopBreaker;
    await blockedCodexAgent(orchestrator, agent.id, machine.id, "launch-1");
    await orchestrator.handleMachineMessage(machine.id, credentialsChanged("codex"), {} as never);
    assert.deepEqual(await breaker.automaticWakeHold(agent.id, Date.now()), { kind: "blocked", reason: "user_reauth" });
  } finally {
    await orchestrator.shutdown();
  }
});
