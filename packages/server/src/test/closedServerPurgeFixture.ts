// A closed server's content for the closed-server purge tests (count and
// delete): known rows in a normal channel, plus the joint projection and the
// migration receipt channel both modes skip.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  agentMigrationReceiptChannels,
  agentMigrations,
  attachmentObjects,
  attachments,
  channelAgents,
  channels,
  featureFlags,
  jointChannels,
  jointChannelServers,
  messages,
  objectEvents,
  servers,
  tasks,
} from "../db/schema";
import { createAgent } from "../services/agentService";
import {
  CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY,
  memoryClosedServerPurgeState,
  runClosedServerPurge,
  type ClosedServerPurgeDeps,
  type ClosedServerPurgeGuardReading,
} from "../services/closedServerPurge";
import { createFeatureFlag, createFeatureFlagRule } from "../services/featureFlagService";
import { registerMachine } from "../services/machineService";
import type { createSeed } from "./integration/seed";

type Seed = ReturnType<typeof createSeed>;

export const DAY_MS = 24 * 3_600_000;
// 12:30Z: outside every quiet time.
export const NOW = new Date("2026-11-09T12:30:00Z");
export const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

export async function flag(variant: string | null) {
  const db = getDb();
  const [existing] = await db.select().from(featureFlags).where(eq(featureFlags.key, CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY));
  if (existing) await db.update(featureFlags).set({ defaultVariant: variant }).where(eq(featureFlags.key, CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY));
  else await createFeatureFlag({ key: CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true, defaultVariant: variant });
}

/** The only way to `delete`: the flag on (counting by default) and a server rule naming these servers with the variant. */
export async function deleteFor(...serverIds: string[]) {
  await flag(null);
  await createFeatureFlagRule({ flagKey: CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: serverIds, variant: "delete" });
}

export const close = (serverId: string, at: Date) => getDb().update(servers).set({ deletedAt: at }).where(eq(servers.id, serverId));

export const noGuards = async (): Promise<ClosedServerPurgeGuardReading> => ({ slot: null, rwOverloadedRecently: false });

/** One run at NOW (or `at`) with its own claim (a fresh state), no apps unless given. */
export function run(deps: ClosedServerPurgeDeps = {}, at: Date = NOW) {
  return runClosedServerPurge({ now: () => at, state: memoryClosedServerPurgeState(() => at), apps: [], readGuards: noGuards, ...deps });
}

export const insertMessage = async (channelId: string, senderId: string, content = "hello") =>
  (await getDb().insert(messages).values({ channelId, senderType: "user", senderId, content }).returning())[0]!;

/**
 * A server with known content: a channel with 3 messages, 2 attachments on
 * one object plus 1 on another, 2 tasks, 3 object events; a joint projection
 * (with 2 messages and a thread under it) and a migration receipt channel
 * (with 1 message), which the count skips.
 */
export async function seedServer(seed: Seed) {
  const db = getDb();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  for (let i = 0; i < 3; i++) await seed.message({ channel, author: owner, content: `m${i}` });
  const [first] = await db.select().from(messages).where(eq(messages.channelId, channel.id)).limit(1);

  const [objectA] = await db.insert(attachmentObjects).values({ originServerId: server.id, uploaderId: owner.id, uploaderType: "user", storageKey: `k/${randomUUID()}`, mimeType: "text/plain", sizeBytes: 100 }).returning();
  const [objectB] = await db.insert(attachmentObjects).values({ originServerId: server.id, uploaderId: owner.id, uploaderType: "user", storageKey: `k/${randomUUID()}`, mimeType: "text/plain", sizeBytes: 23 }).returning();
  for (const objectId of [objectA!.id, objectA!.id, objectB!.id]) {
    await db.insert(attachments).values({ objectId, messageId: first!.id, channelId: channel.id, uploaderId: owner.id, uploaderType: "user", filename: "a.txt" });
  }
  for (const taskNumber of [1, 2]) {
    await db.insert(tasks).values({ channelId: channel.id, taskNumber, title: `t${taskNumber}`, createdByType: "user", createdById: owner.id });
  }
  for (let i = 0; i < 3; i++) {
    await db.insert(objectEvents).values({ serverId: server.id, objectKind: "test", objectId: `o${i}`, eventKind: "created", actorType: "user", actorId: owner.id });
  }

  // A joint projection: the canonical conversation lives in another (storage) server.
  const storage = await seed.server({ owner });
  const [canonical] = await db.insert(channels).values({ serverId: storage.id, name: `joint-canonical-${randomUUID().slice(0, 8)}`, type: "joint" }).returning();
  const [local] = await db.insert(channels).values({ serverId: server.id, name: `joint-${randomUUID().slice(0, 8)}`, type: "joint" }).returning();
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: canonical!.id, createdByServerId: storage.id, createdByUserId: owner.id }).returning();
  await db.insert(jointChannelServers).values({ jointChannelId: joint!.id, serverId: server.id, localChannelId: local!.id });
  const jointParent = await insertMessage(local!.id, owner.id);
  await insertMessage(local!.id, owner.id);
  const [thread] = await db.insert(channels).values({ serverId: server.id, name: `thread-${randomUUID().slice(0, 8)}`, type: "thread", parentMessageId: jointParent.id, parentChannelId: local!.id }).returning();
  await insertMessage(thread!.id, owner.id);

  // A migration receipt channel.
  const { machine: source } = await registerMachine(server.id, owner.id, "Source");
  const { machine: target } = await registerMachine(server.id, owner.id, "Target");
  const agent = await createAgent(server.id, `receipt-agent-${randomUUID().slice(0, 6)}`, { runtime: "codex", machineId: source.id });
  const [receipt] = await db.insert(channels).values({ serverId: server.id, name: `migration-receipt-${randomUUID()}`, type: "dm" }).returning();
  await db.insert(channelAgents).values({ channelId: receipt!.id, agentId: agent.id, addedAt: new Date() });
  const deadline = new Date(Date.now() + 3_600_000);
  const [migration] = await db.insert(agentMigrations).values({
    serverId: server.id, agentId: agent.id, sourceMachineId: source.id, targetMachineId: target.id, state: "in_transit",
    contractVersion: 2, grantKey: `purge-test:${randomUUID()}`, prepDeadlineAt: deadline, transferDeadlineAt: deadline,
    arrivalDeadlineAt: deadline, sourceMachineNameSnapshot: "Source", targetMachineNameSnapshot: "Target", initiatedByUserId: owner.id,
    receiptChannelId: receipt!.id,
  } as typeof agentMigrations.$inferInsert).returning();
  await db.insert(agentMigrationReceiptChannels).values({ channelId: receipt!.id, migrationId: migration!.id, serverId: server.id, agentId: agent.id });
  await insertMessage(receipt!.id, owner.id);

  const skipped = { joint: [local!.id, thread!.id], receipt: [receipt!.id] };
  return { owner, server, serverId: server.id as ServerId, storage, skipped };
}

