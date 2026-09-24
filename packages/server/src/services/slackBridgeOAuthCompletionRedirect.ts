import { and, eq, isNull, ne } from "drizzle-orm";

import { getDb, type Database } from "../db/index.js";
import { servers } from "../db/schema.js";

export function createSlackBridgeOAuthCompletionRedirectPathResolver(
  dependencies: { db?: Database } = {},
): (input: { serverId: string }) => Promise<string | null> {
  return async ({ serverId }) => {
    const db = dependencies.db ?? getDb();
    const [server] = await db
      .select({ slug: servers.slug })
      .from(servers)
      .where(and(
        eq(servers.id, serverId),
        ne(servers.kind, "joint_storage"),
        isNull(servers.deletedAt),
      ))
      .limit(1);
    if (!server) return null;
    return `/s/${encodeURIComponent(server.slug)}/settings/im-bridges`;
  };
}
