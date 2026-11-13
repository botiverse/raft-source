import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db";
import {
  agents,
  channelAgents,
  jointChannelServers,
  jointMembershipDepartures,
  serverAgentMembers,
  serverMembers,
} from "../db/schema";
import {
  createJointChannel,
  acceptJointChannelInvite,
  removeHuman,
  canAgentAccessChannel,
  isChannelAgent,
  listChannelsForAgent,
} from "../services/channelService";
import { removeMember } from "../services/serverService";
import {
  createTasks,
  assignTask,
  updateTaskStatus,
  deleteTaskByOwner,
  resolveTaskById,
} from "../services/taskService";
import { JointTaskWriteDeniedError } from "../services/jointTaskWriteAuthority";
import { createSeed } from "./integration/seed";

export async function jointHumanLifecycleScenario({
  db,
  seed,
}: {
  db: Database;
  seed: ReturnType<typeof createSeed>;
}) {
  const hostOwner = await seed.human(),
    peerOwner = await seed.human(),
    survivor = await seed.human();
  const h = await seed.server({ owner: hostOwner, members: [survivor] }),
    b = await seed.server({ owner: peerOwner, members: [survivor] });
  const created = await createJointChannel({
    hostServerId: h.id,
    createdByUserId: hostOwner.id,
    name: "identity-counts",
    targetServerSlug: b.slug,
    invitedPeople: [`@${peerOwner.name}`],
    userIds: [survivor.id],
  });
  const target = await acceptJointChannelInvite({
    inviteId: created.invites[0]!.id,
    targetServerId: b.id,
    acceptedByUserId: peerOwner.id,
  });
  const [agent] = await db
    .insert(agents)
    .values({ name: "auto-departing", serverId: b.id })
    .returning();
  await db
    .insert(serverAgentMembers)
    .values({ agentId: agent!.id, serverId: b.id, role: "member" });
  await db
    .insert(channelAgents)
    .values({ channelId: target.id, agentId: agent!.id });
  const tasks = await createTasks(
    created.jointChannel.canonicalChannelId,
    "agent",
    agent!.id,
    [{ title: "must stop writing" }],
    { initiatingServerId: b.id },
  );
  const task = tasks.tasks[0]!;
  await assignTask(
    task.id,
    { type: "agent", id: agent!.id },
    "user",
    hostOwner.id,
    { serverId: h.id },
  );
  const status = async () =>
    (
      await db
        .select()
        .from(jointChannelServers)
        .where(eq(jointChannelServers.localChannelId, target.id))
    )[0]!.status;
  await removeHuman(target.id, peerOwner.id, { self: true });
  assert.equal(
    await status(),
    "active",
    "H-introduced person still in B keeps B connected",
  );
  await db.execute(
    sql`CREATE FUNCTION fail_auto_departure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'auto snapshot failure'; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER fail_auto_departure BEFORE INSERT ON joint_membership_removals FOR EACH ROW EXECUTE FUNCTION fail_auto_departure()`,
  );
  try {
    await assert.rejects(
      removeMember(b.id, survivor.id),
      (error) =>
        error instanceof Error &&
        String(error.cause).includes("auto snapshot failure"),
    );
  } finally {
    await db.execute(
      sql`DROP TRIGGER fail_auto_departure ON joint_membership_removals`,
    );
  }
  assert.equal(await status(), "active");
  assert.ok(
    (
      await db
        .select()
        .from(serverMembers)
        .where(
          and(
            eq(serverMembers.serverId, b.id),
            eq(serverMembers.userId, survivor.id),
          ),
        )
    ).length,
    "snapshot failure rolls back server departure as well as auto-disconnect",
  );
  await removeMember(b.id, survivor.id);
  assert.equal(
    await status(),
    "disconnected",
    "zero current B identities auto-disconnects in the same commit",
  );
  assert.equal((await db.select().from(jointMembershipDepartures)).length, 1);
  assert.equal(await isChannelAgent(target.id, agent!.id), false);
  assert.equal(await canAgentAccessChannel(target.id, agent!.id), false);
  assert.equal(
    (await listChannelsForAgent(b.id, agent!.id)).some(
      (row) => row.id === target.id,
    ),
    false,
  );
  for (const mutation of [
    () =>
      createTasks(
        created.jointChannel.canonicalChannelId,
        "agent",
        agent!.id,
        [{ title: "late" }],
        { initiatingServerId: b.id },
      ),
    () =>
      assignTask(
        task.id,
        { type: "user", id: survivor.id },
        "agent",
        agent!.id,
      ),
    () => updateTaskStatus(task.id, "closed", agent!.id, "agent"),
    async () =>
      deleteTaskByOwner((await resolveTaskById(task.id))!, {
        type: "agent",
        id: agent!.id,
      }),
  ])
    await assert.rejects(mutation, JointTaskWriteDeniedError);
  const host = (
    await db
      .select()
      .from(jointChannelServers)
      .where(eq(jointChannelServers.localChannelId, created.channel.id))
  )[0]!;
  assert.equal(
    host.status,
    "active",
    "host is exempt from automatic empty-connection removal",
  );
}
