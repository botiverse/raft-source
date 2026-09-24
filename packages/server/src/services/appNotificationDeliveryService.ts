import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import {
  clearClockInterval,
  clearClockTimeout,
  currentDate,
  setClockInterval,
  setClockTimeout,
} from "@botiverse/raft-shared";
import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index.js";
import {
  agents,
  channels,
  computers,
  notificationDeliveries,
  notificationDeliveryAttempts,
  notificationEvents,
  notificationRecipients,
  oauthAppWebhookConfigs,
  oauthClientInstalls,
  oauthClients,
  servers,
} from "../db/schema.js";
import {
  APP_OUTBOUND_EVENT_GROUPS,
  appOutboundEventRequiredGroups,
  computeEffectiveAppOutboundAuthority,
  type AppOutboundEventType,
  type AppOutboundGroup,
} from "./appOutboundPermissionService.js";
import {
  AppWebhookConfigError,
  decryptAppWebhookSigningSecret,
  isPublicWebhookAddress,
} from "./appWebhookConfigService.js";

const DELIVERY_LOCK_TIMEOUT_MS = 2 * 60 * 1000;
const DELIVERY_TIMEOUT_MS = 10_000;
const DELIVERY_BATCH_SIZE = 25;
const MAX_DELIVERY_ATTEMPTS = 6;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];
const SAFE_PROVENANCE_KEYS = new Set([
  "actor_type",
  "source",
  "changed_fields",
  "outage_occurrence_id",
  "recovery_for_event_id",
]);
const SAFE_UUID_PROVENANCE_KEYS = new Set(["outage_occurrence_id", "recovery_for_event_id"]);

type WebhookPost = (input: {
  endpointUrl: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
}) => Promise<{ status: number }>;

type PinnedLookupAddress = { address: string; family: number };
type PinnedLookupCallback = (
  error: Error | null,
  address: string | PinnedLookupAddress[],
  family?: number,
) => void;

let scheduledDrain: (() => void) | null = null;

export class AppNotificationDeliveryError extends Error {}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, 500);
}

export function appWebhookDeliveryErrorCode(error: unknown): string {
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

async function eventSubjectIsVisible(input: {
  serverId: string;
  subjectType: string;
  subjectId: string | null;
  groups: readonly AppOutboundGroup[];
}, executor: DatabaseExecutor): Promise<boolean> {
  if (!input.subjectId) return false;
  if (input.subjectType === "server") {
    if (!input.groups.includes("server") || input.subjectId !== input.serverId) return false;
    const [row] = await executor.select({ id: servers.id }).from(servers)
      .where(and(eq(servers.id, input.subjectId), isNull(servers.deletedAt))).limit(1);
    return !!row;
  }
  if (input.subjectType === "agent") {
    if (!input.groups.includes("agent")) return false;
    const [row] = await executor.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, input.subjectId), eq(agents.serverId, input.serverId), isNull(agents.deletedAt))).limit(1);
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

export async function emitAppFacingNotificationEvent(input: {
  id?: string;
  serverId: string;
  eventType: AppOutboundEventType;
  subjectType: "server" | "agent" | "channel" | "computer";
  subjectId: string;
  occurredAt?: Date;
  provenance?: Record<string, unknown>;
}, executor: DatabaseExecutor = getDb()): Promise<{ eventId: string; recipientCount: number }> {
  if (!(input.eventType in APP_OUTBOUND_EVENT_GROUPS)) {
    throw new AppNotificationDeliveryError("Unknown app-facing event type");
  }
  const requiredGroups = appOutboundEventRequiredGroups(input.eventType);
  if (!await eventSubjectIsVisible({
    serverId: input.serverId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    groups: requiredGroups,
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
    provenance: sanitizeProvenance(input.provenance),
    occurredAt: input.occurredAt ?? currentDate(),
  }).onConflictDoNothing().returning({ id: notificationEvents.id });
  const eventId = created?.id ?? input.id;
  if (!eventId) throw new AppNotificationDeliveryError("Event id collision without caller-supplied id");
  if (!created) return { eventId, recipientCount: 0 };

  const candidates = await executor.select({
    installation: oauthClientInstalls,
    currentGroups: oauthClients.outboundCurrentGroups,
    currentEvents: oauthClients.outboundCurrentEvents,
    configRevision: oauthAppWebhookConfigs.revision,
  }).from(oauthClientInstalls)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
    .innerJoin(oauthAppWebhookConfigs, eq(oauthAppWebhookConfigs.clientId, oauthClients.id))
    .where(and(
      eq(oauthClientInstalls.serverId, input.serverId),
      eq(oauthClientInstalls.status, "active"),
      eq(oauthClients.enabled, true),
      eq(oauthAppWebhookConfigs.enabled, true),
    ));

  let recipientCount = 0;
  for (const candidate of candidates) {
    const effective = computeEffectiveAppOutboundAuthority({
      currentGroups: candidate.currentGroups,
      currentEvents: candidate.currentEvents,
      approvedGroups: candidate.installation.approvedGroups,
      subscribedEvents: candidate.installation.subscribedEvents,
    });
    if (!effective.events.includes(input.eventType) || !includesAll(effective.groups, requiredGroups)) continue;
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
  if (recipientCount > 0) scheduledDrain?.();
  return { eventId, recipientCount };
}

async function postPublicHttps(input: Parameters<WebhookPost>[0]): Promise<{ status: number }> {
  const url = new URL(input.endpointUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
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
      response.resume();
      resolve({ status: response.statusCode ?? 0 });
    });
    const timeout = setClockTimeout(
      () => request.destroy(new Error("Webhook request timed out")),
      input.timeoutMs,
    );
    request.once("close", () => clearClockTimeout(timeout));
    request.on("socket", (socket) => {
      socket.once("connect", () => {
        if (!socket.remoteAddress || !isPublicWebhookAddress(socket.remoteAddress)) {
          request.destroy(new Error("Webhook connection reached a non-public address"));
        }
      });
    });
    request.on("error", reject);
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
      .where(eq(oauthClientInstalls.id, base.notification.recipientId)).limit(1) : [];

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
    const eventType = base.event.eventType as AppOutboundEventType;
    const eligible = eventType in APP_OUTBOUND_EVENT_GROUPS
      && effective.events.includes(eventType)
      && includesAll(effective.groups, base.event.requiredGroups)
      && await eventSubjectIsVisible({
        serverId: base.event.serverId,
        subjectType: base.event.subjectType,
        subjectId: base.event.subjectId,
        groups: effective.groups,
      }, executor);
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

    const body = JSON.stringify({
      installation_id: authority.installation.id,
      delivery_id: claimed.id,
      attempt: attemptNumber,
      event: {
        id: base.event.id,
        type: base.event.eventType,
        server_id: base.event.serverId,
        occurred_at: base.event.occurredAt.toISOString(),
        subject: { type: base.event.subjectType, id: base.event.subjectId },
        provenance: base.event.provenance,
      },
    });
    const timestamp = Math.floor(now.getTime() / 1000).toString();
    let status = 0;
    let errorCode: string | null = null;
    try {
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
      if (!(status >= 200 && status < 300)) errorCode = `http_${status || "invalid"}`;
    } catch (error) {
      errorCode = appWebhookDeliveryErrorCode(error);
    }
    const outcome = appWebhookDeliveryOutcomeForStatus(status, attemptNumber);
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
} = {}) {
  const intervalMs = input.intervalMs ?? 15_000;
  const batchSize = input.batchSize ?? DELIVERY_BATCH_SIZE;
  const run = () => {
    drainAppNotificationDeliveries({ batchSize }).catch((error) => {
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
