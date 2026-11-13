// The channel list's `lastPostAt` (#wg-ax:3db7ecba): when a person or an agent
// last posted in a channel, thread replies included; system messages do not
// count; null when nobody has. Kept by the messages_channel_last_post trigger.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { channelLastPosts, channelLastPostsBackfill, channels, jointChannelServers } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { __resetChannelLastPostsBackfillCacheForTests, addAgent, addHuman, createChannel, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { seedJointChannel } from "../test/integration/jointFixture";
import { createServer, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

test("lastPostAt: a person's or an agent's post moves it, a thread reply moves its parent, a system message does not; none is null", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`lp-owner-${suffix}@slock.test`, `lp-owner-${suffix}`);
  const server = await createServer("Last Post", `lp-${suffix}`, owner.id);
  const agent = await createAgent(server.id, `lp-agent-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "lp", issuedVia: "computer", createdByUserId: null });
  const busy = await createChannel(server.id, `busy-${suffix}`);
  const quiet = await createChannel(server.id, `quiet-${suffix}`);
  const systemOnly = await createChannel(server.id, `system-${suffix}`);
  for (const channel of [busy, quiet, systemOnly]) {
    await addHuman(channel.id, owner.id);
    await addAgent(channel.id, agent.id);
  }
  const lastPost = async (channelId: string) => (await getDb().select().from(channelLastPosts).where(eq(channelLastPosts.channelId, channelId)))[0]?.lastPostAt ?? null;

  const first = await createMessage(busy.id, "user", owner.id, "hello");
  assert.equal((await lastPost(busy.id))?.getTime(), first.createdAt.getTime());
  await createMessage(systemOnly.id, "user", owner.id, "joined", "system");
  assert.equal(await lastPost(systemOnly.id), null, "a system message is not a post");

  // A thread reply counts for the thread and its parent; within a minute the row is not rewritten.
  const thread = await getOrCreateThread(first.id, owner.id, "user");
  await getDb().update(channelLastPosts).set({ lastPostAt: new Date(first.createdAt.getTime() - 5 * 60_000) }).where(eq(channelLastPosts.channelId, busy.id));
  const reply = await createMessage(thread.id, "agent", agent.id, "on it");
  assert.equal((await lastPost(busy.id))?.getTime(), reply.createdAt.getTime(), "the reply moved its parent channel");
  assert.equal((await lastPost(thread.id))?.getTime(), reply.createdAt.getTime());
  await createMessage(busy.id, "user", owner.id, "again");
  assert.equal((await lastPost(busy.id))?.getTime(), reply.createdAt.getTime(), "within a minute: unchanged (minute precision)");

  const list = async () => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/server`, { headers: { Authorization: `Bearer ${apiKey}` } });
    assert.equal(res.status, 200);
    return (await res.json() as { channels: Array<{ id: string; lastPostAt?: string | null }> }).channels;
  };
  // A fresh database (no messages when 0398 ran, as in tests) is marked done by the migration.
  assert.equal((await getDb().select().from(channelLastPostsBackfill)).length, 1);
  // Before the one-time backfill, the field is left out: no row is not "no posts".
  await getDb().delete(channelLastPostsBackfill);
  __resetChannelLastPostsBackfillCacheForTests();
  assert.ok((await list()).every((channel) => !("lastPostAt" in channel)));
  await getDb().insert(channelLastPostsBackfill).values({ id: 1 }).onConflictDoNothing();
  __resetChannelLastPostsBackfillCacheForTests();
  const body = { channels: await list() };
  const byId = new Map(body.channels.map((channel) => [channel.id, channel.lastPostAt]));
  assert.equal(byId.get(busy.id), reply.createdAt.toISOString());
  assert.equal(byId.get(quiet.id), null, "no posts yet");
  assert.equal(byId.get(systemOnly.id), null);
});

test("lastPostAt: a joint channel reads its canonical channel's last post, or its own from before it was converted; a regular channel's is unchanged", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`lpj-owner-${suffix}@slock.test`, `lpj-owner-${suffix}`);
  const server = await createServer("Last Post Joint", `lpj-${suffix}`, owner.id);
  const peer = await createServer("Last Post Joint Peer", `lpj-peer-${suffix}`, owner.id);
  const agent = await createAgent(server.id, `lpj-agent-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "lpj", issuedVia: "computer", createdByUserId: null });
  const regular = await createChannel(server.id, `regular-${suffix}`);
  const converting = await createChannel(server.id, `converting-${suffix}`);
  const busy = await seedJointChannel({ name: `joint-busy-${suffix}`, serverIds: [server.id, peer.id], createdByUserId: owner.id });
  const quiet = await seedJointChannel({ name: `joint-quiet-${suffix}`, serverIds: [peer.id, server.id], createdByUserId: owner.id });
  const converted = await seedJointChannel({ name: `joint-converted-${suffix}`, serverIds: [server.id, peer.id], createdByUserId: owner.id });
  const target = await seedJointChannel({ name: `joint-target-${suffix}`, serverIds: [peer.id], createdByUserId: owner.id });
  const local = (joint: typeof busy) => joint.projections.find((projection) => projection.serverId === server.id)!;
  for (const channelId of [regular.id, converting.id, local(busy).id, local(quiet).id, local(converted).id]) {
    await addHuman(channelId, owner.id);
    await addAgent(channelId, agent.id);
  }
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  const setLastPost = (channelId: string, at: Date) => getDb().insert(channelLastPosts).values({ channelId, lastPostAt: at })
    .onConflictDoUpdate({ target: channelLastPosts.channelId, set: { lastPostAt: at } });

  const regularPost = await createMessage(regular.id, "user", owner.id, "hello");
  // Joint posts are stored in the canonical channel; the projection itself gets only system messages.
  const jointPost = await createMessage(busy.canonical.id, "user", owner.id, "hello peers");
  await createMessage(local(busy).id, "user", owner.id, "joined", "system");
  // Its own row from before it was converted is older: the canonical one is shown.
  await setLastPost(local(busy).id, minutesAgo(90));
  // Converted, nobody posted since: its posts were moved to the canonical channel without a trigger, so its own row stands.
  const beforeConversion = minutesAgo(30);
  await setLastPost(local(converted).id, beforeConversion);
  // Mid-conversion (projection row active, still a regular channel): its posts are still its own.
  await getDb().insert(jointChannelServers).values({ jointChannelId: target.jointChannelId, serverId: server.id, localChannelId: converting.id, joinedByUserId: owner.id });
  const convertingPost = await createMessage(converting.id, "user", owner.id, "still here");
  await setLastPost(target.canonical.id, new Date(Date.now() + 60_000));

  const res = await fetch(`${app.baseUrl}/internal/agent-api/server`, { headers: { Authorization: `Bearer ${apiKey}` } });
  assert.equal(res.status, 200);
  const byId = new Map((await res.json() as { channels: Array<{ id: string; lastPostAt?: string | null }> }).channels.map((channel) => [channel.id, channel.lastPostAt]));
  assert.equal(byId.get(local(busy).id), jointPost.createdAt.toISOString(), "the projection shows the canonical channel's last post");
  assert.equal(byId.get(local(converted).id), beforeConversion.toISOString(), "a converted channel keeps its posts from before");
  assert.equal(byId.get(local(quiet).id), null, "a joint channel nobody posted in: no posts yet");
  assert.equal(byId.get(converting.id), convertingPost.createdAt.toISOString(), "a channel that is not joint yet reads its own row");
  assert.equal(byId.get(regular.id), regularPost.createdAt.toISOString(), "a regular channel reads its own row");
});

test("archivedChannelCount counts exactly the archived rows ?archived=include lists, joint channels included", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`arc-owner-${suffix}@slock.test`, `arc-owner-${suffix}`);
  const server = await createServer("Archived Count", `arc-${suffix}`, owner.id);
  const peer = await createServer("Archived Count Peer", `arc-peer-${suffix}`, owner.id);
  const agent = await createAgent(server.id, `arc-agent-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "arc", issuedVia: "computer", createdByUserId: null });
  const archive = (id: string) => getDb().update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, id));
  const joinedJoint = await seedJointChannel({ name: `arc-joint-in-${suffix}`, serverIds: [server.id, peer.id], createdByUserId: owner.id });
  await addAgent(joinedJoint.projections[0]!.id, agent.id);
  await archive(joinedJoint.projections[0]!.id);
  const otherJoint = await seedJointChannel({ name: `arc-joint-out-${suffix}`, serverIds: [server.id, peer.id], createdByUserId: owner.id });
  await archive(otherJoint.projections[0]!.id);
  const publicOld = await createChannel(server.id, `arc-public-${suffix}`);
  await archive(publicOld.id);
  const privateOut = await createChannel(server.id, `arc-private-${suffix}`, undefined, "private");
  await archive(privateOut.id);

  const read = async (path: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    assert.equal(res.status, 200);
    return await res.json() as { archivedChannelCount?: number; archivedChannels?: Array<{ name: string }> };
  };
  const counted = await read("/server");
  const listed = await read("/server?archived=include");
  const names = (listed.archivedChannels ?? []).map((channel) => channel.name);
  assert.ok(names.includes(`arc-public-${suffix}`));
  assert.ok(!names.includes(`arc-private-${suffix}`), "a private archived channel the agent is not in");
  assert.ok(!names.includes(`arc-joint-out-${suffix}`), "a joint archived channel the agent is not in");
  assert.equal(counted.archivedChannelCount, names.length, "the SQL count and the listing agree");
});
