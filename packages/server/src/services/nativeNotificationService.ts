import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";

import { getDb } from "../db/index.js";
import {
  nativeNotificationCredentials,
  nativeNotificationDevices,
  nativeNotificationEnrollmentGrants,
  nativeNotificationEvents,
  sessionFamilies,
} from "../db/schema.js";

export const NATIVE_NOTIFICATION_PROTOCOL_VERSION = 1 as const;
export const NATIVE_NOTIFICATION_SCOPE = "notifications:stream" as const;
export const NATIVE_NOTIFICATION_REPLAY_LIMIT = 512;
export const NATIVE_NOTIFICATION_RETENTION_MS = 24 * 60 * 60 * 1000;
export const NATIVE_NOTIFICATION_GRANT_TTL_MS = 60 * 1000;
export const NATIVE_NOTIFICATION_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const APP_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+()-]{0,63}$/;
const APP_ID_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9-]+){2,7}$/;

type ReleaseChannel = "development" | "staging" | "production";
type AttestationState = "missing" | "observed" | "verified" | "rejected";
let attestationVerifierForTests: ((evidence: string) => boolean) | null = null;

export function isNativeNotificationEnabled(): boolean {
  const configured = process.env.SLOCK_NATIVE_NOTIFICATIONS_ENABLED;
  if (configured !== undefined) return configured === "true";
  return process.env.NODE_ENV === "test";
}

export type NotificationIntentV1 = {
  recipientUserId: string;
  eventKey: string;
  serverId: string;
  kind: "channel" | "dm" | "thread";
  channelId: string;
  threadId: string | null;
  parentChannelId: string | null;
  parentMessageId: string | null;
  messageId: string;
  title: string;
  body: string;
  createdAt: Date;
};

export type NotificationIntentTarget = {
  userId: string;
  payload: { title: string; body: string };
  identity: {
    serverId: string;
    kind: "channel" | "dm" | "thread";
    channelId: string | null;
    threadId: string | null;
    parentChannelId: string | null;
    parentMessageId: string | null;
    messageId: string;
  };
};

export type NativeNotificationEventV1 = {
  version: 1;
  eventId: string;
  title: string;
  body: string;
  targetUri: string;
  serverId: string;
  createdAt: string;
};

export class NativeNotificationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NativeNotificationError";
  }
}

function fail(status: number, code: string, message: string): never {
  throw new NativeNotificationError(status, code, message);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function scalarSlice(value: string, max: number): string {
  return [...value].slice(0, max).join("");
}

function boundedText(value: string, max: number, fallback: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return scalarSlice(normalized || fallback, max);
}

function parseBase64Url(value: unknown, minBytes: number, maxBytes: number): Buffer | null {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) return null;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length < minBytes || bytes.length > maxBytes || bytes.toString("base64url") !== value) return null;
    return bytes;
  } catch {
    return null;
  }
}

function safeHashEqual(expectedHex: string, actualHex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(expectedHex) || !/^[0-9a-f]{64}$/.test(actualHex)) return false;
  return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(actualHex, "hex"));
}

function parseOpaqueCredential(value: unknown, prefix: "rng1" | "rnc1"): { id: string; secret: string } | null {
  if (typeof value !== "string" || value.length > 160) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== prefix || !UUID_PATTERN.test(parts[1] ?? "")) return null;
  const secret = parts[2] ?? "";
  if (!parseBase64Url(secret, 32, 32)) return null;
  return { id: parts[1]!, secret };
}

function mintOpaqueCredential(prefix: "rng1" | "rnc1", id: string): { opaque: string; secretHash: string } {
  const secret = randomBytes(32).toString("base64url");
  return { opaque: `${prefix}.${id}.${secret}`, secretHash: sha256(secret) };
}

function isLiveFamily(
  family: { userId: string; revokedAt: Date | null } | undefined,
  userId: string,
): boolean {
  return Boolean(
    family
      && family.userId === userId
      && family.revokedAt === null,
  );
}

export function resolveNotificationIntents(
  targets: readonly NotificationIntentTarget[],
  createdAt: Date,
): NotificationIntentV1[] {
  return targets.map(({ userId, payload, identity }) => {
    if (!identity.channelId) fail(500, "notification_intent_invalid", "Notification target is incomplete");
    return {
      recipientUserId: userId,
      eventKey: `native-notification:v1:${userId}:${identity.serverId}:${identity.messageId}`,
      serverId: identity.serverId,
      kind: identity.kind,
      channelId: identity.channelId,
      threadId: identity.threadId,
      parentChannelId: identity.parentChannelId,
      parentMessageId: identity.parentMessageId,
      messageId: identity.messageId,
      title: boundedText(payload.title, 160, "Raft"),
      body: boundedText(payload.body, 512, "New message"),
      createdAt,
    };
  });
}

export function buildNativeTargetUri(intent: NotificationIntentV1): string {
  const ids = [intent.serverId, intent.channelId, intent.messageId];
  if (!ids.every((id) => UUID_PATTERN.test(id))) {
    fail(500, "notification_intent_invalid", "Notification target contains a non-canonical ID");
  }
  if (intent.kind === "dm") {
    return `raft://v1/servers/${intent.serverId}/dms/${intent.channelId}/messages/${intent.messageId}`;
  }
  if (intent.kind === "thread") {
    if (
      !intent.threadId
      || !intent.parentChannelId
      || !intent.parentMessageId
      || ![intent.threadId, intent.parentChannelId, intent.parentMessageId].every((id) => UUID_PATTERN.test(id))
    ) {
      fail(500, "notification_intent_invalid", "Thread notification target is incomplete");
    }
    return `raft://v1/servers/${intent.serverId}/channels/${intent.parentChannelId}/threads/${intent.threadId}?parentMessageId=${intent.parentMessageId}&messageId=${intent.messageId}`;
  }
  return `raft://v1/servers/${intent.serverId}/channels/${intent.channelId}/messages/${intent.messageId}`;
}

export async function persistNativeNotificationIntents(intents: readonly NotificationIntentV1[]): Promise<number> {
  if (!isNativeNotificationEnabled() || intents.length === 0) return 0;
  const now = currentDate();
  const recipientIds = [...new Set(intents.map((intent) => intent.recipientUserId))];
  const liveBindings = await getDb().select({ userId: nativeNotificationDevices.userId })
    .from(nativeNotificationDevices)
    .innerJoin(nativeNotificationCredentials, and(
      eq(nativeNotificationCredentials.deviceId, nativeNotificationDevices.id),
      eq(nativeNotificationCredentials.sessionFamilyId, nativeNotificationDevices.originSessionFamilyId),
      eq(nativeNotificationCredentials.userId, nativeNotificationDevices.userId),
    ))
    .innerJoin(sessionFamilies, and(
      eq(sessionFamilies.id, nativeNotificationCredentials.sessionFamilyId),
      eq(sessionFamilies.userId, nativeNotificationDevices.userId),
    ))
    .where(and(
      inArray(nativeNotificationDevices.userId, recipientIds),
      isNull(nativeNotificationDevices.revokedAt),
      isNull(nativeNotificationCredentials.revokedAt),
      eq(nativeNotificationCredentials.scope, NATIVE_NOTIFICATION_SCOPE),
      gt(nativeNotificationCredentials.expiresAt, now),
      isNull(sessionFamilies.revokedAt),
    ))
    .groupBy(nativeNotificationDevices.userId);
  const liveUserIds = new Set(liveBindings.map((binding) => binding.userId));
  const rows = intents.filter((intent) => liveUserIds.has(intent.recipientUserId)).map((intent) => ({
    recipientUserId: intent.recipientUserId,
    serverId: intent.serverId,
    messageId: intent.messageId,
    dedupeKey: intent.eventKey,
    version: 1,
    title: intent.title,
    body: intent.body,
    targetUri: buildNativeTargetUri(intent),
    createdAt: intent.createdAt,
    expiresAt: new Date(Math.max(now.getTime(), intent.createdAt.getTime()) + NATIVE_NOTIFICATION_RETENTION_MS),
  }));
  if (rows.length === 0) return 0;
  const inserted = await getDb()
    .insert(nativeNotificationEvents)
    .values(rows)
    .onConflictDoNothing({ target: nativeNotificationEvents.dedupeKey })
    .returning({ eventId: nativeNotificationEvents.eventId });
  return inserted.length;
}

type EnrollmentGrantInput = {
  appId: unknown;
  protocolVersion: unknown;
  appVersion: unknown;
  releaseChannel: unknown;
  appInstanceId: unknown;
  publicKey: unknown;
  nonce: unknown;
  attestation?: unknown;
};

function evaluateAttestation(value: unknown): { state: AttestationState; evidenceHash: string | null } {
  const evidence = typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : null;
  const evidenceHash = evidence ? sha256(evidence) : null;
  const configuredMode = process.env.NATIVE_NOTIFICATION_ATTESTATION_MODE;
  const enforce = process.env.NODE_ENV === "production"
    || configuredMode === "enforce"
    || (configuredMode !== undefined && configuredMode !== "observe");
  // There is deliberately no environment-variable digest allowlist: that
  // would turn replayable evidence into a production attestation bypass. The
  // production verifier is not part of this staging-first slice, so enforce
  // mode fails closed. Tests get a process-local seam that is unavailable in
  // non-test runtimes.
  const verified = evidence !== null && attestationVerifierForTests?.(evidence) === true;
  if (enforce && !verified) return { state: "rejected", evidenceHash };
  if (verified) return { state: "verified", evidenceHash };
  return { state: evidence ? "observed" : "missing", evidenceHash };
}

export function __setNativeNotificationAttestationVerifierForTests(verifier: ((evidence: string) => boolean) | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Test-only attestation verifier is unavailable");
  attestationVerifierForTests = verifier;
}

function parseGrantInput(input: EnrollmentGrantInput) {
  const officialAppId = process.env.NATIVE_NOTIFICATION_APP_ID ?? "ai.slock.desktop";
  if (typeof input.appId !== "string" || input.appId !== officialAppId || !APP_ID_PATTERN.test(input.appId)) {
    fail(400, "invalid_enrollment_request", "Invalid desktop application ID");
  }
  if (input.protocolVersion !== NATIVE_NOTIFICATION_PROTOCOL_VERSION) {
    fail(400, "unsupported_notification_protocol", "Unsupported notification protocol version");
  }
  if (typeof input.appVersion !== "string" || !APP_VERSION_PATTERN.test(input.appVersion)) {
    fail(400, "invalid_enrollment_request", "Invalid desktop application version");
  }
  if (input.releaseChannel !== "development" && input.releaseChannel !== "staging" && input.releaseChannel !== "production") {
    fail(400, "invalid_enrollment_request", "Invalid release channel");
  }
  if (typeof input.appInstanceId !== "string" || !UUID_PATTERN.test(input.appInstanceId)) {
    fail(400, "invalid_enrollment_request", "Invalid application instance ID");
  }
  const publicKeyBytes = parseBase64Url(input.publicKey, 32, 128);
  const nonceBytes = parseBase64Url(input.nonce, 32, 32);
  if (!publicKeyBytes || !nonceBytes) {
    fail(400, "invalid_enrollment_request", "Invalid native key challenge");
  }
  try {
    const key = createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
  } catch {
    fail(400, "invalid_enrollment_request", "Invalid Ed25519 public key");
  }
  const attestation = evaluateAttestation(input.attestation);
  if (attestation.state === "rejected") {
    fail(403, "desktop_attestation_required", "Desktop application attestation is required");
  }
  return {
    appId: input.appId,
    protocolVersion: NATIVE_NOTIFICATION_PROTOCOL_VERSION,
    appVersion: input.appVersion,
    releaseChannel: input.releaseChannel as ReleaseChannel,
    appInstanceId: input.appInstanceId,
    publicKey: input.publicKey as string,
    nonce: input.nonce as string,
    attestation,
  };
}

export async function issueEnrollmentGrant(input: {
  userId: string;
  sessionFamilyId: string;
  request: EnrollmentGrantInput;
  now?: Date;
}): Promise<{ grant: string; expiresAt: string }> {
  const now = input.now ?? currentDate();
  const [family] = await getDb().select({
    userId: sessionFamilies.userId,
    revokedAt: sessionFamilies.revokedAt,
  }).from(sessionFamilies).where(eq(sessionFamilies.id, input.sessionFamilyId)).limit(1);
  if (!isLiveFamily(family, input.userId)) {
    fail(401, "session_family_inactive", "Session family is no longer active");
  }
  const request = parseGrantInput(input.request);
  const id = randomUUID();
  const minted = mintOpaqueCredential("rng1", id);
  const expiresAt = new Date(now.getTime() + NATIVE_NOTIFICATION_GRANT_TTL_MS);
  await getDb().insert(nativeNotificationEnrollmentGrants).values({
    id,
    userId: input.userId,
    sessionFamilyId: input.sessionFamilyId,
    secretHash: minted.secretHash,
    appId: request.appId,
    protocolVersion: request.protocolVersion,
    appVersion: request.appVersion,
    releaseChannel: request.releaseChannel,
    appInstanceId: request.appInstanceId,
    publicKey: request.publicKey,
    nonce: request.nonce,
    attestationState: request.attestation.state,
    attestationEvidenceHash: request.attestation.evidenceHash,
    expiresAt,
    createdAt: now,
  });
  return { grant: minted.opaque, expiresAt: expiresAt.toISOString() };
}

export async function isActiveNativeNotificationSessionFamily(
  userId: string,
  familyId: string | undefined,
): Promise<boolean> {
  if (!familyId) return false;
  const [family] = await getDb().select({
    userId: sessionFamilies.userId,
    revokedAt: sessionFamilies.revokedAt,
  }).from(sessionFamilies).where(eq(sessionFamilies.id, familyId)).limit(1);
  return isLiveFamily(family, userId);
}

export function buildEnrollmentProofTranscript(grant: string, binding: {
  appId: string;
  protocolVersion: number;
  appVersion: string;
  releaseChannel: string;
  appInstanceId: string;
  publicKey: string;
  nonce: string;
}): Buffer {
  return Buffer.from([
    "raft-desktop-notification-enrollment-v1",
    sha256(grant),
    binding.appId,
    String(binding.protocolVersion),
    binding.appVersion,
    binding.releaseChannel,
    binding.appInstanceId,
    binding.publicKey,
    binding.nonce,
  ].join("\0"));
}

function verifyEd25519Proof(publicKey: string, transcript: Buffer, proof: unknown): boolean {
  const signature = parseBase64Url(proof, 64, 64);
  if (!signature) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" && verifySignature(null, transcript, key, signature);
  } catch {
    return false;
  }
}

export async function exchangeEnrollmentGrant(input: {
  grant: unknown;
  proof: unknown;
  now?: Date;
}): Promise<{ credential: string; credentialId: string; deviceId: string; scope: typeof NATIVE_NOTIFICATION_SCOPE; expiresAt: string }> {
  const parsed = parseOpaqueCredential(input.grant, "rng1");
  if (!parsed) fail(400, "invalid_enrollment_exchange", "Invalid enrollment exchange");
  const now = input.now ?? currentDate();
  return getDb().transaction(async (tx) => {
    const [grant] = await tx.select().from(nativeNotificationEnrollmentGrants)
      .where(eq(nativeNotificationEnrollmentGrants.id, parsed.id)).for("update").limit(1);
    if (
      !grant
      || !safeHashEqual(grant.secretHash, sha256(parsed.secret))
      || grant.consumedAt
      || grant.revokedAt
      || grant.expiresAt <= now
      || grant.attestationState === "rejected"
    ) {
      fail(403, "enrollment_exchange_denied", "Enrollment exchange denied");
    }
    const [family] = await tx.select({
      userId: sessionFamilies.userId,
      revokedAt: sessionFamilies.revokedAt,
    }).from(sessionFamilies).where(eq(sessionFamilies.id, grant.sessionFamilyId)).limit(1);
    if (!isLiveFamily(family, grant.userId)) {
      fail(403, "enrollment_exchange_denied", "Enrollment exchange denied");
    }
    const transcript = buildEnrollmentProofTranscript(input.grant as string, grant);
    if (!verifyEd25519Proof(grant.publicKey, transcript, input.proof)) {
      fail(403, "enrollment_exchange_denied", "Enrollment exchange denied");
    }

    const [existingDevice] = await tx.select().from(nativeNotificationDevices).where(and(
      eq(nativeNotificationDevices.userId, grant.userId),
      eq(nativeNotificationDevices.appId, grant.appId),
      eq(nativeNotificationDevices.appInstanceId, grant.appInstanceId),
      isNull(nativeNotificationDevices.revokedAt),
    )).for("update").limit(1);

    let deviceId: string;
    if (existingDevice) {
      deviceId = existingDevice.id;
      await tx.update(nativeNotificationCredentials).set({ revokedAt: now, revokedReason: "reenrolled" })
        .where(and(eq(nativeNotificationCredentials.deviceId, deviceId), isNull(nativeNotificationCredentials.revokedAt)));
      await tx.update(nativeNotificationDevices).set({
        originSessionFamilyId: grant.sessionFamilyId,
        protocolVersion: grant.protocolVersion,
        appVersion: grant.appVersion,
        releaseChannel: grant.releaseChannel,
        publicKey: grant.publicKey,
        attestationState: grant.attestationState,
        attestationEvidenceHash: grant.attestationEvidenceHash,
        lastSeenAt: now,
        updatedAt: now,
      }).where(eq(nativeNotificationDevices.id, deviceId));
    } else {
      const [device] = await tx.insert(nativeNotificationDevices).values({
        userId: grant.userId,
        originSessionFamilyId: grant.sessionFamilyId,
        appId: grant.appId,
        protocolVersion: grant.protocolVersion,
        appVersion: grant.appVersion,
        releaseChannel: grant.releaseChannel,
        appInstanceId: grant.appInstanceId,
        publicKey: grant.publicKey,
        attestationState: grant.attestationState,
        attestationEvidenceHash: grant.attestationEvidenceHash,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      }).returning({ id: nativeNotificationDevices.id });
      deviceId = device!.id;
    }

    const credentialId = randomUUID();
    const minted = mintOpaqueCredential("rnc1", credentialId);
    const expiresAt = new Date(now.getTime() + NATIVE_NOTIFICATION_CREDENTIAL_TTL_MS);
    await tx.insert(nativeNotificationCredentials).values({
      id: credentialId,
      deviceId,
      userId: grant.userId,
      sessionFamilyId: grant.sessionFamilyId,
      secretHash: minted.secretHash,
      scope: NATIVE_NOTIFICATION_SCOPE,
      expiresAt,
      createdAt: now,
    });
    const consumed = await tx.update(nativeNotificationEnrollmentGrants).set({ consumedAt: now }).where(and(
      eq(nativeNotificationEnrollmentGrants.id, grant.id),
      isNull(nativeNotificationEnrollmentGrants.consumedAt),
    )).returning({ id: nativeNotificationEnrollmentGrants.id });
    if (consumed.length !== 1) fail(403, "enrollment_exchange_denied", "Enrollment exchange denied");
    return {
      credential: minted.opaque,
      credentialId,
      deviceId,
      scope: NATIVE_NOTIFICATION_SCOPE,
      expiresAt: expiresAt.toISOString(),
    };
  });
}

export type NativeCredentialPrincipal = {
  credentialId: string;
  deviceId: string;
  userId: string;
  sessionFamilyId: string;
  publicKey: string;
  scope: typeof NATIVE_NOTIFICATION_SCOPE;
  expiresAt: Date;
};

export async function authenticateNativeCredential(
  opaque: unknown,
  options: { now?: Date; recordUse?: boolean } = {},
): Promise<NativeCredentialPrincipal | null> {
  const parsed = parseOpaqueCredential(opaque, "rnc1");
  if (!parsed) return null;
  const now = options.now ?? currentDate();
  const [row] = await getDb().select({
    credentialId: nativeNotificationCredentials.id,
    deviceId: nativeNotificationCredentials.deviceId,
    userId: nativeNotificationCredentials.userId,
    sessionFamilyId: nativeNotificationCredentials.sessionFamilyId,
    secretHash: nativeNotificationCredentials.secretHash,
    scope: nativeNotificationCredentials.scope,
    expiresAt: nativeNotificationCredentials.expiresAt,
    publicKey: nativeNotificationDevices.publicKey,
    deviceRevokedAt: nativeNotificationDevices.revokedAt,
    familyUserId: sessionFamilies.userId,
    familyRevokedAt: sessionFamilies.revokedAt,
  }).from(nativeNotificationCredentials)
    .innerJoin(nativeNotificationDevices, eq(nativeNotificationDevices.id, nativeNotificationCredentials.deviceId))
    .innerJoin(sessionFamilies, eq(sessionFamilies.id, nativeNotificationCredentials.sessionFamilyId))
    .where(and(
      eq(nativeNotificationCredentials.id, parsed.id),
      eq(nativeNotificationDevices.originSessionFamilyId, nativeNotificationCredentials.sessionFamilyId),
      isNull(nativeNotificationCredentials.revokedAt),
      gt(nativeNotificationCredentials.expiresAt, now),
    )).limit(1);
  if (
    !row
    || row.scope !== NATIVE_NOTIFICATION_SCOPE
    || row.deviceRevokedAt
    || !safeHashEqual(row.secretHash, sha256(parsed.secret))
    || !isLiveFamily({
      userId: row.familyUserId,
      revokedAt: row.familyRevokedAt,
    }, row.userId)
  ) return null;
  if (options.recordUse !== false) {
    await getDb().update(nativeNotificationCredentials).set({ lastUsedAt: now })
      .where(eq(nativeNotificationCredentials.id, row.credentialId));
    await getDb().update(nativeNotificationDevices).set({ lastSeenAt: now, updatedAt: now })
      .where(eq(nativeNotificationDevices.id, row.deviceId));
  }
  return {
    credentialId: row.credentialId,
    deviceId: row.deviceId,
    userId: row.userId,
    sessionFamilyId: row.sessionFamilyId,
    publicKey: row.publicKey,
    scope: NATIVE_NOTIFICATION_SCOPE,
    expiresAt: row.expiresAt,
  };
}

export function buildRotationProofTranscript(credential: string, deviceId: string): Buffer {
  return Buffer.from(["raft-desktop-notification-rotation-v1", sha256(credential), deviceId].join("\0"));
}

export async function rotateNativeCredential(input: { credential: unknown; proof: unknown; now?: Date }) {
  const principal = await authenticateNativeCredential(input.credential, { now: input.now, recordUse: false });
  if (!principal || typeof input.credential !== "string") fail(401, "native_credential_invalid", "Invalid native notification credential");
  if (!verifyEd25519Proof(principal.publicKey, buildRotationProofTranscript(input.credential, principal.deviceId), input.proof)) {
    fail(403, "native_credential_proof_invalid", "Invalid native notification credential proof");
  }
  const now = input.now ?? currentDate();
  return getDb().transaction(async (tx) => {
    const [current] = await tx.select().from(nativeNotificationCredentials).where(and(
      eq(nativeNotificationCredentials.id, principal.credentialId),
      isNull(nativeNotificationCredentials.revokedAt),
      gt(nativeNotificationCredentials.expiresAt, now),
    )).for("update").limit(1);
    if (!current) fail(401, "native_credential_invalid", "Invalid native notification credential");
    const revoked = await tx.update(nativeNotificationCredentials).set({ revokedAt: now, revokedReason: "rotated" }).where(and(
      eq(nativeNotificationCredentials.id, current.id),
      isNull(nativeNotificationCredentials.revokedAt),
    )).returning({ id: nativeNotificationCredentials.id });
    if (revoked.length !== 1) fail(401, "native_credential_invalid", "Invalid native notification credential");
    const credentialId = randomUUID();
    const minted = mintOpaqueCredential("rnc1", credentialId);
    const expiresAt = new Date(now.getTime() + NATIVE_NOTIFICATION_CREDENTIAL_TTL_MS);
    await tx.insert(nativeNotificationCredentials).values({
      id: credentialId,
      deviceId: current.deviceId,
      userId: current.userId,
      sessionFamilyId: current.sessionFamilyId,
      secretHash: minted.secretHash,
      scope: NATIVE_NOTIFICATION_SCOPE,
      expiresAt,
      rotatedFromId: current.id,
      createdAt: now,
    });
    return { credential: minted.opaque, credentialId, deviceId: current.deviceId, scope: NATIVE_NOTIFICATION_SCOPE, expiresAt: expiresAt.toISOString() };
  });
}

export async function revokeCurrentNativeCredential(opaque: unknown, now = currentDate()): Promise<boolean> {
  const principal = await authenticateNativeCredential(opaque, { now, recordUse: false });
  if (!principal) return false;
  await getDb().update(nativeNotificationCredentials).set({ revokedAt: now, revokedReason: "self_revoked" })
    .where(and(eq(nativeNotificationCredentials.id, principal.credentialId), isNull(nativeNotificationCredentials.revokedAt)));
  return true;
}

export async function listNativeNotificationDevices(userId: string, now = currentDate()) {
  const rows = await getDb().select({
    id: nativeNotificationDevices.id,
    appId: nativeNotificationDevices.appId,
    protocolVersion: nativeNotificationDevices.protocolVersion,
    appVersion: nativeNotificationDevices.appVersion,
    releaseChannel: nativeNotificationDevices.releaseChannel,
    appInstanceId: nativeNotificationDevices.appInstanceId,
    attestationState: nativeNotificationDevices.attestationState,
    lastSeenAt: nativeNotificationDevices.lastSeenAt,
    revokedAt: nativeNotificationDevices.revokedAt,
    createdAt: nativeNotificationDevices.createdAt,
    credentialExpiresAt: nativeNotificationCredentials.expiresAt,
    familyUserId: sessionFamilies.userId,
    familyRevokedAt: sessionFamilies.revokedAt,
  }).from(nativeNotificationDevices)
    .leftJoin(nativeNotificationCredentials, and(
      eq(nativeNotificationCredentials.deviceId, nativeNotificationDevices.id),
      isNull(nativeNotificationCredentials.revokedAt),
    ))
    .leftJoin(sessionFamilies, eq(sessionFamilies.id, nativeNotificationDevices.originSessionFamilyId))
    .where(eq(nativeNotificationDevices.userId, userId))
    .orderBy(desc(nativeNotificationDevices.createdAt));
  return rows.slice(0, 100).map((row) => ({
    deviceId: row.id,
    appId: row.appId,
    protocolVersion: row.protocolVersion,
    appVersion: row.appVersion,
    releaseChannel: row.releaseChannel,
    appInstanceId: row.appInstanceId,
    attestationState: row.attestationState,
    status: row.revokedAt && row.revokedAt <= now
      ? "revoked"
      : row.credentialExpiresAt && row.credentialExpiresAt > now && isLiveFamily({
        userId: row.familyUserId ?? "",
        revokedAt: row.familyRevokedAt ?? null,
      }, userId)
        ? "active"
        : "inactive",
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function revokeNativeNotificationDevice(userId: string, deviceId: string, now = currentDate()): Promise<boolean> {
  if (!UUID_PATTERN.test(deviceId)) return false;
  return getDb().transaction(async (tx) => {
    const revoked = await tx.update(nativeNotificationDevices).set({
      revokedAt: now,
      revokedReason: "user_revoked",
      updatedAt: now,
    }).where(and(
      eq(nativeNotificationDevices.id, deviceId),
      eq(nativeNotificationDevices.userId, userId),
      isNull(nativeNotificationDevices.revokedAt),
    )).returning({ id: nativeNotificationDevices.id });
    if (revoked.length === 0) return false;
    await tx.update(nativeNotificationCredentials).set({ revokedAt: now, revokedReason: "device_revoked" })
      .where(and(eq(nativeNotificationCredentials.deviceId, deviceId), isNull(nativeNotificationCredentials.revokedAt)));
    return true;
  });
}

function serializeEvent(row: typeof nativeNotificationEvents.$inferSelect): NativeNotificationEventV1 {
  return {
    version: 1,
    eventId: row.eventId,
    title: row.title,
    body: row.body,
    targetUri: row.targetUri,
    serverId: row.serverId,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function prepareNativeNotificationReplay(userId: string, lastEventId: string | undefined, now = currentDate()) {
  if (!lastEventId) {
    const [latest] = await getDb().select({ streamSeq: nativeNotificationEvents.streamSeq })
      .from(nativeNotificationEvents)
      .where(and(eq(nativeNotificationEvents.recipientUserId, userId), gt(nativeNotificationEvents.expiresAt, now)))
      .orderBy(desc(nativeNotificationEvents.streamSeq)).limit(1);
    return { cursorSeq: latest?.streamSeq ?? 0, replay: [] as Array<{ streamSeq: number; event: NativeNotificationEventV1 }> };
  }
  if (!UUID_PATTERN.test(lastEventId)) fail(409, "replay_cursor_unavailable", "Replay cursor is unavailable");
  const [cursor] = await getDb().select({ streamSeq: nativeNotificationEvents.streamSeq })
    .from(nativeNotificationEvents)
    .where(and(
      eq(nativeNotificationEvents.eventId, lastEventId),
      eq(nativeNotificationEvents.recipientUserId, userId),
      gt(nativeNotificationEvents.expiresAt, now),
    )).limit(1);
  if (!cursor) fail(409, "replay_cursor_unavailable", "Replay cursor is unavailable");
  const rows = await getDb().select().from(nativeNotificationEvents).where(and(
    eq(nativeNotificationEvents.recipientUserId, userId),
    gt(nativeNotificationEvents.streamSeq, cursor.streamSeq),
    gt(nativeNotificationEvents.expiresAt, now),
  )).orderBy(asc(nativeNotificationEvents.streamSeq)).limit(NATIVE_NOTIFICATION_REPLAY_LIMIT + 1);
  if (rows.length > NATIVE_NOTIFICATION_REPLAY_LIMIT) {
    fail(409, "replay_window_exceeded", "Replay window exceeded");
  }
  return { cursorSeq: cursor.streamSeq, replay: rows.map((row) => ({ streamSeq: row.streamSeq, event: serializeEvent(row) })) };
}

export async function readNativeNotificationEventsAfter(userId: string, cursorSeq: number, now = currentDate()) {
  const rows = await getDb().select().from(nativeNotificationEvents).where(and(
    eq(nativeNotificationEvents.recipientUserId, userId),
    gt(nativeNotificationEvents.streamSeq, cursorSeq),
    gt(nativeNotificationEvents.expiresAt, now),
  )).orderBy(asc(nativeNotificationEvents.streamSeq)).limit(NATIVE_NOTIFICATION_REPLAY_LIMIT + 1);
  if (rows.length > NATIVE_NOTIFICATION_REPLAY_LIMIT) {
    fail(409, "replay_window_exceeded", "Replay window exceeded");
  }
  return rows.map((row) => ({ streamSeq: row.streamSeq, event: serializeEvent(row) }));
}
