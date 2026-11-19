import { sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { oauthClientUninstalls } from "../db/schema";

/**
 * Remembers that a person uninstalled an App from a Server (db/schema.ts
 * oauthClientUninstalls; GET /api/integrations/marketplace `uninstalledHereAt`).
 * Called in the uninstall's transaction, beside its audit event, for a
 * person's uninstall only: a system uninstall (the closed-server purge) is no
 * one's choice and writes nothing. One row per (Server, App); the newer time
 * wins, so a replayed or late write never moves it back.
 */
export async function recordPersonOAuthClientUninstall(
  tx: DatabaseExecutor,
  input: { serverId: string; clientId: string; actorUserId: string; uninstalledAt: Date },
): Promise<void> {
  await tx.insert(oauthClientUninstalls).values({
    serverId: input.serverId,
    clientId: input.clientId,
    uninstalledAt: input.uninstalledAt,
    actorUserId: input.actorUserId,
  }).onConflictDoUpdate({
    target: [oauthClientUninstalls.serverId, oauthClientUninstalls.clientId],
    set: { uninstalledAt: sql`excluded.uninstalled_at`, actorUserId: sql`excluded.actor_user_id` },
    setWhere: sql`${oauthClientUninstalls.uninstalledAt} < excluded.uninstalled_at`,
  });
}
