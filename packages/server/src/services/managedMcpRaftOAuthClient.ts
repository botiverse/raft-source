import type { ManagedMcpOAuthClientInput, ManagedMcpOAuthClientPolicy } from "@botiverse/raft-shared";

/** Which Raft-owned OAuth client a Connection signs in with; stored as this marker, never as the secret. */
export type ManagedMcpRaftOAuthClientKind = "google";

/**
 * Raft's own registered client for a provider, read from the process environment at each use, so a
 * secret rotated by a rollout (ECS reads secret references when a task starts) applies to every
 * Connection without re-authorization. Google: one Web client per deployment in a Raft Cloud
 * project that enables the APIs of the services it covers and allows that API origin's callback.
 * `MANAGED_MCP_GOOGLE_OAUTH_CLIENT_ID` is plain configuration; `MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SECRET`
 * is an ECS secret reference. Either missing means the deployment has no Raft client.
 */
export function raftManagedMcpOAuthClient(kind: ManagedMcpRaftOAuthClientKind | null | undefined): ManagedMcpOAuthClientInput | null {
  if (kind !== "google") return null;
  const clientId = process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, tokenEndpointAuthMethod: "client_secret_post", requestOfflineAccess: true };
}

/**
 * Which Google Workspace MCP services Raft's client covers on this deployment, from
 * `MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SERVICES` (comma-separated: docs, sheets, slides, drive, gmail,
 * calendar). Unset means all. A deployment lists only the services whose scopes its Google project
 * declares and has had approved, so the others keep the guided own-client form instead of asking
 * for unapproved scopes.
 */
function raftGoogleClientCovers(apiService: string): boolean {
  const configured = process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SERVICES;
  if (configured === undefined) return true;
  const service = apiService.replace(/mcp\.googleapis\.com$/u, "");
  return configured.split(",").map((value) => value.trim().toLowerCase()).includes(service);
}

/** The Raft client kind a policy's provider can use on this deployment, or null when none is configured for it. */
export function availableRaftOAuthClientKind(policy: ManagedMcpOAuthClientPolicy | null): ManagedMcpRaftOAuthClientKind | null {
  return policy?.provider === "google" && raftGoogleClientCovers(policy.apiService) && raftManagedMcpOAuthClient("google") ? "google" : null;
}
