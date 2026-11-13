/**
 * Fixture for the `*.realRw.test.ts` files, which run only in the `risingwave-real`
 * CI job (scripts/ci/risingwave-real-stack.sh) or against a local stack started
 * the same way: real Postgres with logical replication, CDC into a real
 * RisingWave carrying the server-read MV graph.
 *
 * The fixture writes plain rows to Postgres (names are unique per call, so a
 * stack can be reused across runs) and then waits, with a bound, until the
 * RisingWave serving views reflect them.
 *
 * Receiver's expected state on `receiverServer`:
 *   - general   (public channel): 1 unread message from `sender` that mentions
 *                                 the receiver and the agent.
 *   - thread    (followed thread under general): 1 unread reply.
 *   - receiverLocal (the receiver's projection of a joint conversation): 1 unread
 *                                 message stored in canonical storage whose mention
 *                                 rows sit under the SENDER's projection (the
 *                                 rw_inbox_mention_v6 case, see jointMentionV6.test.ts).
 * The agent is a member of general and receiverLocal and is mentioned in both.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Database } from "../db/index";
import { queryRisingWave } from "../db/risingwave";
import {
  agents,
  channelAgents,
  channelHumans,
  channels,
  jointChannels,
  jointChannelServers,
  messageMentions,
  messages,
  serverMembers,
  servers,
  threadFollows,
  users,
} from "../db/schema";

export type RealRwFixture = Awaited<ReturnType<typeof seedRealRwFixture>>;

export async function seedRealRwFixture(db: Database) {
  const tag = randomUUID().slice(0, 8);
  const [sender, receiver, owner] = await db.insert(users).values(
    ["sender", "receiver", "owner"].map((role) => ({
      name: `rwreal-${role}-${tag}`,
      email: `rwreal-${role}-${tag}@test.invalid`,
      passwordHash: "x",
      emailVerified: true,
    })),
  ).returning();
  const [senderServer, receiverServer, storage] = await db.insert(servers).values([
    { name: `RW real sender ${tag}`, slug: `rwreal-sender-${tag}`, ownerId: owner.id },
    { name: `RW real receiver ${tag}`, slug: `rwreal-receiver-${tag}`, ownerId: owner.id },
    { name: `RW real storage ${tag}`, slug: `__rwreal_storage_${tag}__`, ownerId: owner.id, kind: "joint_storage" },
  ]).returning();
  await db.insert(serverMembers).values([
    { serverId: senderServer.id, userId: owner.id, role: "owner" },
    { serverId: receiverServer.id, userId: owner.id, role: "owner" },
    { serverId: senderServer.id, userId: sender.id, role: "member" },
    { serverId: receiverServer.id, userId: sender.id, role: "member" },
    { serverId: receiverServer.id, userId: receiver.id, role: "member" },
  ]);
  const [general, canonical, senderLocal, receiverLocal] = await db.insert(channels).values([
    { serverId: receiverServer.id, name: `rwreal-general-${tag}`, type: "channel" },
    { serverId: storage.id, name: `rwreal-canonical-${tag}`, type: "joint" },
    { serverId: senderServer.id, name: `rwreal-sender-local-${tag}`, type: "joint" },
    { serverId: receiverServer.id, name: `rwreal-receiver-local-${tag}`, type: "joint" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id, createdByServerId: senderServer.id, createdByUserId: owner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint.id, serverId: senderServer.id, localChannelId: senderLocal.id, role: "host", status: "active", joinedByUserId: owner.id },
    { jointChannelId: joint.id, serverId: receiverServer.id, localChannelId: receiverLocal.id, role: "participant", status: "active", joinedByUserId: owner.id },
  ]);
  const [agent] = await db.insert(agents).values({
    serverId: receiverServer.id, name: `rwreal-agent-${tag}`, status: "active",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: general.id, userId: sender.id },
    { channelId: general.id, userId: receiver.id },
    { channelId: senderLocal.id, userId: sender.id },
    { channelId: receiverLocal.id, userId: receiver.id },
  ]);
  await db.insert(channelAgents).values([
    { channelId: general.id, agentId: agent.id },
    { channelId: receiverLocal.id, agentId: agent.id },
  ]);

  // Memberships (joined_at) strictly precede the activity they should surface.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const mentionTargets = [
    { targetType: "user" as const, targetId: receiver.id },
    { targetType: "agent" as const, targetId: agent.id },
  ];
  const [generalMessage] = await db.insert(messages).values({
    channelId: general.id, senderType: "user", senderId: sender.id, content: `hello @receiver @agent ${tag}`,
  }).returning();
  await db.insert(messageMentions).values(mentionTargets.map((target) => ({
    messageId: generalMessage.id, messageSeq: generalMessage.seq, serverId: receiverServer.id,
    channelId: general.id, handleAtSendTime: "you", ...target,
  })));

  const [thread] = await db.insert(channels).values({
    serverId: receiverServer.id, name: `thread-${generalMessage.id.slice(0, 8)}`, type: "thread", parentMessageId: generalMessage.id,
  }).returning();
  await db.insert(threadFollows).values({
    threadChannelId: thread.id, parentMessageId: generalMessage.id, reason: "manual", followerType: "user", followerId: receiver.id,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [threadReply] = await db.insert(messages).values({
    channelId: thread.id, senderType: "user", senderId: sender.id, content: `thread reply ${tag}`,
  }).returning();

  // Joint: stored in canonical storage, mention rows under the SENDER's projection.
  const [jointMessage] = await db.insert(messages).values({
    channelId: canonical.id, senderType: "user", senderId: sender.id, content: `joint @receiver @agent ${tag}`,
  }).returning();
  await db.insert(messageMentions).values(mentionTargets.map((target) => ({
    messageId: jointMessage.id, messageSeq: jointMessage.seq, serverId: senderServer.id,
    channelId: senderLocal.id, handleAtSendTime: "you", ...target,
  })));

  return {
    tag, sender, receiver, owner, senderServer, receiverServer, storage,
    general, canonical, senderLocal, receiverLocal, thread, agent,
    generalMessage, threadReply, jointMessage,
  };
}

/**
 * Poll RisingWave until the fixture has propagated through CDC and every serving
 * view the readers use, or fail after `timeoutMs` with what was still missing.
 */
export async function waitForRealRwFixture(
  pool: pg.Pool,
  f: RealRwFixture,
  timeoutMs = Number(process.env.RISINGWAVE_REAL_CDC_TIMEOUT_MS ?? 120_000),
): Promise<void> {
  const checks: Array<{ label: string; sql: string; values: unknown[]; expected: number }> = [
    {
      label: "rw_messages (CDC)",
      sql: "SELECT count(*) AS n FROM rw_messages WHERE id = ANY($1)",
      values: [[f.generalMessage.id, f.threadReply.id, f.jointMessage.id]],
      expected: 3,
    },
    {
      label: "rw_conversation_unread_v4 (receiver unread rows)",
      sql: `SELECT count(*) AS n FROM rw_conversation_unread_v4
            WHERE receiver_type = 'user' AND receiver_id = $1 AND server_id = $2 AND unread_count = 1`,
      values: [f.receiver.id, f.receiverServer.id],
      expected: 3,
    },
    {
      label: "rw_inbox_serving_v9 (receiver Activity rows)",
      sql: `SELECT count(*) AS n FROM rw_inbox_serving_v9
            WHERE receiver_type = 'user' AND receiver_id = $1 AND server_id = $2`,
      values: [f.receiver.id, f.receiverServer.id],
      expected: 3,
    },
    {
      label: "rw_agent_inbox_v7 (agent rows with a mention)",
      sql: "SELECT count(*) AS n FROM rw_agent_inbox_v7 WHERE agent_id = $1 AND mention_unread = 1",
      values: [f.agent.id],
      expected: 2,
    },
    {
      label: "rw_followed_threads_v5 (followed thread with its parent)",
      sql: `SELECT count(*) AS n FROM rw_followed_threads_v5
            WHERE server_id = $1 AND user_id = $2 AND thread_channel_id = $3
              AND reply_count = 1 AND parent_message_id = $4 AND parent_server_id = $1
              AND NOT joint_projection AND joint_parent_channel_id IS NULL`,
      values: [f.receiverServer.id, f.receiver.id, f.thread.id, f.generalMessage.id],
      expected: 1,
    },
  ];
  const deadline = Date.now() + timeoutMs;
  let pending: string[] = [];
  do {
    pending = [];
    for (const check of checks) {
      const read = await queryRisingWave<{ n: string }>(pool, check.sql, check.values);
      const n = Number(read.result.rows[0]?.n ?? -1);
      if (n !== check.expected) pending.push(`${check.label}: ${n}/${check.expected}`);
    }
    if (pending.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error(
    `RisingWave did not reflect the Postgres fixture within ${timeoutMs}ms (CDC or MV lag, or a broken view). `
      + `Still pending: ${pending.join("; ")}`,
  );
}
