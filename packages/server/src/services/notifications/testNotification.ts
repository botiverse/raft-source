/**
 * Test notifications (docs/contracts/notifications.md §6).
 *
 * `POST /notifications/test` builds a `category: "test"` notification and
 * sends it through the real transport to exactly one device of the caller,
 * skipping policy and the device plan. The device acks when it displayed it;
 * the status lives in Redis (`notif-test:<testId>`, 15 minutes) so any
 * replica can answer the ack and the poll.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import {
  DESKTOP_NOTIFICATION_EVENT,
  currentTimeMs,
  formatNotificationCopy,
  type NotificationLocalization,
  type NotificationTestDeviceKind,
  type NotificationTestStatus,
} from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { pushRegistrations, pushSubscriptions, servers } from "../../db/schema";
import { getRedis, isRedisAvailable } from "../../redis";
import { getAppUrl } from "../../config/appUrl";
import type { BuiltNotification, ExternalSendResult, MobileRegistrationTarget } from "./types";
import { apnsAlertRequest, apnsTransport } from "./transports/apns";
import { fcmAlertMessage, fcmTransport, mobilePushConversationKey } from "./transports/fcm";
import { deleteWebPushSubscription, webPushPayload, webPushTransport } from "./transports/webPush";
import { loadMultiServerUserIds } from "./settings";

export const TEST_NOTIFICATION_TITLE = formatNotificationCopy("push.title.test");
export const TEST_NOTIFICATION_BODY = formatNotificationCopy("push.body.test");
/** The keys of the title and body (contract §1.5); the server-label subtitle is a name. */
const TEST_NOTIFICATION_LOCALIZATION: NotificationLocalization = { titleKey: "push.title.test", bodyKey: "push.body.test", bodyArgs: [] };
/** A pending test with no ack after this long reads as not_shown (clients wait as long). */
export const TEST_NOTIFICATION_ACK_WINDOW_MS = 15 * 1000;
const TEST_NOTIFICATION_TTL_SECONDS = 15 * 60;
const KEY_PREFIX = "notif-test:";

export interface TestNotificationDevice {
  kind: NotificationTestDeviceKind;
  socketId?: string;
  endpoint?: string;
  installationId?: string;
}

export type TestNotificationFailureReason = "no_device" | "provider_error" | "provider_not_configured";

export type TestNotificationSendResult =
  | { testId: string; sent: true }
  | { testId: string; sent: false; reason: TestNotificationFailureReason };

interface StoredTestNotification {
  userId: string;
  status: NotificationTestStatus;
  reason?: string;
  /** Epoch ms of the send; a pending older than the ack window reads as not_shown. */
  sentAt: number;
}

let now: () => number = () => currentTimeMs();

export function __setTestNotificationClockForTests(clock: (() => number) | null): void {
  now = clock ?? (() => currentTimeMs());
}

// Single-replica fallback (dev, tests). Production always has Redis.
const localStore = new Map<string, { value: StoredTestNotification; expiresAt: number }>();

export function __resetTestNotificationStoreForTests(): void {
  localStore.clear();
}

function testKey(testId: string): string {
  return `${KEY_PREFIX}${testId}`;
}

function parseStored(raw: string | null | undefined): StoredTestNotification | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredTestNotification>;
    if (typeof value.userId !== "string" || typeof value.status !== "string" || typeof value.sentAt !== "number") return null;
    return {
      userId: value.userId,
      status: value.status,
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
      sentAt: value.sentAt,
    };
  } catch {
    return null;
  }
}

async function readStored(testId: string): Promise<StoredTestNotification | null> {
  if (isRedisAvailable()) return parseStored(await getRedis().get(testKey(testId)));
  const entry = localStore.get(testKey(testId));
  if (!entry) return null;
  if (entry.expiresAt <= now()) {
    localStore.delete(testKey(testId));
    return null;
  }
  return entry.value;
}

async function writeStored(testId: string, value: StoredTestNotification): Promise<void> {
  if (isRedisAvailable()) {
    await getRedis().set(testKey(testId), JSON.stringify(value), "EX", TEST_NOTIFICATION_TTL_SECONDS);
    return;
  }
  localStore.set(testKey(testId), { value, expiresAt: now() + TEST_NOTIFICATION_TTL_SECONDS * 1000 });
}

/**
 * The test notification. There is no conversation: mobile payloads carry
 * `route: null` and `routeUrl` `/s/<slug>/activity` (contract §4.1); the
 * desktop envelope keeps a valid legacy DesktopNotificationRoute (a `channel`
 * route with an empty channelId, which parseDesktopNotificationV1 accepts; the
 * desktop navigates by `url`). Not "mentioned": it is no @mention. The
 * server label is the subtitle (APNs alert.subtitle; Web Push joins it to the
 * title) for a caller in 2+ servers, as for real notifications; unknown
 * (`multiServer` omitted) names the server, the fail-safe default.
 */
export function buildTestNotification(input: {
  testId: string;
  serverId: string;
  serverName: string;
  serverSlug: string;
  createdAt: Date;
  multiServer?: boolean;
}): BuiltNotification {
  const subtitle = input.multiServer === false ? undefined : input.serverName;
  const routeUrl = `/s/${input.serverSlug}/activity`;
  const route = { type: "channel" as const, serverId: input.serverId, channelId: "", messageId: null };
  const groupKey = `${input.serverId}:test`;
  return {
    envelope: {
      v: 1,
      id: `test:${input.testId}`,
      kind: "mention",
      event: "test",
      title: TEST_NOTIFICATION_TITLE,
      ...(subtitle ? { subtitle } : {}),
      body: TEST_NOTIFICATION_BODY,
      serverId: input.serverId,
      serverName: input.serverName,
      channelId: null,
      threadId: null,
      parentChannelId: null,
      parentMessageId: null,
      messageId: null,
      mentioned: false,
      sender: null,
      url: routeUrl,
      route,
      groupKey,
      createdAt: input.createdAt.toISOString(),
      category: "test",
      priority: "high",
      seq: null,
      conversationId: null,
      silent: false,
      previewMode: "full",
      testId: input.testId,
      localization: TEST_NOTIFICATION_LOCALIZATION,
    },
    push: {
      title: TEST_NOTIFICATION_TITLE,
      ...(subtitle ? { subtitle } : {}),
      body: TEST_NOTIFICATION_BODY,
      localization: TEST_NOTIFICATION_LOCALIZATION,
      serverName: input.serverName,
      channelName: null,
      parentChannelKind: null,
      mentioned: false,
    },
    mobile: {
      serverId: input.serverId,
      channelId: null,
      kind: null,
      threadIdentifier: groupKey,
      notificationKey: mobilePushConversationKey(input.serverId, "test"),
    },
    route: null,
    routeUrl,
  };
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : undefined;
}

export function parseTestNotificationDevice(value: unknown): TestNotificationDevice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const device = value as Record<string, unknown>;
  if (device.kind !== "desktop" && device.kind !== "web" && device.kind !== "mobile") return null;
  const socketId = cleanString(device.socketId);
  const endpoint = cleanString(device.endpoint);
  const installationId = cleanString(device.installationId);
  return {
    kind: device.kind,
    ...(socketId ? { socketId } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(installationId ? { installationId } : {}),
  };
}

type DeliveryOutcome = { sent: true } | { sent: false; reason: TestNotificationFailureReason };

function fromSendResult(result: ExternalSendResult): DeliveryOutcome {
  if (result.status === "sent") return { sent: true };
  return { sent: false, reason: result.reason === "provider_not_configured" ? "provider_not_configured" : "no_device" };
}

async function sendToDesktop(io: SocketServer | undefined, userId: string, socketId: string | undefined, built: BuiltNotification): Promise<DeliveryOutcome> {
  if (!io || !socketId) return { sent: false, reason: "no_device" };
  const sockets = await io.in(socketId).fetchSockets();
  const socket = sockets.find((candidate) =>
    candidate.id === socketId && candidate.data?.userId === userId && candidate.data?.clientKind === "desktop");
  if (!socket) return { sent: false, reason: "no_device" };
  socket.emit(DESKTOP_NOTIFICATION_EVENT, built.envelope);
  return { sent: true };
}

async function sendToWeb(userId: string, endpoint: string | undefined, built: BuiltNotification, testId: string): Promise<DeliveryOutcome> {
  if (!endpoint) return { sent: false, reason: "no_device" };
  const [subscription] = await getDb().select().from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
    .limit(1);
  if (!subscription) return { sent: false, reason: "no_device" };
  try {
    return fromSendResult(await webPushTransport.send(subscription, webPushPayload(built, getAppUrl(), { testId })));
  } catch (err) {
    if (!webPushTransport.isTerminalTargetError(err)) throw err;
    // Not deliverable ever again (non-public endpoint, or gone): drop it like a send would.
    await deleteWebPushSubscription(subscription.id);
    return { sent: false, reason: "no_device" };
  }
}

async function sendToMobile(userId: string, installationId: string | undefined, built: BuiltNotification, testId: string): Promise<DeliveryOutcome> {
  if (!installationId) return { sent: false, reason: "no_device" };
  const [row] = await getDb().select().from(pushRegistrations)
    .where(and(
      eq(pushRegistrations.userId, userId),
      eq(pushRegistrations.installationId, installationId),
      isNull(pushRegistrations.revokedAt),
    ))
    .limit(1);
  if (!row || !row.userId) return { sent: false, reason: "no_device" };
  const target: MobileRegistrationTarget = {
    id: row.id,
    userId: row.userId,
    installationId: row.installationId,
    provider: row.provider,
    deviceToken: row.deviceToken,
    topic: row.topic,
    env: row.env,
    alertsEnabled: row.alertsEnabled,
    osPermission: row.osPermission,
    previewKeySet: row.previewKeySet ?? 1,
  };
  // No badge: a test must not change the app badge.
  const result = target.provider === "apns"
    ? await apnsTransport.send(target, apnsAlertRequest(built, undefined, { testId, previewKeySet: target.previewKeySet }))
    : await fcmTransport.send(target, fcmAlertMessage(built, undefined, { testId, previewKeySet: target.previewKeySet }));
  return fromSendResult(result);
}

/** One attempt to one device of the caller; the outcome is stored for the ack / poll. */
export async function sendTestNotification(input: {
  io: SocketServer | undefined;
  userId: string;
  serverId: string;
  device: TestNotificationDevice;
}): Promise<TestNotificationSendResult> {
  const testId = randomUUID();
  const sentAt = now();
  let outcome: DeliveryOutcome;
  const [server] = await getDb().select({ id: servers.id, name: servers.name, slug: servers.slug })
    .from(servers).where(eq(servers.id, input.serverId)).limit(1);
  if (!server) {
    outcome = { sent: false, reason: "no_device" };
  } else {
    // A failed lookup names the server (fail safe).
    const multiServer = await loadMultiServerUserIds(getDb(), [input.userId])
      .then((ids) => ids.has(input.userId))
      .catch(() => true);
    const built = buildTestNotification({
      testId,
      serverId: server.id,
      serverName: server.name,
      serverSlug: server.slug,
      createdAt: new Date(sentAt),
      multiServer,
    });
    try {
      switch (input.device.kind) {
        case "desktop":
          outcome = await sendToDesktop(input.io, input.userId, input.device.socketId, built);
          break;
        case "web":
          outcome = await sendToWeb(input.userId, input.device.endpoint, built, testId);
          break;
        case "mobile":
          outcome = await sendToMobile(input.userId, input.device.installationId, built, testId);
          break;
      }
    } catch (err) {
      console.warn(`[TestNotification] ${input.device.kind} delivery failed: ${err instanceof Error ? err.name : "unknown_error"}`);
      outcome = { sent: false, reason: "provider_error" };
    }
  }
  await writeStored(testId, outcome.sent
    ? { userId: input.userId, status: "pending", sentAt }
    : { userId: input.userId, status: "failed", reason: outcome.reason, sentAt });
  return outcome.sent ? { testId, sent: true } : { testId, sent: false, reason: outcome.reason };
}

/** false: no such test of this user. */
export async function ackTestNotification(userId: string, testId: string, shown: boolean): Promise<boolean> {
  const stored = await readStored(testId);
  if (!stored || stored.userId !== userId) return false;
  await writeStored(testId, { userId, status: shown ? "shown" : "not_shown", sentAt: stored.sentAt });
  return true;
}

/** null: no such test of this user. */
export async function readTestNotificationStatus(
  userId: string,
  testId: string,
): Promise<{ status: NotificationTestStatus; reason?: string } | null> {
  const stored = await readStored(testId);
  if (!stored || stored.userId !== userId) return null;
  if (stored.status === "pending" && now() - stored.sentAt >= TEST_NOTIFICATION_ACK_WINDOW_MS) return { status: "not_shown" };
  return { status: stored.status, ...(stored.reason ? { reason: stored.reason } : {}) };
}
