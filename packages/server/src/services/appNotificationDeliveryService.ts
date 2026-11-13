import { createHmac, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import {
  appNotificationEventSpec,
  clearClockInterval,
  clearClockTimeout,
  currentDate,
  noopTracer,
  setClockInterval,
  setClockTimeout,
  type AppNotificationSubjectType,
  type Tracer,
} from "@botiverse/raft-shared";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { afterAmbientTransaction } from "../db/ambientTransaction";
import { addTraceEvent, withTraceRoot } from "../tracing/semanticTrace";
import {
  agents,
  channels,
  computers,
  notificationDeliveries,
  notificationDeliveryAttempts,
  notificationEvents,
  notificationRecipients,
  oauthAccessTokens,
  oauthAppWebhookConfigs,
  oauthClientInstalls,
  oauthClients,
  servers,
} from "../db/schema";
import {
  APP_OUTBOUND_EVENT_GROUPS,
  appOutboundEventRequiredGroups,
  computeEffectiveAppOutboundAuthority,
  type AppInstallationEventType,
  type AppOutboundEventType,
  type AppOutboundGroup,
} from "./appOutboundPermissionService";
import {
  AppWebhookConfigError,
  decryptAppWebhookSigningSecret,
  isPublicWebhookAddress,
} from "./appWebhookConfigService";
import { oauthClientIsUserManagedPredicate } from "./oauthClientManagementPolicy";
import { deriveAppMemberRef } from "./appOutboundProjectionService";
import { agentFindableBy } from "./agentMemberListPolicy";
import { responseRequestId } from "./externalRequestCorrelation";

const DELIVERY_LOCK_TIMEOUT_MS = 2 * 60 * 1000;
const DELIVERY_TIMEOUT_MS = 10_000;
const DELIVERY_BATCH_SIZE = 25;
const MAX_DELIVERY_ATTEMPTS = 6;
// The first retry is short: membership events drive access suspension in the
// receiving app, so a single transient failure should not cost a minute.
const RETRY_DELAYS_MS = [10_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];
const SAFE_PROVENANCE_KEYS = new Set([
  "actor_type",
  "source",
  "changed_fields",
  "principal_type",
  "reason",
  "role",
  "previous_role",
  "outage_occurrence_id",
  "recovery_for_event_id",
]);
const SAFE_UUID_PROVENANCE_KEYS = new Set(["outage_occurrence_id", "recovery_for_event_id"]);

export type WebhookPost = (input: {
  endpointUrl: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
}) => Promise<WebhookPostResponse>;

/** `requestId`: the receiver's own request id header, when it sent one (see externalRequestCorrelation). */
/**
 * Where the POST's time went, in ms from the start of the call (DNS lookup
 * included). connect/tls are absent when an idle keep-alive socket was reused.
 */
export type WebhookPostTiming = {
  dnsMs: number;
  connectMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
  socketReused: boolean;
};
export type WebhookPostResponse = { status: number; retryAfter?: string; requestId?: string; timing?: WebhookPostTiming };

type PinnedLookupAddress = { address: string; family: number };
type PinnedLookupCallback = (
  error: Error | null,
  address: string | PinnedLookupAddress[],
  family?: number,
) => void;

let scheduledDrain: (() => void) | null = null;

export class AppNotificationDeliveryError extends Error {}

/**
 * A POST that failed after it started, with the phases that completed first.
 * A timeout records where it stopped: before the connection was up (TCP or
 * TLS never finished) or while waiting for the response's first byte. Without
 * this a receiver that accepts the connection and then never answers looks
 * exactly like one that cannot be reached. The phase goes to traces only: the
 * error code stays `timeout`, because external agents read it as `lastError`.
 */
export class WebhookPostError extends Error {
  constructor(
    readonly original: unknown,
    readonly timing: WebhookPostTiming,
    readonly timeoutPhase: "connect" | "response" | null,
  ) {
    super(original instanceof Error ? original.message : String(original));
    this.name = "WebhookPostError";
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, 500);
}

export function appWebhookDeliveryErrorCode(error: unknown): string {
  if (error instanceof WebhookPostError) {
    return error.timeoutPhase ? "timeout" : appWebhookDeliveryErrorCode(error.original);
  }
  if (error instanceof AppNotificationDeliveryError) return "ssrf_blocked";
  if (error instanceof AppWebhookConfigError) return "configuration_error";
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code).toUpperCase()
    : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns_error";
  if (code.startsWith("CERT_") || code.startsWith("ERR_TLS")
    || code.startsWith("DEPTH_") || code.startsWith("UNABLE_TO_VERIFY")) return "tls_error";
  if (code === "ETIMEDOUT" || message.includes("timed out")) return "timeout";
  return "network_error";
}

function sanitizeProvenance(raw: Record<string, unknown> | undefined): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!SAFE_PROVENANCE_KEYS.has(key)) continue;
    if (key === "changed_fields") {
      if (Array.isArray(value) && value.every((item) => typeof item === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(item))) {
        safe[key] = [...new Set(value)].sort();
      }
      continue;
    }
    if (SAFE_UUID_PROVENANCE_KEYS.has(key)) {
      if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
        safe[key] = value.toLowerCase();
      }
      continue;
    }
    if (typeof value === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(value)) safe[key] = value;
  }
  return safe;
}

function includesAll(haystack: readonly string[], needles: readonly string[]): boolean {
  const values = new Set(haystack);
  return needles.every((value) => values.has(value));
}

export function createAppWebhookPinnedLookup(pinned: PinnedLookupAddress) {
  return (
    _hostname: string,
    options: number | { all?: boolean },
    callback: PinnedLookupCallback,
  ) => {
    if (typeof options === "object" && options.all) {
      callback(null, [pinned]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

/**
 * Which of these agent ids are personal assistants. An assistant is found only
 * by its owner (agentFindableBy), so no App is told it exists: no member event
 * and no agent event names one. The row keeps its owner after deletion, so
 * this holds for a removal too.
 */
async function personalAssistantIdsAmong(agentIds: readonly string[], executor: DatabaseExecutor): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const rows = await executor.select({ id: agents.id }).from(agents)
    .where(and(inArray(agents.id, [...agentIds]), sql`not ${agentFindableBy({})}`));
  return new Set(rows.map((row) => row.id));
}

async function eventSubjectIsVisible(input: {
  serverId: string;
  subjectType: string;
  subjectId: string | null;
  groups: readonly AppOutboundGroup[];
  provenance?: Record<string, unknown>;
}, executor: DatabaseExecutor): Promise<boolean> {
  if (!input.subjectId) return false;
  if (input.subjectType === "member") {
    // The member is gone by the time a removal is delivered, so visibility is
    // the Server's, not the principal's. A Server deletion announces its
    // members' removal after the tombstone is set.
    if (!input.groups.includes("server")) return false;
    const [row] = await executor.select({ id: servers.id }).from(servers)
      .where(input.provenance?.reason === "server_deleted"
        ? eq(servers.id, input.serverId)
        : and(eq(servers.id, input.serverId), isNull(servers.deletedAt)))
      .limit(1);
    if (!row) return false;
    // At delivery: an event about an agent member is never about a personal assistant.
    if (input.provenance?.principal_type === "agent") {
      return (await personalAssistantIdsAmong([input.subjectId], executor)).size === 0;
    }
    return true;
  }
  if (input.subjectType === "server") {
    if (!input.groups.includes("server") || input.subjectId !== input.serverId) return false;
    const [row] = await executor.select({ id: servers.id }).from(servers)
      .where(and(eq(servers.id, input.subjectId), isNull(servers.deletedAt))).limit(1);
    return !!row;
  }
  if (input.subjectType === "agent") {
    if (!input.groups.includes("agent")) return false;
    // A personal assistant is found only by its owner (agentFindableBy): never by an App.
    const [row] = await executor.select({ id: agents.id }).from(agents)
      .where(and(
        eq(agents.id, input.subjectId),
        eq(agents.serverId, input.serverId),
        isNull(agents.deletedAt),
        agentFindableBy({}),
      )).limit(1);
    return !!row;
  }
  if (input.subjectType === "channel") {
    if (!input.groups.includes("channel")) return false;
    const [row] = await executor.select({ id: channels.id }).from(channels)
      .where(and(
        eq(channels.id, input.subjectId),
        eq(channels.serverId, input.serverId),
        eq(channels.type, "channel"),
        isNull(channels.deletedAt),
      )).limit(1);
    return !!row;
  }
  if (input.subjectType === "computer") {
    if (!input.groups.includes("computer")) return false;
    const [row] = await executor.select({ id: computers.id }).from(computers)
      .where(and(
        eq(computers.id, input.subjectId),
        eq(computers.serverId, input.serverId),
        isNull(computers.revokedAt),
      )).limit(1);
    return !!row;
  }
  return false;
}

/**
 * Emit a group-gated event to every eligible installation on the Server. An
 * installation's own event never goes through here: its type is not in
 * APP_OUTBOUND_EVENT_GROUPS, and its subject is not one of these
 * (emitAppInstallationNotificationEvent is its only emitter).
 */
export async function emitAppFacingNotificationEvent(input: {
  id?: string;
  serverId: string;
  eventType: AppOutboundEventType;
  subjectType: Exclude<AppNotificationSubjectType, "member" | "installation">;
  subjectId: string;
  occurredAt?: Date;
  provenance?: Record<string, unknown>;
}, executor: DatabaseExecutor = getDb()): Promise<{ eventId: string; recipientCount: number }> {
  if (!Object.prototype.hasOwnProperty.call(APP_OUTBOUND_EVENT_GROUPS, input.eventType)) {
    throw new AppNotificationDeliveryError("Unknown app-facing event type");
  }
  if (appNotificationEventSpec(input.eventType)?.subject !== input.subjectType) {
    throw new AppNotificationDeliveryError("Event subject does not match its event type");
  }
  const requiredGroups = appOutboundEventRequiredGroups(input.eventType);
  const provenance = sanitizeProvenance(input.provenance);
  if (!await eventSubjectIsVisible({
    serverId: input.serverId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    groups: requiredGroups,
    provenance,
  }, executor)) {
    return { eventId: input.id ?? "", recipientCount: 0 };
  }

  const [created] = await executor.insert(notificationEvents).values({
    ...(input.id ? { id: input.id } : {}),
    serverId: input.serverId,
    eventType: input.eventType,
    requiredGroups,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    provenance,
    occurredAt: input.occurredAt ?? currentDate(),
  }).onConflictDoNothing().returning({ id: notificationEvents.id });
  const eventId = created?.id ?? input.id;
  if (!eventId) throw new AppNotificationDeliveryError("Event id collision without caller-supplied id");
  if (!created) return { eventId, recipientCount: 0 };

  let recipientCount = 0;
  for (const candidate of await eligibleRecipientInstallations(input.serverId, input.eventType, executor)) {
    const [recipient] = await executor.insert(notificationRecipients).values({
      eventId,
      serverId: input.serverId,
      recipientType: "app_installation",
      recipientId: candidate.installation.id,
    }).onConflictDoNothing().returning({ id: notificationRecipients.id });
    if (!recipient) continue;
    await executor.insert(notificationDeliveries).values({
      notificationId: recipient.id,
      adapter: "webhook",
      configRevision: candidate.configRevision,
      grantRevision: candidate.installation.grantRevision,
      subscriptionRevision: candidate.installation.subscriptionRevision,
    }).onConflictDoNothing();
    recipientCount += 1;
  }
  // After commit: started inside the caller's transaction the drain claimed
  // uncommitted deliveries through it and could post webhooks before commit.
  if (recipientCount > 0) afterAmbientTransaction(() => scheduledDrain?.());
  return { eventId, recipientCount };
}

/**
 * Emit an event about one App installation, to that installation only (the
 * App that owns it), in the caller's transaction. There is no recipient
 * parameter: the subject and the only possible recipient are the same row, so
 * an installation event can never reach another App. It needs no
 * installer-approved group; the installation receives it while it is active,
 * subscribed to the event and has an enabled webhook. The event row is written
 * either way, so a committed change always has its event and a rolled-back
 * one never does.
 */
export async function emitAppInstallationNotificationEvent(input: {
  eventType: AppInstallationEventType;
  installation: { id: string; serverId: string };
  occurredAt?: Date;
  provenance?: Record<string, unknown>;
}, executor: DatabaseExecutor = getDb()): Promise<{ eventId: string; recipientCount: number }> {
  if (appNotificationEventSpec(input.eventType)?.subject !== "installation") {
    throw new AppNotificationDeliveryError("Not an installation event type");
  }
  const [created] = await executor.insert(notificationEvents).values({
    serverId: input.installation.serverId,
    eventType: input.eventType,
    requiredGroups: [],
    subjectType: "installation",
    subjectId: input.installation.id,
    provenance: sanitizeProvenance(input.provenance),
    occurredAt: input.occurredAt ?? currentDate(),
  }).returning({ id: notificationEvents.id });
  if (!created) throw new AppNotificationDeliveryError("Event insert returned no row");

  const [candidate] = await executor.select({
    installation: oauthClientInstalls,
    configRevision: oauthAppWebhookConfigs.revision,
  }).from(oauthClientInstalls)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
    .innerJoin(oauthAppWebhookConfigs, eq(oauthAppWebhookConfigs.clientId, oauthClients.id))
    .where(and(
      eq(oauthClientInstalls.id, input.installation.id),
      eq(oauthClientInstalls.serverId, input.installation.serverId),
      eq(oauthClientInstalls.status, "active"),
      eq(oauthClients.enabled, true),
      oauthClientIsUserManagedPredicate(),
      eq(oauthAppWebhookConfigs.enabled, true),
    ))
    .limit(1);
  if (!candidate || !candidate.installation.subscribedEvents.includes(input.eventType)) {
    return { eventId: created.id, recipientCount: 0 };
  }
  const [recipient] = await executor.insert(notificationRecipients).values({
    eventId: created.id,
    serverId: input.installation.serverId,
    recipientType: "app_installation",
    recipientId: candidate.installation.id,
  }).returning({ id: notificationRecipients.id });
  await executor.insert(notificationDeliveries).values({
    notificationId: recipient!.id,
    adapter: "webhook",
    configRevision: candidate.configRevision,
    grantRevision: candidate.installation.grantRevision,
    subscriptionRevision: candidate.installation.subscriptionRevision,
  });
  afterAmbientTransaction(() => scheduledDrain?.());
  return { eventId: created.id, recipientCount: 1 };
}

async function eligibleRecipientInstallations(
  serverId: string,
  eventType: AppOutboundEventType,
  executor: DatabaseExecutor,
) {
  const requiredGroups = appOutboundEventRequiredGroups(eventType);
  const candidates = await executor.select({
    installation: oauthClientInstalls,
    currentGroups: oauthClients.outboundCurrentGroups,
    currentEvents: oauthClients.outboundCurrentEvents,
    configRevision: oauthAppWebhookConfigs.revision,
  }).from(oauthClientInstalls)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
    .innerJoin(oauthAppWebhookConfigs, eq(oauthAppWebhookConfigs.clientId, oauthClients.id))
    .where(and(
      eq(oauthClientInstalls.serverId, serverId),
      eq(oauthClientInstalls.status, "active"),
      eq(oauthClients.enabled, true),
      oauthClientIsUserManagedPredicate(),
      eq(oauthAppWebhookConfigs.enabled, true),
    ));
  return candidates.filter((candidate) => {
    const effective = computeEffectiveAppOutboundAuthority({
      currentGroups: candidate.currentGroups,
      currentEvents: candidate.currentEvents,
      approvedGroups: candidate.installation.approvedGroups,
      subscribedEvents: candidate.installation.subscribedEvents,
    });
    return effective.events.includes(eventType) && includesAll(effective.groups, requiredGroups);
  });
}

export type AppFacingMemberEventType = "server.member_added" | "server.member_removed" | "server.member_role_changed";
export type AppFacingMember = { principalType: "human" | "agent"; principalId: string; role: string };

const MEMBER_EVENT_INSERT_CHUNK = 500;

/**
 * Emit one membership event per member, in the caller's transaction (the
 * outbox). Installations are resolved once, so announcing every member of a
 * deleted Server stays a few bulk inserts. When no installation subscribes,
 * nothing is written. Call kickAppNotificationDelivery() after commit.
 */
export async function emitAppFacingMemberEvents(input: {
  serverId: string;
  eventType: AppFacingMemberEventType;
  members: readonly AppFacingMember[];
  occurredAt?: Date;
  provenance: Record<string, unknown>;
}, executor: DatabaseExecutor = getDb()): Promise<{ eventCount: number; recipientCount: number }> {
  const assistants = await personalAssistantIdsAmong(
    input.members.filter((member) => member.principalType === "agent").map((member) => member.principalId),
    executor,
  );
  const members = input.members.filter((member) => !(member.principalType === "agent" && assistants.has(member.principalId)));
  if (members.length === 0) return { eventCount: 0, recipientCount: 0 };
  const requiredGroups = appOutboundEventRequiredGroups(input.eventType);
  const subjectType = appNotificationEventSpec(input.eventType)?.subject;
  if (subjectType !== "member") throw new AppNotificationDeliveryError("Not a member event type");
  const baseProvenance = sanitizeProvenance(input.provenance);
  if (!await eventSubjectIsVisible({
    serverId: input.serverId,
    subjectType,
    subjectId: input.serverId,
    groups: requiredGroups,
    provenance: baseProvenance,
  }, executor)) return { eventCount: 0, recipientCount: 0 };
  const recipients = await eligibleRecipientInstallations(input.serverId, input.eventType, executor);
  if (recipients.length === 0) return { eventCount: 0, recipientCount: 0 };

  const occurredAt = input.occurredAt ?? currentDate();
  let recipientCount = 0;
  for (let offset = 0; offset < members.length; offset += MEMBER_EVENT_INSERT_CHUNK) {
    const chunk = members.slice(offset, offset + MEMBER_EVENT_INSERT_CHUNK);
    const events = chunk.map((member) => ({
      id: randomUUID(),
      serverId: input.serverId,
      eventType: input.eventType,
      requiredGroups,
      subjectType,
      subjectId: member.principalId,
      provenance: sanitizeProvenance({
        ...baseProvenance,
        principal_type: member.principalType,
        role: member.role,
      }),
      occurredAt,
    }));
    await executor.insert(notificationEvents).values(events);
    const recipientRows = events.flatMap((event) => recipients.map((candidate) => ({
      id: randomUUID(),
      eventId: event.id,
      serverId: input.serverId,
      recipientType: "app_installation" as const,
      recipientId: candidate.installation.id,
      candidate,
    })));
    await executor.insert(notificationRecipients).values(recipientRows.map(({ candidate: _candidate, ...row }) => row));
    await executor.insert(notificationDeliveries).values(recipientRows.map(({ id, candidate }) => ({
      notificationId: id,
      adapter: "webhook" as const,
      configRevision: candidate.configRevision,
      grantRevision: candidate.installation.grantRevision,
      subscriptionRevision: candidate.installation.subscriptionRevision,
    })));
    recipientCount += recipientRows.length;
  }
  return { eventCount: members.length, recipientCount };
}

/**
 * Start a drain now. Emits run inside the caller's transaction, so a drain
 * started from there can run before commit and find nothing; callers that
 * need prompt delivery call this after commit. The poll is the fallback.
 */
export function kickAppNotificationDelivery(): void {
  scheduledDrain?.();
}

/**
 * Render an event subject for one installation. A member is identified by the
 * installation-scoped member_ref. `sub` is added only when this principal has
 * already signed in to this same app on this same Server, and it is exactly
 * the `sub` that app received then (RFC 051 amendment, 2026-10-05): it tells
 * the app nothing it does not already know.
 */
async function renderEventSubject(
  event: typeof notificationEvents.$inferSelect,
  installation: typeof oauthClientInstalls.$inferSelect,
  executor: DatabaseExecutor,
): Promise<Record<string, unknown>> {
  if (event.subjectType !== "member" || !event.subjectId) {
    return { type: event.subjectType, id: event.subjectId };
  }
  const principalType = event.provenance.principal_type === "agent" ? "agent" : "human";
  // Any token ever issued counts, expired or revoked included, on purpose: a
  // removal revokes the member's tokens in the same commit, and the App still
  // needs `sub` to know whose access to suspend. Do not add `revokedAt IS
  // NULL`. If expired tokens are ever pruned, keep a separate record of which
  // principal signed in to which App first, or early sign-ins lose `sub`.
  const [signedIn] = await executor.select({ id: oauthAccessTokens.id }).from(oauthAccessTokens)
    .where(and(
      eq(oauthAccessTokens.clientId, installation.clientId),
      eq(oauthAccessTokens.serverId, installation.serverId),
      eq(oauthAccessTokens.principalType, principalType),
      principalType === "agent"
        ? eq(oauthAccessTokens.agentId, event.subjectId)
        : eq(oauthAccessTokens.userId, event.subjectId),
    )).limit(1);
  return {
    type: "member",
    principal_type: principalType,
    ...deriveAppMemberRef({
      clientId: installation.clientId,
      installationId: installation.id,
      principalId: event.subjectId,
    }),
    ...(signedIn ? { sub: event.subjectId } : {}),
  };
}

/**
 * An event's `data`, rendered for the installation at send time. Only
 * `installation.bot_changed` has any: the bot's state when the delivery is
 * sent (the lookup's mapping), so a retry or a late delivery never reports a
 * state the installation has since left.
 */
async function renderEventData(
  event: typeof notificationEvents.$inferSelect,
  installation: typeof oauthClientInstalls.$inferSelect,
  executor: DatabaseExecutor,
): Promise<Record<string, unknown> | null> {
  if (event.eventType !== "installation.bot_changed") return null;
  // Dynamic: appBotIdentityService emits through this module.
  const { readInstallationBotChangedData } = await import("./appBotIdentityService");
  return readInstallationBotChangedData(executor, installation.id);
}

/**
 * POST to a public HTTPS endpoint: DNS-pinned to a public address, no
 * redirects, TLS verified. Shared by app webhooks and the agent inbox push.
 */
export async function postPublicHttps(input: Parameters<WebhookPost>[0]): Promise<WebhookPostResponse> {
  const url = new URL(input.endpointUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const startedAt = performance.now();
  const sinceStart = () => Math.round(performance.now() - startedAt);
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  const timing: WebhookPostTiming = { dnsMs: sinceStart(), socketReused: false };
  if (addresses.length === 0 || addresses.some((entry) => !isPublicWebhookAddress(entry.address))) {
    throw new AppNotificationDeliveryError("Webhook host resolved to a private or special-use address");
  }
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: "https:",
      hostname,
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: input.headers,
      servername: hostname,
      rejectUnauthorized: true,
      lookup: createAppWebhookPinnedLookup(pinned) as never,
    }, (response) => {
      timing.ttfbMs = sinceStart();
      response.resume();
      const retryAfter = response.headers["retry-after"];
      const requestId = responseRequestId((name) => {
        const value = response.headers[name];
        return typeof value === "string" ? value : undefined;
      });
      resolve({
        status: response.statusCode ?? 0,
        ...(typeof retryAfter === "string" ? { retryAfter } : {}),
        ...(requestId ? { requestId } : {}),
        timing,
      });
    });
    let timedOut = false;
    const timeout = setClockTimeout(() => {
      timedOut = true;
      request.destroy(new Error("Webhook request timed out"));
    }, input.timeoutMs);
    request.once("close", () => clearClockTimeout(timeout));
    request.on("socket", (socket) => {
      // A reused keep-alive socket is already connected: no connect/TLS phase.
      timing.socketReused = !socket.connecting;
      socket.once("connect", () => { timing.connectMs = sinceStart(); });
      socket.once("secureConnect", () => { timing.tlsMs = sinceStart(); });
      socket.once("connect", () => {
        if (!socket.remoteAddress || !isPublicWebhookAddress(socket.remoteAddress)) {
          request.destroy(new Error("Webhook connection reached a non-public address"));
        }
      });
    });
    request.on("error", (error) => {
      // Connected means TLS finished, or a kept-alive socket was reused.
      const connected = timing.tlsMs !== undefined || timing.socketReused;
      reject(new WebhookPostError(error, { ...timing }, timedOut ? (connected ? "response" : "connect") : null));
    });
    request.end(input.body);
  });
}

export function appWebhookDeliveryOutcomeForStatus(status: number, attemptNumber: number): "delivered" | "retry" | "dead_lettered" {
  if (status >= 200 && status < 300) return "delivered";
  const retryable = status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
  if (retryable && attemptNumber < MAX_DELIVERY_ATTEMPTS) return "retry";
  return "dead_lettered";
}

async function finishDeliveryAttempt(input: {
  deliveryId: string;
  attemptNumber: number;
  configRevision: number;
  outcome: "delivered" | "retry" | "suppressed" | "dead_lettered";
  httpStatus?: number | null;
  errorCode?: string | null;
  now: Date;
}, executor: DatabaseExecutor) {
  await executor.insert(notificationDeliveryAttempts).values({
    deliveryId: input.deliveryId,
    attemptNumber: input.attemptNumber,
    configRevision: input.configRevision,
    httpStatus: input.httpStatus ?? null,
    outcome: input.outcome,
    errorCode: input.errorCode?.slice(0, 100) ?? null,
  }).onConflictDoNothing();
  const terminal = input.outcome !== "retry";
  const nextAttemptAt = input.outcome === "retry"
    ? new Date(input.now.getTime() + RETRY_DELAYS_MS[Math.min(input.attemptNumber - 1, RETRY_DELAYS_MS.length - 1)])
    : input.now;
  await executor.update(notificationDeliveries).set({
    status: input.outcome === "retry" ? "pending" : input.outcome,
    configRevision: input.configRevision,
    nextAttemptAt,
    lockedAt: null,
    lastAttemptAt: input.now,
    deliveredAt: input.outcome === "delivered" ? input.now : null,
    terminalReason: terminal && input.outcome !== "delivered" ? (input.errorCode ?? input.outcome) : null,
    lastError: input.outcome === "retry" || input.outcome === "dead_lettered" ? input.errorCode ?? null : null,
    updatedAt: input.now,
  }).where(and(
    eq(notificationDeliveries.id, input.deliveryId),
    eq(notificationDeliveries.attemptCount, input.attemptNumber),
  ));
}

export async function drainAppNotificationDeliveries(input: {
  batchSize?: number;
  executor?: DatabaseExecutor;
  post?: WebhookPost;
  now?: Date;
} = {}): Promise<{ claimed: number; delivered: number; retried: number; suppressed: number; deadLettered: number }> {
  const executor = input.executor ?? getDb();
  const now = input.now ?? currentDate();
  const staleLockedAt = new Date(now.getTime() - DELIVERY_LOCK_TIMEOUT_MS);
  const candidates = await executor.select({ id: notificationDeliveries.id })
    .from(notificationDeliveries)
    .where(and(
      lte(notificationDeliveries.nextAttemptAt, now),
      or(
        eq(notificationDeliveries.status, "pending"),
        and(eq(notificationDeliveries.status, "processing"), lt(notificationDeliveries.lockedAt, staleLockedAt)),
      ),
    ))
    .orderBy(asc(notificationDeliveries.nextAttemptAt))
    .limit(input.batchSize ?? DELIVERY_BATCH_SIZE);
  const summary = { claimed: 0, delivered: 0, retried: 0, suppressed: 0, deadLettered: 0 };

  for (const candidate of candidates) {
    const [claimed] = await executor.update(notificationDeliveries).set({
      status: "processing",
      lockedAt: now,
      attemptCount: sql`${notificationDeliveries.attemptCount} + 1`,
      updatedAt: now,
    }).where(and(
      eq(notificationDeliveries.id, candidate.id),
      lte(notificationDeliveries.nextAttemptAt, now),
      or(
        eq(notificationDeliveries.status, "pending"),
        and(eq(notificationDeliveries.status, "processing"), lt(notificationDeliveries.lockedAt, staleLockedAt)),
      ),
    )).returning();
    if (!claimed) continue;
    summary.claimed += 1;

    const [base] = await executor.select({
      notification: notificationRecipients,
      event: notificationEvents,
    }).from(notificationRecipients)
      .innerJoin(notificationEvents, eq(notificationEvents.id, notificationRecipients.eventId))
      .where(eq(notificationRecipients.id, claimed.notificationId)).limit(1);
    const [authority] = base ? await executor.select({
      installation: oauthClientInstalls,
      clientEnabled: oauthClients.enabled,
      currentGroups: oauthClients.outboundCurrentGroups,
      currentEvents: oauthClients.outboundCurrentEvents,
      config: oauthAppWebhookConfigs,
    }).from(oauthClientInstalls)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
      .innerJoin(oauthAppWebhookConfigs, eq(oauthAppWebhookConfigs.clientId, oauthClients.id))
      .where(and(
        eq(oauthClientInstalls.id, base.notification.recipientId),
        oauthClientIsUserManagedPredicate(),
      )).limit(1) : [];

    const attemptNumber = claimed.attemptCount;
    if (!base || !authority || authority.installation.status !== "active" || !authority.clientEnabled || !authority.config.enabled
      || base.event.serverId !== authority.installation.serverId || base.notification.serverId !== authority.installation.serverId) {
      await finishDeliveryAttempt({
        deliveryId: claimed.id,
        attemptNumber,
        configRevision: authority?.config.revision ?? claimed.configRevision,
        outcome: "suppressed",
        errorCode: "authority_inactive",
        now,
      }, executor);
      summary.suppressed += 1;
      continue;
    }

    const effective = computeEffectiveAppOutboundAuthority({
      currentGroups: authority.currentGroups,
      currentEvents: authority.currentEvents,
      approvedGroups: authority.installation.approvedGroups,
      subscribedEvents: authority.installation.subscribedEvents,
    });
    // The row's subject must be the one its event type is registered with, so
    // a row can't borrow the installation subject to skip groups. An
    // installation event goes only to the installation it is about.
    const spec = appNotificationEventSpec(base.event.eventType);
    const eligible = !!spec && spec.subject === base.event.subjectType && (
      spec.subject === "installation"
        ? base.event.subjectId === authority.installation.id
          && base.notification.recipientId === authority.installation.id
          && authority.installation.subscribedEvents.includes(base.event.eventType)
        : effective.events.includes(base.event.eventType as AppOutboundEventType)
          && includesAll(effective.groups, base.event.requiredGroups)
          && await eventSubjectIsVisible({
            serverId: base.event.serverId,
            subjectType: base.event.subjectType,
            subjectId: base.event.subjectId,
            groups: effective.groups,
            provenance: base.event.provenance,
          }, executor)
    );
    if (!eligible) {
      await finishDeliveryAttempt({
        deliveryId: claimed.id,
        attemptNumber,
        configRevision: authority.config.revision,
        outcome: "suppressed",
        errorCode: "authority_or_visibility_changed",
        now,
      }, executor);
      summary.suppressed += 1;
      continue;
    }

    const timestamp = Math.floor(now.getTime() / 1000).toString();
    let status = 0;
    let errorCode: string | null = null;
    let timing: WebhookPostTiming | undefined;
    let timeoutPhase: WebhookPostError["timeoutPhase"] = null;
    try {
      const data = await renderEventData(base.event, authority.installation, executor);
      const body = JSON.stringify({
        installation_id: authority.installation.id,
        delivery_id: claimed.id,
        attempt: attemptNumber,
        event: {
          id: base.event.id,
          type: base.event.eventType,
          server_id: base.event.serverId,
          occurred_at: base.event.occurredAt.toISOString(),
          subject: await renderEventSubject(base.event, authority.installation, executor),
          provenance: base.event.provenance,
          ...(data ? { data } : {}),
        },
      });
      const secret = decryptAppWebhookSigningSecret(authority.config, claimed.configRevision, now);
      const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
      const response = await (input.post ?? postPublicHttps)({
        endpointUrl: authority.config.endpointUrl,
        body,
        timeoutMs: DELIVERY_TIMEOUT_MS,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body).toString(),
          "user-agent": "Raft-App-Webhook/1.0",
          "x-raft-delivery": claimed.id,
          "x-raft-timestamp": timestamp,
          "x-raft-signature": `v1=${signature}`,
        },
      });
      status = response.status;
      timing = response.timing;
      if (!(status >= 200 && status < 300)) errorCode = `http_${status || "invalid"}`;
    } catch (error) {
      errorCode = appWebhookDeliveryErrorCode(error);
      if (error instanceof WebhookPostError) {
        timing = error.timing;
        timeoutPhase = error.timeoutPhase;
      }
    }
    const outcome = appWebhookDeliveryOutcomeForStatus(status, attemptNumber);
    // One event per attempt on the drain span: the outcome and, when the POST
    // started, where its time went (connect/TLS kept on a timeout).
    addTraceEvent("app_webhook.delivery.attempted", {
      outcome,
      attempt: attemptNumber,
      http_status: status || null,
      error_code: errorCode,
      "webhook.timeout_phase": timeoutPhase,
      ...(timing ? {
        "webhook.dns_ms": timing.dnsMs,
        "webhook.connect_ms": timing.connectMs ?? null,
        "webhook.tls_ms": timing.tlsMs ?? null,
        "webhook.ttfb_ms": timing.ttfbMs ?? null,
        "webhook.socket_reused": timing.socketReused,
      } : {}),
    });
    await finishDeliveryAttempt({
      deliveryId: claimed.id,
      attemptNumber,
      configRevision: authority.config.revision,
      outcome,
      httpStatus: status || null,
      errorCode,
      now,
    }, executor);
    if (outcome === "delivered") summary.delivered += 1;
    else if (outcome === "retry") summary.retried += 1;
    else summary.deadLettered += 1;
  }
  return summary;
}

export function startAppNotificationDeliveryWorker(input: {
  intervalMs?: number;
  batchSize?: number;
  scheduleEvery?: (fn: () => void, intervalMs: number) => unknown;
  clear?: (handle: unknown) => void;
  tracer?: Tracer;
} = {}) {
  const intervalMs = input.intervalMs ?? 15_000;
  const batchSize = input.batchSize ?? DELIVERY_BATCH_SIZE;
  const tracer = input.tracer ?? noopTracer;
  const run = () => {
    // Each drain is a root span. A failure also records the
    // `server.app_notification_delivery.error` event inside it.
    withTraceRoot(
      tracer,
      "server.app_notification_delivery.drain",
      { surface: "server", kind: "internal", attrs: { batch_size: batchSize } },
      () => drainAppNotificationDeliveries({ batchSize }),
      "server.app_notification_delivery.error",
    ).catch((error) => {
      console.error("[AppNotificationDelivery] drain failed", boundedError(error));
    });
  };
  scheduledDrain = run;
  run();
  const handle = (input.scheduleEvery ?? setClockInterval)(run, intervalMs);
  if (typeof handle === "object" && handle && "unref" in handle && typeof handle.unref === "function") handle.unref();
  return {
    stop() {
      scheduledDrain = null;
      (input.clear ?? clearClockInterval)(handle);
    },
  };
}
