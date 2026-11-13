// resolveJointHumanEntrySql({ storageChannelIds }) used to filter projections
// with an inline `joint_channel_id IN (SELECT root.id ... OR EXISTS (...))`,
// which forced a parallel scan of all `channels`. The joint ids are now
// resolved first (resolveJointIdsForStorageChannels). This pins that the
// resolved set equals the former inline subquery for every storage shape, and
// that the predicate denies (never allows) when nothing resolves.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { dbTest as test } from "../test/integration/dbTest";
import type { DatabaseExecutor } from "../db";
import { channels, jointChannels, messages, tasks } from "../db/schema";
import { createJointChannel, acceptJointChannelInvite } from "./channelService";
import { resolveJointHumanEntrySql, resolveJointIdsForStorageChannels } from "./jointHumanMembershipAccess";

/** The former inline condition, verbatim, as the oracle. */
async function formerJointIds(db: DatabaseExecutor, storageChannelIds: string[]) {
  const ids = sql.join(storageChannelIds.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = await db.execute(sql`
    SELECT root.id::text AS id FROM joint_channels root WHERE root.canonical_channel_id IN (${ids})
      OR EXISTS (SELECT 1 FROM channels child LEFT JOIN messages pm ON pm.id=child.parent_message_id
        LEFT JOIN tasks parent_task ON parent_task.id=child.task_id
        WHERE child.id IN (${ids})
          AND root.canonical_channel_id=coalesce(pm.channel_id,parent_task.channel_id,child.parent_channel_id))`);
  return (rows.rows as Array<{ id: string }>).map((row) => row.id).sort();
}

test("storage channel ids resolve to the same joint ids as the former inline subquery", async ({ db, seed }) => {
  const owner = await seed.human();
  const a = await seed.server({ owner });
  const b = await seed.server({ owner });
  const created = await createJointChannel({
    hostServerId: a.id,
    createdByUserId: owner.id,
    name: "storage-ids",
    targetServerSlug: b.slug,
    invitedPeople: [`@${owner.name}`],
    userIds: [],
  });
  await acceptJointChannelInvite({ inviteId: created.invites[0]!.id, targetServerId: b.id, acceptedByUserId: owner.id });
  const [joint] = await db.select().from(jointChannels).where(eq(jointChannels.id, created.jointChannel.id));
  const canonicalId = joint!.canonicalChannelId;

  // A thread under a message of the canonical channel (parent message path).
  const [root] = await db.insert(messages).values({
    channelId: canonicalId, senderType: "user", senderId: owner.id, content: "root", messageType: "chat",
  }).returning();
  const [thread] = await db.insert(channels).values({
    serverId: a.id, name: `thread-${randomUUID().slice(0, 8)}`, type: "thread", parentMessageId: root!.id,
  }).returning();
  // A task conversation of a task in the canonical channel (task path).
  const [task] = await db.insert(tasks).values({
    channelId: canonicalId, taskNumber: 9001, title: "t", status: "todo", createdByType: "user", createdById: owner.id,
  }).returning();
  const [taskConversation] = await db.insert(channels).values({
    serverId: a.id, name: `task-${randomUUID().slice(0, 8)}`, type: "task", taskId: task!.id, parentChannelId: canonicalId,
  }).returning();
  // A deeper child known only by parent_channel_id.
  const [deep] = await db.insert(channels).values({
    serverId: a.id, name: `deep-${randomUUID().slice(0, 8)}`, type: "thread", parentChannelId: canonicalId,
  }).returning();
  // A channel that belongs to no joint.
  const plain = await seed.channel({ server: a, members: [owner], name: `plain-${randomUUID().slice(0, 8)}` });

  const cases: Array<[string, string[]]> = [
    ["canonical channel", [canonicalId]],
    ["thread in the joint channel", [thread!.id]],
    ["task conversation", [taskConversation!.id]],
    ["deep child (parent_channel_id)", [deep!.id]],
    ["several storage ids", [canonicalId, thread!.id, deep!.id, plain.id]],
    ["no joint", [plain.id]],
    ["unknown id", [randomUUID()]],
  ];
  for (const [what, ids] of cases) {
    assert.deepEqual(
      (await resolveJointIdsForStorageChannels(ids, db)).sort(),
      await formerJointIds(db, ids),
      `${what}: same joint ids as the former subquery`,
    );
  }

  // A closed joint: both resolve it the same way (status is not part of the
  // id resolution), and the entry predicate, which requires an active joint,
  // denies through it exactly as before.
  await db.update(jointChannels).set({ status: "closed" }).where(eq(jointChannels.id, joint!.id));
  assert.deepEqual(
    (await resolveJointIdsForStorageChannels([canonicalId, thread!.id], db)).sort(),
    await formerJointIds(db, [canonicalId, thread!.id]),
    "closed joint: same joint ids as the former subquery",
  );
  const permission = await resolveJointHumanEntrySql({ storageChannelIds: [canonicalId] }, db);
  const local = await db.execute(sql`SELECT local_channel_id::text AS id FROM joint_channel_servers WHERE joint_channel_id = ${joint!.id}::uuid`);
  for (const row of local.rows as Array<{ id: string }>) {
    const result = await db.execute(sql`SELECT ${permission(sql`${row.id}::uuid`, sql`${owner.id}::uuid`)} AS allowed`);
    assert.equal((result.rows[0] as { allowed: boolean }).allowed, false, "a closed joint grants no entry");
  }
});

test("nothing resolved (or an empty list) denies, never allows", async ({ db, seed }) => {
  const owner = await seed.human();
  const a = await seed.server({ owner });
  const plain = await seed.channel({ server: a, members: [owner], name: `plain-${randomUUID().slice(0, 8)}` });
  for (const storageChannelIds of [[], [plain.id], [randomUUID()]]) {
    const permission = await resolveJointHumanEntrySql({ storageChannelIds }, db);
    const result = await db.execute(sql`SELECT ${permission(sql`${plain.id}::uuid`, sql`${owner.id}::uuid`)} AS allowed`);
    assert.equal((result.rows[0] as { allowed: boolean }).allowed, false, `storageChannelIds=${JSON.stringify(storageChannelIds)} must deny`);
  }
});
