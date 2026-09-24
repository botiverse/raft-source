import { Router, type Router as RouterType } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { requireAuth, requireServer, requireVerified } from "../middleware/auth.js";
import { getDb } from "../db/index.js";
import { webPushPromptEvents } from "../db/schema.js";
import {
  getVapidPublicKey,
  ensureFamilyRevokeCapability,
  isPushEnabled,
  removeSubscription,
  revokePushFamilyByCapability,
  saveSubscription,
  sendPushToUsers,
  unbindPushInstallation,
  upsertPushRegistration,
  type PushRegistrationEnv,
  type PushRegistrationProvider,
} from "../services/pushService.js";
import * as serverService from "../services/serverService.js";

export const pushRouter: RouterType = Router();
const PUSH_PROMPT_EVENTS = new Set([
  "web_push_prompt_shown",
  "web_push_native_result",
  "web_push_subscription_saved",
  "web_push_subscription_failed",
]);
const MAX_EVENT_FIELD_LENGTH = 128;
const MAX_INSTALLATION_ID_LENGTH = 128;
const MAX_DEVICE_TOKEN_LENGTH = 256;
const MAX_TOPIC_LENGTH = 255;
const MAX_APP_VERSION_LENGTH = 64;
const REGISTRATION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const TOPIC_PATTERN = /^[A-Za-z0-9.-]+$/;
const APP_VERSION_PATTERN = /^[A-Za-z0-9._+()-]+$/;

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
  return value === "apns" ? "apns" : null;
}

function parseEnv(value: unknown): PushRegistrationEnv | null {
  return value === "sandbox" || value === "production" ? value : null;
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
    await getDb().insert(webPushPromptEvents).values({
      userId,
      serverId,
      event,
      trigger,
      result: cleanEventField(req.body?.result),
      permissionBefore: cleanEventField(req.body?.permissionBefore),
      permissionAfter: cleanEventField(req.body?.permissionAfter),
      detail: cleanEventField(req.body?.detail),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[Push] Failed to record prompt event:", err);
    res.status(500).json({ error: "Failed to record prompt event" });
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

  const { endpoint, keys } = req.body ?? {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    res.status(400).json({ error: "Missing endpoint or subscription keys" });
    return;
  }

  try {
    await saveSubscription(userId, endpoint, keys.p256dh, keys.auth);
    res.json({ ok: true });
  } catch (err) {
    console.error("[Push] Failed to save subscription:", err);
    res.status(500).json({ error: "Failed to save subscription" });
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
    console.error("[Push] Failed to remove subscription:", err);
    res.status(500).json({ error: "Failed to remove subscription" });
  }
});

const familyRevokeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const capability = typeof req.body?.capability === "string" ? req.body.capability : "invalid";
    return `${ipKeyGenerator(req.ip ?? "unknown")}:${capability.slice(0, 12)}`;
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
  } catch {
    console.error("[Push] Failed to revoke push family");
    res.status(500).json({ error: "Failed to revoke push family" });
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
  const deviceToken = cleanBoundedRegistrationField(req.body?.deviceToken, MAX_DEVICE_TOKEN_LENGTH, DEVICE_TOKEN_PATTERN);
  const topic = cleanBoundedRegistrationField(req.body?.topic, MAX_TOPIC_LENGTH, TOPIC_PATTERN);
  const appVersionInput = req.body?.appVersion;
  const appVersion = appVersionInput === undefined || appVersionInput === null
    ? null
    : cleanBoundedRegistrationField(appVersionInput, MAX_APP_VERSION_LENGTH, APP_VERSION_PATTERN);

  if (!provider) {
    res.status(400).json({ error: "Invalid push provider" });
    return;
  }
  if (!env) {
    res.status(400).json({ error: "Invalid or missing push environment" });
    return;
  }
  if (!installationId || !deviceToken || !topic) {
    res.status(400).json({ error: "Invalid push registration tuple" });
    return;
  }
  if (appVersionInput !== undefined && appVersionInput !== null && !appVersion) {
    res.status(400).json({ error: "Invalid app version" });
    return;
  }

  try {
    const result = await getDb().transaction(async (tx) => {
      const revokeCapability = await ensureFamilyRevokeCapability({ familyId: sessionFamilyId, userId }, tx);
      if (!revokeCapability) return null;
      const registration = await upsertPushRegistration({
        installationId,
        provider,
        userId,
        serverId,
        sessionFamilyId,
        deviceToken,
        topic,
        env,
        appVersion,
      }, tx);
      return { registration, revokeCapability };
    });
    if (!result) {
      res.status(401).json({ error: "Session family is no longer active" });
      return;
    }
    const { registration, revokeCapability } = result;
    res.json({
      ok: true,
      revoke_capability: revokeCapability,
      registration: {
        installationId: registration.installationId,
        provider: registration.provider,
        env: registration.env,
        topic: registration.topic,
        appVersion: registration.appVersion,
        userId: registration.userId,
        serverId: registration.serverId,
        updatedAt: registration.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    console.error("[Push] Failed to upsert mobile push registration:", err);
    res.status(500).json({ error: "Failed to save push registration" });
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
    console.error("[Push] Failed to unbind mobile push registration:", err);
    res.status(500).json({ error: "Failed to unbind push registration" });
  }
});

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
    const sentAt = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone: "UTC",
    });
    const result = await sendPushToUsers([userId], {
      title: "Raft test notification",
      body: `Direct web push delivered at ${sentAt} UTC`,
      tag: `push-test:${Date.now()}`,
      url: "/settings?pushTest=1",
      alwaysShow: true,
    });

    if (result.attempted === 0) {
      res.status(409).json({ error: "No push subscription found for this user on this server" });
      return;
    }

    if (result.delivered === 0) {
      res.status(502).json({ error: "Push delivery failed for all subscriptions", ...result });
      return;
    }

    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[Push] Failed to send test push:", err);
    res.status(500).json({ error: "Failed to send test push" });
  }
});
