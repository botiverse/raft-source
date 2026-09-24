export type SpawnFailureReason =
  | "agent_proxy_bind_failed"
  | "runner_credential_mint_failed"
  | "provider_connection_materialization_failed"
  | "runtime_not_found"
  | "runtime_version_too_old"
  | "runtime_spawn_failed";

export interface SpawnFailureClassification {
  reason: SpawnFailureReason;
  detail: string;
  userMessage: string;
}

export function classifySpawnFailure(error: unknown): SpawnFailureClassification {
  const detail = error instanceof Error ? error.message : String(error);
  const errorName = error instanceof Error ? error.name : "";
  const lower = detail.toLowerCase();

  if (error instanceof Error && "code" in error && error.code === "runtime_version_too_old") {
    return {
      reason: "runtime_version_too_old",
      detail,
      userMessage: detail,
    };
  }

  if (lower.includes("provider connection materialization")) {
    const status = /provider connection materialization failed \(http (\d{3})\)/i.exec(detail)?.[1];
    const safeDetail = status
      ? `Provider connection materialization failed (HTTP ${status})`
      : lower.includes("invalid payload")
        ? "Provider connection materialization returned an invalid payload"
        : lower.includes("invalid environment")
          ? "Provider connection materialization returned an invalid environment"
          : "Provider connection materialization failed";
    return {
      reason: "provider_connection_materialization_failed",
      detail,
      userMessage: `${safeDetail}. Check Server Settings → AI Providers and retry.`,
    };
  }

  if (lower.includes("agent credential proxy") && lower.includes("failed to bind")) {
    return {
      reason: "agent_proxy_bind_failed",
      detail,
      userMessage: "Local agent proxy could not start. Check if another daemon or service is using the required local port.",
    };
  }

  if (lower.includes("runner_credential_mint") || errorName === "RunnerCredentialMintError") {
    return {
      reason: "runner_credential_mint_failed",
      detail,
      userMessage: "Runner credential mint failed. Ensure the server is deployed and the daemon binary is compatible.",
    };
  }

  if (lower.includes("enoent") || lower.includes("cannot resolve") || lower.includes("not found")) {
    return {
      reason: "runtime_not_found",
      detail,
      userMessage: "Runtime executable not found. Ensure the required CLI is installed and available on PATH.",
    };
  }

  return {
    reason: "runtime_spawn_failed",
    detail,
    userMessage: "Runtime failed to start. Check the Computer logs for details and retry.",
  };
}
