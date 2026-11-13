import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { channelAgents, channelHumans, channels } from "../db/schema";
import { seedJointChannel } from "../test/integration/jointFixture";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { addAgent, addHuman, canUserAccessChannel, createChannel, findOrCreateDM, getOrCreateThreadForChannel } from "../services/channelService";
import { registerMachine } from "../services/machineService";
import { createMessage } from "../services/messageService";
import { canView } from "../services/visibilityService";
import { seedBoundGuest } from "../test/guestFixture";

// Search answers what the visibility entry answers (services/visibilityService):
// joint conversations and their threads are searchable for their members,
// a hidden #all is not, and a guest's are its one bound channel's.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type SearchBody = {
  error?: string;
  results: Array<{ id: string; channelId: string; channelType: string; threadId: string | null; parentChannelId: string; parentChannelName: string; parentChannelType: string; channelName: string }>;
};

test("joint channel and thread messages are searchable by member humans and agents, with local ids; a hidden #all is not", async ({ app, seed, http }) => {
  const db = getDb();
  const owner = await seed.human();
  const member = await seed.human();
  const outsider = await seed.human();
  const peerOwner = await seed.human();
  const server = await seed.server({ owner, members: [member, outsider] });
  const peer = await seed.server({ owner: peerOwner });
  const agent = await createAgent(server.id, `search-joint-agent-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  const { machine, apiKey: machineKey } = await registerMachine(server.id, owner.id, "search-joint-machine");
  await placeAgentOnMachine(agent.id, machine.id);
  const agentKey = (await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "search-joint", issuedVia: "computer", createdByUserId: null })).apiKey;

  const joint = await seedJointChannel({ name: `search-joint-${randomUUID().slice(0, 8)}`, serverIds: [server.id, peer.id], createdByUserId: owner.id });
  const local = joint.projections[0]!;
  await addHuman(local.id, member.id);
  await addAgent(local.id, agent.id);
  const root = await createMessage(joint.canonical.id, "user", member.id, "jointneedle root in the shared room");
  const thread = await getOrCreateThreadForChannel(local.id, root.id, member.id, "user");
  const reply = await createMessage(thread.canonicalThreadChannelId, "user", member.id, "jointneedle reply in the shared thread");

  const [allChannel] = await db.select().from(channels).where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
  const allMessage = await createMessage(allChannel!.id, "user", owner.id, "allneedle before hiding");
  await db.update(channels).set({ type: "private" }).where(eq(channels.id, allChannel!.id));
  // Stale membership rows on the hidden #all.
  await db.insert(channelHumans).values([{ channelId: allChannel!.id, userId: member.id }]).onConflictDoNothing();
  await db.insert(channelAgents).values([{ channelId: allChannel!.id, agentId: agent.id }]).onConflictDoNothing();
  const open = await createChannel(server.id, `search-open-${randomUUID().slice(0, 8)}`);
  const openMessage = await createMessage(open.id, "user", owner.id, "allneedle witness in a public channel");

  const humanSearch = async (human: { id: string }, q: string) => {
    const res = await http.as(human, server).get(`/api/messages/search?${new URLSearchParams({ q })}`);
    const body = await res.json() as SearchBody;
    assert.equal(res.status, 200, body.error);
    return body.results;
  };
  const agentSearches = async (q: string) => {
    const params = new URLSearchParams({ q });
    const legacy = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/search?${params}`, { headers: { Authorization: `Bearer ${machineKey}` } });
    const legacyBody = await legacy.json() as SearchBody;
    assert.equal(legacy.status, 200, legacyBody.error);
    const agentApi = await fetch(`${app.baseUrl}/internal/agent-api/search?${params}`, { headers: { Authorization: `Bearer ${agentKey}` } });
    const agentApiBody = await agentApi.json() as SearchBody;
    assert.equal(agentApi.status, 200, agentApiBody.error);
    return { legacy: legacyBody.results, agentApi: agentApiBody.results };
  };

  const expectJointHits = (results: SearchBody["results"], label: string) => {
    const rootHit = results.find((row) => row.id === root.id);
    const replyHit = results.find((row) => row.id === reply.id);
    assert.ok(rootHit && replyHit, `${label}: finds the joint root and the joint thread reply`);
    // Projected back to this server's ids: canonical storage never leaks.
    assert.equal(rootHit.channelId, local.id, `${label}: root on the local projection`);
    assert.equal(rootHit.channelType, "joint");
    assert.equal(rootHit.parentChannelId, local.id);
    assert.equal(replyHit.channelId, thread.id, `${label}: reply on the local thread projection`);
    assert.equal(replyHit.parentChannelId, local.id);
    assert.equal(replyHit.parentChannelName, local.name);
    for (const row of [rootHit, replyHit]) {
      assert.notEqual(row.channelId, joint.canonical.id);
      assert.notEqual(row.parentChannelId, joint.canonical.id);
      assert.notEqual(row.threadId, thread.canonicalThreadChannelId);
    }
  };
  expectJointHits(await humanSearch(member, "jointneedle"), "member");
  const agentHits = await agentSearches("jointneedle");
  expectJointHits(agentHits.legacy, "agent /internal/agent/:id/search");
  expectJointHits(agentHits.agentApi, "agent /internal/agent-api/search");
  assert.deepEqual(await humanSearch(outsider, "jointneedle"), [], "a server member outside the joint finds nothing");

  // Channel filter by the local projection id reaches the canonical stream.
  const scoped = await http.as(member, server).get(`/api/messages/search?${new URLSearchParams({ q: "jointneedle", channelId: local.id })}`);
  assert.equal(scoped.status, 200);
  assert.deepEqual(((await scoped.json()) as SearchBody).results.map((row) => row.id).sort(), [root.id, reply.id].sort());

  for (const human of [owner, member]) {
    const ids = (await humanSearch(human, "allneedle")).map((row) => row.id);
    assert.ok(ids.includes(openMessage.id), "witness: the public message is found");
    assert.ok(!ids.includes(allMessage.id), "a hidden #all is not searchable, stale membership rows notwithstanding");
  }
  const agentAll = await agentSearches("allneedle");
  for (const results of [agentAll.legacy, agentAll.agentApi]) {
    assert.ok(results.some((row) => row.id === openMessage.id));
    assert.ok(!results.some((row) => row.id === allMessage.id), "agent: a hidden #all is not searchable");
  }
});

test("guest search results are its one bound channel's; a guest-visible channel, another it is in, and its DM stay unsearchable", async ({ seed, http }) => {
  const db = getDb();
  const owner = await seed.human();
  const guest = await seed.human();
  const server = await seed.server({ owner, members: [guest] });
  const agent = await createAgent(server.id, `search-guest-agent-${randomUUID().slice(0, 8)}`, { runtime: "codex" });

  const label = () => randomUUID().slice(0, 8);
  // The guest's one channel (#wg-rbac:#15).
  const guestHome = await createChannel(server.id, `search-guest-home-${label()}`, undefined, "private");
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: guestHome.id });
  const guestOpen = await createChannel(server.id, `search-guest-open-${label()}`);
  await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, guestOpen.id));
  const hiddenFromGuest = await createChannel(server.id, `search-guest-hidden-${label()}`);
  const guestPrivate = await createChannel(server.id, `search-guest-private-${label()}`, undefined, "private");
  await addHuman(guestPrivate.id, guest.id);
  const guestDm = (await findOrCreateDM(server.id, guest.id, agent.id))!;

  const homeMessage = await createMessage(guestHome.id, "user", owner.id, "guestneedle guest home channel");
  const homeThread = await getOrCreateThreadForChannel(guestHome.id, homeMessage.id, owner.id, "user");
  const homeReply = await createMessage(homeThread.id, "user", owner.id, "guestneedle guest home thread reply");
  await createMessage(guestOpen.id, "user", owner.id, "guestneedle guest visible channel");
  await createMessage(guestPrivate.id, "user", owner.id, "guestneedle guest private channel");
  await createMessage(hiddenFromGuest.id, "user", owner.id, "guestneedle not guest visible");
  const dmMessage = await createMessage(guestDm.id, "agent", agent.id, "guestneedle in the guest dm");

  const res = await http.as(guest, server).get(`/api/messages/search?${new URLSearchParams({ q: "guestneedle" })}`);
  const body = await res.json() as SearchBody;
  assert.equal(res.status, 200, body.error);
  // Exactly its channel and that channel's thread.
  assert.deepEqual(body.results.map((row) => row.id).sort(), [homeMessage.id, homeReply.id].sort());

  // A Guest has no DMs: the single check and canView agree with search.
  assert.equal(await canUserAccessChannel(guestDm.id, guest.id, asServerId(server.id)), false);
  assert.deepEqual(await canView({ type: "user", id: guest.id, serverId: asServerId(server.id) }, [{ kind: "conversation", channelId: guestDm.id }]), [false]);
  assert.ok(!body.results.some((row) => row.id === dmMessage.id), "guest DMs are not searchable");
});
