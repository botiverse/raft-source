import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db";
import { channels, messages } from "../db/schema";
import { createSeed } from "./integration/seed";
import { connected } from "./jointHumanMembershipScenarios";
import { jointConversationFamilySql } from "../services/jointHumanMembershipAccess";
import { runParentChannelIdBackfill } from "../services/parentChannelIdBackfill";
import { sqlStateOf } from "../../scripts/joint-human-membership-ops";

const CONSTRAINT = "channels_parent_message_requires_channel";
function migration(suffix: string) {
  const dir = new URL("../../drizzle/", import.meta.url);
  const names = readdirSync(dir).filter(name => name.endsWith(suffix));
  assert.equal(names.length, 1);
  return readFileSync(new URL(names[0]!, dir), "utf8");
}
async function apply(db: Database, source: string) {
  await db.transaction(async tx => {
    for (const statement of source.split("--> statement-breakpoint")) {
      if (statement.trim()) await tx.execute(sql.raw(statement));
    }
  });
}
export async function jointParentCacheScenario({ db, seed }: { db: Database; seed: ReturnType<typeof createSeed> }) {
  const x = await connected({ db, seed });
  const j = x.joint.jointChannel.id;
  const parent = await seed.message({ channel: x.joint.channel, author: x.owner, content: "cache parent" });
  const other = await seed.channel({ server: x.a, members: [x.owner] });
  const [thread] = await db.insert(channels).values({ serverId: x.a.id, type: "thread", name: `cache-${randomUUID()}`,
    parentMessageId: parent.id, parentChannelId: other.id, deletedAt: new Date() }).returning();
  assert.equal(thread!.parentChannelId, parent.channelId, "BEFORE trigger wins over a supplied cache");
  await db.update(channels).set({ parentChannelId: null }).where(eq(channels.id, thread!.id));
  assert.equal((await db.select().from(channels).where(eq(channels.id, thread!.id)))[0]?.parentChannelId, parent.channelId);
  const orphan = () => db.insert(channels).values({ serverId: x.a.id, type: "thread", name: `orphan-${randomUUID()}`, parentMessageId: randomUUID() });
  await assert.rejects(orphan, error => sqlStateOf(error) === "23514");
  const [projection] = await db.insert(channels).values({ serverId: x.a.id, type: "thread", name: `projection-${randomUUID()}` }).returning();
  assert.equal(projection!.parentMessageId, null, "message-less joint projection remains legal");
  const family = async () => new Set((await db.execute<{ id: string }>(jointConversationFamilySql(j))).rows.map(row => row.id));
  assert.ok((await family()).has(thread!.id), "soft-deleted thread stays in the family");
  await db.update(messages).set({ channelId: other.id }).where(eq(messages.id, parent.id));
  assert.equal((await family()).has(thread!.id), false, "conversion updates the cached parent atomically");
  await db.update(messages).set({ channelId: parent.channelId }).where(eq(messages.id, parent.id));
  assert.ok((await family()).has(thread!.id), "conversion rollback restores the family");
  await db.update(channels).set({ parentMessageId: null }).where(eq(channels.id, thread!.id));
  assert.equal((await family()).has(thread!.id), false, "detaching is legal without a parent message");
  await db.update(channels).set({ parentMessageId: parent.id }).where(eq(channels.id, thread!.id));
  assert.ok((await family()).has(thread!.id));

  // Upgrade from actual pre-CHECK history: bypass the old trigger only before
  // ADD NOT VALID. No migration repairs or deletes data silently.
  await db.execute(sql`ALTER TABLE channels DROP CONSTRAINT channels_parent_message_requires_channel`);
  const legacyParent = await seed.message({ channel: x.joint.channel, author: x.owner, content: "legacy cache gap" });
  const legacy = await db.transaction(async tx => {
    await tx.execute(sql`ALTER TABLE channels DISABLE TRIGGER channels_parent_channel_id_insert`);
    const [row] = await tx.insert(channels).values({ serverId: x.a.id, type: "thread", name: `legacy-${randomUUID()}`,
      parentMessageId: legacyParent.id, deletedAt: new Date() }).returning();
    await tx.execute(sql`ALTER TABLE channels ENABLE TRIGGER channels_parent_channel_id_insert`);
    return row!;
  });
  assert.equal(legacy.parentChannelId, null);
  await apply(db, migration("_channels_parent_message_requires_channel.sql"));
  const validated = async () => (await db.execute<{ validated: boolean }>(sql`
    SELECT convalidated AS validated FROM pg_constraint WHERE conrelid='public.channels'::regclass AND conname=${CONSTRAINT}`)).rows[0]?.validated;
  assert.equal(await validated(), false);
  await assert.rejects(orphan, error => sqlStateOf(error) === "23514");
  const validateSql = migration("_channels_parent_message_validate.sql");
  await assert.rejects(apply(db, validateSql), error => sqlStateOf(error) === "23514");
  assert.equal(await validated(), false, "failed validation cannot authorize the new reader/tool");
  const beforeRepair = (await db.select().from(channels).where(eq(channels.id, legacy.id)))[0];
  assert.equal(beforeRepair?.parentChannelId, null, "failure leaves historical data intact");
  const repaired = await runParentChannelIdBackfill(async query => (await db.execute(query)).rows as Array<Record<string, unknown>>, { batchSize: 100, sleepMs: 0 });
  assert.equal(repaired.rowsUpdated, 1);
  await apply(db, validateSql);
  assert.equal(await validated(), true);
  assert.ok((await family()).has(legacy.id), "validated old soft-deleted descendants are preserved");
  await assert.rejects(orphan, error => sqlStateOf(error) === "23514");
}
