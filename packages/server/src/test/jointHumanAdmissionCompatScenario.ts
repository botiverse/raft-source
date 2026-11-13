import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { Database } from "../db";
import { createSeed } from "./integration/seed";
import {
  createJointChannel,
  acceptJointChannelInvite,
  addHuman,
} from "../services/channelService";
import { prepareJointHumanMembershipMirror } from "../services/jointHumanMembershipMirror";

/** The cutover mirror writes the generation-qualified key. A compatible old
 * writer remains harmless; its earlier explicit three-column target fails. */
export async function jointHumanAdmissionCompatScenario({
  db,
  seed,
}: {
  db: Database;
  seed: ReturnType<typeof createSeed>;
}) {
  const owner = await seed.human(),
    person = await seed.human();
  const h = await seed.server({ owner, members: [person] }),
    b = await seed.server({ owner, members: [person] });
  const created = await createJointChannel({
    hostServerId: h.id,
    createdByUserId: owner.id,
    name: "admission-compat",
    targetServerSlug: b.slug,
    invitedPeople: [`@${owner.name}`],
    userIds: [person.id],
  });
  const target = await acceptJointChannelInvite({
    inviteId: created.invites[0]!.id,
    targetServerId: b.id,
    acceptedByUserId: owner.id,
  });
  const mirror = () =>
    db.transaction(async (tx) => {
      const mirror = await prepareJointHumanMembershipMirror(tx, {
        channelIds: [created.channel.id],
      }, "join");
      await mirror.apply([person.id]);
    });
  await mirror();
  await mirror();
  // Emulate the deployed compatible old writer against the migrated key.
  for (let i = 0; i < 2; i++) await db.execute(sql`INSERT INTO joint_channel_admissions(joint_channel_id,user_id,server_id)
    VALUES (${created.jointChannel.id}::uuid,${person.id}::uuid,${h.id}::uuid) ON CONFLICT DO NOTHING`);
  await mirror();
  await mirror();
  // Already a member through H: adding them through B records nothing.
  await addHuman(target.id, person.id);
  const rows = await db.execute(
    sql`SELECT generation FROM joint_channel_admissions WHERE joint_channel_id=${created.jointChannel.id}::uuid AND user_id=${person.id}::uuid`,
  );
  assert.equal(rows.rows.length, 1);
  assert.ok(rows.rows.every((row) => row.generation === 1));
  // PostgreSQL must reject the previous explicit target on this schema. The
  // assertion proves this fixture reaches the rollout failure, not just SQL text.
  await assert.rejects(
    db.execute(sql`INSERT INTO joint_channel_admissions(joint_channel_id,user_id,server_id)
 VALUES (${created.jointChannel.id}::uuid,${person.id}::uuid,${h.id}::uuid)
 ON CONFLICT(joint_channel_id,user_id,server_id) DO NOTHING`),
    (error) =>
      error instanceof Error &&
      String(error.cause).includes("no unique or exclusion constraint"),
  );
}
