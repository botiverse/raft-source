import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";

import type { MachineToServerMessage, ServerToMachineMessage } from "@botiverse/raft-shared";
import {
  REMINDER_FIRE_RECEIPT_CAPABILITY,
  REMINDER_FIRE_REQUEST_CAPABILITY,
} from "@botiverse/raft-shared/src/apps/reminder/protocol.js";

import { getDb } from "../db/index.js";
import { agents, channels, servers, users } from "../db/schema.js";
import {
  createReminder,
  getReminderById,
  type ReminderRow,
} from "../apps/reminder/service.js";
import { AgentOrchestrator } from "./agentOrchestrator.js";


afterEach(async () => {
  await closeTestDatabase();
});

async function seed() {
  const [user] = await getDb().insert(users).values({
    id: "11111111-1111-4111-8111-111111118802",
    email: "legacy-reminder-transition@example.com",
    name: "Legacy Reminder Transition",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await getDb().insert(servers).values({
    id: "22222222-2222-4222-8222-222222228802",
    name: "Legacy Reminder Transition",
    slug: "legacy-reminder-transition",
    ownerId: user!.id,
  }).returning();
  const [agent] = await getDb().insert(agents).values({
    id: "33333333-3333-4333-8333-333333338802",
    serverId: server!.id,
    name: "legacy-reminder-agent",
    status: "active",
    model: "sonnet",
    runtime: "claude",
    executionMode: "byoc",
  }).returning();
  const [channel] = await getDb().insert(channels).values({
    id: "44444444-4444-4444-8444-444444448802",
    serverId: server!.id,
    name: "legacy-reminder-target",
    type: "channel",
  }).returning();
  return { user: user!, server: server!, agent: agent!, channel: channel! };
}

function attempt(
  agentId: string,
  reminderId: string,
  version: number,
  firedAtClient = new Date().toISOString(),
): MachineToServerMessage {
  return {
    type: "reminder.fire_attempt",
    agentId,
    reminderId,
    version,
    firedAtClient,
  };
}

function request(
  agentId: string,
  reminderId: string,
  version: number,
  requestId = "request-1",
  firedAtClient = new Date().toISOString(),
): MachineToServerMessage {
  return {
    type: "reminder.fire_request",
    agentId,
    reminderId,
    version,
    requestId,
    firedAtClient,
  };
}

function bindConnection(
  orchestrator: AgentOrchestrator,
  input: {
    serverId: string;
    daemonVersion: string;
    computerVersion: string;
    capabilities?: string[];
  },
): void {
  (orchestrator as any).machineConnections.set("legacy-reminder-machine", {
    ws: {},
    machineId: "legacy-reminder-machine",
    serverId: input.serverId,
    principalKind: "computer",
    connectionEpochId: "legacy-reminder-connection",
    heartbeatTimer: null,
    runtimeAccountUsageTimer: null,
    lastPong: Date.now(),
    lastIngressAt: Date.now(),
    daemonVersion: input.daemonVersion,
    capabilities: new Set(input.capabilities ?? []),
    runtimes: [],
    migrationTransport: null,
    shutdownIntent: null,
    computerVersion: input.computerVersion,
  });
}

function observeLegacyAdapter(
  orchestrator: AgentOrchestrator,
  agent: { id: string; serverId: string },
) {
  const deliveries: Array<{ agentId: string; content: string }> = [];
  const upserts: ReminderRow[] = [];
  const cancels: Array<{ agentId: string; reminderId: string; version: number }> = [];
  const receiptOutcomes: string[] = [];
  const results: ServerToMachineMessage[] = [];
  (orchestrator as any).validateMachineAgentMessage = async () => agent;
  (orchestrator as any).deliverMessage = async (
    agentId: string,
    message: { content: string },
  ) => {
    deliveries.push({ agentId, content: message.content });
    return { status: "queued" };
  };
  orchestrator.pushReminderUpsert = async (_agentId, row) => {
    upserts.push(row);
    return true;
  };
  orchestrator.pushReminderCancel = async (agentId, reminderId, version) => {
    cancels.push({ agentId, reminderId, version });
    return true;
  };
  (orchestrator as any).sendToMachine = async (_machineId: string, message: ServerToMachineMessage) => {
    results.push(message);
    return true;
  };
  (orchestrator as any).recordBuiltInAppTrace = (
    name: string,
    attrs: Record<string, unknown>,
  ) => {
    if (name === "server.app_source.receipt" && typeof attrs.outcome === "string") {
      receiptOutcomes.push(attrs.outcome);
    }
  };
  return { deliveries, upserts, cancels, receiptOutcomes, results };
}

test("daemon 1.0.15 legacy frame wakes exactly once and re-pushes the recurring revision", async ({ db }) => {

  const { user, server, agent, channel } = await seed();
  const row = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    targetChannelId: channel.id,
    msgId: null,
    title: "legacy recurring catch-up",
    fireAt: new Date(Date.now() - 60_000),
    payload: null,
    recurrence: { version: 1, rule: { kind: "interval", seconds: 900 } },
    createdBy: { type: "human", id: user.id },
  });
  const orchestrator = new AgentOrchestrator();
  bindConnection(orchestrator, {
    serverId: server.id,
    daemonVersion: "1.0.15",
    computerVersion: "9.9.9",
  });
  const observed = observeLegacyAdapter(orchestrator, agent);

  await orchestrator.handleMachineMessage(
    "legacy-reminder-machine",
    attempt(agent.id, row.id, row.version),
  );
  const converged = await getReminderById(row.id);
  assert.ok(converged);
  assert.equal(converged.status, "scheduled");
  assert.equal(converged.version, row.version + 1);
  assert.ok(converged.fireAt.getTime() > Date.now());
  assert.equal(observed.deliveries.length, 1);
  assert.equal(observed.deliveries[0]?.agentId, agent.id);
  assert.match(observed.deliveries[0]?.content ?? "", /catchup/);
  assert.deepEqual(observed.upserts.map((candidate) => candidate.version), [row.version + 1]);
  assert.equal(observed.cancels.length, 0);

  await orchestrator.handleMachineMessage(
    "legacy-reminder-machine",
    attempt(agent.id, row.id, row.version),
  );
  assert.equal(observed.deliveries.length, 1, "duplicate legacy frame must not wake twice");
  assert.equal(observed.upserts.length, 1, "duplicate legacy frame must not re-push twice");
  assert.deepEqual(observed.receiptOutcomes, ["legacy_converged", "legacy_duplicate_noop"]);
});

test("legacy one-time frame reaches a terminal row once", async ({ db }) => {

  const { user, server, agent, channel } = await seed();
  const row = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    targetChannelId: channel.id,
    msgId: null,
    title: "legacy one-time catch-up",
    fireAt: new Date(Date.now() - 60_000),
    payload: null,
    createdBy: { type: "human", id: user.id },
  });
  const orchestrator = new AgentOrchestrator();
  bindConnection(orchestrator, {
    serverId: server.id,
    daemonVersion: "1.0.14",
    computerVersion: "9.9.9",
  });
  const observed = observeLegacyAdapter(orchestrator, agent);

  await orchestrator.handleMachineMessage(
    "legacy-reminder-machine",
    attempt(agent.id, row.id, row.version),
  );
  const converged = await getReminderById(row.id);
  assert.ok(converged);
  assert.equal(converged.status, "fired");
  assert.equal(converged.version, row.version + 1);
  assert.equal(observed.deliveries.length, 1);
  assert.equal(observed.upserts.length, 0);
  assert.deepEqual(observed.cancels, [{
    agentId: agent.id,
    reminderId: row.id,
    version: row.version + 1,
  }]);

  await orchestrator.handleMachineMessage(
    "legacy-reminder-machine",
    attempt(agent.id, row.id, row.version),
  );
  assert.equal(observed.deliveries.length, 1);
  assert.equal(observed.cancels.length, 1);
});

test("legacy on-time fire stays non-catchup after Server processing delay", async ({ db }) => {

  const { user, server, agent, channel } = await seed();
  const dueAt = new Date(Date.now() - 5_000);
  const row = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    targetChannelId: channel.id,
    msgId: null,
    title: "legacy on-time with delayed Server arrival",
    fireAt: dueAt,
    payload: null,
    createdBy: { type: "human", id: user.id },
  });
  const orchestrator = new AgentOrchestrator();
  bindConnection(orchestrator, {
    serverId: server.id,
    daemonVersion: "1.0.15",
    computerVersion: "9.9.9",
  });
  const observed = observeLegacyAdapter(orchestrator, agent);

  await orchestrator.handleMachineMessage(
    "legacy-reminder-machine",
    attempt(agent.id, row.id, row.version, new Date(dueAt.getTime() + 250).toISOString()),
  );

  assert.equal(observed.deliveries.length, 1);
  assert.doesNotMatch(observed.deliveries[0]?.content ?? "", /catchup/);
});

test("a premature legacy frame re-pushes the same revision after the old cache deletes it", async ({ db }) => {

  const { user, server, agent, channel } = await seed();
  const row = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    targetChannelId: channel.id,
    msgId: null,
    title: "legacy premature retry",
    fireAt: new Date(Date.now() + 60_000),
    payload: null,
    createdBy: { type: "human", id: user.id },
  });
  const orchestrator = new AgentOrchestrator();
  bindConnection(orchestrator, {
    serverId: server.id,
    daemonVersion: "1.0.15",
    computerVersion: "9.9.9",
  });
  const observed = observeLegacyAdapter(orchestrator, agent);

  await orchestrator.handleMachineMessage(
    "legacy-reminder-machine",
    attempt(agent.id, row.id, row.version),
  );

  const unchanged = await getReminderById(row.id);
  assert.ok(unchanged);
  assert.equal(unchanged.status, "scheduled");
  assert.equal(unchanged.version, row.version);
  assert.equal(observed.deliveries.length, 0);
  assert.deepEqual(observed.upserts.map((candidate) => candidate.version), [row.version]);
  assert.equal(observed.cancels.length, 0);
  assert.deepEqual(observed.receiptOutcomes, ["legacy_premature_rearmed"]);
});

test("new-wire capability rejects legacy frames even when the fallback version is old", async ({ db }) => {

  const { user, server, agent, channel } = await seed();
  const makeRow = (title: string) => createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    targetChannelId: channel.id,
    msgId: null,
    title,
    fireAt: new Date(Date.now() - 60_000),
    payload: null,
    createdBy: { type: "human" as const, id: user.id },
  });
  const orchestrator = new AgentOrchestrator();
  const observed = observeLegacyAdapter(orchestrator, agent);

  const byVersion = await makeRow("version-gated");
  bindConnection(orchestrator, {
    serverId: server.id,
    daemonVersion: "1.0.16",
    computerVersion: "9.9.9",
  });
  await orchestrator.handleMachineMessage(
    "legacy-reminder-machine",
    attempt(agent.id, byVersion.id, byVersion.version),
  );

  const byCapability = await makeRow("capability-gated");
  bindConnection(orchestrator, {
    serverId: server.id,
    daemonVersion: "1.0.15",
    computerVersion: "9.9.9",
    capabilities: [REMINDER_FIRE_RECEIPT_CAPABILITY],
  });
  await orchestrator.handleMachineMessage(
    "legacy-reminder-machine",
    attempt(agent.id, byCapability.id, byCapability.version),
  );

  assert.equal((await getReminderById(byVersion.id))?.version, byVersion.version);
  assert.equal((await getReminderById(byCapability.id))?.version, byCapability.version);
  assert.equal(observed.deliveries.length, 0);
  assert.equal(observed.upserts.length, 0);
  assert.equal(observed.cancels.length, 0);
  assert.deepEqual(observed.receiptOutcomes, ["rejected", "rejected"]);
});

test("fire-request returns a typed premature duration without changing row or waking", async ({ db }) => {

  const { user, server, agent, channel } = await seed();
  const row = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    targetChannelId: channel.id,
    msgId: null,
    title: "typed premature",
    fireAt: new Date(Date.now() + 9_000),
    payload: null,
    createdBy: { type: "human", id: user.id },
  });
  const orchestrator = new AgentOrchestrator();
  bindConnection(orchestrator, {
    serverId: server.id,
    daemonVersion: "1.0.16",
    computerVersion: "99.0.0",
    capabilities: [REMINDER_FIRE_REQUEST_CAPABILITY],
  });
  const observed = observeLegacyAdapter(orchestrator, agent);

  await orchestrator.handleMachineMessage(
    "legacy-reminder-machine",
    request(agent.id, row.id, row.version),
  );
  const unchanged = await getReminderById(row.id);
  assert.ok(unchanged);
  assert.equal(unchanged.version, row.version);
  assert.equal(unchanged.status, "scheduled");
  assert.deepEqual(observed.deliveries, []);
  assert.deepEqual(observed.upserts, []);
  assert.deepEqual(observed.cancels, []);
  const [result] = observed.results;
  assert.equal(result?.type, "reminder.fire_request.result");
  if (result?.type === "reminder.fire_request.result") {
    assert.equal(result.outcome, "premature");
    if (result.outcome === "premature") {
      assert.equal(result.reason, "premature_fire");
      assert.ok(result.retryAfterMs > 0 && result.retryAfterMs <= 9_000);
      assert.equal(Date.parse(result.dueAt), row.fireAt.getTime());
    }
  }
});

test("fire-request commits once and replays the same accepted terminal after response loss", async ({ db }) => {

  const { user, server, agent, channel } = await seed();
  const row = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    targetChannelId: channel.id,
    msgId: null,
    title: "typed accepted replay",
    fireAt: new Date(Date.now() - 5_000),
    payload: null,
    createdBy: { type: "human", id: user.id },
  });
  const orchestrator = new AgentOrchestrator();
  bindConnection(orchestrator, {
    serverId: server.id,
    daemonVersion: "1.0.16",
    computerVersion: "0.0.1",
    capabilities: [REMINDER_FIRE_REQUEST_CAPABILITY],
  });
  const observed = observeLegacyAdapter(orchestrator, agent);
  const message = request(agent.id, row.id, row.version, "lost-response-request");

  await orchestrator.handleMachineMessage("legacy-reminder-machine", message);
  await orchestrator.handleMachineMessage("legacy-reminder-machine", message);

  const converged = await getReminderById(row.id);
  assert.ok(converged);
  assert.equal(converged.status, "fired");
  assert.equal(converged.version, row.version + 1);
  assert.equal(observed.deliveries.length, 0, "typed path never uses the legacy Server wake");
  assert.equal(observed.cancels.length, 1, "duplicate request cannot repeat lifecycle transport");
  assert.deepEqual(
    observed.results.map((result) =>
      result.type === "reminder.fire_request.result"
        ? [result.outcome, result.requestId]
        : [result.type]
    ),
    [["accepted", "lost-response-request"], ["accepted", "lost-response-request"]],
  );
});

test("fire-request reports non-catchup when an on-time Computer fire reaches Server late", async ({ db }) => {

  const { user, server, agent, channel } = await seed();
  const dueAt = new Date(Date.now() - 5_000);
  const row = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    targetChannelId: channel.id,
    msgId: null,
    title: "typed on-time with delayed Server arrival",
    fireAt: dueAt,
    payload: null,
    createdBy: { type: "human", id: user.id },
  });
  const orchestrator = new AgentOrchestrator();
  bindConnection(orchestrator, {
    serverId: server.id,
    daemonVersion: "1.0.16",
    computerVersion: "0.0.1",
    capabilities: [REMINDER_FIRE_REQUEST_CAPABILITY],
  });
  const observed = observeLegacyAdapter(orchestrator, agent);

  await orchestrator.handleMachineMessage(
    "legacy-reminder-machine",
    request(
      agent.id,
      row.id,
      row.version,
      "delayed-server-request",
      new Date(dueAt.getTime() + 250).toISOString(),
    ),
  );

  const [result] = observed.results;
  assert.equal(result?.type, "reminder.fire_request.result");
  if (result?.type === "reminder.fire_request.result") {
    assert.equal(result.outcome, "accepted");
    if (result.outcome === "accepted") {
      assert.equal(result.catchup, false);
    }
  }
});
