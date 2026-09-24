import { UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface ManagedMcpOAuthStorage {
  redirectUrl: string;
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

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Raft Managed MCP",
      redirect_uris: [this.storage.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  get clientMetadataUrl(): string | undefined {
    return this.storage.clientMetadataUrl;
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
    return this.storage.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    this.storage.clientInformation = clientInformation;
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
