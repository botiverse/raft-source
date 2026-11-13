// An external agent's setup status (server routes/agents.ts GET /agents/:id/external-status).
import type { AgentHostedRuntimeSummary } from "@botiverse/raft-shared";

/** Server routes/agents.ts external-status (services/agentCredentialService.ts externalAgentSetupState). */
export type ExternalAgentSetupState = "waiting_for_login" | "credential_minted" | "login_token_expired" | "connected" | "disconnected";

/** No credential it can sign in with: never connected, its login token expired, or every one revoked. */
export function externalSetupNeedsSignIn(state: ExternalAgentSetupState | undefined): boolean {
  return state === "waiting_for_login" || state === "login_token_expired" || state === "disconnected";
}

export interface ExternalAgentStatus {
  setupState: ExternalAgentSetupState;
  credentialLastUsedAt: string | null;
  /** How its person said it would connect; null before this (show the existing agent's CLI login). Absent from older servers. */
  externalSetupMethod?: "existing_agent" | "sdk" | null;
  lastActivityAt: string | null;
  hostedRuntime?: AgentHostedRuntimeSummary;
}

