import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/index";
import { jointChannels, jointChannelServers, servers } from "../../db/schema";
import { createChannel, JOINT_STORAGE_SERVER_SLUG } from "../../services/channelService";

type Channel = Awaited<ReturnType<typeof createChannel>>;

/**
 * A joint channel shaped like production (createJointChannel): its canonical
 * message stream in a joint_storage namespace server, one `joint` projection
 * channel per participating server (the first is the host), all active.
 * Seeds rows only; membership is the caller's (addHuman / addAgent on a
 * projection). Messages go to `canonical` (createMessage), threads through a
 * projection (getOrCreateThreadForChannel), as the write paths do.
 */
export async function seedJointChannel(input: {
  name: string;
  serverIds: readonly [string, ...string[]];
  createdByUserId: string;
}): Promise<{ jointChannelId: string; canonical: Channel; projections: Channel[] }> {
  const db = getDb();
  const storageServerId = await ensureJointStorageNamespace(input.createdByUserId);
  const canonical = await createChannel(storageServerId, `joint-storage-${randomUUID()}`, undefined, "channel");
  const projections: Channel[] = [];
  for (const serverId of input.serverIds) projections.push(await createChannel(serverId, input.name, undefined, "joint"));
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: input.serverIds[0],
    createdByUserId: input.createdByUserId,
  }).returning();
  await db.insert(jointChannelServers).values(projections.map((projection, index) => ({
    jointChannelId: joint.id,
    serverId: projection.serverId,
    localChannelId: projection.id,
    role: index === 0 ? "host" as const : "participant" as const,
    joinedByUserId: input.createdByUserId,
  })));
  return { jointChannelId: joint.id, canonical, projections };
}

/** The joint_storage namespace Server canonical channels live on (created once). */
export async function ensureJointStorageNamespace(ownerId: string): Promise<string> {
  const db = getDb();
  const slug = JOINT_STORAGE_SERVER_SLUG;
  const [existing] = await db.select({ id: servers.id }).from(servers).where(eq(servers.slug, slug));
  if (existing) return existing.id;
  const [inserted] = await db.insert(servers).values({
    name: "Joint Storage Namespace",
    slug,
    kind: "joint_storage",
    ownerId,
    plan: "founder",
    agentAllChannelGreetingEnabled: false,
  }).returning({ id: servers.id });
  return inserted.id;
}
