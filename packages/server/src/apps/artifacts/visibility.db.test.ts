// Who can see an Artifact (technical design §3.1): the matrix of homes ×
// actors, deleted items, orphans (the platform's rule, first-party app
// mechanism §八: a home conversation soft-deleted, or hard-deleted and its id
// cleared by the foreign key), homes that are not top-level conversations of
// the item's server, a home in a joint channel (its canonical channel, seen
// from every participating server through that server's projection),
// removed members and deleted agents, the list predicate, and a constant
// number of queries for any number of items.
import { fillJointMembersFromChannelHumans } from "../../test/jointMemberFill";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { asServerId, type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { agents, channels, jointChannelServers, serverMembers, tasks } from "../../db/schema";
import { createAgent } from "../../services/agentService";
import {
  addAgent,
  addHuman,
  canUserAccessChannel,
  createChannel,
  deleteChannel,
  disconnectJointChannel,
  filterAgentAccessibleChannelIds,
  findOrCreateDM,
  getOrCreateThreadForChannel,
} from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { runChannelConversionJob, startChannelToJointConversion } from "../../services/channelConversionService";
import { createMessage } from "../../services/messageService";
import { addMember } from "../../services/serverService";
import { createTaskConversationsInTransaction } from "../../services/taskConversationService";
import type { ServerViewActor, ViewActor } from "../../services/visibilityService";
import { localConversationIds } from "../../platform/conversations";
import { dbTest as test } from "../../test/integration/dbTest";
import { seedJointChannel } from "../../test/integration/jointFixture";
import type { createSeed } from "../../test/integration/seed";
import { artifactItems, type ArtifactActorType, type ArtifactHomeKind } from "./schema";
import { actorsWhoCanViewArtifact, canViewArtifacts, visibleArtifactsSql, type ArtifactVisibilitySubject } from "./visibility";
import { seedBoundGuest } from "../../test/guestFixture";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };

async function countQueries<T>(fn: () => Promise<T>): Promise<{ queries: number; value: T }> {
  const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
  const originalQuery = pg.query.bind(pg);
  let queries = 0;
  pg.query = ((...args: unknown[]) => {
    queries += 1;
    return originalQuery(...args);
  }) as PgliteLike["query"];
  try {
    const value = await fn();
    return { queries, value };
  } finally {
    pg.query = originalQuery;
  }
}

/** The deployment has Artifacts (workspace_artifacts_v0 answers on). */
function artifactsOn() {
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
}

async function insertItem(input: {
  serverId: ServerId;
  homeKind: ArtifactHomeKind;
  homeChannelId?: string | null;
  author: { type: ArtifactActorType; id: string };
  deleted?: boolean;
  revoked?: boolean;
}) {
  const id = `pt_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const [row] = await getDb().insert(artifactItems).values({
    id,
    serverId: input.serverId,
    urlKey: id,
    name: id,
    title: `Artifact ${id}`,
    homeKind: input.homeKind,
    homeChannelId: input.homeChannelId ?? null,
    createdByType: input.author.type,
    createdById: input.author.id,
    deletedAt: input.deleted ? new Date() : null,
    revokedAt: input.revoked ? new Date() : null,
  }).returning();
  return row!;
}

/**
 * One server with a public channel (plus a guest-visible and an archived one),
 * a private channel, a human-agent DM, a joint channel, a thread and a private
 * channel that gets deleted, plus a peer server in the joint channel and a
 * stranger's server outside it. On the peer, memberPeer and agentPeer are in
 * the peer's projection of the joint; its owner (outsider) and outsiderAgent
 * are not. A removed member and a deleted agent keep their stale channel
 * membership rows.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const db = getDb();
  const label = () => randomUUID().slice(0, 8);
  const owner = await seed.human();
  const admin = await seed.human();
  const memberIn = await seed.human();
  const memberOut = await seed.human();
  const guest = await seed.human();
  const removed = await seed.human();
  const peerOwner = await seed.human();
  const peerMember = await seed.human();
  const strangerOwner = await seed.human();
  const server = await seed.server({ owner, members: [admin, memberIn, memberOut, guest, removed] });
  const peer = await seed.server({ owner: peerOwner, members: [peerMember] });
  const stranger = await seed.server({ owner: strangerOwner });
  const serverId = asServerId(server.id);
  const peerId = asServerId(peer.id);
  const strangerId = asServerId(stranger.id);
  await db.update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, admin.id)));
  artifactsOn();

  // agentIn is managed by memberIn (its human creator).
  const agentIn = await createAgent(server.id, `art-agent-in-${label()}`, { runtime: "claude", model: "sonnet", creatorType: "user", creatorId: memberIn.id });
  const agentOut = await createAgent(server.id, `art-agent-out-${label()}`, { runtime: "claude", model: "sonnet", creatorType: "user", creatorId: owner.id });
  const peerAgent = await createAgent(peer.id, `art-peer-agent-${label()}`, { runtime: "claude", model: "sonnet" });
  const peerAgentIn = await createAgent(peer.id, `art-peer-agent-in-${label()}`, { runtime: "claude", model: "sonnet" });
  const deletedAgent = await createAgent(server.id, `art-agent-deleted-${label()}`, { runtime: "claude", model: "sonnet" });

  const pub = await createChannel(server.id, `art-public-${label()}`);
  await addHuman(pub.id, memberIn.id);
  const priv = await createChannel(server.id, `art-private-${label()}`, undefined, "private");
  await addHuman(priv.id, memberIn.id);
  // The guest belongs to #priv, its one channel (#wg-rbac:#15); its other memberships grant it nothing.
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: priv.id });
  await addAgent(priv.id, agentIn.id);
  const dm = (await findOrCreateDM(server.id, memberIn.id, agentIn.id))!;
  const gone = await createChannel(server.id, `art-gone-${label()}`, undefined, "private");
  for (const id of [memberIn.id, guest.id]) await addHuman(gone.id, id);
  await addAgent(gone.id, agentIn.id);
  const guestVisible = await createChannel(server.id, `art-guest-visible-${label()}`);
  await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, guestVisible.id));
  const archived = await createChannel(server.id, `art-archived-${label()}`);
  const joint = await seedJointChannel({ name: `art-joint-${label()}`, serverIds: [server.id, peer.id], createdByUserId: owner.id });
  const [jointLocal, jointPeer] = joint.projections as [typeof pub, typeof pub];
  await addHuman(jointLocal.id, memberIn.id);
  await addAgent(jointLocal.id, agentIn.id);
  await addHuman(jointPeer.id, peerMember.id);
  await addAgent(jointPeer.id, peerAgentIn.id);
  const root = await createMessage(pub.id, "user", owner.id, `art thread root ${label()}`);
  const thread = await getOrCreateThreadForChannel(pub.id, root.id, owner.id, "user");
  for (const channel of [pub, priv, guestVisible, archived, jointLocal]) {
    await addHuman(channel.id, removed.id);
    await addAgent(channel.id, deletedAgent.id);
  }
  await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, archived.id));
  await db.delete(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, removed.id)));
  await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, deletedAgent.id));

  const actors = {
    owner: { type: "user", id: owner.id, serverId },
    admin: { type: "user", id: admin.id, serverId },
    memberIn: { type: "user", id: memberIn.id, serverId },
    memberOut: { type: "user", id: memberOut.id, serverId },
    guest: { type: "user", id: guest.id, serverId },
    agentIn: { type: "agent", id: agentIn.id, serverId },
    agentOut: { type: "agent", id: agentOut.id, serverId },
    outsider: { type: "user", id: peerOwner.id, serverId: peerId },
    outsiderAgent: { type: "agent", id: peerAgent.id, serverId: peerId },
    memberPeer: { type: "user", id: peerMember.id, serverId: peerId },
    agentPeer: { type: "agent", id: peerAgentIn.id, serverId: peerId },
    stranger: { type: "user", id: strangerOwner.id, serverId: strangerId },
    removedMember: { type: "user", id: removed.id, serverId },
    deletedAgent: { type: "agent", id: deletedAgent.id, serverId },
  } satisfies Record<string, ViewActor>;
  return {
    serverId,
    peerId,
    channels: { pub, priv, dm, gone, guestVisible, archived, jointLocal, jointPeer, jointCanonical: joint.canonical, thread },
    actors,
    people: { owner, memberIn, memberOut, guest, agentIn, peerMember, peerAgentIn },
  };
}

type World = Awaited<ReturnType<typeof seedWorld>>;
type ActorName = keyof World["actors"];

async function seedItems(world: World) {
  const { serverId, peerId, channels: c, people } = world;
  const author = { type: "user" as const, id: people.owner.id };
  const items = {
    publicChannel: await insertItem({ serverId, homeKind: "conversation", homeChannelId: c.pub.id, author }),
    guestVisibleChannel: await insertItem({ serverId, homeKind: "conversation", homeChannelId: c.guestVisible.id, author }),
    archivedChannel: await insertItem({ serverId, homeKind: "conversation", homeChannelId: c.archived.id, author }),
    // A home in a joint is its canonical channel (publish stores it so), whichever server published.
    jointCanonical: await insertItem({ serverId, homeKind: "conversation", homeChannelId: c.jointCanonical.id, author }),
    jointCanonicalOfPeer: await insertItem({ serverId: peerId, homeKind: "conversation", homeChannelId: c.jointCanonical.id, author: { type: "user", id: people.peerMember.id } }),
    // A server's projection of a joint, as a home (an older publish, or a channel converted since): read as the joint's.
    jointLocal: await insertItem({ serverId, homeKind: "conversation", homeChannelId: c.jointLocal.id, author }),
    // Not homes: a thread, a channel of another server than the item's.
    thread: await insertItem({ serverId, homeKind: "conversation", homeChannelId: c.thread.id, author }),
    crossServer: await insertItem({ serverId: peerId, homeKind: "conversation", homeChannelId: c.pub.id, author }),
    privateChannel: await insertItem({ serverId, homeKind: "conversation", homeChannelId: c.priv.id, author }),
    dm: await insertItem({ serverId, homeKind: "conversation", homeChannelId: c.dm.id, author: { type: "agent", id: people.agentIn.id } }),
    server: await insertItem({ serverId, homeKind: "server", author }),
    public: await insertItem({ serverId, homeKind: "public", author }),
    deletedPublic: await insertItem({ serverId, homeKind: "public", author, deleted: true }),
    deletedServer: await insertItem({ serverId, homeKind: "server", author, deleted: true }),
    orphanByMember: await insertItem({ serverId, homeKind: "conversation", homeChannelId: c.gone.id, author: { type: "user", id: people.memberOut.id } }),
    orphanByAgent: await insertItem({ serverId, homeKind: "conversation", homeChannelId: c.gone.id, author: { type: "agent", id: people.agentIn.id } }),
    orphanByGuest: await insertItem({ serverId, homeKind: "conversation", homeChannelId: c.gone.id, author: { type: "user", id: people.guest.id } }),
    // Orphans of a hard delete: a conversation home whose channel the foreign key set to NULL.
    orphanClearedByMember: await insertItem({ serverId, homeKind: "conversation", homeChannelId: null, author: { type: "user", id: people.memberOut.id } }),
    orphanClearedByAgent: await insertItem({ serverId, homeKind: "conversation", homeChannelId: null, author: { type: "agent", id: people.agentIn.id } }),
    orphanClearedByGuest: await insertItem({ serverId, homeKind: "conversation", homeChannelId: null, author: { type: "user", id: people.guest.id } }),
    orphanClearedDeleted: await insertItem({ serverId, homeKind: "conversation", homeChannelId: null, author: { type: "user", id: people.memberOut.id }, deleted: true }),
    // The peer server's orphan: only its owner (the outsider here) of all these actors.
    orphanClearedOfPeer: await insertItem({ serverId: peerId, homeKind: "conversation", homeChannelId: null, author: { type: "user", id: people.memberOut.id } }),
  };
  await getDb().update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, c.gone.id));
  return items;
}

type ItemName = keyof Awaited<ReturnType<typeof seedItems>>;

// §3.1: public channel visible to a non-joined non-guest member (D3), archived
// or not; an admin outside a private channel sees nothing there (D3); a guest
// only its one bound channel (#wg-rbac:#15; a guest-visible channel grants it
// nothing), never a server home (D4); agents follow the same rules (D5);
// another server's actor is an outsider: public only (C8); a removed member
// or deleted agent: public only, whatever rows it left; deleted: nobody;
// orphans (soft-deleted home or cleared channel alike): author, the author
// agent's manager, owner/admin, never listed; a home that is not a top-level
// conversation of the item's server: nobody. A home in a joint (its
// canonical channel): the joint's members on every participating server,
// each through its own server's projection, whichever server published it;
// nobody else of those servers, nobody of another server.
const NON_GUESTS = ["owner", "admin", "memberIn", "memberOut", "agentIn", "agentOut"] as const;
const SEEN_BY: Record<ItemName, readonly ActorName[]> = {
  publicChannel: NON_GUESTS,
  // guest_visible no longer opens a channel to guests (#wg-rbac:#15).
  guestVisibleChannel: NON_GUESTS,
  archivedChannel: NON_GUESTS,
  jointCanonical: ["memberIn", "agentIn", "memberPeer", "agentPeer"],
  jointCanonicalOfPeer: ["memberIn", "agentIn", "memberPeer", "agentPeer"],
  // Homed on the server's projection (published before publish stored the canonical channel): the joint's all the same.
  jointLocal: ["memberIn", "agentIn", "memberPeer", "agentPeer"],
  thread: [],
  crossServer: [],
  privateChannel: ["memberIn", "guest", "agentIn"],
  dm: ["memberIn", "agentIn"],
  server: NON_GUESTS,
  public: ["owner", "admin", "memberIn", "memberOut", "guest", "agentIn", "agentOut", "outsider", "outsiderAgent", "memberPeer", "agentPeer", "stranger", "removedMember", "deletedAgent"],
  deletedPublic: [],
  deletedServer: [],
  orphanByMember: ["owner", "admin", "memberOut"],
  orphanByAgent: ["owner", "admin", "memberIn", "agentIn"],
  orphanByGuest: ["owner", "admin"],
  orphanClearedByMember: ["owner", "admin", "memberOut"],
  orphanClearedByAgent: ["owner", "admin", "memberIn", "agentIn"],
  orphanClearedByGuest: ["owner", "admin"],
  orphanClearedDeleted: [],
  orphanClearedOfPeer: ["outsider"],
};
const sees = (actor: ActorName, item: ItemName) => SEEN_BY[item].includes(actor);

test("canViewArtifacts answers the §3.1 matrix, deleted items and orphans; visibleArtifactsSql lists the same minus orphans", async ({ seed }) => {
  const world = await seedWorld(seed);
  const items = await seedItems(world);
  const names = Object.keys(items) as ItemName[];
  const subjects: ArtifactVisibilitySubject[] = names.map((name) => items[name]);

  for (const [actorName, actor] of Object.entries(world.actors) as Array<[ActorName, ViewActor]>) {
    const answers = await canViewArtifacts(actor, subjects);
    assert.deepEqual(
      Object.fromEntries(names.map((name, index) => [name, answers[index]])),
      Object.fromEntries(names.map((name) => [name, sees(actorName, name)])),
      `${actorName}: canViewArtifacts`,
    );

    // The list predicate: the live, visible items of the actor's server and of
    // its joints; orphans are reached by id only, another server's public items too.
    const condition = await visibleArtifactsSql(actor);
    const listed = (await getDb().select({ id: artifactItems.id }).from(artifactItems).where(condition)).map((row) => row.id).sort();
    const expectedListed = names
      .filter((name) => sees(actorName, name) && !name.startsWith("orphan"))
      .filter((name) => items[name].serverId === actor.serverId || items[name].homeKind === "conversation")
      .map((name) => items[name].id)
      .sort();
    assert.deepEqual(listed, expectedListed, `${actorName}: visibleArtifactsSql`);
  }

  // Each answer is independent of its batch: one item at a time gives the same.
  for (const name of names) {
    assert.deepEqual(await canViewArtifacts(world.actors.memberIn, [items[name]]), [sees("memberIn", name)], `memberIn alone: ${name}`);
  }

  // Turned the other way (many actors, one item): the same matrix.
  const actorNames = Object.keys(world.actors) as ActorName[];
  for (const name of names) {
    const answers = await actorsWhoCanViewArtifact(actorNames.map((actorName) => world.actors[actorName]), items[name]);
    assert.deepEqual(
      Object.fromEntries(actorNames.map((actorName, index) => [actorName, answers[index]])),
      Object.fromEntries(actorNames.map((actorName) => [actorName, sees(actorName, name)])),
      `${name}: actorsWhoCanViewArtifact`,
    );
  }
  assert.deepEqual(await actorsWhoCanViewArtifact([], items.privateChannel), []);
  // requireStanding: a public item too only for those who stand in its server.
  const standing = await actorsWhoCanViewArtifact(actorNames.map((actorName) => world.actors[actorName]), items.public, { requireStanding: true });
  assert.deepEqual(actorNames.filter((_, index) => standing[index]).sort(), ["admin", "agentIn", "agentOut", "guest", "memberIn", "memberOut", "owner"]);
  assert.deepEqual(
    await actorsWhoCanViewArtifact(actorNames.map((actorName) => world.actors[actorName]), items.privateChannel, { requireStanding: true }),
    actorNames.map((actorName) => sees(actorName, "privateChannel")),
  );
  assert.deepEqual(await canViewArtifacts(world.actors.memberIn, []), []);
});

test("a revoked Artifact is seen by nobody and listed for nobody, its author included", async ({ seed }) => {
  const world = await seedWorld(seed);
  const { serverId, channels: c, people } = world;
  const author = { type: "user" as const, id: people.memberIn.id };
  const revoked = [
    await insertItem({ serverId, homeKind: "public", author, revoked: true }),
    await insertItem({ serverId, homeKind: "server", author, revoked: true }),
    await insertItem({ serverId, homeKind: "conversation", homeChannelId: c.priv.id, author, revoked: true }),
  ];
  for (const actorName of ["owner", "memberIn"] as const) {
    const actor = world.actors[actorName];
    assert.deepEqual(await canViewArtifacts(actor, revoked), [false, false, false], `${actorName}: canViewArtifacts`);
    const listed = await getDb().select({ id: artifactItems.id }).from(artifactItems).where(await visibleArtifactsSql(actor));
    assert.ok(!listed.some((row) => revoked.some((item) => item.id === row.id)), `${actorName}: visibleArtifactsSql`);
  }
});

test("an orphan's agent author stays visible to its personal-assistant owner, not to its creator", async ({ seed }) => {
  const world = await seedWorld(seed);
  const { serverId, channels: c, people } = world;
  const assistant = await createAgent(serverId, `art-helper-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet", creatorType: "user", creatorId: people.memberIn.id });
  await getDb().execute(sql`UPDATE agents SET assistant_owner_user_id = ${people.memberOut.id} WHERE id = ${assistant.id}`);
  const orphan = await insertItem({ serverId, homeKind: "conversation", homeChannelId: c.gone.id, author: { type: "agent", id: assistant.id } });
  await getDb().update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, c.gone.id));
  assert.deepEqual(await canViewArtifacts(world.actors.memberOut, [orphan]), [true], "the assistant's owner");
  assert.deepEqual(await canViewArtifacts(world.actors.memberIn, [orphan]), [false], "the creator of someone else's assistant");
});

test("a hard-deleted home channel: the delete goes through, its Artifacts become orphans the author, its agent's manager, owner and admin see by id; never listed", async ({ seed }) => {
  const world = await seedWorld(seed);
  const { serverId, people } = world;
  const home = await createChannel(serverId, `art-hard-${randomUUID().slice(0, 8)}`, undefined, "private");
  for (const id of [people.memberIn.id, people.memberOut.id, people.guest.id]) await addHuman(home.id, id);
  await addAgent(home.id, people.agentIn.id);
  const byMember = await insertItem({ serverId, homeKind: "conversation", homeChannelId: home.id, author: { type: "user", id: people.memberOut.id } });
  const byAgent = await insertItem({ serverId, homeKind: "conversation", homeChannelId: home.id, author: { type: "agent", id: people.agentIn.id } });
  const all = Object.keys(world.actors) as ActorName[];
  const seenBy = async (item: ArtifactVisibilitySubject) => {
    const byId: ActorName[] = [];
    for (const name of all) if ((await canViewArtifacts(world.actors[name], [item]))[0]) byId.push(name);
    const turned = await actorsWhoCanViewArtifact(all.map((name) => world.actors[name]), item);
    assert.deepEqual(all.filter((_, index) => turned[index]), byId, "actorsWhoCanViewArtifact agrees");
    return byId.sort();
  };
  // The guest is in it but bound to #priv (#wg-rbac:#15; channels are soft-deleted, a hard delete of a guest's bound channel is refused by its key): it sees nothing here.
  assert.deepEqual(await seenBy(byMember), ["agentIn", "memberIn", "memberOut"], "before: the channel's members, not an unbound guest");

  await getDb().delete(channels).where(eq(channels.id, home.id));
  const reread = async (item: { id: string }) => (await getDb().select().from(artifactItems).where(eq(artifactItems.id, item.id)))[0]!;
  const [memberOrphan, agentOrphan] = [await reread(byMember), await reread(byAgent)];
  assert.equal(memberOrphan.homeKind, "conversation");
  assert.equal(memberOrphan.homeChannelId, null);
  // The author, the author agent's manager (memberIn created agentIn), the owner and the admin; a guest never, even its author's channel-mate.
  assert.deepEqual(await seenBy(memberOrphan), ["admin", "memberOut", "owner"]);
  assert.deepEqual(await seenBy(agentOrphan), ["admin", "agentIn", "memberIn", "owner"]);
  for (const name of all) {
    const listed = await getDb().select({ id: artifactItems.id }).from(artifactItems).where(await visibleArtifactsSql(world.actors[name]));
    assert.ok(!listed.some((row) => row.id === byMember.id || row.id === byAgent.id), `${name}: an orphan is never listed`);
  }
});

test("canViewArtifacts runs a fixed number of queries however many items there are", async ({ seed }) => {
  const world = await seedWorld(seed);
  const { serverId, channels: c, people } = world;
  await getDb().update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, c.gone.id));
  const batch = async (size: number) => {
    const rows: ArtifactVisibilitySubject[] = [];
    for (let i = 0; i < size; i += 1) {
      const extra = await createChannel(serverId, `art-count-${randomUUID().slice(0, 8)}`, undefined, "private");
      await addHuman(extra.id, people.memberIn.id);
      await addAgent(extra.id, people.agentIn.id);
      rows.push(
        await insertItem({ serverId, homeKind: "conversation", homeChannelId: extra.id, author: { type: "user", id: people.memberIn.id } }),
        await insertItem({ serverId, homeKind: "conversation", homeChannelId: c.pub.id, author: { type: "user", id: people.memberIn.id } }),
        await insertItem({ serverId, homeKind: "server", author: { type: "user", id: people.memberIn.id } }),
        await insertItem({ serverId, homeKind: "public", author: { type: "user", id: people.memberIn.id } }),
        await insertItem({ serverId, homeKind: "public", author: { type: "user", id: people.memberIn.id }, deleted: true }),
        await insertItem({ serverId, homeKind: "conversation", homeChannelId: c.gone.id, author: { type: "agent", id: people.agentIn.id } }),
        await insertItem({ serverId, homeKind: "conversation", homeChannelId: null, author: { type: "agent", id: people.agentIn.id } }),
        await insertItem({ serverId, homeKind: "conversation", homeChannelId: c.jointCanonical.id, author: { type: "user", id: people.memberIn.id } }),
      );
    }
    return rows;
  };
  const few = await batch(2);
  const many = [...few, ...await batch(8)];
  for (const actorName of ["memberIn", "memberOut", "owner", "guest", "agentIn", "outsider", "memberPeer", "agentPeer", "stranger"] as const) {
    const actor = world.actors[actorName];
    const small = await countQueries(() => canViewArtifacts(actor, few));
    const large = await countQueries(() => canViewArtifacts(actor, many));
    assert.ok(small.queries > 0, `${actorName}: the count observes queries`);
    assert.equal(large.queries, small.queries, `${actorName}: ${small.queries} queries for ${few.length} items, ${large.queries} for ${many.length}`);
  }
  const memberIn = await canViewArtifacts(world.actors.memberIn, many);
  assert.equal(memberIn.filter(Boolean).length, many.length - many.length / 8, "fixture: memberIn sees all but the deleted items (orphans via its agent)");
  const memberPeer = await canViewArtifacts(world.actors.memberPeer, many);
  assert.equal(memberPeer.filter(Boolean).length, many.length / 4, "fixture: memberPeer sees the public and the joint items");
});

test("actorsWhoCanViewArtifact runs a fixed number of queries however many (non-guest) actors there are", async ({ seed }) => {
  const world = await seedWorld(seed);
  const items = await seedItems(world);
  const { serverId } = world;
  const actorsOf = async (count: number) => {
    const actors: ServerViewActor[] = [];
    for (let i = 0; i < count; i += 1) {
      const human = await seed.human();
      await addMember(serverId, human.id);
      const agent = await createAgent(serverId, `art-count-agent-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
      actors.push({ type: "user", id: human.id, serverId }, { type: "agent", id: agent.id, serverId });
    }
    return actors;
  };
  // And actors of the peer server, in its projection of the joint.
  const peerActorsOf = async (count: number) => {
    const actors: ServerViewActor[] = [];
    for (let i = 0; i < count; i += 1) {
      const human = await seed.human();
      await addMember(world.peerId, human.id);
      await addHuman(world.channels.jointPeer.id, human.id);
      const agent = await createAgent(world.peerId, `art-count-peer-agent-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
      await addAgent(world.channels.jointPeer.id, agent.id);
      actors.push({ type: "user", id: human.id, serverId: world.peerId }, { type: "agent", id: agent.id, serverId: world.peerId });
    }
    return actors;
  };
  const few = [...await actorsOf(2), ...await peerActorsOf(2)];
  const many = [...few, ...await actorsOf(8), ...await peerActorsOf(8)];
  const seeingJoint = await actorsWhoCanViewArtifact(many, items.jointCanonical);
  assert.equal(seeingJoint.filter(Boolean).length, 20, "fixture: the peer's actors in its projection see the joint's item");
  for (const name of ["publicChannel", "privateChannel", "jointCanonical", "jointLocal", "dm", "server", "orphanByAgent", "orphanClearedByAgent"] as const) {
    const small = await countQueries(() => actorsWhoCanViewArtifact(few, items[name]));
    const large = await countQueries(() => actorsWhoCanViewArtifact(many, items[name]));
    assert.ok(small.queries > 0, `${name}: the count observes queries`);
    assert.equal(large.queries, small.queries, `${name}: ${small.queries} queries for ${few.length} actors, ${large.queries} for ${many.length}`);
  }
});

// A joint channel is one conversation of every server in it: its messages and
// tasks live on the canonical channel and each server's members reach them
// through their own projection. An Artifact homed in the joint is the same:
// its home is the canonical channel, and it is seen by the joint's members on
// every participating server, through that server's active projection, and
// by nobody else, by id, turned around and listed alike.
test("an Artifact homed in a joint channel is seen by the joint's members on every participating server, by id, turned around and listed", async ({ seed }) => {
  const db = getDb();
  const label = () => randomUUID().slice(0, 8);
  const author = await seed.human();
  const hostMemberOut = await seed.human();
  const peerOwner = await seed.human();
  const peerMemberIn = await seed.human();
  const peerMemberOut = await seed.human();
  const formerMember = await seed.human();
  const host = await seed.server({ owner: author, members: [hostMemberOut] });
  const peer = await seed.server({ owner: peerOwner, members: [peerMemberIn, peerMemberOut] });
  const former = await seed.server({ owner: formerMember });
  artifactsOn();
  const hostId = asServerId(host.id);
  const peerId = asServerId(peer.id);
  const formerId = asServerId(former.id);
  const hostAgentIn = await createAgent(host.id, `aj-host-${label()}`, { runtime: "claude", model: "sonnet" });
  const peerAgentIn = await createAgent(peer.id, `aj-peer-in-${label()}`, { runtime: "claude", model: "sonnet" });
  const peerAgentOut = await createAgent(peer.id, `aj-peer-out-${label()}`, { runtime: "claude", model: "sonnet" });

  const joint = await seedJointChannel({ name: `art-joint-${label()}`, serverIds: [host.id, peer.id, former.id], createdByUserId: author.id });
  const [hostProjection, peerProjection, formerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical, typeof joint.canonical];
  await addHuman(hostProjection.id, author.id);
  await addAgent(hostProjection.id, hostAgentIn.id);
  await addHuman(peerProjection.id, peerMemberIn.id);
  await addAgent(peerProjection.id, peerAgentIn.id);
  await addHuman(formerProjection.id, formerMember.id);
  // The former server left the joint: its projection is disconnected, its member rows stay.
  await db.execute(sql`UPDATE joint_channel_servers SET status = 'disconnected' WHERE local_channel_id = ${formerProjection.id}`);

  const item = await insertItem({ serverId: hostId, homeKind: "conversation", homeChannelId: joint.canonical.id, author: { type: "user", id: author.id } });
  const actors = {
    author: { type: "user", id: author.id, serverId: hostId },
    hostAgentIn: { type: "agent", id: hostAgentIn.id, serverId: hostId },
    hostMemberOut: { type: "user", id: hostMemberOut.id, serverId: hostId },
    peerMemberIn: { type: "user", id: peerMemberIn.id, serverId: peerId },
    peerAgentIn: { type: "agent", id: peerAgentIn.id, serverId: peerId },
    peerMemberOut: { type: "user", id: peerMemberOut.id, serverId: peerId },
    peerAgentOut: { type: "agent", id: peerAgentOut.id, serverId: peerId },
    // A peer member asking through a server it is not in.
    peerMemberViaHost: { type: "user", id: peerMemberIn.id, serverId: hostId },
    formerMember: { type: "user", id: formerMember.id, serverId: formerId },
  } satisfies Record<string, ViewActor>;
  const names = Object.keys(actors) as Array<keyof typeof actors>;
  const expected = ["author", "hostAgentIn", "peerAgentIn", "peerMemberIn"];

  const byId: string[] = [];
  const listed: string[] = [];
  for (const name of names) {
    if ((await canViewArtifacts(actors[name], [item]))[0]) byId.push(name);
    const rows = await db.select({ id: artifactItems.id }).from(artifactItems).where(await visibleArtifactsSql(actors[name]));
    if (rows.some((row) => row.id === item.id)) listed.push(name);
  }
  assert.deepEqual(byId.sort(), expected, "canViewArtifacts");
  assert.deepEqual(listed.sort(), expected, "visibleArtifactsSql");
  const turned = await actorsWhoCanViewArtifact(names.map((name) => actors[name]), item);
  assert.deepEqual(names.filter((_, index) => turned[index]).sort(), expected, "actorsWhoCanViewArtifact");
});

/**
 * A joint between a host server (whose author publishes) and a peer, each
 * with a member and an agent in its projection, an Artifact of the host's
 * homed in it, and a message the host's member posted there.
 */
async function seedJointArtifact(seed: ReturnType<typeof createSeed>) {
  const label = () => randomUUID().slice(0, 8);
  const author = await seed.human();
  const peerOwner = await seed.human();
  const peerMember = await seed.human();
  const host = await seed.server({ owner: author });
  const peer = await seed.server({ owner: peerOwner, members: [peerMember] });
  artifactsOn();
  const hostId = asServerId(host.id);
  const peerId = asServerId(peer.id);
  const hostAgent = await createAgent(host.id, `ajd-host-${label()}`, { runtime: "claude", model: "sonnet" });
  const peerAgent = await createAgent(peer.id, `ajd-peer-${label()}`, { runtime: "claude", model: "sonnet" });
  const joint = await seedJointChannel({ name: `art-joint-${label()}`, serverIds: [host.id, peer.id], createdByUserId: author.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addHuman(hostProjection.id, author.id);
  await addAgent(hostProjection.id, hostAgent.id);
  await addHuman(peerProjection.id, peerMember.id);
  // Disconnecting takes an owner/admin who can open the copy (computed joint membership).
  await addHuman(peerProjection.id, peerOwner.id);
  await addAgent(peerProjection.id, peerAgent.id);
  await createMessage(joint.canonical.id, "user", author.id, `posted by the host before anyone left ${label()}`);
  const item = await insertItem({ serverId: hostId, homeKind: "conversation", homeChannelId: joint.canonical.id, author: { type: "user", id: author.id } });
  const actors = {
    author: { type: "user", id: author.id, serverId: hostId },
    hostAgent: { type: "agent", id: hostAgent.id, serverId: hostId },
    peerMember: { type: "user", id: peerMember.id, serverId: peerId },
    peerAgent: { type: "agent", id: peerAgent.id, serverId: peerId },
  } satisfies Record<string, ViewActor>;
  const projectionOf = { [hostId]: hostProjection.id, [peerId]: peerProjection.id } as Record<ServerId, string>;
  return { item, actors, hostProjection, peerProjection, author, peerOwner, projectionOf };
}

type JointArtifact = Awaited<ReturnType<typeof seedJointArtifact>>;

/** Who sees the item, by id, listed and turned around (asserted to agree); and who can read the joint's messages through their own projection. */
async function jointAnswers({ item, actors, projectionOf }: JointArtifact) {
  const names = Object.keys(actors) as Array<keyof typeof actors>;
  const byId: string[] = [];
  const listed: string[] = [];
  const messages: string[] = [];
  for (const name of names) {
    const actor = actors[name];
    if ((await canViewArtifacts(actor, [item]))[0]) byId.push(name);
    const rows = await getDb().select({ id: artifactItems.id }).from(artifactItems).where(await visibleArtifactsSql(actor));
    if (rows.some((row) => row.id === item.id)) listed.push(name);
    const projection = projectionOf[actor.serverId]!;
    const readsMessages = actor.type === "user"
      ? await canUserAccessChannel(projection, actor.id, actor.serverId)
      : (await filterAgentAccessibleChannelIds([projection], actor.id, actor.serverId)).has(projection);
    if (readsMessages) messages.push(name);
  }
  const turned = await actorsWhoCanViewArtifact(names.map((name) => actors[name]), item);
  assert.deepEqual(names.filter((_, index) => turned[index]).sort(), byId.sort(), "actorsWhoCanViewArtifact agrees with canViewArtifacts");
  assert.deepEqual(listed.sort(), byId.sort(), "visibleArtifactsSql agrees with canViewArtifacts");
  return { seenBy: byId.sort(), readMessages: messages.sort() };
}

test("a joint Artifact when the reader's server disconnects: that server's members and agents see nothing, as they read none of the joint's messages; the publisher's keep it", async ({ seed }) => {
  const world = await seedJointArtifact(seed);
  const before = await jointAnswers(world);
  assert.deepEqual(before.seenBy, ["author", "hostAgent", "peerAgent", "peerMember"]);
  assert.deepEqual(before.readMessages, before.seenBy, "before: whoever reads the joint's messages sees its Artifact");

  await disconnectJointChannel(world.peerProjection.id, world.peerOwner.id);
  const after = await jointAnswers(world);
  assert.deepEqual(after.seenBy, ["author", "hostAgent"]);
  assert.deepEqual(after.readMessages, after.seenBy, "after: the same people as the joint's messages");
});

// The publisher's server leaving the joint (disconnecting, deleting its
// projection, or the joint closing) takes the Artifact from every other
// server, and leaves it on the publisher's server as an orphan (Tenny, F3):
// its author, the author agent's manager and the server's owners and admins
// see it by id; no list shows it.
for (const leaving of ["disconnects", "deletes its projection", "closes the joint"] as const) {
  test(`a joint Artifact when its publisher's server ${leaving}: the other servers see it no more; on the publisher's server it is an orphan (author, the author agent's manager, owners and admins, by id only)`, async ({ seed }) => {
    const db = getDb();
    const label = () => randomUUID().slice(0, 8);
    const owner = await seed.human();
    const admin = await seed.human();
    const author = await seed.human();
    const manager = await seed.human();
    const other = await seed.human();
    const peerOwner = await seed.human();
    const peerMember = await seed.human();
    const host = await seed.server({ owner, members: [admin, author, manager, other] });
    const peer = await seed.server({ owner: peerOwner, members: [peerMember] });
    await db.update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, host.id), eq(serverMembers.userId, admin.id)));
    artifactsOn();
    const hostId = asServerId(host.id);
    const peerId = asServerId(peer.id);
    const authorAgent = await createAgent(host.id, `ajl-agent-${label()}`, { runtime: "claude", model: "sonnet", creatorType: "user", creatorId: manager.id });
    const peerAgent = await createAgent(peer.id, `ajl-peer-${label()}`, { runtime: "claude", model: "sonnet" });
    const joint = await seedJointChannel({ name: `art-joint-${label()}`, serverIds: [host.id, peer.id], createdByUserId: owner.id });
    const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
    for (const human of [owner, admin, author, manager, other]) await addHuman(hostProjection.id, human.id);
    await addAgent(hostProjection.id, authorAgent.id);
    await addHuman(peerProjection.id, peerMember.id);
    await addAgent(peerProjection.id, peerAgent.id);
    const items = {
      byMember: await insertItem({ serverId: hostId, homeKind: "conversation", homeChannelId: joint.canonical.id, author: { type: "user", id: author.id } }),
      byAgent: await insertItem({ serverId: hostId, homeKind: "conversation", homeChannelId: joint.canonical.id, author: { type: "agent", id: authorAgent.id } }),
    };
    const actors = {
      owner: { type: "user", id: owner.id, serverId: hostId },
      admin: { type: "user", id: admin.id, serverId: hostId },
      author: { type: "user", id: author.id, serverId: hostId },
      manager: { type: "user", id: manager.id, serverId: hostId },
      other: { type: "user", id: other.id, serverId: hostId },
      authorAgent: { type: "agent", id: authorAgent.id, serverId: hostId },
      peerMember: { type: "user", id: peerMember.id, serverId: peerId },
      peerAgent: { type: "agent", id: peerAgent.id, serverId: peerId },
    } satisfies Record<string, ViewActor>;
    const names = Object.keys(actors) as Array<keyof typeof actors>;
    const answers = async (item: typeof items.byMember) => {
      const byId: string[] = [];
      const listed: string[] = [];
      for (const name of names) {
        if ((await canViewArtifacts(actors[name], [item]))[0]) byId.push(name);
        const rows = await db.select({ id: artifactItems.id }).from(artifactItems).where(await visibleArtifactsSql(actors[name]));
        if (rows.some((row) => row.id === item.id)) listed.push(name);
      }
      const turned = await actorsWhoCanViewArtifact(names.map((name) => actors[name]), item);
      assert.deepEqual(names.filter((_, index) => turned[index]).sort(), byId.sort(), "actorsWhoCanViewArtifact agrees with canViewArtifacts");
      return { byId: byId.sort(), listed: listed.sort() };
    };
    const everyone = [...names].sort();
    assert.deepEqual(await answers(items.byMember), { byId: everyone, listed: everyone }, "before: every member of the joint");

    if (leaving === "disconnects") await disconnectJointChannel(hostProjection.id, owner.id);
    else if (leaving === "deletes its projection") await deleteChannel(hostProjection.id);
    else await db.execute(sql`UPDATE joint_channels SET status = 'closed' WHERE id = ${joint.jointChannelId}`);

    assert.deepEqual(await answers(items.byMember), { byId: ["admin", "author", "owner"], listed: [] }, "a member's Artifact");
    assert.deepEqual(await answers(items.byAgent), { byId: ["admin", "authorAgent", "manager", "owner"], listed: [] }, "an agent's Artifact");
  });
}

test("a joint Artifact is listed on another server as it is read, beside that server's own joint Artifacts", async ({ seed }) => {
  const world = await seedJointArtifact(seed);
  const peerId = world.actors.peerMember.serverId;
  const ofPeer = await insertItem({ serverId: peerId, homeKind: "conversation", homeChannelId: world.item.homeChannelId, author: { type: "user", id: world.actors.peerMember.id } });
  const listedTo = async (actor: ViewActor) => (await getDb().select({ id: artifactItems.id }).from(artifactItems).where(await visibleArtifactsSql(actor)))
    .map((row) => row.id).filter((id) => id === world.item.id || id === ofPeer.id).sort();
  const both = [world.item.id, ofPeer.id].sort();
  assert.deepEqual(await listedTo(world.actors.peerMember), both, "the peer's person");
  assert.deepEqual(await listedTo(world.actors.peerAgent), both, "the peer's agent");
});

// An Artifact's home is a top-level conversation: a joint's thread or task
// conversation also has a canonical channel and one projection per server
// (joint_channels records), but it is never a home, on any form.
test("an Artifact homed on a joint's thread or task conversation is seen by nobody, by id, turned around or listed", async ({ seed }) => {
  const world = await seedJointArtifact(seed);
  const db = getDb();
  const canonicalId = world.item.homeChannelId!;
  const hostId = world.actors.author.serverId;
  const [canonical] = await db.select().from(channels).where(eq(channels.id, canonicalId));
  const root = await createMessage(canonicalId, "user", world.author.id, `joint thread root ${randomUUID()}`);
  const thread = await getOrCreateThreadForChannel(world.hostProjection.id, root.id, world.author.id, "user");
  assert.notEqual(thread.canonicalThreadChannelId, thread.id, "fixture: a joint thread, a projection of its canonical thread");
  const [task] = await db.insert(tasks).values({ channelId: canonicalId, taskNumber: 1, title: "joint task", createdByType: "user", createdById: world.author.id }).returning();
  const created = await createTaskConversationsInTransaction(db, {
    tasks: [{ id: task!.id, channelId: canonicalId }],
    storageChannel: { id: canonicalId, serverId: canonical!.serverId, type: canonical!.type },
    initiatingServerId: hostId,
  });
  const taskConversation = created.get(task!.id)!;
  assert.ok(taskConversation.jointChannelId, "fixture: a joint task conversation");
  assert.equal(taskConversation.localByServer.size, 2, "fixture: projected on both servers");

  const author = { type: "user" as const, id: world.author.id };
  const homes = {
    task: await insertItem({ serverId: hostId, homeKind: "conversation", homeChannelId: taskConversation.canonicalChannelId, author }),
    thread: await insertItem({ serverId: hostId, homeKind: "conversation", homeChannelId: thread.canonicalThreadChannelId, author }),
  };
  const actors = Object.values(world.actors);
  for (const [name, item] of Object.entries(homes)) {
    assert.deepEqual(await canViewArtifacts(world.actors.author, [item]), [false], `${name}: the author, by id`);
    for (const actor of actors) {
      assert.deepEqual(await canViewArtifacts(actor, [item]), [false], `${name}: ${actor.type} ${actor.id}, by id`);
      const listed = await db.select({ id: artifactItems.id }).from(artifactItems).where(await visibleArtifactsSql(actor));
      assert.ok(!listed.some((row) => row.id === item.id), `${name}: ${actor.type} ${actor.id}, listed`);
    }
    assert.deepEqual(await actorsWhoCanViewArtifact(actors, item), actors.map(() => false), `${name}: turned around`);
  }
  // Witness: the joint's own Artifact is seen.
  assert.deepEqual(await canViewArtifacts(world.actors.peerMember, [world.item]), [true]);
});

// An Artifact published in a channel that later becomes a joint (or, before
// publish stored the canonical channel, into a joint's projection) names that
// server's projection as its home. Read, it is homed in the joint (Tenny, F7;
// no data migration): seen on every participating server, as one published
// there now.
test("an Artifact published in a channel that then becomes a joint is homed in the joint: the joining server's members in it see it, by id, turned around and listed, named by their own projection", async ({ seed }) => {
  const db = getDb();
  const label = () => randomUUID().slice(0, 8);
  const owner = await seed.human();
  const member = await seed.human();
  const memberOut = await seed.human();
  const peerOwner = await seed.human();
  const peerMember = await seed.human();
  const host = await seed.server({ owner, members: [member, memberOut] });
  const peer = await seed.server({ owner: peerOwner, members: [peerMember] });
  artifactsOn();
  const hostId = asServerId(host.id);
  const peerId = asServerId(peer.id);
  const peerAgent = await createAgent(peer.id, `ajc-peer-${label()}`, { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(host.id, `art-conv-${label()}`, undefined, "private");
  await addHuman(channel.id, member.id);
  const item = await insertItem({ serverId: hostId, homeKind: "conversation", homeChannelId: channel.id, author: { type: "user", id: member.id } });

  const job = await startChannelToJointConversion({ serverId: host.id, sourceChannelId: channel.id, createdByUserId: owner.id });
  await runChannelConversionJob(job.id);
  const [converted] = await db.select().from(channels).where(eq(channels.id, channel.id));
  assert.equal(converted!.type, "joint", "fixture: the channel is now the host's projection of a joint");
  // The peer joins: its projection of the joint, as accepting an invite leaves it.
  const [hostRecord] = await db.select().from(jointChannelServers).where(eq(jointChannelServers.localChannelId, channel.id));
  const peerProjection = await createChannel(peer.id, channel.name, undefined, "joint");
  await db.insert(jointChannelServers).values({ jointChannelId: hostRecord!.jointChannelId, serverId: peer.id, localChannelId: peerProjection.id, role: "participant", joinedByUserId: peerOwner.id });
  await fillJointMembersFromChannelHumans();
  await addHuman(peerProjection.id, peerMember.id);
  await addAgent(peerProjection.id, peerAgent.id);

  const actors = {
    member: { type: "user", id: member.id, serverId: hostId },
    memberOut: { type: "user", id: memberOut.id, serverId: hostId },
    peerMember: { type: "user", id: peerMember.id, serverId: peerId },
    peerAgent: { type: "agent", id: peerAgent.id, serverId: peerId },
    peerOwner: { type: "user", id: peerOwner.id, serverId: peerId },
  } satisfies Record<string, ViewActor>;
  const names = Object.keys(actors) as Array<keyof typeof actors>;
  const byId: string[] = [];
  const listed: string[] = [];
  for (const name of names) {
    if ((await canViewArtifacts(actors[name], [item]))[0]) byId.push(name);
    const rows = await db.select({ id: artifactItems.id }).from(artifactItems).where(await visibleArtifactsSql(actors[name]));
    if (rows.some((row) => row.id === item.id)) listed.push(name);
  }
  const expected = ["member", "peerAgent", "peerMember"];
  assert.deepEqual(byId.sort(), expected, "canViewArtifacts");
  assert.deepEqual(listed.sort(), expected, "visibleArtifactsSql");
  const turned = await actorsWhoCanViewArtifact(names.map((name) => actors[name]), item);
  assert.deepEqual(names.filter((_, index) => turned[index]).sort(), expected, "actorsWhoCanViewArtifact");
  assert.equal((await localConversationIds(peerId, [channel.id])).get(channel.id), peerProjection.id, "the peer names the home by its own projection");
  assert.equal((await localConversationIds(hostId, [channel.id])).get(channel.id), channel.id, "the host by its own");
});
