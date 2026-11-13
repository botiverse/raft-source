import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";
import type { Database } from "../db";
import {
  agents,
  channelAgents,
  channelHumans,
  jointChannelMembers,
  jointMembershipDepartures,
  jointMembershipRemovals,
  serverAgentMembers,
  serverMembers,
  servers,
} from "../db/schema";
import {
  createJointChannel,
  acceptJointChannelInvite,
  disconnectJointChannel,
  canUserAccessChannel,
  canUserPostToChannel,
  filterUserAccessibleChannelIds,
  canAgentAccessChannel,
} from "../services/channelService";
import { addMember } from "../services/serverService";
import {
  assertJointReconnectReady,
  cleanJointMembershipDepartureBatch,
  JOINT_DEPARTURE_BATCH_SIZE,
  type JointMembershipDepartureId,
} from "../services/jointMembershipDeparture";
import { createSeed } from "./integration/seed";

export async function jointMembershipDepartureScenario({
  db,
  seed,
}: {
  db: Database;
  seed: ReturnType<typeof createSeed>;
}) {
  const hostOwner = await seed.human();
  const peerOwner = await seed.human();
  const survivor = await seed.human();
  const a = await seed.server({ owner: hostOwner, members: [survivor] });
  const b = await seed.server({ owner: peerOwner, members: [survivor] });
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, a.id));
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, b.id));
  const created = await createJointChannel({
    hostServerId: a.id,
    createdByUserId: hostOwner.id,
    name: "bounded-departure",
    targetServerSlug: b.slug,
    invitedPeople: [`@${peerOwner.name}`],
    userIds: [survivor.id],
  });
  const target = await acceptJointChannelInvite({
    inviteId: created.invites[0]!.id,
    targetServerId: b.id,
    acceptedByUserId: peerOwner.id,
  });
  // A consistent pre-cutover fixture larger than the bounded-delete threshold.
  // Production mutation below is the real disconnect and actual cleanup SQL.
  const victims = [];
  for (let i = 0; i < JOINT_DEPARTURE_BATCH_SIZE; i++)
    victims.push(await seed.human());
  await db
    .insert(serverMembers)
    .values(
      victims.map((user) => ({
        serverId: b.id,
        userId: user.id,
        role: "member" as const,
      })),
    );
  await db
    .insert(channelHumans)
    .values(victims.map((user) => ({ channelId: target.id, userId: user.id })));
  await db
    .insert(jointChannelMembers)
    .values(
      victims.map((user) => ({
        jointChannelId: created.jointChannel.id,
        userId: user.id,
      })),
    );
  const [agent] = await db
    .insert(agents)
    .values({ name: "departing-agent", serverId: b.id })
    .returning();
  await db
    .insert(serverAgentMembers)
    .values({ agentId: agent!.id, serverId: b.id, role: "member" });
  await db
    .insert(channelAgents)
    .values({ channelId: target.id, agentId: agent!.id });
  await db.execute(sql`CREATE FUNCTION fail_joint_departure_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected snapshot failure'; END $$`);
  await db.execute(sql`CREATE TRIGGER fail_joint_departure_snapshot BEFORE INSERT ON joint_membership_removals
    FOR EACH ROW EXECUTE FUNCTION fail_joint_departure_snapshot()`);
  try {
    await assert.rejects(
      disconnectJointChannel(target.id, peerOwner.id),
      (error) =>
        error instanceof Error &&
        String(error.cause).includes("injected snapshot failure"),
    );
  } finally {
    await db.execute(
      sql`DROP TRIGGER fail_joint_departure_snapshot ON joint_membership_removals`,
    );
  }
  assert.equal(
    (await db.select().from(jointMembershipDepartures)).length,
    0,
    "snapshot failure rolls back the disconnect header too",
  );
  assert.equal(
    await canUserAccessChannel(target.id, peerOwner.id, asServerId(b.id)),
    true,
    "failed snapshot leaves the old connection active",
  );
  await disconnectJointChannel(target.id, peerOwner.id);
  const [departure] = await db
    .select()
    .from(jointMembershipDepartures)
    .where(eq(jointMembershipDepartures.localChannelId, target.id));
  assert.ok(departure);
  const id = departure.id as JointMembershipDepartureId;
  const pending = () =>
    db
      .select()
      .from(jointMembershipRemovals)
      .where(eq(jointMembershipRemovals.departureId, id));
  assert.equal(
    (await pending()).length,
    JOINT_DEPARTURE_BATCH_SIZE + 3,
    "global removals and survivor entry revocation fixed in one commit",
  );
  assert.equal(
    (await pending()).find((row) => row.userId === survivor.id)
      ?.removeMembership,
    false,
    "survivor is entry-only, never a global denial",
  );
  assert.equal(
    await canUserAccessChannel(
      created.channel.id,
      survivor.id,
      asServerId(a.id),
    ),
    true,
    "entry-only pending revocation must not deny retained H access",
  );
  assert.equal(
    (await pending()).every((row) => row.membershipRemovedAt === null),
    true,
    "large disconnect defers bounded physical deletion",
  );
  const late = victims[0]!;
  await addMember(a.id, late.id);
  assert.equal(
    await canUserAccessChannel(created.channel.id, late.id, asServerId(a.id)),
    false,
    "joining H after the fixed-list commit cannot rescue the membership",
  );
  assert.equal(await canUserPostToChannel(created.channel.id, late.id), false);
  assert.equal(
    (
      await filterUserAccessibleChannelIds(
        [created.channel.id],
        late.id,
        asServerId(a.id),
      )
    ).size,
    0,
  );
  // Give the rollback branch an adversarial stale H compatibility row.
  await db
    .insert(channelHumans)
    .values({ channelId: created.channel.id, userId: late.id });
  assert.equal(
    await canUserAccessChannel(created.channel.id, late.id, asServerId(a.id)),
    false,
    "fixed-list denial survives a flag rollback and stale CH",
  );
  await assert.rejects(
    db.transaction((tx) =>
      assertJointReconnectReady(tx, created.jointChannel.id, b.id),
    ),
    /cleanup in progress/,
  );
  await assert.rejects(
    cleanJointMembershipDepartureBatch(id, {
      revoke: async (batch) => {
        assert.ok(batch.removals.length <= JOINT_DEPARTURE_BATCH_SIZE);
        throw new Error("injected post-commit Socket/runtime failure");
      },
    }),
    /injected post-commit/,
  );
  assert.equal(
    (await pending()).length,
    JOINT_DEPARTURE_BATCH_SIZE + 3,
    "failure retains durable denial and retry subjects",
  );
  let batches = 0;
  const all = new Set<string>();
  for (;;) {
    const complete = await cleanJointMembershipDepartureBatch(id, {
      revoke: async (batch) => {
        batches++;
        assert.ok(batch.removals.length <= JOINT_DEPARTURE_BATCH_SIZE);
        for (const row of batch.removals) {
          all.add(row.id);
          if (row.userId && row.removeMembership) {
            assert.equal(
              (
                await db
                  .select()
                  .from(jointChannelMembers)
                  .where(
                    and(
                      eq(
                        jointChannelMembers.jointChannelId,
                        created.jointChannel.id,
                      ),
                      eq(jointChannelMembers.userId, row.userId),
                    ),
                  )
              ).length,
              0,
            );
          }
        }
      },
    });
    if (complete) break;
  }
  assert.equal(batches, 2);
  assert.equal(all.size, JOINT_DEPARTURE_BATCH_SIZE + 3);
  // Kept as history (who the disconnect removed), each marked completed.
  assert.equal((await pending()).length, JOINT_DEPARTURE_BATCH_SIZE + 3);
  assert.ok((await pending()).every((row) => row.completedAt !== null));
  await db.transaction((tx) =>
    assertJointReconnectReady(tx, created.jointChannel.id, b.id),
  );
  assert.equal(
    (
      await db
        .select()
        .from(jointChannelMembers)
        .where(
          and(
            eq(jointChannelMembers.jointChannelId, created.jointChannel.id),
            eq(jointChannelMembers.userId, late.id),
          ),
        )
    ).length,
    0,
    "cleanup uses the fixed list, not the later H identity",
  );
  assert.equal(
    (
      await db
        .select()
        .from(channelHumans)
        .where(
          and(
            eq(channelHumans.channelId, created.channel.id),
            eq(channelHumans.userId, late.id),
          ),
        )
    ).length,
    0,
    "all stale compatibility rows are removed",
  );
  assert.equal(await canAgentAccessChannel(target.id, agent!.id), false);
}
