import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db";
import {
  channelHumans,
  jointChannelAdmissions,
  jointChannelInvites,
  jointChannelMembers,
  jointChannelServers,
  serverMembers,
  servers,
} from "../db/schema";
import {
  acceptJointChannelInvites,
  createJointChannel,
  inviteServerToJointChannel,
  getChannelMembers,
} from "../services/channelService";
import { createSeed } from "./integration/seed";
export async function jointHumanMultiConnectScenario({
  db,
  seed,
}: {
  db: Database;
  seed: ReturnType<typeof createSeed>;
}) {
  const hostOwner = await seed.human(),
    acceptor = await seed.human();
  const h = await seed.server({ owner: hostOwner });
  const peers = [];
  for (let i = 0; i < 4; i++)
    peers.push(await seed.server({ owner: acceptor }));
  await db
    .update(servers)
    .set({ plan: "founder" })
    .where(inArray(servers.id, [h.id, ...peers.map((row) => row.id)]));
  const created = await createJointChannel({
    hostServerId: h.id,
    createdByUserId: hostOwner.id,
    name: "multi-sources",
    jointInvites: peers.slice(0, 2).map((peer) => ({
      targetServerSlug: peer.slug,
      invitedPeople: [`@${acceptor.name}`],
    })),
  });
  const initialIds = created.invites.map((invite) => invite.id);
  await db
    .update(serverMembers)
    .set({ role: "member" })
    .where(
      and(
        eq(serverMembers.serverId, peers[1]!.id),
        eq(serverMembers.userId, acceptor.id),
      ),
    );
  await assert.rejects(
    acceptJointChannelInvites({
      inviteIds: initialIds,
      acceptedByUserId: acceptor.id,
    }),
    /Only target server admins/,
  );
  assert.equal(
    (
      await db
        .select()
        .from(jointChannelServers)
        .where(eq(jointChannelServers.jointChannelId, created.jointChannel.id))
    ).length,
    1,
    "failed second selection rolls back the first connection",
  );
  assert.equal(
    (
      await db
        .select()
        .from(jointChannelMembers)
        .where(eq(jointChannelMembers.userId, acceptor.id))
    ).length,
    0,
  );
  const pending = await db
    .select()
    .from(jointChannelInvites)
    .where(inArray(jointChannelInvites.id, initialIds));
  assert.ok(pending.every((invite) => invite.status === "pending"));
  await db
    .update(serverMembers)
    .set({ role: "owner" })
    .where(
      and(
        eq(serverMembers.serverId, peers[1]!.id),
        eq(serverMembers.userId, acceptor.id),
      ),
    );
  const accepted = await acceptJointChannelInvites({
    inviteIds: initialIds,
    acceptedByUserId: acceptor.id,
  });
  assert.equal(accepted.length, 2);
  const sources = () =>
    db
      .select()
      .from(jointChannelAdmissions)
      .where(
        and(
          eq(jointChannelAdmissions.jointChannelId, created.jointChannel.id),
          eq(jointChannelAdmissions.userId, acceptor.id),
        ),
      );
  // Mei's simultaneous two-source join is viewed through each entry. Neither
  // the roster nor its profile source fields may return that entry's source.
  for (const entry of accepted) {
    const publicRow = (await getChannelMembers(entry.id)).humans.find(
      (row) => row.id === acceptor.id,
    )!;
    assert.deepEqual(
      publicRow.servers?.map((row) => row.id),
      peers
        .slice(0, 2)
        .map((row) => row.id)
        .filter((id) => id !== entry.serverId),
    );
  }
  const first = await sources();
  assert.equal(first.length, 2);
  assert.equal(
    new Set(first.map((row) => row.generation)).size,
    1,
    "all selected sources are one episode",
  );
  const nextInvites = [];
  for (const peer of peers.slice(2)) {
    const result = await inviteServerToJointChannel({
      localChannelId: created.channel.id,
      fromServerId: h.id,
      invitedByUserId: hostOwner.id,
      targetServerSlug: peer.slug,
      invitedPeople: [`@${acceptor.name}`],
    });
    nextInvites.push(...result.invites.map((invite) => invite.id));
  }
  const later = await acceptJointChannelInvites({
    inviteIds: nextInvites,
    acceptedByUserId: acceptor.id,
  });
  assert.equal(later.length, 2);
  assert.deepEqual(
    await sources(),
    first,
    "existing J member never accumulates new sources",
  );
  assert.equal(
    (
      await db
        .select()
        .from(channelHumans)
        .where(
          and(
            inArray(
              channelHumans.channelId,
              later.map((row) => row.id),
            ),
            eq(channelHumans.userId, acceptor.id),
          ),
        )
    ).length,
    0,
    "new entry for an existing J member creates neither legacy CH nor a read position",
  );
}
