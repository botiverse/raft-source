import { sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db";

/**
 * Test fixtures only. A fixture that writes joint rows by hand (channel_humans
 * on a `joint` channel first, joint_channels / joint_channel_servers after)
 * leaves J without members: computed membership, the only mode since
 * joint_human_membership_v1 was retired, reads joint_channel_members. This
 * gives every eligible CH row of J's active joint projections (a non-guest
 * member of that projection's server, or a Guest of the host bound to the
 * host projection) a member row, its episode counter and an admission through
 * that server, as the services' own joins would have. Idempotent.
 */
export async function fillJointMembersFromChannelHumans(jointIds?: readonly string[], executor: DatabaseExecutor = getDb()): Promise<void> {
  const scope = jointIds ? (jointIds.length ? sql`p.joint_channel_id IN (${sql.join(jointIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`false`) : sql`true`;
  const eligible = sql`SELECT p.joint_channel_id, p.server_id, ch.user_id, ch.joined_at
    FROM joint_channel_servers p
    JOIN joint_channels j ON j.id = p.joint_channel_id AND j.status = 'active'
    JOIN channels c ON c.id = p.local_channel_id AND c.type = 'joint' AND c.deleted_at IS NULL
    JOIN servers s ON s.id = p.server_id AND s.deleted_at IS NULL
    JOIN channel_humans ch ON ch.channel_id = c.id
    JOIN server_members sm ON sm.server_id = p.server_id AND sm.user_id = ch.user_id
      AND (sm.role <> 'guest' OR (sm.guest_channel_id = p.local_channel_id AND p.role = 'host'))
    WHERE p.status = 'active' AND ${scope}`;
  await executor.execute(sql`INSERT INTO joint_membership_generations (joint_channel_id, principal_kind, principal_id, last_generation)
    SELECT DISTINCT e.joint_channel_id, 'user', e.user_id, 1 FROM (${eligible}) e
    WHERE NOT EXISTS (SELECT 1 FROM joint_channel_members m WHERE m.joint_channel_id = e.joint_channel_id AND m.user_id = e.user_id)
    ON CONFLICT DO NOTHING`);
  await executor.execute(sql`INSERT INTO joint_channel_members (joint_channel_id, user_id, generation, joined_at)
    SELECT e.joint_channel_id, e.user_id, g.last_generation, min(e.joined_at) FROM (${eligible}) e
    JOIN joint_membership_generations g ON g.joint_channel_id = e.joint_channel_id AND g.principal_kind = 'user' AND g.principal_id = e.user_id
    GROUP BY e.joint_channel_id, e.user_id, g.last_generation
    ON CONFLICT DO NOTHING`);
  await executor.execute(sql`INSERT INTO joint_channel_admissions (joint_channel_id, user_id, server_id, generation, admitted_at)
    SELECT e.joint_channel_id, e.user_id, e.server_id, m.generation, e.joined_at FROM (${eligible}) e
    JOIN joint_channel_members m ON m.joint_channel_id = e.joint_channel_id AND m.user_id = e.user_id
    ON CONFLICT DO NOTHING`);
}
