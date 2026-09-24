import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { agentMigrations, agents, channelAgents, channelHumans, channels, featureFlagRules, messages, serverMembers, threadFollows, users } from "../db/schema.js";
import { assignMachine, createAgent } from "../services/agentService.js";
import { addAgent, addHuman, createChannel, getOrCreateThread, removeHuman } from "../services/channelService.js";
import { ActionCardError, markActionCardExecuted, prepareActionCard } from "../services/actionCardsService.js";
import { asServerId } from "@botiverse/raft-shared";
import { AGENT_MIGRATION_FEATURE_FLAG_KEY } from "../services/featureFlagService.js";
import { registerMachine } from "../services/machineService.js";
import { createMessage, getMaxSeq } from "../services/messageService.js";
import { createServer } from "../services/serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}



function authHeaders(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Server-Id": serverId,
  };
}

async function enableMigrationFlag(serverId: string) {
  const db = getDb();
  await db.insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: AGENT_MIGRATION_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [serverId],
  });
}

async function prepareMigrationCard(args: {
  baseUrl: string;
  token: string;
  serverId: string;
  agentId: string;
  targetComputer: string;
}) {
  const res = await fetch(`${args.baseUrl}/api/actions/migration-export`, {
    method: "POST",
    headers: authHeaders(args.token, args.serverId),
    body: JSON.stringify({
      agentId: args.agentId,
      targetComputer: args.targetComputer,
      mode: "cooperative",
    }),
  });
  const text = await res.text();
  return { res, text };
}

async function seedMigrationRouteScenario(args: {
  slug: string;
  enableFlag?: boolean;
  assignSourceMachine?: boolean;
}) {
  const db = getDb();
  const owner = await seedUser(`${args.slug}-owner@slock.test`, `${args.slug}-owner`);
  const member = await seedUser(`${args.slug}-member@slock.test`, `${args.slug}-member`);
  const server = await createServer(`Migration ${args.slug}`, `migration-${args.slug}`, owner.id);
  await db.insert(serverMembers).values({
    serverId: server.id,
    userId: member.id,
    role: "member",
  }).onConflictDoNothing();
  if (args.enableFlag !== false) {
    await enableMigrationFlag(server.id);
  }
  const short = args.slug.slice(0, 8);
  const source = await registerMachine(server.id, owner.id, `${short}-source-computer`);
  const target = await registerMachine(server.id, owner.id, `${short}-target-computer`);
  const agent = await createAgent(server.id, `${short}-agent`, { runtime: "codex" });
  if (args.assignSourceMachine !== false) {
    await assignMachine(agent.id, source.machine.id);
  } else {
    await db.update(agents).set({ machineId: null }).where(eq(agents.id, agent.id));
    agent.machineId = null;
  }
  return { owner, member, server, source: source.machine, target: target.machine, agent };
}

interface EmittedEvent {
  room: string;
  event: string;
  payload: unknown;
}

function installFakeIo(): { io: any; events: EmittedEvent[] } {
  const events: EmittedEvent[] = [];
  const makeRoomChain = (rooms: string[]) => ({
    in(room: string) {
      return makeRoomChain([...rooms, room]);
    },
    socketsJoin(room: string) {
      events.push({ room: rooms.join(" "), event: "socketsJoin", payload: { room } });
    },
  });
  return {
    events,
    io: {
      to(room: string) {
        return {
          emit(event: string, payload: unknown) {
            events.push({ room, event, payload });
          },
        };
      },
      in(room: string) {
        return makeRoomChain([room]);
      },
    },
  };
}

test("action card execute and mark-executed cloak private carrier messages from non-members", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("private-card-owner@slock.test", "private-card-owner");
  const outsider = await seedUser("private-card-outsider@slock.test", "private-card-outsider");
  const server = await createServer("Private Action Card Server", "private-action-card-server", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: outsider.id, role: "member" }).onConflictDoNothing();
  const agent = await createAgent(server.id, "private-card-agent", { runtime: "codex" });
  const privateChannel = await createChannel(server.id, "private-card-channel", undefined, "private");
  await addHuman(privateChannel.id, owner.id);
  await addAgent(privateChannel.id, agent.id);

  const card = await prepareActionCard({
    serverId: asServerId(server.id),
    requesterAgentId: agent.id,
    targetChannelId: privateChannel.id,
    action: {
      type: "channel:create",
      name: "private-card-created-channel",
      visibility: "public",
    },
  });

  const outsiderToken = await tokenForHuman(outsider.email);
  const outsiderHeaders = authHeaders(outsiderToken, server.id);

  const executeRes = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/execute`, {
    method: "POST",
    headers: outsiderHeaders,
    body: JSON.stringify({ expectedState: "prepared" }),
  });
  assert.equal(executeRes.status, 404, `expected outsider execute 404, got ${executeRes.status}`);

  const markRes = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/mark-executed`, {
    method: "POST",
    headers: outsiderHeaders,
    body: JSON.stringify({
      result: { kind: "channel", id: privateChannel.id, name: "fake-result" },
    }),
  });
  assert.equal(markRes.status, 404, `expected outsider mark-executed 404, got ${markRes.status}`);
});

test("public channel read access does not grant action-card write authority", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("public-card-owner@slock.test", "public-card-owner");
  const reader = await seedUser("public-card-reader@slock.test", "public-card-reader");
  const server = await createServer("Public Action Card", `public-action-card-${randomUUID()}`, owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: reader.id, role: "member" });
  const agent = await createAgent(server.id, `public-card-agent-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  const carrier = await createChannel(server.id, "public-card-carrier", undefined, "channel", { type: "user", id: owner.id });
  await addAgent(carrier.id, agent.id);
  const card = await prepareActionCard({
    serverId: asServerId(server.id),
    requesterAgentId: agent.id,
    targetChannelId: carrier.id,
    action: { type: "channel:create", name: "must-not-exist", visibility: "public" },
  });
  const token = await tokenForHuman(reader.email);
  const requestHeaders = authHeaders(token, server.id);

  const execute = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/execute`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ expectedState: "prepared" }),
  });
  assert.equal(execute.status, 403);
  const mark = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/mark-executed`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ result: { kind: "channel", id: carrier.id, name: "fake" } }),
  });
  assert.equal(mark.status, 403);

  const [carrierMessage] = await db.select({ actionMetadata: messages.actionMetadata })
    .from(messages)
    .where(eq(messages.id, card.messageId));
  assert.equal((carrierMessage?.actionMetadata as { state?: string } | null)?.state, "prepared");
  const [created] = await db.select({ id: channels.id }).from(channels).where(and(
    eq(channels.serverId, server.id),
    eq(channels.name, "must-not-exist"),
  ));
  assert.equal(created, undefined);
});

test("migration export profile action-card route is not supported", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("migration-card-owner@slock.test", "migration-card-owner");
  const server = await createServer("Botiverse", "botiverse", owner.id);
  await db.insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: AGENT_MIGRATION_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [server.id],
  });
  const source = await registerMachine(server.id, owner.id, "source-computer");
  const target = await registerMachine(server.id, owner.id, "target-computer");
  const agent = await createAgent(server.id, "migration-card-agent", { runtime: "codex" });
  await assignMachine(agent.id, source.machine.id);

  const token = await tokenForHuman(owner.email);
  const prepareRes = await fetch(`${app.baseUrl}/api/actions/migration-export`, {
    method: "POST",
    headers: authHeaders(token, server.id),
    body: JSON.stringify({
      agentId: agent.id,
      targetComputer: target.machine.id,
      mode: "cooperative",
    }),
  });
  const preparedText = await prepareRes.text();
  assert.equal(prepareRes.status, 410, `prepare should be gone: ${prepareRes.status} ${preparedText}`);
  assert.match(preparedText, /migration_action_card_not_supported/);

  const rows = await db.select().from(agentMigrations).where(eq(agentMigrations.agentId, agent.id));
  assert.equal(rows.length, 0);
});

test("migration export profile action-card route rejects before preflight", async ({ app }) => {
  const scenario = await seedMigrationRouteScenario({ slug: `gone-${randomUUID()}` });
  const token = await tokenForHuman(scenario.owner.email);
  const { res, text } = await prepareMigrationCard({
    baseUrl: app.baseUrl,
    token,
    serverId: scenario.server.id,
    agentId: scenario.agent.id,
    targetComputer: scenario.target.id,
  });
  assert.equal(res.status, 410, `prepare should be gone, got ${res.status} ${text}`);
  assert.match(text, /migration_action_card_not_supported/);
});

test("action card prepare rejects private thread targets without parent access", async ({ app }) => {
  const owner = await seedUser("private-card-thread-owner@slock.test", "private-card-thread-owner");
  const server = await createServer("Private Action Thread", "private-action-thread", owner.id);
  const agent = await createAgent(server.id, "private-card-thread-agent", { runtime: "codex" });
  const privateChannel = await createChannel(server.id, "private-card-thread-parent", undefined, "private");
  await addHuman(privateChannel.id, owner.id);
  const parentMessage = await createMessage(privateChannel.id, "user", owner.id, "private parent");
  const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");

  await assert.rejects(
    () => prepareActionCard({
      serverId: server.id,
      requesterAgentId: agent.id,
      targetChannelId: thread.id,
      action: {
        type: "channel:create",
        name: "private-card-thread-created",
        visibility: "public",
      },
    }),
    (err: unknown) => err instanceof ActionCardError
      && err.status === 403
      && err.code === "TARGET_NOT_ACCESSIBLE",
  );
});

test("action card prepare into private thread does not leak through stale thread rooms", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("private-card-thread-delivery-owner@slock.test", "private-card-thread-delivery-owner");
  const removed = await seedUser("private-card-thread-delivery-removed@slock.test", "private-card-thread-delivery-removed");
  const server = await createServer("Private Action Thread Delivery", "private-action-thread-delivery", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: removed.id, role: "member" }).onConflictDoNothing();
  const agent = await createAgent(server.id, "private-card-thread-agent-b", { runtime: "codex" });
  const privateChannel = await createChannel(server.id, "private-card-thread-delivery-parent", undefined, "private");
  await addHuman(privateChannel.id, owner.id);
  await addHuman(privateChannel.id, removed.id);
  await addAgent(privateChannel.id, agent.id);
  const parentMessage = await createMessage(privateChannel.id, "user", owner.id, "private parent");
  const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
  await db.insert(threadFollows).values([
    {
      threadChannelId: thread.id,
      followerType: "user",
      followerId: owner.id,
      parentMessageId: parentMessage.id,
      reason: "authored",
    },
    {
      threadChannelId: thread.id,
      followerType: "user",
      followerId: removed.id,
      parentMessageId: parentMessage.id,
      reason: "manual",
    },
  ]);

  await removeHuman(privateChannel.id, removed.id);
  const { io, events } = installFakeIo();

  await prepareActionCard({
    serverId: server.id,
    requesterAgentId: agent.id,
    targetChannelId: thread.id,
    action: {
      type: "channel:create",
      name: "private-card-thread-delivery-created",
      visibility: "public",
    },
    io,
  });

  assert.ok(
    events.some((event) => event.event === "message:new" && event.room === `user:${owner.id}`),
    "remaining private parent member should receive prepared action cards in the thread",
  );
  assert.ok(
    !events.some((event) => event.event === "message:new" && event.room === `user:${removed.id}`),
    "removed private parent member must not receive prepared action cards directly",
  );
  assert.ok(
    !events.some((event) => event.event === "message:new" && event.room === `channel:${thread.id}`),
    "prepared action cards must not broadcast to stale thread rooms",
  );
});

test("executed action cards update private thread followers without stale thread-room broadcast", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("private-card-execute-owner@slock.test", "private-card-execute-owner");
  const removed = await seedUser("private-card-execute-removed@slock.test", "private-card-execute-removed");
  const server = await createServer("Private Action Card Execute Server", "private-action-card-execute-server", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: removed.id, role: "member" }).onConflictDoNothing();
  const agent = await createAgent(server.id, "private-card-execute-agent", { runtime: "codex" });
  const privateChannel = await createChannel(server.id, "private-card-execute-channel", undefined, "private");
  await addHuman(privateChannel.id, owner.id);
  await addHuman(privateChannel.id, removed.id);
  await addAgent(privateChannel.id, agent.id);
  const parentMessage = await createMessage(privateChannel.id, "user", owner.id, "thread root");
  const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
  await db.insert(threadFollows).values([
    {
      threadChannelId: thread.id,
      followerType: "user",
      followerId: owner.id,
      parentMessageId: parentMessage.id,
      reason: "authored",
    },
    {
      threadChannelId: thread.id,
      followerType: "user",
      followerId: removed.id,
      parentMessageId: parentMessage.id,
      reason: "manual",
    },
  ]);

  await removeHuman(privateChannel.id, removed.id);
  const card = await prepareActionCard({
    serverId: asServerId(server.id),
    requesterAgentId: agent.id,
    targetChannelId: thread.id,
    action: {
      type: "channel:create",
      name: "private-card-execute-created",
      visibility: "public",
    },
  });
  const { io, events } = installFakeIo();

  await markActionCardExecuted({
    serverId: asServerId(server.id),
    userId: owner.id,
    messageId: card.messageId,
    result: { kind: "channel", id: privateChannel.id, name: "private-card-execute-created" },
    io,
  });

  assert.ok(
    events.some((event) => event.event === "message:updated" && event.room === `user:${owner.id}`),
    "remaining private parent member should receive executed action-card updates in the thread",
  );
  assert.ok(
    !events.some((event) => event.event === "message:updated" && event.room === `user:${removed.id}`),
    "removed private parent member must not receive executed action-card updates directly",
  );
  assert.ok(
    !events.some((event) => event.event === "message:updated" && event.room === `channel:${thread.id}`),
    "executed action cards must not broadcast updates to stale thread rooms",
  );
});

test("action card channel:create rejects cross-server UUID initial members", async ({ app }) => {
  const ownerA = await seedUser("action-card-cross-owner-a@slock.test", "action-card-cross-owner-a");
  const ownerB = await seedUser("action-card-cross-owner-b@slock.test", "action-card-cross-owner-b");
  const serverA = await createServer("Action Card Cross A", "action-card-cross-a", ownerA.id);
  const serverB = await createServer("Action Card Cross B", "action-card-cross-b", ownerB.id);
  const agentA = await createAgent(serverA.id, "action-card-cross-agent-a", { runtime: "codex" });
  const agentB = await createAgent(serverB.id, "action-card-cross-agent-b", { runtime: "codex" });
  const carrier = await createChannel(serverA.id, "action-card-cross-carrier", undefined, "private");
  const foreignChannel = await createChannel(serverB.id, "action-card-cross-foreign-channel", undefined, "private");
  await addHuman(carrier.id, ownerA.id);
  await addAgent(carrier.id, agentA.id);

  await assert.rejects(
    () => prepareActionCard({
      serverId: serverA.id,
      requesterAgentId: agentA.id,
      targetChannelId: carrier.id,
      action: {
        type: "channel:create",
        name: "action-card-cross-created-agent",
        visibility: "private",
        initialAgents: [agentB.id],
      },
    }),
    /initialAgents\[0\]/,
  );

  await assert.rejects(
    () => prepareActionCard({
      serverId: serverA.id,
      requesterAgentId: agentA.id,
      targetChannelId: carrier.id,
      action: {
        type: "channel:create",
        name: "action-card-cross-created-human",
        visibility: "private",
        initialHumans: [ownerB.id],
      },
    }),
    /initialHumans\[0\]/,
  );

  await assert.rejects(
    () => prepareActionCard({
      serverId: serverA.id,
      requesterAgentId: agentA.id,
      targetChannelId: carrier.id,
      action: {
        type: "channel:add_member",
        channel: foreignChannel.id,
        agents: [agentA.id],
      },
    }),
    /channel/,
  );

  const prepared = await prepareActionCard({
    serverId: serverA.id,
    requesterAgentId: agentA.id,
    targetChannelId: carrier.id,
    action: {
      type: "channel:create",
      name: "action-card-cross-created-safe",
      visibility: "private",
      initialAgents: [agentA.id],
      initialHumans: [ownerA.id],
    },
  });
  assert.equal(prepared.metadata.action.type, "channel:create");
});

test("channel:add_member cards cannot report success before the target memberships exist", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("member-card-owner@slock.test", "member-card-owner");
  const actor = await seedUser("member-card-actor@slock.test", "member-card-actor");
  const target = await seedUser("member-card-target@slock.test", "member-card-target");
  const server = await createServer("Member Action Card", `member-action-card-${randomUUID()}`, owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: actor.id, role: "member" },
    { serverId: server.id, userId: target.id, role: "member" },
  ]);
  const requester = await createAgent(server.id, `member-card-agent-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  const carrier = await createChannel(server.id, "member-card-carrier", undefined, "channel", { type: "user", id: owner.id });
  const targetChannel = await createChannel(server.id, "member-card-target-channel", undefined, "channel", { type: "user", id: owner.id });
  await addHuman(carrier.id, actor.id);
  await addHuman(targetChannel.id, actor.id);
  await addAgent(carrier.id, requester.id);
  const card = await prepareActionCard({
    serverId: asServerId(server.id),
    requesterAgentId: requester.id,
    targetChannelId: carrier.id,
    action: { type: "channel:add_member", channel: targetChannel.id, humans: [target.id] },
  });
  const token = await tokenForHuman(actor.email);
  const headers = authHeaders(token, server.id);
  const result = {
    kind: "channel-members",
    channelId: targetChannel.id,
    channelName: targetChannel.name,
    addedHumanIds: [target.id],
    addedAgentIds: [],
  };

  const premature = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/mark-executed`, {
    method: "POST",
    headers,
    body: JSON.stringify({ result }),
  });
  assert.equal(premature.status, 409);
  const [stillPrepared] = await db.select({ actionMetadata: messages.actionMetadata })
    .from(messages)
    .where(eq(messages.id, card.messageId));
  assert.equal((stillPrepared?.actionMetadata as { state?: string } | null)?.state, "prepared");

  await addHuman(targetChannel.id, target.id);
  const committed = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/mark-executed`, {
    method: "POST",
    headers,
    body: JSON.stringify({ result }),
  });
  assert.equal(committed.status, 200);
});

test("action card agent:create resolves structured computer constraints", async ({ app }) => {
  const ownerA = await seedUser("action-card-computer-owner-a@slock.test", "action-card-computer-owner-a");
  const ownerB = await seedUser("action-card-computer-owner-b@slock.test", "action-card-computer-owner-b");
  const serverA = await createServer("Action Card Computer A", "action-card-computer-a", ownerA.id);
  const serverB = await createServer("Action Card Computer B", "action-card-computer-b", ownerB.id);
  const agentA = await createAgent(serverA.id, "action-card-computer-agent-a", { runtime: "codex" });
  const carrier = await createChannel(serverA.id, "action-card-computer-carrier", undefined, "private");
  await addHuman(carrier.id, ownerA.id);
  await addAgent(carrier.id, agentA.id);
  const { machine: localMachine } = await registerMachine(serverA.id, ownerA.id, "tygg-ec2");
  const { machine: foreignMachine } = await registerMachine(serverB.id, ownerB.id, "other-ec2");

  const prepared = await prepareActionCard({
    serverId: serverA.id,
    requesterAgentId: agentA.id,
    targetChannelId: carrier.id,
    action: {
      type: "agent:create",
      name: "action-card-computer-created",
      description: "must run on the requested computer",
      requiredComputer: "tygg-ec2",
    },
  });

  assert.equal(prepared.metadata.action.type, "agent:create");
  if (prepared.metadata.action.type === "agent:create") {
    assert.equal(prepared.metadata.action.requiredComputer, localMachine.id);
  }

  await assert.rejects(
    () => prepareActionCard({
      serverId: serverA.id,
      requesterAgentId: agentA.id,
      targetChannelId: carrier.id,
      action: {
        type: "agent:create",
        name: "action-card-computer-foreign",
        requiredComputer: foreignMachine.id,
      },
    }),
    /requiredComputer/,
  );
});

test("agent:create action card required computer blocks mark-executed mismatch", async ({ app }) => {
  const owner = await seedUser("action-card-required-owner@slock.test", "action-card-required-owner");
  const server = await createServer("Action Card Required Computer", "action-card-required-computer", owner.id);
  const requester = await createAgent(server.id, "action-card-required-requester", { runtime: "codex" });
  const carrier = await createChannel(server.id, "action-card-required-carrier", undefined, "private");
  await addHuman(carrier.id, owner.id);
  await addAgent(carrier.id, requester.id);
  const { machine: requiredMachine } = await registerMachine(server.id, owner.id, "required-ec2");
  const { machine: wrongMachine } = await registerMachine(server.id, owner.id, "wrong-ec2");
  const created = await createAgent(server.id, "action-card-required-created", { runtime: "codex" });
  await assignMachine(created.id, wrongMachine.id);

  const card = await prepareActionCard({
    serverId: server.id,
    requesterAgentId: requester.id,
    targetChannelId: carrier.id,
    action: {
      type: "agent:create",
      name: "action-card-required-created",
      requiredComputer: requiredMachine.id,
    },
  });
  await assert.rejects(
    () => markActionCardExecuted({
      messageId: card.messageId,
      serverId: asServerId(server.id),
      userId: owner.id,
      result: { kind: "agent", id: created.id, name: created.name },
    }),
    (err: unknown) => err instanceof ActionCardError
      && err.status === 409
      && err.code === "REQUIRED_COMPUTER_MISMATCH",
  );
});

test("agent:create action card rejects mark-executed from a member without createAgents", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("action-card-permission-owner@slock.test", "action-card-permission-owner");
  const member = await seedUser("action-card-permission-member@slock.test", "action-card-permission-member");
  const server = await createServer("Action Card Permission", `action-card-permission-${randomUUID()}`, owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const requester = await createAgent(server.id, "action-card-permission-requester", { runtime: "codex" });
  const created = await createAgent(server.id, "action-card-permission-created", { runtime: "codex" });
  const carrier = await createChannel(server.id, "action-card-permission-carrier", undefined, "channel", { type: "user", id: owner.id });
  await addHuman(carrier.id, member.id);
  await addAgent(carrier.id, requester.id);

  const card = await prepareActionCard({
    serverId: asServerId(server.id),
    requesterAgentId: requester.id,
    targetChannelId: carrier.id,
    action: { type: "agent:create", name: "action-card-permission-created" },
  });

  await assert.rejects(
    () => markActionCardExecuted({
      messageId: card.messageId,
      serverId: asServerId(server.id),
      userId: member.id,
      result: { kind: "agent", id: created.id, name: created.name },
    }),
    (err: unknown) => err instanceof ActionCardError
      && err.status === 403
      && err.code === "MISSING_CREATE_AGENTS_CAPABILITY",
  );

  const [row] = await db.select({ actionMetadata: messages.actionMetadata })
    .from(messages)
    .where(eq(messages.id, card.messageId));
  assert.equal((row?.actionMetadata as { state?: string } | null)?.state, "prepared");
});

test("agent:create action card rejects incompatible mark-executed result kind", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("action-card-kind-owner@slock.test", "action-card-kind-owner");
  const server = await createServer("Action Card Result Kind", "action-card-result-kind", owner.id);
  const requester = await createAgent(server.id, "action-card-kind-requester", { runtime: "codex" });
  const carrier = await createChannel(server.id, "action-card-kind-carrier", undefined, "private");
  await addHuman(carrier.id, owner.id);
  await addAgent(carrier.id, requester.id);
  const { machine: requiredMachine } = await registerMachine(server.id, owner.id, "kind-required-ec2");

  const card = await prepareActionCard({
    serverId: server.id,
    requesterAgentId: requester.id,
    targetChannelId: carrier.id,
    action: {
      type: "agent:create",
      name: "action-card-kind-created",
      requiredComputer: requiredMachine.id,
    },
  });

  await assert.rejects(
    () => markActionCardExecuted({
      messageId: card.messageId,
      serverId: asServerId(server.id),
      userId: owner.id,
      result: { kind: "channel", id: carrier.id, name: carrier.name },
    }),
    (err: unknown) => err instanceof ActionCardError
      && err.status === 400
      && err.code === "ACTION_RESULT_KIND_MISMATCH",
  );

  const [row] = await db
    .select({ actionMetadata: messages.actionMetadata })
    .from(messages)
    .where(eq(messages.id, card.messageId));
  const metadata = row?.actionMetadata as { state?: string } | null | undefined;
  assert.equal(metadata?.state, "prepared");
});

test("channel membership helpers reject cross-server principals", async ({ app }) => {
  const db = getDb();
  const ownerA = await seedUser("membership-cross-owner-a@slock.test", "membership-cross-owner-a");
  const ownerB = await seedUser("membership-cross-owner-b@slock.test", "membership-cross-owner-b");
  const serverA = await createServer("Membership Cross A", "membership-cross-a", ownerA.id);
  const serverB = await createServer("Membership Cross B", "membership-cross-b", ownerB.id);
  const channelA = await createChannel(serverA.id, "membership-cross-channel-a", undefined, "private");
  const agentB = await createAgent(serverB.id, "membership-cross-agent-b", { runtime: "codex" });

  await assert.rejects(() => addHuman(channelA.id, ownerB.id), /server/);
  await assert.rejects(() => addAgent(channelA.id, agentB.id), /server/);

  const humanRows = await db
    .select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(and(eq(channelHumans.channelId, channelA.id), eq(channelHumans.userId, ownerB.id)));
  assert.equal(humanRows.length, 0);

  const agentRows = await db
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, channelA.id), eq(channelAgents.agentId, agentB.id)));
  assert.equal(agentRows.length, 0);
});

test("prepared action cards advance realtime gap recovery seq", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("action-card-seq-owner@slock.test", "action-card-seq-owner");
  const server = await createServer("Action Card Seq Server", "action-card-seq-server", owner.id);
  const agent = await createAgent(server.id, "action-card-seq-agent", { runtime: "codex" });
  const channel = await createChannel(server.id, "action-card-seq-channel", undefined, "channel");
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);

  const card = await prepareActionCard({
    serverId: server.id,
    requesterAgentId: agent.id,
    targetChannelId: channel.id,
    action: {
      type: "channel:create",
      name: "action-card-seq-created-channel",
      visibility: "public",
    },
  });

  const [message] = await db
    .select({ seq: messages.seq })
    .from(messages)
    .where(eq(messages.id, card.messageId));

  assert.ok(message?.seq, "prepared action card should create a message row");
  assert.ok(
    getMaxSeq(server.id) >= message.seq,
    "prepared action card message must advance max seq so missed socket events self-heal",
  );
});

test("prepared action cards retain metadata through message sync recovery", async ({ app }) => {
  const owner = await seedUser("action-card-sync-owner@slock.test", "action-card-sync-owner");
  const server = await createServer("Action Card Sync Server", "action-card-sync-server", owner.id);
  const agent = await createAgent(server.id, "action-card-sync-agent", { runtime: "codex" });
  const channel = await createChannel(server.id, "action-card-sync-channel", undefined, "channel");
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);

  const card = await prepareActionCard({
    serverId: server.id,
    requesterAgentId: agent.id,
    targetChannelId: channel.id,
    action: {
      type: "channel:create",
      name: "action-card-sync-created-channel",
      visibility: "public",
    },
  });

  const token = await tokenForHuman(owner.email);
  const res = await fetch(`${app.baseUrl}/api/messages/sync?since_seq=0&channel_id=${channel.id}`, {
    headers: authHeaders(token, server.id),
  });
  assert.equal(res.status, 200);
  const synced = await res.json() as Array<{ id: string; actionMetadata?: { kind?: string; state?: string } | null }>;
  const syncedCard = synced.find((message) => message.id === card.messageId);

  assert.equal(syncedCard?.actionMetadata?.kind, "action-card");
  assert.equal(syncedCard?.actionMetadata?.state, "prepared");
});
