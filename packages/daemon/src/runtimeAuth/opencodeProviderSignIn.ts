import type { ExecutableInstallation, LoginProvider, OpencodeProviderAuth, OpencodeProviderAuthErrorKind, ProviderAuthStatus, Runtime } from "@botiverse/oar";
import {
  RUNTIME_AUTH_PROVIDER_OAUTH_METHOD_LIMIT,
  RUNTIME_AUTH_SIGNED_IN_PROVIDER_LIMIT,
  isRuntimeAuthProviderId,
  runtimeAuthOAuthMethodLabelSchema,
  runtimeAuthProviderSchema,
  type RuntimeAuthLoginResult,
  type RuntimeAuthProvider,
  type RuntimeAuthProviderFailureReason,
  type RuntimeAuthProviderKeyEntry,
  type RuntimeAuthProviderOAuthFlow,
  type RuntimeAuthSignedInProvider,
  type RuntimeAuthStatus,
} from "@botiverse/raft-shared";

import { piProviderLabel } from "./piProviderSignIn";

/**
 * OpenCode 2's sign-ins from the web (docs/contracts/runtime-auth.md §6c):
 * every integration OpenCode's own registry lists (OAR 0.100
 * `createOpencodeProviderAuth().loginProviders()`), each signed in on its own
 * through OpenCode's HTTP API on a local `opencode serve` OAR starts. Raft
 * keeps no list of providers for keys; account (OAuth) sign-ins are offered
 * only for the providers of `OPENCODE_OAUTH_PROVIDERS`. OAR never reads
 * OpenCode's credential files, and neither does Raft.
 *
 * One facade per Computer (`OpencodeSignIn`), kept for the daemon's life and
 * closed on shutdown: OAR stops its server `idleMs` after the last operation,
 * and every read after that is a cold start of 2-3 s, so the status is
 * cached and operations run one at a time. Never a key, a pasted code or a
 * token in a log, a trace or a message back: OAR's error messages are
 * redacted, and Raft reads only their kind.
 */

/** OAR's bound for starting `opencode serve` and for each request on it. */
export const OPENCODE_SIGN_IN_TIMEOUT_MS = 20_000;
/** How long one login waits for the person (OAR's default; OpenCode's own attempts expire after 600 s). */
export const OPENCODE_LOGIN_TIMEOUT_MS = 10 * 60_000;
/** How long OAR keeps `opencode serve` up after the last operation: long enough for list → sign in → status. */
export const OPENCODE_SIGN_IN_IDLE_MS = 30_000;
/**
 * How long a status read is reused. A sign-in change from the web clears it
 * at once; a change made on the Computer itself shows after this.
 */
export const OPENCODE_STATUS_CACHE_MS = 5 * 60_000;
/** How long a provider list, connect or logout waits for the operation before it (never a login: see `OpencodeSignIn.withFacade`). */
export const OPENCODE_QUEUE_WAIT_MS = 5_000;
/**
 * The whole of a provider list or connect on the Computer (queue wait and
 * OpenCode's work), ended as `timed_out` before the server's relay budget
 * (RUNTIME_AUTH_PROVIDER_RELAY_BUDGET_MS, 30 s) gives up on it; and of a
 * logout, before RUNTIME_AUTH_LOGOUT_RELAY_BUDGET_MS (45 s). The work itself
 * may still finish after it (a key may be saved): the status report after it
 * shows which.
 */
export const OPENCODE_PROVIDER_DEADLINE_MS = 25_000;
export const OPENCODE_LOGOUT_DEADLINE_MS = 40_000;

/**
 * The providers whose OpenCode account (OAuth) sign-ins the web offers, by
 * OpenCode's provider id; like Pi's `PI_OAUTH_FLOWS`, the one list, kept here
 * (the server and the web show what the daemon lists and filter nothing).
 * OpenCode lists every OAuth method of its registry, a plugin's too: one not
 * reviewed here is not offered (`opencodeOAuthMethods` lists none) and a login
 * for it is refused before OpenCode is asked (`opencodeOAuthAllowed`). Their
 * API-key sign-in is unaffected.
 *
 * `formSelect`: the one form answer the daemon gives, for a provider whose
 * sign-in asks a required select. OpenCode 2.2.7's GitHub Copilot sign-in
 * first asks a deployment type (GitHub.com or GitHub Enterprise, no default):
 * from the web it is always GitHub.com, as for Pi's Copilot (PI_OAUTH_FLOWS
 * blankText); Enterprise is not offered. OAR's prompt carries the field's
 * title and its option values, not its key, so it is matched by provider and
 * option value. Any other form question, Enterprise's URL included, is refused.
 */
export const OPENCODE_OAUTH_PROVIDERS: Readonly<Record<string, { formSelect?: string }>> = {
  "github-copilot": { formSelect: "github.com" },
  openai: {},
  xai: {},
};

/** Whether the web may start an OpenCode account sign-in for this provider (`OPENCODE_OAUTH_PROVIDERS`). */
export function opencodeOAuthAllowed(providerId: string): boolean {
  return Object.hasOwn(OPENCODE_OAUTH_PROVIDERS, providerId);
}

export function opencodeFormAnswer(providerId: string, prompt: { readonly kind: string; readonly options?: readonly { readonly id: string }[] }): string | null {
  const value = opencodeOAuthAllowed(providerId) ? OPENCODE_OAUTH_PROVIDERS[providerId]!.formSelect : undefined;
  if (value === undefined || prompt.kind !== "select") return null;
  return prompt.options?.some((option) => option.id === value) ? value : null;
}

/**
 * Whether an OAuth method's label names a sign-in that runs with no browser
 * on the Computer: a device code (GitHub Copilot "Login with GitHub
 * (device)", OpenAI "ChatGPT Pro/Plus (headless)"; on OpenCode 2.2.7 OpenAI's
 * "Codex device code (legacy)"). OpenCode does not say; its labels do. Only
 * an ordering and a hint: what the attempt shows decides. Known misses on
 * 2.2.7: xAI's "SuperGrok Subscription" is a device-code method (its id is
 * `device`, which OAR does not pass on) and reads as `link`, and whether
 * OpenAI's "Sign in with ChatGPT" (`chatgpt-token-sharing`) returns to a
 * localhost page is unknown without starting an attempt; neither is sorted
 * first. Both still show their device code or link once started.
 */
const DEVICE_CODE_LABEL = /\b(device|headless)\b/iu;

export function opencodeOAuthFlow(label: string): RuntimeAuthProviderOAuthFlow {
  return DEVICE_CODE_LABEL.test(label) ? "device_code" : "link";
}

/**
 * A provider's OAuth sign-ins as the web offers them: none for a provider
 * not on `OPENCODE_OAUTH_PROVIDERS`; else device-code methods first (they
 * need no browser on the Computer), then the others, each in OpenCode's
 * order. Labels the web could not carry are dropped.
 */
export function opencodeOAuthMethods(provider: LoginProvider): { label: string; flow: RuntimeAuthProviderOAuthFlow }[] {
  if (!opencodeOAuthAllowed(provider.providerId)) return [];
  // The provider list's own rule for a method label (runtimeAuthOAuthMethodLabelSchema): one odd label drops that method only.
  const methods = provider.methods
    .flatMap((method) => (method.method === "oauth" && runtimeAuthOAuthMethodLabelSchema.safeParse(method.name).success ? [method.name] : []))
    .map((label) => ({ label, flow: opencodeOAuthFlow(label) }));
  const ordered = [...methods.filter((method) => method.flow === "device_code"), ...methods.filter((method) => method.flow !== "device_code")];
  return ordered.slice(0, RUNTIME_AUTH_PROVIDER_OAUTH_METHOD_LIMIT);
}

/**
 * Integrations whose key sign-in asks more than the key (OAR 0.100 release
 * notes: Azure, Cloudflare, Snowflake Cortex): `setApiKey` refuses them
 * (`method_unavailable`) without storing anything. Matched by id prefix, as
 * OpenCode names them; one missed here is refused on the Computer instead.
 */
const OPENCODE_KEY_ASKING_MORE = /^(azure|cloudflare|snowflake)/u;

export function opencodeKeyEntry(provider: LoginProvider): RuntimeAuthProviderKeyEntry | null {
  const methods = provider.methods.filter((method) => method.method === "api_key");
  if (methods.length === 0) return null;
  // A prompt OpenCode has for the key wins over the environment variables it also reads.
  if (!methods.some((method) => method.method === "api_key" && !method.ambient)) return "outside";
  return OPENCODE_KEY_ASKING_MORE.test(provider.providerId) ? "more_fields" : "key";
}

/**
 * The stored sign-ins as the status report carries them. OpenCode does not
 * say whether an account is a subscription: `subscription` is left out, and
 * the web shows the kind as unknown. A credential with no method OAR knows
 * (an `external` one) is shown as an account.
 */
export function opencodeSignedInProviders(
  stored: readonly ProviderAuthStatus[],
  providers: readonly LoginProvider[],
): RuntimeAuthSignedInProvider[] {
  const names = new Map(providers.map((provider) => [provider.providerId, provider.name]));
  const rows: RuntimeAuthSignedInProvider[] = [];
  for (const entry of stored) {
    if (!entry.configured || !isRuntimeAuthProviderId(entry.providerId)) continue;
    rows.push({
      id: entry.providerId,
      label: piProviderLabel(names.get(entry.providerId), entry.providerId),
      method: entry.method === "api_key" ? "api_key" : "oauth",
    });
  }
  return rows.slice(0, RUNTIME_AUTH_SIGNED_IN_PROVIDER_LIMIT);
}

/** One integration of OpenCode's registry as the web chooses it; null for one the web could not show. */
export function opencodeWebProvider(provider: LoginProvider, stored: ProviderAuthStatus | undefined): RuntimeAuthProvider | null {
  if (!isRuntimeAuthProviderId(provider.providerId)) return null;
  const oauthMethods = opencodeOAuthMethods(provider);
  const apiKey = provider.methods.find((method) => method.method === "api_key" && !method.ambient)
    ?? provider.methods.find((method) => method.method === "api_key");
  const keyEntry = opencodeKeyEntry(provider);
  const configured = stored?.configured === true;
  const candidate: RuntimeAuthProvider = {
    id: provider.providerId,
    label: piProviderLabel(provider.name, provider.providerId),
    configured,
    endpoint: { kind: "fixed" },
    needsModelIds: false,
    signIn: {
      ...(oauthMethods.length > 0 ? { oauthMethods } : {}),
      ...(apiKey && keyEntry ? { apiKey: { label: piProviderLabel(apiKey.name, provider.providerId), entry: keyEntry } } : {}),
      ...(configured && stored?.method ? { stored: stored.method } : {}),
    },
  };
  const parsed = runtimeAuthProviderSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** An error kind read from an `OpencodeProviderAuthError`: OAR's own, or Raft's `not_installed` (`unavailableError`). */
export type OpencodeErrorKind = OpencodeProviderAuthErrorKind | "not_installed";

/** What a trace's `error_kind` may carry for OpenCode: an error's kind, the queue's own (`queue_timeout`, `deadline`, `closed`), else `other`. */
export type OpencodeTraceErrorKind = OpencodeErrorKind | "queue_timeout" | "deadline" | "closed" | "other";

/**
 * The kinds read: OAR 0.100's `OpencodeProviderAuthErrorKind` and Raft's
 * `not_installed`, every one listed (the type checks it against OAR's). A
 * closed set, so a trace never carries anything an error object made up.
 */
const OPENCODE_ERROR_KINDS: Readonly<Record<OpencodeErrorKind, true>> = {
  version_unsupported: true, unsupported_installation: true, startup_failed: true, server_failed: true, authentication_failed: true,
  timed_out: true, unknown_provider: true, method_unavailable: true, rejected: true, expired: true, loopback_required: true, not_installed: true,
};

/** OAR's error kind, read from an `OpencodeProviderAuthError` only and only when it is a known one; its message is never read. */
export function opencodeErrorKind(error: unknown): OpencodeErrorKind | undefined {
  if (!error || typeof error !== "object" || (error as { name?: unknown }).name !== "OpencodeProviderAuthError") return undefined;
  const kind = (error as { kind?: unknown }).kind;
  return typeof kind === "string" && Object.hasOwn(OPENCODE_ERROR_KINDS, kind) ? kind as OpencodeErrorKind : undefined;
}

/**
 * An error's kind for a trace: OAR's (`opencodeErrorKind`), the queue's
 * (`queue_timeout`, `deadline`, `closed`), else `other`. Never a message.
 */
export function opencodeTraceErrorKind(error: unknown): OpencodeTraceErrorKind {
  if (error instanceof OpencodeQueueTimeout) return "queue_timeout";
  if (error instanceof OpencodeDeadline) return "deadline";
  if (error instanceof OpencodeSignInClosed) return "closed";
  return opencodeErrorKind(error) ?? "other";
}

/** A queue wait that ran out: the operation before it was still running. */
export class OpencodeQueueTimeout extends Error {
  override readonly name = "OpencodeQueueTimeout";
}

/** An operation's total deadline passed (the queue wait and OpenCode's work); the work may still finish. */
export class OpencodeDeadline extends Error {
  override readonly name = "OpencodeDeadline";
}

/** The facade was closed (daemon shutdown) before this operation's turn. */
export class OpencodeSignInClosed extends Error {
  override readonly name = "OpencodeSignInClosed";
}

/** Why an OpenCode login ended without a sign-in, from OAR's error kind. */
export function opencodeLoginFailure(error: unknown): Exclude<RuntimeAuthLoginResult, { kind: "logged_in" | "cancelled" | "busy" }> {
  switch (opencodeErrorKind(error)) {
    case "not_installed": return { kind: "unsupported", reason: "not_installed" };
    case "version_unsupported": return { kind: "unsupported", reason: "version_unsupported" };
    case "unsupported_installation": return { kind: "unsupported", reason: "unsupported_installation" };
    // A provider OpenCode no longer lists, or a sign-in it no longer offers: nothing to run.
    case "unknown_provider":
    case "method_unavailable": return { kind: "unsupported", reason: "unsupported_installation" };
    case "loopback_required": return { kind: "failed", reason: "loopback_required" };
    case "timed_out":
    case "expired": return { kind: "failed", reason: "timed_out" };
    case "rejected": return { kind: "failed", reason: "rejected" };
    // startup_failed, server_failed, authentication_failed (another server answered on its port), anything else.
    default: return { kind: "failed", reason: "process_failed" };
  }
}

/** Why a provider list, connect or logout failed, from OAR's error kind; `errorKind` is for the trace only. */
export function opencodeProviderFailure(error: unknown):
  | { kind: "unsupported"; reason: "not_installed" | "version_unsupported" | "unsupported_installation"; errorKind: OpencodeTraceErrorKind }
  | { kind: "failed"; reason: RuntimeAuthProviderFailureReason; errorKind: OpencodeTraceErrorKind } {
  if (error instanceof OpencodeQueueTimeout || error instanceof OpencodeDeadline) return { kind: "failed", reason: "timed_out", errorKind: opencodeTraceErrorKind(error) };
  if (error instanceof OpencodeSignInClosed) return { kind: "failed", reason: "process_failed", errorKind: "closed" };
  const kind = opencodeErrorKind(error);
  switch (kind) {
    case "not_installed":
    case "version_unsupported":
    case "unsupported_installation": return { kind: "unsupported", reason: kind, errorKind: kind };
    case "timed_out": return { kind: "failed", reason: "timed_out", errorKind: kind };
    case "rejected":
    case "unknown_provider":
    case "method_unavailable": return { kind: "failed", reason: "rejected", errorKind: kind };
    case undefined: return { kind: "failed", reason: "process_failed", errorKind: "other" };
    // timed_out is handled above; expired never ends a list or key (a login's only).
    default: return { kind: "failed", reason: kind === "expired" ? "timed_out" : "process_failed", errorKind: kind };
  }
}

/** What one status read found: the stored sign-ins and the registry, or why there is none. */
export type OpencodeSnapshot =
  | { kind: "ready"; stored: readonly ProviderAuthStatus[]; providers: readonly LoginProvider[] }
  | { kind: "unavailable"; reason: "not_installed" | "version_unsupported" | "unsupported_installation" };

export function opencodeStatusOf(snapshot: OpencodeSnapshot): RuntimeAuthStatus {
  if (snapshot.kind === "unavailable") return { kind: "unavailable", reason: snapshot.reason };
  const providers = opencodeSignedInProviders(snapshot.stored, snapshot.providers);
  return providers.length > 0 ? { kind: "logged_in", providers } : { kind: "logged_out" };
}

/** Errors after which the facade is dropped, so the next operation re-reads the installation and starts afresh. */
const FACADE_ENDING_KINDS: ReadonlySet<OpencodeErrorKind> = new Set<OpencodeErrorKind>(["not_installed", "version_unsupported", "unsupported_installation", "startup_failed", "authentication_failed"]);

export interface OpencodeSignInDeps {
  /** OAR's `opencode` runtime, for its installation probe. */
  loadRuntime(): Promise<Runtime>;
  /** OAR's `createOpencodeProviderAuth` on that installation (oarLoader). */
  create(installation: ExecutableInstallation): Promise<OpencodeProviderAuth>;
  now(): number;
}

type Operation = "login" | "read" | "change";

/** How long an operation may wait for its turn, and for its turn and its work together (`OpencodeQueueTimeout`, `OpencodeDeadline`); unbounded when absent. */
export interface OpencodeOperationBounds {
  readonly waitMs?: number;
  readonly deadlineMs?: number;
}

/**
 * The Computer's one OpenCode sign-in facade: created on first use, kept,
 * and closed on daemon shutdown. Operations run one at a time (a login
 * holds the queue until it ends, up to OPENCODE_LOGIN_TIMEOUT_MS); a status
 * read never waits behind one, it answers from its cache. A status read is
 * cached for OPENCODE_STATUS_CACHE_MS and cleared by any change made here.
 * A runtime rescan (`markStale`) drops the facade, at once when idle, else
 * before the next operation, so an upgraded OpenCode, a changed path or
 * plugin set (its registry, its methods) takes effect.
 */
export class OpencodeSignIn {
  private facade: Promise<OpencodeProviderAuth> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private holder: Operation | null = null;
  private waiting = 0;
  /** Logins waiting for their turn: as good as running for a key save or a logout. */
  private queuedLogins = 0;
  private cache: { atMs: number; snapshot: OpencodeSnapshot } | null = null;
  private closed = false;
  /** Set by a rescan while an operation runs: the facade is dropped before the next one. */
  private stale = false;

  constructor(private readonly deps: OpencodeSignInDeps) {}

  /** A login holds the queue or waits for it: a key save and a logout are busy, another login too. */
  loginPending(): boolean {
    return this.holder === "login" || this.queuedLogins > 0;
  }

  /** Drops the cached status, so the next read asks OpenCode. */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * A runtime rescan: OpenCode may have been installed, upgraded, moved or
   * given other plugins. Drops the cached status and the facade (its
   * installation and its registry): at once when nothing uses it, else
   * before the next operation starts.
   */
  markStale(): void {
    this.cache = null;
    if (this.holder === null && this.waiting === 0) {
      void this.dropFacade();
      return;
    }
    this.stale = true;
  }

  /**
   * The status for a report: the cached read while it is fresh, or while
   * another operation holds the queue (any age; null when there is none,
   * reported as unknown); else a new read.
   */
  async snapshot(): Promise<OpencodeSnapshot | null> {
    const cached = this.cache;
    if (cached && this.deps.now() - cached.atMs < OPENCODE_STATUS_CACHE_MS) return cached.snapshot;
    if (this.holder !== null || this.waiting > 0) return cached?.snapshot ?? null;
    return this.read();
  }

  /** A new status read, through the queue, cached. */
  async read(bounds: OpencodeOperationBounds = {}): Promise<OpencodeSnapshot> {
    const snapshot = await this.withFacade("read", async (auth) => {
      const stored = await auth.listProviders({ resolve: false });
      return { kind: "ready", stored, providers: auth.loginProviders() } satisfies OpencodeSnapshot;
    }, bounds).catch((error: unknown): OpencodeSnapshot => {
      const kind = opencodeErrorKind(error);
      if (kind === "not_installed" || kind === "version_unsupported" || kind === "unsupported_installation") return { kind: "unavailable", reason: kind };
      throw error;
    });
    this.cache = { atMs: this.deps.now(), snapshot };
    return snapshot;
  }

  /**
   * Runs `work` on the facade once every operation before it has ended.
   * `bounds.waitMs`: how long to wait for them (OpencodeQueueTimeout after
   * it); `bounds.deadlineMs`: how long the wait and the work may take
   * together (OpencodeDeadline after it; the work runs on and keeps its turn
   * until it ends, so the queue stays one at a time). Unbounded when absent.
   * A change clears the cached status whatever its outcome.
   */
  async withFacade<T>(operation: Operation, work: (auth: OpencodeProviderAuth) => Promise<T>, bounds: OpencodeOperationBounds = {}): Promise<T> {
    if (bounds.deadlineMs === undefined) return this.inTurn(operation, work, bounds.waitMs);
    const run = this.inTurn(operation, work, bounds.waitMs);
    // Past the deadline the caller has its answer; the run's own outcome then has no one to hear it.
    run.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new OpencodeDeadline(`OpenCode sign-in did not finish within ${String(bounds.deadlineMs)} ms`)), bounds.deadlineMs);
    });
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async inTurn<T>(operation: Operation, work: (auth: OpencodeProviderAuth) => Promise<T>, waitMs: number | undefined): Promise<T> {
    if (this.closed) throw new OpencodeSignInClosed("OpenCode sign-in is closed");
    const before = this.tail;
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    this.tail = before.then(() => mine);
    this.waiting += 1;
    if (operation === "login") this.queuedLogins += 1;
    try {
      if (waitMs === undefined) {
        await before;
      } else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<"expired">((resolve) => { timer = setTimeout(() => resolve("expired"), waitMs); });
        const outcome = await Promise.race([before.then(() => "ready" as const), expired]);
        clearTimeout(timer);
        if (outcome === "expired") {
          // Our turn is given up: the queue moves on to whoever is behind us once `before` ends.
          release();
          throw new OpencodeQueueTimeout(`OpenCode sign-in busy for ${String(waitMs)} ms`);
        }
      }
    } finally {
      this.waiting -= 1;
      if (operation === "login") this.queuedLogins -= 1;
    }
    this.holder = operation;
    try {
      // Closed while this one waited (daemon shutdown): start nothing.
      if (this.closed) throw new OpencodeSignInClosed("OpenCode sign-in is closed");
      if (this.stale) {
        this.stale = false;
        await this.dropFacade();
      }
      const auth = await this.auth();
      try {
        return await work(auth);
      } catch (error) {
        const kind = opencodeErrorKind(error);
        if (kind && FACADE_ENDING_KINDS.has(kind)) await this.dropFacade();
        throw error;
      }
    } finally {
      if (operation !== "read") this.cache = null;
      this.holder = null;
      release();
    }
  }

  /** Stops OpenCode's server now (daemon shutdown); no operation starts after it. */
  async close(): Promise<void> {
    this.closed = true;
    await this.dropFacade();
  }

  private async auth(): Promise<OpencodeProviderAuth> {
    if (!this.facade) {
      const creating = this.createFacade();
      this.facade = creating;
      creating.catch(() => { if (this.facade === creating) this.facade = null; });
    }
    return this.facade;
  }

  private async createFacade(): Promise<OpencodeProviderAuth> {
    const runtime = await this.deps.loadRuntime();
    if (!runtime.installation) throw unavailableError("unsupported_installation");
    const installation = await runtime.installation();
    if (installation.kind === "not_found") throw unavailableError("not_installed");
    if (installation.kind !== "available" || installation.via !== "executable") throw unavailableError("unsupported_installation");
    return this.deps.create(installation);
  }

  private async dropFacade(): Promise<void> {
    const facade = this.facade;
    this.facade = null;
    if (!facade) return;
    try {
      await (await facade).close();
    } catch {
      // A facade that never came up has nothing to stop.
    }
  }
}

/**
 * The installation was not there or not usable: thrown in the shape of OAR's
 * error, so one mapping reads every kind (`not_installed` is Raft's own,
 * from OAR's installation probe).
 */
function unavailableError(kind: "not_installed" | "unsupported_installation"): Error {
  const error = new Error(kind === "not_installed" ? "OpenCode is not installed" : "OpenCode's installation cannot sign in");
  error.name = "OpencodeProviderAuthError";
  (error as Error & { kind: string }).kind = kind;
  return error;
}
