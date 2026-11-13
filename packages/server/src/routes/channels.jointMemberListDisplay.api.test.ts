import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { apiTest } from "../test/integration/apiTest";
import { servers } from "../db/schema";
import { createAgent } from "../services/agentService";
import { acceptJointChannelInvite, addAgent, addHuman, createJointChannel, disconnectJointChannel } from "../services/channelService";
import { removeMember } from "../services/serverService";
import { seedBoundGuest } from "../test/guestFixture";

type Roster = {
  agents: Array<{ id: string; inViewerServer?: boolean }>;
  humans: Array<{ id: string; inViewerServer?: boolean; effectiveChannelRole: string; servers: Array<{ id: string; name: string }> }>;
};

// Joint member-list display (cindyz 2026-11-04, #wg-rbac:fc8d488f msg 3777f504):
// group by membership of the viewed server V; tags = active sources minus V.
apiTest("computed joint member list groups by the viewed server and tags only current sources", async ({ db, seed, http }) => {
  const ownerA = await seed.human(), ownerB = await seed.human(), ownerC = await seed.human();
  const bob = await seed.human(), dana = await seed.human(), ebby = await seed.human(), gus = await seed.human();
  const a = await seed.server({ owner: ownerA, name: "Alpha", members: [bob, dana, ebby, gus] });
  const b = await seed.server({ owner: ownerB, name: "Bravo", members: [bob, ebby] });
  const c = await seed.server({ owner: ownerC, name: "Charlie", members: [dana] });
  await seedBoundGuest({ serverId: b.id, userId: gus.id }, db);
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, a.id));
  const made = await createJointChannel({
    hostServerId: a.id,
    createdByUserId: ownerA.id,
    name: "member-list-display",
    jointInvites: [
      { targetServerSlug: b.slug, invitedPeople: [`@${ownerB.name}`] },
      { targetServerSlug: c.slug, invitedPeople: [`@${ownerC.name}`] },
    ],
  });
  const inviteFor = (serverId: string) => made.invites.find((invite) => invite.toServerId === serverId)!.id;
  const entryB = await acceptJointChannelInvite({ inviteId: inviteFor(b.id), targetServerId: b.id, acceptedByUserId: ownerB.id });
  const entryC = await acceptJointChannelInvite({ inviteId: inviteFor(c.id), targetServerId: c.id, acceptedByUserId: ownerC.id });
  // Sources: bob through B; ebby and gus through A; dana through A and C.
  await addHuman(entryB.id, bob.id);
  await addHuman(made.channel.id, ebby.id);
  await addHuman(made.channel.id, gus.id);
  await addHuman(made.channel.id, dana.id);
  // Re-adding a member through C records nothing; a source through C is what
  // a connection of C for her writes (a multi-server connect).
  await addHuman(entryC.id, dana.id);
  await db.execute(sql`INSERT INTO joint_channel_admissions (joint_channel_id, user_id, server_id, generation)
    SELECT m.joint_channel_id, m.user_id, ${c.id}::uuid, m.generation FROM joint_channel_members m
    WHERE m.joint_channel_id=${made.jointChannel.id}::uuid AND m.user_id=${dana.id}::uuid`);
  const bravoAgent = await createAgent(b.id, "BravoAgent", { runtime: "claude", model: "sonnet" });
  await addAgent(entryB.id, bravoAgent.id);

  const roster = async (viewer: { id: string }, server: { id: string }, channelId: string) => {
    const response = await http.as(viewer, server).get(`/api/channels/${channelId}/members`);
    assert.equal(response.status, 200);
    return (await response.json()) as Roster;
  };
  const row = (r: Roster, user: { id: string }) => {
    const found = r.humans.find((human) => human.id === user.id);
    assert.ok(found, `${user.id} is listed`);
    return { inViewerServer: found.inViewerServer, tags: found.servers.map((server) => server.name).sort(), role: found.effectiveChannelRole };
  };

  const fromA = await roster(ownerA, a, made.channel.id);
  const fromB = await roster(ownerB, b, entryB.id);
  const fromC = await roster(ownerC, c, entryC.id);
  // (a) member of V, source only V: V group, no tag.
  assert.equal(row(fromA, ownerA).inViewerServer, true);
  assert.deepEqual(row(fromA, ownerA).tags, []);
  // (b) member of V, source elsewhere: V group, that source's tag.
  assert.deepEqual(row(fromA, bob), { inViewerServer: true, tags: ["Bravo"], role: "member" });
  // (c) not a member of V, sources A and C: other group, both tags.
  assert.deepEqual(row(fromB, dana), { inViewerServer: false, tags: ["Alpha", "Charlie"], role: "member" });
  // (d) ebby belongs to A and B, source A. B membership is never a tag.
  assert.deepEqual(row(fromA, ebby), { inViewerServer: true, tags: [], role: "member" });
  assert.deepEqual(row(fromB, ebby), { inViewerServer: true, tags: ["Alpha"], role: "member" });
  assert.deepEqual(row(fromC, ebby), { inViewerServer: false, tags: ["Alpha"], role: "member" });
  // (f) a guest of V is in V's group and keeps the guest label.
  assert.deepEqual(row(fromB, gus), { inViewerServer: true, tags: ["Alpha"], role: "guest" });
  assert.deepEqual(row(fromA, gus), { inViewerServer: true, tags: [], role: "member" });

  // Agents belong to their one server.
  assert.equal(fromB.agents.find((agent) => agent.id === bravoAgent.id)?.inViewerServer, true);
  assert.equal(fromA.agents.find((agent) => agent.id === bravoAgent.id)?.inViewerServer, false);

  // (e) a source whose server disconnected is not shown.
  await disconnectJointChannel(entryC.id, ownerC.id);
  const afterDisconnect = await roster(ownerB, b, entryB.id);
  assert.deepEqual(row(afterDisconnect, dana), { inViewerServer: false, tags: ["Alpha"], role: "member" });

  // Leaving a source server drops its tag at once (so "also a member of" stays true),
  // before any leave-when-no-source rule: bob, in through B, leaves B and stays via A.
  await removeMember(b.id, bob.id);
  const afterLeave = await roster(ownerA, a, made.channel.id);
  assert.deepEqual(row(afterLeave, bob), { inViewerServer: true, tags: [], role: "member" });
});
