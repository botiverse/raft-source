import type { ManagedMcpOAuthClientInput } from "@botiverse/raft-shared";
import { ManagedMcpCredentialError, decryptManagedMcpSecret } from "./managedMcpCredentialService";
import type { ManagedMcpOAuthStorage } from "./managedMcpOAuthProvider";

/** Validate before encryption; errors must never echo supplied credentials. */
export function normalizeManagedMcpOAuthClient(value: unknown): ManagedMcpOAuthClientInput | null | undefined {
  if (value === undefined || value === null) return value;
  const invalid = () => new ManagedMcpCredentialError("OAuth client configuration is invalid", "managed_mcp_credential_invalid");
  if (typeof value !== "object" || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["clientId", "clientSecret", "tokenEndpointAuthMethod", "scope", "requestOfflineAccess"].includes(key))) throw invalid();
  if (typeof input.clientId !== "string" || !input.clientId.trim() || input.clientId.length > 2000 || /[\r\n]/u.test(input.clientId)) throw invalid();
  const method = input.tokenEndpointAuthMethod;
  if (method !== "none" && method !== "client_secret_post" && method !== "client_secret_basic") throw invalid();
  if (method === "none" && input.clientSecret !== undefined) throw invalid();
  if (method !== "none" && (typeof input.clientSecret !== "string" || !input.clientSecret.trim() || input.clientSecret.length > 16000 || /[\r\n]/u.test(input.clientSecret))) throw invalid();
  if (input.scope !== undefined && (typeof input.scope !== "string" || input.scope.length > 4000 || /[\r\n]/u.test(input.scope))) throw invalid();
  if (input.requestOfflineAccess !== undefined && typeof input.requestOfflineAccess !== "boolean") throw invalid();
  return {
    clientId: input.clientId.trim(),
    tokenEndpointAuthMethod: method,
    ...(method !== "none" ? { clientSecret: input.clientSecret as string } : {}),
    ...(typeof input.scope === "string" && input.scope.trim() ? { scope: input.scope.trim() } : {}),
    ...(input.requestOfflineAccess === true ? { requestOfflineAccess: true } : {}),
  };
}

export function configuredManagedMcpOAuthStorage(client: ManagedMcpOAuthClientInput): ManagedMcpOAuthStorage {
  return { redirectUrl: "https://invalid.invalid/api/mcp/oauth/callback", configuredClient: client };
}


/** A presence hint, never the client ID or secret. An unreadable payload is unknown, not absent. */
export function hasConfiguredManagedMcpOAuthClient(payload: string | null): boolean | undefined {
  if (!payload) return false;
  try {
    const value = decryptManagedMcpSecret(payload);
    return typeof value === "object" && value !== null && "configuredClient" in value
      && Boolean(value.configuredClient);
  } catch (error) {
    if (error instanceof ManagedMcpCredentialError) return undefined;
    throw error;
  }
}
