import {
  RUNTIME_AUTH_V1_RUNTIMES,
  asRuntimeAuthLoginId,
  isRuntimeAuthRuntime,
  runtimeAuthLoginEventSchema,
  runtimeAuthLoginResultSchema,
  runtimeAuthLogoutNeedsCapability,
  runtimeAuthProviderConnectResultSchema,
  runtimeAuthProvidersResultSchema,
  runtimeAuthSupports,
  runtimeLimitResetResultSchema,
  runtimeLimitResetsReadResultSchema,
  safeParseRuntimeAccountUsageSnapshot,
} from "@botiverse/raft-shared";
import type {
  RuntimeAccountUsageProvider,
  RuntimeAccountUsageSnapshot,
  RuntimeLimitResetResult,
  RuntimeAuthLoginEventPush,
  RuntimeAuthLoginId,
  RuntimeAuthLoginRegion,
  RuntimeAuthLoginResultPush,
  RuntimeAuthLogoutResult,
  RuntimeAuthProviderConnectInput,
  RuntimeAuthProviderConnectResult,
  RuntimeAuthProvidersResult,
  RuntimeAuthRuntime,
  RuntimeAuthStatus,
  RuntimeAuthStatusReport,
  RuntimeLimitResetIdempotencyKey,
  RuntimeLimitResetKind,
  RuntimeLimitResetsReadResult,
} from "@botiverse/raft-shared";
import type { Socket } from "socket.io-client";
import api from "../api/client";
import { getSocket, onSocketCreated } from "../api/socket";
import { RUNTIME_USAGE_REQUEST_HEADERS } from "./runtimeAccountUsageClient";

/**
 * task #17: the web side of logging a Computer's Claude Code / Codex in and
 * out (docs/contracts/runtime-auth.md). One read per (server, Computer),
 * cached in memory and re-read when the server says the Computer sent a new
 * status (`machine:runtime_auth:updated`, content-free). Login links and codes
 * arrive on this person's own sockets only, filtered by login id by the caller.
 *
 * Nothing here logs: the pasted code, and a provider's API key, go into one
 * request body each and nowhere else.
 */

export const RUNTIME_AUTH_CLIENT_CACHE_MS = 30_000;

/** `computer_not_attached`: no person attached this Computer, so nobody can relay a login for it. */
export type RuntimeAuthAvailability = "ok" | "computer_offline" | "computer_upgrade_required" | "computer_not_attached";

export interface RuntimeAuthView {
  status: RuntimeAuthStatusReport | null;
  availability: RuntimeAuthAvailability;
  /**
   * The runtimes this Computer signs in and out from here (its daemon's
   * capabilities); the others need a newer Computer. Absent from a server that
   * predates Kimi and Qoder: Claude Code and Codex then. A server-gated runtime
   * (Antigravity) is named only where the server offers it.
   */
  runtimes?: readonly RuntimeAuthRuntime[];
  /**
   * The runtimes this Computer signs out from here. Absent from a server that
   * predates Antigravity's sign-out: every runtime it signs in that has a
   * logout then, except one whose logout needs a newer daemon (Antigravity).
   */
  logoutRuntimes?: readonly RuntimeAuthRuntime[];
  canAct: boolean;
  /**
   * Claude limit resets on this Computer (behind claude_limit_reset, for a
   * person who may act): `ok`, or `computer_upgrade_required` when its daemon
   * lacks the capability (an older Computer, or one not on Linux). Absent:
   * nothing to show.
   */
  claudeLimitResets?: "ok" | "computer_upgrade_required";
  /**
   * What this viewer may do with those resets, beside `claudeLimitResets`.
   * Only the person who connected the Computer spends its Claude resets
   * (`canUse`: a redeem; `canConsent`: a read with consent at the 5-hour
   * limit); an owner or admin may only view them. Absent from an older
   * server: both allowed (the server enforces either way).
   */
  claudeLimitResetAccess?: { canUse: boolean; canConsent: boolean };
}

/** Whether this Computer signs the runtime in and out from here, or needs upgrading first. */
export function runtimeAuthComputerSupports(view: RuntimeAuthView, runtime: RuntimeAuthRuntime): boolean {
  return (view.runtimes ?? RUNTIME_AUTH_V1_RUNTIMES).includes(runtime);
}

/** Whether this Computer signs the runtime out from here (an older one may sign it in but not out: Antigravity). */
export function runtimeAuthComputerSignsOut(view: RuntimeAuthView, runtime: RuntimeAuthRuntime): boolean {
  if (!runtimeAuthSupports(runtime, "logout")) return false;
  if (view.logoutRuntimes) return view.logoutRuntimes.includes(runtime);
  return !runtimeAuthLogoutNeedsCapability(runtime) && runtimeAuthComputerSupports(view, runtime);
}

export const RUNTIME_AUTH_UPDATED_EVENT = "machine:runtime_auth:updated";
export const RUNTIME_AUTH_LOGIN_EVENT = "runtime_auth:login:event";
export const RUNTIME_AUTH_LOGIN_RESULT_EVENT = "runtime_auth:login:result";

export type RuntimeAuthLoginEventMessage = RuntimeAuthLoginEventPush & { serverId: string };
export type RuntimeAuthLoginResultMessage = RuntimeAuthLoginResultPush & { serverId: string };

/** The socket surface this client needs: listen and stop listening. */
export type RuntimeAuthSocket = Pick<Socket, "on" | "off">;

/**
 * Where the client finds the socket: the current instance, and a call when a
 * new instance replaces it (a reconnect drops every listener on the old one).
 */
export interface RuntimeAuthSocketSource {
  current(): RuntimeAuthSocket | null;
  onReplaced(listener: () => void): () => void;
}

export interface RuntimeAuthHttp {
  get<T>(url: string): Promise<T>;
  post<T>(url: string, body?: unknown): Promise<T>;
}

/** Thrown by `startLogin` (no valid login id) or a provider call (no valid result) when the server's answer does not check out. */
export class RuntimeAuthMalformedResponseError extends Error {
  constructor() {
    super("The server answered in a shape this page does not read");
  }
}

/** The runtime's status in a view, or null when the Computer has not reported it. */
export function runtimeAuthStatusOf(view: RuntimeAuthView | null, runtime: RuntimeAuthRuntime): RuntimeAuthStatus | null {
  return view?.status?.runtimes[runtime] ?? null;
}

function viewKey(serverId: string, machineId: string): string {
  return `${serverId}\0${machineId}`;
}

function base(serverId: string, machineId: string): string {
  return `/servers/${encodeURIComponent(serverId)}/machines/${encodeURIComponent(machineId)}/runtime-auth`;
}

type LoginHandlers = {
  event: (message: RuntimeAuthLoginEventMessage) => void;
  result: (message: RuntimeAuthLoginResultMessage) => void;
};

/** The routing fields every login push carries, checked; null when any is off. */
function loginPushHeader(payload: unknown): { serverId: string; machineId: string; runtime: RuntimeAuthRuntime; loginId: RuntimeAuthLoginId } | null {
  if (!payload || typeof payload !== "object") return null;
  const { serverId, machineId, runtime, loginId } = payload as Record<string, unknown>;
  if (typeof serverId !== "string" || typeof machineId !== "string" || !isRuntimeAuthRuntime(runtime)) return null;
  const id = typeof loginId === "string" ? asRuntimeAuthLoginId(loginId) : null;
  return id ? { serverId, machineId, runtime, loginId: id } : null;
}

export class RuntimeAuthClient {
  private readonly cache = new Map<string, { value: RuntimeAuthView; expiresAt: number }>();
  private readonly reads = new Map<string, Promise<RuntimeAuthView>>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly loginHandlers = new Set<LoginHandlers>();
  /** The socket instance the handlers below are on, or null when none is needed. */
  private attached: RuntimeAuthSocket | null = null;
  private stopReplacedWatch: (() => void) | null = null;

  constructor(
    private readonly http: RuntimeAuthHttp,
    private readonly socketSource: RuntimeAuthSocketSource,
    private readonly now: () => number = Date.now,
  ) {}

  read(serverId: string, machineId: string): Promise<RuntimeAuthView> {
    const key = viewKey(serverId, machineId);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached.value);
    const pending = this.reads.get(key);
    if (pending) return pending;
    const request = this.http.get<RuntimeAuthView>(base(serverId, machineId)).then((value) => {
      if (this.reads.get(key) === request) {
        this.cache.set(key, { value, expiresAt: this.now() + RUNTIME_AUTH_CLIENT_CACHE_MS });
      }
      return value;
    }).finally(() => {
      if (this.reads.get(key) === request) this.reads.delete(key);
    });
    this.reads.set(key, request);
    return request;
  }

  /** Drops the cached view so the next read asks the server, and tells every watcher. */
  invalidate(serverId: string, machineId: string): void {
    const key = viewKey(serverId, machineId);
    this.cache.delete(key);
    this.reads.delete(key);
    this.notify(machineId);
  }

  /**
   * Calls `onChange` whenever this Computer's status may have changed (a new
   * report, a login or logout from this page). The watcher re-reads.
   */
  watch(machineId: string, onChange: () => void): () => void {
    let set = this.listeners.get(machineId);
    if (!set) {
      set = new Set();
      this.listeners.set(machineId, set);
    }
    set.add(onChange);
    this.syncSocket();
    return () => {
      const current = this.listeners.get(machineId);
      current?.delete(onChange);
      if (current && current.size === 0) this.listeners.delete(machineId);
      this.syncSocket();
    };
  }

  /**
   * Listens for login events and results on this person's sockets. Pushes
   * whose routing fields, login id or payload do not check out are dropped here.
   */
  onLogin(handlers: LoginHandlers): () => void {
    this.loginHandlers.add(handlers);
    this.syncSocket();
    return () => {
      this.loginHandlers.delete(handlers);
      this.syncSocket();
    };
  }

  /**
   * Starts a login on the Computer; the id is checked before anyone may use it.
   * `region`: the one the person chose, for a runtime whose login asks for one (Kimi).
   * `providerId`: the provider to sign in, for a runtime that signs in per provider (Pi, OpenCode).
   * `oauthMethod`: the OAuth sign-in the person chose, by its label, for a runtime that offers several (OpenCode).
   */
  async startLogin(serverId: string, machineId: string, runtime: RuntimeAuthRuntime, region?: RuntimeAuthLoginRegion, providerId?: string, oauthMethod?: string): Promise<{ loginId: RuntimeAuthLoginId }> {
    const body = region || providerId || oauthMethod
      ? { ...(region ? { region } : {}), ...(providerId ? { providerId } : {}), ...(oauthMethod ? { oauthMethod } : {}) }
      : undefined;
    const answer = await this.http.post<{ loginId?: unknown } | null>(`${base(serverId, machineId)}/${runtime}/login`, body);
    const loginId = typeof answer?.loginId === "string" ? asRuntimeAuthLoginId(answer.loginId) : null;
    if (!loginId) throw new RuntimeAuthMalformedResponseError();
    return { loginId };
  }

  /** Sends the one-time code to that Computer's login. Never log `code`. */
  async submitCode(serverId: string, machineId: string, runtime: RuntimeAuthRuntime, loginId: RuntimeAuthLoginId, code: string): Promise<void> {
    await this.http.post(`${base(serverId, machineId)}/${runtime}/login/${encodeURIComponent(loginId)}/code`, { code });
  }

  async cancelLogin(serverId: string, machineId: string, runtime: RuntimeAuthRuntime, loginId: RuntimeAuthLoginId): Promise<void> {
    await this.http.post(`${base(serverId, machineId)}/${runtime}/login/${encodeURIComponent(loginId)}/cancel`);
  }

  /** `providerId`: the one provider to sign out, for a runtime that signs in per provider (Pi). */
  async logout(serverId: string, machineId: string, runtime: RuntimeAuthRuntime, providerId?: string): Promise<RuntimeAuthLogoutResult> {
    const { result } = await this.http.post<{ result: RuntimeAuthLogoutResult }>(`${base(serverId, machineId)}/${runtime}/logout`, providerId ? { providerId } : undefined);
    return result;
  }

  /**
   * Spends one of the runtime account's limit resets on the Computer (Codex).
   * `idempotencyKey` names one confirmed click: pass the same key to retry an
   * attempt whose outcome was never learned (a timeout, `unknown`), so the
   * retry never spends a second reset. Answers the outcome and the usage the
   * Computer read right after it (null when it could not), checked here.
   */
  async redeemLimitReset(
    serverId: string,
    machineId: string,
    provider: RuntimeAccountUsageProvider,
    idempotencyKey: RuntimeLimitResetIdempotencyKey,
    /** Claude: the one kind the person chose. Naming it also tells the server this page reads every result shape. */
    kind?: RuntimeLimitResetKind,
  ): Promise<{ result: RuntimeLimitResetResult; snapshot: RuntimeAccountUsageSnapshot | null }> {
    const url = `/servers/${encodeURIComponent(serverId)}/machines/${encodeURIComponent(machineId)}/runtime-account-usage/${provider}/limit-reset`;
    const answer = await this.http.post<{ result?: unknown; snapshot?: unknown } | null>(url, kind ? { idempotencyKey, kind } : { idempotencyKey });
    const result = runtimeLimitResetResultSchema.safeParse(answer?.result);
    if (!result.success) throw new RuntimeAuthMalformedResponseError();
    const snapshot = answer?.snapshot ? safeParseRuntimeAccountUsageSnapshot(answer.snapshot) : null;
    return { result: result.data, snapshot: snapshot?.success ? snapshot.data : null };
  }

  /**
   * Reads which limit resets the Claude account holds on the Computer (it
   * opens Claude Code's own command for each kind and cancels it). Only on a
   * person's click. `consent`: the person accepted that, at the 5-hour limit,
   * opening the command can use the older program's 5-hour reset.
   */
  async readLimitResets(serverId: string, machineId: string, consent: boolean): Promise<RuntimeLimitResetsReadResult> {
    const url = `/servers/${encodeURIComponent(serverId)}/machines/${encodeURIComponent(machineId)}/runtime-account-usage/claude/limit-resets/read`;
    const answer = await this.http.post<{ result?: unknown } | null>(url, consent ? { consent: true } : {});
    const parsed = runtimeLimitResetsReadResultSchema.safeParse(answer?.result);
    if (!parsed.success) throw new RuntimeAuthMalformedResponseError();
    return parsed.data;
  }

  /** The providers a runtime with `connect_provider` (Qwen Code, Pi) offers on the Computer, read there. */
  async listProviders(serverId: string, machineId: string, runtime: RuntimeAuthRuntime): Promise<RuntimeAuthProvidersResult> {
    const answer = await this.http.get<{ result?: unknown } | null>(`${base(serverId, machineId)}/${runtime}/providers`);
    const parsed = runtimeAuthProvidersResultSchema.safeParse(answer?.result);
    if (!parsed.success) throw new RuntimeAuthMalformedResponseError();
    return parsed.data;
  }

  /**
   * Saves a provider's API key on the Computer. The key goes into this one
   * request body and nowhere else; never log `input`. The status is re-read
   * by the caller once the Computer answers.
   */
  async connectProvider(serverId: string, machineId: string, runtime: RuntimeAuthRuntime, input: RuntimeAuthProviderConnectInput): Promise<RuntimeAuthProviderConnectResult> {
    const answer = await this.http.post<{ result?: unknown } | null>(`${base(serverId, machineId)}/${runtime}/connect-provider`, input);
    const parsed = runtimeAuthProviderConnectResultSchema.safeParse(answer?.result);
    if (!parsed.success) throw new RuntimeAuthMalformedResponseError();
    return parsed.data;
  }

  clear(): void {
    this.cache.clear();
    this.reads.clear();
  }

  private notify(machineId: string): void {
    for (const listener of [...(this.listeners.get(machineId) ?? [])]) listener();
  }

  private readonly handleUpdated = (payload: { machineId?: unknown } | null) => {
    const machineId = payload?.machineId;
    if (typeof machineId !== "string") return;
    // The event names only the Computer: drop every server's view of it.
    for (const key of [...this.cache.keys(), ...this.reads.keys()]) {
      if (key.endsWith(`\0${machineId}`)) {
        this.cache.delete(key);
        this.reads.delete(key);
      }
    }
    this.notify(machineId);
  };

  private readonly handleLoginEvent = (payload: unknown) => {
    const header = loginPushHeader(payload);
    const event = header ? runtimeAuthLoginEventSchema.safeParse((payload as { event?: unknown }).event) : null;
    if (!header || !event?.success) return;
    for (const handlers of [...this.loginHandlers]) handlers.event({ ...header, event: event.data });
  };

  private readonly handleLoginResult = (payload: unknown) => {
    const header = loginPushHeader(payload);
    const result = header ? runtimeAuthLoginResultSchema.safeParse((payload as { result?: unknown }).result) : null;
    if (!header || !result?.success) return;
    for (const handlers of [...this.loginHandlers]) handlers.result({ ...header, result: result.data });
  };

  /**
   * Keeps the handlers on the socket instance in use while anyone listens: a
   * reconnect makes a new instance (the old one lost every listener), so the
   * handlers move to it.
   */
  private syncSocket(): void {
    const needed = this.listeners.size > 0 || this.loginHandlers.size > 0;
    if (needed && !this.stopReplacedWatch) {
      this.stopReplacedWatch = this.socketSource.onReplaced(() => this.syncSocket());
    } else if (!needed && this.stopReplacedWatch) {
      this.stopReplacedWatch();
      this.stopReplacedWatch = null;
    }
    const target = needed ? this.socketSource.current() : null;
    if (target === this.attached) return;
    const previous = this.attached;
    if (previous) {
      previous.off(RUNTIME_AUTH_UPDATED_EVENT, this.handleUpdated);
      previous.off(RUNTIME_AUTH_LOGIN_EVENT, this.handleLoginEvent);
      previous.off(RUNTIME_AUTH_LOGIN_RESULT_EVENT, this.handleLoginResult);
    }
    this.attached = target;
    if (target) {
      target.on(RUNTIME_AUTH_UPDATED_EVENT, this.handleUpdated);
      target.on(RUNTIME_AUTH_LOGIN_EVENT, this.handleLoginEvent);
      target.on(RUNTIME_AUTH_LOGIN_RESULT_EVENT, this.handleLoginResult);
    }
  }
}

export const runtimeAuthClient = new RuntimeAuthClient(
  {
    get: async <T,>(url: string) => (await api.get<T>(url)).data,
    // A limit reset answers with a usage snapshot: say this build reads window scopes.
    post: async <T,>(url: string, body?: unknown) => (await api.post<T>(url, body ?? {}, { headers: { ...RUNTIME_USAGE_REQUEST_HEADERS } })).data,
  },
  { current: () => getSocket(), onReplaced: (listener) => onSocketCreated(() => listener()) },
);

/** The server's error code on a failed request (`{code}` in the body), and its HTTP status. */
export function runtimeAuthRequestError(error: unknown): { status: number | null; code: string | null } {
  const response = (error as { response?: { status?: unknown; data?: { code?: unknown } } } | null)?.response;
  return {
    status: typeof response?.status === "number" ? response.status : null,
    code: typeof response?.data?.code === "string" ? response.data.code : null,
  };
}
