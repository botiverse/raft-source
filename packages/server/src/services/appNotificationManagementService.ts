import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  oauthAppPermissionRevisions,
  oauthAppWebhookConfigs,
  oauthClientInstalls,
  oauthClients,
} from "../db/schema.js";
import { computeEffectiveAppOutboundAuthority } from "./appOutboundPermissionService.js";
import { oauthClientIsUserManagedPredicate } from "./oauthClientManagementPolicy.js";

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

  return {
    ...row,
    effective: computeEffectiveAppOutboundAuthority({
      currentGroups: row.requestedGroups,
      currentEvents: row.requestedEvents,
      approvedGroups: row.approvedGroups,
      subscribedEvents: row.subscribedEvents,
    }),
    approvalRequired: row.requestedGroups.some((group) => !row.approvedGroups.includes(group)),
  };
}
