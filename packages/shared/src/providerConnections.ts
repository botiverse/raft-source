import { PI_BUILTIN_PROVIDER_API_KEY_ENV_KEYS_GENERATED } from "./piBuiltinModels.generated.js";

type PresetProviderConnectionProviderId = keyof typeof PI_BUILTIN_PROVIDER_API_KEY_ENV_KEYS_GENERATED;
type GatewayProviderConnectionProviderId = "openai-compatible" | "anthropic-compatible";

export const PROVIDER_CONNECTION_PROVIDER_IDS = [
  ...(Object.keys(PI_BUILTIN_PROVIDER_API_KEY_ENV_KEYS_GENERATED) as PresetProviderConnectionProviderId[]),
  "openai-compatible",
  "anthropic-compatible",
] as const satisfies readonly (PresetProviderConnectionProviderId | GatewayProviderConnectionProviderId)[];

export type ProviderConnectionProviderId = typeof PROVIDER_CONNECTION_PROVIDER_IDS[number];
export type ProviderConnectionAuthMethod = "api_key" | "oauth";
export type ProviderConnectionStatus = "unchecked" | "ready" | "error" | "pending_auth" | "expired";

export interface ProviderConnectionProviderOption {
  id: ProviderConnectionProviderId;
  label: string;
  providerKind: "preset" | "gateway";
}

export interface ProviderConnectionCatalog {
  connections: ProviderConnectionSummary[];
  providerOptions: ProviderConnectionProviderOption[];
}

export interface ProviderConnectionSummary {
  id: string;
  name: string;
  providerId: ProviderConnectionProviderId;
  authMethod: ProviderConnectionAuthMethod;
  endpointUrl: string | null;
  supportsImageInput: boolean;
  enabled: boolean;
  status: ProviderConnectionStatus;
  configVersion: number;
  credentialVersion: number;
  hasCredential: boolean;
  assignedAgentCount: number;
  lastCheckedAt: string | null;
  lastErrorCategory: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Credential-free metadata materialized by the server for one exact launch. */
export interface ProviderConnectionLaunchProjection {
  providerId: ProviderConnectionProviderId;
  endpointUrl: string | null;
  supportsImageInput: boolean;
}

export function isProviderConnectionProviderId(value: unknown): value is ProviderConnectionProviderId {
  return typeof value === "string"
    && (PROVIDER_CONNECTION_PROVIDER_IDS as readonly string[]).includes(value);
}
