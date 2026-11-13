import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db";
import { oauthAppLinkPreviews, oauthClientInstalls, oauthClients, oauthLinkPreviewDeclines, oauthUserConsents, serverMembers, servers } from "../db/schema";
import { LINK_PREVIEW_SCOPES } from "./appLinkPreviewService";
import { recordIntegrationAuditEvent } from "./integrationAuditService";
import { grantOAuthUserConsent, validateOAuthScopesForClient, type OAuthUserConsentSource } from "./oauthService";

// A person's answer to an App's first-view link-preview prompt, for
// themselves on one Server. Allowing records a consent (as Login with Raft
// does) and lifts a decline; declining is also how previews are turned off
// later. A decline leaves the consent row alone: that row records Login with
// Raft, and the next login would write it again anyway.

export const LINK_PREVIEW_APP_NOT_FOUND = "LINK_PREVIEW_APP_NOT_FOUND";
export const LINK_PREVIEW_SCOPES_NOT_ALLOWED = "LINK_PREVIEW_SCOPES_NOT_ALLOWED";

export type LinkPreviewApp = { id: string; name: string; icon: string | null };
type Viewer = { serverId: string; userId: string; clientId: string };

/**
 * The App the viewer may answer a prompt for: enabled, actively installed on
 * this Server with a link-preview registration, the viewer a member. Locks, in
 * this order, the App row (FOR KEY SHARE: marketplace offline review holds it
 * FOR UPDATE while it removes installations), then the membership and the
 * installation (FOR SHARE: member removal locks the membership FOR UPDATE;
 * uninstall and offline review delete the installation). A removal that
 * commits first leaves nothing to find; one that waits runs after this commit
 * and clears what it wrote.
 */
async function lockPromptedApp(tx: DatabaseExecutor, input: Viewer) {
  const [app] = await tx.select({ id: oauthClients.id, name: oauthClients.name, icon: oauthClients.logoUrl, key: oauthClients.clientId, allowedScopes: oauthClients.allowedScopes })
    .from(oauthClients).where(and(eq(oauthClients.id, input.clientId), eq(oauthClients.enabled, true))).for("key share");
  if (!app) return null;
  const [installed] = await tx.select({ id: oauthClientInstalls.id }).from(serverMembers)
    .innerJoin(servers, and(eq(servers.id, serverMembers.serverId), isNull(servers.deletedAt)))
    .innerJoin(oauthClientInstalls, and(eq(oauthClientInstalls.serverId, serverMembers.serverId), eq(oauthClientInstalls.clientId, app.id), eq(oauthClientInstalls.status, "active")))
    .innerJoin(oauthAppLinkPreviews, eq(oauthAppLinkPreviews.clientId, app.id))
    .where(and(eq(serverMembers.serverId, input.serverId), eq(serverMembers.userId, input.userId)))
    .for("share", { of: [serverMembers, oauthClientInstalls] });
  return installed ? app : null;
}

const appView = (app: { id: string; name: string; icon: string | null }): LinkPreviewApp => ({ id: app.id, name: app.name, icon: app.icon });

/**
 * The viewer's link-preview choice for one App on one Server, as a
 * transaction-scoped advisory lock. Declining takes it exclusively before it
 * writes; an interactive card execute takes it shared and then re-reads the
 * decline (services/linkCardLiveState.ts, Tenny's #10971 review). A missing
 * decline row can't be row-locked, so this is what keeps "not declined"
 * stable until that execute commits: a decline that committed first is seen
 * by the re-read, and one that starts later waits for the commit.
 */
export async function lockLinkPreviewChoice(tx: DatabaseExecutor, choice: { userId: string; serverId: string; clientId: string }, mode: "shared" | "exclusive"): Promise<void> {
  const key = `link_preview_choice:${choice.userId}:${choice.serverId}:${choice.clientId}`;
  await tx.execute(mode === "shared"
    ? sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`
    : sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export type AllowLinkPreviewsResult =
  | { kind: "not_found" }
  | { kind: "scopes_not_allowed" }
  | { kind: "allowed"; app: LinkPreviewApp; scopes: string[]; source: OAuthUserConsentSource; grantedAt: Date };

/** The viewer allows the App's previews: lifts their decline and consents with the preview scopes. */
export async function allowLinkPreviews(input: Viewer): Promise<AllowLinkPreviewsResult> {
  return getDb().transaction(async (tx) => {
    const app = await lockPromptedApp(tx, input);
    if (!app) return { kind: "not_found" } as const;
    if (!validateOAuthScopesForClient(LINK_PREVIEW_SCOPES, { clientId: app.key, allowedScopes: app.allowedScopes }).allowed) {
      return { kind: "scopes_not_allowed" } as const;
    }
    const removed = await tx.delete(oauthLinkPreviewDeclines).where(and(
      eq(oauthLinkPreviewDeclines.userId, input.userId),
      eq(oauthLinkPreviewDeclines.serverId, input.serverId),
      eq(oauthLinkPreviewDeclines.clientId, app.id),
    )).returning({ id: oauthLinkPreviewDeclines.id });
    const consent = await grantOAuthUserConsent(tx, {
      userId: input.userId, serverId: input.serverId, clientId: app.id, scopes: LINK_PREVIEW_SCOPES, source: "preview_prompt", now: currentDate(),
    });
    await recordIntegrationAuditEvent({
      serverId: input.serverId, clientId: app.id, eventType: "link_preview.consent_granted", outcome: "success", source: "web",
      actor: { type: "human", id: input.userId }, subject: { type: "human", id: input.userId }, target: { type: "app", id: app.id },
      metadata: { clientKey: app.key, consentSource: consent.source, removedDecline: removed.length > 0 },
    }, tx);
    return { kind: "allowed", app: appView(app), scopes: consent.scopes, source: consent.source, grantedAt: consent.grantedAt } as const;
  });
}

export type DeclineLinkPreviewsResult = { kind: "not_found" } | { kind: "declined"; app: LinkPreviewApp; declinedAt: Date };

/** The viewer declines (or turns off) the App's previews. Their consent row stays as it is. */
export async function declineLinkPreviews(input: Viewer): Promise<DeclineLinkPreviewsResult> {
  return getDb().transaction(async (tx) => {
    const app = await lockPromptedApp(tx, input);
    if (!app) return { kind: "not_found" } as const;
    // Ordered with any card execute that is re-reading this viewer's decline.
    await lockLinkPreviewChoice(tx, { ...input, clientId: app.id }, "exclusive");
    const now = currentDate();
    const [decline] = await tx.insert(oauthLinkPreviewDeclines)
      .values({ userId: input.userId, serverId: input.serverId, clientId: app.id, declinedAt: now })
      .onConflictDoUpdate({
        target: [oauthLinkPreviewDeclines.userId, oauthLinkPreviewDeclines.serverId, oauthLinkPreviewDeclines.clientId],
        set: { declinedAt: now },
      }).returning({ declinedAt: oauthLinkPreviewDeclines.declinedAt });
    await recordIntegrationAuditEvent({
      serverId: input.serverId, clientId: app.id, eventType: "link_preview.declined", outcome: "success", source: "web",
      actor: { type: "human", id: input.userId }, subject: { type: "human", id: input.userId }, target: { type: "app", id: app.id },
      metadata: { clientKey: app.key },
    }, tx);
    return { kind: "declined", app: appView(app), declinedAt: decline!.declinedAt } as const;
  });
}

/**
 * The viewer's link-preview choices on this Server, for Apps with a
 * link-preview registration: allowed (an active consent covering the preview
 * scopes, not declined) and declined.
 */
export async function listLinkPreviewChoices(input: { serverId: string; userId: string }) {
  const app = { id: oauthClients.id, name: oauthClients.name, icon: oauthClients.logoUrl };
  const [allowed, declined] = await Promise.all([
    getDb().select({ app, scopes: oauthUserConsents.scopes, source: oauthUserConsents.source, grantedAt: oauthUserConsents.grantedAt })
      .from(oauthUserConsents)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthUserConsents.clientId))
      .innerJoin(oauthAppLinkPreviews, eq(oauthAppLinkPreviews.clientId, oauthClients.id))
      .leftJoin(oauthLinkPreviewDeclines, and(eq(oauthLinkPreviewDeclines.userId, oauthUserConsents.userId),
        eq(oauthLinkPreviewDeclines.serverId, oauthUserConsents.serverId), eq(oauthLinkPreviewDeclines.clientId, oauthUserConsents.clientId)))
      .where(and(eq(oauthUserConsents.userId, input.userId), eq(oauthUserConsents.serverId, input.serverId), isNull(oauthUserConsents.revokedAt),
        sql`${oauthUserConsents.scopes}::jsonb @> ${JSON.stringify(LINK_PREVIEW_SCOPES)}::jsonb`, isNull(oauthLinkPreviewDeclines.id)))
      .orderBy(asc(oauthClients.name), asc(oauthClients.id)),
    getDb().select({ app, declinedAt: oauthLinkPreviewDeclines.declinedAt })
      .from(oauthLinkPreviewDeclines)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthLinkPreviewDeclines.clientId))
      .innerJoin(oauthAppLinkPreviews, eq(oauthAppLinkPreviews.clientId, oauthClients.id))
      .where(and(eq(oauthLinkPreviewDeclines.userId, input.userId), eq(oauthLinkPreviewDeclines.serverId, input.serverId)))
      .orderBy(asc(oauthClients.name), asc(oauthClients.id)),
  ]);
  return { allowed, declined };
}
