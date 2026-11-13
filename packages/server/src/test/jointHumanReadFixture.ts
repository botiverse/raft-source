import assert from "node:assert/strict";
import { connected } from "./jointHumanMembershipScenarios";
import { and, eq } from "drizzle-orm";
import { channelHumans, channels, jointChannels, jointChannelServers, messages, tasks, threadFollows } from "../db/schema";
import { executeCompatibilityReadMutation, type ReadMutationPayload } from "../services/readMutationSequencer";

export async function jointHumanReadFixture(input: Parameters<typeof connected>[0]) {
  const x = await connected(input);
  const { db } = input;
  assert.equal((await db.select().from(channelHumans).where(and(
    eq(channelHumans.channelId, x.target.id), eq(channelHumans.userId, x.peer.id),
  ))).length, 0, "the reader is a J member with no legacy join at B");
  const [parent] = await db.insert(messages).values({
    channelId: x.joint.jointChannel.canonicalChannelId, senderType: "user", senderId: x.owner.id,
    content: "read through the new entry", seq: 10,
  }).returning();
  const [task] = await db.insert(tasks).values({
    channelId: x.joint.jointChannel.canonicalChannelId, taskNumber: 1,
    title: "shared task", createdByType: "user", createdById: x.owner.id,
  }).returning();
  const children = [];
  for (const type of ["thread", "task"] as const) {
    const [storage, local] = await db.insert(channels).values([
      { serverId: x.a.id, name: `${type}-storage`, type,
        ...(type === "thread" ? { parentMessageId: parent.id } : { taskId: task.id, parentChannelId: x.joint.jointChannel.canonicalChannelId }) },
      { serverId: x.b.id, name: `${type}-entry`, type, parentChannelId: x.target.id,
        ...(type === "task" ? { taskId: task.id } : {}) },
    ]).returning();
    const [joint] = await db.insert(jointChannels).values({
      canonicalChannelId: storage.id, createdByServerId: x.a.id, createdByUserId: x.owner.id, status: "active",
    }).returning();
    await db.insert(jointChannelServers).values({
      jointChannelId: joint.id, serverId: x.b.id, localChannelId: local.id, role: "participant", status: "active",
    });
    await db.insert(messages).values({
      channelId: storage.id, senderType: "user", senderId: x.owner.id, content: type, seq: 11,
    });
    await db.insert(threadFollows).values({
      threadChannelId: local.id, followerType: "user", followerId: x.peer.id, reason: "manual",
      ...(type === "thread" ? { parentMessageId: parent.id } : { parentTaskId: task.id }),
    });
    children.push({ storage, local });
  }
  const run = (mutation: ReadMutationPayload) => executeCompatibilityReadMutation({
    serverId: x.b.id, principalId: x.peer.id, mutation,
  });
  return { ...x, children, run };
}
