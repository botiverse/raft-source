/**
 * task #1120 — typed agent launch failures.
 *
 * Every failure the daemon can name carries a stable machine-readable code
 * (`code` on new error classes; `spawnFailureCode` on classes whose `code`
 * already means something else). `classifySpawnFailure` decides by code only.
 * Messages are for humans and logs; nothing dispatches on their text.
 */

// task #1123: the reason enum is the wire contract now, so it lives in shared;
// re-exported here so daemon call sites keep their import path.
import { SPAWN_FAILURE_REASONS as SHARED_SPAWN_FAILURE_REASONS, type AgentStartNotSpawnedReason, type SpawnFailureReason } from "@botiverse/raft-shared";
export type { SpawnFailureReason } from "@botiverse/raft-shared";

const SPAWN_FAILURE_REASONS: ReadonlySet<string> = new Set<string>(SHARED_SPAWN_FAILURE_REASONS);

/**
 * The stable code of a launch failure, or null when the error is not one the
 * daemon classifies. Node's own `ENOENT` (spawn of a missing executable) is the
 * one foreign code accepted, as `runtime_not_found`.
 */
export function spawnFailureCodeOf(error: unknown): SpawnFailureReason | null {
  if (!(error instanceof Error)) return null;
  const typed = error as { code?: unknown; spawnFailureCode?: unknown };
  if (typeof typed.spawnFailureCode === "string" && SPAWN_FAILURE_REASONS.has(typed.spawnFailureCode)) {
    return typed.spawnFailureCode as SpawnFailureReason;
  }
  if (typeof typed.code === "string") {
    if (SPAWN_FAILURE_REASONS.has(typed.code)) return typed.code as SpawnFailureReason;
    if (typed.code === "ENOENT") return "runtime_not_found";
  }
  return null;
}

/** The configured model is not available to this runtime on this computer. */
export class RuntimeModelNotFoundError extends Error {
  readonly code = "model_not_found" as const;
  readonly runtimeId: string;
  readonly model: string;

  constructor(input: { runtimeId: string; model: string }) {
    super(`Model ${input.model} is not available for the ${input.runtimeId} runtime on this computer`);
    this.name = "RuntimeModelNotFoundError";
    this.runtimeId = input.runtimeId;
    this.model = input.model;
  }
}

/**
 * task #10 — the session this start would resume failed context compaction
 * repeatedly (the summary request no longer fits the model). Resuming it
 * again would fail the same way; a new session (Reset Session & Restart) is
 * the way out.
 */
export class RuntimeSessionNeedsResetError extends Error {
  readonly code = "session_needs_reset" as const;
  readonly runtimeId: string;
  readonly failures: number;

  constructor(input: { runtimeId: string; failures: number }) {
    super(`The ${input.runtimeId} session failed context compaction ${input.failures} times in a row and cannot be resumed`);
    this.name = "RuntimeSessionNeedsResetError";
    this.runtimeId = input.runtimeId;
    this.failures = input.failures;
  }
}

/**
 * task #1258 — the agent's saved session was last run by another major line
 * of its runtime (OpenCode 1.x vs 2.x keep separate session stores, and 2.x
 * silently creates a session for an unknown id). Resuming is refused and the
 * session id is left as it is; a human starts a new session (Reset Session)
 * or reinstalls the recorded major. `recordedMajor` is null when the session
 * predates the daemon's record (made before 2.x support existed, so by 1.x).
 */
export class RuntimeSessionRuntimeMismatchError extends Error {
  readonly code = "session_runtime_mismatch" as const;
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly reason: "major_mismatch" | "unrecorded" | "record_unreadable";
  readonly recordedMajor: number | null;
  readonly installedVersion: string;

  constructor(input: {
    runtimeId: string;
    sessionId: string;
    reason: "major_mismatch" | "unrecorded" | "record_unreadable";
    recordedMajor: number | null;
    installedVersion: string;
  }) {
    const origin = input.reason === "record_unreadable"
      ? "an OpenCode version Raft can no longer tell (its session record is unreadable)"
      : input.recordedMajor === null
        ? "an earlier OpenCode line (its major version was not recorded)"
        : `OpenCode ${input.recordedMajor}.x`;
    super(`The ${input.runtimeId} session was created by ${origin} and cannot be resumed with the installed OpenCode ${input.installedVersion}`);
    this.name = "RuntimeSessionRuntimeMismatchError";
    this.runtimeId = input.runtimeId;
    this.sessionId = input.sessionId;
    this.reason = input.reason;
    this.recordedMajor = input.recordedMajor;
    this.installedVersion = input.installedVersion;
  }
}

/**
 * The selected model has no entry in the runtime's configuration on this
 * computer (Kimi: config.toml [models."X"]). Distinct from model_not_found so
 * only this runtime-confirmed case stops automatic relaunches (task #1221).
 */
export class RuntimeModelNotConfiguredError extends Error {
  readonly code = "model_not_configured" as const;
  readonly runtimeId: string;
  readonly model: string;

  constructor(input: { runtimeId: string; model: string }) {
    super(`Model ${input.model} is not configured for the ${input.runtimeId} runtime on this computer`);
    this.name = "RuntimeModelNotConfiguredError";
    this.runtimeId = input.runtimeId;
    this.model = input.model;
  }
}

/**
 * task #1307 — the provider API key holds a character that cannot be sent in
 * an HTTP header (usually pasted along with the key). The message names the
 * key variable, position and character code for the local log only; the user
 * sees reason-chosen copy that never carries any of them.
 */
export class ProviderApiKeyInvalidError extends Error {
  readonly code = "provider_api_key_invalid" as const;
  readonly keyName: string;

  constructor(input: { keyName: string; position: number; charCode: number }) {
    super(
      `${input.keyName} contains a character that cannot be sent in an HTTP header (position ${input.position}, `
      + `code ${input.charCode}). Remove any pasted text, line breaks or other characters that are not part of the key.`,
    );
    this.name = "ProviderApiKeyInvalidError";
    this.keyName = input.keyName;
  }
}

/** The runtime needs a human login on this computer before it can start. */
export class RuntimeLoginRequiredError extends Error {
  readonly code = "runtime_login_required" as const;
  readonly runtimeId: string;

  constructor(input: { runtimeId: string; message: string }) {
    super(input.message);
    this.name = "RuntimeLoginRequiredError";
    this.runtimeId = input.runtimeId;
  }
}

/** The runtime rejected its configuration on this computer (not the model name). */
export class RuntimeConfigInvalidError extends Error {
  readonly code = "runtime_config_invalid" as const;
  readonly runtimeId: string;

  constructor(input: { runtimeId: string; message: string }) {
    super(input.message);
    this.name = "RuntimeConfigInvalidError";
    this.runtimeId = input.runtimeId;
  }
}

/**
 * The agent's env vars set names this Computer does not take from the server
 * (agentEnvVarPolicy.ts). `names` are valid variable names only, never
 * values; keys that are not valid names are only counted.
 */
export class AgentEnvVarsNotAllowedError extends Error {
  readonly code = "env_var_not_allowed" as const;
  readonly runtimeId: string;
  readonly names: readonly string[];
  readonly invalidNameCount: number;

  constructor(input: { runtimeId: string; names: readonly string[]; invalidNameCount?: number }) {
    const invalidNameCount = input.invalidNameCount ?? 0;
    const parts = [
      ...(input.names.length > 0 ? [input.names.join(", ")] : []),
      ...(invalidNameCount > 0 ? [`${invalidNameCount} invalid name(s)`] : []),
    ];
    super(`Agent environment variables not allowed on this Computer: ${parts.join("; ")}`);
    this.name = "AgentEnvVarsNotAllowedError";
    this.runtimeId = input.runtimeId;
    this.names = input.names;
    this.invalidNameCount = invalidNameCount;
  }
}

/** The runtime's executable / entry point could not be resolved on this computer. */
export class RuntimeExecutableNotFoundError extends Error {
  readonly code = "runtime_not_found" as const;
  readonly runtimeId: string;
  /** Path-free, machine-readable cause when the resolver knows it (e.g. Windows launch resolution). */
  readonly reason?: string;

  constructor(input: { runtimeId: string; message: string; reason?: string }) {
    super(input.message);
    this.name = "RuntimeExecutableNotFoundError";
    this.runtimeId = input.runtimeId;
    if (input.reason) this.reason = input.reason;
  }
}

/** The local Agent Credential Proxy could not bind its listening port. */
export class AgentProxyBindError extends Error {
  readonly code = "agent_proxy_bind_failed" as const;

  constructor(message: string) {
    super(message);
    this.name = "AgentProxyBindError";
  }
}

export type ProviderConnectionMaterializationFailureKind = "http" | "invalid_payload" | "invalid_environment";

/** The server could not materialize the provider connection for launch. */
export class ProviderConnectionMaterializationError extends Error {
  readonly code = "provider_connection_materialization_failed" as const;
  readonly kind: ProviderConnectionMaterializationFailureKind;
  readonly status?: number;

  constructor(input: { kind: ProviderConnectionMaterializationFailureKind; status?: number; message: string }) {
    super(input.message);
    this.name = "ProviderConnectionMaterializationError";
    this.kind = input.kind;
    this.status = input.status;
  }
}

export function isRuntimeModelNotFoundError(error: unknown): error is RuntimeModelNotFoundError {
  return error instanceof RuntimeModelNotFoundError || (error instanceof Error && (error as { code?: unknown }).code === "model_not_found");
}

export function isProviderConnectionMaterializationError(error: unknown): error is ProviderConnectionMaterializationError {
  return error instanceof ProviderConnectionMaterializationError
    || (error instanceof Error && (error as { code?: unknown }).code === "provider_connection_materialization_failed");
}

/**
 * A start of a runtime that runs only on the OAR host (`RuntimeDriver.oarOnly`)
 * that the OAR host could not run. There is no legacy host to hand it to, so
 * the start fails with this error instead (agentHostRouter.ts). `notSpawnedReason`
 * settles the launch; `userMessage` is the sentence the owner sees.
 */
export class OarOnlyStartError extends Error {
  readonly spawnFailureCode: SpawnFailureReason;
  readonly runtimeId: string;
  /** Why the OAR host did not run the start (its trace reason). */
  readonly hostReason: string;
  readonly notSpawnedReason: AgentStartNotSpawnedReason;
  readonly userMessage: string;

  constructor(input: {
    runtimeId: string;
    hostReason: string;
    userMessage: string;
    spawnFailureCode?: SpawnFailureReason;
    notSpawnedReason?: AgentStartNotSpawnedReason;
  }) {
    super(`${input.runtimeId} runs only on the OAR host, which could not run this start (${input.hostReason})`);
    this.name = "OarOnlyStartError";
    this.runtimeId = input.runtimeId;
    this.hostReason = input.hostReason;
    this.userMessage = input.userMessage;
    this.spawnFailureCode = input.spawnFailureCode ?? "runtime_spawn_failed";
    this.notSpawnedReason = input.notSpawnedReason ?? "start_rejected";
  }
}
