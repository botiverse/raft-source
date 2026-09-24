import { installFakeIo } from "./channels.api.fixtures.js";
import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  __resetFailpointsForTests,
  __setFailpointsForTests,
  BasicTracer,
  InMemoryFailpointRegistry,
  MemoryTraceSink,
  type AgentMessage,
} from "@botiverse/raft-shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import { openTestApp } from "../test/integration/app.js";
import { getDb } from "../db/index.js";
import { channelAgents, channelHumans, channels, inboxNotificationFacts, jointChannels, jointChannelServers, messages, serverAgentMembers, servers, threadFollows, users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { createAgent, assignMachine } from "../services/agentService.js";
import { AgentOrchestrator } from "../services/agentOrchestrator.js";
import { registerMachine, updateMachine } from "../services/machineService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import * as channelService from "../services/channelService.js";
import {
  __resetMessageServiceDepsForTests,
  __setMessageServiceDepsForTests,
  createMessage,
} from "../services/messageService.js";
import { recordInboxNotificationFacts } from "../services/inboxNotificationService.js";
import * as taskService from "../services/taskService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const execFileAsync = promisify(execFile);
const cliEntry = fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url));

async function seed() {
  const db = getDb();
  const [owner] = await db
    .insert(users)
    .values({
      email: "internal-channel-owner@slock.test",
      name: "internal-channel-owner",
      displayName: "Owner",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
    })
    .returning();
  const server = await createServer("Internal Channel", "internal-channel", owner.id);
  const agent = await createAgent(server.id, "channel-agent", { runtime: "claude" });
  const { machine, apiKey } = await registerMachine(server.id, owner.id, "channel-machine");
  await assignMachine(agent.id, machine.id);
  const { apiKey: agentApiKey } = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["channels", "server"],
    name: "channel-membership-cli-e2e",
    createdByUserId: owner.id,
  });
  const channel = await channelService.createChannel(server.id, "focus-room", "Agent can leave this channel");
  await channelService.addAgent(channel.id, agent.id);
  const joinOnlyChannel = await channelService.createChannel(server.id, "join-public", "Agent can self-join this visible public channel");
  const [allChannel] = (await channelService.listChannels(server.id)).filter((candidate) => candidate.name === "all");
  return { server, agent, machine, apiKey, agentApiKey, channel, joinOnlyChannel, allChannel, owner };
}

function machineHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function installReceiveOrchestrator(
  app: { set: (k: string, v: unknown) => void },
  receiveMessages: (signal?: AbortSignal) => Promise<AgentMessage[]>,
): void {
  let bufferedMessages: AgentMessage[] = [];
  app.set("agentOrchestrator", {
    deliverMessage: async () => {},
    receiveMessages: async (_agentId: string, _block: boolean, _timeoutMs: number, signal?: AbortSignal) => {
      bufferedMessages = await receiveMessages(signal);
      return bufferedMessages;
    },
    discardUndeliverableMessages: (_agentId: string, messages: AgentMessage[]) => {
      const seqs = new Set(messages.map((message) => message.seq).filter((seq): seq is number => Number.isInteger(seq)));
      const before = bufferedMessages.length;
      bufferedMessages = bufferedMessages.filter((message) => !message.seq || !seqs.has(message.seq));
      return { removedCount: before - bufferedMessages.length };
    },
    hasMachineLocally: () => true,
    getActivity: async () => ({ activity: "offline", activityDetail: "" }),
    getMachineStatus: async () => "offline",
    getMachineStatusVersion: async () => 0,
    getMachineDaemonVersion: () => null,
    evictCache: () => {},
    shutdown: () => {},
    setIO: () => {},
  });
}

async function isAgentInChannel(channelId: string, agentId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ channelId: channelAgents.channelId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, channelId), eq(channelAgents.agentId, agentId)));
  return !!row;
}

async function isHumanInChannel(channelId: string, userId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ channelId: channelHumans.channelId })
    .from(channelHumans)
    .where(and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, userId)));
  return !!row;
}

async function setAgentServerRole(serverId: string, agentId: string, role: "member" | "admin") {
  await getDb()
    .update(serverAgentMembers)
    .set({ role })
    .where(and(eq(serverAgentMembers.serverId, serverId), eq(serverAgentMembers.agentId, agentId)));
}

async function waitForChannelSystemMessageCount(
  channelId: string,
  content: string,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  let actual = -1;
  while (Date.now() < deadline) {
    const rows = await getDb()
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.channelId, channelId), eq(messages.content, content)));
    actual = rows.length;
    if (actual === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(actual, expected, `timed out waiting for ${expected} lifecycle system message(s)`);
}

async function createFollowedThread(channelId: string, ownerId: string, agentId: string) {
  const db = getDb();
  const parentMessage = await createMessage(channelId, "user", ownerId, "parent message");
  const thread = await channelService.getOrCreateThread(parentMessage.id, ownerId, "user");
  await db.insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "agent",
    followerId: agentId,
    parentMessageId: parentMessage.id,
    reason: "manual",
  }).onConflictDoNothing();
  return { thread, parentMessage };
}

async function isAgentFollowingThread(threadChannelId: string, agentId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ threadChannelId: threadFollows.threadChannelId })
    .from(threadFollows)
    .where(and(
      eq(threadFollows.threadChannelId, threadChannelId),
      eq(threadFollows.followerType, "agent"),
      eq(threadFollows.followerId, agentId),
      isNull(threadFollows.unfollowedAt),
    ));
  return !!row;
}

async function runSlockCli(
  args: string[],
  env: Record<string, string>,
  input?: string,
): Promise<{ stdout: string; stderr: string }> {
  const raftEnv = {
    ...(env.SLOCK_SERVER_URL && !env.RAFT_SERVER_URL ? { RAFT_SERVER_URL: env.SLOCK_SERVER_URL } : {}),
    ...(env.SLOCK_AGENT_ID && !env.RAFT_AGENT_ID ? { RAFT_AGENT_ID: env.SLOCK_AGENT_ID } : {}),
    ...(env.SLOCK_AGENT_TOKEN && !env.RAFT_AGENT_TOKEN ? { RAFT_AGENT_TOKEN: env.SLOCK_AGENT_TOKEN } : {}),
    ...(env.SLOCK_SERVER_ID && !env.RAFT_SERVER_ID ? { RAFT_SERVER_ID: env.SLOCK_SERVER_ID } : {}),
  };
  const childEnv = {
    ...process.env,
    SLOCK_AGENT_ID: "",
    SLOCK_SERVER_URL: "",
    SLOCK_SERVER_ID: "",
    SLOCK_AGENT_TOKEN_FILE: "",
    SLOCK_AGENT_TOKEN: "",
    SLOCK_AGENT_PROXY_URL: "",
    SLOCK_AGENT_PROXY_TOKEN: "",
    SLOCK_AGENT_PROXY_TOKEN_FILE: "",
    ...raftEnv,
    ...env,
  };
  if (input === undefined) {
    return execFileAsync(process.execPath, ["--import", "tsx", cliEntry, ...args], { env: childEnv });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", cliEntry, ...args], {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(Object.assign(new Error(`raft CLI exited with code ${code}`), { code, stdout, stderr }));
    });
    child.stdin.end(input);
  });
}

async function createAgentProfileEnv(baseUrl: string, serverId: string, agentId: string): Promise<{
  env: Record<string, string>;
  cleanup: () => void;
}> {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-agent-profile-"));
  const { apiKey } = await mintAgentCredential({
    agentId,
    scopes: ["read", "send", "server", "channels"],
    name: `cli-e2e-${randomUUID().slice(0, 8)}`,
    createdByUserId: null,
  });
  fs.writeFileSync(path.join(profileDir, "credential.json"), JSON.stringify({
    schemaVersion: 1,
    serverUrl: baseUrl,
    agentId,
    serverId,
    apiKey,
    scopes: ["read", "send", "server", "channels"],
  }));
  return {
    env: {
      RAFT_PROFILE: "cli-e2e",
      RAFT_PROFILE_DIR: profileDir,
    },
    cleanup: () => fs.rmSync(profileDir, { recursive: true, force: true }),
  };
}

async function assertSlockCliFails(
  args: string[],
  env: Record<string, string>,
  pattern: RegExp,
): Promise<{ stdout: string; stderr: string }> {
  try {
    await runSlockCli(args, env);
  } catch (err) {
    const failure = err as { code?: number | string; stdout?: string; stderr?: string };
    assert.notEqual(failure.code, 0);
    const stdout = failure.stdout ?? "";
    const stderr = failure.stderr ?? "";
    assert.match(`${stdout}\n${stderr}`, pattern);
    return { stdout, stderr };
  }
  assert.fail(`expected slock ${args.join(" ")} to fail`);
}

test("agent receive long-poll records semantic phases without raw ids", async ({ app }) => {
  const { agent, apiKey } = await seed();
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "1".repeat(32),
    spanIdGenerator: () => "2".repeat(16),
  });
  app.app.set("serverTracer", tracer);
  installReceiveOrchestrator(app.app, async () => []);

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/receive?block=false&timeout=1`, {
    headers: machineHeaders(apiKey),
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  assert.deepEqual(await res.json(), { messages: [] });

  const [span] = sink.getAllSpans();
  assert.equal(span.name, "server.http.request");
  assert.equal(span.attrs?.route_pattern, "/internal/agent/:id/receive");
  assert.equal(span.attrs?.caller_kind, "agent");
  assert.equal(span.attrs?.agent_id_present, true);
  assert.deepEqual(
    span.events.map((event) => event.name),
    [
      "agent_receive.request.started",
      "agent.ownership.checked",
      "machine.routing.checked",
      "agent_receive.wait.started",
      "agent_receive.messages.received",
      "messages.rendered",
      "response.ready",
      "http.response.finished",
    ],
  );

  const receivedEvent = span.events.find((event) => event.name === "agent_receive.messages.received");
  assert.equal(receivedEvent?.attrs?.messages_count, 0);
  assert.equal(receivedEvent?.attrs?.outcome, "empty");
  const readyEvent = span.events.find((event) => event.name === "response.ready");
  assert.equal(readyEvent?.attrs?.messages_count, 0);
  assert.equal(Object.values(span.attrs ?? {}).includes(agent.id), false);
  assert.equal(span.events.some((event) => Object.values(event.attrs ?? {}).includes(agent.id)), false);
});

test("legacy agent receive refreshes a task amended after enqueue before returning it", async ({ app }) => {

  try {
    const { agent, apiKey, channel, owner } = await seed();
    await channelService.addHuman(channel.id, owner.id);
    const { tasks: [created], hostMessages: [hostMessage] } = await taskService.createTasks(
      channel.id,
      "user",
      owner.id,
      [{ title: "legacy queued title A", description: "legacy queued description A" }],
    );
    const queued: AgentMessage = {
      channel_id: channel.id,
      channel_name: channel.name,
      channel_type: "channel",
      sender_id: owner.id,
      sender_name: owner.name,
      sender_type: "human",
      content: hostMessage.content,
      timestamp: hostMessage.createdAt.toISOString(),
      seq: hostMessage.seq,
      message_id: hostMessage.id,
      task_status: created.status,
      task_number: created.taskNumber,
      task_assignee_type: null,
      task_assignee_id: null,
      task_assignee_name: null,
      task_current_projection: {
        title: created.title,
        description: created.description,
        revision: created.revision,
        superseded: false,
        amended_at: null,
        amended_by_type: null,
        amended_by_name: null,
        source: "tasks_current_projection",
      },
    };
    installReceiveOrchestrator(app.app, async () => [queued]);

    const amendment = await taskService.amendTask(created.id, {
      title: "legacy current title B",
      description: "legacy current description B",
    }, "user", owner.id);
    assert.notEqual(typeof amendment, "string", String(amendment));
    if (typeof amendment === "string") return;

    const registry = new InMemoryFailpointRegistry();
    registry.configure("server.message.taskProjection.canonicalTaskFactsQuery", {
      effect: "throw",
      payload: "injected legacy drain refresh failure",
    });
    __setFailpointsForTests(registry);
    const failed = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/receive?block=false&timeout=1`, {
      headers: machineHeaders(apiKey),
    });
    assert.equal(failed.status, 500, "legacy drain must not return an unverified queued task snapshot");

    __resetFailpointsForTests();
    const response = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/receive?block=false&timeout=1`, {
      headers: machineHeaders(apiKey),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { messages?: AgentMessage[] };
    assert.equal(body.messages?.length, 1);
    assert.equal(body.messages?.[0]?.content, "legacy queued title A", "immutable host bytes must survive refresh");
    assert.deepEqual(body.messages?.[0]?.task_current_projection, {
      title: "legacy current title B",
      description: "legacy current description B",
      revision: amendment.row.revision,
      superseded: true,
      amended_at: amendment.event.createdAt.toISOString(),
      amended_by_type: "user",
      amended_by_name: owner.name,
      source: "tasks_current_projection",
    });
  } finally {
    __resetFailpointsForTests();
    await app.close();
  }
});

test("agent receive drops queued private-channel messages after membership removal", async ({ app }) => {
  const { server, agent, apiKey, allChannel, owner } = await seed();
  const privateChannel = await channelService.createChannel(server.id, "removed-private-room", "private surface", "private");
  await channelService.addAgent(privateChannel.id, agent.id);
  await channelService.removeAgent(privateChannel.id, agent.id);
  const foreignServer = await createServer("Internal Foreign Server", "internal-foreign-server", owner.id);
  const foreignChannel = await channelService.createChannel(foreignServer.id, "foreign-public-room", "cross-server public");

  const queuedPrivate: AgentMessage = {
    channel_id: privateChannel.id,
    channel_name: privateChannel.name,
    channel_type: "private",
    sender_id: "system",
    sender_name: "system",
    sender_type: "system",
    content: "queued before removal",
    timestamp: new Date(0).toISOString(),
    seq: 50,
    message_id: "private-message",
  };
  const queuedForeignPublic: AgentMessage = {
    channel_id: foreignChannel.id,
    channel_name: foreignChannel.name,
    channel_type: "channel",
    sender_id: "system",
    sender_name: "system",
    sender_type: "system",
    content: "foreign server public",
    timestamp: new Date(0).toISOString(),
    seq: 52,
    message_id: "foreign-public-message",
  };
  const queuedPublic: AgentMessage = {
    channel_id: allChannel.id,
    channel_name: allChannel.name,
    channel_type: "channel",
    sender_id: "system",
    sender_name: "system",
    sender_type: "system",
    content: "still visible",
    timestamp: new Date(0).toISOString(),
    seq: 51,
    message_id: "public-message",
  };
  installReceiveOrchestrator(app.app, async () => [queuedPrivate, queuedForeignPublic, queuedPublic]);

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/receive?block=false&timeout=1`, {
    headers: machineHeaders(apiKey),
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = await res.json() as { messages?: AgentMessage[] };
  assert.deepEqual(body.messages?.map((message) => message.content), ["still visible"]);
  assert.deepEqual(body.messages?.map((message) => message.channel_name), ["all"]);
});

test("agent receive long-poll records timeout and failure outcomes", async () => {
  const timeoutApp = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const { agent, apiKey } = await seed();
    const sink = new MemoryTraceSink();
    timeoutApp.app.set("serverTracer", new BasicTracer({
      sink,
      traceIdGenerator: () => "7".repeat(32),
      spanIdGenerator: () => "8".repeat(16),
    }));
    installReceiveOrchestrator(timeoutApp.app, async () => []);

    const res = await fetch(`${timeoutApp.baseUrl}/internal/agent/${agent.id}/receive?block=true&timeout=1`, {
      headers: machineHeaders(apiKey),
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const [span] = sink.getAllSpans();
    const receivedEvent = span.events.find((event) => event.name === "agent_receive.messages.received");
    assert.equal(receivedEvent?.attrs?.outcome, "timeout");
  } finally {
    await timeoutApp.close();
  }

  const failureApp = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  const originalConsoleError = console.error;
  try {
    console.error = () => {};
    const { agent, apiKey } = await seed();
    const sink = new MemoryTraceSink();
    failureApp.app.set("serverTracer", new BasicTracer({
      sink,
      traceIdGenerator: () => "9".repeat(32),
      spanIdGenerator: () => "a".repeat(16),
    }));
    installReceiveOrchestrator(failureApp.app, async () => {
      throw new Error("receive failed");
    });

    const res = await fetch(`${failureApp.baseUrl}/internal/agent/${agent.id}/receive?block=true&timeout=1`, {
      headers: machineHeaders(apiKey),
    });
    assert.equal(res.status, 500, `expected 500, got ${res.status}`);
    const [span] = sink.getAllSpans();
    assert.equal(span.status, "error");
    const failedEvent = span.events.find((event) => event.name === "agent_receive.request.failed");
    assert.equal(failedEvent?.attrs?.error_class, "Error");
    assert.equal(Object.values(failedEvent?.attrs ?? {}).includes("receive failed"), false);
  } finally {
    console.error = originalConsoleError;
    await failureApp.close();
  }
});

test("agent receive long-poll closes the HTTP span exactly once on client abort", async ({ app }) => {
  const { agent, apiKey } = await seed();
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "3".repeat(32),
    spanIdGenerator: () => "4".repeat(16),
  });
  app.app.set("serverTracer", tracer);

  let markReceiveStarted!: () => void;
  const receiveStarted = new Promise<void>((resolve) => {
    markReceiveStarted = resolve;
  });
  let abortObserved!: Promise<void>;
  installReceiveOrchestrator(app.app, async (signal) => {
    markReceiveStarted();
    abortObserved = new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    await abortObserved;
    return [];
  });

  const abort = new AbortController();
  const request = fetch(`${app.baseUrl}/internal/agent/${agent.id}/receive?block=true&timeout=10000`, {
    headers: machineHeaders(apiKey),
    signal: abort.signal,
  });
  await receiveStarted;
  abort.abort();
  await assert.rejects(request, { name: "AbortError" });
  await abortObserved;
  await new Promise((resolve) => setTimeout(resolve, 20));

  const spans = sink.getAllSpans();
  assert.equal(spans.length, 1);
  const [span] = spans;
  assert.equal(span.status, "cancelled");
  assert.equal(span.events.filter((event) => event.name === "http.response.closed").length, 1);
  assert.equal(span.events.filter((event) => event.name === "http.response.finished").length, 0);
  assert.equal(
    span.events.filter((event) => event.name === "agent_receive.request.closed").length,
    1,
    JSON.stringify(span.events.map((event) => event.name)),
  );
  assert.equal(Object.values(span.attrs ?? {}).includes(agent.id), false);
});

test("agent internal route can leave its own regular channel without admin permissions", async ({ app }) => {
  const { agent, apiKey, channel } = await seed();
  const events = installFakeIo(app.app);
  assert.equal(await isAgentInChannel(channel.id, agent.id), true);

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels/${channel.id}/leave`, {
    method: "POST",
    headers: machineHeaders(apiKey),
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  assert.equal(await isAgentInChannel(channel.id, agent.id), false);
  assert.deepEqual(events, [
    {
      room: `server:${agent.serverId}`,
      event: "channel:members-updated",
      payload: { channelId: channel.id },
    },
  ]);
});

test("agent internal route can leave private channel and empty private channel is deleted", async ({ app }) => {
  const db = getDb();
  const { agent, apiKey, server } = await seed();
  const privateChannel = await channelService.createChannel(server.id, "agent-private-leave", undefined, "private");
  await channelService.addAgent(privateChannel.id, agent.id);
  const parentMessage = await createMessage(privateChannel.id, "agent", agent.id, "private self-leave parent");
  const thread = await channelService.getOrCreateThread(parentMessage.id, agent.id, "agent");
  const events = installFakeIo(app.app);
  const purges: Array<{ agentId: string; channelIds: string[]; reason?: string }> = [];
  const deliveryAckCalls: Array<{ agentId: string; channelId: string; seq: number }> = [];
  const agentOrchestrator = app.app.get("agentOrchestrator") as {
    purgeAgentInboxForChannelTree: (agentId: string, parentChannelId: string, reason?: string) => Promise<unknown>;
    acknowledgeDeliveredMessagesForChannelUpToSeq?: (agentId: string, channelId: string, seq: number) => unknown;
  };
  agentOrchestrator.acknowledgeDeliveredMessagesForChannelUpToSeq = (agentId, channelId, seq) => {
    deliveryAckCalls.push({ agentId, channelId, seq });
    return { removedCount: 0 };
  };
  agentOrchestrator.purgeAgentInboxForChannelTree = async (agentId, parentChannelId, reason) => {
    const threadChannelIds = await channelService.listThreadChannelIdsForParentChannel(parentChannelId);
    purges.push({ agentId, channelIds: [parentChannelId, ...threadChannelIds], reason });
  };

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels/${privateChannel.id}/leave`, {
    method: "POST",
    headers: machineHeaders(apiKey),
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  assert.equal(await isAgentInChannel(privateChannel.id, agent.id), false);
  assert.deepEqual(events, [
    {
      room: `channel:${privateChannel.id}`,
      event: "channel:members-updated",
      payload: { channelId: privateChannel.id },
    },
  ]);
  assert.deepEqual(purges, [{
    agentId: agent.id,
    channelIds: [privateChannel.id, thread.id],
    reason: "channel_membership_removed",
  }]);
  assert.deepEqual(deliveryAckCalls, []);

  const [deleted] = await db
    .select({ deletedAt: channels.deletedAt })
    .from(channels)
    .where(eq(channels.id, privateChannel.id));
  assert.ok(deleted?.deletedAt, "agent-only private channel should be deleted when the agent leaves");
});

test("agent server info includes current runtime machine context", async ({ app }) => {
  const { agent, machine, apiKey, server } = await seed();
  await updateMachine(machine.id, { description: "Runs local UI previews." });

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/server`, {
    method: "GET",
    headers: machineHeaders(apiKey),
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const data = await res.json() as any;
  assert.deepEqual(data.runtimeContext, {
    agentId: agent.id,
    runtime: agent.runtime,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    serverId: server.id,
    machineId: machine.id,
    machineName: machine.name,
    machineDescription: "Runs local UI previews.",
    machineHostname: null,
    machineOs: null,
    daemonVersion: null,
    workspacePath: null,
  });
  assert.equal(data.serverRole, "member");
  assert.equal(data.serverCapabilities?.addChannelMembers, true);
  const ownAgent = data.agents.find((candidate: { name: string }) => candidate.name === agent.name);
  assert.equal(ownAgent?.role, "member");
  assert.equal(ownAgent?.status, agent.status);
  assert.equal(ownAgent?.activity, "offline");
  assert.equal(ownAgent?.activityDetail, "");
});

test("agent server info hides archived channels and non-member private channels", async ({ app }) => {
  const { agent, apiKey, server, owner } = await seed();
  await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  const archivedChannel = await channelService.createChannel(server.id, "archived-agent-list", "hidden from list_server");
  await channelService.addAgent(archivedChannel.id, agent.id);
  await channelService.archiveChannel(archivedChannel.id, owner.id);
  const privateMemberChannel = await channelService.createChannel(server.id, "agent-private-member", undefined, "private");
  await channelService.addAgent(privateMemberChannel.id, agent.id);
  await channelService.createChannel(server.id, "agent-private-outsider", undefined, "private");

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/server`, {
    method: "GET",
    headers: machineHeaders(apiKey),
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const data = await res.json() as { channels: Array<{ name: string; type: string; joined: boolean; archivedAt?: string | null }> };
  const channelNames = data.channels.map((channel) => channel.name);
  const byName = new Map(data.channels.map((channel) => [channel.name, channel]));
  assert.ok(channelNames.includes("focus-room"), "agent should still see active regular channels");
  assert.ok(channelNames.includes("join-public"), "agent should still see public channels it has not joined");
  assert.ok(channelNames.includes("agent-private-member"), "agent should see private channels it belongs to");
  assert.equal(byName.get("focus-room")?.type, "channel", "agent list_server must identify public channels");
  assert.equal(byName.get("agent-private-member")?.type, "private", "agent list_server must identify private channels");
  assert.ok(!channelNames.includes("agent-private-outsider"), "agent must not see private channels it does not belong to");
  assert.ok(!channelNames.includes("archived-agent-list"), "agent list_server must not include archived channels");
});

test("agent internal route can unfollow its own thread attention row", async ({ app }) => {
  const { agent, apiKey, channel, owner } = await seed();
  const { thread, parentMessage } = await createFollowedThread(channel.id, owner.id, agent.id);
  assert.equal(await isAgentFollowingThread(thread.id, agent.id), true);
  assert.equal(await isAgentInChannel(channel.id, agent.id), true);

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/threads/unfollow`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ thread: `#focus-room:${parentMessage.id.slice(0, 8)}` }),
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  assert.equal(await isAgentFollowingThread(thread.id, agent.id), false);
  assert.equal(await isAgentInChannel(channel.id, agent.id), true);
});

test("CLI e2e: slock thread unfollow removes agent attention without leaving parent channel", async ({ app }) => {

  let cleanupProfile: (() => void) | undefined;
  try {
    const { agent, channel, owner, server } = await seed();
    const agentProfile = await createAgentProfileEnv(app.baseUrl, server.id, agent.id);
    cleanupProfile = agentProfile.cleanup;
    const { thread, parentMessage } = await createFollowedThread(channel.id, owner.id, agent.id);
    const threadTarget = `#focus-room:${parentMessage.id.slice(0, 8)}`;
    assert.equal(await isAgentFollowingThread(thread.id, agent.id), true);
    assert.equal(await isAgentInChannel(channel.id, agent.id), true);

    const { stdout, stderr } = await runSlockCli(
      ["thread", "unfollow", "--target", threadTarget],
      agentProfile.env,
    );

    assert.equal(stderr, "");
    assert.match(stdout, /^Unfollowed #focus-room:[0-9a-f]{8}\./);
    assert.equal(await isAgentFollowingThread(thread.id, agent.id), false);
    assert.equal(await isAgentInChannel(channel.id, agent.id), true);
  } finally {
    cleanupProfile?.();
    await app.close();
  }
});

test("CLI e2e: parent-muted followed thread travels from message send through server delivery to message check", async ({ app }) => {

  const cleanups: Array<() => void> = [];
  try {
    const { server, agent: seededAgent, channel, owner } = await seed();
    await channelService.removeAgent(channel.id, seededAgent.id);
    const sender = await createAgent(server.id, "cli-thread-sender", { runtime: "external", model: "external" });
    const receiver = await createAgent(server.id, "cli-thread-receiver", { runtime: "external", model: "external" });
    await channelService.addAgent(channel.id, sender.id);
    await channelService.addAgent(channel.id, receiver.id);
    // Pin the durable read boundary explicitly. Relying on the cold-start
    // membership timestamp makes the parent control nondeterministic when the
    // membership and parent rows share the same database timestamp.
    await channelService.markAgentLegacyRead(receiver.id, channel.id, 0);

    const { thread, parentMessage } = await createFollowedThread(channel.id, owner.id, receiver.id);
    const threadTarget = `#focus-room:${parentMessage.id.slice(0, 8)}`;
    const muteState = await channelService.setInboxTargetActivityMuteState({
      receiverType: "agent",
      receiverId: receiver.id,
      serverId: server.id,
      sourceChannelId: channel.id,
      activityMuted: true,
    });
    assert.equal(muteState.activityMuted, true);
    assert.equal(await isAgentFollowingThread(thread.id, receiver.id), true);

    // Exercise the production queue instead of the test harness's no-op
    // deliverMessage stub. External agents are deliberate here: the server
    // must queue their events without trying to spawn a managed runtime.
    app.app.set("agentOrchestrator", new AgentOrchestrator());

    const senderProfile = await createAgentProfileEnv(app.baseUrl, server.id, sender.id);
    const receiverProfile = await createAgentProfileEnv(app.baseUrl, server.id, receiver.id);
    cleanups.push(senderProfile.cleanup, receiverProfile.cleanup);

    const baseline = await runSlockCli(["message", "check"], receiverProfile.env);
    assert.equal(baseline.stderr, "");
    assert.match(baseline.stdout, new RegExp(
      `\\[target=#focus-room msg=${parentMessage.id.slice(0, 8)} time=.* type=human\\] @${owner.name}: parent message`,
    ));
    assert.match(baseline.stdout, /No more new inbox messages\./);

    const mutedRootContent = `muted root control ${randomUUID()}`;
    const rootSend = await runSlockCli(
      ["message", "send", "--target", "#focus-room"],
      senderProfile.env,
      mutedRootContent,
    );
    assert.equal(rootSend.stderr, "");
    assert.match(rootSend.stdout, /^Message sent to #focus-room\. Message ID: [0-9a-f-]+/);

    const afterMutedRoot = await runSlockCli(["message", "check"], receiverProfile.env);
    assert.equal(afterMutedRoot.stderr, "");
    assert.equal(afterMutedRoot.stdout, "No new inbox messages.\n");

    const threadContent = `followed thread delivery ${randomUUID()}`;
    const threadSend = await runSlockCli(
      ["message", "send", "--target", threadTarget],
      senderProfile.env,
      threadContent,
    );
    assert.equal(threadSend.stderr, "");
    assert.match(threadSend.stdout, new RegExp(`^Message sent to ${threadTarget}\\. Message ID: [0-9a-f-]+`));

    const delivered = await runSlockCli(["message", "check"], receiverProfile.env);
    assert.equal(delivered.stderr, "");
    assert.match(delivered.stdout, new RegExp(
      `\\[target=${threadTarget} msg=[0-9a-f]{8} time=.* type=agent\\] @${sender.name}: ${threadContent}`,
    ));
    assert.match(delivered.stdout, /No more new inbox messages\./);
    assert.doesNotMatch(delivered.stdout, new RegExp(mutedRootContent));

    const afterAck = await runSlockCli(["message", "check"], receiverProfile.env);
    assert.equal(afterAck.stderr, "");
    assert.equal(afterAck.stdout, "No new inbox messages.\n");

    const persistedThreadMessages = await getDb()
      .select({ content: messages.content })
      .from(messages)
      .where(eq(messages.channelId, thread.id));
    assert.deepEqual(persistedThreadMessages.map((message) => message.content), [threadContent]);
  } finally {
    for (const cleanup of cleanups) cleanup();
    await app.close();
  }
});

test("agent internal route can unfollow a followed thread without parent membership", async ({ app }) => {
  const { server, machine, apiKey, channel, owner } = await seed();
  const listener = await createAgent(server.id, "thread-listener", { runtime: "claude" });
  await assignMachine(listener.id, machine.id);
  const { thread } = await createFollowedThread(channel.id, owner.id, listener.id);
  assert.equal(await isAgentFollowingThread(thread.id, listener.id), true);
  assert.equal(await isAgentInChannel(channel.id, listener.id), false);

  const res = await fetch(`${app.baseUrl}/internal/agent/${listener.id}/threads/unfollow`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ thread: thread.id }),
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  assert.equal(await isAgentFollowingThread(thread.id, listener.id), false);
  assert.equal(await isAgentInChannel(channel.id, listener.id), false);
});

test("agent internal route rejects non-thread unfollow targets", async ({ app }) => {
  const { agent, apiKey } = await seed();
  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/threads/unfollow`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ thread: "#focus-room" }),
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status}`);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /Target must be a thread/);
});

test("agent internal route can join a visible public channel", async ({ app }) => {
  const db = getDb();
  const { agent, apiKey, joinOnlyChannel } = await seed();
  const events = installFakeIo(app.app);
  const deliveries: Array<{ agentId: string; message: { content: string; sender_type: string; seq?: number } }> = [];
  const agentOrchestrator = app.app.get("agentOrchestrator") as {
    deliverMessage: (agentId: string, message: { content: string; sender_type: string; seq?: number }) => Promise<void>;
  };
  agentOrchestrator.deliverMessage = async (agentId, message) => {
    deliveries.push({ agentId, message });
  };
  assert.equal(await isAgentInChannel(joinOnlyChannel.id, agent.id), false);

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels/${joinOnlyChannel.id}/join`, {
    method: "POST",
    headers: machineHeaders(apiKey),
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  assert.equal(await isAgentInChannel(joinOnlyChannel.id, agent.id), true);
  const [systemMessage] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.channelId, joinOnlyChannel.id), eq(messages.messageType, "system")))
    .orderBy(desc(messages.createdAt));
  assert.ok(systemMessage, "expected a persistent self-join system message");
  assert.equal(systemMessage.content, "@channel-agent joined this channel.");
  assert.equal(systemMessage.senderId, "system");

  const delivery = deliveries.find((item) => item.agentId === agent.id);
  assert.ok(delivery, "joining agent should receive the channel system message");
  assert.equal(delivery.message.sender_type, "system");
  assert.equal(delivery.message.content, "@channel-agent joined this channel.");
  assert.ok(delivery.message.seq, "delivery should carry the persisted message seq");
  assert.deepEqual(events.at(-1), {
    room: `server:${agent.serverId}`,
    event: "channel:members-updated",
    payload: { channelId: joinOnlyChannel.id },
  });
});

test("CLI e2e: slock channel join adds agent to a visible public channel", async ({ app }) => {

  let cleanupProfile: (() => void) | undefined;
  try {
    const { agent, joinOnlyChannel, server } = await seed();
    const agentProfile = await createAgentProfileEnv(app.baseUrl, server.id, agent.id);
    cleanupProfile = agentProfile.cleanup;
    assert.equal(await isAgentInChannel(joinOnlyChannel.id, agent.id), false);

    const { stdout, stderr } = await runSlockCli(
      ["channel", "join", "--target", "#join-public"],
      agentProfile.env,
    );

    assert.equal(stderr, "");
    assert.equal(
      stdout,
      [
        "Joined #join-public. You can now send messages there and receive ordinary channel delivery.",
        "Still arrives:",
        "- Personal @mentions still reach you even if you later mute ordinary channel updates.",
        "- Threads you started or follow stay followed even if you later mute this channel.",
        "",
      ].join("\n"),
    );
    assert.equal(await isAgentInChannel(joinOnlyChannel.id, agent.id), true);
  } finally {
    cleanupProfile?.();
    await app.close();
  }
});

test("agent internal route allows the member role's createChannels capability", async ({ app }) => {
  const { agent, apiKey } = await seed();

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ name: "agent-member-can-create" }),
  });

  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = (await res.json()) as { name?: string; createdByAgentId?: string };
  assert.equal(body.name, "agent-member-can-create");
  assert.equal(body.createdByAgentId, agent.id);
});

test("agent channel create denial names the createChannels capability", async ({ app }) => {
  const { agent, apiKey, server } = await seed();
  await getDb()
    .delete(serverAgentMembers)
    .where(and(eq(serverAgentMembers.serverId, server.id), eq(serverAgentMembers.agentId, agent.id)));

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ name: "agent-without-server-membership" }),
  });

  assert.equal(res.status, 403, `expected 403, got ${res.status}`);
  assert.deepEqual(await res.json(), {
    error: "Agent requires createChannels capability to create channels",
  });
});

test("agent internal route creates channel for agent admin and joins creator agent", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const { agent, apiKey, server, owner } = await seed();
  await setAgentServerRole(server.id, agent.id, "admin");
  const events = installFakeIo(app.app);

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({
      name: "#agent-admin-room",
      description: "Created by an agent admin",
      visibility: "public",
    }),
  });

  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = (await res.json()) as { id: string; name: string; type: string; joined: boolean; createdByAgentId: string };
  assert.equal(body.name, "agent-admin-room");
  assert.equal(body.type, "channel");
  assert.equal(body.joined, true);
  assert.equal(body.createdByAgentId, agent.id);
  assert.equal(await isAgentInChannel(body.id, agent.id), true);
  assert.ok(events.some((event) => event.room === `user:${owner.id}` && event.event === "channel:updated"));

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/internal/agent/:id/channels"
  );
  assert.ok(span, "expected agent channel create request span");
  const traceEvents = new Map(span.events.map((event) => [event.name, event]));
  assert.equal(traceEvents.get("agent_channel_create.request.started")?.attrs?.actor_server_match, true);
  assert.equal(traceEvents.get("agent_channel_create.authorization.checked")?.attrs?.outcome, "allowed");
  assert.equal(traceEvents.get("agent_channel_create.authorization.checked")?.attrs?.required_capability, "createChannels");
  assert.equal(traceEvents.get("agent_channel_create.created")?.attrs?.visibility, "public");
  assert.equal(traceEvents.get("agent_channel_create.created")?.attrs?.creator_joined, true);
  assert.equal(traceEvents.get("agent_channel_create.broadcasted")?.attrs?.visibility, "public");
  assert.equal(span.events.some((event) => Object.values(event.attrs ?? {}).includes(agent.id)), false);
});

test("agent internal route updates a regular channel for agent admin", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const { agent, apiKey, server, channel } = await seed();
  await setAgentServerRole(server.id, agent.id, "admin");
  const events = installFakeIo(app.app);

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels/${channel.id}`, {
    method: "PATCH",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({
      name: "#renamed-focus",
      description: "Renamed by agent admin",
      visibility: "private",
    }),
  });

  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = (await res.json()) as { id: string; name: string; type: string; description: string | null };
  assert.equal(body.id, channel.id);
  assert.equal(body.name, "renamed-focus");
  assert.equal(body.description, "Renamed by agent admin");
  assert.equal(body.type, "private");
  assert.ok(!events.some((event) => event.event === "channel:updated"), "no connected human belongs to this private channel");

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/internal/agent/:id/channels/:channelId"
  );
  assert.ok(span, "expected agent channel update request span");
  const traceEvents = new Map(span.events.map((event) => [event.name, event]));
  assert.equal(traceEvents.get("agent_channel_update.authorization.checked")?.attrs?.outcome, "allowed");
  assert.equal(traceEvents.get("agent_channel_update.updated")?.attrs?.renamed, true);
  assert.equal(traceEvents.get("agent_channel_update.updated")?.attrs?.visibility_changed, true);
  assert.equal(traceEvents.get("agent_channel_update.updated")?.attrs?.channel_visibility, "private");
  assert.equal(span.events.some((event) => Object.values(event.attrs ?? {}).includes(agent.id)), false);
});

test("agent without server membership gets an exact addChannelMembers denial", async ({ app }) => {
  const { agent, apiKey, server, owner, channel } = await seed();
  await getDb().delete(serverAgentMembers).where(and(
    eq(serverAgentMembers.serverId, server.id),
    eq(serverAgentMembers.agentId, agent.id),
  ));

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels/${channel.id}/members`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ user: owner.name }),
  });

  assert.equal(res.status, 403, `expected 403, got ${res.status}`);
  const body = (await res.json()) as { error?: string };
  assert.equal(body.error, "Agent requires addChannelMembers capability to add channel members");
});

test("agent mutation denials name their exact server capabilities", async ({ app }) => {
  const { agent, apiKey, owner, channel } = await seed();
  await channelService.addHuman(channel.id, owner.id);

  const updateChannel = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels/${channel.id}`, {
    method: "PATCH",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ name: "#member-agent-cannot-rename" }),
  });
  assert.equal(updateChannel.status, 403, `expected 403, got ${updateChannel.status}`);
  assert.equal(
    ((await updateChannel.json()) as { error?: string }).error,
    "Agent requires editChannelMetadata or changeChannelVisibility capability to update channels",
  );

  const removeMember = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels/${channel.id}/members`, {
    method: "DELETE",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ user: owner.name }),
  });
  assert.equal(removeMember.status, 403, `expected 403, got ${removeMember.status}`);
  assert.equal(
    ((await removeMember.json()) as { error?: string }).error,
    "Agent requires removeChannelMembers capability to remove channel members",
  );
  assert.equal(await isHumanInChannel(channel.id, owner.id), true);

  const updateServer = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/server`, {
    method: "PATCH",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ name: "Member Agent Rename Attempt" }),
  });
  assert.equal(updateServer.status, 403, `expected 403, got ${updateServer.status}`);
  assert.equal(
    ((await updateServer.json()) as { error?: string }).error,
    "Agent requires editServerSettings capability to edit the server profile",
  );
});

test("agent internal route lets a member agent add a human member by handle", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const { agent, apiKey, server, owner } = await seed();
  const privateChannel = await channelService.createChannel(server.id, "agent-admin-private-add", "Private add-member target", "private");
  await channelService.addAgent(privateChannel.id, agent.id);
  const events = installFakeIo(app.app);

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels/${privateChannel.id}/members`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ user: `@${owner.name}` }),
  });

  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = (await res.json()) as { ok?: boolean; alreadyMember?: boolean; member?: { type?: string; name?: string } };
  assert.equal(body.ok, true);
  assert.equal(body.alreadyMember, false);
  assert.equal(body.member?.type, "human");
  assert.equal(body.member?.name, owner.name);
  assert.equal(await isHumanInChannel(privateChannel.id, owner.id), true);
  assert.ok(events.some((event) => event.room === `channel:${privateChannel.id}` && event.event === "channel:members-updated"));
  assert.ok(events.some((event) => event.room === `user:${owner.id}` && event.event === "channel:updated"));

  const [systemMessage] = await getDb()
    .select()
    .from(messages)
    .where(and(eq(messages.channelId, privateChannel.id), eq(messages.messageType, "system")))
    .orderBy(desc(messages.createdAt));
  assert.ok(systemMessage, "agent-driven human membership should create a persistent system message");
  assert.equal(systemMessage.content, `@${owner.name} was added to this channel.`);
  const facts = await getDb()
    .select()
    .from(inboxNotificationFacts)
    .where(eq(inboxNotificationFacts.messageId, systemMessage.id));
  const actorFact = facts.find((fact) => fact.receiverType === "agent" && fact.receiverId === agent.id);
  const targetFact = facts.find((fact) => fact.receiverType === "user" && fact.receiverId === owner.id);
  assert.equal(actorFact?.unreadEligible, false, "the acting agent's membership notice should be born-read");
  assert.equal(targetFact?.unreadEligible, true, "the added human should receive the membership notice unread");

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/internal/agent/:id/channels/:channelId/members"
  );
  assert.ok(span, "expected agent channel add-member request span");
  const traceEvents = new Map(span.events.map((event) => [event.name, event]));
  assert.equal(traceEvents.get("agent_channel_member_add.request.started")?.attrs?.actor_server_match, true);
  assert.equal(traceEvents.get("agent_channel_member_add.authorization.checked")?.attrs?.outcome, "allowed");
  assert.equal(traceEvents.get("agent_channel_member_add.authorization.checked")?.attrs?.required_capability, "addChannelMembers");
  assert.equal(traceEvents.get("agent_channel_member_add.added")?.attrs?.target_type, "human");
  assert.equal(traceEvents.get("agent_channel_member_add.added")?.attrs?.channel_visibility, "private");
  assert.equal(traceEvents.get("agent_channel_member_add.broadcasted")?.attrs?.target_type, "human");
  const routeEvents = span.events.filter((event) => event.name.startsWith("agent_channel_member_add."));
  assert.equal(routeEvents.some((event) => Object.values(event.attrs ?? {}).includes(agent.id)), false);
  assert.equal(routeEvents.some((event) => Object.values(event.attrs ?? {}).includes(owner.id)), false);
});

test("agent-admin human add rolls membership back on notice failure and retry repairs it", async ({ app }) => {

  try {
    const { agent, apiKey, server, owner } = await seed();
    await setAgentServerRole(server.id, agent.id, "admin");
    const channel = await channelService.createChannel(
      server.id,
      "agent-admin-human-add-repair",
      "Atomic human membership notice repair",
      "private",
    );
    await channelService.addAgent(channel.id, agent.id);
    const addMemberRequest = () => fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels/${channel.id}/members`, {
      method: "POST",
      headers: machineHeaders(apiKey),
      body: JSON.stringify({ user: `@${owner.name}` }),
    });

    let failNextMessage = true;
    __setMessageServiceDepsForTests({
      createMessage: async (...args) => {
        if (failNextMessage) {
          failNextMessage = false;
          throw new Error("injected agent membership notice persistence failure");
        }
        return createMessage(...args);
      },
      recordInboxNotificationFacts,
    });
    try {
      const first = await addMemberRequest();
      assert.equal(first.status, 500);
      assert.equal(
        await isHumanInChannel(channel.id, owner.id),
        false,
        "notice failure must not strand committed membership before retry",
      );
      assert.equal(
        (await getDb().select().from(messages).where(and(
          eq(messages.channelId, channel.id),
          eq(messages.messageType, "system"),
        ))).length,
        0,
      );

      const retry = await addMemberRequest();
      assert.equal(retry.status, 200);
      const retryBody = await retry.json() as { alreadyMember?: boolean };
      assert.equal(retryBody.alreadyMember, false, "rolled-back first attempt must retry as the completing add");
      assert.equal(await isHumanInChannel(channel.id, owner.id), true);
      const repairedMessages = await getDb().select().from(messages).where(and(
        eq(messages.channelId, channel.id),
        eq(messages.messageType, "system"),
      ));
      assert.equal(repairedMessages.length, 1, "retry must persist exactly one repaired membership notice");
      assert.equal(repairedMessages[0]?.content, `@${owner.name} was added to this channel.`);

      const replay = await addMemberRequest();
      assert.equal(replay.status, 200);
      const replayBody = await replay.json() as { alreadyMember?: boolean };
      assert.equal(replayBody.alreadyMember, true);
      assert.equal(
        (await getDb().select({ id: messages.id }).from(messages).where(and(
          eq(messages.channelId, channel.id),
          eq(messages.messageType, "system"),
        ))).length,
        1,
      );
    } finally {
      __resetMessageServiceDepsForTests();
    }
  } finally {
    __resetMessageServiceDepsForTests();
    await app.close();
  }
});

test("agent internal route sends a targeted channel update when adding owner to public channel", async ({ app }) => {
  const { agent, apiKey, server, owner } = await seed();
  await setAgentServerRole(server.id, agent.id, "admin");
  const publicChannel = await channelService.createChannel(server.id, "agent-admin-public-add", "Public add-member target", "channel");
  await channelService.addAgent(publicChannel.id, agent.id);
  const events = installFakeIo(app.app);

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels/${publicChannel.id}/members`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ user: `@${owner.name}` }),
  });

  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  assert.equal(await isHumanInChannel(publicChannel.id, owner.id), true);
  assert.ok(events.some((event) => event.room === `server:${server.id}` && event.event === "channel:members-updated"));
  assert.ok(events.some((event) =>
    event.room === `user:${owner.id}`
    && event.event === "channel:updated"
    && (event.payload as { channel?: { id?: string; joined?: boolean } }).channel?.id === publicChannel.id
    && (event.payload as { channel?: { id?: string; joined?: boolean } }).channel?.joined === true
  ));
});

test("agent internal route removes a human member by handle for agent admin", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const { agent, apiKey, server, owner, channel } = await seed();
  await setAgentServerRole(server.id, agent.id, "admin");
  await channelService.addHuman(channel.id, owner.id);
  const events = installFakeIo(app.app);

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels/${channel.id}/members`, {
    method: "DELETE",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ user: `@${owner.name}` }),
  });

  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = (await res.json()) as {
    ok?: boolean;
    wasMember?: boolean;
    member?: { type?: string; name?: string };
    attention?: { stillArrives?: string[]; threadBoundary?: string; manageCommand?: string };
  };
  assert.equal(body.ok, true);
  assert.equal(body.wasMember, true);
  assert.equal(body.member?.type, "human");
  assert.equal(body.member?.name, owner.name);
  assert.ok(
    body.attention?.stillArrives?.some((line) => /followed threads still notify/.test(line)),
    "remove-member should warn that public followed threads can still notify",
  );
  assert.match(body.attention?.threadBoundary ?? "", /does not unfollow existing thread follows/);
  assert.match(body.attention?.threadBoundary ?? "", /Private channel\/thread content still requires current parent access/);
  assert.match(body.attention?.manageCommand ?? "", /raft thread unfollow/);
  assert.equal(await isHumanInChannel(channel.id, owner.id), false);
  assert.ok(events.some((event) => event.room === `server:${server.id}` && event.event === "channel:members-updated"));

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/internal/agent/:id/channels/:channelId/members"
    && candidate.events.some((event) => event.name === "agent_channel_member_remove.removed")
  );
  assert.ok(span, "expected agent channel remove-member request span");
  const traceEvents = new Map(span.events.map((event) => [event.name, event]));
  assert.equal(traceEvents.get("agent_channel_member_remove.authorization.checked")?.attrs?.outcome, "allowed");
  assert.equal(traceEvents.get("agent_channel_member_remove.removed")?.attrs?.target_type, "human");
  assert.equal(traceEvents.get("agent_channel_member_remove.removed")?.attrs?.was_member, true);
  assert.equal(span.events.some((event) => Object.values(event.attrs ?? {}).includes(agent.id)), false);
  assert.equal(span.events.some((event) => Object.values(event.attrs ?? {}).includes(owner.id)), false);
});

test("agent internal route updates server profile for agent admin", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const { agent, apiKey, server } = await seed();
  await setAgentServerRole(server.id, agent.id, "admin");

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/server`, {
    method: "PATCH",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ name: "Renamed Server" }),
  });

  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = (await res.json()) as { id: string; name: string };
  assert.equal(body.id, server.id);
  assert.equal(body.name, "Renamed Server");
  const [stored] = await getDb()
    .select({ name: servers.name })
    .from(servers)
    .where(eq(servers.id, server.id));
  assert.equal(stored?.name, "Renamed Server");

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/internal/agent/:id/server"
    && candidate.events.some((event) => event.name === "agent_server_profile.updated")
  );
  assert.ok(span, "expected agent server profile update request span");
  const traceEvents = new Map(span.events.map((event) => [event.name, event]));
  assert.equal(traceEvents.get("agent_server_profile.authorization.checked")?.attrs?.outcome, "allowed");
  assert.equal(traceEvents.get("agent_server_profile.updated")?.attrs?.renamed, true);
  assert.equal(span.events.some((event) => Object.values(event.attrs ?? {}).includes(agent.id)), false);
});

test("CLI e2e: slock channel create creates private channel for agent admin", async ({ app }) => {

  const profile = { cleanup: () => {} };
  try {
    const { agent, server } = await seed();
    const agentProfile = await createAgentProfileEnv(app.baseUrl, server.id, agent.id);
    profile.cleanup = agentProfile.cleanup;
    await setAgentServerRole(server.id, agent.id, "admin");

    const { stdout, stderr } = await runSlockCli(
      ["channel", "create", "--name", "#agent-cli-room", "--private", "--description", "CLI created"],
      agentProfile.env,
    );

    assert.equal(stderr, "");
    assert.equal(stdout, "Created #agent-cli-room (private). You are joined and can send messages there.\n");
    const [created] = await getDb()
      .select({ id: channels.id, type: channels.type })
      .from(channels)
      .where(and(eq(channels.serverId, server.id), eq(channels.name, "agent-cli-room")));
    assert.ok(created, "expected channel to be created");
    assert.equal(created.type, "private");
    assert.equal(await isAgentInChannel(created.id, agent.id), true);
  } finally {
    profile.cleanup();
    await app.close();
  }
});

test("CLI e2e: slock channel update edits a joined channel for agent admin", async ({ app }) => {

  const profile = { cleanup: () => {} };
  try {
    const { agent, server, channel } = await seed();
    const agentProfile = await createAgentProfileEnv(app.baseUrl, server.id, agent.id);
    profile.cleanup = agentProfile.cleanup;
    await setAgentServerRole(server.id, agent.id, "admin");

    const { stdout, stderr } = await runSlockCli(
      ["channel", "update", "--target", "#focus-room", "--name", "#focus-renamed", "--private"],
      agentProfile.env,
    );

    assert.equal(stderr, "");
    assert.equal(stdout, "Updated #focus-renamed (private).\n");
    const [updated] = await getDb()
      .select({ name: channels.name, type: channels.type })
      .from(channels)
      .where(eq(channels.id, channel.id));
    assert.equal(updated?.name, "focus-renamed");
    assert.equal(updated?.type, "private");
  } finally {
    profile.cleanup();
    await app.close();
  }
});

test("CLI e2e: channel archive and unarchive enforce admin authority and restore writes", async ({ app }) => {

  const profile = { cleanup: () => {} };
  try {
    const { agent, server, channel, joinOnlyChannel, apiKey } = await seed();
    const agentProfile = await createAgentProfileEnv(app.baseUrl, server.id, agent.id);
    profile.cleanup = agentProfile.cleanup;

    await assertSlockCliFails(
      ["channel", "archive", "--target", "#focus-room"],
      agentProfile.env,
      /Agent requires archiveChannels capability to archive channels/,
    );
    await assertSlockCliFails(
      ["channel", "unarchive", "--target", "#focus-room"],
      agentProfile.env,
      /Agent requires archiveChannels capability to unarchive channels/,
    );
    const [afterDenied] = await getDb()
      .select({ archivedAt: channels.archivedAt })
      .from(channels)
      .where(eq(channels.id, channel.id));
    assert.equal(afterDenied?.archivedAt, null, "ordinary-member denial must leave channel active");

    await setAgentServerRole(server.id, agent.id, "admin");

    // Private targets stay visibility-gated even for an admin-role agent.
    await getDb().update(channels)
      .set({ type: "private" })
      .where(eq(channels.id, joinOnlyChannel.id));
    await assertSlockCliFails(
      ["channel", "archive", "--target", "#join-public"],
      agentProfile.env,
      /Channel not found/,
    );
    const [privateAfterOutsiderDenial] = await getDb()
      .select({ archivedAt: channels.archivedAt })
      .from(channels)
      .where(eq(channels.id, joinOnlyChannel.id));
    assert.equal(privateAfterOutsiderDenial?.archivedAt, null);

    await channelService.addAgent(joinOnlyChannel.id, agent.id);
    const privateArchive = await runSlockCli(
      ["channel", "archive", "--target", "#join-public"],
      agentProfile.env,
    );
    assert.equal(privateArchive.stderr, "");
    assert.equal(privateArchive.stdout, "Archived #join-public. The channel is read-only until unarchived.\n");
    const privateUnarchive = await runSlockCli(
      ["channel", "unarchive", "--target", "#join-public"],
      agentProfile.env,
    );
    assert.equal(privateUnarchive.stderr, "");
    assert.equal(privateUnarchive.stdout, "Unarchived #join-public. Messages and other writes are enabled again.\n");

    const archivedCli = await runSlockCli(
      ["channel", "archive", "--target", "#focus-room"],
      agentProfile.env,
    );
    assert.equal(archivedCli.stderr, "");
    assert.equal(archivedCli.stdout, "Archived #focus-room. The channel is read-only until unarchived.\n");
    const [archived] = await getDb()
      .select({
        archivedAt: channels.archivedAt,
        archivedByUserId: channels.archivedByUserId,
        archivedByAgentId: channels.archivedByAgentId,
      })
      .from(channels)
      .where(eq(channels.id, channel.id));
    assert.ok(archived?.archivedAt);
    assert.equal(archived?.archivedByUserId, null, "agent archive must not impersonate a human actor");
    assert.equal(archived?.archivedByAgentId, agent.id, "agent archive must retain durable actor provenance");

    const blockedSend = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/send`, {
      method: "POST",
      headers: machineHeaders(apiKey),
      body: JSON.stringify({ target: "#focus-room", content: "must stay blocked while archived" }),
    });
    assert.equal(blockedSend.status, 409);
    assert.equal((await blockedSend.json() as { code?: string }).code, "channel_archived");

    const unarchivedCli = await runSlockCli(
      ["channel", "unarchive", "--target", "#focus-room"],
      agentProfile.env,
    );
    assert.equal(unarchivedCli.stderr, "");
    assert.equal(unarchivedCli.stdout, "Unarchived #focus-room. Messages and other writes are enabled again.\n");
    const [unarchived] = await getDb()
      .select({
        archivedAt: channels.archivedAt,
        archivedByUserId: channels.archivedByUserId,
        archivedByAgentId: channels.archivedByAgentId,
      })
      .from(channels)
      .where(eq(channels.id, channel.id));
    assert.equal(unarchived?.archivedAt, null);
    assert.equal(unarchived?.archivedByUserId, null);
    assert.equal(unarchived?.archivedByAgentId, null);

    const restoredSend = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/send`, {
      method: "POST",
      headers: machineHeaders(apiKey),
      body: JSON.stringify({ target: "#focus-room", content: "writes restored after unarchive" }),
    });
    assert.equal(restoredSend.status, 200, await restoredSend.text());

  } finally {
    profile.cleanup();
    await app.close();
  }
});

test("agent channel lifecycle admits one transition under concurrent retries and born-reads the actor notice", async ({ app }) => {
  const { agent, server, channel, agentApiKey } = await seed();
  await setAgentServerRole(server.id, agent.id, "admin");
  const headers = {
    Authorization: `Bearer ${agentApiKey}`,
    "Content-Type": "application/json",
  };
  const request = (action: "archive" | "unarchive") => fetch(
    `${app.baseUrl}/internal/agent-api/channels/${action}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ target: "#focus-room" }),
    },
  );

  const archiveResponses = await Promise.all([request("archive"), request("archive")]);
  assert.deepEqual(archiveResponses.map((response) => response.status), [200, 200]);
  const archiveBodies = await Promise.all(archiveResponses.map((response) => response.json())) as Array<{
    archivedAt: string | null;
    archivedByAgentId: string | null;
  }>;
  assert.ok(archiveBodies.every((body) => typeof body.archivedAt === "string"));
  assert.ok(archiveBodies.every((body) => body.archivedByAgentId === agent.id));

  const archivedContent = `📦 ${agent.name} archived this channel`;
  await waitForChannelSystemMessageCount(channel.id, archivedContent, 1);
  const [archiveMessage] = await getDb()
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.channelId, channel.id), eq(messages.content, archivedContent)));
  assert.ok(archiveMessage);
  const [actorArchiveFact] = await getDb()
    .select({ unreadEligible: inboxNotificationFacts.unreadEligible })
    .from(inboxNotificationFacts)
    .where(and(
      eq(inboxNotificationFacts.messageId, archiveMessage.id),
      eq(inboxNotificationFacts.receiverType, "agent"),
      eq(inboxNotificationFacts.receiverId, agent.id),
    ));
  assert.equal(actorArchiveFact?.unreadEligible, false, "the causal agent's archive notice must be born-read");

  const unarchiveResponses = await Promise.all([request("unarchive"), request("unarchive")]);
  assert.deepEqual(unarchiveResponses.map((response) => response.status), [200, 200]);
  const unarchiveBodies = await Promise.all(unarchiveResponses.map((response) => response.json())) as Array<{
    archivedAt: string | null;
    archivedByAgentId: string | null;
  }>;
  assert.ok(unarchiveBodies.every((body) => body.archivedAt === null));
  assert.ok(unarchiveBodies.every((body) => body.archivedByAgentId === null));

  const unarchivedContent = `📤 ${agent.name} unarchived this channel`;
  await waitForChannelSystemMessageCount(channel.id, unarchivedContent, 1);
  const [unarchiveMessage] = await getDb()
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.channelId, channel.id), eq(messages.content, unarchivedContent)));
  assert.ok(unarchiveMessage);
  const [actorUnarchiveFact] = await getDb()
    .select({ unreadEligible: inboxNotificationFacts.unreadEligible })
    .from(inboxNotificationFacts)
    .where(and(
      eq(inboxNotificationFacts.messageId, unarchiveMessage.id),
      eq(inboxNotificationFacts.receiverType, "agent"),
      eq(inboxNotificationFacts.receiverId, agent.id),
    ));
  assert.equal(actorUnarchiveFact?.unreadEligible, false, "the causal agent's unarchive notice must be born-read");
});

test("CLI e2e: slock channel add-member adds a human to a joined channel for a member agent", async ({ app }) => {

  const profile = { cleanup: () => {} };
  try {
    const { agent, server, owner, channel } = await seed();
    const agentProfile = await createAgentProfileEnv(app.baseUrl, server.id, agent.id);
    profile.cleanup = agentProfile.cleanup;
    assert.equal(await isHumanInChannel(channel.id, owner.id), false);

    const { stdout, stderr } = await runSlockCli(
      ["channel", "add-member", "--target", "#focus-room", "--user", `@${owner.name}`],
      agentProfile.env,
    );

    assert.equal(stderr, "");
    assert.equal(stdout, `Added @${owner.name} to #focus-room as a user.\n`);
    assert.equal(await isHumanInChannel(channel.id, owner.id), true);
  } finally {
    profile.cleanup();
    await app.close();
  }
});

test("CLI e2e: slock channel remove-member removes a human from a joined channel for agent admin", async ({ app }) => {

  const profile = { cleanup: () => {} };
  try {
    const { agent, server, owner, channel } = await seed();
    const agentProfile = await createAgentProfileEnv(app.baseUrl, server.id, agent.id);
    profile.cleanup = agentProfile.cleanup;
    await setAgentServerRole(server.id, agent.id, "admin");
    await channelService.addHuman(channel.id, owner.id);
    assert.equal(await isHumanInChannel(channel.id, owner.id), true);

    const { stdout, stderr } = await runSlockCli(
      ["channel", "remove-member", "--target", "#focus-room", "--user", `@${owner.name}`],
      agentProfile.env,
    );

    assert.equal(stderr, "");
    assert.match(stdout, new RegExp(`Removed @${owner.name} from #focus-room\\.`));
    assert.match(stdout, /Still arrives:\n- If #focus-room is public, followed threads still notify/);
    assert.match(stdout, /Removing a channel member does not unfollow existing thread follows/);
    assert.equal(await isHumanInChannel(channel.id, owner.id), false);
  } finally {
    profile.cleanup();
    await app.close();
  }
});

test("CLI e2e: slock server update renames current server for agent admin", async ({ app }) => {

  const profile = { cleanup: () => {} };
  try {
    const { agent, server } = await seed();
    const agentProfile = await createAgentProfileEnv(app.baseUrl, server.id, agent.id);
    profile.cleanup = agentProfile.cleanup;
    await setAgentServerRole(server.id, agent.id, "admin");

    const { stdout, stderr } = await runSlockCli(
      ["server", "update", "--name", "CLI Renamed Server"],
      agentProfile.env,
    );

    assert.equal(stderr, "");
    assert.equal(stdout, "Updated server CLI Renamed Server.\n");
    const [updated] = await getDb()
      .select({ name: servers.name })
      .from(servers)
      .where(eq(servers.id, server.id));
    assert.equal(updated?.name, "CLI Renamed Server");
  } finally {
    profile.cleanup();
    await app.close();
  }
});

test("CLI e2e: member agent can create channels but other management mutations stay denied", async ({ app }) => {

  const profile = { cleanup: () => {} };
  try {
    const { agent, server, owner, channel } = await seed();
    const agentProfile = await createAgentProfileEnv(app.baseUrl, server.id, agent.id);
    profile.cleanup = agentProfile.cleanup;

    const memberCreate = await runSlockCli(
      ["channel", "create", "--name", "#member-cli-created"],
      agentProfile.env,
    );
    assert.equal(memberCreate.stderr, "");
    assert.match(memberCreate.stdout, /Created #member-cli-created/);
    const [createdByMember] = await getDb()
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.serverId, server.id), eq(channels.name, "member-cli-created")));
    assert.ok(createdByMember, "member-agent CLI create must persist the channel");
    assert.equal(await isAgentInChannel(createdByMember.id, agent.id), true);

    const memberAdd = await runSlockCli(
      ["channel", "add-member", "--target", "#focus-room", "--user", `@${owner.name}`],
      agentProfile.env,
    );
    assert.equal(memberAdd.stderr, "");
    assert.equal(memberAdd.stdout, `Added @${owner.name} to #focus-room as a user.\n`);
    assert.equal(await isHumanInChannel(channel.id, owner.id), true, "member-agent CLI add-member must add human");

    await assertSlockCliFails(
      ["channel", "update", "--target", "#focus-room", "--name", "#member-cli-renamed-denied"],
      agentProfile.env,
      /Agent requires editChannelMetadata or changeChannelVisibility capability to update channels/,
    );
    const [channelAfterDeniedUpdate] = await getDb()
      .select({ name: channels.name })
      .from(channels)
      .where(eq(channels.id, channel.id));
    assert.equal(channelAfterDeniedUpdate?.name, "focus-room", "member-agent CLI update denial must not rename channel");

    await assertSlockCliFails(
      ["channel", "remove-member", "--target", "#focus-room", "--user", `@${owner.name}`],
      agentProfile.env,
      /Agent requires removeChannelMembers capability to remove channel members/,
    );
    assert.equal(await isHumanInChannel(channel.id, owner.id), true, "member-agent CLI remove-member denial must preserve human");

    await assertSlockCliFails(
      ["server", "update", "--name", "Member CLI Rename Denied"],
      agentProfile.env,
      /Agent requires editServerSettings capability to edit the server profile/,
    );
    const [serverAfterDeniedUpdate] = await getDb()
      .select({ name: servers.name })
      .from(servers)
      .where(eq(servers.id, server.id));
    assert.equal(serverAfterDeniedUpdate?.name, "Internal Channel", "member-agent CLI server update denial must not rename server");
  } finally {
    profile.cleanup();
    await app.close();
  }
});

test("agent internal route cannot self-join private channels", async ({ app }) => {
  const { agent, apiKey, server } = await seed();
  const privateChannel = await channelService.createChannel(server.id, "agent-private-invite-only", undefined, "private");

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels/${privateChannel.id}/join`, {
    method: "POST",
    headers: machineHeaders(apiKey),
  });
  assert.equal(res.status, 403, `expected 403, got ${res.status}`);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /Private channels require an invitation/);
  assert.equal(await isAgentInChannel(privateChannel.id, agent.id), false);
});

test("agent internal route cannot self-join joint channels", async ({ app }) => {
  const { agent, apiKey, server } = await seed();
  const jointChannel = await channelService.createChannel(server.id, "agent-joint-invite-only", undefined, "joint");

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels/${jointChannel.id}/join`, {
    method: "POST",
    headers: machineHeaders(apiKey),
  });
  assert.equal(res.status, 403, `expected 403, got ${res.status}`);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /Joint channels require an invitation/);
  assert.equal(await isAgentInChannel(jointChannel.id, agent.id), false);
});

test("agent internal route cannot join archived public channels", async ({ app }) => {
  const { agent, apiKey, joinOnlyChannel, owner } = await seed();
  await channelService.archiveChannel(joinOnlyChannel.id, owner.id);

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels/${joinOnlyChannel.id}/join`, {
    method: "POST",
    headers: machineHeaders(apiKey),
  });
  assert.equal(res.status, 409, `expected 409, got ${res.status}`);
  const body = (await res.json()) as { code?: string; error?: string };
  assert.equal(body.code, "channel_archived");
  assert.equal(await isAgentInChannel(joinOnlyChannel.id, agent.id), false);
});

test("agent reactions cloak private message existence from non-member agents", async ({ app }) => {
  const { server, agent, machine, apiKey, owner } = await seed();
  const outsiderAgent = await createAgent(server.id, "reaction-outsider-agent", { runtime: "claude" });
  await assignMachine(outsiderAgent.id, machine.id);
  const privateChannel = await channelService.createChannel(server.id, "agent-reaction-private", undefined, "private");
  await channelService.addAgent(privateChannel.id, agent.id);
  const chatMessage = await createMessage(privateChannel.id, "user", owner.id, "private agent reaction target");
  const systemMessage = await createMessage(privateChannel.id, "user", "system", "private system event", "system");
  const headers = machineHeaders(apiKey);

  const addChat = await fetch(`${app.baseUrl}/internal/agent/${outsiderAgent.id}/messages/${chatMessage.id}/reactions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ emoji: "👀" }),
  });
  assert.equal(addChat.status, 404, `expected private add 404, got ${addChat.status}`);

  const removeChat = await fetch(`${app.baseUrl}/internal/agent/${outsiderAgent.id}/messages/${chatMessage.id}/reactions`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ emoji: "👀" }),
  });
  assert.equal(removeChat.status, 404, `expected private remove 404, got ${removeChat.status}`);

  const addSystem = await fetch(`${app.baseUrl}/internal/agent/${outsiderAgent.id}/messages/${systemMessage.id}/reactions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ emoji: "👀" }),
  });
  assert.equal(addSystem.status, 404, `expected private system add 404, got ${addSystem.status}`);
});

test("agent internal task mutations require parent channel membership even when public channel is readable", async ({ app }) => {
  const { agent, apiKey, joinOnlyChannel, owner } = await seed();
  assert.equal(await isAgentInChannel(joinOnlyChannel.id, agent.id), false);
  const { tasks: [task] } = await taskService.createTasks(joinOnlyChannel.id, "user", owner.id, [{ title: "visible but read-only task" }]);

  const listRes = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/tasks?channel=${encodeURIComponent("#join-public")}`, {
    headers: machineHeaders(apiKey),
  });
  assert.equal(listRes.status, 200, `expected list 200, got ${listRes.status}`);
  const listBody = await listRes.json() as { tasks: Array<{ messageId: string }> };
  assert.equal(listBody.tasks.some((candidate) => candidate.messageId === task.messageId), true);

  const claimRes = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/tasks/claim`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ channel: "#join-public", task_numbers: [task.taskNumber] }),
  });
  assert.equal(claimRes.status, 403, `expected claim 403, got ${claimRes.status}`);

  const updateRes = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/tasks/update-status`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ channel: "#join-public", task_number: task.taskNumber, status: "in_progress" }),
  });
  assert.equal(updateRes.status, 403, `expected update 403, got ${updateRes.status}`);

  const createRes = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/tasks`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ channel: "#join-public", tasks: [{ title: "should not create" }] }),
  });
  assert.equal(createRes.status, 403, `expected create 403, got ${createRes.status}`);
});

test("agent resolves, creates, and claims joint tasks through its local projection", async ({ app }) => {
  const { server: peerServer, agent: peerAgent, apiKey, owner: peerOwner } = await seed();
  const db = getDb();
  const [hostOwner] = await db
    .insert(users)
    .values({
      email: "internal-joint-host@slock.test",
      name: "internal-joint-host",
      displayName: "Joint Host",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
    })
    .returning();
  const hostServer = await createServer("Internal Joint Host", "internal-joint-host", hostOwner.id);
  const canonical = await channelService.createChannel(hostServer.id, "joint-storage-internal", undefined, "channel");
  const hostProjection = await channelService.createChannel(hostServer.id, "botiverse-scopedb", undefined, "joint");
  const peerProjection = await channelService.createChannel(peerServer.id, "botiverse-scopedb", undefined, "joint");
  await channelService.addHuman(hostProjection.id, hostOwner.id);
  await channelService.addHuman(peerProjection.id, peerOwner.id);
  await channelService.addAgent(peerProjection.id, peerAgent.id);

  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: joint.id,
      serverId: hostServer.id,
      localChannelId: hostProjection.id,
      role: "host",
      joinedByUserId: hostOwner.id,
    },
    {
      jointChannelId: joint.id,
      serverId: peerServer.id,
      localChannelId: peerProjection.id,
      role: "participant",
      joinedByUserId: peerOwner.id,
    },
  ]);

  const message = await createMessage(canonical.id, "user", hostOwner.id, "joint task candidate");

  const resolveRes = await fetch(`${app.baseUrl}/internal/agent/${peerAgent.id}/messages/${message.id.slice(0, 8)}/resolve`, {
    headers: machineHeaders(apiKey),
  });
  assert.equal(resolveRes.status, 200, `expected resolve 200, got ${resolveRes.status}`);
  const resolveBody = await resolveRes.json() as { message: { message_id: string; channel_name: string; content: string } };
  assert.equal(resolveBody.message.message_id, message.id);
  assert.equal(resolveBody.message.channel_name, peerProjection.name);
  assert.equal(resolveBody.message.content, "joint task candidate");

  const claimRes = await fetch(`${app.baseUrl}/internal/agent/${peerAgent.id}/tasks/claim`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ channel: "#botiverse-scopedb", message_ids: [message.id.slice(0, 8)] }),
  });
  assert.equal(claimRes.status, 200, `expected joint claim 200, got ${claimRes.status}`);
  const claimBody = await claimRes.json() as {
    results: Array<{ messageId?: string; success: boolean; taskNumber?: number }>;
  };
  assert.deepEqual(claimBody.results.map((result) => result.success), [true]);
  const claimedTask = await taskService.getTaskByMessageId(message.id);
  assert.ok(claimedTask, "claim should create one canonical task");
  assert.equal(claimedTask.channelId, canonical.id);
  assert.equal(claimedTask.claimedById, peerAgent.id);

  const createRes = await fetch(`${app.baseUrl}/internal/agent/${peerAgent.id}/tasks`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ channel: "#botiverse-scopedb", tasks: [{ title: "joint task" }] }),
  });
  assert.equal(createRes.status, 200, `expected joint create 200, got ${createRes.status}`);
  const createBody = await createRes.json() as { tasks: Array<{ id: string; channelId: string }> };
  assert.equal(createBody.tasks.length, 1);
  assert.equal(createBody.tasks[0]!.channelId, peerProjection.id, "response must stay on the requester's local surface");
  const createdTask = await taskService.resolveTaskById(createBody.tasks[0]!.id);
  assert.ok(createdTask, "created task should persist once");
  assert.equal(createdTask.row.channelId, canonical.id);
});

test("GET /agent/:id/tasks validates the ?status filter", async ({ app }) => {
  const { agent, apiKey } = await seed();
  const base = `${app.baseUrl}/internal/agent/${agent.id}/tasks?channel=${encodeURIComponent("#join-public")}`;

  // A valid task status is accepted.
  const ok = await fetch(`${base}&status=in_progress`, { headers: machineHeaders(apiKey) });
  assert.equal(ok.status, 200, `expected 200 for valid status, got ${ok.status}`);

  // An unknown status is rejected (was silently passed through as `any`).
  const bad = await fetch(`${base}&status=bogus`, { headers: machineHeaders(apiKey) });
  assert.equal(bad.status, 400, `expected 400 for invalid status, got ${bad.status}`);
  const badBody = await bad.json() as { error: string };
  assert.equal(badBody.error, "Invalid status value");

  // A repeated ?status param (Express parses to an array) must also fail
  // closed — a present non-string value can't bypass the filter validation.
  const repeated = await fetch(`${base}&status=todo&status=bogus`, { headers: machineHeaders(apiKey) });
  assert.equal(repeated.status, 400, `expected 400 for repeated/array status, got ${repeated.status}`);
});

test("agent internal route cannot leave #all", async ({ app }) => {
  const { agent, apiKey, allChannel } = await seed();
  assert.ok(allChannel);
  assert.equal(await isAgentInChannel(allChannel.id, agent.id), false, "virtual #all must not persist agent membership rows");

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels/${allChannel.id}/leave`, {
    method: "POST",
    headers: machineHeaders(apiKey),
  });
  assert.equal(res.status, 403, `expected 403, got ${res.status}`);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /#all channel/);
  assert.equal(await isAgentInChannel(allChannel.id, agent.id), false);
});
