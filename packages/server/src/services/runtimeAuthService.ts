import { randomBytes } from "node:crypto";

import {
  RUNTIME_AUTH_LOGIN_START_LIMIT,
  RUNTIME_AUTH_LOGIN_START_WINDOW_MS,
  RUNTIME_AUTH_LOGIN_TTL_MS,
  RUNTIME_AUTH_RUNTIMES,
  asRuntimeAuthLoginId,
  currentTimeMs,
  runtimeAuthStatusReportSchema,
  type RuntimeAuthLoginId,
  type RuntimeAuthRuntime,
  type RuntimeAuthStatusReport,
} from "@botiverse/raft-shared";

import { z } from "zod";

import { getRedis, isRedisAvailable } from "../redis";

/**
 * task #17: the server side of web login / logout for a Computer's runtime
 * (docs/contracts/runtime-auth.md). A login is a short-lived record in Redis
 * (in-process without it): who started it, for which Computer and runtime.
 * It is never written to the database and expires with the login's TTL.
 * The latest auth status each Computer reported is kept the same way, and a
 * count of provider lists and connects per person and Computer (never what
 * they carried: a provider connect's API key is not kept anywhere).
 */

const SESSION_PREFIX = "slock:runtime-auth-login:v1";
const ACTIVE_PREFIX = "slock:runtime-auth-login-active:v1";
const STARTS_PREFIX = "slock:runtime-auth-login-starts:v1";
const STATUS_PREFIX = "slock:runtime-auth-status:v1";
const PROVIDER_REQUESTS_PREFIX = "slock:runtime-auth-provider-requests:v1";
const CLAUDE_LIMIT_RESET_REQUESTS_PREFIX = "slock:claude-limit-reset-requests:v1";
/**
 * Claude limit-reset reads and redeems allowed per (person, Computer) in the
 * login window. Each one starts the person's own Claude Code on the Computer
 * for up to a minute or two; a few clicks and a retry or two fit well inside.
 */
export const CLAUDE_LIMIT_RESET_REQUEST_LIMIT = 10;
/** Provider list reads allowed per (person, Computer) in the login window: one per dialog open. */
export const RUNTIME_AUTH_PROVIDER_LIST_REQUEST_LIMIT = 30;
const STATUS_TTL_SECONDS = 24 * 60 * 60;
const LOGIN_TTL_SECONDS = Math.ceil(RUNTIME_AUTH_LOGIN_TTL_MS / 1000);
const STARTS_WINDOW_SECONDS = Math.ceil(RUNTIME_AUTH_LOGIN_START_WINDOW_MS / 1000);

export interface RuntimeAuthLoginSession {
  loginId: RuntimeAuthLoginId;
  serverId: string;
  machineId: string;
  runtime: RuntimeAuthRuntime;
  requesterUserId: string;
  startedAtMs: number;
  /** The Computer connection the login runs on; its disconnect ends only these. */
  connectionEpochId: string | null;
}

const sessionRecordSchema = z.strictObject({
  loginId: z.string(),
  serverId: z.string(),
  machineId: z.string(),
  runtime: z.enum(RUNTIME_AUTH_RUNTIMES),
  requesterUserId: z.string(),
  startedAtMs: z.number(),
  connectionEpochId: z.string().nullable(),
});

export interface RuntimeAuthStoreBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Deletes the key only while it still holds this value (one atomic step). */
  delIfEquals(key: string, value: string): Promise<void>;
  /** Increments the counter, starting its TTL on the first increment; returns the new count. */
  incrementWindow(key: string, ttlSeconds: number): Promise<number>;
}

type LocalEntry = { value: string; expiresAtMs: number };
const localEntries = new Map<string, LocalEntry>();

function localGet(key: string): string | null {
  const entry = localEntries.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= currentTimeMs()) {
    localEntries.delete(key);
    return null;
  }
  return entry.value;
}

const localBackend: RuntimeAuthStoreBackend = {
  async get(key) {
    return localGet(key);
  },
  async set(key, value, ttlSeconds) {
    localEntries.set(key, { value, expiresAtMs: currentTimeMs() + ttlSeconds * 1_000 });
  },
  async setIfAbsent(key, value, ttlSeconds) {
    if (localGet(key) !== null) return false;
    localEntries.set(key, { value, expiresAtMs: currentTimeMs() + ttlSeconds * 1_000 });
    return true;
  },
  async del(key) {
    localEntries.delete(key);
  },
  async delIfEquals(key, value) {
    if (localGet(key) === value) localEntries.delete(key);
  },
  async incrementWindow(key, ttlSeconds) {
    const current = localGet(key);
    const next = (current === null ? 0 : Number(current)) + 1;
    const expiresAtMs = current === null ? currentTimeMs() + ttlSeconds * 1_000 : localEntries.get(key)!.expiresAtMs;
    localEntries.set(key, { value: String(next), expiresAtMs });
    return next;
  },
};

const INCREMENT_WINDOW_LUA = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
return count
`;

const DEL_IF_EQUALS_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end
return 0
`;

const redisBackend: RuntimeAuthStoreBackend = {
  async get(key) {
    return getRedis().get(key);
  },
  async set(key, value, ttlSeconds) {
    await getRedis().set(key, value, "EX", ttlSeconds);
  },
  async setIfAbsent(key, value, ttlSeconds) {
    return (await getRedis().set(key, value, "EX", ttlSeconds, "NX")) === "OK";
  },
  async del(key) {
    await getRedis().del(key);
  },
  async delIfEquals(key, value) {
    await getRedis().eval(DEL_IF_EQUALS_LUA, 1, key, value);
  },
  async incrementWindow(key, ttlSeconds) {
    return Number(await getRedis().eval(INCREMENT_WINDOW_LUA, 1, key, String(ttlSeconds)));
  },
};

const routingBackend: RuntimeAuthStoreBackend = {
  get: (key) => (isRedisAvailable() ? redisBackend : localBackend).get(key),
  set: (key, value, ttl) => (isRedisAvailable() ? redisBackend : localBackend).set(key, value, ttl),
  setIfAbsent: (key, value, ttl) => (isRedisAvailable() ? redisBackend : localBackend).setIfAbsent(key, value, ttl),
  del: (key) => (isRedisAvailable() ? redisBackend : localBackend).del(key),
  delIfEquals: (key, value) => (isRedisAvailable() ? redisBackend : localBackend).delIfEquals(key, value),
  incrementWindow: (key, ttl) => (isRedisAvailable() ? redisBackend : localBackend).incrementWindow(key, ttl),
};

export type RuntimeAuthStartOutcome =
  | { kind: "started"; session: RuntimeAuthLoginSession }
  | { kind: "rate_limited" }
  | { kind: "login_in_progress" };

export function mintRuntimeAuthLoginId(): RuntimeAuthLoginId {
  return asRuntimeAuthLoginId(`rtl_${randomBytes(24).toString("base64url")}`)!;
}

export class RuntimeAuthService {
  constructor(
    private readonly backend: RuntimeAuthStoreBackend = routingBackend,
    private readonly now: () => number = currentTimeMs,
  ) {}

  async recordStatus(machineId: string, report: RuntimeAuthStatusReport): Promise<void> {
    await this.backend.set(`${STATUS_PREFIX}:${machineId}`, JSON.stringify(report), STATUS_TTL_SECONDS);
  }

  async getStatus(machineId: string): Promise<RuntimeAuthStatusReport | null> {
    const raw = await this.backend.get(`${STATUS_PREFIX}:${machineId}`);
    if (!raw) return null;
    try {
      const parsed = runtimeAuthStatusReportSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Reserves a login: within the start rate limit for this person and
   * Computer, and only when no other login for this runtime is running there.
   */
  async startLogin(input: { serverId: string; machineId: string; runtime: RuntimeAuthRuntime; userId: string; connectionEpochId?: string | null }): Promise<RuntimeAuthStartOutcome> {
    const starts = await this.backend.incrementWindow(`${STARTS_PREFIX}:${input.userId}:${input.machineId}`, STARTS_WINDOW_SECONDS);
    if (starts > RUNTIME_AUTH_LOGIN_START_LIMIT) return { kind: "rate_limited" };
    const loginId = mintRuntimeAuthLoginId();
    const reserved = await this.backend.setIfAbsent(activeKey(input.machineId, input.runtime), loginId, LOGIN_TTL_SECONDS);
    if (!reserved) return { kind: "login_in_progress" };
    const session: RuntimeAuthLoginSession = {
      loginId,
      serverId: input.serverId,
      machineId: input.machineId,
      runtime: input.runtime,
      requesterUserId: input.userId,
      startedAtMs: this.now(),
      connectionEpochId: input.connectionEpochId ?? null,
    };
    try {
      await this.backend.set(`${SESSION_PREFIX}:${loginId}`, JSON.stringify(session), LOGIN_TTL_SECONDS);
    } catch (error) {
      // Without its record the login can never be ended: free the runtime now, not after the TTL.
      await this.backend.delIfEquals(activeKey(input.machineId, input.runtime), loginId).catch(() => undefined);
      throw error;
    }
    return { kind: "started", session };
  }

  /**
   * Counts one provider list or connect by this person on this Computer (each
   * starts the runtime's own process there); false once over its limit in
   * the login window. Connects have the login start limit; lists, read each
   * time the dialog opens, a higher one, counted apart.
   */
  async allowProviderRequest(kind: "list" | "connect", userId: string, machineId: string): Promise<boolean> {
    const count = await this.backend.incrementWindow(`${PROVIDER_REQUESTS_PREFIX}:${kind}:${userId}:${machineId}`, STARTS_WINDOW_SECONDS);
    return count <= (kind === "list" ? RUNTIME_AUTH_PROVIDER_LIST_REQUEST_LIMIT : RUNTIME_AUTH_LOGIN_START_LIMIT);
  }

  /** Counts one Claude limit-reset read or redeem; false once the person is over the limit on this Computer. */
  async allowClaudeLimitResetRequest(kind: "read" | "redeem", userId: string, machineId: string): Promise<boolean> {
    const count = await this.backend.incrementWindow(`${CLAUDE_LIMIT_RESET_REQUESTS_PREFIX}:${kind}:${userId}:${machineId}`, STARTS_WINDOW_SECONDS);
    return count <= CLAUDE_LIMIT_RESET_REQUEST_LIMIT;
  }

  async getSession(loginId: RuntimeAuthLoginId): Promise<RuntimeAuthLoginSession | null> {
    const raw = await this.backend.get(`${SESSION_PREFIX}:${loginId}`);
    if (!raw) return null;
    try {
      const parsed = sessionRecordSchema.safeParse(JSON.parse(raw));
      return parsed.success && parsed.data.loginId === loginId ? { ...parsed.data, loginId } : null;
    } catch {
      return null;
    }
  }

  /**
   * The login, only for the person who started it and for the Computer and
   * runtime named in the request. Anything else is null, so callers answer
   * 404 and never reveal that someone else's login exists.
   */
  async getSessionForRequester(input: { loginId: string; machineId: string; runtime: string; userId: string }): Promise<RuntimeAuthLoginSession | null> {
    const loginId = asRuntimeAuthLoginId(input.loginId);
    if (!loginId) return null;
    const session = await this.getSession(loginId);
    if (!session) return null;
    if (session.requesterUserId !== input.userId || session.machineId !== input.machineId || session.runtime !== input.runtime) return null;
    return session;
  }

  /** The login running for this runtime on this Computer, if any. */
  async getActiveSession(machineId: string, runtime: RuntimeAuthRuntime): Promise<RuntimeAuthLoginSession | null> {
    const raw = await this.backend.get(activeKey(machineId, runtime));
    const loginId = raw ? asRuntimeAuthLoginId(raw) : null;
    return loginId ? this.getSession(loginId) : null;
  }

  /** Ends a login: drops its record and releases the runtime for the next one. */
  async endLogin(session: RuntimeAuthLoginSession): Promise<void> {
    await this.backend.del(`${SESSION_PREFIX}:${session.loginId}`);
    // Atomic: a newer login that took the lock meanwhile keeps it.
    await this.backend.delIfEquals(activeKey(session.machineId, session.runtime), session.loginId);
  }
}

function activeKey(machineId: string, runtime: RuntimeAuthRuntime): string {
  return `${ACTIVE_PREFIX}:${machineId}:${runtime}`;
}

export const runtimeAuthService = new RuntimeAuthService();

export function __clearRuntimeAuthLocalStoreForTests(): void {
  localEntries.clear();
}

/** Every key and value in the in-process store, for tests that prove what it never holds. */
export function __runtimeAuthLocalStoreEntriesForTests(): string[] {
  return [...localEntries].map(([key, entry]) => `${key}=${entry.value}`);
}
