// `human_avatar_builder_v0` (shared featureFlags.ts): where the Server reads
// it. Saving a built avatar and a new account's random one; drawing a stored
// one never asks. Every failure reads as off.
import { and, eq, isNull, ne } from "drizzle-orm";
import { HUMAN_AVATAR_BUILDER_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { serverMembers, servers } from "../db/schema";
import { UUID_RE } from "../lib/messageId";
import { evaluateFeatureFlag, evaluateFeatureFlags } from "./featureFlagService";

/** On for this server. No server reads off. */
export async function isHumanAvatarBuilderOnForServer(
  serverId: string | null | undefined,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  if (!serverId) return false;
  try {
    return (await evaluateFeatureFlag({ key: HUMAN_AVATAR_BUILDER_FEATURE_FLAG_KEY, serverId }, executor)).enabled === true;
  } catch {
    return false;
  }
}

/**
 * On for a person saving their own avatar. The account belongs to no server,
 * so: the server the request names (X-Server-Id, which the web sends for its
 * current server) when the person is a member of it; otherwise (no header,
 * account setup before any server, a server they are not in) on when it is on
 * for any server they belong to.
 */
export async function isHumanAvatarBuilderOnForPerson(userId: string, namedServerId: unknown): Promise<boolean> {
  try {
    const memberships = await getDb()
      .select({ serverId: serverMembers.serverId })
      .from(serverMembers)
      .innerJoin(servers, eq(serverMembers.serverId, servers.id))
      .where(and(
        eq(serverMembers.userId, userId),
        ne(servers.kind, "joint_storage"),
        isNull(servers.deletedAt),
      ));
    const serverIds = memberships.map((row) => row.serverId as string);
    const named = typeof namedServerId === "string" && UUID_RE.test(namedServerId)
      ? serverIds.find((id) => id.toLowerCase() === namedServerId.toLowerCase())
      : undefined;
    const asked = named ? [named] : serverIds;
    if (asked.length === 0) return false;
    const evaluations = await evaluateFeatureFlags(asked.map((serverId) => ({
      key: HUMAN_AVATAR_BUILDER_FEATURE_FLAG_KEY,
      serverId,
      userId,
    })));
    return evaluations.some((evaluation) => evaluation.enabled === true);
  } catch {
    return false;
  }
}
