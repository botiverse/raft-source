import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { asServerId, type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, channelAgents, channelHumans, channels } from "../db/schema";
import { seedJointChannel } from "../test/integration/jointFixture";
import type { createSeed } from "../test/integration/seed";
import { createAgent } from "./agentService";
import {
  addAgent,
  addHuman,
  canAgentAccessChannel,
  canUserAccessChannel,
  createChannel,
  findOrCreateDM,
  getOrCreateThreadForChannel,
} from "./channelService";
import { createMessage } from "./messageService";
import {
  canView,
  visibleConversationSql,
  visibleRootChannelIds,
  type ViewActor,
  type VisibleRoots,
} from "./visibilityService";
import { seedBoundGuest } from "../test/guestFixture";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };

/**
 * One server with every kind of conversation, a thread under each, and the
 * actors of the matrix: owner, member, guest (bound to #private-member, #wg-rbac:#15), an agent of
 * this server, an agent of another server, a deleted agent of this server.
 */
async function seedMatrix(seed: ReturnType<typeof createSeed>) {
  const db = getDb();
  const owner = await seed.human();
  const member = await seed.human();
  const guest = await seed.human();
  const peerOwner = await seed.human();
  const server = await seed.server({ owner, members: [member, guest] });
  const peer = await seed.server({ owner: peerOwner });

  const label = () => randomUUID().slice(0, 8);
  const agent = await createAgent(server.id, `matrix-agent-${label()}`, { runtime: "claude", model: "sonnet" });
  const otherServerAgent = await createAgent(peer.id, `matrix-other-agent-${label()}`, { runtime: "claude", model: "sonnet" });
  const deletedAgent = await createAgent(server.id, `matrix-deleted-agent-${label()}`, { runtime: "claude", model: "sonnet" });

  const pub = await createChannel(server.id, `matrix-public-${label()}`);
  const pubGuestVisible = await createChannel(server.id, `matrix-public-guest-${label()}`);
  await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, pubGuestVisible.id));
  const pubArchived = await createChannel(server.id, `matrix-public-archived-${label()}`);
  const privMember = await createChannel(server.id, `matrix-private-member-${label()}`, undefined, "private");
  const privNon = await createChannel(server.id, `matrix-private-non-${label()}`, undefined, "private");
  for (const userId of [owner.id, member.id]) await addHuman(privMember.id, userId);
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: privMember.id });
  const deleted = await createChannel(server.id, `matrix-deleted-${label()}`, undefined, "private");
  for (const userId of [owner.id, member.id, guest.id]) await addHuman(deleted.id, userId);
  for (const id of [agent.id, deletedAgent.id]) {
    await addAgent(privMember.id, id);
    await addAgent(deleted.id, id);
  }
  // The other server's agent with a (stray) membership row here: the pin, not the row, decides.
  await db.insert(channelAgents).values([{ channelId: privMember.id, agentId: otherServerAgent.id }]);

  const memberDm = (await findOrCreateDM(server.id, member.id, agent.id))!;
  const guestDm = (await findOrCreateDM(server.id, guest.id, agent.id))!;

  // Joint: one projection per (joint, server) is the schema's rule, so "a
  // member on another projection" can only be a member on the peer server's
  // projection, which grants nothing here.
  const jointMember = await seedJointChannel({ name: `matrix-joint-member-${label()}`, serverIds: [server.id, peer.id], createdByUserId: owner.id });
  const jointPeerOnly = await seedJointChannel({ name: `matrix-joint-peer-${label()}`, serverIds: [server.id, peer.id], createdByUserId: owner.id });
  const jointNon = await seedJointChannel({ name: `matrix-joint-non-${label()}`, serverIds: [server.id, peer.id], createdByUserId: owner.id });
  const jointLocal = jointMember.projections[0]!;
  for (const userId of [owner.id, member.id]) await addHuman(jointLocal.id, userId);
  await addAgent(jointLocal.id, agent.id);
  for (const userId of [owner.id, member.id]) await db.insert(channelHumans).values({ channelId: jointPeerOnly.projections[1]!.id, userId });
  await db.insert(channelAgents).values({ channelId: jointPeerOnly.projections[1]!.id, agentId: agent.id });

  // Hidden #all with stale membership rows for everyone.
  const [allChannel] = await db.select().from(channels).where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
  assert.ok(allChannel, "fixture: the server has #all");
  for (const userId of [owner.id, member.id, guest.id]) await db.insert(channelHumans).values({ channelId: allChannel.id, userId }).onConflictDoNothing();
  await db.insert(channelAgents).values({ channelId: allChannel.id, agentId: agent.id }).onConflictDoNothing();

  const threadOf = async (channel: { id: string }, storage?: { id: string }) => {
    const root = await createMessage((storage ?? channel).id, "user", owner.id, `matrix root ${randomUUID()}`);
    return (await getOrCreateThreadForChannel(channel.id, root.id, owner.id, "user")).id;
  };
  const threads = {
    pub: await threadOf(pub),
    pubGuestVisible: await threadOf(pubGuestVisible),
    pubArchived: await threadOf(pubArchived),
    privMember: await threadOf(privMember),
    privNon: await threadOf(privNon),
    memberDm: await threadOf(memberDm),
    guestDm: await threadOf(guestDm),
    jointMember: await threadOf(jointLocal, jointMember.canonical),
    jointPeerOnly: await threadOf(jointPeerOnly.projections[0]!, jointPeerOnly.canonical),
    jointNon: await threadOf(jointNon.projections[0]!, jointNon.canonical),
    all: await threadOf(allChannel),
    deleted: await threadOf(deleted),
  };

  // Hide/archive/delete only after the threads exist (the write paths refuse them afterwards).
  await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, pubArchived.id));
  await db.update(channels).set({ type: "private" }).where(eq(channels.id, allChannel.id));
  await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, deleted.id));
  await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, deletedAgent.id));

  const conversations = {
    pub: pub.id,
    pubGuestVisible: pubGuestVisible.id,
    pubArchived: pubArchived.id,
    privMember: privMember.id,
    privNon: privNon.id,
    memberDm: memberDm.id,
    guestDm: guestDm.id,
    jointMember: jointLocal.id,
    jointPeerOnly: jointPeerOnly.projections[0]!.id,
    jointNon: jointNon.projections[0]!.id,
    all: allChannel.id,
    deleted: deleted.id,
  };
  const serverId = asServerId(server.id);
  const actors = {
    owner: { type: "user", id: owner.id, serverId },
    member: { type: "user", id: member.id, serverId },
    guest: { type: "user", id: guest.id, serverId },
    agent: { type: "agent", id: agent.id, serverId },
    otherServerAgent: { type: "agent", id: otherServerAgent.id, serverId },
    deletedAgent: { type: "agent", id: deletedAgent.id, serverId },
  } satisfies Record<string, ViewActor>;
  return { server, peer, conversations, threads, actors, jointMember, agents: { agent, otherServerAgent, deletedAgent } };
}

/** The pre-existing single checks: canUserAccessChannel, and canAgentAccessChannel plus the server pin. */
async function oracle(actor: ViewActor, channelId: string, agentServerIds: ReadonlyMap<string, string>): Promise<boolean> {
  if (actor.type === "user") return canUserAccessChannel(channelId, actor.id, actor.serverId);
  const [channel] = await getDb().select({ serverId: channels.serverId }).from(channels).where(eq(channels.id, channelId));
  return agentServerIds.get(actor.id) === actor.serverId
    && channel?.serverId === actor.serverId
    && await canAgentAccessChannel(channelId, actor.id);
}

async function predicateRows(roots: VisibleRoots, serverId: ServerId): Promise<Set<string>> {
  const result = await getDb().execute(sql`
    SELECT c.id::text AS id
    FROM ${channels} c
    WHERE c.server_id = ${serverId}
      AND c.deleted_at IS NULL
      AND ${visibleConversationSql(roots, sql`c.id`, sql`c.parent_channel_id`)}
  `);
  return new Set((result.rows as Array<{ id: string }>).map((row) => row.id));
}

test("canView, visibleRootChannelIds and visibleConversationSql answer the whole matrix exactly as the single checks", async ({ seed }) => {
  const { server, conversations, threads, actors, agents: seeded } = await seedMatrix(seed);
  const db = getDb();
  const agentServerIds = new Map((await db.select({ id: agents.id, serverId: agents.serverId, deletedAt: agents.deletedAt }).from(agents))
    .filter((row) => row.deletedAt === null)
    .map((row) => [row.id, row.serverId]));
  const ids = [...Object.values(conversations), ...Object.values(threads)];
  const serverChannelIds = (await db.select({ id: channels.id }).from(channels).where(eq(channels.serverId, server.id))).map((row) => row.id);

  const views: Record<string, Set<string>> = {};
  for (const [name, actor] of Object.entries(actors)) {
    // canView: one answer per home, in order, equal to the single check of each.
    const answers = await canView(actor, ids.map((channelId) => ({ kind: "conversation", channelId })));
    assert.equal(answers.length, ids.length);
    const expected: boolean[] = [];
    for (const id of ids) expected.push(await oracle(actor, id, agentServerIds));
    assert.deepEqual(answers, expected, `${name}: canView = single checks`);
    views[name] = new Set(ids.filter((_, index) => answers[index]));

    // visibleRootChannelIds: exactly the visible top-level conversations (and parentless joint thread projections) of the server.
    const roots = await visibleRootChannelIds(actor);
    const visibleTopLevel: string[] = [];
    for (const id of serverChannelIds) if ((await canView(actor, [{ kind: "conversation", channelId: id }]))[0]) visibleTopLevel.push(id);
    const threadRows = await db.select({ id: channels.id, type: channels.type, parentChannelId: channels.parentChannelId }).from(channels).where(eq(channels.serverId, server.id));
    const parentByThread = new Map(threadRows.filter((row) => row.type === "thread").map((row) => [row.id, row.parentChannelId]));
    assert.deepEqual(
      [...roots.roots.map((root) => root.id), ...roots.parentlessThreadIds].sort(),
      visibleTopLevel.filter((id) => !parentByThread.has(id) || parentByThread.get(id) === null).sort(),
      `${name}: visible roots`,
    );

    // Without threads: the same top-level roots, no thread candidates, no joint storage map.
    const topLevelOnly = await visibleRootChannelIds(actor, { includeThreads: false });
    assert.deepEqual(topLevelOnly.roots, roots.roots, `${name}: includeThreads=false keeps the roots`);
    assert.deepEqual(topLevelOnly.parentlessThreadIds, []);
    assert.equal(topLevelOnly.jointStorageByLocalId.size, 0);

    // visibleConversationSql: row by row over every live channel row of the server, the same answer as canView.
    assert.deepEqual([...await predicateRows(roots, actor.serverId)].sort(), visibleTopLevel.sort(), `${name}: SQL predicate = canView`);
  }

  // The matrix is not vacuous: the cells of the design table.
  const sees = (actor: string, ...keys: Array<keyof typeof conversations>) => {
    for (const key of keys) assert.ok(views[actor]!.has(conversations[key]), `${actor} sees ${key}`);
    for (const key of keys) assert.ok(views[actor]!.has(threads[key]), `${actor} sees the thread under ${key}`);
  };
  const doesNotSee = (actor: string, ...keys: Array<keyof typeof conversations>) => {
    for (const key of keys) assert.ok(!views[actor]!.has(conversations[key]), `${actor} does not see ${key}`);
    for (const key of keys) assert.ok(!views[actor]!.has(threads[key]), `${actor} does not see the thread under ${key}`);
  };
  for (const human of ["owner", "member"]) {
    sees(human, "pub", "pubGuestVisible", "pubArchived", "privMember", "jointMember");
    doesNotSee(human, "privNon", "guestDm", "jointPeerOnly", "jointNon", "all", "deleted");
  }
  sees("member", "memberDm");
  doesNotSee("owner", "memberDm");
  // A guest sees its one channel only: no guest-visible channel, DM, joint or
  // #all, whatever membership rows it has (#wg-rbac:#15).
  sees("guest", "privMember");
  doesNotSee("guest", "pub", "pubGuestVisible", "pubArchived", "privNon", "memberDm", "guestDm", "jointMember", "deleted", "all");
  sees("agent", "pub", "pubArchived", "privMember", "memberDm", "guestDm", "jointMember");
  doesNotSee("agent", "privNon", "jointPeerOnly", "jointNon", "all", "deleted");
  assert.deepEqual([...views.otherServerAgent!], [], "an agent of another server sees nothing here, not even public channels");
  assert.deepEqual([...views.deletedAgent!], [], "a deleted agent sees nothing");
  assert.ok(await canAgentAccessChannel(conversations.pub, seeded.agent.id));
  assert.equal(await canAgentAccessChannel(conversations.pub, seeded.otherServerAgent.id), false, "canAgentAccessChannel itself is pinned now");
  assert.equal(await canAgentAccessChannel(conversations.pub, seeded.deletedAgent.id), false);
});

test("visibleConversationSql also admits the joint's canonical storage rows for its members only", async ({ seed }) => {
  const { actors, jointMember } = await seedMatrix(seed);
  const canonicalThread = (await getDb().select({ id: channels.id }).from(channels).where(eq(channels.parentChannelId, jointMember.canonical.id)))[0]!;
  const storageRows = async (actor: ViewActor) => {
    const roots = await visibleRootChannelIds(actor);
    const result = await getDb().execute(sql`
      SELECT c.id::text AS id FROM ${channels} c
      WHERE c.id IN (${jointMember.canonical.id}, ${canonicalThread.id})
        AND ${visibleConversationSql(roots, sql`c.id`, sql`c.parent_channel_id`)}
    `);
    return (result.rows as Array<{ id: string }>).map((row) => row.id).sort();
  };
  const both = [jointMember.canonical.id, canonicalThread.id].sort();
  assert.deepEqual(await storageRows(actors.member), both);
  assert.deepEqual(await storageRows(actors.agent), both);
  assert.deepEqual(await storageRows(actors.guest), [], "guests never see joint conversations");
  assert.deepEqual(await storageRows(actors.otherServerAgent), []);
  // canView itself stays on local ids: storage is never a conversation of the server.
  assert.deepEqual(await canView(actors.member, [{ kind: "conversation", channelId: jointMember.canonical.id }]), [false]);
});

test("canView and visibleRootChannelIds run a fixed number of queries however many channels there are", async ({ seed }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const agent = await createAgent(server.id, `count-agent-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  const serverId = asServerId(server.id);
  const human: ViewActor = { type: "user", id: member.id, serverId };
  const agentActor: ViewActor = { type: "agent", id: agent.id, serverId };
  const ids: string[] = [];
  const grow = async (size: number) => {
    for (let i = 0; i < size; i += 1) {
      const label = randomUUID().slice(0, 8);
      const open = await createChannel(server.id, `count-open-${label}`);
      const room = await createChannel(server.id, `count-room-${label}`, undefined, "private");
      await addHuman(room.id, member.id);
      await addAgent(room.id, agent.id);
      const joint = await seedJointChannel({ name: `count-joint-${label}`, serverIds: [server.id], createdByUserId: owner.id });
      await addHuman(joint.projections[0]!.id, member.id);
      await addAgent(joint.projections[0]!.id, agent.id);
      const root = await createMessage(room.id, "user", member.id, `count root ${label}`);
      const thread = await getOrCreateThreadForChannel(room.id, root.id, member.id, "user");
      const jointRoot = await createMessage(joint.canonical.id, "user", member.id, `count joint root ${label}`);
      const jointThread = await getOrCreateThreadForChannel(joint.projections[0]!.id, jointRoot.id, member.id, "user");
      const dm = (await findOrCreateDM(server.id, member.id, agent.id))!;
      ids.push(open.id, room.id, joint.projections[0]!.id, thread.id, jointThread.id, dm.id);
    }
  };
  const count = async <T>(fn: () => Promise<T>) => {
    const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
    const originalQuery = pg.query.bind(pg);
    let queries = 0;
    pg.query = ((...args: unknown[]) => {
      queries += 1;
      return originalQuery(...args);
    }) as PgliteLike["query"];
    try {
      // Read the counter after the call: in `{ queries, value: await fn() }`
      // it would be read before fn runs, and every count would be 0.
      const value = await fn();
      return { queries, value };
    } finally {
      pg.query = originalQuery;
    }
  };
  const measure = async () => ({
    humanRoots: await count(() => visibleRootChannelIds(human)),
    agentRoots: await count(() => visibleRootChannelIds(agentActor)),
    humanView: await count(() => canView(human, ids.map((channelId) => ({ kind: "conversation" as const, channelId })))),
    agentView: await count(() => canView(agentActor, ids.map((channelId) => ({ kind: "conversation" as const, channelId })))),
  });

  await grow(2);
  const few = await measure();
  await grow(6);
  const many = await measure();
  assert.ok(many.humanRoots.value.roots.length > few.humanRoots.value.roots.length, "fixture: more roots");
  assert.equal(many.humanView.value.filter(Boolean).length, ids.length, "fixture: the member sees every seeded conversation");
  assert.equal(many.agentView.value.filter(Boolean).length, ids.length, "fixture: the agent sees every seeded conversation");
  for (const key of ["humanRoots", "agentRoots", "humanView", "agentView"] as const) {
    assert.ok(few[key].queries > 0, `${key}: the counter saw no queries`);
    assert.equal(many[key].queries, few[key].queries, `${key}: ${few[key].queries} queries for few channels, ${many[key].queries} for many`);
  }
});
