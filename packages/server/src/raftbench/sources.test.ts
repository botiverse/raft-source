import { expect } from "vitest";
import { eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { agents, channels, channelAgents, channelHumans, jointChannelMembers, jointChannels, jointChannelServers, messages, serverMembers, servers, tasks } from "../db/schema";
import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";
import { includeThreadSources } from "./sources";

const test = createApiTest();
test("joint reply sources use local parent permission and canonical message storage", async ({ db, seed }) => {
  const owner = await seed.human();
  const [local, remote] = await db.insert(servers).values([
    { ownerId: owner.id, name: "Local", slug: "source-local" }, { ownerId: owner.id, name: "Remote", slug: "source-remote" },
  ]).returning();
  await db.insert(serverMembers).values({ serverId: local.id, userId: owner.id, role: "owner", setupStatus: "complete" });
  const [agent] = await db.insert(agents).values({ serverId: local.id, name: "Reader" }).returning();
  const [canonical, face] = await db.insert(channels).values([
    { serverId: remote.id, name: "canonical", type: "joint" }, { serverId: local.id, name: "local-name", type: "joint" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: canonical.id, createdByServerId: remote.id, createdByUserId: owner.id }).returning();
  await db.insert(jointChannelServers).values({ jointChannelId: joint.id, serverId: local.id, localChannelId: face.id, role: "participant", status: "active", joinedByUserId: owner.id });
  await db.insert(channelAgents).values({ channelId: face.id, agentId: agent.id });
  await db.insert(channelHumans).values({ channelId: face.id, userId: owner.id });
  await fillJointMembersFromChannelHumans();
  const [parent] = await db.insert(messages).values({ channelId: canonical.id, senderId: owner.id, senderType: "user", content: "Synthetic parent" }).returning();
  const [card] = await db.insert(tasks).values({ channelId: canonical.id, taskNumber: 1, title: "Synthetic task", createdByType: "user", createdById: owner.id }).returning();
  const [ct, lt, task] = await db.insert(channels).values([
    { serverId: remote.id, name: "canonical-thread", type: "thread", parentMessageId: parent.id, parentChannelId: canonical.id },
    { serverId: local.id, name: "local-thread", type: "thread" },
    { serverId: remote.id, name: "task-not-in-this-scope", type: "task", taskId: card.id, parentChannelId: canonical.id },
  ]).returning();
  await db.update(messages).set({ threadId: ct.id }).where(eq(messages.id, parent.id));
  const [threadJoint] = await db.insert(jointChannels).values({ canonicalChannelId: ct.id, createdByServerId: remote.id, createdByUserId: owner.id }).returning();
  await db.insert(jointChannelServers).values({ jointChannelId: threadJoint.id, serverId: local.id, localChannelId: lt.id, role: "participant", status: "active", joinedByUserId: owner.id });
  const roots = [{ localId: face.id, storageId: canonical.id, target: "#local-name" }];
  const read = () => includeThreadSources(roots, local.id, owner.id, agent.id);
  expect(await read()).toEqual([...roots, { localId: lt.id, storageId: ct.id, parentId: face.id, target: `#local-name:${parent.id.slice(0, 8)}` }]);
  expect((await read()).some(source => source.storageId === task.id)).toBe(false);
  await db.delete(channelAgents).where(eq(channelAgents.agentId, agent.id));
  expect(await read()).toEqual(roots);
  await db.insert(channelAgents).values({ channelId: face.id, agentId: agent.id });
  // The person's joint membership is the parent permission (computed membership).
  await db.delete(jointChannelMembers).where(eq(jointChannelMembers.userId, owner.id));
  expect(await read()).toEqual(roots);
  await fillJointMembersFromChannelHumans();
  await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, parent.id));
  expect(await read()).toEqual(roots);
  await db.update(messages).set({ deletedAt: null }).where(eq(messages.id, parent.id));
  await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, ct.id));
  expect(await read()).toEqual(roots);
});
