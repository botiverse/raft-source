import { createHash } from "node:crypto";
import { hydrateRuntimeConfig, parseRuntimeConfig, runtimeConfigToLaunchFields, type AgentConfig } from "@botiverse/raft-shared";

/**
 * Reconciler step 7: an agent's runtime spec, the part of its config a
 * running session cannot take without a restart, compared between what a
 * process's session started with and what its config says now (a rebind, a
 * server features answer). Both hosts decide with it, from one entry each
 * (`reconcileSpec`): drift and idle stop the process the way the cold-idle
 * sweep does, and the next start runs on the new config.
 *
 * A whitelist: only the components below are compared, so a config field
 * added later never restarts a session unless it is added here. Compared
 * (after `hydrateRuntimeConfig`, the form every launch reads, so a server
 * default or a legacy flat field and its structured twin are the same):
 *
 * - `runtime`: the launch runtime.
 * - `model`: the launch model.
 * - `runtime_config`: the launch mode and reasoning effort.
 * - `env`: the agent's own env vars (the provider's generated ones are `provider`).
 * - `provider`: the provider (its kind, connection id or preset, URL and key)
 *   and the Claude command. Of a server-managed connection only its id: the
 *   projection a spawn resolves (`providerConnection`) is not compared.
 * - `execution_mode`: absent is `byoc`, as the runtime profile reads it.
 * - `managed_mcp` (reconciler step 11): `managedMcpFingerprint`, the server's
 *   fingerprint of the agent's managed MCP servers.
 * - `provider_connection`: `providerConnectionRevision`, the revision of the
 *   server-managed provider connection the launch resolves.
 *
 * The last two are optional (`OPTIONAL_RUNTIME_SPEC_COMPONENTS`): an older
 * server sends neither, so one absent on either side is no drift; they are
 * compared only when both sides carry them.
 *
 * Server features are the sixth kind (`features`), decided as before by
 * `serverFeaturesDrift` (serverFeaturesRefresh.ts).
 *
 * Never compared: the session, URLs and every credential (auth token, agent
 * and runner credentials, proxy tokens), runtimeProfileControl,
 * constructedWakeContext, runtimeContext, name, displayName, description and
 * installed apps (the standing prompt's inputs, which the standing-prompt
 * ledger re-delivers), and the wake and launch fields.
 *
 * Normalized: absent, undefined, null, an empty object and an empty array
 * are the same; object keys are sorted; each component is compared by the
 * sha256 of its canonical JSON. The snapshot holds those hashes and the few
 * non-secret facts a host reports; it lives in memory only (on the process),
 * and only the drift kinds ever leave it (traces), never a key or a value.
 */
export const RUNTIME_SPEC_COMPONENTS = ["runtime", "model", "runtime_config", "env", "provider", "execution_mode", "managed_mcp", "provider_connection"] as const;
export type RuntimeSpecComponent = typeof RUNTIME_SPEC_COMPONENTS[number];
/** Compared only when both sides carry one: absent (an older server) is no drift. */
const OPTIONAL_RUNTIME_SPEC_COMPONENTS: ReadonlySet<RuntimeSpecComponent> = new Set(["managed_mcp", "provider_connection"]);
/**
 * A drift kind (`daemon.agent.spec_restart_stop` `drift`, comma-joined): a
 * spec component, the server features, or (reconciler step 15) the provider
 * account its released credential now signs in as (`credential_account`).
 */
export type RuntimeSpecDriftKind = RuntimeSpecComponent | "features" | "credential_account";

export interface RuntimeSpecSnapshot {
  /** sha256 of each component's canonical JSON; null for an optional component the config does not carry. */
  readonly hashes: Readonly<Record<RuntimeSpecComponent, string | null>>;
  /**
   * The host the config asks for (`runtimeHost`): not a drift kind (a flag
   * change never moves a running session), but a spec stop whose config asks
   * for another host is not started again by the daemon itself
   * (`specChangeNeedsServerStart`).
   */
  readonly host: "oar" | "default";
  /** The launch runtime and model (the session rule; never traced). */
  readonly runtime: string;
  readonly model: string;
  /** What the runtime profile reports of a running process: the config's own values at its start. */
  readonly reported: Pick<AgentConfig, "runtime" | "model" | "reasoningEffort" | "executionMode">;
  /**
   * Whether this Computer can read the config: it hydrates and passes the
   * strict parse. One that does not (a provider kind from a newer Server)
   * fails at its own spawn; it is never drift, so a running process is not
   * stopped for a config that cannot start.
   */
  readonly readable: boolean;
}

type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical };

/** Absent, null, an empty object or array: no value (undefined). Keys sorted. */
function canonicalize(value: unknown): Canonical | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item) ?? null);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === "object") {
    const out: Record<string, Canonical> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = canonicalize((value as Record<string, unknown>)[key]);
      if (item !== undefined) out[key] = item;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  return undefined;
}

function componentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value) ?? null)).digest("hex");
}

/** The compared components of `config`, before hashing. */
function runtimeSpecComponents(config: AgentConfig): Record<RuntimeSpecComponent, unknown> & { runtime: string; model: string; readable: boolean } {
  const executionMode = config.executionMode || "byoc";
  try {
    const hydrated = hydrateRuntimeConfig(config);
    const launch = runtimeConfigToLaunchFields(hydrated);
    const provider = "provider" in hydrated ? hydrated.provider : undefined;
    return {
      runtime: launch.runtime,
      model: launch.model,
      // A custom model's declared limits (#proj-runtime:#50) are launch inputs
      // too; absent ones canonicalize away, so existing agents keep their hash.
      runtime_config: {
        mode: launch.mode,
        reasoningEffort: launch.reasoningEffort,
        modelLimits: hydrated.model.kind === "custom"
          ? { contextWindow: hydrated.model.contextWindow, maxOutputTokens: hydrated.model.maxOutputTokens }
          : undefined,
      },
      env: hydrated.envVars,
      provider: {
        // The default provider is no provider.
        provider: provider && provider.kind !== "default" ? provider : undefined,
        command: launch.command,
      },
      execution_mode: executionMode,
      managed_mcp: config.managedMcpFingerprint,
      provider_connection: config.providerConnectionRevision,
      // Hydration is lenient (it keeps what it does not know); the strict
      // parse is what says this Computer knows every part of it.
      readable: parseRuntimeConfig(config).ok,
    };
  } catch {
    // A config hydration refuses fails at spawn; compare its own fields meanwhile.
    return {
      runtime: config.runtime || "claude",
      model: config.model ?? "",
      runtime_config: { reasoningEffort: config.reasoningEffort },
      env: config.envVars,
      provider: config.runtimeConfig ?? undefined,
      execution_mode: executionMode,
      managed_mcp: config.managedMcpFingerprint,
      provider_connection: config.providerConnectionRevision,
      readable: false,
    };
  }
}

export function runtimeSpecOf(config: AgentConfig): RuntimeSpecSnapshot {
  const components = runtimeSpecComponents(config);
  const hashes = {} as Record<RuntimeSpecComponent, string | null>;
  for (const component of RUNTIME_SPEC_COMPONENTS) {
    const value = components[component];
    hashes[component] = OPTIONAL_RUNTIME_SPEC_COMPONENTS.has(component) && canonicalize(value) === undefined ? null : componentHash(value);
  }
  return {
    hashes,
    host: config.runtimeHost === "oar" ? "oar" : "default",
    runtime: components.runtime,
    model: components.model,
    readable: components.readable,
    reported: {
      runtime: config.runtime,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      executionMode: config.executionMode,
    },
  };
}

/** The components a session started with `startedWith` has drifted on, in RUNTIME_SPEC_COMPONENTS order. */
export function runtimeSpecDrift(startedWith: RuntimeSpecSnapshot, desired: RuntimeSpecSnapshot): RuntimeSpecComponent[] {
  // An unreadable side compares nothing: its own spawn reports the failure.
  if (!startedWith.readable || !desired.readable) return [];
  return RUNTIME_SPEC_COMPONENTS.filter((component) => {
    const started = startedWith.hashes[component];
    const wanted = desired.hashes[component];
    // An optional component absent on either side (an older server) compares nothing.
    if (started === null || wanted === null) return false;
    return started !== wanted;
  });
}

/**
 * Reconciler step 11 (Tenny's decision 1): a session stopped for its spec
 * whose config now names another runtime, or asks for another host (legacy
 * vs OAR), is not started again by the daemon from its own restart state:
 * the server's next start does, and the host router places it. Any other
 * spec stop is started again as before.
 */
export function specChangeNeedsServerStart(
  startedWith: Pick<RuntimeSpecSnapshot, "runtime" | "host" | "readable">,
  desired: Pick<RuntimeSpecSnapshot, "runtime" | "host" | "readable">,
): boolean {
  if (!startedWith.readable || !desired.readable) return false;
  return startedWith.runtime !== desired.runtime || startedWith.host !== desired.host;
}

/**
 * Why the next start must open a new session rather than resume the one a
 * process with `startedWith` ran, or null: another runtime cannot read its
 * session, and Codex binds a thread to its model. `runtime_host_changed`
 * (#oar-raft:#10, `runtimeHostSessionDrop`): the agent's runtime now runs on
 * another host whose store cannot read the session.
 */
export type SessionDropReason = "runtime_changed" | "codex_model_changed" | "runtime_host_changed";

/** Words for a log line: what the dropped session started on. */
export function sessionDropReasonText(reason: SessionDropReason): string {
  if (reason === "runtime_changed") return "another runtime";
  if (reason === "codex_model_changed") return "another Codex model";
  return "another runtime host";
}

/**
 * A Cursor SDK agent id (`agent-<uuid>`), the only session the OAR host's
 * Cursor (the SDK) can resume. Cursor CLI (`cursor-agent`) sessions are bare
 * uuids, which the SDK does not know, and the CLI cannot resume an SDK agent.
 * Where the shapes come from: the legacy driver records the CLI's
 * `system`/`init` `session_id` (drivers/cursor.ts `parseLine`), a bare uuid;
 * OAR reports the SDK's `agent.agentId` as the session id, `agent-<uuid>`
 * (OAR's Cursor docs, "Session creation and resume"). The whole id must
 * match, so a CLI id never passes for an SDK one.
 */
export function isCursorSdkSessionId(sessionId: string | null | undefined): boolean {
  return typeof sessionId === "string" && /^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId);
}

/**
 * #oar-raft:#10: `runtime_host_changed` when the host about to run `runtime`
 * cannot read `sessionId` because the other host started it, else null.
 * Only Cursor today: the OAR host runs it through the Cursor SDK, the legacy
 * host through the Cursor CLI, and their session stores are separate. Read
 * from the session id itself, so it holds across daemon restarts (unlike
 * `SessionSpecMemory`).
 */
export function runtimeHostSessionDrop(
  runtime: string | null | undefined,
  sessionId: string | null | undefined,
  host: "oar" | "legacy",
): "runtime_host_changed" | null {
  if (runtime !== "cursor" || !sessionId) return null;
  const sdkSession = isCursorSdkSessionId(sessionId);
  return (host === "oar") !== sdkSession ? "runtime_host_changed" : null;
}

export function sessionDropReason(
  startedWith: Pick<RuntimeSpecSnapshot, "runtime" | "model"> & { readable?: boolean },
  desired: Pick<RuntimeSpecSnapshot, "runtime" | "model"> & { readable?: boolean },
): SessionDropReason | null {
  if (startedWith.readable === false || desired.readable === false) return null;
  if (startedWith.runtime !== desired.runtime) return "runtime_changed";
  if (startedWith.runtime === "codex" && startedWith.model !== desired.model) return "codex_model_changed";
  return null;
}

/**
 * What re-ran the reconcile decision: traced on the stop it caused
 * (`daemon.agent.spec_restart_stop` / `daemon.agent.cold_idle_stop`
 * `trigger`). The decision never reads it. A spec stop that only the sweep
 * makes means an entry point is missing; a cold-idle stop usually comes from
 * the sweep (a process turns cold with no event).
 */
export type RuntimeSpecReconcileTrigger =
  /** The desired spec changed: a rebind, a server features answer, a spawn that registered on older features. */
  | "signal"
  /**
   * A turn ended (also an idle compaction's end). Input written to the
   * runtime, a tracked mention and a message the agent reads are all
   * consumed or settled by a turn, so this is where they stop holding it.
   */
  | "turn_end"
  /** The last background task ended, or was presumed ended. */
  | "background_tasks_done"
  /** Input written into the turn that ended started no turn within QUEUED_INPUT_SETTLE_MS. */
  | "queued_input_settled"
  /** Held work went away without a turn: a server purge, or (OAR) held deliveries taken or refused. */
  | "delivery_consumed"
  /** The 10-minute sweep. */
  | "sweep"
  /** Reconciler step 15: an invalid credential was released for a credentials change and now signs in as another account. */
  | "credentials_changed"
  /** A delivery was queued for a process in a turn (reconciler step 9: its health). */
  | "delivery_arrived"
  /** A process with queued work reached the moment it would cross its stall threshold (reconciler step 9). */
  | "stall_deadline";

/**
 * Reconciler step 7: the runtime and model each agent's last session started
 * on, in memory only (lost with the daemon; the Server then decides: it
 * clears a Codex session on a model change). A start that would resume that
 * session on another runtime, or a Codex session on another model, starts a
 * new one instead (`sessionToDrop`). One per daemon, shared by both hosts.
 */
export class SessionSpecMemory {
  private readonly sessions = new Map<string, { sessionId: string; runtime: string; model: string }>();

  /** A process of `agentId` ran `sessionId` on `startedWith`. */
  remember(agentId: string, sessionId: string | null | undefined, startedWith: Pick<RuntimeSpecSnapshot, "runtime" | "model">): void {
    if (!sessionId) return;
    this.sessions.set(agentId, { sessionId, runtime: startedWith.runtime, model: startedWith.model });
  }

  /** Why a start of `agentId` on `config` must not resume `sessionId`, or null. */
  sessionToDrop(agentId: string, sessionId: string | null | undefined, desired: Pick<RuntimeSpecSnapshot, "runtime" | "model">): SessionDropReason | null {
    const known = this.sessions.get(agentId);
    if (!sessionId || !known || known.sessionId !== sessionId) return null;
    return sessionDropReason(known, desired);
  }
}
