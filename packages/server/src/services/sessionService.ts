import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, notExists, sql } from "drizzle-orm";
import { AUTH_REFRESH_ROTATED_REPLAY_GRACE_MS, currentDate, setClockTimeout } from "@botiverse/raft-shared";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { getDb, type DatabaseExecutor } from "../db/index";
import {
  accountDeletionRequests,
  appLoginRequests,
  deviceAuthorizations,
  deviceLoginGrants,
  oauthAccessRequests,
  sessionFamilies,
  sessionRefreshRotationReceipts,
  sessionTokenPredecessors,
  sessions,
  users,
  type SessionScope,
  type RequestSessionScope,
} from "../db/schema";
import { getRedis, isRedisAvailable } from "../redis";
import { revokeSocketAccess } from "../socket/accessRevocation";
import { revokeKeysOfRevokedDeviceSessions } from "./deviceSessionKeys";
import type { SessionIssueProof } from "./sessionIssueGate";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { rememberTraceUserId } from "../tracing/traceUserId";

let getDbForService = getDb;
const ROTATED_REFRESH_REPLAY_GRACE_MS = AUTH_REFRESH_ROTATED_REPLAY_GRACE_MS;
const ROTATED_REFRESH_REPLAY_GRACE_TTL_SECONDS = Math.ceil(ROTATED_REFRESH_REPLAY_GRACE_MS / 1_000);
const ROTATED_REFRESH_REPLAY_KEY_PREFIX = "slock:auth:rotated-refresh-replay:";

export type DurableRefreshReplayBinding = {
  attemptId: string;
  installationId: string;
};

type RecentRotation = {
  sessionId?: string;
  familyId: string;
  userId: string;
  refreshToken: string;
  expiresAt: Date;
  replayUntilMs: number;
  rememberedAtMs: number;
};

type RotationReplayPayload = Omit<RecentRotation, "replayUntilMs" | "rememberedAtMs"> & { rememberedAtMs?: number };

export type RefreshReplayLookupResult =
  | "not_needed"
  | "durable_hit"
  | "durable_binding_mismatch"
  | "local_hit"
  | "shared_hit"
  | "miss"
  | "expired"
  | "child_invalid"
  | "superseded"
  | "error";

export type RefreshReplayGraceAgeBucket =
  | "<1s"
  | "1-3s"
  | "3-10s"
  | ">=10s"
  | "unknown";

export type AuthRefreshReplayTrace = {
  replayLookupResult: RefreshReplayLookupResult;
  redisAvailable: boolean;
  graceAgeBucket: RefreshReplayGraceAgeBucket | null;
  /** Set for "superseded": which login lost a rotation (task #72; decides
   * whether reuse detection is worth it). */
  superseded?: { userId: string; familyId: string };
};

export type RefreshedSession = {
  sessionId: string;
  familyId: string;
  userId: string;
  refreshToken: string;
  expiresAt: Date;
  replayedRotation: boolean;
};

export type RefreshSessionWithTraceResult = {
  refreshed: RefreshedSession | null;
  replayTrace: AuthRefreshReplayTrace;
};

type RotationReplayStore = {
  remember(oldTokenHash: string, rotation: RotationReplayPayload): Promise<void>;
  replay(oldTokenHash: string): Promise<RotationReplayPayload | null>;
};

const recentRotationsByOldHash = new Map<string, RecentRotation>();
let sharedReplayStoreForTests: RotationReplayStore | null | undefined;

export function __setSessionServiceDbForTests(mockGetDb: typeof getDb) {
  getDbForService = mockGetDb;
}

export function __setSessionServiceReplayStoreForTests(store: RotationReplayStore | null) {
  sharedReplayStoreForTests = store;
}

export function __getSessionServiceLocalReplayCacheSizeForTests(): number {
  return recentRotationsByOldHash.size;
}

export function __clearSessionServiceLocalReplayCacheForTests() {
  recentRotationsByOldHash.clear();
}

export function __resetSessionServiceDbForTests() {
  getDbForService = getDb;
  sharedReplayStoreForTests = undefined;
  recentRotationsByOldHash.clear();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function lockActiveUser(tx: DatabaseExecutor, userId: string): Promise<boolean> {
  const [user] = await tx.select({ retiredAt: users.retiredAt, traceUserId: users.traceUserId }).from(users)
    .where(eq(users.id, userId)).limit(1).for("update");
  // Same row read: login and refresh spans export the user as trace_user_id
  // (refresh is most of the user-attributed request spans).
  rememberTraceUserId(userId, user?.traceUserId);
  return Boolean(user && !user.retiredAt);
}

type DurableReplayIdentity = DurableRefreshReplayBinding & {
  predecessorTokenHash: string;
  predecessorSessionId: string;
  userId: string;
  familyId: string;
  successorSessionId: string;
};

function durableReplayEncryptionKey(): Buffer {
  const rootSecret = process.env.AUTH_REFRESH_REPLAY_ENCRYPTION_KEY?.trim()
    || process.env.JWT_SECRET?.trim();
  if (!rootSecret) {
    throw new Error("AUTH_REFRESH_REPLAY_ENCRYPTION_KEY or JWT_SECRET is required");
  }
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(rootSecret, "utf8"),
    Buffer.from("slock-session-refresh-rotation-receipt", "utf8"),
    Buffer.from("v1-aes-256-gcm", "utf8"),
    32,
  ));
}

function durableReplayAad(identity: DurableReplayIdentity): Buffer {
  const fields = [
    "v1",
    identity.predecessorTokenHash,
    identity.predecessorSessionId,
    identity.userId,
    identity.familyId,
    identity.successorSessionId,
    identity.attemptId,
    identity.installationId,
  ];
  return Buffer.from(fields.map((field) => `${Buffer.byteLength(field, "utf8")}:${field}`).join("|"), "utf8");
}

function encryptDurableSuccessor(refreshToken: string, identity: DurableReplayIdentity) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", durableReplayEncryptionKey(), iv);
  cipher.setAAD(durableReplayAad(identity));
  const ciphertext = Buffer.concat([cipher.update(refreshToken, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
  };
}

function decryptDurableSuccessor(
  encrypted: { ciphertext: string; iv: string; authTag: string },
  identity: DurableReplayIdentity,
): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    durableReplayEncryptionKey(),
    Buffer.from(encrypted.iv, "base64url"),
  );
  decipher.setAAD(durableReplayAad(identity));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function replayKey(oldTokenHash: string): string {
  return `${ROTATED_REFRESH_REPLAY_KEY_PREFIX}${oldTokenHash}`;
}

function serializeRotation(rotation: RotationReplayPayload): string {
  return JSON.stringify({
    sessionId: rotation.sessionId,
    familyId: rotation.familyId,
    userId: rotation.userId,
    refreshToken: rotation.refreshToken,
    expiresAt: rotation.expiresAt.toISOString(),
    rememberedAtMs: rotation.rememberedAtMs,
  });
}

function parseRotation(raw: string | null): RotationReplayPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<{
      sessionId: unknown;
      familyId: unknown;
      userId: unknown;
      refreshToken: unknown;
      expiresAt: unknown;
      rememberedAtMs: unknown;
    }>;
    if (
      (parsed.sessionId !== undefined && typeof parsed.sessionId !== "string")
      || typeof parsed.familyId !== "string"
      || typeof parsed.userId !== "string"
      || typeof parsed.refreshToken !== "string"
      || typeof parsed.expiresAt !== "string"
      || (parsed.rememberedAtMs !== undefined && typeof parsed.rememberedAtMs !== "number")
    ) {
      return null;
    }
    const expiresAt = new Date(parsed.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) return null;
    return {
      sessionId: parsed.sessionId,
      familyId: parsed.familyId,
      userId: parsed.userId,
      refreshToken: parsed.refreshToken,
      expiresAt,
      rememberedAtMs: Number.isFinite(parsed.rememberedAtMs) ? parsed.rememberedAtMs : undefined,
    };
  } catch {
    return null;
  }
}

function defaultSharedReplayStore(): RotationReplayStore | null {
  if (!isRedisAvailable()) return null;
  return {
    async remember(oldTokenHash, rotation) {
      await getRedis().set(
        replayKey(oldTokenHash),
        serializeRotation(rotation),
        "EX",
        ROTATED_REFRESH_REPLAY_GRACE_TTL_SECONDS,
      );
    },
    async replay(oldTokenHash) {
      return parseRotation(await getRedis().get(replayKey(oldTokenHash)));
    },
  };
}

function sharedReplayStore(): RotationReplayStore | null {
  return sharedReplayStoreForTests === undefined ? defaultSharedReplayStore() : sharedReplayStoreForTests;
}

function sharedReplayStoreInfo(): { store: RotationReplayStore | null; redisAvailable: boolean } {
  if (sharedReplayStoreForTests !== undefined) {
    return {
      store: sharedReplayStoreForTests,
      redisAvailable: sharedReplayStoreForTests !== null,
    };
  }
  return {
    store: defaultSharedReplayStore(),
    redisAvailable: isRedisAvailable(),
  };
}

function replayTrace(
  replayLookupResult: RefreshReplayLookupResult,
  redisAvailable: boolean,
  graceAgeBucket: RefreshReplayGraceAgeBucket | null = null,
): AuthRefreshReplayTrace {
  return { replayLookupResult, redisAvailable, graceAgeBucket };
}

function graceAgeBucket(rotation: Pick<RotationReplayPayload, "rememberedAtMs">): RefreshReplayGraceAgeBucket {
  if (!Number.isFinite(rotation.rememberedAtMs)) return "unknown";
  const ageMs = Date.now() - rotation.rememberedAtMs!;
  if (!Number.isFinite(ageMs) || ageMs < 0) return "unknown";
  if (ageMs < 1_000) return "<1s";
  if (ageMs < 3_000) return "1-3s";
  if (ageMs < ROTATED_REFRESH_REPLAY_GRACE_MS) return "3-10s";
  return ">=10s";
}

function replayPayloadExpired(rotation: Pick<RotationReplayPayload, "rememberedAtMs">): boolean {
  if (!Number.isFinite(rotation.rememberedAtMs)) return false;
  return Date.now() - rotation.rememberedAtMs! > ROTATED_REFRESH_REPLAY_GRACE_MS;
}

async function rememberRotation(oldTokenHash: string, rotation: RotationReplayPayload) {
  const rememberedAtMs = Date.now();
  const rotationWithTimestamp = {
    ...rotation,
    rememberedAtMs: rotation.rememberedAtMs ?? rememberedAtMs,
  };
  recentRotationsByOldHash.set(oldTokenHash, {
    ...rotationWithTimestamp,
    replayUntilMs: rotationWithTimestamp.rememberedAtMs + ROTATED_REFRESH_REPLAY_GRACE_MS,
  });
  // Expire idle entries as well as actively replayed ones. Bound the cache
  // during bursts so token retention cannot grow with process lifetime.
  while (recentRotationsByOldHash.size > 10_000) {
    recentRotationsByOldHash.delete(recentRotationsByOldHash.keys().next().value!);
  }
  const timer = setClockTimeout(() => {
    const cached = recentRotationsByOldHash.get(oldTokenHash);
    if (cached && cached.replayUntilMs <= Date.now()) recentRotationsByOldHash.delete(oldTokenHash);
  }, ROTATED_REFRESH_REPLAY_GRACE_MS + 1);
  if (timer && typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") timer.unref();

  const store = sharedReplayStore();
  if (!store) return;
  try {
    await store.remember(oldTokenHash, rotationWithTimestamp);
  } catch (error) {
    console.warn("[session] failed to persist refresh replay grace", serializeErrorForLog(error));
  }
}

async function replayRecentRotation(oldTokenHash: string): Promise<{
  replay: (RotationReplayPayload & { sessionId: string }) | null;
  trace: AuthRefreshReplayTrace;
}> {
  async function activeRotation(rotation: RotationReplayPayload): Promise<(RotationReplayPayload & { sessionId: string }) | null> {
    const session = await validateSession(rotation.refreshToken);
    if (!session || session.userId !== rotation.userId) return null;
    return {
      ...rotation,
      sessionId: rotation.sessionId ?? session.id,
    };
  }

  const shared = sharedReplayStoreInfo();
  let expiredLocalGraceAgeBucket: RefreshReplayGraceAgeBucket | null = null;
  const rotation = recentRotationsByOldHash.get(oldTokenHash);
  if (rotation) {
    if (rotation.replayUntilMs < Date.now()) {
      expiredLocalGraceAgeBucket = graceAgeBucket(rotation);
      recentRotationsByOldHash.delete(oldTokenHash);
    } else {
      const replay = await activeRotation({
        userId: rotation.userId,
        familyId: rotation.familyId,
        refreshToken: rotation.refreshToken,
        expiresAt: rotation.expiresAt,
        rememberedAtMs: rotation.rememberedAtMs,
      });
      return replay
        ? { replay, trace: replayTrace("local_hit", shared.redisAvailable, graceAgeBucket(rotation)) }
        : { replay: null, trace: replayTrace("child_invalid", shared.redisAvailable, graceAgeBucket(rotation)) };
    }
  }

  if (!shared.store) {
    return {
      replay: null,
      trace: replayTrace(expiredLocalGraceAgeBucket ? "expired" : "miss", shared.redisAvailable, expiredLocalGraceAgeBucket),
    };
  }
  try {
    const sharedRotation = await shared.store.replay(oldTokenHash);
    if (!sharedRotation) {
      return {
        replay: null,
        trace: replayTrace(expiredLocalGraceAgeBucket ? "expired" : "miss", shared.redisAvailable, expiredLocalGraceAgeBucket),
      };
    }
    const bucket = graceAgeBucket(sharedRotation);
    if (replayPayloadExpired(sharedRotation)) {
      return { replay: null, trace: replayTrace("expired", shared.redisAvailable, bucket) };
    }
    const replay = await activeRotation(sharedRotation);
    return replay
      ? { replay, trace: replayTrace("shared_hit", shared.redisAvailable, bucket) }
      : { replay: null, trace: replayTrace("child_invalid", shared.redisAvailable, bucket) };
  } catch (error) {
    console.warn("[session] failed to read refresh replay grace", serializeErrorForLog(error));
    return { replay: null, trace: replayTrace("error", shared.redisAvailable, expiredLocalGraceAgeBucket) };
  }
}

/**
 * How long a refresh token lives from its issue (each refresh starts a new
 * window): 30 days for a person's own sign-in, 7 for a device login's session
 * (the Computer refreshes when it uses it; the CLI drops its session after one
 * call, so that one simply runs out).
 */
export function refreshLifetimeMs(scope: SessionScope): number {
  return (scope === "device" ? 7 : 30) * 24 * 60 * 60 * 1000;
}

/**
 * The scope a rotation keeps: the family's (a row with no family is refused
 * before it gets here). A family id with no family row can't happen
 * (sessions cascade with their family); if it did, fail closed.
 * Null when the family is revoked or retired: it never rotates. Both delete
 * the family's sessions in the same transaction, so a rotation should never
 * find one; this keeps that from being the only guard.
 */
async function familyScope(tx: DatabaseExecutor, familyId: string): Promise<SessionScope | null> {
  const [family] = await tx.select({ scope: sessionFamilies.scope, revokedAt: sessionFamilies.revokedAt, retiredAt: sessionFamilies.retiredAt })
    .from(sessionFamilies)
    .where(eq(sessionFamilies.id, familyId)).limit(1);
  if (!family) throw new Error("SESSION_FAMILY_MISSING");
  if (family.revokedAt || family.retiredAt) return null;
  return family.scope;
}

/** A device login's session was revoked while one of its requests was minting. */
export class DeviceSessionRevokedError extends Error {
  constructor() {
    super("device session revoked");
    this.name = "DeviceSessionRevokedError";
  }
}

/**
 * The fence a device session's write (credential mint, Computer attach or
 * adopt) takes inside its transaction: the person's `users` row FOR KEY SHARE,
 * then a share lock on the still-live family. Every family revoker locks
 * `users` FOR UPDATE first and then updates the family, so writers take the
 * same order and the two wait on each other instead of deadlocking (the
 * write's foreign keys to `users` take KEY SHARE anyway). A revoke that commits
 * first leaves the family revoked here (DeviceSessionRevokedError); a write
 * that holds the fence first commits before the family update, and the key
 * cascade (revokeKeysOfRevokedDeviceSessions), which runs after that update
 * commits, then sees what it wrote.
 */
export async function lockLiveSessionFamily(tx: DatabaseExecutor, familyId: string, userId: string): Promise<void> {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("key share");
  // A retired family is no more live than a revoked one: it may write nothing.
  const [family] = await tx.select({ id: sessionFamilies.id }).from(sessionFamilies)
    .where(and(
      eq(sessionFamilies.id, familyId),
      eq(sessionFamilies.userId, userId),
      isNull(sessionFamilies.revokedAt),
      isNull(sessionFamilies.retiredAt),
    ))
    .for("share");
  if (!family) throw new DeviceSessionRevokedError();
}

export type RetireDeviceSessionFamilyResult = "retired" | "already_retired" | "revoked" | "not_found";

/**
 * Retires a device session family for the migration to one-time grants
 * (device-auth design v2 §4 step 2): its sessions are deleted, so its refresh
 * tokens are dead, and `retired_at` makes its access tokens unusable too
 * (verifyActiveAccessTokenWithAccount). Nothing it issued is touched: its keys
 * keep naming it, and a later revoke of the family still revokes them
 * (deviceSessionKeys.ts reads `revoked_at` only). Takes the person's `users`
 * row FOR UPDATE first, as every family revoker and rotation do. A revoked
 * family stays revoked (never "retired" over it); an already retired one is
 * left as it is.
 */
export async function retireDeviceSessionFamilyInTransaction(
  tx: DatabaseExecutor, userId: string, familyId: string, now = currentDate(),
): Promise<RetireDeviceSessionFamilyResult> {
  if (!(await lockActiveUser(tx, userId))) return "not_found";
  const [family] = await tx.select({ scope: sessionFamilies.scope, revokedAt: sessionFamilies.revokedAt, retiredAt: sessionFamilies.retiredAt })
    .from(sessionFamilies)
    .where(and(eq(sessionFamilies.id, familyId), eq(sessionFamilies.userId, userId)))
    .limit(1);
  if (!family || family.scope !== "device") return "not_found";
  if (family.revokedAt) return "revoked";
  if (family.retiredAt) {
    // Idempotent; and nothing of it may still refresh.
    await tx.delete(sessions).where(and(eq(sessions.familyId, familyId), eq(sessions.userId, userId)));
    return "already_retired";
  }
  await tx.update(sessionFamilies).set({ retiredAt: now, retiredReason: "migration" })
    .where(and(eq(sessionFamilies.id, familyId), eq(sessionFamilies.userId, userId), isNull(sessionFamilies.revokedAt), isNull(sessionFamilies.retiredAt)));
  await tx.delete(sessions).where(and(eq(sessions.familyId, familyId), eq(sessions.userId, userId)));
  return "retired";
}

/** The family a device session's mint records and fences, or null for any other session. */
export function deviceSessionFamilyOf(req: { sessionScope?: RequestSessionScope; sessionFamilyId?: string }): string | null {
  return req.sessionScope === "device" && req.sessionFamilyId ? req.sessionFamilyId : null;
}

/**
 * The family a person's own web (full) session's key issue records and fences
 * (webSessionIssuedKeys.ts: a security revoke of it revokes what it issued),
 * or null for any other session and for a legacy token with no family. Only
 * requireAuth sets `sessionScope`, so other auth paths record nothing.
 */
export function webSessionFamilyOf(req: { sessionScope?: RequestSessionScope; sessionFamilyId?: string }): string | null {
  return req.sessionScope === "full" && req.sessionFamilyId ? req.sessionFamilyId : null;
}

/** The approving family's SSO facts, when it is this person's own and was signed in by SSO. */
async function approverSsoFacts(tx: DatabaseExecutor, approverFamilyId: string, userId: string): Promise<{ ssoConnectionId?: string; ssoAuthenticatedAt?: Date }> {
  const [approver] = await tx.select({ connectionId: sessionFamilies.ssoConnectionId, authenticatedAt: sessionFamilies.ssoAuthenticatedAt })
    .from(sessionFamilies)
    .where(and(eq(sessionFamilies.id, approverFamilyId), eq(sessionFamilies.userId, userId)));
  return approver?.connectionId && approver.authenticatedAt
    ? { ssoConnectionId: approver.connectionId, ssoAuthenticatedAt: approver.authenticatedAt }
    : {};
}

/**
 * Issues a new login (a new family). The proof comes from the sign-in flow's
 * gate (sessionIssueGate.ts) and names the person; a proof whose second
 * factor was verified marks the new family verified (when, and with what).
 */
export async function createSession(
  proof: SessionIssueProof,
  executor?: DatabaseExecutor,
  options: { scope?: SessionScope } = {},
): Promise<{ sessionId: string; familyId: string; refreshToken: string; expiresAt: Date }> {
  const db = getDbForService();
  const { userId } = proof;
  const sessionId = randomUUID();
  const familyId = randomUUID();
  const refreshToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(refreshToken);
  const scope = options.scope ?? "full";
  const expiresAt = new Date(Date.now() + refreshLifetimeMs(scope));

  const create = async (tx: DatabaseExecutor) => {
    if (!(await lockActiveUser(tx, userId))) throw new Error("USER_RETIRED");
    await tx.insert(sessionFamilies).values({
      id: familyId,
      userId,
      scope,
      // An app login inherits the approver's verification time (proofForAppLogin); any other proof verified just now.
      ...(proof.secondFactor === "verified"
        ? { secondFactorVerifiedAt: proof.flow === "app_login" ? proof.verifiedAt : currentDate(), secondFactorMethod: proof.method }
        : {}),
      // Signed in by a Server's SSO connection just now (rfcs/083-server-sso.md §5.4), or approved
      // from a session that was: a device or app login carries the approver's SSO facts unchanged,
      // so it ages out with it (RFC 083 §5.2).
      ...(proof.flow === "sso_login"
        ? { ssoConnectionId: proof.ssoConnectionId, ssoAuthenticatedAt: currentDate() }
        : (proof.flow === "app_login" || proof.flow === "device_login") && proof.approverFamilyId
          ? await approverSsoFacts(tx, proof.approverFamilyId, userId)
          : {}),
    });
    await tx.insert(sessions).values({
      id: sessionId,
      userId,
      familyId,
      tokenHash,
      expiresAt,
    });
  };
  if (executor) await create(executor);
  else await db.transaction(create);

  return { sessionId, familyId, refreshToken, expiresAt };
}

export async function validateSession(refreshToken: string) {
  const db = getDbForService();
  const tokenHash = hashToken(refreshToken);

  const [session] = await db.select().from(sessions)
    .where(eq(sessions.tokenHash, tokenHash));

  if (!session) return null;
  if (new Date(session.expiresAt) < new Date()) {
    // Expired — clean up
    await db.delete(sessions).where(eq(sessions.id, session.id));
    return null;
  }

  return session;
}

export async function revokeSession(refreshToken: string): Promise<{ sessionId: string; userId: string } | null> {
  const db = getDbForService();
  const tokenHash = hashToken(refreshToken);
  const result = await db.transaction(async (tx) => {
    // Take the same user lock as rotation before consuming the session. A
    // concurrent rotation may move the token to lineage while we wait.
    const [session] = await tx.select({ userId: sessions.userId }).from(sessions)
      .where(eq(sessions.tokenHash, tokenHash)).limit(1);
    const [predecessor] = session ? [] : await tx.select({ userId: sessionTokenPredecessors.userId })
      .from(sessionTokenPredecessors).where(eq(sessionTokenPredecessors.tokenHash, tokenHash)).limit(1);
    const [oldReceipt] = session || predecessor ? [] : await tx.select({ userId: sessionRefreshRotationReceipts.userId })
      .from(sessionRefreshRotationReceipts).where(eq(sessionRefreshRotationReceipts.predecessorTokenHash, tokenHash)).limit(1);
    const userId = session?.userId ?? predecessor?.userId ?? oldReceipt?.userId;
    if (!userId) return null;
    await lockActiveUser(tx, userId);
    const [currentSession] = await tx
      .delete(sessions)
      .where(eq(sessions.tokenHash, tokenHash))
      .returning({ sessionId: sessions.id, userId: sessions.userId, familyId: sessions.familyId, expiresAt: sessions.expiresAt });
    if (currentSession?.familyId) {
      // Retain hash-only logout authority so a retry can repair failed Socket
      // fanout even though the current session row was already consumed.
      await tx.insert(sessionTokenPredecessors).values({
        tokenHash, sessionId: currentSession.sessionId, userId: currentSession.userId,
        familyId: currentSession.familyId, expiresAt: currentSession.expiresAt,
      });
    }
    let revoked: { sessionId: string; userId: string; familyId: string | null } | undefined = currentSession;
    if (!revoked) {
      const [lineage] = await tx.select({
        sessionId: sessionTokenPredecessors.sessionId,
        userId: sessionTokenPredecessors.userId,
        familyId: sessionTokenPredecessors.familyId,
      }).from(sessionTokenPredecessors).where(and(
        eq(sessionTokenPredecessors.tokenHash, tokenHash),
        gt(sessionTokenPredecessors.expiresAt, currentDate()),
      )).limit(1);
      revoked = lineage;
    }
    if (!revoked) {
      // A client may explicitly log out after the predecessor was consumed but
      // before it durably stored the successor. Honor that intent by revoking
      // the family named by the still-live durable receipt; otherwise a later
      // retry could resurrect the session the user just revoked.
      const [receipt] = await tx
        .select({
          sessionId: sessionRefreshRotationReceipts.predecessorSessionId,
          userId: sessionRefreshRotationReceipts.userId,
          familyId: sessionRefreshRotationReceipts.familyId,
        })
        .from(sessionRefreshRotationReceipts)
        .where(and(
          eq(sessionRefreshRotationReceipts.predecessorTokenHash, tokenHash),
          gt(sessionRefreshRotationReceipts.expiresAt, currentDate()),
        ))
        .limit(1);
      revoked = receipt;
    }
    if (!revoked) return null;
    const now = currentDate();
    if (revoked.familyId) {
      await revokeSessionFamilyInTransaction(tx, revoked.userId, revoked.familyId, "logout", now);
    }
    return { sessionId: revoked.sessionId, userId: revoked.userId, familyId: revoked.familyId };
  });
  if (!result) return null;
  try {
    await revokeSocketAccess({ userId: result.userId, familyId: result.familyId ?? undefined });
  } finally {
    if (result.familyId) await revokeKeysOfRevokedDeviceSessions({ familyId: result.familyId });
  }
  return { sessionId: result.sessionId, userId: result.userId };
}

/**
 * Deletes the sessions of families the caller just revoked (all of the
 * person's when `familyIds` is "all"), keeping each refresh token's hash in
 * `session_token_predecessors` first (as a rotation and a logout do), so a
 * refresh with one is told its sign-in was ended (`session_revoked`,
 * isRevokedSessionRefreshToken) rather than just "invalid". The hashes go
 * with their family's rows and with the hourly cleanup at their expiry.
 */
async function deleteRevokedSessionsInTransaction(tx: DatabaseExecutor, userId: string, familyIds: readonly string[] | "all"): Promise<void> {
  if (familyIds !== "all" && familyIds.length === 0) return;
  const ofThem = and(
    eq(sessions.userId, userId),
    familyIds === "all" ? undefined : inArray(sessions.familyId, [...familyIds]),
  );
  await tx.insert(sessionTokenPredecessors).select(
    tx.select({
      tokenHash: sessions.tokenHash,
      sessionId: sessions.id,
      userId: sessions.userId,
      familyId: sessions.familyId,
      expiresAt: sessions.expiresAt,
    }).from(sessions).where(and(ofThem, isNotNull(sessions.familyId))),
  ).onConflictDoNothing();
  await tx.delete(sessions).where(ofThem);
}

/**
 * Whether this refresh token belonged to a sign-in that has since been
 * revoked (signed out elsewhere, a password change, turning two-step
 * verification on, ...): the refresh route answers it `session_revoked`.
 * Read only after a refresh failed.
 */
export async function isRevokedSessionRefreshToken(refreshToken: string): Promise<boolean> {
  const [row] = await getDbForService().select({ id: sessionFamilies.id })
    .from(sessionTokenPredecessors)
    .innerJoin(sessionFamilies, eq(sessionFamilies.id, sessionTokenPredecessors.familyId))
    .where(and(eq(sessionTokenPredecessors.tokenHash, hashToken(refreshToken)), isNotNull(sessionFamilies.revokedAt)))
    .limit(1);
  return row !== undefined;
}

/** All family revocation writers serialize with refresh on the user row.
 * After its transaction commits, the caller must evict Socket subscriptions
 * and revoke what a device session handed out (revokeKeysOfRevokedDeviceSessions). */
export async function revokeSessionFamilyInTransaction(
  tx: DatabaseExecutor, userId: string, familyId: string,
  reason: "logout" | "capability" | "device_login_revoked", now = currentDate(),
) {
  await lockActiveUser(tx, userId);
  await tx.update(sessionFamilies).set({
    revokedAt: now, revokedReason: reason,
    capabilityRetainUntil: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
  }).where(and(eq(sessionFamilies.id, familyId), eq(sessionFamilies.userId, userId), isNull(sessionFamilies.revokedAt)));
  await deleteRevokedSessionsInTransaction(tx, userId, [familyId]);
  await denyLoginCodesApprovedBy(tx, userId, [familyId], now);
}

/**
 * Whether the sign-in that approved a one-time login code is still live: the
 * person's own `full` family, neither revoked nor retired, with an unexpired
 * session, and the person neither retired nor scheduled for deletion. An app
 * login's code (app_login_requests.approver_family_id), a person's Login
 * with Raft code (oauth_access_requests.approver_session_family_id) and a
 * device login's code that asks for a device session
 * (device_authorizations.approver_family_id) are exchanged only while this
 * holds; a code that names no family never is.
 *
 * The caller holds the person's `users` row lock in `tx` (FOR UPDATE, or FOR
 * KEY SHARE) before it reads the code's row: every family revoker takes that
 * row FOR UPDATE first and denies the codes the family approved
 * (denyLoginCodesApprovedBy) in its transaction, so a revoke either commits
 * before this read or waits until what the caller issues exists.
 */
export async function isApprovingSessionLive(
  tx: DatabaseExecutor,
  input: { userId: string; familyId: string | null },
  now = currentDate(),
): Promise<boolean> {
  if (!input.familyId) return false;
  const [live] = await tx.select({ id: sessionFamilies.id })
    .from(sessionFamilies)
    .innerJoin(users, eq(users.id, sessionFamilies.userId))
    .innerJoin(sessions, and(eq(sessions.familyId, sessionFamilies.id), gt(sessions.expiresAt, now)))
    .leftJoin(accountDeletionRequests, and(eq(accountDeletionRequests.userId, users.id), eq(accountDeletionRequests.state, "pending")))
    .where(and(
      eq(sessionFamilies.id, input.familyId),
      eq(sessionFamilies.userId, input.userId),
      eq(sessionFamilies.scope, "full"),
      isNull(sessionFamilies.revokedAt),
      isNull(sessionFamilies.retiredAt),
      isNull(users.retiredAt),
      isNull(accountDeletionRequests.id),
    ))
    .limit(1);
  return live !== undefined;
}

/**
 * A one-time login code dies with the sign-in that approved it, whatever the
 * revoke (a logout too): every family revoker calls this in its transaction,
 * after it took the person's `users` row FOR UPDATE. Denies the person's
 * approved app login codes those families approved, their Login with Raft
 * codes not yet exchanged, and their device login codes not yet polled that
 * ask for a device session (`"all"`: every family of the person, every such
 * code). Unlike what a session approved through a device-login grant
 * (approverSessionGrants.ts, a security revoke only), nothing has been issued
 * from these yet, so denying them takes nothing away that is in use. A device
 * code that carries a one-time grant is that grant's, and keeps its rule.
 * The exchange refuses them anyway (isApprovingSessionLive); this keeps that
 * from being the only guard.
 */
export async function denyLoginCodesApprovedBy(
  tx: DatabaseExecutor, userId: string, familyIds: readonly string[] | "all", now = currentDate(),
): Promise<void> {
  if (familyIds !== "all" && familyIds.length === 0) return;
  await tx.update(appLoginRequests).set({ status: "denied" }).where(and(
    eq(appLoginRequests.status, "approved"),
    familyIds === "all"
      ? inArray(appLoginRequests.approverFamilyId, tx.select({ id: sessionFamilies.id }).from(sessionFamilies).where(eq(sessionFamilies.userId, userId)))
      : inArray(appLoginRequests.approverFamilyId, [...familyIds]),
  ));
  await tx.update(oauthAccessRequests).set({
    status: "denied", remember: false, resolvedByUserId: userId, resolvedAt: now, updatedAt: now,
  }).where(and(
    eq(oauthAccessRequests.userId, userId),
    eq(oauthAccessRequests.principalType, "human"),
    eq(oauthAccessRequests.status, "approved"),
    isNull(oauthAccessRequests.consumedAt),
    familyIds === "all" ? undefined : inArray(oauthAccessRequests.approverSessionFamilyId, [...familyIds]),
  ));
  // Only codes still usable: an expired one is refused anyway, and stays as it ended.
  await tx.update(deviceAuthorizations).set({ status: "denied", deniedAt: now }).where(and(
    eq(deviceAuthorizations.approvedByUserId, userId),
    eq(deviceAuthorizations.status, "approved"),
    isNull(deviceAuthorizations.consumedAt),
    gt(deviceAuthorizations.expiresAt, now),
    familyIds === "all" ? undefined : inArray(deviceAuthorizations.approverFamilyId, [...familyIds]),
    notExists(tx.select({ id: deviceLoginGrants.id }).from(deviceLoginGrants)
      .where(eq(deviceLoginGrants.deviceAuthorizationId, deviceAuthorizations.id))),
  ));
}

/**
 * The revoked reasons of the person's other own sign-ins signed out when, from
 * one sign-in, they turned two-step verification on (design §5, P2) or
 * replaced a second-factor secret while it is on (new backup codes, a re-bound
 * authenticator app). Not a security revoke: like a logout, what those
 * sessions issued or approved keeps working (approverSessionGrants.ts reads
 * only `revoke_all`, `password_changed` and `device_login_revoked`), but a
 * login code they approved that nobody has exchanged yet dies with them, as
 * with any revoke (denyLoginCodesApprovedBy).
 */
export const SECOND_FACTOR_ENABLED_REVOKED_REASON = "second_factor_enabled";
export const SECOND_FACTOR_CHANGED_REVOKED_REASON = "second_factor_changed";
export type OtherSessionsRevokedReason = typeof SECOND_FACTOR_ENABLED_REVOKED_REASON | typeof SECOND_FACTOR_CHANGED_REVOKED_REASON;

/**
 * Signs out every live `full` family of the person (their own sign-ins: web,
 * desktop, mobile) except `keepFamilyId`, the one that made the change.
 * Device families (Computers, the raft CLI) stay: revoking one also revokes
 * the Computer keys and agent credentials it issued (deviceSessionKeys.ts).
 * Takes the person's `users` row FOR UPDATE first, like every family revoker.
 * Their refresh tokens are then answered `session_revoked`
 * (deleteRevokedSessionsInTransaction); their access tokens stop at once
 * (the family is revoked). Returns the revoked family ids; after commit the
 * caller must notify Socket (revokeSocketAccess) for each.
 */
export async function revokeOtherWebSessionFamiliesInTransaction(
  tx: DatabaseExecutor, userId: string, keepFamilyId: string, now = currentDate(),
  reason: OtherSessionsRevokedReason = SECOND_FACTOR_ENABLED_REVOKED_REASON,
): Promise<string[]> {
  await lockActiveUser(tx, userId);
  const revoked = await tx.update(sessionFamilies).set({
    revokedAt: now, revokedReason: reason,
    capabilityRetainUntil: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
  }).where(and(
    eq(sessionFamilies.userId, userId),
    eq(sessionFamilies.scope, "full"),
    ne(sessionFamilies.id, keepFamilyId),
    isNull(sessionFamilies.revokedAt),
  )).returning({ id: sessionFamilies.id });
  const ids = revoked.map((family) => family.id);
  await deleteRevokedSessionsInTransaction(tx, userId, ids);
  await denyLoginCodesApprovedBy(tx, userId, ids, now);
  return ids;
}

/** Caller owns commit; after it, it must notify Socket and run revokeKeysOfRevokedDeviceSessions. */
/**
 * The revoked reason of the session that changed the password itself (it gave
 * the current password, so it is the person): revoked like the others, but
 * what it issued or approved is kept (webSessionIssuedKeys.ts,
 * approverSessionGrants.ts), and maintenance's repair reads this to keep it.
 * Not a login code it approved that nobody has exchanged yet: that dies with
 * it, as with any revoke (denyLoginCodesApprovedBy).
 */
export const PASSWORD_CHANGED_REVOKED_REASON = "password_changed";

/**
 * Revokes every live family of the person (`revoke_all`) in one statement,
 * with one timestamp. `passwordChangedBy`: the family of the session that
 * changed the password, revoked with `password_changed` instead.
 */
export async function revokeAllUserSessionsInTransaction(tx: DatabaseExecutor, userId: string, options: { passwordChangedBy?: string | null } = {}) {
  const now = currentDate();
  await lockActiveUser(tx, userId);
  const exempt = options.passwordChangedBy ?? null;
  await tx.update(sessionFamilies).set({
    revokedAt: now,
    revokedReason: exempt
      ? sql`case when ${sessionFamilies.id} = ${exempt} then ${PASSWORD_CHANGED_REVOKED_REASON} else 'revoke_all' end`
      : "revoke_all",
    capabilityRetainUntil: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
  }).where(and(eq(sessionFamilies.userId, userId), isNull(sessionFamilies.revokedAt)));
  await deleteRevokedSessionsInTransaction(tx, userId, "all");
  // The changing session's codes too: it is revoked like the others.
  await denyLoginCodesApprovedBy(tx, userId, "all", now);
}

export async function revokeAllUserSessions(userId: string) {
  await getDbForService().transaction(tx => revokeAllUserSessionsInTransaction(tx, userId));
  try {
    await revokeSocketAccess({ userId });
  } finally {
    await revokeKeysOfRevokedDeviceSessions({ userId });
  }
}

/**
 * Rotate refresh token: atomically consume old, create new.
 * Returns null if another request already consumed the old token, and for a
 * row with no family: rotation never starts a login, only createSession does
 * (through its gate), so such a row is left alone and cannot be refreshed.
 */
export async function rotateSession(oldRefreshToken: string, userId: string): Promise<{ sessionId: string; familyId: string; refreshToken: string; expiresAt: Date } | null> {
  const db = getDbForService();
  const oldTokenHash = hashToken(oldRefreshToken);

  const rotated = await db.transaction(async (tx) => {
    if (!(await lockActiveUser(tx, userId))) return null;
    const [consumed] = await tx
      .delete(sessions)
      .where(and(
        eq(sessions.tokenHash, oldTokenHash),
        eq(sessions.userId, userId),
        gt(sessions.expiresAt, new Date()),
        isNotNull(sessions.familyId),
      ))
      .returning({ id: sessions.id, userId: sessions.userId, familyId: sessions.familyId, expiresAt: sessions.expiresAt });

    if (!consumed?.familyId) return null;

    const scope = await familyScope(tx, consumed.familyId);
    if (!scope) return null;
    const sessionId = randomUUID();
    const familyId = consumed.familyId;
    const refreshToken = randomBytes(32).toString("hex");
    const tokenHash = hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + refreshLifetimeMs(scope));

    await tx.insert(sessions).values({
      id: sessionId,
      userId,
      familyId,
      tokenHash,
      expiresAt,
    });

    await tx.insert(sessionTokenPredecessors).values({
      tokenHash: oldTokenHash, sessionId: consumed.id, userId, familyId, expiresAt: consumed.expiresAt,
    });

    return { sessionId, familyId, refreshToken, expiresAt };
  });

  if (rotated) {
    await rememberRotation(oldTokenHash, { userId, ...rotated });
  }

  return rotated;
}

async function refreshSessionWithDurableReplay(
  oldRefreshToken: string,
  binding: DurableRefreshReplayBinding,
): Promise<RefreshSessionWithTraceResult> {
  const db = getDbForService();
  const predecessorTokenHash = hashToken(oldRefreshToken);
  const redisAvailable = sharedReplayStoreInfo().redisAvailable;

  return db.transaction(async (tx) => {
    const now = currentDate();
    const [predecessor] = await tx.select({ userId: sessions.userId, familyId: sessions.familyId }).from(sessions)
      .where(eq(sessions.tokenHash, predecessorTokenHash)).limit(1);
    if (predecessor) {
      if (!(await lockActiveUser(tx, predecessor.userId))) {
        return { refreshed: null, replayTrace: replayTrace("child_invalid", redisAvailable) };
      }
      // A row with no family is refused, not given one (see rotateSession).
      if (!predecessor.familyId) {
        return { refreshed: null, replayTrace: replayTrace("child_invalid", redisAvailable) };
      }
    }
    const [consumed] = await tx
      .delete(sessions)
      .where(and(
        eq(sessions.tokenHash, predecessorTokenHash),
        gt(sessions.expiresAt, now),
        isNotNull(sessions.familyId),
      ))
      .returning({
        id: sessions.id,
        userId: sessions.userId,
        familyId: sessions.familyId,
        expiresAt: sessions.expiresAt,
      });

    if (consumed?.familyId) {
      const scope = await familyScope(tx, consumed.familyId);
      if (!scope) return { refreshed: null, replayTrace: replayTrace("child_invalid", redisAvailable) };
      const familyId = consumed.familyId;

      const sessionId = randomUUID();
      const successorRefreshToken = randomBytes(32).toString("hex");
      const successorExpiresAt = new Date(now.getTime() + refreshLifetimeMs(scope));

      await tx.insert(sessions).values({
        id: sessionId,
        userId: consumed.userId,
        familyId,
        tokenHash: hashToken(successorRefreshToken),
        expiresAt: successorExpiresAt,
      });

      await tx.insert(sessionTokenPredecessors).values({
        tokenHash: predecessorTokenHash, sessionId: consumed.id,
        userId: consumed.userId, familyId, expiresAt: consumed.expiresAt,
      });

      const identity: DurableReplayIdentity = {
        ...binding,
        predecessorTokenHash,
        predecessorSessionId: consumed.id,
        userId: consumed.userId,
        familyId,
        successorSessionId: sessionId,
      };
      const encrypted = encryptDurableSuccessor(successorRefreshToken, identity);
      await tx.insert(sessionRefreshRotationReceipts).values({
        predecessorTokenHash,
        predecessorSessionId: consumed.id,
        userId: consumed.userId,
        familyId,
        successorSessionId: sessionId,
        attemptId: binding.attemptId,
        installationId: binding.installationId,
        successorTokenCiphertext: encrypted.ciphertext,
        successorTokenIv: encrypted.iv,
        successorTokenAuthTag: encrypted.authTag,
        // A phone can freeze an app for far longer than a few minutes between
        // the server rotating and the app reading the reply (task #72): the
        // receipt lives as long as the successor it hands back.
        expiresAt: successorExpiresAt,
      });

      return {
        refreshed: {
          sessionId,
          familyId,
          userId: consumed.userId,
          refreshToken: successorRefreshToken,
          expiresAt: successorExpiresAt,
          replayedRotation: false,
        },
        replayTrace: replayTrace("not_needed", redisAvailable),
      };
    }

    const [receipt] = await tx
      .select()
      .from(sessionRefreshRotationReceipts)
      .where(eq(sessionRefreshRotationReceipts.predecessorTokenHash, predecessorTokenHash))
      .limit(1);
    if (!receipt) {
      // No receipt, yet this token was rotated and its login is still live:
      // the successor has itself rotated since (its receipt goes with it), so
      // this client lost that rotation (task #72). Say so apart from an
      // unknown token; it is recorded, not treated as reuse.
      const [rotatedFrom] = await tx
        .select({ userId: sessionTokenPredecessors.userId, familyId: sessionTokenPredecessors.familyId })
        .from(sessionTokenPredecessors)
        .innerJoin(sessionFamilies, eq(sessionFamilies.id, sessionTokenPredecessors.familyId))
        .where(and(
          eq(sessionTokenPredecessors.tokenHash, predecessorTokenHash),
          gt(sessionTokenPredecessors.expiresAt, now),
          isNull(sessionFamilies.revokedAt),
          isNull(sessionFamilies.retiredAt),
        ))
        .limit(1);
      if (rotatedFrom) {
        return {
          refreshed: null,
          replayTrace: { ...replayTrace("superseded", redisAvailable), superseded: rotatedFrom },
        };
      }
      return { refreshed: null, replayTrace: replayTrace("miss", redisAvailable) };
    }

    if (receipt.attemptId !== binding.attemptId || receipt.installationId !== binding.installationId) {
      return {
        refreshed: null,
        replayTrace: replayTrace("durable_binding_mismatch", redisAvailable),
      };
    }

    const receiptExpiresAt = new Date(receipt.expiresAt);
    if (receiptExpiresAt <= now) {
      await tx.delete(sessionRefreshRotationReceipts)
        .where(eq(sessionRefreshRotationReceipts.id, receipt.id));
      return { refreshed: null, replayTrace: replayTrace("expired", redisAvailable) };
    }

    const [successor] = await tx
      .select()
      .from(sessions)
      .where(and(
        eq(sessions.id, receipt.successorSessionId),
        eq(sessions.userId, receipt.userId),
        eq(sessions.familyId, receipt.familyId),
        gt(sessions.expiresAt, now),
      ))
      .limit(1);
    const [family] = await tx
      .select()
      .from(sessionFamilies)
      .where(and(
        eq(sessionFamilies.id, receipt.familyId),
        eq(sessionFamilies.userId, receipt.userId),
        isNull(sessionFamilies.revokedAt),
        isNull(sessionFamilies.retiredAt),
      ))
      .limit(1);
    if (!successor || !family) {
      await tx.delete(sessionRefreshRotationReceipts)
        .where(eq(sessionRefreshRotationReceipts.id, receipt.id));
      return { refreshed: null, replayTrace: replayTrace("child_invalid", redisAvailable) };
    }

    const identity: DurableReplayIdentity = {
      attemptId: receipt.attemptId,
      installationId: receipt.installationId,
      predecessorTokenHash: receipt.predecessorTokenHash,
      predecessorSessionId: receipt.predecessorSessionId,
      userId: receipt.userId,
      familyId: receipt.familyId,
      successorSessionId: receipt.successorSessionId,
    };
    try {
      const successorRefreshToken = decryptDurableSuccessor({
        ciphertext: receipt.successorTokenCiphertext,
        iv: receipt.successorTokenIv,
        authTag: receipt.successorTokenAuthTag,
      }, identity);
      if (hashToken(successorRefreshToken) !== successor.tokenHash) {
        return { refreshed: null, replayTrace: replayTrace("child_invalid", redisAvailable) };
      }
      return {
        refreshed: {
          sessionId: successor.id,
          familyId: receipt.familyId,
          userId: receipt.userId,
          refreshToken: successorRefreshToken,
          expiresAt: new Date(successor.expiresAt),
          replayedRotation: true,
        },
        replayTrace: replayTrace("durable_hit", redisAvailable),
      };
    } catch {
      return { refreshed: null, replayTrace: replayTrace("error", redisAvailable) };
    }
  });
}

export async function refreshSessionWithTrace(
  refreshToken: string,
  durableBinding?: DurableRefreshReplayBinding,
): Promise<RefreshSessionWithTraceResult> {
  if (durableBinding) {
    return refreshSessionWithDurableReplay(refreshToken, durableBinding);
  }
  const oldTokenHash = hashToken(refreshToken);
  const session = await validateSession(refreshToken);
  if (!session) {
    const replay = await replayRecentRotation(oldTokenHash);
    return {
      refreshed: replay.replay ? { ...replay.replay, replayedRotation: true } : null,
      replayTrace: replay.trace,
    };
  }

  const rotated = await rotateSession(refreshToken, session.userId);
  if (rotated) {
    return {
      refreshed: { userId: session.userId, ...rotated, replayedRotation: false },
      replayTrace: replayTrace("not_needed", sharedReplayStoreInfo().redisAvailable),
    };
  }

  const replay = await replayRecentRotation(oldTokenHash);
  return {
    refreshed: replay.replay ? { ...replay.replay, replayedRotation: true } : null,
    replayTrace: replay.trace,
  };
}

export async function refreshSession(
  refreshToken: string,
  durableBinding?: DurableRefreshReplayBinding,
): Promise<RefreshedSession | null> {
  return (await refreshSessionWithTrace(refreshToken, durableBinding)).refreshed;
}

export async function cleanupExpiredSessions() {
  const db = getDbForService();
  const now = currentDate();
  await db.transaction(async (tx) => {
    await tx.delete(sessionTokenPredecessors).where(lte(sessionTokenPredecessors.expiresAt, now));
    await tx.delete(sessionRefreshRotationReceipts)
      .where(lte(sessionRefreshRotationReceipts.expiresAt, now));
    await tx.delete(sessions).where(lt(sessions.expiresAt, now));
    await tx.update(sessionFamilies).set({
      revokeCapabilityNonce: null,
      capabilityRetainUntil: null,
    }).where(and(
      lte(sessionFamilies.capabilityRetainUntil, now),
      isNotNull(sessionFamilies.revokedAt),
    ));
  });
}
