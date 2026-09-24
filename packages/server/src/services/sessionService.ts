import { and, eq, gt, isNotNull, isNull, lt, lte } from "drizzle-orm";
import { AUTH_REFRESH_ROTATED_REPLAY_GRACE_MS, currentDate, setClockTimeout } from "@botiverse/raft-shared";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { getDb, type DatabaseExecutor } from "../db/index.js";
import { sessionFamilies, sessionRefreshRotationReceipts, sessionTokenPredecessors, sessions, users } from "../db/schema.js";
import { getRedis, isRedisAvailable } from "../redis.js";
import { revokeSocketAccess } from "../socket/accessRevocation.js";
import { serializeErrorForLog } from "../tracing/safeErrorLog.js";

let getDbForService = getDb;
const ROTATED_REFRESH_REPLAY_GRACE_MS = AUTH_REFRESH_ROTATED_REPLAY_GRACE_MS;
const ROTATED_REFRESH_REPLAY_GRACE_TTL_SECONDS = Math.ceil(ROTATED_REFRESH_REPLAY_GRACE_MS / 1_000);
const ROTATED_REFRESH_REPLAY_KEY_PREFIX = "slock:auth:rotated-refresh-replay:";
export const DURABLE_REFRESH_REPLAY_TTL_MS = 15 * 60 * 1_000;

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
  const [user] = await tx.select({ retiredAt: users.retiredAt }).from(users)
    .where(eq(users.id, userId)).limit(1).for("update");
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

export async function createSession(userId: string, executor?: DatabaseExecutor): Promise<{ sessionId: string; familyId: string; refreshToken: string; expiresAt: Date }> {
  const db = getDbForService();
  const sessionId = randomUUID();
  const familyId = randomUUID();
  const refreshToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  const create = async (tx: DatabaseExecutor) => {
    if (!(await lockActiveUser(tx, userId))) throw new Error("USER_RETIRED");
    await tx.insert(sessionFamilies).values({ id: familyId, userId });
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
  await revokeSocketAccess({ userId: result.userId, familyId: result.familyId ?? undefined });
  return { sessionId: result.sessionId, userId: result.userId };
}

/** All family revocation writers serialize with refresh on the user row.
 * The caller must evict Socket subscriptions after its transaction commits. */
export async function revokeSessionFamilyInTransaction(
  tx: DatabaseExecutor, userId: string, familyId: string,
  reason: "logout" | "capability", now = currentDate(),
) {
  await lockActiveUser(tx, userId);
  await tx.update(sessionFamilies).set({
    revokedAt: now, revokedReason: reason,
    capabilityRetainUntil: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
  }).where(and(eq(sessionFamilies.id, familyId), eq(sessionFamilies.userId, userId), isNull(sessionFamilies.revokedAt)));
  await tx.delete(sessions).where(and(eq(sessions.familyId, familyId), eq(sessions.userId, userId)));
}

/** Caller owns commit and must notify Socket after commit when using this seam. */
export async function revokeAllUserSessionsInTransaction(tx: DatabaseExecutor, userId: string) {
  const now = currentDate();
  await lockActiveUser(tx, userId);
  await tx.update(sessionFamilies).set({
    revokedAt: now,
    revokedReason: "revoke_all",
    capabilityRetainUntil: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
  }).where(and(eq(sessionFamilies.userId, userId), isNull(sessionFamilies.revokedAt)));
  await tx.delete(sessions).where(eq(sessions.userId, userId));
}

export async function revokeAllUserSessions(userId: string) {
  await getDbForService().transaction(tx => revokeAllUserSessionsInTransaction(tx, userId));
  await revokeSocketAccess({ userId });
}

/**
 * Rotate refresh token: atomically consume old, create new.
 * Returns null if another request already consumed the old token.
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
      ))
      .returning({ id: sessions.id, userId: sessions.userId, familyId: sessions.familyId, expiresAt: sessions.expiresAt });

    if (!consumed) return null;

    const sessionId = randomUUID();
    const familyId = consumed.familyId ?? randomUUID();
    const refreshToken = randomBytes(32).toString("hex");
    const tokenHash = hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    if (!consumed.familyId) {
      await tx.insert(sessionFamilies).values({ id: familyId, userId });
    }
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
    const [predecessor] = await tx.select({ userId: sessions.userId }).from(sessions)
      .where(eq(sessions.tokenHash, predecessorTokenHash)).limit(1);
    if (predecessor) {
      if (!(await lockActiveUser(tx, predecessor.userId))) {
        return { refreshed: null, replayTrace: replayTrace("child_invalid", redisAvailable) };
      }
    }
    const [consumed] = await tx
      .delete(sessions)
      .where(and(
        eq(sessions.tokenHash, predecessorTokenHash),
        gt(sessions.expiresAt, now),
      ))
      .returning({
        id: sessions.id,
        userId: sessions.userId,
        familyId: sessions.familyId,
        expiresAt: sessions.expiresAt,
      });

    if (consumed) {
      const familyId = consumed.familyId ?? randomUUID();
      if (!consumed.familyId) {
        await tx.insert(sessionFamilies).values({ id: familyId, userId: consumed.userId });
      }

      const sessionId = randomUUID();
      const successorRefreshToken = randomBytes(32).toString("hex");
      const successorExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000);
      const receiptExpiresAt = new Date(now.getTime() + DURABLE_REFRESH_REPLAY_TTL_MS);

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
        expiresAt: receiptExpiresAt,
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
