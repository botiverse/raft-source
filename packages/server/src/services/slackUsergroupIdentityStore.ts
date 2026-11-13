import { randomBytes } from "node:crypto";
import { and, eq, or, asc, isNull, ne } from "drizzle-orm";
import type { Database } from "../db/index";
import { externalAppInstalls, slackUsergroupIdentities, type SlackUsergroupRecoveryRef } from "../db/schema";
import { slackAgentUsergroupMarker } from "./slackMentionTokens";

export type SlackUsergroupIdentity = typeof slackUsergroupIdentities.$inferSelect;
export type SlackUsergroupPrincipal = {
  installId: string;
  serverId: string;
  principalKind: "agent" | "user";
  principalId: string;
};

export function slackUsergroupDescription(kind: "agent" | "user"): string {
  return kind === "agent" ? "Raft agent" : "Raft member";
}

// A provisioning reference, unrelated to any Raft Server/member UUID. It is
// only visible until the provider id is durably bound; an ambiguous create can
// be recovered without adopting an ordinary group by its name or handle.
export function slackUsergroupRecoveryDescription(identity: SlackUsergroupIdentity): string {
  return `Raft identity pending ${identity.recoveryRef}`;
}

export function slackUsergroupIdentityMarker(identity: SlackUsergroupIdentity): string {
  return identity.principalKind === "agent"
    ? slackAgentUsergroupMarker(identity.serverId, identity.principalId)
    : `workspace-user:${identity.principalId}`;
}

export async function listSlackUsergroupIdentities(db: Database, installId: string, serverId: string): Promise<SlackUsergroupIdentity[]> {
  return db.select().from(slackUsergroupIdentities).where(and(
    eq(slackUsergroupIdentities.installId, installId),
    or(eq(slackUsergroupIdentities.serverId, serverId), eq(slackUsergroupIdentities.principalKind, "user")),
  )).orderBy(isNull(slackUsergroupIdentities.providerUsergroupId), asc(slackUsergroupIdentities.id));
}

export async function reserveSlackUsergroupIdentity(db: Database, principal: SlackUsergroupPrincipal): Promise<SlackUsergroupIdentity> {
  return db.transaction(async (tx) => {
    // Human identity is workspace-wide. Serialize reservations on the install
    // so concurrent servers cannot mint one row/group each for the same user.
    // serverId remains provenance on old rows, not human identity authority.
    if (principal.principalKind === "user") {
      await tx.select({ id: externalAppInstalls.id }).from(externalAppInstalls)
        .where(eq(externalAppInstalls.id, principal.installId)).for("update");
    }
    const scope = and(
      eq(slackUsergroupIdentities.installId, principal.installId),
      eq(slackUsergroupIdentities.principalKind, principal.principalKind),
      eq(slackUsergroupIdentities.principalId, principal.principalId),
      ...(principal.principalKind === "agent" ? [eq(slackUsergroupIdentities.serverId, principal.serverId)] : []),
    );
    const [existing] = await tx.select().from(slackUsergroupIdentities).where(scope)
      .orderBy(isNull(slackUsergroupIdentities.providerUsergroupId), asc(slackUsergroupIdentities.id)).limit(1);
    if (existing) return existing;
    await tx.insert(slackUsergroupIdentities).values({
      ...principal, recoveryRef: randomBytes(24).toString("hex") as SlackUsergroupRecoveryRef,
    }).onConflictDoNothing();
    const [identity] = await tx.select().from(slackUsergroupIdentities).where(scope).limit(1);
    if (!identity) throw new Error("Slack usergroup identity reservation missing");
    return identity;
  });
}

export async function bindSlackUsergroupIdentity(db: Database, identity: SlackUsergroupIdentity, providerId: string) {
  if (identity.providerUsergroupId === providerId) return;
  await db.update(slackUsergroupIdentities).set({ providerUsergroupId: providerId })
    .where(eq(slackUsergroupIdentities.id, identity.id));
  identity.providerUsergroupId = providerId;
}

/** Persist one confirmed outbound destination without discarding old aliases. */
export async function setCanonicalSlackHumanUsergroup(
  db: Database, identity: SlackUsergroupIdentity, canonical: boolean, isClaimHeld: () => Promise<boolean>,
): Promise<boolean> {
  if (identity.principalKind !== "user" || (canonical && !identity.providerUsergroupId)) return false;
  if (identity.humanCanonical === canonical) return isClaimHeld();
  return db.transaction(async (tx) => {
    await tx.select({ id: externalAppInstalls.id }).from(externalAppInstalls)
      .where(eq(externalAppInstalls.id, identity.installId)).for("update");
    if (!(await isClaimHeld())) return false;
    if (canonical) await tx.update(slackUsergroupIdentities).set({ humanCanonical: false }).where(and(
      eq(slackUsergroupIdentities.installId, identity.installId), eq(slackUsergroupIdentities.principalKind, "user"),
      eq(slackUsergroupIdentities.principalId, identity.principalId), ne(slackUsergroupIdentities.id, identity.id),
      eq(slackUsergroupIdentities.humanCanonical, true),
    ));
    await tx.update(slackUsergroupIdentities).set({ humanCanonical: canonical }).where(eq(slackUsergroupIdentities.id, identity.id));
    identity.humanCanonical = canonical;
    return true;
  });
}
