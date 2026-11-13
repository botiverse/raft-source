import { homedir } from "node:os";

import type { AuthStatus, LoginAccount, LoginUnsupportedReason, ProviderAuthFacade, ProviderLoginEvent, ProviderLoginInteraction, Runtime } from "@botiverse/oar";
import type { QwenProvider, QwenProviderAuth } from "@botiverse/oar/runtimes/qwen";
import {
  RUNTIME_AUTH_PROVIDER_LIST_LIMIT,
  RUNTIME_AUTH_RUNTIMES,
  RUNTIME_AUTH_UNSUPPORTED_REASONS,
  RUNTIME_AUTH_V1_RUNTIMES,
  SERVER_CAPABILITY_RUNTIME_AUTH_V1,
  SERVER_CAPABILITY_RUNTIME_AUTH_V2,
  isOpencodeLiteralApiKey,
  isPiLiteralApiKey,
  maskRuntimeAccountEmail,
  runtimeAuthRuntimeFor,
  runtimeAuthAccountSchema,
  runtimeAuthLoginEventSchema,
  runtimeAuthLoginResultSchema,
  runtimeAuthLogoutResultSchema,
  runtimeAuthProviderConnectResultSchema,
  runtimeAuthProviderSchema,
  runtimeAuthProvidersResultSchema,
  runtimeAuthSignsInPerProvider,
  runtimeAuthStatusSchema,
  runtimeAuthSupports,
  type RuntimeAuthAccount,
  type RuntimeAuthLoginEvent,
  type RuntimeAuthLoginId,
  type RuntimeAuthLoginRegion,
  type RuntimeAuthLoginResult,
  type RuntimeAuthLogoutResult,
  type RuntimeAuthProvider,
  type RuntimeAuthProviderConnectInput,
  type RuntimeAuthProviderConnectResult,
  type RuntimeAuthProviderFailureReason,
  type RuntimeAuthProvidersResult,
  type RuntimeAuthRuntime,
  type RuntimeAuthStatus,
  type RuntimeAuthStatusReport,
} from "@botiverse/raft-shared";

import type { OarProviderAuth } from "../oarLoader";
import { kimiSdkAuthLogin, kimiSdkAuthLogout, type KimiSdkAuth } from "./kimiSdkAuth";
import {
  OPENCODE_LOGOUT_DEADLINE_MS,
  OPENCODE_PROVIDER_DEADLINE_MS,
  OPENCODE_QUEUE_WAIT_MS,
  opencodeFormAnswer,
  opencodeKeyEntry,
  opencodeLoginFailure,
  opencodeOAuthAllowed,
  opencodeOAuthMethods,
  opencodeProviderFailure,
  opencodeStatusOf,
  opencodeTraceErrorKind,
  opencodeWebProvider,
  type OpencodeSignIn,
  type OpencodeTraceErrorKind,
} from "./opencodeProviderSignIn";
import { PI_OAUTH_FLOWS, piKeyEntry, piLoginFailureReason, piOAuthFlow, piSignedInProviders, piWebProvider } from "./piProviderSignIn";

/**
 * task #17: web login and logout for this Computer's runtimes (Claude Code,
 * Codex, Kimi, Qoder, Antigravity, Grok Build, CodeBuddy Code), run here through OAR, except Kimi Code's: that runs on
 * the Kimi Code SDK the daemon bundles (kimiSdkAuth.ts), the one its agents
 * run on, so it needs no Kimi Code CLI installed. Credentials stay in the
 * runtime's own store. The daemon relays the link or device code and the
 * result; the one-time code the person pastes goes to that login's prompt only
 * and is never logged, traced or kept after the login ends.
 *
 * Antigravity (OAR 0.97): status is `agy models`, login `agy acp --login`,
 * whose Google link is relayed and whose code (or the address the browser
 * landed on) the person pastes back through the same code prompt as Claude's.
 * Its logout (OAR 0.98) is agy's ACP `logout`, then `agy models` decides:
 * `unsupported {version_unsupported}` from an agy build without it, `failed
 * {still_logged_in}` while another sign-in is still active.
 *
 * Grok Build (OAR 0.99): status is `grok models` (signed in names its method,
 * e.g. "grok.com"), login `grok login --device-auth`, whose device code and
 * accounts.x.ai link are relayed as `device_code`: the person confirms the
 * code there and pastes nothing back. On Windows OAR cannot keep grok from
 * opening a browser on the Computer and answers `browser_suppression_unavailable`,
 * shown as unsupported. Its logout is `grok logout`, then `grok models`
 * decides; `failed {still_logged_in}` means another xAI sign-in (such as an
 * API key in the environment; that Grok Build reads XAI_API_KEY is assumed, not
 * verified) is still active. Both hosts' Grok agents run the same
 * `grok` CLI on the same store (`$GROK_HOME/auth.json`, `~/.grok` by default),
 * so the web sign-in serves agents on the legacy driver too.
 *
 * Qwen Code has no sign-in: a model provider's API key is saved in Qwen's own
 * settings (OAR's provider facade). The key arrives in one server message,
 * goes to OAR's `connect` and nowhere else: never into a log, a trace, a
 * message back, or a field of this host.
 *
 * Pi signs in per model provider, in the Computer's own Pi `auth.json` (OAR's
 * `createPiProviderAuth`, in-process, so on Windows too): every provider pi's
 * `/login` lists, by OAuth (piProviderSignIn.ts says how each flow runs from
 * here and answers pi's own questions in it) or by an API key, which goes to
 * `setApiKey` only, under the same rules as Qwen's, and only when pi would
 * keep it literal (no leading `!`, no `$`). Its status reads the stored
 * sign-ins without resolving any (no OAuth refresh, no key command run).
 *
 * OpenCode 2 signs in per provider too, through its own server (OAR 0.100
 * `createOpencodeProviderAuth`, `loopback: "refuse"`): one facade for the
 * daemon's life (opencodeProviderSignIn.ts), its operations one at a time and
 * its status cached. The person chooses the OAuth method (device code
 * first); one that only a browser on the Computer could finish ends as
 * `failed {loopback_required}` before any link is shown. OpenCode 1 answers
 * `unavailable {version_unsupported}`.
 */

/**
 * OAR's own bound for a status query (Claude, Codex and Kimi default to 20s,
 * Qoder's networked `qodercli status` to 30s): one report waits on the slowest.
 */
export const RUNTIME_AUTH_STATUS_TIMEOUT_MS = 20_000;
/**
 * The bound for OAR's logout, its confirming status read included: from OAR
 * 0.100 that read (Claude, Codex, Antigravity's `agy models`, Grok's
 * `grok models`) takes what is left of the caller's `timeoutMs` (at least
 * 1s), where before it ran at OAR's own default outside it (20s; 30s for
 * Antigravity and Grok, which had a 10s logout bound of their own for it).
 * The server waits RUNTIME_AUTH_LOGOUT_RELAY_BUDGET_MS (45s) for the whole
 * round trip: OAR's installation check (bounded only by OAR at 30s, normally
 * well under a second), then this, which leaves about 15s of room, also for
 * a logout that ends slightly after its bound (OAR's contract). A
 * pathologically slow probe can still outlast the relay: the person then
 * sees the timeout, and the status report after the logout corrects the
 * card. OAR's own logout default (60s) would outlast the relay every time
 * the logout hangs.
 */
export const RUNTIME_AUTH_LOGOUT_TIMEOUT_MS = 30_000;
/**
 * The bound for one OAR provider operation (Qwen starts its own process to
 * list providers or to save one; OAR's default is 30s). The server waits
 * RUNTIME_AUTH_PROVIDER_RELAY_BUDGET_MS (30s) for the round trip: OAR's
 * installation check (`qwen --version`, normally well under a second), then
 * this, which leaves about 10s of room. A connect that outlasts it may or may
 * not have saved (OAR's contract); the status report after it shows which.
 */
export const RUNTIME_AUTH_PROVIDER_TIMEOUT_MS = 20_000;

/** Runtimes only the OAR host runs, which does not run on Windows (agentHost/oarAgentHost.ts). */
const OAR_HOST_ONLY_RUNTIMES: ReadonlySet<RuntimeAuthRuntime> = new Set(["qoder", "qwen", "codebuddy"]);

/**
 * The environment OAR runs a runtime's status, login and logout in, as its agents run
 * it: `agy` keeps a separate file-based sign-in when it sees an SSH session,
 * so its agents are started without one (drivers/antigravity.deprecated.ts
 * ANTIGRAVITY_ENV_OVERRIDES), and so are its status, login and logout here,
 * or the person would sign in (or out of) a store the agents never read.
 */
export const RUNTIME_AUTH_OAR_ENV: Readonly<Partial<Record<RuntimeAuthRuntime, Readonly<Record<string, null>>>>> = {
  antigravity: { SSH_CLIENT: null, SSH_CONNECTION: null, SSH_TTY: null },
};

function oarEnvOption(runtimeId: RuntimeAuthRuntime): { env?: Record<string, null> } {
  const env = RUNTIME_AUTH_OAR_ENV[runtimeId];
  return env ? { env: { ...env } } : {};
}

/**
 * The runtimes a server reads in a status report, from its `machine:context`
 * capabilities: none without V1; Claude Code and Codex only without V2 (its
 * schema refuses a whole report that names any other runtime).
 *
 * Returns one of two constant arrays (or null), never a fresh one: callers
 * compare results by reference to tell whether the server's reads changed.
 */
export function runtimeAuthRuntimesReadBy(serverCapabilities: readonly string[]): readonly RuntimeAuthRuntime[] | null {
  if (!serverCapabilities.includes(SERVER_CAPABILITY_RUNTIME_AUTH_V1)) return null;
  return serverCapabilities.includes(SERVER_CAPABILITY_RUNTIME_AUTH_V2) ? RUNTIME_AUTH_RUNTIMES : RUNTIME_AUTH_V1_RUNTIMES;
}

export type RuntimeAuthHostMessage =
  | { type: "machine:runtime_auth:status"; report: RuntimeAuthStatusReport }
  | { type: "machine:runtime_auth:login:event"; loginId: RuntimeAuthLoginId; event: RuntimeAuthLoginEvent }
  | { type: "machine:runtime_auth:login:result"; loginId: RuntimeAuthLoginId; result: RuntimeAuthLoginResult }
  | { type: "machine:runtime_auth:logout:result"; requestId: string; result: RuntimeAuthLogoutResult }
  | { type: "machine:runtime_auth:providers:result"; requestId: string; result: RuntimeAuthProvidersResult }
  | { type: "machine:runtime_auth:connect_provider:result"; requestId: string; result: RuntimeAuthProviderConnectResult };

/** What changed a runtime's machine-shared credentials: a web login, a logout, or a provider key saved. */
export type RuntimeAuthCredentialsChange = "login" | "logout" | "connect_provider";

export interface RuntimeAuthHostDeps {
  /** OAR's runtime, for every runtime but Kimi. */
  loadRuntime(id: RuntimeAuthRuntime): Promise<Runtime>;
  /**
   * Kimi Code's sign-in status, read from its stored tokens without loading
   * the SDK (`readKimiCodeSignInStatus`): every report asks it, on every
   * daemon. Never OAR's `kimi`.
   */
  kimiStatus(): Promise<RuntimeAuthStatus>;
  /**
   * Kimi Code's sign-in on the bundled Kimi Code SDK (`loadKimiSdkAuth`),
   * which loads the SDK: for a login or a logout only, never a status.
   */
  loadKimiAuth(): Promise<KimiSdkAuth>;
  /**
   * OAR's provider settings facade for a runtime with `connect_provider`
   * (Qwen Code's `createQwenProviderAuth`), loaded on first use; null for
   * a runtime OAR has none for.
   */
  loadProviderAuth(id: RuntimeAuthRuntime): Promise<OarProviderAuth | null>;
  send(message: RuntimeAuthHostMessage): void;
  /** Trace attributes only: runtime, outcome, reason, durations. Never a link, code or account. */
  recordEvent(name: string, attrs: Record<string, string | number | boolean | undefined>): void;
  now(): number;
  /**
   * The runtimes the connected server reads in a status report (V1: Claude
   * Code and Codex; V2: all), or null when no connected server reads one:
   * then no status query runs and no report is sent.
   */
  serverReads(): readonly RuntimeAuthRuntime[] | null;
  /**
   * Called once after a login, logout or provider connect that succeeded
   * (never after a failed, cancelled, busy or timed-out one), after its result
   * was sent. Stop-gap (#proj-raft-computer:#46): the agent hosts clear what
   * kept agents on this runtime's shared credentials from waking.
   */
  onCredentialsChanged?(runtime: RuntimeAuthRuntime, reason: RuntimeAuthCredentialsChange): void;
  /**
   * Pi's provider sign-ins on this Computer (OAR's `createPiProviderAuth`)
   * on the `auth.json` the Pi runtime's agents read by default (the daemon's
   * Pi agent dir), created fresh for each operation; never Built-in Pi's.
   */
  loadPiAuth?(): Promise<ProviderAuthFacade>;
  /**
   * OpenCode 2's sign-ins on this Computer: the daemon's one facade
   * (opencodeProviderSignIn.ts), closed on shutdown through `close()`.
   */
  opencode?: OpencodeSignIn;
  /**
   * Pi's stable id for this installation (its own settings' device id), for
   * the one flow that needs it (OpenAI "Sign in with ChatGPT"); asked only
   * when that flow runs.
   */
  piDeviceId?(): string;
  /**
   * A runtime's sign-ins may have changed the models it can run (Pi lists the
   * models of the providers it can authenticate): re-detect them, so the
   * model picker follows. Called after a Pi login, logout or key save that
   * did (or may have) changed `auth.json`.
   */
  rescanModels?(runtime: RuntimeAuthRuntime): void;
  /** This Computer's platform; the process's when absent. */
  platform?: NodeJS.Platform;
  /**
   * Where the runtime reads its settings relative to for a provider list or
   * connect: the home of the account running this daemon when absent (the
   * key is saved in user scope, for every agent of that account).
   */
  providerSettingsCwd?: string;
}

interface ActiveLogin {
  readonly runtime: RuntimeAuthRuntime;
  /** The region the person chose, for a runtime whose login asks for one (Kimi). */
  readonly region: RuntimeAuthLoginRegion | undefined;
  /** The provider to sign in, for a runtime that signs in per provider (Pi, OpenCode). */
  readonly providerId: string | undefined;
  /** The OAuth method the person chose, by its label (OpenCode); absent: the provider's preferred one. */
  readonly oauthMethod: string | undefined;
  /** OAR's error kind when the login failed on one (OpenCode), for the result's trace only: a closed set, never a message. */
  errorKind?: OpencodeTraceErrorKind;
  readonly controller: AbortController;
  readonly startedAtMs: number;
  /** The open code prompt, if the runtime is waiting for one. */
  pendingCode: { resolve: (code: string) => void; reject: (error: Error) => void } | null;
  codePrompts: number;
}

export class RuntimeAuthHost {
  private readonly logins = new Map<RuntimeAuthLoginId, ActiveLogin>();
  /** The last detection's runtime ids, so a report after a login or logout probes the same set. */
  private detected: string[] | null = null;
  /** One status report at a time; a request while one runs queues exactly one more, so the last report sent is the newest. */
  private reporting: Promise<void> | null = null;
  private reportAgain: string | null = null;
  /** OAR's credential / metering per runtime from the last status read (trace only; the web report carries labels). Not cleared on sign-out: the trace reads it only for a runtime the current report shows logged_in, and every logged_in read overwrites it. Kimi Code and Qwen Code (their own status paths) set none. */
  private readonly signInKinds = new Map<RuntimeAuthRuntime, { signIn?: "account" | "api_key"; billing?: "plan" | "usage" }>();
  /** Report runs started so far, and the newest report sent with the run it came from. */
  private reportRuns = 0;
  private lastReport: { run: number; report: RuntimeAuthStatusReport } | null = null;
  /** The runtimes a provider connect is running for: one at a time each, since each writes the same settings. */
  private readonly connecting = new Set<RuntimeAuthRuntime>();
  /**
   * The bundled SDK's Kimi login until it has really ended: after a cancel
   * it runs on to its next poll and could still save a token and rewrite
   * Kimi's config, so another Kimi login is busy until then.
   */
  private kimiSdkLogin: Promise<void> | null = null;

  constructor(private readonly deps: RuntimeAuthHostDeps) {}

  /**
   * The status of each runtime the server reads, from OAR's status query
   * (Kimi: its stored tokens, read without loading the SDK), read only, no
   * secret. `detected` holds Raft
   * runtime ids, matched through `runtimeAuthRuntimeFor`: `kimi` is in for
   * Kimi Code (`kimi-sdk`) only. Every daemon with this code lists `kimi-sdk`
   * (an in-process SDK whose probe is always available), and its sign-in is
   * that same SDK, so it is never `not_installed` here. The Kimi CLI (`kimi`)
   * counts for none.
   */
  async collectStatus(runtimes: readonly RuntimeAuthRuntime[], detected?: readonly string[]): Promise<RuntimeAuthStatusReport> {
    const collectedAt = new Date(this.deps.now()).toISOString();
    // Runtimes detection did not find are reported as not installed, and one
    // this Computer cannot run as unsupported, without running anything; the
    // others ask OAR's status query.
    const entries = await Promise.all(runtimes.map(async (runtimeId) => [
      runtimeId,
      detected && !detected.some((raftRuntimeId) => runtimeAuthRuntimeFor(raftRuntimeId) === runtimeId)
        ? ({ kind: "unavailable", reason: "not_installed" } as const)
        : !this.runsHere(runtimeId)
          ? ({ kind: "unavailable", reason: "unsupported_installation" } as const)
          : await this.statusOf(runtimeId),
    ] as const));
    return { collectedAt, runtimes: Object.fromEntries(entries) };
  }

  async reportStatus(trigger: string, detected?: readonly string[]): Promise<void> {
    if (detected) {
      this.detected = [...detected];
      // A runtime rescan: OpenCode may have been installed, upgraded to 2, moved or given other plugins since its last read.
      // Drops its cached status and its facade (installation, registry), so the change takes effect.
      this.deps.opencode?.markStale();
    }
    if (this.reporting) {
      this.reportAgain = trigger;
      return this.reporting;
    }
    this.reporting = (async () => {
      try {
        let next: string | null = trigger;
        while (next !== null) {
          const current = next;
          this.reportAgain = null;
          const runtimes = this.deps.serverReads();
          if (!runtimes) break;
          const run = ++this.reportRuns;
          const report = await this.collectStatus(runtimes, this.detected ?? undefined);
          this.deps.send({ type: "machine:runtime_auth:status", report });
          this.lastReport = { run, report };
          const attrs: Record<string, string | undefined> = { trigger: current };
          for (const runtimeId of runtimes) {
            attrs[runtimeId] = report.runtimes[runtimeId]?.kind;
            // How each runtime is signed in (subscription vs API key, and the
            // plan), as OAR names it. Labels only; never the masked account.
            Object.assign(attrs, authAccountTraceAttrs(runtimeId, report.runtimes[runtimeId]));
            // OAR's closed sets: account vs api_key, plan vs usage (Cindy, #oar-raft:eea998ea).
            const kinds = report.runtimes[runtimeId]?.kind === "logged_in" ? this.signInKinds.get(runtimeId) : undefined;
            attrs[`${runtimeId}_sign_in_kind`] = kinds?.signIn;
            attrs[`${runtimeId}_billing_kind`] = kinds?.billing;
          }
          this.deps.recordEvent("daemon.runtime_auth.status.reported", attrs);
          next = this.reportAgain;
        }
      } finally {
        // Cleared in the same tick the loop exits, so a request arriving after
        // the last read of reportAgain starts a new run instead of being lost.
        this.reporting = null;
      }
    })();
    return this.reporting;
  }

  /**
   * Reconciler step 15: sends a status report (as `reportStatus`) and returns
   * `runtime`'s status in a report whose query started after this call, or
   * null when none ran (no server reads one) or it does not name the runtime.
   * A report already running when this is called is too old to count: the
   * one queued after it answers.
   */
  async reportFreshStatus(trigger: string, runtime: RuntimeAuthRuntime): Promise<RuntimeAuthStatus | null> {
    const since = this.reportRuns;
    await this.reportStatus(trigger);
    const last = this.lastReport;
    return last && last.run > since ? last.report.runtimes[runtime] ?? null : null;
  }

  /**
   * `region`: checked against the runtime by the caller
   * (`runtimeAuthLoginRegionFits`); `providerId` likewise
   * (`runtimeAuthProviderIdFits`), and `oauthMethod`
   * (`runtimeAuthOAuthMethodFits`).
   */
  startLogin(loginId: RuntimeAuthLoginId, runtimeId: RuntimeAuthRuntime, region?: RuntimeAuthLoginRegion, providerId?: string, oauthMethod?: string): void {
    // A start repeated for a login that is already running (a redelivery) changes nothing.
    if (this.logins.has(loginId)) return;
    if ([...this.logins.values()].some((login) => login.runtime === runtimeId) || (runtimeId === "kimi" && this.kimiSdkLogin)) {
      // Answered without touching the running login.
      this.deps.send({ type: "machine:runtime_auth:login:result", loginId, result: { kind: "busy" } });
      this.deps.recordEvent("daemon.runtime_auth.login.result", { runtime: runtimeId, outcome: "busy", duration_ms: 0 });
      return;
    }
    const login: ActiveLogin = { runtime: runtimeId, region, providerId, oauthMethod, controller: new AbortController(), startedAtMs: this.deps.now(), pendingCode: null, codePrompts: 0 };
    this.logins.set(loginId, login);
    // The region and the provider id are no secret: which service the person signs in to.
    this.deps.recordEvent("daemon.runtime_auth.login.started", { runtime: runtimeId, region, ...providerIdAttr(providerId) });
    void this.runLogin(loginId, login).then(
      (result) => this.finishLogin(loginId, runtimeId, result, login.startedAtMs, providerId),
      () => this.finishLogin(loginId, runtimeId, { kind: "failed", reason: "process_failed" }, login.startedAtMs, providerId),
    );
  }

  /** Writes the pasted code to the login waiting for it. Unknown or finished logins drop it silently. */
  submitCode(loginId: RuntimeAuthLoginId, code: string): void {
    const login = this.logins.get(loginId);
    const answer = login?.pendingCode;
    if (!login || !answer) {
      this.deps.recordEvent("daemon.runtime_auth.login.code_dropped", { reason: login ? "no_prompt" : "unknown_login" });
      return;
    }
    login.pendingCode = null;
    answer.resolve(code);
  }

  cancelLogin(loginId: RuntimeAuthLoginId): void {
    this.logins.get(loginId)?.controller.abort();
  }

  /** `providerId`: the provider to sign out, for a runtime that signs in per provider (Pi); checked by the caller. */
  async logout(requestId: string, runtimeId: RuntimeAuthRuntime, providerId?: string): Promise<void> {
    const startedAtMs = this.deps.now();
    const trace: ErrorKindTrace = {};
    const result = await (runtimeId === "pi"
      ? this.runPiLogout(providerId)
      : runtimeId === "opencode" ? this.runOpencodeLogout(providerId, trace) : this.runLogout(runtimeId))
      .catch((): RuntimeAuthLogoutResult => ({ kind: "failed", reason: "process_failed" }));
    this.deps.send({ type: "machine:runtime_auth:logout:result", requestId, result });
    this.deps.recordEvent("daemon.runtime_auth.logout.result", {
      runtime: runtimeId,
      ...providerIdAttr(providerId),
      outcome: result.kind,
      reason: "reason" in result ? result.reason : undefined,
      ...errorKindAttr(trace.errorKind),
      duration_ms: this.deps.now() - startedAtMs,
    });
    if (result.kind === "logged_out") {
      this.credentialsChanged(runtimeId, "logout");
      this.modelsMayHaveChanged(runtimeId);
    }
    if (this.deps.serverReads()) await this.reportStatus("logout").catch(() => undefined);
  }

  /** The model providers the runtime offers here, for the person to choose one (read only; no secret). */
  async listProviders(requestId: string, runtimeId: RuntimeAuthRuntime): Promise<void> {
    const startedAtMs = this.deps.now();
    const trace: ErrorKindTrace = {};
    let errorKind: string | undefined;
    const result = await this.runListProviders(runtimeId, trace).catch((error: unknown): RuntimeAuthProvidersResult => {
      const failure = providerFailure(error);
      errorKind = failure.errorKind;
      return { kind: "failed", reason: failure.reason };
    });
    // The fields are built from checked values; a result that still fails is a bug here, sent as unreadable.
    const checked = runtimeAuthProvidersResultSchema.safeParse(result);
    const sent: RuntimeAuthProvidersResult = checked.success ? checked.data : { kind: "failed", reason: "invalid_response" };
    this.deps.send({ type: "machine:runtime_auth:providers:result", requestId, result: sent });
    this.deps.recordEvent("daemon.runtime_auth.providers.result", {
      runtime: runtimeId,
      outcome: sent.kind,
      reason: "reason" in sent ? sent.reason : undefined,
      error_kind: errorKind ?? trace.errorKind,
      provider_count: sent.kind === "listed" ? sent.providers.length : undefined,
      duration_ms: this.deps.now() - startedAtMs,
    });
  }

  /**
   * Saves a provider's API key in the runtime's own settings (user scope).
   * `input.apiKey` goes to OAR's connect and nowhere else: the result, the
   * trace and the status report after it carry the provider id and the
   * outcome only. One connect per runtime at a time; another gets `busy`.
   */
  async connectProvider(requestId: string, runtimeId: RuntimeAuthRuntime, input: RuntimeAuthProviderConnectInput): Promise<void> {
    const startedAtMs = this.deps.now();
    const trace: ErrorKindTrace = {};
    let errorKind: string | undefined;
    let result: RuntimeAuthProviderConnectResult;
    if (this.connecting.has(runtimeId)) {
      result = { kind: "busy" };
    } else {
      this.connecting.add(runtimeId);
      try {
        result = await this.runConnectProvider(runtimeId, input, trace);
      } catch (error) {
        const failure = providerFailure(error);
        errorKind = failure.errorKind;
        result = { kind: "failed", reason: failure.reason };
      } finally {
        this.connecting.delete(runtimeId);
      }
    }
    // Reasons are pinned by the types; parse only to keep the wire honest.
    const sent = runtimeAuthProviderConnectResultSchema.parse(result);
    this.deps.send({ type: "machine:runtime_auth:connect_provider:result", requestId, result: sent });
    this.deps.recordEvent("daemon.runtime_auth.connect_provider.result", {
      runtime: runtimeId,
      // Qwen's menu id ("deepseek"), checked against a short pattern: no secret.
      provider_id: input.providerId,
      outcome: sent.kind,
      reason: "reason" in sent ? sent.reason : undefined,
      error_kind: errorKind ?? trace.errorKind,
      duration_ms: this.deps.now() - startedAtMs,
    });
    if (sent.kind === "connected") this.credentialsChanged(runtimeId, "connect_provider");
    // A save, or one that ran out of time and may have saved: the card reads the new status.
    const mayHaveSaved = sent.kind === "connected" || (sent.kind === "failed" && sent.reason === "timed_out");
    if (mayHaveSaved) this.modelsMayHaveChanged(runtimeId);
    if (mayHaveSaved && this.deps.serverReads()) await this.reportStatus("connect_provider").catch(() => undefined);
  }

  /** Stops every running login (daemon shutdown or a lost server connection's cleanup). */
  cancelAll(): void {
    for (const login of this.logins.values()) login.controller.abort();
  }

  /** Daemon shutdown: every login stopped, and OpenCode's sign-in server with them. */
  async close(): Promise<void> {
    this.cancelAll();
    await this.deps.opencode?.close().catch(() => undefined);
  }

  /** Qoder, Qwen Code and CodeBuddy Code run on the OAR host only, which does not run on Windows (agentHost/oarAgentHost.ts). */
  private runsHere(runtimeId: RuntimeAuthRuntime): boolean {
    return !(OAR_HOST_ONLY_RUNTIMES.has(runtimeId) && (this.deps.platform ?? process.platform) === "win32");
  }

  private async statusOf(runtimeId: RuntimeAuthRuntime): Promise<RuntimeAuthStatus> {
    try {
      if (runtimeId === "kimi") return await this.deps.kimiStatus();
      if (runtimeId === "pi") return await this.piStatus();
      if (runtimeId === "opencode") return await this.opencodeStatus();
      const runtime = await this.deps.loadRuntime(runtimeId);
      if (!runtime.installation || !runtime.authStatus) return { kind: "unavailable", reason: "unsupported_installation" };
      const installation = await runtime.installation();
      if (installation.kind === "not_found") return { kind: "unavailable", reason: "not_installed" };
      if (installation.kind !== "available") return { kind: "unavailable", reason: "unsupported_installation" };
      const status = await runtime.authStatus(installation, { timeoutMs: RUNTIME_AUTH_STATUS_TIMEOUT_MS, ...oarEnvOption(runtimeId) });
      if (runtimeAuthSupports(runtimeId, "connect_provider")) return providerKeyStatus(status);
      if (status.kind === "logged_out") return { kind: "logged_out" };
      if (status.kind === "unknown") return { kind: "unknown" };
      const account = webAccount(status.account);
      this.signInKinds.set(runtimeId, signInKinds(status.account));
      return checkedStatus({ kind: "logged_in", ...(account ? { account } : {}) });
    } catch {
      return { kind: "unknown" };
    }
  }

  private async runLogin(loginId: RuntimeAuthLoginId, login: ActiveLogin): Promise<RuntimeAuthLoginResult> {
    if (!this.runsHere(login.runtime)) return { kind: "unsupported", reason: "unsupported_installation" };
    if (login.runtime === "kimi") return this.runKimiLogin(loginId, login);
    if (login.runtime === "pi") return this.runPiLogin(loginId, login);
    if (login.runtime === "opencode") return this.runOpencodeLogin(loginId, login);
    const runtime = await this.deps.loadRuntime(login.runtime);
    if (!runtime.installation || !runtime.login) return { kind: "unsupported", reason: "unsupported_installation" };
    const installation = await runtime.installation();
    if (installation.kind === "not_found") return { kind: "unsupported", reason: "not_installed" };
    if (installation.kind !== "available") return { kind: "unsupported", reason: "unsupported_installation" };
    // The person signs in from the web, on their own device: no browser opens
    // on the Computer itself (OAR 0.69 openBrowser; Grok: a `BROWSER` that does
    // nothing, refused on Windows as browser_suppression_unavailable). Only Kimi's login takes
    // a region, and it does not run here (runKimiLogin).
    const options = { openBrowser: false, ...oarEnvOption(login.runtime) };
    const result = await runtime.login(installation, {
      signal: login.controller.signal,
      onEvent: (event: ProviderLoginEvent) => {
        // A link or code the web cannot show would leave the person waiting
        // for nothing: throwing ends the login as interaction_failed (OAR's contract).
        if (!this.relayEvent(loginId, webEvent(event)) && event.kind !== "info") {
          throw new Error(`login ${event.kind} could not be shown on the web`);
        }
      },
      prompt: (prompt) => {
        if (prompt.kind !== "manual_code") {
          // Only a pasted sign-in code is relayed (Claude's; Antigravity's, or
          // the address its sign-in page landed on); no other prompt reaches the web.
          return Promise.reject(new Error(`unsupported login prompt: ${prompt.kind}`));
        }
        return this.askForCode(loginId, login, prompt.signal);
      },
    }, options);
    switch (result.kind) {
      case "logged_in": {
        const account = webAccount(result.account);
        return { kind: "logged_in", ...(account ? { account } : {}) };
      }
      case "failed":
        return { kind: "failed", reason: result.reason, ...safeDetail(result.detail) };
      case "cancelled":
        return { kind: "cancelled" };
      case "unsupported":
        return { kind: "unsupported", reason: webUnsupportedReason(result.reason), ...safeDetail(result.detail) };
    }
  }

  /**
   * Kimi Code's login on the bundled SDK, in the region the person chose. Its
   * device code reaches the web as OAR's `kimi` relayed it; no browser opens
   * on the Computer (the SDK opens none).
   */
  private async runKimiLogin(loginId: RuntimeAuthLoginId, login: ActiveLogin): Promise<RuntimeAuthLoginResult> {
    const { result, errorKind, sdkSettled } = await kimiSdkAuthLogin(await this.deps.loadKimiAuth(), {
      region: login.region,
      signal: login.controller.signal,
      relay: (event) => this.relayEvent(loginId, event),
    });
    // Set before this login's result is sent and its entry dropped, so no start slips in between.
    if (sdkSettled) {
      const running = sdkSettled.finally(() => {
        if (this.kimiSdkLogin === running) this.kimiSdkLogin = null;
      });
      this.kimiSdkLogin = running;
    }
    // The SDK error's class name only, never its message.
    if (errorKind) this.deps.recordEvent("daemon.runtime_auth.login.sdk_error", { runtime: login.runtime, error_kind: errorKind });
    return result;
  }

  /**
   * Relays a code prompt to the web and waits for the person's paste. The
   * prompt closes when the login is cancelled, or when the runtime itself
   * closes it (`promptSignal`: Pi's localhost callback won the race).
   */
  private askForCode(loginId: RuntimeAuthLoginId, login: ActiveLogin, promptSignal?: AbortSignal): Promise<string> {
    if (login.controller.signal.aborted) return Promise.reject(new Error("login cancelled"));
    if (promptSignal?.aborted) return Promise.reject(new Error("prompt closed"));
    login.codePrompts += 1;
    this.relayEvent(loginId, { kind: "code_prompt", ...(login.codePrompts > 1 ? { retry: true } : {}) });
    return new Promise<string>((resolve, reject) => {
      const pending = { resolve, reject };
      login.pendingCode = pending;
      const close = (reason: string) => () => {
        if (login.pendingCode === pending) login.pendingCode = null;
        reject(new Error(reason));
      };
      login.controller.signal.addEventListener("abort", close("login cancelled"), { once: true });
      promptSignal?.addEventListener("abort", close("prompt closed"), { once: true });
    });
  }

  /** The Pi facade, or the reason there is none on this daemon. */
  private async piAuth(): Promise<ProviderAuthFacade> {
    if (!this.deps.loadPiAuth) throw new Error("Pi sign-in is not wired on this daemon");
    return this.deps.loadPiAuth();
  }

  /**
   * Pi's status: `logged_in` with every provider that has a stored sign-in,
   * `logged_out` with none. Read without resolving anything: no OAuth
   * refresh, no key command run (a stored `!cmd` key is the person's own,
   * and would run on every report otherwise).
   */
  private async piStatus(): Promise<RuntimeAuthStatus> {
    const auth = await this.piAuth();
    const providers = piSignedInProviders(await auth.listProviders({ resolve: false }), auth.loginProviders());
    return providers.length > 0 ? checkedStatus({ kind: "logged_in", providers }) : { kind: "logged_out" };
  }

  /**
   * One Pi provider's OAuth sign-in, the flow pi has for it run headless:
   * pi's mode question answered with the headless option, Copilot's
   * Enterprise question with "github.com", a code or the landing page's
   * address pasted by the person. Any other question ends it as
   * `interaction_failed`; a provider with no flow Raft can run from here is
   * never started.
   */
  private async runPiLogin(loginId: RuntimeAuthLoginId, login: ActiveLogin): Promise<RuntimeAuthLoginResult> {
    const providerId = login.providerId;
    if (!providerId) return { kind: "failed", reason: "interaction_failed" };
    const auth = await this.piAuth();
    const provider = auth.loginProviders().find((candidate) => candidate.providerId === providerId);
    // A provider pi does not list here, or one with no account sign-in: nothing to run, not a refused sign-in.
    if (!provider?.methods.some((method) => method.method === "oauth")) return { kind: "unsupported", reason: "unsupported_installation" };
    if (piOAuthFlow(providerId) === "computer_only") return { kind: "unsupported", reason: "unsupported_installation" };
    const plan = PI_OAUTH_FLOWS[providerId]!;
    let refused = false;
    let blankTextGiven = false;
    const refuse = (what: string): never => {
      refused = true;
      throw new Error(`unsupported Pi login ${what}`);
    };
    const interaction: ProviderLoginInteraction = {
      signal: login.controller.signal,
      onEvent: (event) => {
        // A link or code the web cannot show would leave the person waiting for nothing.
        if (!this.relayEvent(loginId, webEvent(event)) && event.kind !== "info") refuse(`event ${event.kind}`);
      },
      prompt: async (prompt) => {
        switch (prompt.kind) {
          case "select":
            return plan.select && prompt.options.some((option) => option.id === plan.select) ? plan.select : refuse("mode");
          case "text":
            if (plan.blankText && !blankTextGiven) {
              blankTextGiven = true;
              return "";
            }
            return refuse("question");
          case "manual_code":
            return this.askForCode(loginId, login, prompt.signal);
          default:
            return refuse(`prompt ${prompt.kind}`);
        }
      },
    };
    try {
      await auth.login(providerId, "oauth", interaction, this.deps.piDeviceId ? { getDeviceId: this.deps.piDeviceId } : {});
      return { kind: "logged_in" };
    } catch (error) {
      if (login.controller.signal.aborted) return { kind: "cancelled" };
      if (refused) return { kind: "failed", reason: "interaction_failed" };
      return { kind: "failed", reason: piLoginFailureReason(error) };
    }
  }

  /** Clears one Pi provider's stored sign-in (its `auth.json` entry); a key in the environment still counts for Pi after it. */
  private async runPiLogout(providerId: string | undefined): Promise<RuntimeAuthLogoutResult> {
    if (!providerId) return { kind: "failed", reason: "rejected" };
    await (await this.piAuth()).logout(providerId);
    return { kind: "logged_out" };
  }

  /** OpenCode's facade, or the reason there is none on this daemon. */
  private opencodeSignIn(): OpencodeSignIn {
    if (!this.deps.opencode) throw new Error("OpenCode sign-in is not wired on this daemon");
    return this.deps.opencode;
  }

  /**
   * OpenCode's status: `logged_in` with every provider that has a stored
   * credential, `logged_out` with none, `unavailable` without OpenCode 2. The
   * cached read while fresh or while a sign-in runs; `unknown` when there is
   * none yet and another operation holds the facade.
   */
  private async opencodeStatus(): Promise<RuntimeAuthStatus> {
    // Bounded like every other runtime's status query: a cold `opencode serve` never holds up the
    // report. A read that outlasts it runs on and fills the cache for the next report.
    const read = this.opencodeSignIn().snapshot();
    read.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), RUNTIME_AUTH_STATUS_TIMEOUT_MS); });
    try {
      const snapshot = await Promise.race([read, late]);
      return snapshot && snapshot !== "late" ? checkedStatus(opencodeStatusOf(snapshot)) : { kind: "unknown" };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One OpenCode provider's OAuth sign-in, by the method the person chose
   * (its label; absent: the preferred one, device code first); only for a
   * provider on `OPENCODE_OAUTH_PROVIDERS`, else `unsupported` before
   * OpenCode is asked. OAR asks
   * which method only when the provider has several; the daemon answers with
   * the chosen one and nothing else: a question the method's own form asks
   * ends it as `interaction_failed`. A pasted code goes to OpenCode's attempt
   * through the same code prompt as Pi's.
   */
  private async runOpencodeLogin(loginId: RuntimeAuthLoginId, login: ActiveLogin): Promise<RuntimeAuthLoginResult> {
    const providerId = login.providerId;
    if (!providerId) return { kind: "failed", reason: "interaction_failed" };
    // Never trust that the web hid it: a provider off the allowlist is refused before OpenCode is asked.
    if (!opencodeOAuthAllowed(providerId)) return { kind: "unsupported", reason: "unsupported_installation" };
    const signIn = this.opencodeSignIn();
    let refused = false;
    let methodChosen = false;
    let formAnswered = false;
    const refuse = (what: string): never => {
      refused = true;
      throw new Error(`unsupported OpenCode login ${what}`);
    };
    try {
      return await signIn.withFacade("login", async (auth): Promise<RuntimeAuthLoginResult> => {
        const provider = auth.loginProviders().find((candidate) => candidate.providerId === providerId);
        const methods = provider ? opencodeOAuthMethods(provider) : [];
        // A provider OpenCode does not list here, or with no account sign-in: nothing to run.
        if (methods.length === 0) return { kind: "unsupported", reason: "unsupported_installation" };
        const chosen = login.oauthMethod ?? methods[0]!.label;
        if (!methods.some((method) => method.label === chosen)) return { kind: "unsupported", reason: "unsupported_installation" };
        // OAR asks which method only when the provider has more than one (in OpenCode's own list, before
        // Raft drops any label): with one, every select is a question of that method's form, and refused.
        if (provider!.methods.filter((method) => method.method === "oauth").length === 1) methodChosen = true;
        const interaction: ProviderLoginInteraction = {
          signal: login.controller.signal,
          onEvent: (event) => {
            if (!this.relayEvent(loginId, webEvent(event)) && event.kind !== "info") refuse(`event ${event.kind}`);
          },
          prompt: async (prompt) => {
            switch (prompt.kind) {
              case "select": {
                // OAR's own question, which method: answered once, with the one chosen.
                const option = methodChosen ? undefined : prompt.options.find((candidate) => candidate.label === chosen);
                if (option) {
                  methodChosen = true;
                  return option.id;
                }
                // The one form question answered (`formSelect`: Copilot's deployment type, GitHub.com), once; any other refused.
                const answer = formAnswered ? null : opencodeFormAnswer(providerId, prompt);
                if (answer === null) return refuse("question");
                formAnswered = true;
                return answer;
              }
              case "manual_code":
                return this.askForCode(loginId, login, prompt.signal);
              default:
                return refuse(`prompt ${prompt.kind}`);
            }
          },
        };
        await auth.login(providerId, "oauth", interaction);
        return { kind: "logged_in" };
      });
    } catch (error) {
      if (login.controller.signal.aborted) return { kind: "cancelled" };
      if (refused) return { kind: "failed", reason: "interaction_failed" };
      login.errorKind = opencodeTraceErrorKind(error);
      return opencodeLoginFailure(error);
    }
  }

  /** Removes every stored credential of one OpenCode provider; a key in the environment still counts for OpenCode after it. */
  private async runOpencodeLogout(providerId: string | undefined, trace: ErrorKindTrace): Promise<RuntimeAuthLogoutResult> {
    if (!providerId) return { kind: "failed", reason: "rejected" };
    const signIn = this.opencodeSignIn();
    // A sign-in running or waiting holds the facade for up to OPENCODE_LOGIN_TIMEOUT_MS: say so at once.
    if (signIn.loginPending()) return { kind: "failed", reason: "busy" };
    try {
      await signIn.withFacade("change", (auth) => auth.logout(providerId), { waitMs: OPENCODE_QUEUE_WAIT_MS, deadlineMs: OPENCODE_LOGOUT_DEADLINE_MS });
      return { kind: "logged_out" };
    } catch (error) {
      const failure = opencodeProviderFailure(error);
      trace.errorKind = failure.errorKind;
      if (failure.kind === "unsupported") return { kind: "unsupported", reason: failure.reason };
      return { kind: "failed", reason: failure.reason === "timed_out" ? "timed_out" : failure.reason === "rejected" ? "rejected" : "process_failed" };
    }
  }

  private async runLogout(runtimeId: RuntimeAuthRuntime): Promise<RuntimeAuthLogoutResult> {
    if (!this.runsHere(runtimeId)) return { kind: "unsupported", reason: "unsupported_installation" };
    if (runtimeId === "kimi") return kimiSdkAuthLogout(await this.deps.loadKimiAuth());
    const runtime = await this.deps.loadRuntime(runtimeId);
    if (!runtime.installation || !runtime.logout) return { kind: "unsupported", reason: "unsupported_installation" };
    const installation = await runtime.installation();
    if (installation.kind === "not_found") return { kind: "unsupported", reason: "not_installed" };
    if (installation.kind !== "available") return { kind: "unsupported", reason: "unsupported_installation" };
    const result = await runtime.logout(installation, { timeoutMs: RUNTIME_AUTH_LOGOUT_TIMEOUT_MS, ...oarEnvOption(runtimeId) });
    const mapped: RuntimeAuthLogoutResult = result.kind === "logged_out"
      ? { kind: "logged_out" }
      : result.kind === "failed"
        ? { kind: "failed", reason: result.reason, ...safeDetail(result.detail) }
        : { kind: "unsupported", reason: webUnsupportedReason(result.reason), ...safeDetail(result.detail) };
    // Reasons are pinned by the types and safeDetail keeps the detail valid; parse only to apply the schema's trimming.
    return runtimeAuthLogoutResultSchema.parse(mapped);
  }

  /** The runtime's provider facade on this Computer (creating it starts nothing), or the reason there is none. */
  private async providerAuthHere(runtimeId: RuntimeAuthRuntime): Promise<
    | { kind: "ready"; auth: QwenProviderAuth }
    | { kind: "unsupported"; reason: (typeof RUNTIME_AUTH_UNSUPPORTED_REASONS)[number] }
  > {
    if (!this.runsHere(runtimeId)) return { kind: "unsupported", reason: "unsupported_installation" };
    const providerAuth = await this.deps.loadProviderAuth(runtimeId);
    if (!providerAuth) return { kind: "unsupported", reason: "unsupported_installation" };
    const runtime = await this.deps.loadRuntime(runtimeId);
    if (!runtime.installation) return { kind: "unsupported", reason: "unsupported_installation" };
    const installation = await runtime.installation();
    if (installation.kind === "not_found") return { kind: "unsupported", reason: "not_installed" };
    // OAR's facade drives an installed executable; a bundled runtime has none to start.
    if (installation.kind !== "available" || installation.via !== "executable") return { kind: "unsupported", reason: "unsupported_installation" };
    const options = { cwd: this.deps.providerSettingsCwd ?? homedir(), timeoutMs: RUNTIME_AUTH_PROVIDER_TIMEOUT_MS };
    return { kind: "ready", auth: await providerAuth.create(installation, options) };
  }

  private async runListProviders(runtimeId: RuntimeAuthRuntime, trace: ErrorKindTrace): Promise<RuntimeAuthProvidersResult> {
    if (runtimeId === "pi") {
      // pi's own `/login` list, every provider in it: Raft keeps no list.
      const auth = await this.piAuth();
      const stored = new Map((await auth.listProviders({ resolve: false })).map((entry) => [entry.providerId, entry]));
      const shown = auth.loginProviders()
        .map((provider) => piWebProvider(provider, stored.get(provider.providerId)))
        .filter((provider): provider is RuntimeAuthProvider => provider !== null);
      return { kind: "listed", providers: shown.slice(0, RUNTIME_AUTH_PROVIDER_LIST_LIMIT) };
    }
    if (runtimeId === "opencode") return this.runOpencodeListProviders(trace);
    const here = await this.providerAuthHere(runtimeId);
    if (here.kind === "unsupported") return here;
    const providers = await here.auth.listProviders();
    const shown = providers.map(webProvider).filter((provider): provider is RuntimeAuthProvider => provider !== null);
    return { kind: "listed", providers: shown.slice(0, RUNTIME_AUTH_PROVIDER_LIST_LIMIT) };
  }

  private async runConnectProvider(runtimeId: RuntimeAuthRuntime, input: RuntimeAuthProviderConnectInput, trace: ErrorKindTrace): Promise<RuntimeAuthProviderConnectResult> {
    if (runtimeId === "pi") return this.runPiConnect(input);
    if (runtimeId === "opencode") return this.runOpencodeConnect(input, trace);
    const here = await this.providerAuthHere(runtimeId);
    if (here.kind === "unsupported") return here;
    // User scope: the key serves every agent of the account running this
    // Computer, whatever its workspace. OAR sends the key on the runtime's
    // stdin only and redacts it from anything it reads back.
    await here.auth.connect({
      providerId: input.providerId,
      apiKey: input.apiKey,
      scope: "user",
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(input.modelIds ? { modelIds: input.modelIds } : {}),
    });
    return { kind: "connected" };
  }

  /**
   * Saves one Pi provider's API key in Pi's `auth.json` (OAR's `setApiKey`:
   * pi's key prompt answered with it, nothing else). Refused unless pi would
   * keep the key literal (a leading `!` is run as a command, a `$` filled in
   * from the environment, on every read by every Pi process of this account)
   * and the provider takes one key and nothing more. The key goes to
   * `setApiKey` only.
   */
  private async runPiConnect(input: RuntimeAuthProviderConnectInput): Promise<RuntimeAuthProviderConnectResult> {
    if (!isPiLiteralApiKey(input.apiKey) || input.baseUrl !== undefined || input.modelIds !== undefined) return { kind: "failed", reason: "rejected" };
    const auth = await this.piAuth();
    const provider = auth.loginProviders().find((candidate) => candidate.providerId === input.providerId);
    if (!provider || piKeyEntry(provider) !== "key") return { kind: "failed", reason: "rejected" };
    await auth.setApiKey(input.providerId, input.apiKey);
    return { kind: "connected" };
  }

  /**
   * OpenCode's integration registry, every provider in it: Raft keeps no
   * list. A fresh read when the facade is free (the dialog just opened);
   * while a sign-in holds it, the cached one.
   */
  private async runOpencodeListProviders(trace: ErrorKindTrace): Promise<RuntimeAuthProvidersResult> {
    const signIn = this.opencodeSignIn();
    const bounds = { waitMs: OPENCODE_QUEUE_WAIT_MS, deadlineMs: OPENCODE_PROVIDER_DEADLINE_MS };
    try {
      const snapshot = signIn.loginPending() ? await signIn.snapshot() ?? await signIn.read(bounds) : await signIn.read(bounds);
      if (snapshot.kind === "unavailable") return { kind: "unsupported", reason: snapshot.reason };
      const stored = new Map(snapshot.stored.map((entry) => [entry.providerId, entry]));
      const shown = snapshot.providers
        .map((provider) => opencodeWebProvider(provider, stored.get(provider.providerId)))
        .filter((provider): provider is RuntimeAuthProvider => provider !== null);
      return { kind: "listed", providers: shown.slice(0, RUNTIME_AUTH_PROVIDER_LIST_LIMIT) };
    } catch (error) {
      const failure = opencodeProviderFailure(error);
      trace.errorKind = failure.errorKind;
      return failure.kind === "unsupported" ? { kind: "unsupported", reason: failure.reason } : { kind: "failed", reason: failure.reason };
    }
  }

  /**
   * Saves one OpenCode provider's API key through OpenCode's own server
   * (OAR's `setApiKey`: the key prompt answered with it, nothing else; an
   * earlier credential replaced, best effort). Refused unless OpenCode keeps
   * it literal (`isOpencodeLiteralApiKey`) and the provider takes one key and
   * nothing more. Busy while a sign-in holds the facade. The key goes to
   * `setApiKey` only.
   */
  private async runOpencodeConnect(input: RuntimeAuthProviderConnectInput, trace: ErrorKindTrace): Promise<RuntimeAuthProviderConnectResult> {
    if (!isOpencodeLiteralApiKey(input.apiKey) || input.baseUrl !== undefined || input.modelIds !== undefined) return { kind: "failed", reason: "rejected" };
    const signIn = this.opencodeSignIn();
    // A sign-in running or waiting holds the facade: busy at once, not after a queue wait.
    if (signIn.loginPending()) return { kind: "busy" };
    try {
      return await signIn.withFacade("change", async (auth): Promise<RuntimeAuthProviderConnectResult> => {
        const provider = auth.loginProviders().find((candidate) => candidate.providerId === input.providerId);
        if (!provider || opencodeKeyEntry(provider) !== "key") return { kind: "failed", reason: "rejected" };
        await auth.setApiKey(input.providerId, input.apiKey);
        return { kind: "connected" };
      }, { waitMs: OPENCODE_QUEUE_WAIT_MS, deadlineMs: OPENCODE_PROVIDER_DEADLINE_MS });
    } catch (error) {
      const failure = opencodeProviderFailure(error);
      trace.errorKind = failure.errorKind;
      return failure.kind === "unsupported" ? { kind: "unsupported", reason: failure.reason } : { kind: "failed", reason: failure.reason };
    }
  }

  /** Sends the event if the web may show it; false when it was dropped. */
  private relayEvent(loginId: RuntimeAuthLoginId, event: RuntimeAuthLoginEvent | null): boolean {
    const parsed = event ? runtimeAuthLoginEventSchema.safeParse(event) : null;
    if (!parsed?.success) {
      this.deps.recordEvent("daemon.runtime_auth.login.event_dropped", { kind: event?.kind ?? "unmapped" });
      return false;
    }
    this.deps.send({ type: "machine:runtime_auth:login:event", loginId, event: parsed.data });
    this.deps.recordEvent("daemon.runtime_auth.login.event", { kind: parsed.data.kind });
    return true;
  }

  private finishLogin(loginId: RuntimeAuthLoginId, runtimeId: RuntimeAuthRuntime, result: RuntimeAuthLoginResult, startedAtMs: number, providerId?: string): void {
    const login = this.logins.get(loginId);
    if (login) {
      // A prompt still open when the login settles is moot: close it (OAR leaves that to the caller).
      login.pendingCode?.reject(new Error("login ended"));
      login.pendingCode = null;
      this.logins.delete(loginId);
    }
    // Reasons are pinned by the types; safeDetail and webAccount keep the rest valid. A
    // result that still fails is a bug here, reported as a failed login rather than sent.
    const parsed = runtimeAuthLoginResultSchema.safeParse(result);
    const checked: RuntimeAuthLoginResult = parsed.success ? parsed.data : { kind: "failed", reason: "process_failed" };
    this.deps.send({ type: "machine:runtime_auth:login:result", loginId, result: checked });
    this.deps.recordEvent("daemon.runtime_auth.login.result", {
      runtime: runtimeId,
      ...providerIdAttr(providerId),
      outcome: checked.kind,
      reason: "reason" in checked ? checked.reason : undefined,
      ...errorKindAttr(checked.kind === "logged_in" ? undefined : login?.errorKind),
      code_prompts: login?.codePrompts,
      duration_ms: this.deps.now() - startedAtMs,
    });
    if (checked.kind === "logged_in") {
      this.credentialsChanged(runtimeId, "login");
      this.modelsMayHaveChanged(runtimeId);
    }
    if (this.deps.serverReads()) void this.reportStatus("login").catch(() => undefined);
  }

  /** Pi's model list follows its sign-ins: re-detect it after one changed. Other runtimes' do not. */
  private modelsMayHaveChanged(runtimeId: RuntimeAuthRuntime): void {
    if (!runtimeAuthSignsInPerProvider(runtimeId)) return;
    try {
      this.deps.rescanModels?.(runtimeId);
    } catch {
      this.deps.recordEvent("daemon.runtime_auth.rescan_models.failed", { runtime: runtimeId });
    }
  }

  /** Tells the agent hosts; a listener that throws never changes the result already sent. */
  private credentialsChanged(runtimeId: RuntimeAuthRuntime, reason: RuntimeAuthCredentialsChange): void {
    try {
      this.deps.onCredentialsChanged?.(runtimeId, reason);
    } catch {
      this.deps.recordEvent("daemon.runtime_auth.credentials_changed.listener_failed", { runtime: runtimeId, reason });
    }
  }
}

/** Where an operation that maps its own errors (OpenCode's) leaves OAR's error kind for its trace. */
interface ErrorKindTrace {
  errorKind?: OpencodeTraceErrorKind;
}

/** An error kind as a trace attribute, only when there is one: other runtimes' traces stay as they were. */
function errorKindAttr(errorKind: OpencodeTraceErrorKind | undefined): { error_kind?: string } {
  return errorKind === undefined ? {} : { error_kind: errorKind };
}

/** A per-provider runtime's provider id as a trace attribute; no key at all for the other runtimes, whose traces stay as they were. */
function providerIdAttr(providerId: string | undefined): { provider_id?: string } {
  return providerId === undefined ? {} : { provider_id: providerId };
}

/** The account as the web may show it: email masked here, plan and method as short labels. */
/** A method or plan label as a short lowercase token; anything else is "other". */
export function authLabelTraceValue(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  const token = label.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9 ._-]{0,39}$/.test(token) ? token : "other";
}

/** OAR's `credential` / `metering` for a signed-in account, only when they are one of OAR's known values. */
function signInKinds(account: LoginAccount | undefined): { signIn?: "account" | "api_key"; billing?: "plan" | "usage" } {
  const signIn = account?.credential === "account" || account?.credential === "api_key" ? account.credential : undefined;
  const billing = account?.metering === "plan" || account?.metering === "usage" ? account.metering : undefined;
  return { ...(signIn ? { signIn } : {}), ...(billing ? { billing } : {}) };
}

function authAccountTraceAttrs(
  runtime: RuntimeAuthRuntime,
  status: RuntimeAuthStatus | undefined,
): Record<string, string | undefined> {
  const account = status?.kind === "logged_in" ? status.account : undefined;
  return {
    [`${runtime}_method`]: authLabelTraceValue(account?.methodLabel),
    [`${runtime}_plan`]: authLabelTraceValue(account?.planLabel),
  };
}

function webAccount(account: LoginAccount | undefined): RuntimeAuthAccount | undefined {
  if (!account) return undefined;
  const candidate: RuntimeAuthAccount = {
    ...(maskRuntimeAccountEmail(account.email) ? { maskedLabel: maskRuntimeAccountEmail(account.email) } : {}),
    ...(account.plan ? { planLabel: account.plan.slice(0, 80) } : {}),
    ...(account.method ? { methodLabel: account.method.slice(0, 40) } : {}),
  };
  const parsed = runtimeAuthAccountSchema.safeParse(candidate);
  if (parsed.success) return Object.keys(parsed.data).length > 0 ? parsed.data : undefined;
  // Drop only the fields that fail, never the whole account.
  const kept: RuntimeAuthAccount = {};
  for (const key of Object.keys(candidate) as (keyof RuntimeAuthAccount)[]) {
    const single = { [key]: candidate[key] };
    if (runtimeAuthAccountSchema.safeParse(single).success) Object.assign(kept, single);
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * A provider-key runtime's status (Qwen Code). OAR's check is presence only
 * and never answers `logged_in`: `unknown` both when it finds configured
 * credential sources (labelled in `configured`, never with values) and when
 * it could not look (no `configured`). Only a label that means a provider
 * API key was configured in Qwen's own settings reads as configured
 * (`logged_in` on the wire, "Provider configured" on the web):
 * - `<settings file>: security.auth.apiKey`, bare or with an API-key
 *   protocol as its selected type; not with Qwen OAuth or Vertex selected
 *   (then the key is not what Qwen uses);
 * - `user .env or settings.env: <key>`: a key in a `.env` file Qwen reads or
 *   a settings file's `env` (where Qwen's own provider connect writes one).
 * Never: `environment: <key>`, a key in the daemon's own environment (it may
 * be there for another runtime, and agents get their own), the legacy Qwen
 * OAuth file or its selected type (free tier discontinued), Vertex ADC,
 * external auth, or a credentials file that is missing. With none of the
 * counted ones it is `unknown`: no claim either way. The OAR upgrade tests in
 * runtimeAuthHost.test.ts run OAR's real check for the main case of each
 * rule; the other labels are tested as copied from OAR.
 */
const SETTINGS_API_KEY_SOURCE = /^(user settings|system settings|system defaults): security\.auth\.apiKey(?: \((openai|openai-responses|anthropic|gemini)\))?$/u;
const SETTINGS_ENV_KEY_SOURCE = /^user \.env or settings\.env: .+$/u;

function providerKeyStatus(status: AuthStatus): RuntimeAuthStatus {
  if (status.kind === "logged_out") return { kind: "logged_out" };
  const configured = status.kind === "unknown" ? status.configured ?? [] : [];
  return configured.some((source) => SETTINGS_API_KEY_SOURCE.test(source) || SETTINGS_ENV_KEY_SOURCE.test(source))
    ? { kind: "logged_in" }
    : { kind: "unknown" };
}

/**
 * A provider as the web shows it, from the runtime's menu entry: its name,
 * group and description, whether its settings hold anything (never what),
 * and what the person must add (an endpoint, a model). Null for an entry the
 * web could not show; a field that cannot be shown is dropped first.
 */
function webProvider(provider: QwenProvider): RuntimeAuthProvider | null {
  const baseUrl = provider.baseUrl;
  const choices = Array.isArray(baseUrl) ? baseUrl.flatMap((option: unknown) => {
    const row = option && typeof option === "object" ? option as Record<string, unknown> : null;
    return row && typeof row.id === "string" && typeof row.label === "string" && typeof row.url === "string"
      ? [{ id: row.id, label: row.label.slice(0, 80), url: row.url }]
      : [];
  }) : [];
  const endpoint: RuntimeAuthProvider["endpoint"] = typeof baseUrl === "string"
    ? { kind: "fixed" }
    : baseUrl === undefined
      ? { kind: "custom", ...(typeof provider.baseUrlPlaceholder === "string" ? { placeholder: provider.baseUrlPlaceholder.slice(0, 200) } : {}) }
      : { kind: "choice", options: choices };
  const defaultModels = provider.defaultModelIds;
  const essentials: RuntimeAuthProvider = {
    id: provider.id,
    label: provider.label.slice(0, 80),
    configured: provider.existingConfig !== undefined,
    endpoint,
    needsModelIds: !(Array.isArray(defaultModels) && defaultModels.length > 0),
  };
  const groupLabel = provider.uiLabels && typeof provider.uiLabels === "object"
    ? (provider.uiLabels as Record<string, unknown>).flowTitle
    : undefined;
  const full: RuntimeAuthProvider = {
    ...essentials,
    ...(typeof provider.description === "string" ? { description: provider.description.slice(0, 200) } : {}),
    ...(typeof provider.uiGroup === "string"
      ? { group: { id: provider.uiGroup, ...(typeof groupLabel === "string" ? { label: groupLabel.slice(0, 80) } : {}) } }
      : {}),
  };
  for (const candidate of [full, essentials]) {
    const parsed = runtimeAuthProviderSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * Why a provider operation failed, from OAR's error kind (its message is
 * never read: the runtime's own text may quote a stored key). `errorKind`
 * is for the trace only.
 */
function providerFailure(error: unknown): { reason: RuntimeAuthProviderFailureReason; errorKind: string } {
  const kind = error && typeof error === "object" && (error as { name?: unknown }).name === "QwenProviderAuthError"
    ? (error as { kind?: unknown }).kind
    : undefined;
  switch (kind) {
    case "native": return { reason: "rejected", errorKind: kind };
    case "timeout": return { reason: "timed_out", errorKind: kind };
    case "process_exited":
    case "launch_failed": return { reason: "process_failed", errorKind: kind };
    case "invalid_response": return { reason: "invalid_response", errorKind: kind };
    default: return { reason: "process_failed", errorKind: "other" };
  }
}

function checkedStatus(status: RuntimeAuthStatus): RuntimeAuthStatus {
  return runtimeAuthStatusSchema.safeParse(status).success ? status : { kind: "unknown" };
}

function webEvent(event: ProviderLoginEvent): RuntimeAuthLoginEvent | null {
  switch (event.kind) {
    case "auth_url":
      return { kind: "auth_url", url: event.url, ...(event.instructions ? { instructions: event.instructions.slice(0, 500) } : {}) };
    case "device_code":
      return {
        kind: "device_code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...(event.expiresInSeconds ? { expiresInSeconds: Math.min(3600, Math.round(event.expiresInSeconds)) } : {}),
      };
    case "info":
      return { kind: "info", message: event.message.slice(0, 500) };
    default:
      return null;
  }
}

/**
 * The reasons the web knows. OAR 0.76 added `browser_suppression_unavailable`
 * (Kimi: no browser can be kept from opening on this machine); for the person
 * signing in from the web that is "this Computer cannot run this login".
 * Mapped here rather than added to the shared protocol: servers already
 * deployed validate the reason against the fixed list and would drop a new one.
 */
function webUnsupportedReason(reason: LoginUnsupportedReason): (typeof RUNTIME_AUTH_UNSUPPORTED_REASONS)[number] {
  switch (reason) {
    case "version_unsupported":
    case "unsupported_installation":
      return reason;
    case "browser_suppression_unavailable":
      return "unsupported_installation";
  }
}

/** OAR's detail is already redacted; keep it only when it is one short safe line. */
function safeDetail(detail: string | undefined): { detail?: string } {
  if (!detail) return {};
  const line = detail.split("\n")[0]!.trim().slice(0, 300);
  return line && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(line) ? { detail: line } : {};
}
