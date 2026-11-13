import { and, eq } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import {
  oauthAppPermissionRevisions,
  oauthAppWebhookConfigs,
  oauthClientInstalls,
  oauthClients,
} from "../db/schema";
import { computeEffectiveAppOutboundAuthority } from "./appOutboundPermissionService";
import { oauthClientIsUserManagedPredicate } from "./oauthClientManagementPolicy";
import { getTextRevisions, promptTextConsentEnabled } from "./appPromptTextService";
import { currentAppPermissionSet, hasUnapprovedAppPermissions, type AppPermissionSet } from "./appPermissionExpectation";

export type AppPermissionUpdateInstallRow = {
  installationId: string;
  clientId: string;
  /** What Approve update records: the App's current declaration (currentAppPermissionSet). */
  requested: AppPermissionSet;
  /** What this Server's installation holds. */
  approved: AppPermissionSet;
  /** The App asks for a scope or group this installation has not approved. */
  approvalRequired: boolean;
};

/**
 * The installations on a Server whose App permission updates an admin there
 * approves (#triage:59b61529): every active installation of an enabled,
 * user-managed third-party App, the Server's own installation of its own App
 * included. The notice count, the Settings list flag and the installation
 * detail all read this one function, so whatever the notice counts, Settings
 * lists with a Review button, and its Approve update records `requested`.
 */
export async function appPermissionUpdateInstallRows(
  serverId: string,
  options: { clientId?: string; db?: DatabaseExecutor } = {},
): Promise<AppPermissionUpdateInstallRow[]> {
  const rows = await (options.db ?? getDb()).select({
    installationId: oauthClientInstalls.id,
    clientId: oauthClientInstalls.clientId,
    allowedScopes: oauthClients.allowedScopes,
    requestedGroups: oauthClients.outboundCurrentGroups,
    approvedScopes: oauthClientInstalls.approvedScopes,
    approvedGroups: oauthClientInstalls.approvedGroups,
  }).from(oauthClientInstalls)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
    .where(and(
      eq(oauthClientInstalls.serverId, serverId),
      options.clientId === undefined ? undefined : eq(oauthClientInstalls.clientId, options.clientId),
      eq(oauthClientInstalls.status, "active"),
      eq(oauthClients.enabled, true),
      eq(oauthClients.appType, "third_party_global"),
      oauthClientIsUserManagedPredicate(),
    ));
  return rows.map((row) => {
    const requested = currentAppPermissionSet({ allowedScopes: row.allowedScopes, outboundCurrentGroups: row.requestedGroups });
    const approved = { scopes: [...row.approvedScopes], groups: [...row.approvedGroups] };
    return {
      installationId: row.installationId,
      clientId: row.clientId,
      requested,
      approved,
      approvalRequired: hasUnapprovedAppPermissions(requested, approved),
    };
  });
}

/** A narrow notification projection; no App names, scopes or credentials leave this read. */
export async function countAppPermissionUpdates(serverId: string): Promise<number> {
  return (await appPermissionUpdateInstallRows(serverId)).filter((row) => row.approvalRequired).length;
}

export async function getAppNotificationDeveloperState(input: {
  clientId: string;
  sourceServerId: string;
}) {
  return getDb().transaction(async (db) => {
    const [client] = await db.select({
      id: oauthClients.id,
      enabled: oauthClients.enabled,
      requestRevision: oauthClients.outboundRequestRevision,
      currentRevisionId: oauthClients.outboundCurrentRevisionId,
      pendingRevisionId: oauthClients.outboundPendingRevisionId,
      currentGroups: oauthClients.outboundCurrentGroups,
      currentEvents: oauthClients.outboundCurrentEvents,
    }).from(oauthClients).where(and(
      eq(oauthClients.id, input.clientId),
      eq(oauthClients.serverId, input.sourceServerId),
      oauthClientIsUserManagedPredicate(),
    )).limit(1);
    if (!client) return null;

    const [pendingRevision, webhook, sourceInstallation] = await Promise.all([
      client.pendingRevisionId
        ? db.select({
          id: oauthAppPermissionRevisions.id,
          revision: oauthAppPermissionRevisions.revision,
          groups: oauthAppPermissionRevisions.requestedGroups,
          events: oauthAppPermissionRevisions.requestedEvents,
          createdAt: oauthAppPermissionRevisions.createdAt,
        }).from(oauthAppPermissionRevisions).where(and(
          eq(oauthAppPermissionRevisions.id, client.pendingRevisionId),
          eq(oauthAppPermissionRevisions.clientId, client.id),
          eq(oauthAppPermissionRevisions.state, "pending_review"),
        )).limit(1).then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      db.select({
        endpointUrl: oauthAppWebhookConfigs.endpointUrl,
        revision: oauthAppWebhookConfigs.revision,
        enabled: oauthAppWebhookConfigs.enabled,
        previousValidUntil: oauthAppWebhookConfigs.previousValidUntil,
        updatedAt: oauthAppWebhookConfigs.updatedAt,
      }).from(oauthAppWebhookConfigs)
        .where(eq(oauthAppWebhookConfigs.clientId, client.id))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db.select({
        id: oauthClientInstalls.id,
        status: oauthClientInstalls.status,
        approvedRequestRevisionId: oauthClientInstalls.approvedRequestRevisionId,
        approvedGroups: oauthClientInstalls.approvedGroups,
      }).from(oauthClientInstalls).where(and(
        eq(oauthClientInstalls.clientId, client.id),
        eq(oauthClientInstalls.serverId, input.sourceServerId),
      )).limit(1).then((rows) => rows[0] ?? null),
    ]);

    return {
      requestRevision: client.requestRevision,
      currentRevisionId: client.currentRevisionId,
      currentGroups: client.currentGroups,
      currentEvents: client.currentEvents,
      pendingRevision,
      webhook,
      sourceInstallation: sourceInstallation ? { ...sourceInstallation, enabled: client.enabled } : null,
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export async function getAppNotificationInstallationState(input: {
  clientId: string;
  serverId: string;
}) {
  const [row] = await getDb().select({
    installationId: oauthClientInstalls.id,
    status: oauthClientInstalls.status,
    approvedRequestRevisionId: oauthClientInstalls.approvedRequestRevisionId,
    approvedGroups: oauthClientInstalls.approvedGroups,
    subscribedEvents: oauthClientInstalls.subscribedEvents,
    grantRevision: oauthClientInstalls.grantRevision,
    subscriptionRevision: oauthClientInstalls.subscriptionRevision,
    requestedGroups: oauthClients.outboundCurrentGroups,
    requestedEvents: oauthClients.outboundCurrentEvents,
    pendingRevisionId: oauthClients.outboundPendingRevisionId,
    allowedScopes: oauthClients.allowedScopes,
    approvedScopes: oauthClientInstalls.approvedScopes,
    confirmedTextRevisionId: oauthClientInstalls.confirmedTextRevisionId,
    currentTextRevisionId: oauthClients.textCurrentRevisionId,
  }).from(oauthClientInstalls)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
    .where(and(
      eq(oauthClientInstalls.serverId, input.serverId),
      eq(oauthClientInstalls.clientId, input.clientId),
      eq(oauthClientInstalls.status, "active"),
      oauthClientIsUserManagedPredicate(),
    ))
    .limit(1);
  if (!row) return null;

  const { allowedScopes, confirmedTextRevisionId, currentTextRevisionId, ...rest } = row;
  // Whether this installation awaits Approve update: the same rule and row
  // set as the notice count. A row outside it (a server-local App's source
  // installation, a disabled App) has nothing to approve.
  const [update] = await appPermissionUpdateInstallRows(input.serverId, { clientId: input.clientId });
  const requestedScopes = (update?.requested ?? currentAppPermissionSet({ allowedScopes, outboundCurrentGroups: row.requestedGroups })).scopes;
  // Task #4: the text this Server's agents read (confirmed) and the app's
  // current text. Confirmation is only asked for while the flag is on.
  const textRevisions = await getTextRevisions([confirmedTextRevisionId, currentTextRevisionId]);
  const confirmedText = confirmedTextRevisionId ? textRevisions.get(confirmedTextRevisionId) ?? null : null;
  const currentText = currentTextRevisionId ? textRevisions.get(currentTextRevisionId) ?? null : null;
  const textConfirmationRequired = Boolean(currentText)
    && confirmedTextRevisionId !== currentTextRevisionId
    && await promptTextConsentEnabled(input.serverId);
  // Login scopes the app added after this server approved it (task #2).
  const newScopes = requestedScopes.filter((scope) => !row.approvedScopes.includes(scope));
  return {
    ...rest,
    requestedScopes,
    newScopes,
    effective: computeEffectiveAppOutboundAuthority({
      currentGroups: row.requestedGroups,
      currentEvents: row.requestedEvents,
      approvedGroups: row.approvedGroups,
      subscribedEvents: row.subscribedEvents,
    }),
    approvalRequired: update?.approvalRequired ?? false,
    promptText: {
      confirmed: confirmedText,
      current: currentText,
      confirmationRequired: textConfirmationRequired,
    },
  };
}
