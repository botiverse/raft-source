import {
  RAFT_CLIENT_CAPABILITIES_HEADER,
  RUNTIME_USAGE_WINDOW_SCOPE_CLIENT_CAPABILITY,
  safeParseRuntimeAccountUsageSnapshot,
} from "@botiverse/raft-shared";
import type {
  RuntimeAccountUsageProvider,
  RuntimeAccountUsageSnapshot,
} from "@botiverse/raft-shared";
import api from "../api/client";

export const RUNTIME_ACCOUNT_USAGE_CLIENT_CACHE_MS = 60_000;

/**
 * What this build declares on the requests that answer with a usage
 * snapshot (read, refresh, limit reset): its parser reads a window's `scope`.
 * The server strips `scope` for a request without it, so an older bundle's
 * strict parse never drops the snapshot.
 */
export const RUNTIME_USAGE_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  [RAFT_CLIENT_CAPABILITIES_HEADER]: RUNTIME_USAGE_WINDOW_SCOPE_CLIENT_CAPABILITY,
};
export const RUNTIME_ACCOUNT_USAGE_CLIENT_REFRESH_COOLDOWN_MS = 120_000;

/**
 * `unsupported`: this Computer's daemon does not read the provider's usage
 * (Antigravity on a Computer before OAR 0.103): show no usage for it, as for
 * a runtime that reports none, never "needs attention".
 */
export type RuntimeAccountUsageReadResult =
  | { state: "missing" | "unsupported"; snapshot: null }
  | { state: "fresh" | "stale"; snapshot: RuntimeAccountUsageSnapshot };

export type RuntimeAccountUsageRefreshResult = {
  accepted: boolean;
  state: "requested" | "cooldown" | "computer_offline" | "fresh" | "timeout" | "unsupported";
  /**
   * Present when `state === "fresh"`: the snapshot the machine just detected,
   * in the same shape the read path returns. Manual refreshes await the
   * machine's reply through the server relay and carry the value inline.
   */
  snapshot?: RuntimeAccountUsageSnapshot | null;
};

/**
 * A refresh carries the computer's reply inline. Keep it only in the shape
 * the read path guarantees: one malformed snapshot (an account whose
 * `windows` is not an array) would otherwise crash every usage view that
 * renders it, the whole Computers page included (#triage:#151).
 */
function withValidSnapshot(result: RuntimeAccountUsageRefreshResult): RuntimeAccountUsageRefreshResult {
  if (!result.snapshot) return result;
  const parsed = safeParseRuntimeAccountUsageSnapshot(result.snapshot);
  return { ...result, snapshot: parsed.success ? parsed.data : null };
}

/**
 * A read's answer in the shape every usage view relies on: an answer without
 * a snapshot holding its accounts (absent, an unknown state) is `missing`,
 * never a crash where a view reads `snapshot.accounts`. The server's read
 * serves only snapshots its cache validated on the way in.
 */
function readResultOf(value: unknown): RuntimeAccountUsageReadResult {
  const answer = value as { state?: unknown; snapshot?: { accounts?: unknown } | null } | null | undefined;
  if (answer?.state === "unsupported") return { state: "unsupported", snapshot: null };
  if ((answer?.state === "fresh" || answer?.state === "stale") && Array.isArray(answer.snapshot?.accounts)) {
    return answer as RuntimeAccountUsageReadResult;
  }
  return { state: "missing", snapshot: null };
}

type GetJson = (url: string) => Promise<RuntimeAccountUsageReadResult>;
type PostJson = (url: string, body: unknown) => Promise<RuntimeAccountUsageRefreshResult>;

function requestKey(serverId: string, machineId: string, provider: RuntimeAccountUsageProvider): string {
  return `${serverId}\0${machineId}\0${provider}`;
}

export class RuntimeAccountUsageClient {
  private readonly cache = new Map<string, { value: RuntimeAccountUsageReadResult; expiresAt: number }>();
  private readonly reads = new Map<string, Promise<RuntimeAccountUsageReadResult>>();
  private readonly refreshes = new Map<string, Promise<RuntimeAccountUsageRefreshResult>>();
  private readonly refreshStartedAt = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly getJson: GetJson,
    private readonly postJson: PostJson,
    private readonly now: () => number = Date.now,
  ) {}

  read(serverId: string, machineId: string, provider: RuntimeAccountUsageProvider): Promise<RuntimeAccountUsageReadResult> {
    const key = requestKey(serverId, machineId, provider);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached.value);
    const pending = this.reads.get(key);
    if (pending) return pending;
    const url = `/servers/${serverId}/machines/${machineId}/runtime-account-usage/${provider}`;
    const request = this.getJson(url).then((answer) => {
      const value = readResultOf(answer);
      this.store(key, value);
      return value;
    }).finally(() => {
      if (this.reads.get(key) === request) this.reads.delete(key);
    });
    this.reads.set(key, request);
    return request;
  }

  refresh(
    serverId: string,
    machineId: string,
    provider: RuntimeAccountUsageProvider,
    reason: "manual" | "stale_or_missing",
  ): Promise<RuntimeAccountUsageRefreshResult> {
    const key = requestKey(serverId, machineId, provider);
    const pending = this.refreshes.get(key);
    if (pending) return pending;
    const lastStartedAt = this.refreshStartedAt.get(key);
    if (lastStartedAt !== undefined && this.now() - lastStartedAt < RUNTIME_ACCOUNT_USAGE_CLIENT_REFRESH_COOLDOWN_MS) {
      return Promise.resolve({ accepted: false, state: "cooldown" });
    }
    this.refreshStartedAt.set(key, this.now());
    const url = `/servers/${serverId}/machines/${machineId}/runtime-account-usage/${provider}/refresh`;
    const request = this.postJson(url, { reason }).then((reply) => {
      const result = withValidSnapshot(reply);
      // A manual refresh can wait for the machine's reply (server relay): a
      // `fresh` result carries the snapshot itself. Write it in the read-path
      // shape so the chip can render it in place and later reads reuse it.
      if (result.state === "fresh" && result.snapshot) {
        this.store(key, { state: "fresh", snapshot: result.snapshot });
      }
      return result;
    }).finally(() => {
      if (this.refreshes.get(key) === request) this.refreshes.delete(key);
    });
    this.refreshes.set(key, request);
    return request;
  }

  /** Milliseconds left before another refresh is allowed for this subject
   *  (0 when the window is open). Drives the chip's disabled + countdown state
   *  so a refused click is explained before it happens (task #704). */
  refreshCooldownRemainingMs(
    serverId: string,
    machineId: string,
    provider: RuntimeAccountUsageProvider,
  ): number {
    const lastStartedAt = this.refreshStartedAt.get(requestKey(serverId, machineId, provider));
    if (lastStartedAt === undefined) return 0;
    return Math.max(0, RUNTIME_ACCOUNT_USAGE_CLIENT_REFRESH_COOLDOWN_MS - (this.now() - lastStartedAt));
  }

  /**
   * Calls `listener` whenever a read result lands in the cache (a read from
   * the server, or a manual refresh's snapshot), so a view drawn from cached
   * reads (the rack's usage meters) follows what a usage card just fetched.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private store(key: string, value: RuntimeAccountUsageReadResult): void {
    this.cache.set(key, { value, expiresAt: this.now() + RUNTIME_ACCOUNT_USAGE_CLIENT_CACHE_MS });
    for (const listener of this.listeners) listener();
  }

  /** Puts a snapshot the Computer just read (after a limit reset) into the read cache, as a manual refresh does. */
  storeSnapshot(serverId: string, machineId: string, provider: RuntimeAccountUsageProvider, snapshot: RuntimeAccountUsageSnapshot): void {
    this.store(requestKey(serverId, machineId, provider), { state: "fresh", snapshot });
  }

  invalidate(serverId: string, machineId: string, provider: RuntimeAccountUsageProvider): void {
    this.cache.delete(requestKey(serverId, machineId, provider));
  }

  clear(): void {
    this.cache.clear();
    this.reads.clear();
    this.refreshes.clear();
    this.refreshStartedAt.clear();
  }
}

export const runtimeAccountUsageClient = new RuntimeAccountUsageClient(
  async (url) => (await api.get<RuntimeAccountUsageReadResult>(url, { headers: { ...RUNTIME_USAGE_REQUEST_HEADERS } })).data,
  async (url, body) => (await api.post<RuntimeAccountUsageRefreshResult>(url, body, { headers: { ...RUNTIME_USAGE_REQUEST_HEADERS } })).data,
);
