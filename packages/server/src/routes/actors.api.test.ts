import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { ActorResolveResponse, ResolvedActor } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, jointChannels, jointChannelServers, servers, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman } from "../services/channelService";
import { addMember } from "../services/serverService";
import { seedBoundGuest } from "../test/guestFixture";
import { apiTest as test } from "../test/integration/apiTest";
import type { createHttpClient } from "../test/integration/http";
import { seedJointChannel } from "../test/integration/jointFixture";
import type { createSeed } from "../test/integration/seed";

// POST /api/actors/resolve (routes/actors.ts, services/actorResolveService.ts):
// batched display identity. Each denial case carries a witness that the same
// request resolves when access is granted, so "absent" means "filtered".

type Seed = ReturnType<typeof createSeed>;
type Http = ReturnType<typeof createHttpClient>;
type Ref = { kind: "human" | "agent"; id: string };

async function fixture(seed: Seed) {
  const owner = await seed.human();
  const requester = await seed.human();
  const colleague = await seed.human();
  const server = await seed.server({ owner, members: [requester, colleague] });
  const localAgent = await createAgent(server.id, `local-${randomUUID().slice(0, 8)}`, { runtime: "claude", displayName: "Local Agent" });
  const deletedAgent = await createAgent(server.id, `gone-${randomUUID().slice(0, 8)}`, { runtime: "claude" });
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, deletedAgent.id));

  const peerOwner = await seed.human();
  const peerHuman = await seed.human({ avatarUrl: "https://example.test/peer.png" });
  const peerServer = await seed.server({ owner: peerOwner, members: [peerHuman] });
  const peerAgent = await createAgent(peerServer.id, `peer-${randomUUID().slice(0, 8)}`, { runtime: "claude" });

  const joint = await seedJointChannel({ name: `joint-${randomUUID().slice(0, 8)}`, serverIds: [server.id, peerServer.id], createdByUserId: owner.id });
  const [localProjection, peerProjection] = joint.projections;
  await addHuman(localProjection!.id, requester.id);
  await addHuman(peerProjection!.id, peerHuman.id);
  await addAgent(peerProjection!.id, peerAgent.id);
  return { owner, requester, colleague, server, localAgent, deletedAgent, peerHuman, peerServer, peerAgent, joint, localProjection: localProjection!, peerProjection: peerProjection! };
}

async function resolve(http: Http, as: { id: string }, server: { id: string }, actors: unknown) {
  const response = await http.as(as, server).request("/api/actors/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actors }),
  });
  return response;
}

async function resolved(http: Http, as: { id: string }, server: { id: string }, actors: Ref[]): Promise<ResolvedActor[]> {
  const response = await resolve(http, as, server, actors);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return ((await response.json()) as ActorResolveResponse).actors;
}

const ids = (actors: ResolvedActor[]) => actors.map((actor) => `${actor.kind}:${actor.id}`).sort();
const human = (id: string): Ref => ({ kind: "human", id });
const agent = (id: string): Ref => ({ kind: "agent", id });

test("resolves same-server humans and agents, deleted agents included, with identity fields only", async ({ seed, http }) => {
  const f = await fixture(seed);
  const actors = await resolved(http, f.requester, f.server, [
    human(f.colleague.id), human(f.requester.id), agent(f.localAgent.id), agent(f.deletedAgent.id), human(f.colleague.id),
  ]);
  assert.deepEqual(ids(actors), ids([
    { kind: "human", id: f.colleague.id }, { kind: "human", id: f.requester.id },
    { kind: "agent", id: f.localAgent.id }, { kind: "agent", id: f.deletedAgent.id },
  ] as ResolvedActor[]), "deduped, all four resolved");
  const colleague = actors.find((actor) => actor.id === f.colleague.id)!;
  assert.deepEqual(colleague, {
    kind: "human",
    id: f.colleague.id,
    homeServerId: f.server.id,
    name: f.colleague.name,
    displayName: f.colleague.displayName,
    avatarUrl: null,
    // Deprecated, always empty: Raft no longer uses Gravatar.
    gravatarHash: "",
  });
  const localAgent = actors.find((actor) => actor.id === f.localAgent.id)!;
  assert.deepEqual(localAgent, {
    kind: "agent", id: f.localAgent.id, homeServerId: f.server.id, name: f.localAgent.name, displayName: "Local Agent", avatarUrl: null, gravatarHash: null,
  });
  for (const actor of actors) {
    assert.deepEqual(Object.keys(actor).sort(), ["avatarUrl", "displayName", "gravatarHash", "homeServerId", "id", "kind", "name"]);
  }
  // A kind mismatch does not resolve: an agent id asked as a human is absent.
  assert.deepEqual(await resolved(http, f.requester, f.server, [human(f.localAgent.id)]), []);
});

test("resolves joint-channel peers only for a requester in an active joint channel", async ({ seed, http }) => {
  const f = await fixture(seed);
  const actors = await resolved(http, f.requester, f.server, [human(f.peerHuman.id), agent(f.peerAgent.id)]);
  assert.deepEqual(actors.find((actor) => actor.kind === "human"), {
    kind: "human", id: f.peerHuman.id, homeServerId: f.peerServer.id, name: f.peerHuman.name, displayName: f.peerHuman.displayName,
    avatarUrl: "https://example.test/peer.png", gravatarHash: null,
  });
  assert.deepEqual(actors.find((actor) => actor.kind === "agent"), {
    kind: "agent", id: f.peerAgent.id, homeServerId: f.peerServer.id, name: f.peerAgent.name, displayName: f.peerAgent.displayName ?? null,
    avatarUrl: null, gravatarHash: null,
  });
  // The colleague is a member of this server but not of the joint channel.
  assert.deepEqual(await resolved(http, f.colleague, f.server, [human(f.peerHuman.id), agent(f.peerAgent.id)]), []);
  // A peer agent that left the peer projection is no longer visible.
  const otherPeerAgent = await createAgent(f.peerServer.id, `peer-other-${randomUUID().slice(0, 8)}`, { runtime: "claude" });
  assert.deepEqual(await resolved(http, f.requester, f.server, [agent(otherPeerAgent.id)]), []);
});

test("an inactive joint channel or projection hides peers (deleting a projection disconnects it)", async ({ seed, http }) => {
  const f = await fixture(seed);
  const db = getDb();
  const refs = [human(f.peerHuman.id), agent(f.peerAgent.id)];
  const visible = async () => ids(await resolved(http, f.requester, f.server, refs));
  const both = [`agent:${f.peerAgent.id}`, `human:${f.peerHuman.id}`].sort();
  assert.deepEqual(await visible(), both, "witness: visible while everything is active");

  const projection = (serverId: string) => and(eq(jointChannelServers.jointChannelId, f.joint.jointChannelId), eq(jointChannelServers.serverId, serverId));
  await db.update(jointChannelServers).set({ status: "disconnected" }).where(projection(f.peerServer.id));
  assert.deepEqual(await visible(), [], "peer projection disconnected");
  await db.update(jointChannelServers).set({ status: "active" }).where(projection(f.peerServer.id));
  await db.update(jointChannelServers).set({ status: "disconnected" }).where(projection(f.server.id));
  assert.deepEqual(await visible(), [], "local projection disconnected");
  await db.update(jointChannelServers).set({ status: "active" }).where(projection(f.server.id));

  await db.update(jointChannels).set({ status: "closed" }).where(eq(jointChannels.id, f.joint.jointChannelId));
  assert.deepEqual(await visible(), [], "joint channel closed");
  await db.update(jointChannels).set({ status: "active" }).where(eq(jointChannels.id, f.joint.jointChannelId));
  assert.deepEqual(await visible(), both, "witness: visible again once reactivated");

});

test("a deleted peer agent is not resolved through the joint channel", async ({ seed, http }) => {
  const f = await fixture(seed);
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, f.peerAgent.id));
  assert.deepEqual(await resolved(http, f.requester, f.server, [agent(f.peerAgent.id)]), []);
});

test("unknown and forbidden ids get the same answer", async ({ seed, http }) => {
  const f = await fixture(seed);
  const outsider = await seed.human();
  await seed.server({ owner: outsider });
  const forbidden = await resolve(http, f.colleague, f.server, [human(f.peerHuman.id), human(outsider.id), agent(f.peerAgent.id)]);
  const unknown = await resolve(http, f.colleague, f.server, [human(randomUUID()), human(randomUUID()), agent(randomUUID())]);
  assert.equal(forbidden.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(await forbidden.json(), { actors: [] });
  assert.deepEqual(await unknown.json(), { actors: [] });
});

// Only its owner finds a personal assistant (agentFindableBy): by id it is
// absent for anyone else, exactly like an id that does not exist.
test("another person's assistant resolves only for its owner", async ({ seed, http }) => {
  const f = await fixture(seed);
  const assistant = await createAgent(f.server.id, `assistant-${randomUUID().slice(0, 8)}`, {
    runtime: "external", model: "external", creatorType: "user", creatorId: f.colleague.id, kind: "personal_assistant",
  });
  await getDb().update(agents).set({ assistantOwnerUserId: f.colleague.id }).where(eq(agents.id, assistant.id));
  for (const viewer of [f.requester, f.owner]) {
    assert.deepEqual(ids(await resolved(http, viewer, f.server, [agent(assistant.id), agent(f.localAgent.id)])), [`agent:${f.localAgent.id}`]);
  }
  assert.deepEqual(ids(await resolved(http, f.colleague, f.server, [agent(assistant.id)])), [`agent:${assistant.id}`], "witness: its owner resolves it");
});

test("a same-server member who is also a joint peer is reported as this server's member", async ({ seed, http }) => {
  const f = await fixture(seed);
  await addMember(f.server.id, f.peerHuman.id);
  const [actor] = await resolved(http, f.requester, f.server, [human(f.peerHuman.id)]);
  assert.equal(actor?.homeServerId, f.server.id);
  assert.equal(actor?.gravatarHash, "");
  // Seen from the peer server, the requester is a joint peer from this server.
  const [fromPeer] = await resolved(http, f.peerHuman, f.peerServer, [human(f.requester.id)]);
  assert.equal(fromPeer?.homeServerId, f.server.id);
  assert.equal(fromPeer?.gravatarHash, null);
});

test("a hidden human directory resolves only self, exposed humans and channel peers", async ({ seed, http }) => {
  const f = await fixture(seed);
  const channelPeer = await seed.human();
  await addMember(f.server.id, channelPeer.id);
  await seed.channel({ server: f.server, members: [f.requester, channelPeer], visibility: "private" });
  const refs = [human(f.requester.id), human(f.colleague.id), human(channelPeer.id), human(f.owner.id), agent(f.localAgent.id)];
  const everyone = [`human:${f.requester.id}`, `human:${f.colleague.id}`, `human:${channelPeer.id}`, `human:${f.owner.id}`, `agent:${f.localAgent.id}`].sort();
  assert.deepEqual(ids(await resolved(http, f.requester, f.server, refs)), everyone, "witness: open directory");

  await getDb().update(servers).set({ hideHumansFromMembers: true }).where(eq(servers.id, f.server.id));
  assert.deepEqual(ids(await resolved(http, f.requester, f.server, refs)), [`human:${f.requester.id}`, `human:${channelPeer.id}`, `agent:${f.localAgent.id}`].sort());
  // An owner is not subject to the hidden directory.
  assert.deepEqual(ids(await resolved(http, f.owner, f.server, refs)), everyone);
});

test("guests are refused the whole route", async ({ seed, http }) => {
  const f = await fixture(seed);
  await seedBoundGuest({ serverId: f.server.id, userId: f.colleague.id });
  const response = await resolve(http, f.colleague, f.server, [human(f.colleague.id)]);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  // Witness: a member with the same request is answered.
  assert.equal((await resolve(http, f.requester, f.server, [human(f.colleague.id)])).status, 200);
});

test("invalid bodies are 400; more than 200 actors is 400", async ({ seed, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const many = (count: number) => Array.from({ length: count }, () => human(randomUUID()));
  assert.equal((await resolve(http, owner, server, many(200))).status, 200);
  assert.equal((await resolve(http, owner, server, many(201))).status, 400);
  assert.equal((await resolve(http, owner, server, [])).status, 400);
  assert.equal((await resolve(http, owner, server, [{ kind: "machine", id: randomUUID() }])).status, 400);
  assert.equal((await resolve(http, owner, server, [{ kind: "human", id: "not-a-uuid" }])).status, 400);
  assert.equal((await resolve(http, owner, server, [{ kind: "human", id: randomUUID(), extra: 1 }])).status, 400);
  const extraTopLevel = await http.as(owner, server).request("/api/actors/resolve", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actors: [human(owner.id)], more: true }),
  });
  assert.equal(extraTopLevel.status, 400);
  const tooLarge = await http.as(owner, server).request("/api/actors/resolve", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actors: many(200), pad: "x".repeat(40_000) }),
  });
  assert.equal(tooLarge.status, 413);
});

test("email and role never appear in the answer", async ({ seed, http }) => {
  const f = await fixture(seed);
  const response = await resolve(http, f.owner, f.server, [human(f.colleague.id), human(f.owner.id)]);
  const text = await response.text();
  const [colleagueRow] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, f.colleague.id));
  assert.equal(text.includes(colleagueRow!.email), false);
  assert.equal(text.includes(f.owner.email), false);
  assert.equal(/"(email|role)"/.test(text), false);
});
