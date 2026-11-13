import type { Server as SocketServer } from "socket.io";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { actionCards, channelConversionJobs, channels, messages } from "../db/schema";
import { emitActionCardMessageUpdated } from "./actionCardsService";

/** Replay current card state after a committed conversion transition. Cancel
 * clears card/job links, so recover its source scope from the durable job.
 * Reading current metadata also makes delivery safe after a later reconfirm. */
export async function emitChannelConversionCardUpdates(io: SocketServer | undefined, jobId: string): Promise<void> {
  if (!io) return;
  const [job] = await getDb().select({
    status: channelConversionJobs.status,
    rollbackState: sql<string | null>`${channelConversionJobs.progress}->>'rollbackState'`,
  }).from(channelConversionJobs).where(eq(channelConversionJobs.id, jobId));
  if (!job) return;
  // Only a reopened source needs the source-scope match; it cannot use an
  // index (the OR spans cards, carriers and metadata), so it reads every card.
  // Every other transition replays the job's own cards through
  // idx_action_cards_conversion_job instead of scanning all of them.
  const reopened = job.status === "canceled" || (job.status === "failed" && job.rollbackState === "restored");
  let cursor: string | null = null;
  while (true) {
    const after = cursor ? sql`message.id > ${cursor}::uuid` : sql`true`;
    const result = await getDb().execute(reopened ? sql`
      SELECT message.id::text AS id
      FROM ${messages} message
      JOIN ${actionCards} card ON card.message_id = message.id
      JOIN ${channelConversionJobs} job ON job.id = ${jobId}::uuid
      LEFT JOIN ${channels} carrier ON carrier.id = message.channel_id
      LEFT JOIN ${messages} parent_message ON parent_message.id = carrier.parent_message_id
      WHERE (card.conversion_job_id = job.id OR (
        (job.status = 'canceled' OR (job.status = 'failed' AND job.progress->>'rollbackState' = 'restored')) AND (
          message.channel_id = job.source_channel_id
          OR (carrier.type = 'thread' AND parent_message.channel_id = job.source_channel_id)
          OR (carrier.type = 'task' AND carrier.parent_channel_id = job.source_channel_id)
          OR (card.action_type = 'channel:add_member' AND message.action_metadata->'action'->>'channel' = job.source_channel_id::text)
        )
      )) AND ${after}
      ORDER BY message.id LIMIT 128
    ` : sql`
      SELECT message.id::text AS id
      FROM ${actionCards} card
      JOIN ${messages} message ON message.id = card.message_id
      WHERE card.conversion_job_id = ${jobId}::uuid AND ${after}
      ORDER BY message.id LIMIT 128
    `);
    const rows = result.rows as Array<{ id: string }>;
    for (const row of rows) await emitActionCardMessageUpdated(io, row);
    if (rows.length < 128) return;
    cursor = rows.at(-1)!.id;
  }
}
