import { sql, type SQL } from "drizzle-orm";
import type { DatabaseExecutor } from "../db";

/**
 * The one way an ordinary admission records its source rows
 * (joint_channel_admissions), shared by every ordinary admission path so they
 * behave identically (#wg-rbac:#23).
 *
 * `candidates` is a SELECT with the columns joint_channel_id, user_id,
 * server_id, generation, admitted_at, admitted_by: what the admission would
 * write.
 *
 * 1. INSERT ... ON CONFLICT DO NOTHING, as before: a new tuple gets an
 *    'admission' row (the column default); an existing one is left alone.
 * 2. Only for the tuples that statement did not insert: a live 'recovery' row
 *    of that tuple becomes an ordinary 'admission' with the admitted_by and
 *    admitted_at this admission would have written. An ended row is never
 *    revived and an existing 'admission' row never touched (the WHERE matches
 *    neither, so neither is row-locked). Its joint_admission_recoveries row
 *    stays: the record that the tuple was once recovered.
 *
 * Nothing here writes 'recovery', and it decides nothing about who may admit:
 * the caller has already done that, as for the plain insert.
 */
export async function recordOrdinaryJointAdmissions(tx: DatabaseExecutor, candidates: SQL): Promise<void> {
  const notInserted = await tx.execute<{
    jointChannelId: string;
    userId: string;
    serverId: string;
    generation: number;
    admittedAt: string;
    admittedBy: string | null;
  }>(sql`WITH candidate AS MATERIALIZED (${candidates}),
    inserted AS (
      INSERT INTO joint_channel_admissions (joint_channel_id,user_id,server_id,generation,admitted_at,admitted_by)
      SELECT joint_channel_id,user_id,server_id,generation,admitted_at,admitted_by FROM candidate
      ON CONFLICT (joint_channel_id,user_id,server_id,generation) DO NOTHING
      RETURNING joint_channel_id,user_id,server_id,generation)
    SELECT c.joint_channel_id AS "jointChannelId",c.user_id AS "userId",c.server_id AS "serverId",c.generation,
      c.admitted_at::text AS "admittedAt",c.admitted_by AS "admittedBy"
    FROM candidate c
    WHERE NOT EXISTS (SELECT 1 FROM inserted i WHERE i.joint_channel_id=c.joint_channel_id AND i.user_id=c.user_id
      AND i.server_id=c.server_id AND i.generation=c.generation)
    ORDER BY c.joint_channel_id,c.user_id,c.generation,c.server_id`);
  if (notInserted.rows.length === 0) return;
  const tuples = sql.join(notInserted.rows.map((row) => sql`(${row.jointChannelId}::uuid,${row.userId}::uuid,${row.serverId}::uuid,
    ${Number(row.generation)}::integer,${row.admittedAt}::timestamptz,${row.admittedBy}::uuid)`), sql`, `);
  await tx.execute(sql`UPDATE joint_channel_admissions a SET kind='admission',admitted_by=v.admitted_by,admitted_at=v.admitted_at
    FROM (VALUES ${tuples}) v(joint_channel_id,user_id,server_id,generation,admitted_at,admitted_by)
    WHERE a.joint_channel_id=v.joint_channel_id AND a.user_id=v.user_id AND a.server_id=v.server_id
      AND a.generation=v.generation AND a.kind='recovery' AND a.ended_at IS NULL`);
}
