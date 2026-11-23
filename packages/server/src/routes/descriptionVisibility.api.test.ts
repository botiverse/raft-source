import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import type { AgentMessage } from "@botiverse/raft-shared";
import { getDb } from "../db";
import { agents, servers, users } from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { createSeed } from "../test/integration/seed";
import { createHttpClient } from "../test/integration/http";
import { seedBoundGuest } from "../test/guestFixture";
import { enableExternalChannelsFlag } from "../test/externalInviteFixture";
import { withChannelDelivery } from "../test/orchestratorStub";
import { prepareJointHumanMembershipMirror } from "../services/jointHumanMembershipMirror";
import { acceptJointChannelInvite, addAgent, addHuman, createChannel, createJointChannel, getOrCreateThreadForChannel } from "../services/channelService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { __resetMessageServiceDepsForTests, __setMessageServiceDepsForTests, broadcastAndDeliver, createMessage, deliverMessagesToAgents, deliverMessageToAgent, getOriginJointServers } from "../services/messageService";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { registerMachine } from "../services/machineService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";

/**
 * Description visibility (cindyz 2026-11-17; message headers: Tenny), one
 * server rule (lib/descriptionVisibility.ts): an agent's profile description
 * and any message sender's description reach only non-guest members of the
 * subject's server, judged on the viewer's server. Human profile
 * descriptions are unchanged.
 *
 * Host H (owner, member, a Guest bound to H's projection, an agent) and peer
 * P (admin, member, an agent) share a joint channel.
 */
const test = createApiTest();

const DESC = {
  hostAgent: "host agent: reviews host PRs",
  peerAgent: "peer agent: triages peer bugs",
  hostMember: "host member: design lead",
  peerMember: "peer member: on-call at peer",
  guest: "guest: contractor",
};

async function seedJoint() {
  const db = getDb();
  const seed = createSeed(db);
  const hostOwner = await seed.human();
  const hostMember = await seed.human();
  const peerAdmin = await seed.human();
  const peerMember = await seed.human();
  const guest = await seed.human();
  const host = await seed.server({ owner: hostOwner, members: [hostMember] });
  const peer = await seed.server({ owner: peerAdmin, members: [peerMember] });
  const made = await createJointChannel({
    hostServerId: host.id,
    createdByUserId: hostOwner.id,
    name: `desc-${host.slug}`.slice(0, 40),
    targetServerSlug: peer.slug,
    invitedPeople: [`@${peerAdmin.name}`],
    userIds: [hostMember.id],
  });
  const peerChannel = await acceptJointChannelInvite({
    inviteId: made.invites[0]!.id,
    targetServerId: peer.id,
    acceptedByUserId: peerAdmin.id,
  });
  await addHuman(peerChannel.id, peerMember.id);
  await enableExternalChannelsFlag(host.id);
  await seedBoundGuest({ serverId: host.id, userId: guest.id, channelId: made.channel.id });
  await db.transaction(async (tx) => {
    const mirror = await prepareJointHumanMembershipMirror(tx, { channelIds: [made.channel.id] }, "join");
    await mirror.apply([guest.id], { actorUserId: hostOwner.id });
  });
  const suffix = Date.now() % 100000;
  const hostAgent = await createAgent(host.id, `deschost${suffix}`, { runtime: "codex" });
  const peerAgent = await createAgent(peer.id, `descpeer${suffix}`, { runtime: "codex" });
  await addAgent(made.channel.id, hostAgent.id);
  await addAgent(peerChannel.id, peerAgent.id);
  await db.update(agents).set({ description: DESC.hostAgent }).where(eq(agents.id, hostAgent.id));
  await db.update(agents).set({ description: DESC.peerAgent }).where(eq(agents.id, peerAgent.id));
  for (const [user, description] of [[hostMember, DESC.hostMember], [peerMember, DESC.peerMember], [guest, DESC.guest]] as const) {
    await db.update(users).set({ description }).where(eq(users.id, user.id));
  }
  return { host, peer, hostOwner, hostMember, peerAdmin, peerMember, guest, hostAgent, peerAgent, hostChannel: made.channel, peerChannel, canonicalId: made.jointChannel.canonicalChannelId };
}

type Seeded = Awaited<ReturnType<typeof seedJoint>>;

async function getJson(http: ReturnType<typeof createHttpClient>, who: { id: string }, server: { id: string }, path: string) {
  const response = await http.as(who, server).get(path);
  const text = await response.text();
  assert.equal(response.status, 200, `${path}: ${text}`);
  return JSON.parse(text) as unknown;
}

/** Each sender's `senderDescription` in a web history read, by sender id. */
async function webHeaderDescriptions(http: ReturnType<typeof createHttpClient>, who: { id: string }, server: { id: string }, channelId: string) {
  const body = await getJson(http, who, server, `/api/messages/channel/${channelId}?limit=50`) as { messages?: unknown[] } | unknown[];
  const rows = (Array.isArray(body) ? body : body.messages ?? []) as Array<{ senderId: string; senderDescription?: string | null }>;
  return new Map(rows.map((row) => [row.senderId, row.senderDescription ?? null]));
}

async function postAll(f: Seeded) {
  // One shared store: every side's message lives on the canonical channel.
  await createMessage(f.canonicalId, "agent", f.hostAgent.id, "from the host agent");
  await createMessage(f.canonicalId, "user", f.hostMember.id, "from the host member");
  await createMessage(f.canonicalId, "user", f.guest.id, "from the guest");
  await createMessage(f.canonicalId, "user", f.peerMember.id, "from the peer member");
  await createMessage(f.canonicalId, "agent", f.peerAgent.id, "from the peer agent");
}

test("agent profile: same-server members read the description; a Guest and another server's member get null", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJoint();

  const asMember = await getJson(http, f.hostMember, f.host, `/api/agents/${f.hostAgent.id}`) as Record<string, unknown>;
  assert.equal(asMember.description, DESC.hostAgent, "a same-server member reads it as before");

  const asGuest = await getJson(http, f.guest, f.host, `/api/agents/${f.hostAgent.id}`) as Record<string, unknown>;
  assert.equal(asGuest.profileProjection, "channel_summary");
  assert.equal(asGuest.name, f.hostAgent.name, "name stays");
  assert.ok("description" in asGuest, "the key stays (nullable), for older clients");
  assert.equal(asGuest.description, null, "a Guest gets no agent description");

  const guestList = await getJson(http, f.guest, f.host, "/api/agents") as Array<Record<string, unknown>>;
  const guestRow = guestList.find((row) => row.id === f.hostAgent.id);
  assert.ok(guestRow, JSON.stringify(guestList));
  assert.equal(guestRow.description, null, "nor in the Guest's agent list");
  const memberList = await getJson(http, f.hostMember, f.host, "/api/agents") as Array<Record<string, unknown>>;
  assert.equal(memberList.find((row) => row.id === f.hostAgent.id)?.description, DESC.hostAgent);

  const asPeer = await getJson(http, f.peerMember, f.peer, `/api/agents/${f.hostAgent.id}`) as Record<string, unknown>;
  assert.equal(asPeer.serverId, f.host.id, "which server it belongs to stays");
  assert.equal(asPeer.serverName, f.host.name);
  assert.equal(asPeer.avatarUrl ?? null, null);
  assert.ok("description" in asPeer);
  assert.equal(asPeer.description, null, "another server's member gets no agent description");
  const peerOwnAgent = await getJson(http, f.peerMember, f.peer, `/api/agents/${f.peerAgent.id}`) as Record<string, unknown>;
  assert.equal(peerOwnAgent.description, DESC.peerAgent, "their own server's agent keeps it");
});

test("human profile descriptions are unchanged for a Guest and another server's member", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJoint();
  for (const [who, server] of [[f.guest, f.host], [f.hostMember, f.host]] as const) {
    const card = await getJson(http, who, server, `/api/servers/${f.host.id}/members/${f.peerMember.id}/profile`) as Record<string, unknown>;
    assert.equal(card.description, DESC.peerMember, `${who === f.guest ? "Guest" : "member"} reads a person's own description`);
  }
  const peerCard = await getJson(http, f.peerMember, f.peer, `/api/servers/${f.peer.id}/members/${f.hostMember.id}/profile`) as Record<string, unknown>;
  assert.equal(peerCard.description, DESC.hostMember);
});

test("web message headers: a sender's description only for a non-guest member of the sender's (and reader's) server", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJoint();
  await postAll(f);

  const member = await webHeaderDescriptions(http, f.hostMember, f.host, f.hostChannel.id);
  assert.deepEqual(Object.fromEntries(member), {
    [f.hostAgent.id]: DESC.hostAgent,
    [f.hostMember.id]: DESC.hostMember,
    [f.guest.id]: null,
    [f.peerMember.id]: null,
    [f.peerAgent.id]: null,
  }, "host member: own server's non-guest senders only");

  const guest = await webHeaderDescriptions(http, f.guest, f.host, f.hostChannel.id);
  assert.deepEqual([...guest.values()].filter((value) => value !== null), [], "a Guest reads no sender description");

  const peer = await webHeaderDescriptions(http, f.peerMember, f.peer, f.peerChannel.id);
  assert.deepEqual(Object.fromEntries(peer), {
    [f.hostAgent.id]: null,
    [f.hostMember.id]: null,
    [f.guest.id]: null,
    [f.peerMember.id]: DESC.peerMember,
    [f.peerAgent.id]: DESC.peerAgent,
  }, "peer member: keyed on the reader's server, not the canonical channel's");
});

test("agent API history: another server's senders and Guests read without a description", async ({ app }) => {
  const f = await seedJoint();
  await postAll(f);
  const historyOf = async (agentId: string, channelName: string) => {
    const { apiKey } = await mintAgentCredential({ agentId, scopes: ["read"], name: "description-visibility", issuedVia: "computer", createdByUserId: null });
    const response = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(`#${channelName}`)}&limit=50`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const rows = (JSON.parse(text) as { messages: Array<{ senderId?: string; sender_id?: string; senderDescription?: string | null; sender_description?: string | null }> }).messages;
    return Object.fromEntries(rows.map((row) => [row.senderId ?? row.sender_id, row.senderDescription ?? row.sender_description ?? null]));
  };

  assert.deepEqual(await historyOf(f.hostAgent.id, f.hostChannel.name), {
    // The reader's own messages carry no description: it wrote that text about itself.
    [f.hostAgent.id]: null,
    [f.hostMember.id]: DESC.hostMember,
    [f.guest.id]: null,
    [f.peerMember.id]: null,
    [f.peerAgent.id]: null,
  });
  assert.deepEqual(await historyOf(f.peerAgent.id, f.peerChannel.name), {
    [f.hostAgent.id]: null,
    [f.hostMember.id]: null,
    [f.guest.id]: null,
    [f.peerMember.id]: DESC.peerMember,
    [f.peerAgent.id]: null,
  });
});

test("agent API message resolve: the same rule as the history read", async ({ app }) => {
  const f = await seedJoint();
  const fromPeer = await createMessage(f.canonicalId, "user", f.peerMember.id, "peer resolve");
  const fromHost = await createMessage(f.canonicalId, "user", f.hostMember.id, "host resolve");
  const { apiKey } = await mintAgentCredential({ agentId: f.peerAgent.id, scopes: ["read"], name: "description-resolve", issuedVia: "computer", createdByUserId: null });
  const resolve = async (messageId: string) => {
    const response = await fetch(`${app.baseUrl}/internal/agent-api/messages/${messageId}/resolve`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return (JSON.parse(text) as { message: { sender_description: string | null } }).message.sender_description;
  };
  assert.equal(await resolve(fromPeer.id), DESC.peerMember, "the peer agent's own server's person");
  assert.equal(await resolve(fromHost.id), null, "another server's person");
  const own = await createMessage(f.canonicalId, "agent", f.peerAgent.id, "own resolve");
  assert.equal(await resolve(own.id), null, "the reading agent's own message");
});

function recordingOrchestrator() {
  const delivered = new Map<string, AgentMessage[]>();
  const orchestrator = withChannelDelivery({
    deliverMessage: async (agentId: string, message: AgentMessage) => {
      delivered.set(agentId, [...(delivered.get(agentId) ?? []), message]);
      return { status: "queued", reason: "replayable_inbox" } as const;
    },
  }) as AgentOrchestrator;
  return { delivered, orchestrator };
}

test("live joint delivery: the sender's description per recipient server, Guests' never", async ({ app }) => {
  const f = await seedJoint();
  const { delivered, orchestrator } = recordingOrchestrator();
  const sendAndRead = async (channelId: string, senderType: "user" | "agent", sender: { id: string; name: string }) => {
    delivered.clear();
    await broadcastAndDeliver(app.io, orchestrator, { channelId, senderType, senderId: sender.id, senderName: sender.name, content: `hello from ${sender.name}` });
    // Joint fan-out runs after the send returns.
    const expected = [f.hostAgent.id, f.peerAgent.id].filter((id) => id !== sender.id);
    for (let i = 0; i < 50 && !expected.every((id) => delivered.has(id)); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      host: delivered.get(f.hostAgent.id)?.at(-1)?.sender_description,
      peer: delivered.get(f.peerAgent.id)?.at(-1)?.sender_description,
    };
  };

  assert.deepEqual(await sendAndRead(f.peerChannel.id, "user", f.peerMember), { host: null, peer: DESC.peerMember }, "another server's person");
  assert.deepEqual(await sendAndRead(f.hostChannel.id, "user", f.hostMember), { host: DESC.hostMember, peer: null }, "a host member");
  assert.deepEqual(await sendAndRead(f.hostChannel.id, "user", f.guest), { host: null, peer: null }, "a Guest sender");
  assert.deepEqual((await sendAndRead(f.hostChannel.id, "agent", f.hostAgent)).peer, null, "our agent, read by another server's agent");
  assert.deepEqual((await sendAndRead(f.peerChannel.id, "agent", f.peerAgent)).host, null, "their agent, read by ours");
});

test("thread join context reads sender descriptions as the receiving server's agents may", async ({ app }) => {
  const f = await seedJoint();
  const parent = await createMessage(f.canonicalId, "user", f.peerMember.id, "peer parent");
  const thread = await getOrCreateThreadForChannel(f.hostChannel.id, parent.id, f.hostMember.id, "user");
  const { delivered, orchestrator } = recordingOrchestrator();
  await broadcastAndDeliver(app.io, orchestrator, {
    channelId: thread.id,
    senderType: "user",
    senderId: f.hostMember.id,
    senderName: f.hostMember.name,
    content: `@${f.hostAgent.name} take a look`,
  });
  for (let i = 0; i < 50 && !delivered.has(f.hostAgent.id); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  const message = delivered.get(f.hostAgent.id)?.at(-1);
  assert.ok(message, "the mentioned host agent is delivered to");
  assert.equal(message.sender_description, DESC.hostMember, "a host member, read by a host agent");
  const context = message.thread_join_context;
  assert.ok(context, JSON.stringify(message));
  assert.equal(context.parent_message.sender_description, null, "another server's person as the parent's sender");
});

/** Every `message:updated` the routes emit, by room (the real io stays for everything else). */
function recordMessageUpdates(app: { app: { get(key: string): unknown; set(key: string, value: unknown): void } }) {
  const updates: Array<{ room: string; payload: Record<string, unknown> }> = [];
  const io = app.app.get("io") as { to(room: string): { emit(event: string, payload: unknown): unknown } };
  app.app.set("io", new Proxy(io, {
    get(target, key, receiver) {
      if (key !== "to") return Reflect.get(target, key, receiver);
      return (room: string) => {
        const real = target.to(room);
        return new Proxy(real, {
          get(inner, innerKey, innerReceiver) {
            if (innerKey !== "emit") return Reflect.get(inner, innerKey, innerReceiver);
            return (event: string, payload: unknown) => {
              if (event === "message:updated") updates.push({ room, payload: payload as Record<string, unknown> });
              return inner.emit(event, payload);
            };
          },
        });
      };
    },
  }));
  return updates;
}

test("reaction broadcasts carry no sender description to any room; the reactor's own response keeps theirs", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJoint();
  const updates = recordMessageUpdates(app);
  const rooms = [`channel:${f.hostChannel.id}`, `channel:${f.peerChannel.id}`];
  const assertBroadcastsNull = (label: string) => {
    for (const room of rooms) {
      const update = updates.filter((entry) => entry.room === room).at(-1);
      assert.ok(update, `${label}: ${room} gets the update (${JSON.stringify(updates.map((entry) => entry.room))})`);
      assert.ok("senderDescription" in update.payload, `${label}: the key stays`);
      assert.equal(update.payload.senderDescription, null, `${label}: ${room} (Guests and the peer server) reads no description`);
    }
    updates.length = 0;
  };

  // A host member reacts (human route) to the host agent's message.
  const fromHostAgent = await createMessage(f.canonicalId, "agent", f.hostAgent.id, "react to me");
  const humanReaction = await http.as(f.hostMember, f.host).request(`/api/messages/${fromHostAgent.id}/reactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emoji: "👍" }),
  });
  const humanBody = await humanReaction.json() as Record<string, unknown>;
  assert.equal(humanReaction.status, 200, JSON.stringify(humanBody));
  assert.equal(humanBody.senderDescription, DESC.hostAgent, "the reacting host member's own response");
  assertBroadcastsNull("human route");

  // The host agent reacts (agent API) to a host member's message.
  const fromHostMember = await createMessage(f.canonicalId, "user", f.hostMember.id, "agent reacts");
  const { apiKey } = await mintAgentCredential({ agentId: f.hostAgent.id, scopes: ["reactions"], name: "description-reaction", issuedVia: "computer", createdByUserId: null });
  const agentReaction = await fetch(`${app.baseUrl}/internal/agent-api/messages/${fromHostMember.id}/reactions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ emoji: "👀" }),
  });
  assert.equal(agentReaction.status, 200, await agentReaction.clone().text());
  assertBroadcastsNull("agent API route");

  // The legacy machine route (it reacts on the storage channel, so a host
  // channel that is not joint; its room is the same shared broadcast).
  const local = await createChannel(f.host.id, `desc-local-${Date.now() % 100000}`, undefined, "channel");
  await addAgent(local.id, f.hostAgent.id);
  await addHuman(local.id, f.hostMember.id);
  const localMessage = await createMessage(local.id, "user", f.hostMember.id, "legacy reacts");
  const { machine, apiKey: machineKey } = await registerMachine(f.host.id, f.hostOwner.id, `desc-machine-${Date.now() % 100000}`);
  await placeAgentOnMachine(f.hostAgent.id, machine.id);
  const legacy = await fetch(`${app.baseUrl}/internal/agent/${f.hostAgent.id}/messages/${localMessage.id}/reactions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${machineKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ emoji: "🎉" }),
  });
  assert.equal(legacy.status, 200, await legacy.clone().text());
  const legacyUpdate = updates.filter((entry) => entry.room === `channel:${local.id}`).at(-1);
  assert.ok(legacyUpdate, JSON.stringify(updates.map((entry) => entry.room)));
  assert.equal(legacyUpdate.payload.senderDescription, null, "legacy agent route");
});

/**
 * Where an outside sender is from (descriptionVisibility senderOriginFor):
 * for an agent reader only, in place of the withheld description. `guest`
 * only on the guest's own (host) server; another server's reader sees a host
 * guest as from the host, with its slug, like any host member.
 */
type OriginRow = { senderId?: string; sender_id?: string; senderOrigin?: unknown; sender_origin?: unknown };
const otherServer = (server: { slug: string }) => ({ kind: "other_server", serverSlug: server.slug });
const otherServerWire = (server: { slug: string }) => ({ kind: "other_server", server_slug: server.slug });

async function agentApiKey(agentId: string, scopes: Parameters<typeof mintAgentCredential>[0]["scopes"]) {
  return (await mintAgentCredential({ agentId, scopes, name: "sender-origin", issuedVia: "computer", createdByUserId: null })).apiKey;
}

test("agent API history: an outside sender's origin per reader server; none for same-server senders", async ({ app }) => {
  const f = await seedJoint();
  await postAll(f);
  const originsOf = async (agentId: string, channelName: string) => {
    const apiKey = await agentApiKey(agentId, ["read"]);
    const response = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(`#${channelName}`)}&limit=50`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const rows = (JSON.parse(text) as { messages: OriginRow[] }).messages;
    return Object.fromEntries(rows.map((row) => [row.senderId ?? row.sender_id, "senderOrigin" in row ? row.senderOrigin : "absent"]));
  };

  assert.deepEqual(await originsOf(f.hostAgent.id, f.hostChannel.name), {
    [f.hostAgent.id]: "absent",
    [f.hostMember.id]: "absent",
    [f.guest.id]: { kind: "guest" },
    [f.peerMember.id]: otherServer(f.peer),
    [f.peerAgent.id]: otherServer(f.peer),
  }, "host agent: a guest of its server is a guest; the peer's senders are from the peer");
  assert.deepEqual(await originsOf(f.peerAgent.id, f.peerChannel.name), {
    [f.hostAgent.id]: otherServer(f.host),
    [f.hostMember.id]: otherServer(f.host),
    [f.guest.id]: otherServer(f.host),
    [f.peerMember.id]: "absent",
    [f.peerAgent.id]: "absent",
  }, "peer agent: a host guest reads as from the host, never as a guest");
});

test("web history carries no sender origin for any reader", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJoint();
  await postAll(f);
  for (const [who, server, channel] of [[f.hostMember, f.host, f.hostChannel], [f.guest, f.host, f.hostChannel], [f.peerMember, f.peer, f.peerChannel]] as const) {
    const body = await getJson(http, who, server, `/api/messages/channel/${channel.id}?limit=50`) as { messages?: unknown[] } | unknown[];
    const rows = (Array.isArray(body) ? body : body.messages ?? []) as Array<Record<string, unknown>>;
    assert.ok(rows.length >= 5, JSON.stringify(rows));
    assert.deepEqual(rows.filter((row) => "senderOrigin" in row || "sender_origin" in row), [], "a human read has no origin key");
  }
});

test("agent API message resolve: sender_origin as the history read has it", async ({ app }) => {
  const f = await seedJoint();
  const fromHost = await createMessage(f.canonicalId, "user", f.hostMember.id, "host resolve");
  const fromPeer = await createMessage(f.canonicalId, "user", f.peerMember.id, "peer resolve");
  const apiKey = await agentApiKey(f.peerAgent.id, ["read"]);
  const resolve = async (messageId: string) => {
    const response = await fetch(`${app.baseUrl}/internal/agent-api/messages/${messageId}/resolve`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const message = (JSON.parse(text) as { message: Record<string, unknown> }).message;
    return "sender_origin" in message ? message.sender_origin : "absent";
  };
  assert.deepEqual(await resolve(fromHost.id), otherServerWire(f.host));
  assert.equal(await resolve(fromPeer.id), "absent");
});

test("live joint delivery: sender_origin per recipient server; guest only on the host side", async ({ app }) => {
  const f = await seedJoint();
  const { delivered, orchestrator } = recordingOrchestrator();
  const sendAndRead = async (channelId: string, senderType: "user" | "agent", sender: { id: string; name: string }) => {
    delivered.clear();
    await broadcastAndDeliver(app.io, orchestrator, { channelId, senderType, senderId: sender.id, senderName: sender.name, content: `origin from ${sender.name}` });
    const expected = [f.hostAgent.id, f.peerAgent.id].filter((id) => id !== sender.id);
    for (let i = 0; i < 50 && !expected.every((id) => delivered.has(id)); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const originOf = (agentId: string) => {
      const message = delivered.get(agentId)?.at(-1);
      return message ? ("sender_origin" in message ? message.sender_origin : "absent") : "undelivered";
    };
    return { host: originOf(f.hostAgent.id), peer: originOf(f.peerAgent.id) };
  };

  assert.deepEqual(await sendAndRead(f.peerChannel.id, "user", f.peerMember), { host: otherServerWire(f.peer), peer: "absent" }, "a peer person");
  assert.deepEqual(await sendAndRead(f.hostChannel.id, "user", f.hostMember), { host: "absent", peer: otherServerWire(f.host) }, "a host member");
  assert.deepEqual(await sendAndRead(f.hostChannel.id, "user", f.guest), { host: { kind: "guest" }, peer: otherServerWire(f.host) }, "a host guest");
  assert.deepEqual((await sendAndRead(f.hostChannel.id, "agent", f.hostAgent)).peer, otherServerWire(f.host), "our agent, read by the peer's");
  assert.deepEqual((await sendAndRead(f.peerChannel.id, "agent", f.peerAgent)).host, otherServerWire(f.peer), "their agent, read by ours");
});

test("thread join context: the parent's sender origin as the receiving server's agents read it", async ({ app }) => {
  const f = await seedJoint();
  const parent = await createMessage(f.canonicalId, "user", f.peerMember.id, "peer parent");
  const thread = await getOrCreateThreadForChannel(f.hostChannel.id, parent.id, f.hostMember.id, "user");
  const { delivered, orchestrator } = recordingOrchestrator();
  await broadcastAndDeliver(app.io, orchestrator, {
    channelId: thread.id,
    senderType: "user",
    senderId: f.hostMember.id,
    senderName: f.hostMember.name,
    content: `@${f.hostAgent.name} origin check`,
  });
  for (let i = 0; i < 50 && !delivered.has(f.hostAgent.id); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  const message = delivered.get(f.hostAgent.id)?.at(-1);
  assert.ok(message?.thread_join_context, JSON.stringify(message));
  assert.equal("sender_origin" in message, false, "a host member, read by a host agent");
  assert.deepEqual(message.thread_join_context.parent_message.sender_origin, otherServerWire(f.peer));
});

test("a room broadcast carries no sender origin, even when an agent's action produced it", async ({ app }) => {
  const f = await seedJoint();
  const updates = recordMessageUpdates(app);
  const fromPeer = await createMessage(f.canonicalId, "user", f.peerMember.id, "react from the host agent");
  const apiKey = await agentApiKey(f.hostAgent.id, ["reactions"]);
  const reaction = await fetch(`${app.baseUrl}/internal/agent-api/messages/${fromPeer.id}/reactions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ emoji: "👀" }),
  });
  assert.equal(reaction.status, 200, await reaction.clone().text());
  const rooms = [`channel:${f.hostChannel.id}`, `channel:${f.peerChannel.id}`];
  for (const room of rooms) {
    const update = updates.filter((entry) => entry.room === room).at(-1);
    assert.ok(update, `${room} gets the update (${JSON.stringify(updates.map((entry) => entry.room))})`);
    assert.equal("senderOrigin" in update.payload, false, `${room}: no origin on a shared broadcast`);
  }
});

test("batch delivery and single redelivery: a joint message carries the sender's origin as live delivery does", async ({ app }) => {
  void app; // the fixture opens the database
  const f = await seedJoint();
  const { delivered, orchestrator } = recordingOrchestrator();
  const originOf = (agentId: string) => {
    const message = delivered.get(agentId)?.at(-1);
    return message ? ("sender_origin" in message ? message.sender_origin : "absent") : "undelivered";
  };
  const fromPeer = await createMessage(f.canonicalId, "user", f.peerMember.id, "a peer task host message");
  const fromHost = await createMessage(f.canonicalId, "user", f.hostMember.id, "a host task host message");
  const fromGuest = await createMessage(f.canonicalId, "user", f.guest.id, "a guest task host message");
  // The task route's shape: each joint face gets the persisted rows on its own channel id.
  const deliverOn = async (channelId: string, message: Awaited<ReturnType<typeof createMessage>>, name: string) => {
    delivered.clear();
    await deliverMessagesToAgents(orchestrator, [{ ...message, channelId }], name);
  };

  await deliverOn(f.hostChannel.id, fromPeer, f.peerMember.name);
  assert.deepEqual(originOf(f.hostAgent.id), otherServerWire(f.peer), "batch: a peer person, read by the host agent");
  await deliverOn(f.hostChannel.id, fromHost, f.hostMember.name);
  assert.equal(originOf(f.hostAgent.id), "absent", "batch: a host member");
  await deliverOn(f.hostChannel.id, fromGuest, f.guest.name);
  assert.deepEqual(originOf(f.hostAgent.id), { kind: "guest" }, "batch: a host guest on the host side");
  await deliverOn(f.peerChannel.id, fromGuest, f.guest.name);
  assert.deepEqual(originOf(f.peerAgent.id), otherServerWire(f.host), "batch: a host guest on the peer side");
  await deliverOn(f.peerChannel.id, fromHost, f.hostMember.name);
  assert.deepEqual(originOf(f.peerAgent.id), otherServerWire(f.host), "batch: a host member, read by the peer agent");

  // Single redelivery reads the stored (canonical) row: the reader is the recipient agent on its own server.
  delivered.clear();
  await deliverMessageToAgent(orchestrator, fromPeer.id, f.hostAgent.id);
  assert.deepEqual(originOf(f.hostAgent.id), otherServerWire(f.peer), "single: a peer person, read by the host agent");
  delivered.clear();
  await deliverMessageToAgent(orchestrator, fromHost.id, f.hostAgent.id);
  assert.equal(originOf(f.hostAgent.id), "absent", "single: a host member keeps no origin");
  assert.equal(delivered.get(f.hostAgent.id)?.at(-1)?.sender_description, DESC.hostMember, "and their description");
});

test("fail closed: a non-member sender outside any joint conversation still reads as from another server", async ({ app }) => {
  void app; // the fixture opens the database
  const db = getDb();
  const seed = createSeed(db);
  const owner = await seed.human();
  const outsider = await seed.human();
  const server = await seed.server({ owner });
  const channel = await createChannel(server.id, `origin-local-${Date.now() % 100000}`, undefined, "channel");
  const agent = await createAgent(server.id, `originlocal${Date.now() % 100000}`, { runtime: "codex" });
  await addAgent(channel.id, agent.id);
  // A person who is not (or no longer) a member of this server: no description, never a bare `@name`.
  await db.update(users).set({ description: "outsider: not one of yours" }).where(eq(users.id, outsider.id));
  const message = await createMessage(channel.id, "user", outsider.id, "from outside");
  const { delivered, orchestrator } = recordingOrchestrator();
  await deliverMessagesToAgents(orchestrator, [message], outsider.name);
  const payload = delivered.get(agent.id)?.at(-1);
  assert.ok(payload, "delivered");
  assert.equal(payload.sender_description, null);
  assert.deepEqual(payload.sender_origin, { kind: "other_server" });
});

/** Counts the joint lookups redelivery makes for a sender origin. */
function countOriginJointLookups() {
  const calls: string[] = [];
  __setMessageServiceDepsForTests({
    getOriginJointServers: async (channelId, db) => {
      calls.push(channelId);
      return getOriginJointServers(channelId, db);
    },
  });
  return calls;
}

test("redelivery looks the joint up only for an outside sender in a channel that can be joint", async ({ app }) => {
  void app; // the fixture opens the database
  const db = getDb();
  const seed = createSeed(db);
  const owner = await seed.human();
  const member = await seed.human();
  const outsider = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const channel = await createChannel(server.id, `origin-count-${Date.now() % 100000}`, undefined, "channel");
  const agent = await createAgent(server.id, `origincount${Date.now() % 100000}`, { runtime: "codex" });
  await addAgent(channel.id, agent.id);
  const { delivered, orchestrator } = recordingOrchestrator();
  const calls = countOriginJointLookups();
  try {
    for (const sender of [member, outsider]) {
      const message = await createMessage(channel.id, "user", sender.id, "local");
      await deliverMessagesToAgents(orchestrator, [message], sender.name);
      await deliverMessageToAgent(orchestrator, message.id, agent.id);
    }
    assert.deepEqual(calls, [], "a local channel: no joint lookup, whoever sent it");
    assert.deepEqual(delivered.get(agent.id)?.map((m) => m.sender_origin ?? null), [null, null, { kind: "other_server" }, { kind: "other_server" }]);

    const f = await seedJoint();
    const fromHost = await createMessage(f.canonicalId, "user", f.hostMember.id, "host member");
    const fromPeer = await createMessage(f.canonicalId, "user", f.peerMember.id, "peer member");
    delivered.clear();
    await deliverMessagesToAgents(orchestrator, [{ ...fromHost, channelId: f.hostChannel.id }], f.hostMember.name);
    assert.deepEqual(calls, [], "a joint channel, a same-server sender: no lookup");
    await deliverMessagesToAgents(orchestrator, [{ ...fromPeer, channelId: f.hostChannel.id }], f.peerMember.name);
    assert.deepEqual(calls, [f.hostChannel.id], "an outside sender in a joint channel: one lookup for the batch");
    assert.deepEqual(delivered.get(f.hostAgent.id)?.at(-1)?.sender_origin, otherServerWire(f.peer));
  } finally {
    __resetMessageServiceDepsForTests();
  }
});

test("a person in two of the joint's servers is named by the server they posted through", async ({ app }) => {
  const db = getDb();
  const seed = createSeed(db);
  const hostOwner = await seed.human();
  const person = await seed.human();
  const suffix = Date.now() % 100000;
  const host = await seed.server({ owner: hostOwner });
  // Slugs chosen so the one they post through sorts last (the read fallback would name the first).
  const first = await seed.server({ owner: person, slug: `aorigin-${suffix}` });
  const second = await seed.server({ owner: person, slug: `zorigin-${suffix}` });
  await db.update(servers).set({ plan: "founder" }).where(inArray(servers.id, [host.id, first.id, second.id]));
  const made = await createJointChannel({
    hostServerId: host.id,
    createdByUserId: hostOwner.id,
    name: `origin-two-${suffix}`,
    jointInvites: [first, second].map((server) => ({ targetServerSlug: server.slug, invitedPeople: [`@${person.name}`] })),
  });
  const faces = new Map<string, string>();
  for (const invite of made.invites) {
    const face = await acceptJointChannelInvite({ inviteId: invite.id, targetServerId: invite.toServerId, acceptedByUserId: person.id });
    faces.set(invite.toServerId, face.id);
  }
  const hostAgent = await createAgent(host.id, `origintwo${suffix}`, { runtime: "codex" });
  await addAgent(made.channel.id, hostAgent.id);
  const { delivered, orchestrator } = recordingOrchestrator();
  await broadcastAndDeliver(app.io, orchestrator, {
    channelId: faces.get(second.id)!,
    senderType: "user",
    senderId: person.id,
    senderName: person.name,
    content: "posted through the second server",
  });
  for (let i = 0; i < 50 && !delivered.has(hostAgent.id); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(delivered.get(hostAgent.id)?.at(-1)?.sender_origin, { kind: "other_server", server_slug: second.slug });
});
