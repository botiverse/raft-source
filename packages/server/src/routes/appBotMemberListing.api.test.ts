import { vi } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { agents, appBotBindings, channels, messageMentions, oauthClientInstalls, threadFollows, users } from "../db/schema";
import { activeAppBotOrOrdinaryAgent } from "../services/agentMemberListPolicy";
import { createAgent } from "../services/agentService";
import * as channelService from "../services/channelService";
import { createJoinLink, getInviteInfo } from "../services/inviteService";
import { createMessage } from "../services/messageService";
import { createOAuthClient } from "../services/oauthService";
import { createServer } from "../services/serverService";
import { buildServerInfoAgentSummaries } from "./internal";

/**
 * A removed App Bot (bot grant revoked: binding disabled, agent row and
 * channel memberships kept) is hidden from every member list and count, by the
 * one shared condition activeAppBotOrOrdinaryAgent. Re-adding it brings it back
 * to its channels; its old messages keep resolving it throughout.
 */

const test = createApiTest();

async function seedUser(suffix: string) {
  const [user] = await getDb().insert(users).values({
    email: `listing-${suffix}@slock.test`,
    name: `listing-${suffix}`,
    displayName: `listing-${suffix}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  return user!;
}

test("a removed App Bot leaves every member list and count, returns when re-added, and keeps its history", async ({ app }) => {
  const short = randomUUID().slice(0, 8);
  const owner = await seedUser(short);
  const token = await tokenForHuman(owner.email);
  const server = await createServer("Bot Listing Server", `bot-listing-${short}`, owner.id);
  const headers = { Authorization: `Bearer ${token}`, "X-Server-Id": server.id, "Content-Type": "application/json" };
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${app.baseUrl}${path}`, { headers });
    assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`);
    return res.json() as Promise<T>;
  };

  // #all starts hidden; reveal it so its virtual audience is a member list.
  const [allChannel] = await getDb().update(channels).set({ type: "channel" })
    .where(and(eq(channels.serverId, server.id), eq(channels.name, "all"))).returning();
  assert.ok(allChannel);

  const plain = await createAgent(server.id, `plain-${short}`, { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `listing-bot-${short}`,
    name: "Listing Bot App",
    enableBot: true,
  });
  await getDb().insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
    status: "active",
    botGrant: "pending",
  });
  const setBot = async (action: "grant" | "revoke") => {
    const res = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/install/bot`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    return res.json() as Promise<{ bot: { agentId: string } | null; listingChanged?: unknown }>;
  };
  const granted = await setBot("grant");
  assert.ok(granted.bot);
  assert.equal("listingChanged" in granted, false, "the route's broadcast hint stays out of the response");
  const botId = granted.bot.agentId;
  const [botRow] = await getDb().select({ name: agents.name }).from(agents).where(eq(agents.id, botId));
  const botName = botRow!.name;

  const publicChannel = await channelService.createChannel(server.id, `pub-${short}`, undefined, "channel", { type: "user", id: owner.id });
  const privateChannel = await channelService.createChannel(server.id, `priv-${short}`, undefined, "private", { type: "user", id: owner.id });
  for (const channel of [publicChannel, privateChannel]) {
    await channelService.addAgent(channel.id, botId);
    await channelService.addAgent(channel.id, plain.id);
  }
  const botMessage = await createMessage(publicChannel.id, "agent", botId, "hello from the bot");
  const thread = await channelService.getOrCreateThreadForChannel(publicChannel.id, botMessage.id, owner.id, "user");
  await getDb().insert(threadFollows).values([botId, plain.id].map((followerId) => ({
    threadChannelId: thread.id,
    followerType: "agent" as const,
    followerId,
    parentMessageId: botMessage.id,
    reason: "replied" as const,
  })));
  const { token: joinToken } = await createJoinLink(server.id, owner.id);

  type Directory = Array<{ id: string; inMemberLists?: boolean; managedByApp?: { name: string } | null }>;
  /** Every list and count, as the agent ids (or counts) it shows. */
  const lists = async () => {
    const membersOf = async (channelId: string) => (await get<{ agents: Array<{ id: string }> }>(`/api/channels/${channelId}/members`)).agents.map((agent) => agent.id);
    const forward = await get<{ targets: Array<{ type: string; id: string }> }>(`/api/messages/forward/targets/search?q=${encodeURIComponent(botName)}`);
    const followers = await get<{ threads: Array<{ agents: Array<{ id: string }> }> }>(`/api/channels/threads/followers?threadChannelIds=${thread.id}`);
    const publicMembers = await membersOf(publicChannel.id);
    return {
      publicMembers,
      publicAgentCount: publicMembers.length,
      privateMembers: await membersOf(privateChannel.id),
      allMembers: await membersOf(allChannel.id),
      publicAgents: (await get<Array<{ id: string }>>(`/api/channels/${publicChannel.id}/agents`)).map((agent) => agent.id),
      inviteAgentCount: (await getInviteInfo(joinToken))?.agentCount,
      forwardTargets: forward.targets.filter((target) => target.type === "agent").map((target) => target.id),
      serverInfoAgents: (await buildServerInfoAgentSummaries(server.id)).map((agent) => agent.name),
      threadFollowers: followers.threads[0]!.agents.map((agent) => agent.id),
    };
  };
  const directory = async () => {
    const list = await get<Directory>("/api/agents");
    const detail = await get<{ id: string; inMemberLists?: boolean }>(`/api/agents/${botId}`);
    return { bot: list.find((agent) => agent.id === botId), plain: list.find((agent) => agent.id === plain.id), detail };
  };
  const history = async () => {
    const page = await get<{ messages: Array<{ id: string; senderId: string; senderType: string }> }>(`/api/messages/channel/${publicChannel.id}`);
    return page.messages.find((message) => message.id === botMessage.id);
  };

  // Listed while granted: every list shows the Bot (so a later absence is the change, not the fixture).
  const before = await lists();
  for (const ids of [before.publicMembers, before.privateMembers, before.allMembers, before.publicAgents, before.forwardTargets, before.threadFollowers]) {
    assert.ok(ids.includes(botId), JSON.stringify(before));
  }
  assert.ok(before.serverInfoAgents.includes(botName));
  assert.equal(before.publicAgentCount, 2);
  const listedAgentCount = before.inviteAgentCount!;
  assert.ok(listedAgentCount >= 2);
  assert.equal((await directory()).bot?.inMemberLists, true);

  // Remove the Bot, watching what open clients are told.
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  const to = app.io.to.bind(app.io);
  const spy = vi.spyOn(app.io, "to").mockImplementation((...args) => {
    const room = String(args[0]);
    const target = to(...args as Parameters<typeof to>);
    return new Proxy(target, {
      get(inner, key, receiver) {
        if (key !== "emit") return Reflect.get(inner, key, receiver);
        return (event: string, ...payload: unknown[]) => {
          emitted.push({ room, event, payload: payload[0] });
          return Reflect.apply(inner.emit, inner, [event, ...payload]);
        };
      },
    });
  });
  try {
    await setBot("revoke");
  } finally {
    spy.mockRestore();
  }
  const [binding] = await getDb().select({ state: appBotBindings.state }).from(appBotBindings).where(eq(appBotBindings.agentId, botId));
  assert.equal(binding?.state, "disabled");
  const [stillActive] = await getDb().select({ status: agents.status, deletedAt: agents.deletedAt }).from(agents).where(eq(agents.id, botId));
  assert.deepEqual(stillActive, { status: "active", deletedAt: null }, "removal keeps the agent row (the reason it still showed)");

  const removed = await lists();
  for (const ids of [removed.publicMembers, removed.privateMembers, removed.allMembers, removed.publicAgents, removed.forwardTargets, removed.threadFollowers]) {
    assert.ok(!ids.includes(botId), `removed Bot still listed: ${JSON.stringify(removed)}`);
  }
  for (const ids of [removed.publicMembers, removed.privateMembers, removed.allMembers, removed.publicAgents, removed.threadFollowers]) {
    assert.ok(ids.includes(plain.id), `ordinary agent must stay listed: ${JSON.stringify(removed)}`);
  }
  assert.ok(!removed.serverInfoAgents.includes(botName));
  assert.ok(removed.serverInfoAgents.includes(plain.name));
  assert.equal(removed.publicAgentCount, 1);
  assert.equal(removed.inviteAgentCount, listedAgentCount - 1);

  // The directory keeps it for history and says member lists leave it out;
  // ordinary agents carry no flag.
  const removedDirectory = await directory();
  assert.equal(removedDirectory.bot?.inMemberLists, false);
  assert.equal(removedDirectory.bot?.managedByApp?.name, "Listing Bot App");
  assert.equal(removedDirectory.detail.inMemberLists, false, "a fetched profile must not re-list it");
  assert.equal(removedDirectory.plain?.inMemberLists, undefined);
  const removedHistory = await history();
  assert.equal(removedHistory?.senderId, botId, "old messages still show the Bot");
  assert.equal(removedHistory?.senderType, "agent");

  // Realtime: the directory and each list that showed the Bot re-read.
  const roomsFor = (channelId: string) => emitted
    .filter((entry) => entry.event === "channel:members-updated" && (entry.payload as { channelId?: string }).channelId === channelId)
    .map((entry) => entry.room);
  assert.ok(emitted.some((entry) => entry.event === "agent:updated" && entry.room === `server:${server.id}` && (entry.payload as { agentId?: string }).agentId === botId), JSON.stringify(emitted));
  assert.deepEqual(roomsFor(publicChannel.id), [`server:${server.id}`]);
  assert.deepEqual(roomsFor(privateChannel.id), [`channel:${privateChannel.id}`]);
  assert.deepEqual(roomsFor(allChannel.id), [`server:${server.id}`]);

  // A removed Bot is no mention candidate; an ordinary agent still is.
  const send = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ channelId: publicChannel.id, content: `@${botName} and @${plain.name} ping` }),
  });
  assert.equal(send.status, 200, await send.clone().text());
  const { id: mentionMessageId } = await send.json() as { id: string };
  const mentioned = await getDb().select({ targetId: messageMentions.targetId }).from(messageMentions)
    .where(eq(messageMentions.messageId, mentionMessageId));
  assert.deepEqual(mentioned.map((row) => row.targetId), [plain.id]);

  // Re-adding re-activates the same binding: the Bot is back in its channels.
  await setBot("grant");
  const readded = await lists();
  for (const ids of [readded.publicMembers, readded.privateMembers, readded.allMembers, readded.publicAgents, readded.forwardTargets, readded.threadFollowers]) {
    assert.ok(ids.includes(botId), `re-added Bot missing: ${JSON.stringify(readded)}`);
  }
  assert.ok(readded.serverInfoAgents.includes(botName));
  assert.equal(readded.publicAgentCount, 2);
  assert.equal(readded.inviteAgentCount, listedAgentCount);
  assert.equal((await directory()).bot?.inMemberLists, true);
  assert.equal((await history())?.senderId, botId);
});

test("activeAppBotOrOrdinaryAgent: an ordinary agent always passes; a Bot only with an active binding and an active installation", async ({ db }) => {
  void db;
  const short = randomUUID().slice(0, 8);
  const owner = await seedUser(`pred-${short}`);
  const server = await createServer("Bot Listing Predicate", `bot-listing-pred-${short}`, owner.id);
  const plain = await createAgent(server.id, `pred-plain-${short}`, { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const bots = [];
  for (const label of ["live", "disabled", "suspended", "uninstalled"] as const) {
    const { client } = await createOAuthClient({
      serverId: server.id,
      createdByUserId: owner.id,
      clientId: `pred-${label}-${short}`,
      name: `Predicate ${label}`,
      enableBot: true,
    });
    const [install] = await getDb().insert(oauthClientInstalls).values({
      serverId: server.id,
      clientId: client.id,
      installedByUserId: owner.id,
      status: label === "suspended" ? "suspended" : "active",
      botGrant: "granted",
    }).returning();
    const [bot] = await getDb().insert(agents).values({
      serverId: server.id,
      name: `pred-${label}-${short}`,
      runtime: "external",
      status: "active",
      managedByAppInstallId: install!.id,
    }).returning();
    await getDb().insert(appBotBindings).values({
      installId: install!.id,
      serverId: server.id,
      agentId: bot!.id,
      handle: `pred-${label}-${short}`,
      state: label === "disabled" ? "disabled" : label === "uninstalled" ? "uninstalled" : "active",
    });
    bots.push({ label, id: bot!.id });
  }
  const ids = [plain.id, ...bots.map((bot) => bot.id)];
  const rows = await getDb()
    .select({ id: agents.id, listed: sql<boolean>`${activeAppBotOrOrdinaryAgent()}` })
    .from(agents)
    .where(inArray(agents.id, ids));
  const listed = new Map(rows.map((row) => [row.id, row.listed]));
  assert.deepEqual(
    [["plain", plain.id], ...bots.map((bot) => [bot.label, bot.id])].map(([label, id]) => [label, listed.get(id!)]),
    [["plain", true], ["live", true], ["disabled", false], ["suspended", false], ["uninstalled", false]],
  );
});
