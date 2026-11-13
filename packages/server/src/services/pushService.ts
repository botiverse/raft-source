import { revokeSocketAccess } from "../socket/accessRevocation";
import { revokeSessionFamilyInTransaction } from "./sessionService";
import { revokeKeysOfRevokedDeviceSessions } from "./deviceSessionKeys";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { currentDate } from "@botiverse/raft-shared";
import { and, eq, exists, gt, isNull, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { pushRegistrations, pushSubscriptions, serverMembers, sessionFamilies, sessions } from "../db/schema";
import { addTraceEvent } from "../tracing/semanticTrace";
import { fcmTransport } from "./notifications/transports/fcm";
import { isWebPushEnabled } from "./notifications/transports/webPush";

/**
 * Push device bookkeeping: Web Push subscriptions, mobile registrations, the
 * session-family revoke capability and the delivery status the Android app
 * reads. Sending lives in services/notifications (one dispatcher for every
 * transport, providers in services/notifications/transports/*).
 */

export {
  __resetWebPushRuntimeForTests,
  __setWebPushRuntimeForTests,
  getVapidPublicKey,
  isAllowedWebPushEndpoint,
  webPushEndpointHostname,
} from "./notifications/transports/webPush";
export { isAllowedApnsTopic } from "./notifications/transports/apns";

export const PUSH_FAMILY_CAPABILITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function isPushEnabled(): boolean {
  return isWebPushEnabled();
}

export type PushRegistrationProvider = "apns" | "fcm";
export type PushRegistrationEnv = "sandbox" | "production";
/** What a mobile push to one device may show; stored per registration. */
export type PushPreviewMode = "full" | "sender_only" | "hidden";

export interface PushRegistrationInput {
  installationId: string;
  provider: PushRegistrationProvider;
  userId: string;
  serverId: string;
  sessionFamilyId: string;
  deviceToken: string;
  topic: string;
  env: PushRegistrationEnv;
  appVersion?: string | null;
  /** Omitted: a new row gets "full" and an existing row keeps its stored mode. */
  previewMode?: PushPreviewMode;
}

export type PushFamilyRevokeResult = "revoked" | "already_revoked" | "invalid";

function capabilitySigningKey(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is required");
  return secret;
}

function capabilitySignature(familyId: string, nonce: string): string {
  return createHmac("sha256", capabilitySigningKey())
    .update("push-family-revoke-v1\0")
    .update(familyId)
    .update("\0")
    .update(nonce)
    .digest("base64url");
}

function formatFamilyRevokeCapability(familyId: string, nonce: string): string {
  return `${familyId}.${nonce}.${capabilitySignature(familyId, nonce)}`;
}

function parseFamilyRevokeCapability(capability: string): { familyId: string; nonce: string; signature: string } | null {
  if (capability.length > 256) return null;
  const [familyId, nonce, signature, extra] = capability.split(".");
  if (extra !== undefined || !familyId || !nonce || !signature) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(familyId)
    || !/^[A-Za-z0-9_-]{22}$/.test(nonce)
    || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    return null;
  }
  return { familyId, nonce, signature };
}

function capabilitySignatureMatches(familyId: string, nonce: string, signature: string): boolean {
  const expected = Buffer.from(capabilitySignature(familyId, nonce));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function ensureFamilyRevokeCapability(
  input: { familyId: string; userId: string },
  executor: DatabaseExecutor = getDb(),
): Promise<string | null> {
  const candidateNonce = randomBytes(16).toString("base64url");
  const [family] = await executor
    .update(sessionFamilies)
    .set({ revokeCapabilityNonce: sql`COALESCE(${sessionFamilies.revokeCapabilityNonce}, ${candidateNonce})` })
    .where(and(
      eq(sessionFamilies.id, input.familyId),
      eq(sessionFamilies.userId, input.userId),
      isNull(sessionFamilies.revokedAt),
    ))
    .returning({ id: sessionFamilies.id, nonce: sessionFamilies.revokeCapabilityNonce });
  return family?.nonce ? formatFamilyRevokeCapability(family.id, family.nonce) : null;
}

export async function revokePushFamilyByCapability(
  capability: string,
  now = currentDate(),
): Promise<PushFamilyRevokeResult> {
  const parsed = parseFamilyRevokeCapability(capability);
  if (!parsed || !capabilitySignatureMatches(parsed.familyId, parsed.nonce, parsed.signature)) return "invalid";

  let revokedUserId: string | undefined;
  const result = await getDb().transaction(async (tx) => {
    const [family] = await tx.select({
      id: sessionFamilies.id,
      userId: sessionFamilies.userId,
      nonce: sessionFamilies.revokeCapabilityNonce,
      revokedAt: sessionFamilies.revokedAt,
      capabilityRetainUntil: sessionFamilies.capabilityRetainUntil,
    }).from(sessionFamilies).where(eq(sessionFamilies.id, parsed.familyId));
    if (!family?.nonce || family.nonce !== parsed.nonce) return "invalid";

    if (family.revokedAt) {
      if (family.capabilityRetainUntil && family.capabilityRetainUntil.getTime() > now.getTime()) {
        revokedUserId = family.userId;
        return "already_revoked";
      }
      await tx.update(sessionFamilies).set({
        revokeCapabilityNonce: null,
        capabilityRetainUntil: null,
      }).where(eq(sessionFamilies.id, family.id));
      return "invalid";
    }

    await revokeSessionFamilyInTransaction(tx, family.userId, family.id, "capability", now);
    revokedUserId = family.userId;
    return "revoked";
  });
  // Also retry eviction for an already-revoked capability after fanout failure.
  if (revokedUserId) {
    try {
      await revokeSocketAccess({ userId: revokedUserId, familyId: parsed.familyId });
    } finally {
      await revokeKeysOfRevokedDeviceSessions({ familyId: parsed.familyId }, now);
    }
  }
  if (result === "revoked") addTraceEvent("push.family.revoked", { reason: "capability" });
  return result;
}

export async function saveSubscription(userId: string, endpoint: string, p256dh: string, auth: string) {
  const db = getDb();
  await db
    .insert(pushSubscriptions)
    .values({ userId, endpoint, p256dh, auth })
    .onConflictDoUpdate({
      target: [pushSubscriptions.userId, pushSubscriptions.endpoint],
      set: { p256dh, auth, updatedAt: new Date() },
    });
}

export async function removeSubscription(userId: string, endpoint: string) {
  const db = getDb();
  await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}

export async function upsertPushRegistration(input: PushRegistrationInput, executor: DatabaseExecutor = getDb()) {
  const [row] = await executor
    .insert(pushRegistrations)
    .values({
      installationId: input.installationId,
      provider: input.provider,
      userId: input.userId,
      serverId: input.serverId,
      sessionFamilyId: input.sessionFamilyId,
      deviceToken: input.deviceToken,
      topic: input.topic,
      env: input.env,
      appVersion: input.appVersion ?? null,
      ...(input.previewMode ? { previewMode: input.previewMode } : {}),
      revokedAt: null,
      revokedReason: null,
      revokedUserId: null,
      updatedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: [pushRegistrations.installationId, pushRegistrations.provider],
      set: {
        userId: input.userId,
        serverId: input.serverId,
        sessionFamilyId: input.sessionFamilyId,
        deviceToken: input.deviceToken,
        topic: input.topic,
        env: input.env,
        appVersion: input.appVersion ?? null,
        // An older client re-registering without the field keeps the device's choice.
        ...(input.previewMode ? { previewMode: input.previewMode } : {}),
        revokedAt: null,
        revokedReason: null,
        // Bound again: user_id is authoritative; keeping the old diagnostic copy
        // would make an active row look revoked.
        revokedUserId: null,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  addTraceEvent("push.registration.upserted", {
    registration_id: row.id,
    provider: input.provider,
    env: input.env,
    server_id: input.serverId,
    user_id: input.userId,
    preview_mode: row.previewMode,
  });

  return row;
}

// Keep who the row belonged to when a revoke/unbind clears user_id (diagnostics
// only). SET reads the pre-update row; a row already unbound keeps its earlier value.
function previousUserIdForDiagnostics() {
  return sql<string | null>`coalesce(${pushRegistrations.userId}, ${pushRegistrations.revokedUserId})`;
}

export async function unbindPushInstallation(
  input: { installationId: string; userId: string; serverId: string },
  executor: DatabaseExecutor = getDb(),
): Promise<number> {
  const result = await executor
    .update(pushRegistrations)
    .set({
      userId: null,
      revokedUserId: previousUserIdForDiagnostics(),
      serverId: null,
      sessionFamilyId: null,
      updatedAt: sql`now()`,
    })
    .where(and(
      eq(pushRegistrations.installationId, input.installationId),
      eq(pushRegistrations.userId, input.userId),
      eq(pushRegistrations.serverId, input.serverId),
    ))
    .returning({ id: pushRegistrations.id });

  addTraceEvent("push.registration.unbound", {
    server_id: input.serverId,
    user_id: input.userId,
    unbound_count: result.length,
  });

  return result.length;
}

export async function revokePushRegistration(
  input: { registrationId: string; reason: string },
  executor: DatabaseExecutor = getDb(),
): Promise<void> {
  await executor
    .update(pushRegistrations)
    .set({
      userId: null,
      revokedUserId: previousUserIdForDiagnostics(),
      serverId: null,
      revokedAt: sql`now()`,
      revokedReason: input.reason,
      updatedAt: sql`now()`,
    })
    .where(eq(pushRegistrations.id, input.registrationId));

  addTraceEvent("push.registration.revoked", {
    registration_id: input.registrationId,
    reason: input.reason,
  });
}

export interface MobilePushServerDeliveryStatus {
  fcmActive: boolean;
}

export interface MobilePushDeliveryStatus {
  servers: Record<string, MobilePushServerDeliveryStatus>;
  /**
   * This installation holds a live FCM registration for the user (not revoked,
   * session family live with an unexpired session), whatever the FCM
   * configuration says. Lets the app tell "not registered" from "registered
   * but not delivering".
   */
  fcmRegistered: boolean;
}

/**
 * For each server the user belongs to: will this installation get pushes through
 * FCM right now? The Android app raises its own tray notification from the live
 * connection only where this is false, so a device never gets both. True needs
 * FCM configured and a live FCM registration of this installation for the user.
 */
export async function mobilePushDeliveryStatus(
  input: { userId: string; installationId: string },
  executor: DatabaseExecutor = getDb(),
): Promise<MobilePushDeliveryStatus> {
  const [registration] = await executor
    .select({ id: pushRegistrations.id })
    .from(pushRegistrations)
    .innerJoin(sessionFamilies, and(
      eq(pushRegistrations.sessionFamilyId, sessionFamilies.id),
      isNull(sessionFamilies.revokedAt),
    ))
    .where(and(
      eq(pushRegistrations.installationId, input.installationId),
      eq(pushRegistrations.provider, "fcm"),
      eq(pushRegistrations.userId, input.userId),
      isNull(pushRegistrations.revokedAt),
      exists(
        executor
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(
            eq(sessions.familyId, sessionFamilies.id),
            gt(sessions.expiresAt, currentDate()),
          )),
      ),
    ))
    .limit(1);
  const fcmRegistered = registration !== undefined;

  const memberships = await executor
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(eq(serverMembers.userId, input.userId));
  const serverIds = [...new Set(memberships.map((membership) => membership.serverId))];
  const inactive = () => ({
    servers: Object.fromEntries(serverIds.map((serverId) => [serverId, { fcmActive: false }])),
    fcmRegistered,
  });
  if (serverIds.length === 0) return inactive();
  if (!fcmTransport.isConfigured()) return inactive();
  if (!fcmRegistered) return inactive();
  // FCM is on for every server (the rollout flag is retired).
  return {
    servers: Object.fromEntries(serverIds.map((serverId) => [serverId, { fcmActive: true }])),
    fcmRegistered,
  };
}

