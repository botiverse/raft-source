import { and, asc, eq } from "drizzle-orm";
import { getDb, type DatabaseTransaction } from "../db/index.js";
import { oauthClients, oauthClientInstalls } from "../db/schema.js";

// Called only inside an authorized source-server mutation, or the explicit
// legacy backfill. Lock the client before reading its current grant so a
// concurrent permission change cannot leave a newly inserted stale grant.
// Conflict means preserve identity, subscriptions, and especially suspension.
export async function ensureLocalAppSourceInstallation(
  clientId: typeof oauthClients.$inferSelect.id,
  tx: DatabaseTransaction,
) {
  const [client] = await tx.select().from(oauthClients).where(and(
    eq(oauthClients.id, clientId),
    eq(oauthClients.appType, "server_local"),
    eq(oauthClients.enabled, true),
  )).limit(1).for("update");
  if (!client) return null;
  const [created] = await tx.insert(oauthClientInstalls).values({
    clientId: client.id,
    serverId: client.serverId,
    installedByUserId: client.createdByUserId,
    approvedRequestRevisionId: client.outboundCurrentRevisionId,
    approvedGroups: client.outboundCurrentGroups,
    grantRevision: client.outboundCurrentRevisionId ? 1 : 0,
  }).onConflictDoNothing({ target: [oauthClientInstalls.serverId, oauthClientInstalls.clientId] })
    .returning({ id: oauthClientInstalls.id });
  return created ?? null;
}

// Each candidate is rechecked under lock, including enabled/distribution state.
// Existing rows are deliberately untouched; this is missing-row repair only.
export type LocalInstallationBackfillOutcome = "unchanged" | "missing" | "created";
export type LocalInstallationBackfillFailure = { clientId: string; stage: "transaction" };
export async function backfillLocalAppSourceInstallations(db = getDb(), apply = false) {
  const clients = await db.select({ id: oauthClients.id }).from(oauthClients).where(and(
    eq(oauthClients.appType, "server_local"), eq(oauthClients.enabled, true),
  )).orderBy(asc(oauthClients.id));
  let scanned = 0;
  let missing = 0;
  let created = 0;
  const failures: LocalInstallationBackfillFailure[] = [];
  for (const client of clients) {
    scanned++;
    try {
      const outcome = await db.transaction(async (tx): Promise<LocalInstallationBackfillOutcome> => {
        const [current] = await tx.select().from(oauthClients).where(and(
          eq(oauthClients.id, client.id), eq(oauthClients.appType, "server_local"),
          eq(oauthClients.enabled, true),
        )).limit(1).for("update");
        if (!current) return "unchanged";
        const [existing] = await tx.select({ id: oauthClientInstalls.id }).from(oauthClientInstalls).where(and(
          eq(oauthClientInstalls.clientId, current.id), eq(oauthClientInstalls.serverId, current.serverId),
        )).limit(1);
        if (existing) return "unchanged";
        if (!apply) return "missing";
        return await ensureLocalAppSourceInstallation(current.id, tx) ? "created" : "unchanged";
      });
      if (outcome === "missing" || outcome === "created") missing++;
      if (outcome === "created") created++;
    } catch {
      failures.push({ clientId: client.id, stage: "transaction" });
    }
  }
  return { scanned, missing, created, failed: failures.length, failures };
}
