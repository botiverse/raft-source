import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db";
import { asServerId } from "@botiverse/raft-shared";
import { jointChannelMembers, serverMembers } from "../db/schema";
import {
  createJointChannel,
  acceptJointChannelInvite,
  addHuman,
  removeHuman,
  canUserAccessChannel,
  archiveChannel,
} from "../services/channelService";
import {
  addMember,
  removeMember,
  transitionMemberRole,
} from "../services/serverService";
import { withLockedChannelActorCapability } from "../lib/channelActorPermissions";
import { createSeed } from "./integration/seed";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function blocked(db: Database) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const r = await db.execute(sql`SELECT count(*)::int n FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'`);
    if (Number(r.rows[0]?.n) > 0) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail(
    "actual competing service did not wait for the first writer's lock",
  );
}

/** Real PostgreSQL only: actual services and transaction/row/advisory locks,
 * both orders of a new host identity versus host-authorized removal, role loss and
 * shared archive versus a B writer. No sleep establishes the ordering. */
export async function jointHumanAuthorityConcurrency({
  db,
  seed,
}: {
  db: Database;
  seed: ReturnType<typeof createSeed>;
}) {
  const owner = await seed.human();
  const manager = await seed.human();
  const victim = await seed.human();
  const a = await seed.server({ owner, members: [manager] });
  const b = await seed.server({ owner, members: [manager, victim] });
  const created = await createJointChannel({
    hostServerId: a.id,
    createdByUserId: owner.id,
    name: "authority-race",
    targetServerSlug: b.slug,
    invitedPeople: [`@${owner.name}`],
    userIds: [manager.id],
  });
  const target = await acceptJointChannelInvite({
    inviteId: created.invites[0]!.id,
    targetServerId: b.id,
    acceptedByUserId: owner.id,
  });
  await db
    .update(serverMembers)
    .set({ role: "admin" })
    .where(
      and(
        eq(serverMembers.serverId, b.id),
        eq(serverMembers.userId, manager.id),
      ),
    );
  await db
    .update(serverMembers)
    .set({ role: "admin" })
    .where(
      and(
        eq(serverMembers.serverId, a.id),
        eq(serverMembers.userId, manager.id),
      ),
    );
  await addHuman(target.id, victim.id);
  const removeHost = () =>
    withLockedChannelActorCapability(
      {
        serverId: a.id,
        channelId: created.channel.id,
        actorType: "user",
        actorId: manager.id,
        capability: "removeChannelMembers",
        humanSubjectIds: [victim.id],
      },
      (tx, context) => removeHuman(created.channel.id, victim.id, context, tx),
    );
  const member = async () =>
    (
      await db
        .select()
        .from(jointChannelMembers)
        .where(
          and(
            eq(jointChannelMembers.jointChannelId, created.jointChannel.id),
            eq(jointChannelMembers.userId, victim.id),
          ),
        )
    ).length === 1;
  {
    const ready = latch(),
      release = latch();
    const join = db.transaction(async () => {
      await addMember(a.id, victim.id);
      ready.resolve();
      await release.promise;
    });
    await Promise.race([ready.promise, join]);
    const removal = removeHost().then(
      () => null,
      (error) => error,
    );
    try {
      await blocked(db);
    } finally {
      release.resolve();
      await join;
    }
    assert.equal(await removal, null);
    assert.equal(
      await member(),
      false,
      "a new H identity cannot defeat global host removal",
    );
  }
  await removeMember(a.id, victim.id);
  await addHuman(target.id, victim.id);
  {
    const ready = latch(),
      release = latch();
    const removal = withLockedChannelActorCapability(
      {
        serverId: a.id,
        channelId: created.channel.id,
        actorType: "user",
        actorId: manager.id,
        capability: "removeChannelMembers",
        humanSubjectIds: [victim.id],
      },
      async (tx, context) => {
        await removeHuman(created.channel.id, victim.id, context, tx);
        ready.resolve();
        await release.promise;
      },
    );
    await Promise.race([ready.promise, removal]);
    const join = addMember(a.id, victim.id);
    try {
      await blocked(db);
    } finally {
      release.resolve();
      await removal;
    }
    await join;
    assert.equal(
      await member(),
      false,
      "host join after a committed removal cannot recreate J member",
    );
    assert.equal(
      await canUserAccessChannel(
        created.channel.id,
        victim.id,
        asServerId(a.id),
      ),
      false,
    );
  }
  // A rejoin overlapping an uncommitted departure can still observe the old
  // committed SM and return already-present. Neither it nor the retry after
  // commit may revive provenance, while H preserves the current J episode.
  await addMember(a.id, victim.id);
  await addHuman(target.id, victim.id);
  {
    const ready = latch(),
      release = latch();
    const leaving = db.transaction(async () => {
      await removeMember(b.id, victim.id);
      ready.resolve();
      await release.promise;
    });
    await Promise.race([ready.promise, leaving]);
    const rejoining = addMember(b.id, victim.id);
    try {
      assert.equal(
        await rejoining,
        false,
        "overlapping join sees the still-committed membership",
      );
    } finally {
      release.resolve();
      await leaving;
    }
    assert.equal(await addMember(b.id, victim.id), true);
    assert.equal(await member(), true);
    await assert.rejects(
      () =>
        withLockedChannelActorCapability(
          {
            serverId: b.id,
            channelId: target.id,
            actorType: "user",
            actorId: manager.id,
            capability: "removeChannelMembers",
            humanSubjectIds: [victim.id],
          },
          (tx, c) => removeHuman(target.id, victim.id, c, tx),
        ),
      /Channel capability required/,
      "a peer entry cannot remove humans after identity rejoin",
    );
  }
  await removeHuman(created.channel.id, victim.id, { self: true });
  await addHuman(target.id, victim.id);
  await removeMember(a.id, victim.id);
  await addHuman(target.id, victim.id);
  {
    const ready = latch(),
      release = latch();
    const demotion = db.transaction(async () => {
      await transitionMemberRole({
        serverId: a.id,
        actorUserId: owner.id,
        targetUserId: manager.id,
        nextRole: "member",
      });
      ready.resolve();
      await release.promise;
    });
    await Promise.race([ready.promise, demotion]);
    const removal = removeHost().then(
      () => null,
      (error) => error,
    );
    try {
      await blocked(db);
    } finally {
      release.resolve();
      await demotion;
    }
    assert.match(String(await removal), /Channel capability required/);
    assert.equal(
      await member(),
      true,
      "locked actor role loss defeats stale preflight authority",
    );
  }
  // A B writer first holds its own channel and J. Host archive must wait for
  // B's channel BEFORE acquiring J, rather than holding J and waiting for B.
  {
    const ready = latch(),
      release = latch();
    const writer = withLockedChannelActorCapability(
      {
        serverId: b.id,
        channelId: target.id,
        actorType: "user",
        actorId: manager.id,
        capability: "addChannelMembers",
        humanSubjectIds: [victim.id],
      },
      async () => {
        ready.resolve();
        await release.promise;
      },
    );
    await Promise.race([ready.promise, writer]);
    const archive = withLockedChannelActorCapability(
      {
        serverId: a.id,
        channelId: created.channel.id,
        actorType: "user",
        actorId: owner.id,
        capability: "archiveChannels",
      },
      (tx) => archiveChannel(created.channel.id, owner.id, tx),
    );
    try {
      await blocked(db);
    } finally {
      release.resolve();
      await writer;
    }
    assert.ok((await archive).archivedAt);
  }
}
