import type { ManagedMcpOAuthClientInput } from "@botiverse/raft-shared";
import { UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { raftManagedMcpOAuthClient, type ManagedMcpRaftOAuthClientKind } from "./managedMcpRaftOAuthClient";

export interface ManagedMcpOAuthStorage {
  redirectUrl: string;
  configuredClient?: ManagedMcpOAuthClientInput;
  /** Signs in with Raft's own client for this provider, resolved from the deployment at each use. */
  raftClient?: ManagedMcpRaftOAuthClientKind;
  /** The provider policy's scopes for Raft's client, recorded when it is chosen; without them it is not used. */
  raftClientScope?: string;
  /** The active sign-in, checked again after acquiring the credential lease. */
  authorizationState?: string;
  clientMetadataUrl?: string;
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discoveryState?: OAuthDiscoveryState;
}

export class ManagedMcpOAuthProvider implements OAuthClientProvider {
  authorizationUrl: string | undefined;

  constructor(
    private readonly storage: ManagedMcpOAuthStorage,
    private readonly persist: () => Promise<void>,
    private readonly fixedState?: string,
  ) {}

  get redirectUrl(): string {
    return this.storage.redirectUrl;
  }

  /** The user's registered client, else Raft's own client when this Connection uses it. */
  private get registeredClient(): ManagedMcpOAuthClientInput | undefined {
    if (this.storage.configuredClient) return this.storage.configuredClient;
    if (!this.storage.raftClient || !this.storage.raftClientScope) return undefined;
    const raft = raftManagedMcpOAuthClient(this.storage.raftClient);
    return raft ? { ...raft, scope: this.storage.raftClientScope } : undefined;
  }

  /** On a registered or Raft client, never fall back to stored registration data or CIMD. */
  private get usesRegisteredClient(): boolean {
    return Boolean(this.storage.configuredClient || this.storage.raftClient);
  }

  get clientMetadata(): OAuthClientMetadata {
    const client = this.registeredClient;
    return {
      client_name: "Raft Managed MCP",
      redirect_uris: [this.storage.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: client?.tokenEndpointAuthMethod ?? "none",
      ...(client?.scope ? { scope: client.scope } : {}),
    };
  }

  get clientMetadataUrl(): string | undefined {
    return this.usesRegisteredClient ? undefined : this.storage.clientMetadataUrl;
  }

  state(): string {
    if (!this.fixedState) {
      if (this.storage.tokens?.refresh_token) {
        throw new Error("Managed MCP OAuth token refresh is temporarily unavailable");
      }
      throw new UnauthorizedError("Managed MCP OAuth must be reconnected from Raft");
    }
    return this.fixedState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const client = this.registeredClient;
    return client ? {
      client_id: client.clientId,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    } : this.usesRegisteredClient ? undefined : this.storage.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    // The SDK writes back the client it used after a token exchange. A registered or Raft client
    // is already known; storing it would copy its secret (Raft's comes from the deployment) here.
    if (this.usesRegisteredClient) delete this.storage.clientInformation;
    else this.storage.clientInformation = clientInformation;
    await this.persist();
  }

  tokens(): OAuthTokens | undefined {
    return this.storage.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.storage.tokens = tokens;
    delete this.storage.codeVerifier;
    await this.persist();
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (!this.fixedState) throw new UnauthorizedError("Managed MCP OAuth must be reconnected from Raft");
    // A client with fixed scopes (a provider policy) never asks for more: the SDK would otherwise
    // take a server's `insufficient_scope` challenge, or its full scopes_supported, as the request.
    const allowed = this.registeredClient?.scope?.split(" ").filter(Boolean);
    if (allowed?.length) {
      const requested = authorizationUrl.searchParams.get("scope")?.split(" ").filter(Boolean) ?? [];
      if (requested.length === 0 || requested.some((scope) => !allowed.includes(scope))) {
        throw new UnauthorizedError("The MCP server asked for scopes beyond this Connection's client");
      }
    }
    if (this.registeredClient?.requestOfflineAccess) {
      authorizationUrl.searchParams.set("access_type", "offline");
      authorizationUrl.searchParams.set("prompt", "consent");
    }
    this.authorizationUrl = authorizationUrl.toString();
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.storage.codeVerifier = codeVerifier;
    await this.persist();
  }

  codeVerifier(): string {
    if (!this.storage.codeVerifier) throw new Error("Managed MCP OAuth code verifier is unavailable");
    return this.storage.codeVerifier;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    this.storage.discoveryState = discoveryState;
    await this.persist();
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.storage.discoveryState;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all" || scope === "client") delete this.storage.clientInformation;
    if (scope === "all" || scope === "tokens") delete this.storage.tokens;
    if (scope === "all" || scope === "verifier") delete this.storage.codeVerifier;
    if (scope === "all" || scope === "discovery") delete this.storage.discoveryState;
    await this.persist();
  }
}
