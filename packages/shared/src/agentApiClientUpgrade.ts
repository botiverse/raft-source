// A Server refusing an agent API request because the client that sent it is
// too old (today: Artifacts' minimum `raft` CLI version while Artifacts is
// dogfooding, the server's apps/artifacts/cliFloor.ts;
// docs/development/workspace-artifacts.md#minimum-cli-version). The route
// answers 426 with this body before it runs. Re-exported by
// agentApiContract.ts; a leaf, so the agent operations' outcome
// (agentOps/outcome.ts) reads it without loading the contract.

export const AGENT_API_CLIENT_UPGRADE_REQUIRED_CODE = "CLIENT_UPGRADE_REQUIRED";

/** HTTP 426 Upgrade Required. */
export const AGENT_API_CLIENT_UPGRADE_REQUIRED_STATUS = 426;

/**
 * The 426 body. `error` is the sentence for the agent: what is too old, and
 * exactly how to upgrade; agent clients show it as it is.
 * `suggestedNextAction` is the how-to-upgrade part alone, so clients that
 * predate this body (they show a generic message and the Server's next
 * action) still tell the agent what to do.
 */
export interface AgentApiClientUpgradeRequiredBody {
  error: string;
  code: typeof AGENT_API_CLIENT_UPGRADE_REQUIRED_CODE;
  /** The oldest client version the route accepts (release part; its prereleases pass too). */
  minVersion: string;
  /** The version the client sent, or null when it sent none (or one that isn't a version). */
  yourVersion: string | null;
  suggestedNextAction: string;
}

/** A 426 body as declared above, or null for anything else. */
export function parseAgentApiClientUpgradeRequiredBody(body: unknown): AgentApiClientUpgradeRequiredBody | null {
  if (!body || typeof body !== "object") return null;
  const { error, code, minVersion, yourVersion, suggestedNextAction } = body as Record<string, unknown>;
  if (code !== AGENT_API_CLIENT_UPGRADE_REQUIRED_CODE || typeof error !== "string" || typeof minVersion !== "string") return null;
  return {
    error,
    code,
    minVersion,
    yourVersion: typeof yourVersion === "string" ? yourVersion : null,
    suggestedNextAction: typeof suggestedNextAction === "string" ? suggestedNextAction : "",
  };
}
