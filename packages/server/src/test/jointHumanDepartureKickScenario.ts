import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db";
import { isInTransaction } from "../db/ambientTransaction";
import {
  agents,
  channelAgents,
  channelHumans,
  jointChannelAdmissions,
  serverMembers,
  serverAgentMembers,
  jointMembershipDepartures,
} from "../db/schema";
import {
  createJointChannel,
  acceptJointChannelInvite,
  addHuman,
  removeHuman,
} from "../services/channelService";
import { ServerMemberRoleTransitionError, removeMember, transitionMemberRole } from "../services/serverService";
import { configureJointDepartureEffects } from "../services/jointMembershipDeparture";
import { createSeed } from "./integration/seed";

export async function jointHumanDepartureKickScenario({
  db,
  seed,
}: {
  db: Database;
  seed: ReturnType<typeof createSeed>;
}) {
  for (const mode of ["channel_leave", "server_leave"] as const) {
    const host = await seed.human(),
      peer = await seed.human(),
      person = await seed.human();
    const h = await seed.server({ owner: host, members: [person] }),
      b = await seed.server({ owner: peer, members: [person] });
    const created = await createJointChannel({
      hostServerId: h.id,
      createdByUserId: host.id,
      name: "inline-" + mode,
      targetServerSlug: b.slug,
      invitedPeople: [`@${peer.name}`],
      userIds: [person.id],
    });
    const target = await acceptJointChannelInvite({
      inviteId: created.invites[0]!.id,
      targetServerId: b.id,
      acceptedByUserId: peer.id,
    });
    const [agent] = await db
      .insert(agents)
      .values({ name: "inline-agent", serverId: b.id })
      .returning();
    await db
      .insert(serverAgentMembers)
      .values({ serverId: b.id, agentId: agent!.id, role: "member" });
    await db
      .insert(channelAgents)
      .values({ channelId: target.id, agentId: agent!.id });
    await removeHuman(target.id, peer.id, { self: true });
    let calls = 0;
    configureJointDepartureEffects({
      revoke: async (batch) => {
        assert.equal(
          isInTransaction(),
          false,
          "external revocation cannot run inside the outer transaction",
        );
        assert.ok(batch.removals.some((row) => row.agentId === agent!.id));
        calls++;
      },
    });
    try {
      const mutate = () =>
        mode === "channel_leave"
          ? removeHuman(created.channel.id, person.id, { self: true })
          : removeMember(b.id, person.id);
      // Roll back an actual departure after it has registered the kick. A
      // transaction-settled callback must find no durable committed task.
      const abort = new Error("rollback complete departure");
      await assert.rejects(
        db.transaction(async () => {
          await mutate();
          assert.equal(calls, 0);
          throw abort;
        }),
        (error) => error === abort,
      );
      assert.equal(calls, 0);
      await db.transaction(async () => {
        await mutate();
        assert.equal(calls, 0, "nested mutation must wait for outer commit");
      });
      const deadline = Date.now() + 5000;
      for (;;) {
        const [header] = await db
          .select()
          .from(jointMembershipDepartures)
          .where(eq(jointMembershipDepartures.localChannelId, target.id));
        if (header?.completedAt) break;
        assert.ok(
          Date.now() < deadline,
          "inline departure did not finish without a recovery sweep",
        );
        await new Promise((done) => setTimeout(done, 5));
      }
      assert.equal(
        calls,
        1,
        "one committed departure runs exactly once without recovery",
      );
    } finally {
      configureJointDepartureEffects(null);
    }
  }

  // Demotion is no departure trigger: no role change makes a Guest
  // (#wg-rbac:#15). It is refused and leaves role, membership, sources and
  // departures as they were.
  {
    const host = await seed.human(),
      peer = await seed.human(),
      person = await seed.human();
    const h = await seed.server({ owner: host, members: [person] }),
      b = await seed.server({ owner: peer, members: [person] });
    const created = await createJointChannel({
      hostServerId: h.id,
      createdByUserId: host.id,
      name: "inline-demotion",
      targetServerSlug: b.slug,
      invitedPeople: [`@${peer.name}`],
    });
    const target = await acceptJointChannelInvite({
      inviteId: created.invites[0]!.id,
      targetServerId: b.id,
      acceptedByUserId: peer.id,
    });
    // The person enters J through B, so a B demotion would end its source.
    await addHuman(target.id, person.id);
    const snapshot = async () => ({
      role: (await db.select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId }).from(serverMembers)
        .where(and(eq(serverMembers.serverId, b.id), eq(serverMembers.userId, person.id)))),
      membership: (await db.select().from(channelHumans).where(eq(channelHumans.userId, person.id)))
        .map((row) => row.channelId).sort(),
      sources: (await db.select().from(jointChannelAdmissions)
        .where(and(eq(jointChannelAdmissions.jointChannelId, created.jointChannel.id), eq(jointChannelAdmissions.userId, person.id))))
        .map((row) => ({ serverId: row.serverId, generation: row.generation, endedAt: row.endedAt })),
      departures: await db.select().from(jointMembershipDepartures).where(eq(jointMembershipDepartures.localChannelId, target.id)),
    });
    const before = await snapshot();
    assert.deepEqual(before.role, [{ role: "member", guestChannelId: null }]);
    assert.ok(before.sources.some((row) => row.serverId === b.id && row.endedAt === null) && before.membership.includes(target.id), "the person is in J through B (the snapshot is not vacuous)");
    let calls = 0;
    configureJointDepartureEffects({ revoke: async () => { calls++; } });
    try {
      await assert.rejects(
        transitionMemberRole({ serverId: b.id, actorUserId: peer.id, targetUserId: person.id, nextRole: "guest" }),
        (error: unknown) => error instanceof ServerMemberRoleTransitionError && error.code === "transition_forbidden",
      );
      assert.deepEqual(await snapshot(), before, "a refused demotion changes nothing");
      assert.equal(calls, 0, "a refused demotion revokes nothing");
    } finally {
      configureJointDepartureEffects(null);
    }
  }
}
