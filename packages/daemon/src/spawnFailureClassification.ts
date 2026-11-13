import {
  isRuntimeModelDetectionLookupReason,
  isSpawnFailureLookupReason,
  type RuntimeModelDetectionLookupReason,
  type SpawnFailureActivityDiagnostic,
  type SpawnFailureLookupReason,
} from "@botiverse/raft-shared";
import {
  AgentEnvVarsNotAllowedError,
  OarOnlyStartError,
  RuntimeModelNotConfiguredError,
  isProviderConnectionMaterializationError,
  isRuntimeModelNotFoundError,
  spawnFailureCodeOf,
  type SpawnFailureReason,
} from "./spawnFailureErrors";

import { formatRuntimeResetSessionGuidance } from "./runtimeErrorDiagnostics";

export type { SpawnFailureReason } from "./spawnFailureErrors";

type RuntimeModelNotFoundErrorLike = { model: string };

export const PROVIDER_API_KEY_INVALID_USER_MESSAGE =
  "Couldn't start: there's a problem with the API key. Copy the full key again from your provider's dashboard, save, and retry.";

export interface SpawnFailureClassification {
  reason: SpawnFailureReason;
  detail: string;
  userMessage: string;
  /** task #1242 — only with `runtime_not_found`: how the PATH lookup ended, when the resolver said. */
  lookupReason?: SpawnFailureLookupReason;
}

/**
 * A resolver that looked the command up with the runtime probe's lookup
 * (`lookupCommandOnPath`, e.g. Grok) reports the probe vocabulary; the start
 * carrier speaks the launch vocabulary. One boundary, one mapping; the detect
 * carrier keeps the probe vocabulary untouched.
 */
const LAUNCH_LOOKUP_REASON_FROM_PROBE: Record<RuntimeModelDetectionLookupReason, SpawnFailureLookupReason> = {
  not_installed: "not_on_path",
  probe_timeout: "lookup_timed_out",
  permission_denied: "lookup_permission_denied",
  probe_failed: "lookup_failed",
};

/**
 * The resolver's path-free lookup verdict, when the thrown error (or its
 * cause) carries one in either vocabulary, together with that error's own
 * message (the start wrapper's message is for logs). Anything else is "no
 * verdict".
 */
function lookupVerdictOf(error: unknown): { reason: SpawnFailureLookupReason; message: string } | null {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const raw = (candidate as { reason?: unknown } | null | undefined)?.reason;
    const reason = isSpawnFailureLookupReason(raw)
      ? raw
      : isRuntimeModelDetectionLookupReason(raw)
        ? LAUNCH_LOOKUP_REASON_FROM_PROBE[raw]
        : null;
    if (reason) {
      return { reason, message: candidate instanceof Error ? candidate.message : String(candidate) };
    }
  }
  return null;
}

function envVarsNotAllowedCause(error: unknown): AgentEnvVarsNotAllowedError | null {
  for (let current = error, depth = 0; current && depth < 5; current = (current as { cause?: unknown }).cause, depth += 1) {
    if (current instanceof AgentEnvVarsNotAllowedError) return current;
  }
  return null;
}

/** Names the variables (never their values) and how to get the agent going again. */
export function agentEnvVarsNotAllowedUserMessage(names: readonly string[], invalidNameCount = 0): string {
  const sentences: string[] = [];
  if (names.length > 0) {
    const one = names.length === 1;
    sentences.push(
      `This agent's settings set ${names.join(", ")}, which this Computer no longer accepts from the server because ${one ? "it" : "they"} can make it run other programs.`,
      `Remove ${one ? "it" : "them"} from the agent's environment variables, then restart the agent.`,
    );
  }
  if (invalidNameCount > 0) {
    sentences.push(
      "This agent's environment variables include a name that is not a valid variable name (only letters, digits and underscores, not starting with a digit).",
      "Fix or remove it in the agent's settings, then restart the agent.",
    );
  }
  if (names.some((name) => name.toUpperCase() === "PATH")) {
    // The Computer service starts from the user's login shell environment on
    // macOS and Linux (computer shellEnvCapture.ts), so that is where PATH goes.
    sentences.push("Agents get PATH from this computer: on macOS and Linux add the directory in your login shell's startup file (such as ~/.zshrc or ~/.profile) and restart the Computer service; on Windows add it to your user PATH.");
  }
  return sentences.join(" ");
}

/**
 * Map a launch failure to a stable reason + a user message. Raw detail stays
 * out of it, except where a typed error builds its own sentence (an OAR-only
 * start quotes its runtime's masked first line, agentHostRouter.ts).
 * Decides by the error's typed code only (task #1120): message
 * text is for logs, so a "not found" in a model error can no longer be read as
 * a missing executable. Anything without a known code is the generic fallback.
 */
export function classifySpawnFailure(error: unknown): SpawnFailureClassification {
  const detail = error instanceof Error ? error.message : String(error);
  // An OAR-only runtime's start names its own way out (agentHostRouter.ts).
  if (error instanceof OarOnlyStartError) return { reason: error.spawnFailureCode, detail, userMessage: error.userMessage };
  const reason = spawnFailureCodeOf(error) ?? "runtime_spawn_failed";

  switch (reason) {
    case "runtime_version_too_old":
      return { reason, detail, userMessage: detail };
    case "provider_connection_materialization_failed": {
      const typed = isProviderConnectionMaterializationError(error)
        ? error
        : isProviderConnectionMaterializationError((error as { cause?: unknown }).cause)
          ? (error as { cause: import("./spawnFailureErrors").ProviderConnectionMaterializationError }).cause
          : null;
      const safeDetail = typed?.kind === "http" && typed.status !== undefined
        ? `Provider connection materialization failed (HTTP ${typed.status})`
        : typed?.kind === "invalid_payload"
          ? "Provider connection materialization returned an invalid payload"
          : typed?.kind === "invalid_environment"
            ? "Provider connection materialization returned an invalid environment"
            : "Provider connection materialization failed";
      return { reason, detail, userMessage: `${safeDetail}. Check Server Settings → AI Providers and retry.` };
    }
    case "agent_proxy_bind_failed":
      return {
        reason,
        detail,
        userMessage: "Local agent proxy could not start. Check if another daemon or service is using the required local port.",
      };
    case "runner_credential_mint_failed":
      return {
        reason,
        detail,
        userMessage: "Runner credential mint failed. Ensure the server is deployed and the daemon binary is compatible.",
      };
    case "model_not_found": {
      const typed = isRuntimeModelNotFoundError(error)
        ? error
        : isRuntimeModelNotFoundError((error as { cause?: unknown }).cause)
          ? (error as { cause: RuntimeModelNotFoundErrorLike }).cause
          : null;
      const model = typed ? typed.model : "the configured model";
      return {
        reason,
        detail,
        userMessage: `Model ${model} is not available for this runtime on this computer: it may have been renamed or removed in this runtime version, or its provider has no usable API key here. Choose another model, or fix the provider's key, in the agent's settings.`,
      };
    }
    case "runtime_not_found": {
      // task #1242: only a confirmed miss (`not_on_path`) may suggest
      // installing. An undecided lookup (timed out, denied, failed) shows its
      // resolver's own path-free message (task #1240 wording); no verdict at
      // all (a plain ENOENT, an unknown value) gets neutral copy.
      const verdict = lookupVerdictOf(error);
      const userMessage = verdict === null
        ? "Could not confirm whether the runtime executable is available on this computer. Retry, or check the Computer's status."
        : verdict.reason === "not_on_path"
          ? "Runtime executable not found. Ensure the required CLI is installed and available on PATH."
          : verdict.message;
      return {
        reason,
        detail,
        userMessage,
        ...(verdict ? { lookupReason: verdict.reason } : {}),
      };
    }
    case "model_not_configured": {
      const cause = (error as { cause?: unknown }).cause;
      const typed = error instanceof RuntimeModelNotConfiguredError
        ? error
        : cause instanceof RuntimeModelNotConfiguredError ? cause : null;
      const model = typed ? typed.model : "the configured model";
      return {
        reason,
        detail,
        userMessage: `Model ${model} is not configured for this runtime on this computer. Choose a configured model in the agent's settings, or add it to the runtime's configuration there, then restart the agent.`,
      };
    }
    case "provider_api_key_invalid":
      // task #1307: Cat's copy. Older servers and web builds drop the typed
      // reason and show this text, so it is the same sentence the web picks by
      // reason. Never the key, its position or its character codes.
      return { reason, detail, userMessage: PROVIDER_API_KEY_INVALID_USER_MESSAGE };
    case "session_needs_reset":
      return {
        reason,
        detail,
        userMessage: "This agent's runtime session failed context compaction several times in a row: its conversation no longer fits the model, so resuming it cannot succeed. "
          + formatRuntimeResetSessionGuidance(),
      };
    case "session_runtime_mismatch":
      // task #1258: the detail is the typed error's own sentence (which major
      // made the session, which is installed); nothing from provider output.
      return {
        reason,
        detail,
        userMessage: `${detail}. Sessions do not carry across runtime major versions, so automatic restarts are paused. `
          + formatRuntimeResetSessionGuidance()
          + " Alternatively, install the runtime version line the session was created with and restart the agent.",
      };
    case "runtime_login_required":
      return {
        reason,
        detail,
        userMessage: "The runtime needs you to log in on this computer before it can start. Log in to the runtime there, then restart the agent.",
      };
    case "runtime_config_invalid":
      return {
        reason,
        detail,
        userMessage: "The runtime's configuration on this computer is invalid, so the agent cannot start. Fix the runtime configuration there, then restart the agent.",
      };
    case "runtime_spawn_failed":
      return {
        reason,
        detail,
        userMessage: "Runtime failed to start. Check the Computer logs for details and retry.",
      };
    case "env_var_not_allowed":
    {
      const typed = envVarsNotAllowedCause(error);
      return { reason, detail, userMessage: agentEnvVarsNotAllowedUserMessage(typed?.names ?? [], typed?.invalidNameCount ?? 0) };
    }
    case "runtime_start_timeout":
    case "model_unsupported":
    case "runtime_repeated_failure":
      // Reported by the daemon itself (`startTimeoutClassification`, a
      // reconciler step 12 hand-off), never thrown; an error carrying the
      // code keeps its own message.
      return { reason, detail, userMessage: detail };
  }
}

/** A start whose runtime never produced its first output in time; `detail` is the copy shown. */
export function startTimeoutClassification(detail: string): SpawnFailureClassification {
  return { reason: "runtime_start_timeout", detail, userMessage: detail };
}

/** What a failed start shows: the user message and its typed reason (task #1123). */
export interface StartFailureActivity {
  detail: string;
  spawnFailure: SpawnFailureActivityDiagnostic;
}

/**
 * The `runtime_unavailable` activity of a failed start. The configured model
 * rides along only for the model reasons and a start timeout (the model is the
 * likely cause), bounded, so the web and the server's pause trace can name it.
 */
export function startFailureActivity(classification: SpawnFailureClassification, model: string | null | undefined): StartFailureActivity {
  const carriesModel = (classification.reason === "model_not_found" || classification.reason === "model_not_configured" || classification.reason === "model_unsupported" || classification.reason === "runtime_start_timeout")
    && typeof model === "string" && model.length > 0;
  const carriesLookupReason = classification.reason === "runtime_not_found" && classification.lookupReason !== undefined;
  return {
    detail: classification.userMessage,
    spawnFailure: {
      reason: classification.reason,
      ...(carriesModel ? { model: model.slice(0, 128) } : {}),
      ...(carriesLookupReason ? { lookupReason: classification.lookupReason } : {}),
    },
  };
}
