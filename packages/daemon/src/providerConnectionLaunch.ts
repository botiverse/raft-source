import {
  BUILTIN_RUNTIME_GATEWAY_PROVIDER_BASE_URL_ENV_KEYS,
  BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS,
  BUILTIN_RUNTIME_PROVIDER_ENV_KEYS,
  hydrateRuntimeConfig,
  isBuiltInRuntimeGatewayProviderId,
  isBuiltInRuntimeProviderId,
  isProviderConnectionProviderId,
  type AgentConfig,
} from "@botiverse/raft-shared";
import { daemonFetch } from "./daemonFetch.js";

type ProviderConnectionLaunch = {
  envVars: Record<string, string>;
  providerConnection: NonNullable<AgentConfig["providerConnection"]>;
};

export async function requestProviderConnectionLaunch(input: {
  serverUrl: string;
  daemonApiKey: string;
  agentId: string;
  connectionId: string;
}): Promise<ProviderConnectionLaunch> {
  const url = new URL(
    `/internal/computer/runners/${encodeURIComponent(input.agentId)}/provider-connection`,
    input.serverUrl,
  );
  const response = await daemonFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.daemonApiKey}`,
      "Content-Type": "application/json",
      "X-Raft-Client": "daemon-server-session-worker",
    },
    body: JSON.stringify({ connectionId: input.connectionId }),
  });
  if (!response.ok) {
    throw new Error(`Provider connection materialization failed (HTTP ${response.status})`);
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  const projection = body?.providerConnection;
  const envVars = body?.envVars;
  if (
    !body
    || Object.keys(body).sort().join(",") !== "envVars,providerConnection"
    || !projection
    || typeof projection !== "object"
    || Array.isArray(projection)
    || Object.keys(projection).sort().join(",") !== "endpointUrl,providerId,supportsImageInput"
    || !isProviderConnectionProviderId((projection as Record<string, unknown>).providerId)
    || !(
      (projection as Record<string, unknown>).endpointUrl === null
      || typeof (projection as Record<string, unknown>).endpointUrl === "string"
    )
    || typeof (projection as Record<string, unknown>).supportsImageInput !== "boolean"
    || !envVars
    || typeof envVars !== "object"
    || Array.isArray(envVars)
  ) {
    throw new Error("Provider connection materialization returned an invalid payload");
  }
  const providerConnection = projection as ProviderConnectionLaunch["providerConnection"];
  const materializedEnvVars = envVars as Record<string, string>;
  const presetApiKeyEnv = isBuiltInRuntimeProviderId(providerConnection.providerId)
    ? BUILTIN_RUNTIME_PROVIDER_ENV_KEYS[providerConnection.providerId]
    : null;
  const gatewayApiKeyEnv = isBuiltInRuntimeGatewayProviderId(providerConnection.providerId)
    ? BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS[providerConnection.providerId]
    : null;
  const gatewayBaseUrlEnv = isBuiltInRuntimeGatewayProviderId(providerConnection.providerId)
    ? BUILTIN_RUNTIME_GATEWAY_PROVIDER_BASE_URL_ENV_KEYS[providerConnection.providerId]
    : null;
  const expectedEnvKeys = presetApiKeyEnv
    ? [presetApiKeyEnv]
    : gatewayApiKeyEnv && gatewayBaseUrlEnv
      ? [gatewayApiKeyEnv, gatewayBaseUrlEnv]
      : [];
  const entries = Object.entries(materializedEnvVars);
  if (
    entries.length !== expectedEnvKeys.length
    || entries.some(([key, value]) => !expectedEnvKeys.includes(key) || typeof value !== "string" || !value)
    || (!presetApiKeyEnv && (!gatewayApiKeyEnv || !gatewayBaseUrlEnv))
    || (presetApiKeyEnv && (
      providerConnection.endpointUrl !== null || providerConnection.supportsImageInput
    ))
    || (gatewayBaseUrlEnv && (
      !providerConnection.endpointUrl
      || materializedEnvVars[gatewayBaseUrlEnv] !== providerConnection.endpointUrl
    ))
  ) {
    throw new Error("Provider connection materialization returned an invalid environment");
  }
  return { envVars: Object.fromEntries(entries), providerConnection };
}

export async function materializeProviderConnectionForSpawn(
  config: AgentConfig,
  input: { serverUrl: string; daemonApiKey: string; agentId: string },
): Promise<AgentConfig> {
  const runtimeConfig = hydrateRuntimeConfig(config);
  if (runtimeConfig.runtime !== "builtin" || runtimeConfig.provider?.kind !== "connection") return config;
  const launch = await requestProviderConnectionLaunch({
    ...input,
    connectionId: runtimeConfig.provider.connectionId,
  });
  return {
    ...config,
    providerConnection: launch.providerConnection,
    envVars: { ...(config.envVars ?? {}), ...launch.envVars },
  };
}
