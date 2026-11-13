import type { ManagedMcpOAuthClientInput, ManagedMcpOAuthClientMode, ManagedMcpOAuthClientPolicy } from "@botiverse/raft-shared";

export interface OAuthClientDraft {
  mode: "keep" | "automatic" | "custom";
  /** An untouched automatic client on edit must not invalidate its grant. */
  preserveAutomatic?: boolean;
  clientId: string;
  clientSecret: string;
  method: ManagedMcpOAuthClientInput["tokenEndpointAuthMethod"];
  scope: string;
  offline: boolean;
}
export function emptyOAuthClientDraft(
  configured = false,
  policy: ManagedMcpOAuthClientPolicy | null = null,
  raftClient = false,
  clientMode: ManagedMcpOAuthClientMode = "either",
): OAuthClientDraft {
  if (policy && !configured && !raftClient) {
    // A provider without automatic registration starts on its only option, with Raft's fixed settings.
    return { mode: "custom", clientId: "", clientSecret: "", method: policy.tokenEndpointAuthMethod, scope: "", offline: policy.requestOfflineAccess };
  }
  if (!policy && !configured && clientMode === "registered") {
    // The App takes only a registered client; its settings stay the user's to choose.
    return { mode: "custom", clientId: "", clientSecret: "", method: "none", scope: "", offline: false };
  }
  return { mode: configured ? "keep" : "automatic", clientId: "", clientSecret: "", method: "none", scope: "", offline: false };
}
export function editOAuthClientDraft(
  configured: boolean | undefined,
  policy: ManagedMcpOAuthClientPolicy | null = null,
  raftClient = false,
  clientMode: ManagedMcpOAuthClientMode = "either",
): OAuthClientDraft {
  // Without Raft's client a policy provider has nothing automatic to keep; with it, "automatic" is Raft's client.
  if (policy && !raftClient) return emptyOAuthClientDraft(configured !== false, policy);
  // A registered-only App has no automatic client to preserve.
  if (!policy && configured === false && clientMode === "registered") return emptyOAuthClientDraft(false, null, false, clientMode);
  return configured === false
    ? { ...emptyOAuthClientDraft(), preserveAutomatic: true }
    : emptyOAuthClientDraft(true);
}
export function oauthClientPayload(draft: OAuthClientDraft): ManagedMcpOAuthClientInput | null | undefined {
  if (draft.mode === "keep") return undefined;
  if (draft.mode === "automatic") return draft.preserveAutomatic ? undefined : null;
  return {
    clientId: draft.clientId,
    tokenEndpointAuthMethod: draft.method,
    ...(draft.method !== "none" ? { clientSecret: draft.clientSecret } : {}),
    ...(draft.scope.trim() ? { scope: draft.scope.trim() } : {}),
    ...(draft.offline ? { requestOfflineAccess: true } : {}),
  };
}
