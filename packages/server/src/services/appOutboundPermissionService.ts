import {
  APP_NOTIFICATION_EVENT_GROUPS,
  APP_NOTIFICATION_GROUPS,
  appNotificationEventRequiredGroups,
  currentDate,
  type AppNotificationEvent,
  type AppNotificationGroup,
} from "@botiverse/raft-shared";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index.js";
import {
  oauthAppInstallationTokens,
  oauthAppPermissionRevisions,
  oauthClientInstalls,
  oauthClients,
} from "../db/schema.js";
import { ensureLocalAppSourceInstallation } from "./appSourceInstallationService.js";
import * as integrationAuditService from "./integrationAuditService.js";
import { oauthClientIsUserManagedPredicate } from "./oauthClientManagementPolicy.js";

export const APP_OUTBOUND_GROUPS = APP_NOTIFICATION_GROUPS;
export const APP_OUTBOUND_EVENT_GROUPS = APP_NOTIFICATION_EVENT_GROUPS;
export type AppOutboundGroup = AppNotificationGroup;
export type AppOutboundEventType = AppNotificationEvent;

const GROUP_SET = new Set<string>(APP_OUTBOUND_GROUPS);
const EVENT_SET = new Set<string>(Object.keys(APP_OUTBOUND_EVENT_GROUPS));

export class AppOutboundPermissionError extends Error {}

function normalizeStringSet(raw: unknown, allowed: Set<string>, label: string): string[] {
  if (!Array.isArray(raw)) throw new AppOutboundPermissionError(`${label} must be an array`);
  const result = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string" || !allowed.has(value)) {
      throw new AppOutboundPermissionError(`Unknown ${label} value`);
    }
    result.add(value);
  }
  return [...result].sort();
}

export function normalizeAppOutboundGroups(raw: unknown): AppOutboundGroup[] {
  return normalizeStringSet(raw, GROUP_SET, "group") as AppOutboundGroup[];
}

function intersect(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value)).sort();
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value)).sort();
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function normalizeAppOutboundPermissionRequest(input: {
  groups: unknown;
  events: unknown;
}): { groups: AppOutboundGroup[]; events: AppOutboundEventType[] } {
  const groups = normalizeStringSet(input.groups, GROUP_SET, "group") as AppOutboundGroup[];
  const events = normalizeStringSet(input.events, EVENT_SET, "event") as AppOutboundEventType[];
  const groupSet = new Set(groups);
  for (const event of events) {
    const missing = APP_OUTBOUND_EVENT_GROUPS[event].find((group) => !groupSet.has(group));
    if (missing) {
      throw new AppOutboundPermissionError(`Event ${event} requires group ${missing}`);
    }
  }
  return { groups, events };
}

export function computeEffectiveAppOutboundAuthority(input: {
  currentGroups: readonly string[];
  currentEvents: readonly string[];
  approvedGroups: readonly string[];
  subscribedEvents: readonly string[];
}): { groups: AppOutboundGroup[]; events: AppOutboundEventType[] } {
  const groups = intersect(
    intersect(input.currentGroups, input.approvedGroups),
    APP_OUTBOUND_GROUPS,
  ) as AppOutboundGroup[];
  const groupSet = new Set(groups);
  const allowedByGroups = (Object.keys(APP_OUTBOUND_EVENT_GROUPS) as AppOutboundEventType[])
    .filter((event) => APP_OUTBOUND_EVENT_GROUPS[event].every((group) => groupSet.has(group)));
  const events = intersect(
    intersect(input.currentEvents, input.subscribedEvents),
    allowedByGroups,
  ) as AppOutboundEventType[];
  return { groups, events };
}

async function revokeInstallationTokens(
  executor: DatabaseExecutor,
  installationIds: readonly string[],
  now: Date,
) {
  if (installationIds.length === 0) return;
  await executor.update(oauthAppInstallationTokens)
    .set({ revokedAt: now })
    .where(and(
      inArray(oauthAppInstallationTokens.installationId, [...installationIds]),
      isNull(oauthAppInstallationTokens.revokedAt),
    ));
}

export async function createAppOutboundPermissionRevision(input: {
  clientId: string;
  actor: { type: "human" | "agent" | "system"; id?: string | null };
  groups: unknown;
  events: unknown;
}, dbOrTx: ReturnType<typeof getDb> = getDb()) {
  const requested = normalizeAppOutboundPermissionRequest(input);
  return dbOrTx.transaction(async (tx) => {
    const [client] = await tx.select({
      id: oauthClients.id,
      serverId: oauthClients.serverId,
      clientKey: oauthClients.clientId,
      appType: oauthClients.appType,
      publishStatus: oauthClients.publishStatus,
      revision: oauthClients.outboundRequestRevision,
      currentGroups: oauthClients.outboundCurrentGroups,
      currentEvents: oauthClients.outboundCurrentEvents,
    }).from(oauthClients)
      .where(and(
        eq(oauthClients.id, input.clientId),
        oauthClientIsUserManagedPredicate(),
      ))
      .limit(1)
      .for("update");
    if (!client) return null;

    const priorGroups = [...client.currentGroups].sort();
    const priorEvents = [...client.currentEvents].sort();
    const survivingGroups = intersect(priorGroups, requested.groups);
    const survivingEvents = intersect(priorEvents, requested.events);
    const additions = [
      ...difference(requested.groups, priorGroups),
      ...difference(requested.events, priorEvents),
    ];
    const requiresReview = client.appType === "third_party_global"
      && (client.publishStatus === "published" || client.publishStatus === "unpublish_requested")
      && additions.length > 0;
    const currentGroups = requiresReview ? survivingGroups : requested.groups;
    const currentEvents = requiresReview ? survivingEvents : requested.events;
    const revision = client.revision + 1;
    const now = currentDate();

    await tx.update(oauthAppPermissionRevisions)
      .set({ state: "superseded" })
      .where(and(
        eq(oauthAppPermissionRevisions.clientId, client.id),
        ne(oauthAppPermissionRevisions.state, "superseded"),
      ));
    const [created] = await tx.insert(oauthAppPermissionRevisions).values({
      clientId: client.id,
      revision,
      requestedGroups: requested.groups,
      requestedEvents: requested.events,
      state: requiresReview ? "pending_review" : "active",
      createdByType: input.actor.type,
      createdById: input.actor.id ?? null,
    }).returning();

    await tx.update(oauthClients).set({
      outboundRequestRevision: revision,
      outboundCurrentRevisionId: created.id,
      outboundPendingRevisionId: requiresReview ? created.id : null,
      outboundCurrentGroups: currentGroups,
      outboundCurrentEvents: currentEvents,
      updatedAt: now,
    }).where(eq(oauthClients.id, client.id));

    const groupsContracted = difference(priorGroups, currentGroups).length > 0;
    let invalidatedInstallationCount = 0;
    if (groupsContracted) {
      const affected = await tx.select({
        id: oauthClientInstalls.id,
        approvedGroups: oauthClientInstalls.approvedGroups,
        grantRevision: oauthClientInstalls.grantRevision,
      }).from(oauthClientInstalls).where(and(
          eq(oauthClientInstalls.clientId, client.id),
          eq(oauthClientInstalls.status, "active"),
        ));
      invalidatedInstallationCount = affected.length;
      for (const installation of affected) {
        await tx.update(oauthClientInstalls).set({
          approvedGroups: intersect(installation.approvedGroups, currentGroups),
          grantRevision: installation.grantRevision + 1,
          updatedAt: now,
        }).where(eq(oauthClientInstalls.id, installation.id));
      }
      await revokeInstallationTokens(tx, affected.map((row) => row.id), now);
    }

    if (!requiresReview) {
      await ensureLocalAppSourceInstallation(client.id, tx);
      const sourceInstalls = await tx.select({
        id: oauthClientInstalls.id,
        approvedGroups: oauthClientInstalls.approvedGroups,
        grantRevision: oauthClientInstalls.grantRevision,
      }).from(oauthClientInstalls).where(and(
        eq(oauthClientInstalls.clientId, client.id),
        eq(oauthClientInstalls.serverId, client.serverId),
        eq(oauthClientInstalls.status, "active"),
      ));
      const changedSourceInstallIds: string[] = [];
      for (const installation of sourceInstalls) {
        const groupsChanged = !sameSet([...installation.approvedGroups].sort(), currentGroups);
        await tx.update(oauthClientInstalls).set({
          approvedRequestRevisionId: created.id,
          approvedGroups: currentGroups,
          grantRevision: groupsChanged ? installation.grantRevision + 1 : installation.grantRevision,
          updatedAt: now,
        }).where(eq(oauthClientInstalls.id, installation.id));
        if (groupsChanged) changedSourceInstallIds.push(installation.id);
      }
      await revokeInstallationTokens(tx, changedSourceInstallIds, now);
    }

    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: client.serverId,
      clientId: client.id,
      eventType: "app.outbound_permission_requested",
      outcome: "success",
      source: "api",
      actor: input.actor,
      subject: { type: "app", id: client.id },
      target: { type: "app", id: client.id },
      metadata: {
        clientKey: client.clientKey,
        revision,
        state: created.state,
        groupCount: requested.groups.length,
        eventCount: requested.events.length,
        invalidatedInstallationCount,
      },
    }, tx);

    return {
      revision: created,
      currentGroups,
      currentEvents,
      requiresReview,
      invalidatedInstallationCount,
    };
  });
}

export async function approvePendingAppOutboundPermissionRevision(input: {
  clientId: string;
  reviewerUserId: string;
}, dbOrTx: ReturnType<typeof getDb> = getDb()) {
  return dbOrTx.transaction(async (tx) => {
    const [client] = await tx.select({
      id: oauthClients.id,
      serverId: oauthClients.serverId,
      clientKey: oauthClients.clientId,
      pendingRevisionId: oauthClients.outboundPendingRevisionId,
    }).from(oauthClients)
      .where(and(
        eq(oauthClients.id, input.clientId),
        oauthClientIsUserManagedPredicate(),
      ))
      .limit(1)
      .for("update");
    if (!client?.pendingRevisionId) return null;
    const now = currentDate();

    const [revision] = await tx.update(oauthAppPermissionRevisions).set({
      state: "active",
      reviewedByUserId: input.reviewerUserId,
      reviewedAt: now,
    }).where(and(
      eq(oauthAppPermissionRevisions.id, client.pendingRevisionId),
      eq(oauthAppPermissionRevisions.clientId, client.id),
      eq(oauthAppPermissionRevisions.state, "pending_review"),
    )).returning();
    if (!revision) return null;

    await tx.update(oauthClients).set({
      outboundCurrentRevisionId: revision.id,
      outboundPendingRevisionId: null,
      outboundCurrentGroups: revision.requestedGroups,
      outboundCurrentEvents: revision.requestedEvents,
      updatedAt: now,
    }).where(eq(oauthClients.id, client.id));

    const sourceInstalls = await tx.select({
      id: oauthClientInstalls.id,
      approvedGroups: oauthClientInstalls.approvedGroups,
      grantRevision: oauthClientInstalls.grantRevision,
    }).from(oauthClientInstalls).where(and(
      eq(oauthClientInstalls.clientId, client.id),
      eq(oauthClientInstalls.serverId, client.serverId),
      eq(oauthClientInstalls.status, "active"),
    ));
    const changedSourceInstallIds: string[] = [];
    for (const installation of sourceInstalls) {
      const groupsChanged = !sameSet([...installation.approvedGroups].sort(), revision.requestedGroups);
      await tx.update(oauthClientInstalls).set({
        approvedRequestRevisionId: revision.id,
        approvedGroups: revision.requestedGroups,
        grantRevision: groupsChanged ? installation.grantRevision + 1 : installation.grantRevision,
        updatedAt: now,
      }).where(eq(oauthClientInstalls.id, installation.id));
      if (groupsChanged) changedSourceInstallIds.push(installation.id);
    }
    await revokeInstallationTokens(tx, changedSourceInstallIds, now);

    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: client.serverId,
      clientId: client.id,
      eventType: "app.outbound_permission_approved",
      outcome: "success",
      source: "api",
      actor: { type: "human", id: input.reviewerUserId },
      subject: { type: "app", id: client.id },
      target: { type: "app", id: client.id },
      metadata: {
        clientKey: client.clientKey,
        revision: revision.revision,
        groupCount: revision.requestedGroups.length,
        eventCount: revision.requestedEvents.length,
      },
    }, tx);
    return revision;
  });
}

export async function updateAppInstallationGrant(input: {
  installationId: string;
  actorUserId: string;
}, dbOrTx: ReturnType<typeof getDb> = getDb()) {
  return dbOrTx.transaction(async (tx) => {
    const [row] = await tx.select({
      installation: oauthClientInstalls,
      clientKey: oauthClients.clientId,
      currentRevisionId: oauthClients.outboundCurrentRevisionId,
      currentGroups: oauthClients.outboundCurrentGroups,
      currentEvents: oauthClients.outboundCurrentEvents,
    }).from(oauthClientInstalls)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
      .where(and(
        eq(oauthClientInstalls.id, input.installationId),
        oauthClientIsUserManagedPredicate(),
      ))
      .limit(1)
      .for("update");
    if (!row || row.installation.status !== "active" || !row.currentRevisionId) return null;

    const nextSubscriptions = intersect(
      row.installation.subscribedEvents,
      (Object.keys(APP_OUTBOUND_EVENT_GROUPS) as AppOutboundEventType[]).filter((event) => (
        row.currentEvents.includes(event)
        && APP_OUTBOUND_EVENT_GROUPS[event].every((group) => row.currentGroups.includes(group))
      )),
    );
    const groupsChanged = !sameSet(
      [...row.installation.approvedGroups].sort(),
      [...row.currentGroups].sort(),
    );
    const nextGrantRevision = groupsChanged
      ? row.installation.grantRevision + 1
      : row.installation.grantRevision;
    const subscriptionsChanged = !sameSet([...row.installation.subscribedEvents].sort(), nextSubscriptions);
    const now = currentDate();
    const [updated] = await tx.update(oauthClientInstalls).set({
      approvedRequestRevisionId: row.currentRevisionId,
      approvedGroups: row.currentGroups,
      subscribedEvents: nextSubscriptions,
      grantRevision: nextGrantRevision,
      subscriptionRevision: subscriptionsChanged
        ? row.installation.subscriptionRevision + 1
        : row.installation.subscriptionRevision,
      updatedAt: now,
    }).where(eq(oauthClientInstalls.id, row.installation.id)).returning();
    if (groupsChanged) await revokeInstallationTokens(tx, [row.installation.id], now);

    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: row.installation.serverId,
      clientId: row.installation.clientId,
      eventType: "installation.outbound_grant_updated",
      outcome: "success",
      source: "api",
      actor: { type: "human", id: input.actorUserId },
      subject: { type: "app", id: row.installation.clientId },
      target: { type: "installation", id: row.installation.id },
      metadata: {
        clientKey: row.clientKey,
        installationId: row.installation.id,
        grantRevision: nextGrantRevision,
        groupCount: row.currentGroups.length,
      },
    }, tx);
    return updated;
  });
}

export async function updateAppInstallationSubscriptions(input: {
  installationId: string;
  clientId?: string;
  subscribedEvents: unknown;
  actor: { type: "human" | "app"; id?: string | null };
}, dbOrTx: ReturnType<typeof getDb> = getDb()) {
  const subscribedEvents = normalizeStringSet(input.subscribedEvents, EVENT_SET, "event") as AppOutboundEventType[];
  return dbOrTx.transaction(async (tx) => {
    const [row] = await tx.select({
      installation: oauthClientInstalls,
      clientKey: oauthClients.clientId,
      currentGroups: oauthClients.outboundCurrentGroups,
      currentEvents: oauthClients.outboundCurrentEvents,
    }).from(oauthClientInstalls)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
      .where(and(
        eq(oauthClientInstalls.id, input.installationId),
        input.clientId ? eq(oauthClientInstalls.clientId, input.clientId) : undefined,
        oauthClientIsUserManagedPredicate(),
      ))
      .limit(1)
      .for("update");
    if (!row || row.installation.status !== "active") return null;

    const effectiveWithoutSubscription = computeEffectiveAppOutboundAuthority({
      currentGroups: row.currentGroups,
      currentEvents: row.currentEvents,
      approvedGroups: row.installation.approvedGroups,
      subscribedEvents: row.currentEvents,
    });
    if (difference(subscribedEvents, effectiveWithoutSubscription.events).length > 0) {
      throw new AppOutboundPermissionError("Subscription exceeds approved event authority");
    }
    const now = currentDate();
    const [updated] = await tx.update(oauthClientInstalls).set({
      subscribedEvents,
      subscriptionRevision: row.installation.subscriptionRevision + 1,
      updatedAt: now,
    }).where(eq(oauthClientInstalls.id, row.installation.id)).returning();

    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: row.installation.serverId,
      clientId: row.installation.clientId,
      eventType: "installation.outbound_subscription_updated",
      outcome: "success",
      source: "api",
      actor: input.actor.type === "human"
        ? { type: "human", id: input.actor.id }
        : { type: "system" },
      requester: input.actor.type === "app"
        ? { type: "app", id: row.installation.clientId }
        : undefined,
      subject: { type: "app", id: row.installation.clientId },
      target: { type: "installation", id: row.installation.id },
      metadata: {
        clientKey: row.clientKey,
        installationId: row.installation.id,
        subscriptionRevision: updated.subscriptionRevision,
        eventCount: subscribedEvents.length,
      },
    }, tx);
    return updated;
  });
}

export function appOutboundEventRequiredGroups(eventType: AppOutboundEventType): AppOutboundGroup[] {
  return appNotificationEventRequiredGroups(eventType);
}
