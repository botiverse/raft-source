import { asc, inArray, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { agents, messages, users } from "../db/schema";

/** Each source contributes at most a page; their global prefix is still exact. */
export async function readSourcePage(db: DatabaseExecutor, storageIds: string[], after: number, from: Date, to: Date, limit: number) {
  const ids = [...new Set(storageIds)];
  if (!ids.length) return [];
  const pageIds = sql`(SELECT candidate.id FROM unnest(${sql.param(ids)}::uuid[]) AS source(channel_id)
    CROSS JOIN LATERAL (
      SELECT id, seq FROM messages
      WHERE channel_id = source.channel_id AND seq > ${after}
        AND created_at >= ${from.toISOString()}::timestamptz AND created_at < ${to.toISOString()}::timestamptz
        AND deleted_at IS NULL
      ORDER BY seq LIMIT ${limit}
    ) AS candidate
    ORDER BY candidate.seq LIMIT ${limit})`;
  const page = await db.select().from(messages).where(inArray(messages.id, pageIds)).orderBy(asc(messages.seq));
  return withSenderNames(db, page);
}

export async function withSenderNames(db: DatabaseExecutor, page: Array<typeof messages.$inferSelect>) {
  // Sender IDs also include non-UUID system identities. Never cast them in SQL,
  // or cast the indexed UUID column to text for a join over all candidates.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const humanIds = [...new Set(page.filter(m => m.senderType === "user" && uuid.test(m.senderId)).map(m => m.senderId))];
  const agentIds = [...new Set(page.filter(m => m.senderType === "agent" && uuid.test(m.senderId)).map(m => m.senderId))];
  const humans = humanIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, humanIds)) : [];
  const bots = agentIds.length ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)) : [];
  const humanNames = new Map(humans.map(row => [row.id, row.name]));
  const agentNames = new Map(bots.map(row => [row.id, row.name]));
  return page.map(message => ({ message, userName: humanNames.get(message.senderId) ?? null, agentName: agentNames.get(message.senderId) ?? null }));
}
