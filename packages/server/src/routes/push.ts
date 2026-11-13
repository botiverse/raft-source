import { Router, type Router as RouterType } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { requireAuth, requireServer, requireVerified } from "../middleware/auth";
import { and, eq, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { asServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { legacyProductEventsAllowed } from "../services/productAnalyticsGate";
import { pushRegistrations, pushSubscriptions, webPushPromptEvents } from "../db/schema";
import {
  getVapidPublicKey,
  ensureFamilyRevokeCapability,
  isAllowedApnsTopic,
  isAllowedWebPushEndpoint,
  isPushEnabled,
  mobilePushDeliveryStatus,
  removeSubscription,
  revokePushFamilyByCapability,
  saveSubscription,
  unbindPushInstallation,
  upsertPushRegistration,
  webPushEndpointHostname,
  type PushPreviewMode,
  type PushRegistrationEnv,
  type PushRegistrationProvider,
} from "../services/pushService";
import * as serverService from "../services/serverService";
import * as notificationSettings from "../services/notifications/settings";
import { sendTestNotification } from "../services/notifications/testNotification";
import { mapWithConcurrency } from "../lib/mapWithConcurrency";
import { sendJsonServerError } from "./errorResponse";
import { clientIpForRateLimit } from "../lib/clientIpForRateLimit";

export const pushRouter: RouterType = Router();
// The banner's Dismiss and its link to Settings; This device's turn-off and
// test result (cindyz, #proj-analytics:fbb8f05c). Same table, same fields, but
// interactions recorded for an analytics question, not delivery diagnostics:
// written only when "Share usage data" and the workspace switch allow it.
const PUSH_PROMPT_INTERACTION_EVENTS = new Set([
  "web_push_prompt_dismissed",
  "web_push_prompt_settings_opened",
  "web_push_disabled",
  "web_push_test_result",
]);
// An interaction row's `detail` is only ever a test failure's fixed code
// (web: testFailureReasonCode, utils/pushEnableRecording.ts; change both
// together); anything else, e.g. a browser's raw error text, is dropped.
const PUSH_TEST_RESULT_DETAIL = /^reason=(no_device|provider_error|provider_not_configured|not_subscribed|error)$/;
function storedDetail(event: string, detail: string | null): string | null {
  if (!PUSH_PROMPT_INTERACTION_EVENTS.has(event)) return detail;
  return event === "web_push_test_result" && detail !== null && PUSH_TEST_RESULT_DETAIL.test(detail) ? detail : null;
}
const PUSH_PROMPT_EVENTS = new Set([
  "web_push_prompt_shown",
  "web_push_native_result",
  "web_push_subscription_saved",
  "web_push_subscription_failed",
  ...PUSH_PROMPT_INTERACTION_EVENTS,
]);
const MAX_EVENT_FIELD_LENGTH = 128;
const MAX_INSTALLATION_ID_LENGTH = 128;
const MAX_DEVICE_TOKEN_LENGTH = 256;
const MAX_TOPIC_LENGTH = 255;
const MAX_APP_VERSION_LENGTH = 64;
const REGISTRATION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
// FCM registration tokens are longer and contain ':' (e.g. "<instance>:APA91b...").
const MAX_FCM_DEVICE_TOKEN_LENGTH = 4096;
const FCM_DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_:-]+$/;
const TOPIC_PATTERN = /^[A-Za-z0-9.-]+$/;
const APP_VERSION_PATTERN = /^[A-Za-z0-9._+()-]+$/;
/** In-flight test sends per POST /push/test (one per web subscription of the user). */
const TEST_PUSH_CONCURRENCY = 4;

function cleanEventField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_EVENT_FIELD_LENGTH) : null;
}

function cleanRegistrationField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function cleanBoundedRegistrationField(value: unknown, maxLength: number, pattern: RegExp): string | null {
  const cleaned = cleanRegistrationField(value);
  if (!cleaned || cleaned.length > maxLength || !pattern.test(cleaned)) return null;
  return cleaned;
}

function parseProvider(value: unknown): PushRegistrationProvider | null {
  return value === "apns" || value === "fcm" ? value : null;
}

function parseEnv(value: unknown): PushRegistrationEnv | null {
  return value === "sandbox" || value === "production" ? value : null;
}

// Absent or null keeps the stored mode (like appVersion). A string this server
// does not know (e.g. a mode from a newer client) fails closed to "hidden" rather
// than rejecting the whole registration; only a non-string is malformed (null).
function parsePreviewMode(value: unknown): PushPreviewMode | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  return value === "full" || value === "sender_only" || value === "hidden" ? value : "hidden";
}

const OS_PERMISSIONS = ["granted", "denied", "provisional", "unknown"] as const;
type PushOsPermission = (typeof OS_PERMISSIONS)[number];

// Absent or null keeps the stored value. A string this server does not know
// reads as "unknown" (a newer client's state); a non-string is malformed (null).
function parseOsPermission(value: unknown): PushOsPermission | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  return (OS_PERMISSIONS as readonly string[]).includes(value) ? value as PushOsPermission : "unknown";
}

// Absent or null keeps the stored value; anything but a boolean is malformed (null).
function parseAlertsEnabled(value: unknown): boolean | undefined | null {
  if (value === undefined || value === null) return undefined;
  return typeof value === "boolean" ? value : null;
}

// Absent or null keeps the stored value (NULL reads as set 1). A positive
// integer is the newest redacted-preview loc-key set the app knows (a newer
// app may report a set this server does not know yet); anything else is
// malformed (null).
function parsePreviewKeySet(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 1000 ? value : null;
}

function serializeRegistration(registration: typeof pushRegistrations.$inferSelect) {
  return {
    installationId: registration.installationId,
    provider: registration.provider,
    env: registration.env,
    topic: registration.topic,
    appVersion: registration.appVersion,
    previewMode: registration.previewMode,
    alertsEnabled: registration.alertsEnabled,
    osPermission: registration.osPermission,
    previewKeySet: registration.previewKeySet ?? 1,
    userId: registration.userId,
    serverId: registration.serverId,
    updatedAt: registration.updatedAt.toISOString(),
  };
}

// The VAPID public key is intentionally unauthenticated: browsers need it before
// a user-specific subscription exists, and it is safe to expose by design.
pushRouter.get("/vapid-key", (_req, res) => {
  const publicKey = getVapidPublicKey();
  if (!publicKey) {
    res.status(503).json({ error: "Push notifications not configured" });
    return;
  }
  res.json({ publicKey });
});

pushRouter.post("/prompt-events", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const event = cleanEventField(req.body?.event);
  const trigger = cleanEventField(req.body?.trigger);
  if (!event || !PUSH_PROMPT_EVENTS.has(event) || !trigger) {
    res.status(400).json({ error: "Invalid push prompt event" });
    return;
  }

  const headerServerId = typeof req.headers["x-server-id"] === "string"
    ? req.headers["x-server-id"]
    : null;
  let serverId: string | null = null;
  if (headerServerId && await serverService.isMember(headerServerId, userId)) {
    serverId = headerServerId;
  }

  try {
    if (PUSH_PROMPT_INTERACTION_EVENTS.has(event)
      && !(await legacyProductEventsAllowed(getDb(), { userId, serverId: serverId === null ? null : asServerId(serverId) }))) {
      res.json({ ok: true });
      return;
    }
    await getDb().insert(webPushPromptEvents).values({
      userId,
      serverId,
      event,
      trigger,
      result: cleanEventField(req.body?.result),
      permissionBefore: cleanEventField(req.body?.permissionBefore),
      permissionAfter: cleanEventField(req.body?.permissionAfter),
      detail: storedDetail(event, cleanEventField(req.body?.detail)),
    });
    res.json({ ok: true });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to record prompt event",
      logPrefix: "[Push] Failed to record prompt event:",
      err,
    });
  }
});

pushRouter.post("/subscribe", requireAuth, requireVerified, async (req, res) => {
  if (!isPushEnabled()) {
    res.status(503).json({ error: "Push notifications not configured" });
    return;
  }

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { endpoint, keys, oldEndpoint } = req.body ?? {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    res.status(400).json({ error: "Missing endpoint or subscription keys" });
    return;
  }
  if (!webPushEndpointHostname(endpoint)) {
    res.status(400).json({ error: "Push endpoint must be a public HTTPS URL" });
    return;
  }
  // Only the browsers' own push services: never a host of the subscriber's choosing.
  if (!isAllowedWebPushEndpoint(endpoint)) {
    res.status(400).json({ error: "Push endpoint is not on a supported push service", code: "push_endpoint_host_not_allowed" });
    return;
  }
  // From a service worker's pushsubscriptionchange: the browser replaced the
  // subscription, so the old endpoint goes (contract §3.2).
  if (oldEndpoint !== undefined && oldEndpoint !== null && (typeof oldEndpoint !== "string" || oldEndpoint.length > 4096)) {
    res.status(400).json({ error: "Invalid oldEndpoint" });
    return;
  }

  try {
    if (typeof oldEndpoint === "string" && oldEndpoint && oldEndpoint !== endpoint) {
      // One transaction: the new subscription replaces the caller's old one.
      await getDb().transaction(async (tx) => {
        await tx.insert(pushSubscriptions)
          .values({ userId, endpoint, p256dh: keys.p256dh, auth: keys.auth })
          .onConflictDoUpdate({
            target: [pushSubscriptions.userId, pushSubscriptions.endpoint],
            set: { p256dh: keys.p256dh, auth: keys.auth, updatedAt: new Date() },
          });
        await tx.delete(pushSubscriptions)
          .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, oldEndpoint)));
      });
    } else {
      await saveSubscription(userId, endpoint, keys.p256dh, keys.auth);
    }
    res.json({ ok: true });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to save subscription",
      logPrefix: "[Push] Failed to save subscription:",
      err,
    });
  }
});

pushRouter.delete("/subscribe", requireAuth, requireVerified, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { endpoint } = req.body ?? {};
  if (!endpoint) {
    res.status(400).json({ error: "Missing endpoint" });
    return;
  }

  try {
    await removeSubscription(userId, endpoint);
    res.json({ ok: true });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to remove subscription",
      logPrefix: "[Push] Failed to remove subscription:",
      err,
    });
  }
});

const familyRevokeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const capability = typeof req.body?.capability === "string" ? req.body.capability : "invalid";
    return `${ipKeyGenerator(clientIpForRateLimit(req))}:${capability.slice(0, 12)}`;
  },
  message: { error: "Too many family revoke attempts" },
});

pushRouter.post("/family-revoke", familyRevokeLimiter, async (req, res) => {
  const capability = typeof req.body?.capability === "string" ? req.body.capability.trim() : "";
  if (!capability || capability.length > 256 || !/^[A-Za-z0-9._-]+$/.test(capability)) {
    res.status(400).json({ error: "Invalid revoke capability shape" });
    return;
  }

  try {
    const result = await revokePushFamilyByCapability(capability);
    if (result === "invalid") {
      res.status(403).json({ error: "Invalid revoke capability" });
      return;
    }
    res.status(204).end();
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to revoke push family",
      logPrefix: "[Push] Failed to revoke push family",
      err,
    });
  }
});

// Whether this installation gets server pushes through FCM, for every server the
// user belongs to. The Android app keeps its own tray notifications where it doesn't.
// fcmRegistered: the installation holds a live FCM registration for the user,
// independent of the rollout flag and FCM configuration.
pushRouter.get("/delivery-status", requireAuth, requireVerified, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const installationId = cleanBoundedRegistrationField(req.query.installationId, MAX_INSTALLATION_ID_LENGTH, REGISTRATION_ID_PATTERN);
  if (!installationId) {
    res.status(400).json({ error: "Invalid installation id" });
    return;
  }

  try {
    const { servers, fcmRegistered } = await mobilePushDeliveryStatus({ userId, installationId });
    // FCM is fully rolled out (mobile_push_fcm_v0 retired): every server
    // reports fcmActive, so older Android builds leave their own tray
    // notifications to the server pushes.
    res.json({
      servers: Object.fromEntries(Object.keys(servers).map((serverId) => [serverId, { fcmActive: true }])),
      fcmRegistered,
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to read push delivery status",
      logPrefix: "[Push] Failed to read push delivery status:",
      err,
    });
  }
});

pushRouter.post("/registrations", requireAuth, requireVerified, requireServer, async (req, res) => {
  const userId = req.userId;
  const serverId = req.serverId;
  const sessionFamilyId = req.sessionFamilyId;
  if (!userId || !serverId || !sessionFamilyId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const provider = parseProvider(req.body?.provider);
  const env = parseEnv(req.body?.env);
  const installationId = cleanBoundedRegistrationField(req.body?.installationId, MAX_INSTALLATION_ID_LENGTH, REGISTRATION_ID_PATTERN);
  const deviceToken = provider === "fcm"
    ? cleanBoundedRegistrationField(req.body?.deviceToken, MAX_FCM_DEVICE_TOKEN_LENGTH, FCM_DEVICE_TOKEN_PATTERN)
    : cleanBoundedRegistrationField(req.body?.deviceToken, MAX_DEVICE_TOKEN_LENGTH, DEVICE_TOKEN_PATTERN);
  const topic = cleanBoundedRegistrationField(req.body?.topic, MAX_TOPIC_LENGTH, TOPIC_PATTERN);
  const appVersionInput = req.body?.appVersion;
  const appVersion = appVersionInput === undefined || appVersionInput === null
    ? null
    : cleanBoundedRegistrationField(appVersionInput, MAX_APP_VERSION_LENGTH, APP_VERSION_PATTERN);
  // Omitted keeps the stored mode, so an older client re-registering never resets it.
  // Deprecated: the account setting decides (see previewModeToAdopt below).
  const previewMode = parsePreviewMode(req.body?.previewMode);
  const alertsEnabled = parseAlertsEnabled(req.body?.alertsEnabled);
  const osPermission = parseOsPermission(req.body?.osPermission);
  const previewKeySet = parsePreviewKeySet(req.body?.previewKeySet);

  if (!provider) {
    res.status(400).json({ error: "Invalid push provider" });
    return;
  }
  if (!env) {
    res.status(400).json({ error: "Invalid or missing push environment" });
    return;
  }
  // FCM has no sandbox: one endpoint serves debug and release builds alike.
  if (provider === "fcm" && env !== "production") {
    res.status(400).json({ error: "FCM registrations use the production environment" });
    return;
  }
  if (!installationId || !deviceToken || !topic) {
    res.status(400).json({ error: "Invalid push registration tuple" });
    return;
  }
  // Our APNs key pushes only to our own app: another bundle id (a fork or a
  // third-party build pointed at this server) would only get TopicDisallowed.
  if (provider === "apns" && !isAllowedApnsTopic(topic)) {
    res.status(400).json({ error: "Push topic is not supported by this server", code: "push_topic_not_allowed" });
    return;
  }
  if (appVersionInput !== undefined && appVersionInput !== null && !appVersion) {
    res.status(400).json({ error: "Invalid app version" });
    return;
  }
  if (previewMode === null) {
    res.status(400).json({ error: "Invalid preview mode" });
    return;
  }
  if (alertsEnabled === null) {
    res.status(400).json({ error: "alertsEnabled must be a boolean" });
    return;
  }
  if (osPermission === null) {
    res.status(400).json({ error: "Invalid OS permission" });
    return;
  }
  if (previewKeySet === null) {
    res.status(400).json({ error: "previewKeySet must be a positive integer" });
    return;
  }

  try {
    const result = await getDb().transaction(async (tx) => {
      const revokeCapability = await ensureFamilyRevokeCapability({ familyId: sessionFamilyId, userId }, tx);
      if (!revokeCapability) return null;
      // What this installation reported last, if it was this user's (also
      // after a revoke): the previewMode compatibility rule compares with it.
      const [previous] = await tx
        .select({ previewMode: pushRegistrations.previewMode })
        .from(pushRegistrations)
        .where(and(
          eq(pushRegistrations.installationId, installationId),
          eq(pushRegistrations.provider, provider),
          sql`coalesce(${pushRegistrations.userId}, ${pushRegistrations.revokedUserId}) = ${userId}::uuid`,
        ));
      const upserted = await upsertPushRegistration({
        installationId,
        provider,
        userId,
        serverId,
        sessionFamilyId,
        deviceToken,
        topic,
        env,
        appVersion,
        previewMode,
      }, tx);
      const [registration] = await tx
        .update(pushRegistrations)
        .set({
          lastRegisteredAt: sql`now()`,
          ...(alertsEnabled !== undefined ? { alertsEnabled } : {}),
          ...(osPermission !== undefined ? { osPermission } : {}),
          ...(previewKeySet !== undefined ? { previewKeySet } : {}),
        })
        .where(eq(pushRegistrations.id, upserted.id))
        .returning();
      const account = await notificationSettings.getAccountNotificationSettings(userId, tx);
      const adopt = notificationSettings.previewModeToAdopt({
        reported: previewMode,
        previouslyReported: previous?.previewMode ?? null,
        account: account.previewMode,
      });
      const accountUpdate = adopt
        ? await notificationSettings.updateAccountNotificationSettings(userId, { previewMode: adopt }, tx)
        : null;
      return { registration: registration ?? upserted, revokeCapability, accountUpdate };
    });
    if (!result) {
      res.status(401).json({ error: "Session family is no longer active" });
      return;
    }
    const { registration, revokeCapability, accountUpdate } = result;
    if (accountUpdate?.kind === "updated" && accountUpdate.changed) {
      notificationSettings.emitNotificationPrefsUpdated(req.app.get("io") as SocketServer | undefined, userId, {
        type: "account",
        settings: accountUpdate.settings,
      });
    }
    res.json({
      ok: true,
      revoke_capability: revokeCapability,
      registration: serializeRegistration(registration),
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to save push registration",
      logPrefix: "[Push] Failed to upsert mobile push registration:",
      err,
    });
  }
});

// The device's own notification state (contract §3.1): its "receive
// notifications here" switch and the OS permission. Only the caller's own
// installation.
pushRouter.patch("/registrations/:installationId", requireAuth, requireVerified, requireServer, async (req, res) => {
  const userId = req.userId;
  if (!userId || !req.serverId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const installationId = cleanBoundedRegistrationField(req.params.installationId, MAX_INSTALLATION_ID_LENGTH, REGISTRATION_ID_PATTERN);
  if (!installationId) {
    res.status(400).json({ error: "Invalid installation id" });
    return;
  }
  const alertsEnabled = parseAlertsEnabled(req.body?.alertsEnabled);
  const osPermission = parseOsPermission(req.body?.osPermission);
  if (alertsEnabled === null) {
    res.status(400).json({ error: "alertsEnabled must be a boolean" });
    return;
  }
  if (osPermission === null) {
    res.status(400).json({ error: "Invalid OS permission" });
    return;
  }
  if (alertsEnabled === undefined && osPermission === undefined) {
    res.status(400).json({ error: "alertsEnabled or osPermission is required" });
    return;
  }

  try {
    const [registration] = await getDb()
      .update(pushRegistrations)
      .set({
        ...(alertsEnabled !== undefined ? { alertsEnabled } : {}),
        ...(osPermission !== undefined ? { osPermission } : {}),
        updatedAt: sql`now()`,
      })
      .where(and(eq(pushRegistrations.installationId, installationId), eq(pushRegistrations.userId, userId)))
      .returning();
    if (!registration) {
      res.status(404).json({ error: "Push registration not found" });
      return;
    }
    res.json({ ok: true, registration: serializeRegistration(registration) });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to update push registration",
      logPrefix: "[Push] Failed to update mobile push registration:",
      err,
    });
  }
});

pushRouter.delete("/registrations/:installationId", requireAuth, requireVerified, requireServer, async (req, res) => {
  const userId = req.userId;
  const serverId = req.serverId;
  if (!userId || !serverId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const installationId = cleanRegistrationField(req.params.installationId);
  if (!installationId) {
    res.status(400).json({ error: "Missing installation id" });
    return;
  }

  try {
    const unbound = await unbindPushInstallation({ installationId, userId, serverId });
    res.json({ ok: true, unbound });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to unbind push registration",
      logPrefix: "[Push] Failed to unbind mobile push registration:",
      err,
    });
  }
});

// Deprecated (older apps' "send test notification"): POST /api/notifications/test
// is the real-transport test to one device. Kept until those apps move: one
// test notification, through the same test path, to every Web Push
// subscription of the caller; the response keeps its old shape.
pushRouter.post("/test", requireAuth, requireVerified, async (req, res) => {
  if (!isPushEnabled()) {
    res.status(503).json({ error: "Push notifications not configured" });
    return;
  }

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const subscriptions = await getDb()
      .select({ endpoint: pushSubscriptions.endpoint })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    // The envelope names a server: the header's when the caller is a member, else their first.
    const headerServerId = typeof req.headers["x-server-id"] === "string" ? req.headers["x-server-id"] : null;
    const serverId = headerServerId && await serverService.isMember(headerServerId, userId)
      ? headerServerId
      : (await notificationSettings.listServerLevels(userId))[0]?.serverId ?? null;
    if (subscriptions.length === 0 || !serverId) {
      res.status(409).json({ error: "No push subscription found for this user on this server" });
      return;
    }

    const io = req.app.get("io") as SocketServer | undefined;
    // Each send goes through the real path (DB reads, a provider call): bounded per request.
    const results = await mapWithConcurrency(subscriptions, TEST_PUSH_CONCURRENCY, (subscription) => sendTestNotification({
      io,
      userId,
      serverId,
      device: { kind: "web", endpoint: subscription.endpoint },
    }));
    const attempted = results.length;
    const delivered = results.filter((result) => result.sent).length;
    const summary = { attempted, delivered, failed: attempted - delivered };
    if (delivered === 0) {
      res.status(502).json({ error: "Push delivery failed for all subscriptions", ...summary });
      return;
    }
    res.json({ ok: true, ...summary });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to send test push",
      logPrefix: "[Push] Failed to send test push:",
      err,
    });
  }
});
