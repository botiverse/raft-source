import { and, asc, eq, exists, isNull, ne, notExists, or, sql } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db";
import { oauthAppLinkPreviews, oauthClientInstalls, oauthClients, oauthLinkPreviewDeclines, oauthUserConsents, serverMembers, servers } from "../db/schema";
import { coversLinkPreviewScopes, LINK_PREVIEW_SCOPES, onServerOrEveryServer } from "./appLinkPreviewService";
import { recordIntegrationAuditEvent } from "./integrationAuditService";
import { grantAccountOAuthUserConsent, isAccountLoginEnabledFor } from "./oauthAccountLogin";
import { grantOAuthUserConsent, validateOAuthScopesForClient, type OAuthUserConsentSource } from "./oauthService";

// A person's answer to an App's first-view link-preview prompt, for
// themselves on one Server. Allowing records a consent (as Login with Raft
// does) and lifts a decline; declining is also how previews are turned off
// later. A decline leaves the consent row alone: that row records Login with
// Raft, and the next login would write it again anyway.
//
// For an App in account mode (RFC 079 D17) the answer is one per person and
// App, whichever Server it is given on: allowing writes the account consent
// (no Server, the one an account-mode login writes) and declining writes a
// decline with no Server, each counting on every Server
// (appLinkPreviewService.registeredApps). A consent or decline the person
// gave on one Server before the App switched keeps counting on that Server
// only, until they answer there again (allowing there lifts that decline).
// A guest cannot answer for an account-mode App on that Server (D7).

export const LINK_PREVIEW_APP_NOT_FOUND = "LINK_PREVIEW_APP_NOT_FOUND";
export const LINK_PREVIEW_SCOPES_NOT_ALLOWED = "LINK_PREVIEW_SCOPES_NOT_ALLOWED";

export type LinkPreviewApp = { id: string; name: string; icon: string | null };
type Viewer = { serverId: string; userId: string; clientId: string };

/**
 * The App the viewer may answer a prompt for: enabled, actively installed on
 * this Server with a link-preview registration, the viewer a member (for an
 * account-mode App: not a guest, RFC 079 D7, and the kill switch
 * oauth_account_login on for them). Locks, in
 * this order, the App row (FOR KEY SHARE: marketplace offline review holds it
 * FOR UPDATE while it removes installations), then the membership and the
 * installation (FOR SHARE: member removal locks the membership FOR UPDATE;
 * uninstall and offline review delete the installation). A removal that
 * commits first leaves nothing to find; one that waits runs after this commit
 * and clears what it wrote.
 */
async function lockPromptedApp(tx: DatabaseExecutor, input: Viewer) {
  // The mode read here holds to commit: the switch locks this row FOR UPDATE.
  const [app] = await tx.select({ id: oauthClients.id, name: oauthClients.name, icon: oauthClients.logoUrl, key: oauthClients.clientId, allowedScopes: oauthClients.allowedScopes,
    loginMode: oauthClients.loginMode })
    .from(oauthClients).where(and(eq(oauthClients.id, input.clientId), eq(oauthClients.enabled, true))).for("key share");
  if (!app) return null;
  // An account-mode App's answer is the account-mode row, which does not
  // exist while the kill switch is off for the person: no answer, as a guest.
  if (app.loginMode === "account" && !await isAccountLoginEnabledFor(input.userId, tx)) return null;
  const [installed] = await tx.select({ id: oauthClientInstalls.id }).from(serverMembers)
    .innerJoin(servers, and(eq(servers.id, serverMembers.serverId), isNull(servers.deletedAt)))
    .innerJoin(oauthClientInstalls, and(eq(oauthClientInstalls.serverId, serverMembers.serverId), eq(oauthClientInstalls.clientId, app.id), eq(oauthClientInstalls.status, "active")))
    .innerJoin(oauthAppLinkPreviews, eq(oauthAppLinkPreviews.clientId, app.id))
    .where(and(eq(serverMembers.serverId, input.serverId), eq(serverMembers.userId, input.userId),
      app.loginMode === "account" ? ne(serverMembers.role, "guest") : undefined))
    .for("share", { of: [serverMembers, oauthClientInstalls] });
  return installed ? app : null;
}

const appView = (app: { id: string; name: string; icon: string | null }): LinkPreviewApp => ({ id: app.id, name: app.name, icon: app.icon });

/**
 * The viewer's link-preview choice for one App on one Server (`serverId`
 * null: an account-mode App's choice for every Server), as a
 * transaction-scoped advisory lock. Declining takes it exclusively before it
 * writes; an interactive card execute takes both of a Server's (its own and
 * the one for every Server) shared and then re-reads the decline
 * (services/linkCardLiveState.ts, Tenny's #10971 review). A missing decline
 * row can't be row-locked, so this is what keeps "not declined" stable until
 * that execute commits: a decline that committed first is seen by the
 * re-read, and one that starts later waits for the commit.
 */
export async function lockLinkPreviewChoice(tx: DatabaseExecutor, choice: { userId: string; serverId: string | null; clientId: string }, mode: "shared" | "exclusive"): Promise<void> {
  const key = `link_preview_choice:${choice.userId}:${choice.serverId ?? "account"}:${choice.clientId}`;
  await tx.execute(mode === "shared"
    ? sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`
    : sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export type AllowLinkPreviewsResult =
  | { kind: "not_found" }
  | { kind: "scopes_not_allowed" }
  | { kind: "allowed"; app: LinkPreviewApp; scopes: string[]; source: OAuthUserConsentSource; grantedAt: Date };

/**
 * The viewer allows the App's previews: lifts their decline and consents with
 * the preview scopes. For an account-mode App, the consent and the decline
 * lifted are the ones for every Server, and the decline on this Server too.
 */
export async function allowLinkPreviews(input: Viewer): Promise<AllowLinkPreviewsResult> {
  return getDb().transaction(async (tx) => {
    const app = await lockPromptedApp(tx, input);
    if (!app) return { kind: "not_found" } as const;
    if (!validateOAuthScopesForClient(LINK_PREVIEW_SCOPES, { clientId: app.key, allowedScopes: app.allowedScopes }).allowed) {
      return { kind: "scopes_not_allowed" } as const;
    }
    const everyServer = app.loginMode === "account";
    const removed = await tx.delete(oauthLinkPreviewDeclines).where(and(
      eq(oauthLinkPreviewDeclines.userId, input.userId),
      everyServer ? onServerOrEveryServer(oauthLinkPreviewDeclines.serverId, input.serverId) : eq(oauthLinkPreviewDeclines.serverId, input.serverId),
      eq(oauthLinkPreviewDeclines.clientId, app.id),
    )).returning({ id: oauthLinkPreviewDeclines.id });
    const grant = { userId: input.userId, clientId: app.id, scopes: LINK_PREVIEW_SCOPES, source: "preview_prompt" as const, now: currentDate() };
    const consent = everyServer ? await grantAccountOAuthUserConsent(tx, grant) : await grantOAuthUserConsent(tx, { ...grant, serverId: input.serverId });
    await recordIntegrationAuditEvent({
      serverId: input.serverId, clientId: app.id, eventType: "link_preview.consent_granted", outcome: "success", source: "web",
      actor: { type: "human", id: input.userId }, subject: { type: "human", id: input.userId }, target: { type: "app", id: app.id },
      metadata: { clientKey: app.key, consentSource: consent.source, removedDecline: removed.length > 0, ...(everyServer ? { loginMode: "account" } : {}) },
    }, tx);
    return { kind: "allowed", app: appView(app), scopes: consent.scopes, source: consent.source, grantedAt: consent.grantedAt } as const;
  });
}

export type DeclineLinkPreviewsResult = { kind: "not_found" } | { kind: "declined"; app: LinkPreviewApp; declinedAt: Date };

/**
 * The viewer declines (or turns off) the App's previews: on this Server, or,
 * for an account-mode App, on every Server. Their consent row stays as it is.
 */
export async function declineLinkPreviews(input: Viewer): Promise<DeclineLinkPreviewsResult> {
  return getDb().transaction(async (tx) => {
    const app = await lockPromptedApp(tx, input);
    if (!app) return { kind: "not_found" } as const;
    const everyServer = app.loginMode === "account";
    const serverId = everyServer ? null : input.serverId;
    // Ordered with any card execute that is re-reading this viewer's decline.
    await lockLinkPreviewChoice(tx, { userId: input.userId, serverId, clientId: app.id }, "exclusive");
    const now = currentDate();
    const [decline] = await tx.insert(oauthLinkPreviewDeclines)
      .values({ userId: input.userId, serverId, clientId: app.id, declinedAt: now })
      .onConflictDoUpdate(everyServer
        ? { target: [oauthLinkPreviewDeclines.userId, oauthLinkPreviewDeclines.clientId], targetWhere: sql`server_id IS NULL`, set: { declinedAt: now } }
        : { target: [oauthLinkPreviewDeclines.userId, oauthLinkPreviewDeclines.serverId, oauthLinkPreviewDeclines.clientId], set: { declinedAt: now } })
      .returning({ declinedAt: oauthLinkPreviewDeclines.declinedAt });
    await recordIntegrationAuditEvent({
      serverId: input.serverId, clientId: app.id, eventType: "link_preview.declined", outcome: "success", source: "web",
      actor: { type: "human", id: input.userId }, subject: { type: "human", id: input.userId }, target: { type: "app", id: app.id },
      metadata: { clientKey: app.key, ...(everyServer ? { loginMode: "account" } : {}) },
    }, tx);
    return { kind: "declined", app: appView(app), declinedAt: decline!.declinedAt } as const;
  });
}

/**
 * The viewer's link-preview choices on this Server, for Apps with a
 * link-preview registration, one row per App: allowed (an active consent
 * covering the preview scopes, not declined) and declined. An account-mode
 * App's choice for every Server is listed on each Server where the App is
 * actively installed (where it can be changed), and wins over a row the
 * viewer left on this Server before the App switched; it is not listed while
 * the kill switch oauth_account_login is off for the viewer.
 */
export async function listLinkPreviewChoices(input: { serverId: string; userId: string }) {
  const app = { id: oauthClients.id, name: oauthClients.name, icon: oauthClients.logoUrl };
  // While the kill switch is off for the viewer, the rows for every Server are
  // not listed (they cannot be answered); a decline for every Server still
  // keeps an earlier per-Server consent out of `allowed`, as it stops it.
  const accountLoginOn = await isAccountLoginEnabledFor(input.userId);
  // Where the viewer can change an account-mode App's choice: the App actively installed here, the viewer no guest here (D7).
  const answerableHere = exists(getDb().select({ one: sql`1` }).from(oauthClientInstalls)
    .innerJoin(serverMembers, and(eq(serverMembers.serverId, oauthClientInstalls.serverId), eq(serverMembers.userId, input.userId)))
    .where(and(eq(oauthClientInstalls.clientId, oauthClients.id), eq(oauthClientInstalls.serverId, input.serverId), eq(oauthClientInstalls.status, "active"),
      ne(serverMembers.role, "guest"))));
  // This Server's rows, and an account-mode App's rows for every Server (only it holds those), listed where they can be changed.
  const countsHere = (serverIdColumn: typeof oauthUserConsents.serverId | typeof oauthLinkPreviewDeclines.serverId) => and(
    accountLoginOn ? onServerOrEveryServer(serverIdColumn, input.serverId) : eq(serverIdColumn, input.serverId),
    or(ne(oauthClients.loginMode, "account"), answerableHere),
  );
  // Within each App, the row for every Server first.
  const everyServerFirst = (serverIdColumn: typeof oauthUserConsents.serverId | typeof oauthLinkPreviewDeclines.serverId) => sql`${serverIdColumn} ASC NULLS FIRST`;
  const [allowed, declined] = await Promise.all([
    getDb().select({ app, scopes: oauthUserConsents.scopes, source: oauthUserConsents.source, grantedAt: oauthUserConsents.grantedAt })
      .from(oauthUserConsents)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthUserConsents.clientId))
      .innerJoin(oauthAppLinkPreviews, eq(oauthAppLinkPreviews.clientId, oauthClients.id))
      .where(and(eq(oauthUserConsents.userId, input.userId), countsHere(oauthUserConsents.serverId), isNull(oauthUserConsents.revokedAt),
        coversLinkPreviewScopes(oauthUserConsents.scopes),
        notExists(getDb().select({ one: sql`1` }).from(oauthLinkPreviewDeclines).where(and(
          eq(oauthLinkPreviewDeclines.userId, oauthUserConsents.userId), eq(oauthLinkPreviewDeclines.clientId, oauthUserConsents.clientId),
          onServerOrEveryServer(oauthLinkPreviewDeclines.serverId, input.serverId))))))
      .orderBy(asc(oauthClients.name), asc(oauthClients.id), everyServerFirst(oauthUserConsents.serverId)),
    getDb().select({ app, declinedAt: oauthLinkPreviewDeclines.declinedAt })
      .from(oauthLinkPreviewDeclines)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthLinkPreviewDeclines.clientId))
      .innerJoin(oauthAppLinkPreviews, eq(oauthAppLinkPreviews.clientId, oauthClients.id))
      .where(and(eq(oauthLinkPreviewDeclines.userId, input.userId), countsHere(oauthLinkPreviewDeclines.serverId)))
      .orderBy(asc(oauthClients.name), asc(oauthClients.id), everyServerFirst(oauthLinkPreviewDeclines.serverId)),
  ]);
  return { allowed: firstPerApp(allowed), declined: firstPerApp(declined) };
}

function firstPerApp<T extends { app: { id: string } }>(rows: T[]): T[] {
  return rows.filter((row, index) => index === 0 || rows[index - 1]!.app.id !== row.app.id);
}
