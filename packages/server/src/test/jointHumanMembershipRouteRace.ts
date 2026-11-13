import assert from "node:assert/strict";
import pg from "pg";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db";
import { channels, channelHumans, jointChannelAdmissions, jointChannelMembers, messageMentions } from "../db/schema";
import { addMember } from "../services/serverService";
import { removeHuman } from "../services/channelService";
import { createTasks } from "../services/taskService";
import { ensureTaskConversation } from "../services/taskConversationService";
import { createMessage } from "../services/messageService";
import { executeMentionActionId } from "../services/mentionActionService";
import { connected } from "./jointHumanMembershipScenarios";
import type { createSeed } from "./integration/seed";
import { createHttpClient } from "./integration/http";

async function waitingOn(observer: pg.Client, blockerPid: number, queryFragment: string): Promise<number> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND $1 = ANY(pg_blocking_pids(pid)) AND query ILIKE $2`, [blockerPid, `%${queryFragment}%`]);
    if (rows[0]) return rows[0].pid;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Expected waiter on backend ${blockerPid} at ${queryFragment}`);
}

/** Actual HTTP membership route versus actual mention-add service on a local
 * task under the same joint. A separate client holds the route target's SM row,
 * so the route has the channel lock before mention starts. No production hooks
 * or hand-written imitation of either writer are used. */
export async function jointHumanMembershipRouteRace(f: {
  db: Database; seed: ReturnType<typeof createSeed>; baseUrl: string; databaseUrl: string;
}) {
  const { db, seed } = f;
  const x = await connected(f);
  await removeHuman(x.joint.channel.id, x.peer.id, { self: true });
  const mentioned = await seed.human(); await addMember(x.a.id, mentioned.id);
  const created = await createTasks(x.joint.jointChannel.canonicalChannelId, "user", x.owner.id,
    [{ title: "joint membership race" }], { initiatingServerId: x.a.id });
  const discussion = await ensureTaskConversation(created.tasks[0]!.id, { initiatingServerId: x.a.id, createdByUserId: x.owner.id });
  assert.ok(discussion);
  const localTask = discussion.conversation.localByServer.get(x.a.id);
  assert.ok(localTask);
  const message = await createMessage(discussion.conversation.canonicalChannelId, "user", x.owner.id, "mention membership race");
  const [mention] = await db.insert(messageMentions).values({ messageId: message.id, messageSeq: message.seq,
    serverId: x.a.id, channelId: localTask.localChannelId, targetType: "user", targetId: mentioned.id,
    handleAtSendTime: mentioned.name, notifiableAtSend: false }).returning();
  const blocker = new pg.Client({ connectionString: f.databaseUrl });
  const observer = new pg.Client({ connectionString: f.databaseUrl });
  const clientErrors: Error[] = [];
  blocker.on("error", (error: Error) => { clientErrors.push(error); });
  observer.on("error", (error: Error) => { clientErrors.push(error); });
  await blocker.connect(); await observer.connect();
  let route: Promise<Response> | undefined;
  let action: ReturnType<typeof executeMentionActionId> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2 FOR UPDATE", [x.a.id, x.peer.id]);
    const blockerPid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0]!.pid;
    route = createHttpClient(f.baseUrl).as(x.owner, x.a).request(`/api/channels/${x.joint.channel.id}/members`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: x.peer.id }),
      signal: AbortSignal.timeout(15_000),
    });
    const routePid = await waitingOn(observer, blockerPid, "server_members");
    action = executeMentionActionId(mention!.id, x.a.id, "user", x.owner.id, "add");
    // Catch immediately: old lock order produces 40P01 after the blocker is
    // released, before Promise.allSettled below observes the rejected action.
    void action.catch(() => {});
    await waitingOn(observer, routePid, '"channels"');
    await blocker.query("COMMIT");
    const [routeResult, mentionResult] = await Promise.allSettled([route, action]);
    if (routeResult.status !== "fulfilled") throw new Error("actual add-member HTTP request must settle", { cause: routeResult.reason });
    assert.equal(routeResult.value.status, 200, await routeResult.value.clone().text());
    if (mentionResult.status !== "fulfilled") throw new Error("mention add must settle without 40P01", { cause: mentionResult.reason });
    assert.equal(mentionResult.value.status, "delivered", JSON.stringify(mentionResult.value));
    for (const userId of [x.peer.id, mentioned.id]) {
      assert.equal((await db.select().from(channelHumans).where(and(eq(channelHumans.channelId, x.joint.channel.id), eq(channelHumans.userId, userId)))).length, 1);
      // Admissions are generational since #11525: the peer's pre-race removal keeps its old
      // episode's row as history, so count A's source at the current membership generation.
      const [member] = await db.select().from(jointChannelMembers).where(and(eq(jointChannelMembers.jointChannelId, x.joint.jointChannel.id), eq(jointChannelMembers.userId, userId)));
      assert.ok(member, "the person is a J member");
      assert.equal((await db.select().from(jointChannelAdmissions).where(and(eq(jointChannelAdmissions.jointChannelId, x.joint.jointChannel.id), eq(jointChannelAdmissions.userId, userId), eq(jointChannelAdmissions.serverId, x.a.id), eq(jointChannelAdmissions.generation, member.generation), isNull(jointChannelAdmissions.endedAt)))).length, 1, "exactly one current A source");
    }
    assert.deepEqual(clientErrors, [], "standalone PostgreSQL clients must not emit connection errors");
    assert.equal((await db.select().from(channels).where(eq(channels.id, localTask.localChannelId)))[0]?.type, "task");
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    await Promise.allSettled([route, action].filter((promise): promise is NonNullable<typeof promise> => promise !== undefined));
    await blocker.end(); await observer.end();
  }
}
