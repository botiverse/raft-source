import {
  APP_AGENT_REMINDER_WRITE_GROUP,
  APP_INSTALLATION_NOTIFICATION_EVENTS,
  APP_NOTIFICATION_EVENT_GROUPS,
  APP_NOTIFICATION_GROUPS,
  appNotificationEventRequiredGroups,
  currentDate,
  isAppInstallationNotificationEvent,
  type AppInstallationNotificationEvent,
  type AppNotificationEvent,
  type AppNotificationGroup,
} from "@botiverse/raft-shared";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import {
  oauthAppInstallationTokens,
  oauthAppPermissionRevisions,
  oauthClientInstalls,
  oauthClients,
} from "../db/schema";
import { assertAppPermissionsMatch, currentAppPermissionSet, type ExpectedAppPermissions } from "./appPermissionExpectation";
import { ensureCurrentTextRevision } from "./appPromptTextService";
import { ensureLocalAppSourceInstallation } from "./appSourceInstallationService";
import * as integrationAuditService from "./integrationAuditService";
import { announcePermissionUpdatesChanged, announcePermissionUpdatesForApp } from "./listChangedRealtime";
import { oauthClientIsUserManagedPredicate } from "./oauthClientManagementPolicy";
import { isApprovedOfficialAppClient } from "./officialAppAutoInstallService";

export const APP_OUTBOUND_GROUPS = APP_NOTIFICATION_GROUPS;
/** The group-gated events: what an App declares and an installer approves. */
export const APP_OUTBOUND_EVENT_GROUPS = APP_NOTIFICATION_EVENT_GROUPS;
export type AppOutboundGroup = AppNotificationGroup;
export type AppOutboundEventType = AppNotificationEvent;
/** An event about the App's own installation: subscribed to without a declaration or group. */
export type AppInstallationEventType = AppInstallationNotificationEvent;

const GROUP_SET = new Set<string>(APP_OUTBOUND_GROUPS);
/** What an App may declare. */
const EVENT_SET = new Set<string>(Object.keys(APP_OUTBOUND_EVENT_GROUPS));
/** What an installation may subscribe to: the declared kind, plus its own events. */
const SUBSCRIBABLE_EVENT_SET = new Set<string>([...EVENT_SET, ...APP_INSTALLATION_NOTIFICATION_EVENTS]);

/**
 * The installation's own events in a subscription set. Every path that
 * rewrites a subscription from the App's declared events keeps these: they
 * are never declared, so the rewrite would otherwise drop them. The review
 * approval (public.marketplace_approve_permission_review) keeps them in SQL,
 * with this list written out there (c_installation_events).
 */
export function installationEventSubscriptions(subscribedEvents: readonly string[]): AppInstallationEventType[] {
  return subscribedEvents.filter(isAppInstallationNotificationEvent).sort();
}

/**
 * A subscription set without the installation's own events: what an
 * installer's App Notifications settings list (they approve groups, and these
 * events need none).
 */
export function groupGatedSubscriptions(subscribedEvents: readonly string[]): AppOutboundEventType[] {
  return subscribedEvents.filter((event): event is AppOutboundEventType => EVENT_SET.has(event));
}

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
    if (
      requested.groups.includes(APP_AGENT_REMINDER_WRITE_GROUP)
      && !await isApprovedOfficialAppClient(client.id, tx)
    ) {
      throw new AppOutboundPermissionError(`Group ${APP_AGENT_REMINDER_WRITE_GROUP} is only grantable to official apps`);
    }

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
        subscribedEvents: oauthClientInstalls.subscribedEvents,
        subscriptionRevision: oauthClientInstalls.subscriptionRevision,
      }).from(oauthClientInstalls).where(and(
        eq(oauthClientInstalls.clientId, client.id),
        eq(oauthClientInstalls.serverId, client.serverId),
        eq(oauthClientInstalls.status, "active"),
      ));
      const changedSourceInstallIds: string[] = [];
      for (const installation of sourceInstalls) {
        const groupsChanged = !sameSet([...installation.approvedGroups].sort(), currentGroups);
        const subscribedEvents = [...currentEvents, ...installationEventSubscriptions(installation.subscribedEvents)].sort();
        const eventsChanged = !sameSet([...installation.subscribedEvents].sort(), subscribedEvents);
        await tx.update(oauthClientInstalls).set({
          approvedRequestRevisionId: created.id,
          approvedGroups: currentGroups,
          grantRevision: groupsChanged ? installation.grantRevision + 1 : installation.grantRevision,
          subscribedEvents,
          subscriptionRevision: eventsChanged ? installation.subscriptionRevision + 1 : installation.subscriptionRevision,
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
    // Every server it is installed on may have an update to approve now.
    await announcePermissionUpdatesForApp(tx, client.id);

    return {
      revision: created,
      currentGroups,
      currentEvents,
      requiresReview,
      invalidatedInstallationCount,
    };
  });
}

export async function updateAppInstallationGrant(input: {
  installationId: string;
  actorUserId: string;
  /**
   * The scopes and groups the admin was shown; recorded only on an exact
   * match. With a prompt-text revision, approving also confirms that
   * revision for this Server (task #4); without one, the text is untouched.
   */
  expected: ExpectedAppPermissions;
}, dbOrTx: ReturnType<typeof getDb> = getDb()) {
  return dbOrTx.transaction(async (tx) => {
    const [row] = await tx.select({
      installation: oauthClientInstalls,
      clientKey: oauthClients.clientId,
      currentRevisionId: oauthClients.outboundCurrentRevisionId,
      currentGroups: oauthClients.outboundCurrentGroups,
      currentEvents: oauthClients.outboundCurrentEvents,
      allowedScopes: oauthClients.allowedScopes,
    }).from(oauthClientInstalls)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
      .where(and(
        eq(oauthClientInstalls.id, input.installationId),
        oauthClientIsUserManagedPredicate(),
      ))
      .limit(1)
      .for("update");
    if (!row || row.installation.status !== "active") return null;
    // Approving an update also approves the app's current login scopes, so it
    // applies to apps that declare no outbound permissions too (task #2). The
    // row lock above holds the app row, so a developer edit can't slip in
    // between this check and the write.
    const text = await ensureCurrentTextRevision(tx, row.installation.clientId);
    const current = {
      ...currentAppPermissionSet({ allowedScopes: row.allowedScopes, outboundCurrentGroups: row.currentGroups }),
      textRevisionId: text.revisionId,
      text: text.text,
    };
    assertAppPermissionsMatch(input.expected, current);
    // Each path below writes the grant; sent once this commits.
    announcePermissionUpdatesChanged([row.installation.serverId]);
    const approvedScopes = current.scopes;
    const textConfirmation = input.expected.textRevisionId
      ? { confirmedTextRevisionId: text.revisionId, textConfirmedByUserId: input.actorUserId, textConfirmedAt: currentDate() }
      : {};
    if (!row.currentRevisionId) {
      const [scopesOnly] = await tx.update(oauthClientInstalls).set({
        approvedScopes,
        ...textConfirmation,
        updatedAt: currentDate(),
      }).where(eq(oauthClientInstalls.id, row.installation.id)).returning();
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
          grantRevision: row.installation.grantRevision,
          groupCount: 0,
          approvedScopes,
        },
      }, tx);
      return scopesOnly;
    }

    const nextSubscriptions = [
      ...intersect(
        row.installation.subscribedEvents,
        (Object.keys(APP_OUTBOUND_EVENT_GROUPS) as AppOutboundEventType[]).filter((event) => (
          row.currentEvents.includes(event)
          && APP_OUTBOUND_EVENT_GROUPS[event].every((group) => row.currentGroups.includes(group))
        )),
      ),
      ...installationEventSubscriptions(row.installation.subscribedEvents),
    ].sort();
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
      approvedScopes,
      ...textConfirmation,
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
        approvedScopes,
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
  // The installation's own events (installation.bot_changed) need no
  // declaration and no installer-approved group; every other event stays
  // within the installation's effective authority.
  const subscribedEvents = normalizeStringSet(input.subscribedEvents, SUBSCRIBABLE_EVENT_SET, "event");
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
    if (difference(groupGatedSubscriptions(subscribedEvents), effectiveWithoutSubscription.events).length > 0) {
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
