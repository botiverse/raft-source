import {
  RUNTIME_CONFIG_VERSION,
} from "@botiverse/raft-shared";
import type {
  ResolvedAgentCreateFormDefinition,
  BuiltInRuntimeConfig,
  BuiltInRuntimeGatewayProviderId,
  BuiltInRuntimeProviderId,
  ProviderlessRuntimeConfig,
  RuntimeReasoningEffort,
} from "@botiverse/raft-shared";
import { RuntimeConfigBuildError } from "./runtimeConfigForm";

export function buildSchemaDrivenBuiltInConfig(input: {
  definition: ResolvedAgentCreateFormDefinition;
  providerId: string;
  apiKey: string;
  baseUrl: string;
  supportsImageInput: boolean;
  model: string;
  envVars: Record<string, string> | null;
}): BuiltInRuntimeConfig {
  const providerSource = input.definition.optionSources.provider;
  const modelSource = input.definition.optionSources.model;
  if (providerSource?.kind !== "select" || modelSource?.kind !== "dependent_select") {
    throw new RuntimeConfigBuildError("optionSourcesInvalid", "Runtime form option sources are invalid");
  }
  const provider = providerSource.options.find((option) => option.value === input.providerId);
  if (!provider) throw new RuntimeConfigBuildError("selectValidProvider", "Select a valid provider");
  if (!input.apiKey.trim()) throw new RuntimeConfigBuildError("apiKeyRequired", "API Key is required");
  const customModelAllowed = modelSource.customValueAllowedByValue[input.providerId] === true;
  if (!input.model.trim()) throw new RuntimeConfigBuildError("modelRequired", "Model is required");
  if (!customModelAllowed && !(modelSource.optionsByValue[input.providerId] ?? []).some((option) => option.value === input.model)) {
    throw new RuntimeConfigBuildError("selectValidProviderModel", "Select a valid provider model");
  }
  if (provider.providerKind === "gateway" && !/^https?:\/\//i.test(input.baseUrl.trim())) {
    throw new RuntimeConfigBuildError("baseUrlInvalid", "Base URL must start with http:// or https://");
  }
  return {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "builtin",
    provider: provider.providerKind === "gateway"
      ? {
          kind: "gateway",
          providerId: input.providerId as BuiltInRuntimeGatewayProviderId,
          baseUrl: input.baseUrl.trim(),
          apiKey: input.apiKey.trim(),
          ...("supportsImageInput" in input.definition.dataSchema.properties
            ? { supportsImageInput: input.supportsImageInput }
            : {}),
        }
      : {
          kind: "preset",
          providerId: input.providerId as BuiltInRuntimeProviderId,
          apiKey: input.apiKey.trim(),
        },
    model: customModelAllowed
      ? { kind: "custom", name: input.model.trim() }
      : { kind: "preset", id: input.model },
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: input.envVars,
    hostUserState: "forbidden",
  };
}

export function buildConnectionDrivenBuiltInConfig(input: {
  definition: ResolvedAgentCreateFormDefinition;
  connectionId: string;
  providerId: string;
  model: string;
  envVars: Record<string, string> | null;
}): BuiltInRuntimeConfig {
  const providerSource = input.definition.optionSources.provider;
  const modelSource = input.definition.optionSources.model;
  if (providerSource?.kind !== "select" || modelSource?.kind !== "dependent_select") {
    throw new RuntimeConfigBuildError("optionSourcesInvalid", "Runtime form option sources are invalid");
  }
  if (!input.connectionId.trim() || !providerSource.options.some((option) => option.value === input.providerId)) {
    throw new RuntimeConfigBuildError("selectValidProviderConnection", "Select a valid provider connection");
  }
  const customModelAllowed = modelSource.customValueAllowedByValue[input.providerId] === true;
  if (!input.model.trim()) throw new RuntimeConfigBuildError("modelRequired", "Model is required");
  if (!customModelAllowed && !(modelSource.optionsByValue[input.providerId] ?? []).some((option) => option.value === input.model)) {
    throw new RuntimeConfigBuildError("selectValidProviderModel", "Select a valid provider model");
  }
  return {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "builtin",
    provider: { kind: "connection", connectionId: input.connectionId.trim() },
    model: customModelAllowed
      ? { kind: "custom", name: input.model.trim() }
      : { kind: "preset", id: input.model },
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: input.envVars,
    hostUserState: "forbidden",
  };
}

export function buildSchemaDrivenKimiConfig(input: {
  definition: ResolvedAgentCreateFormDefinition;
  model: string;
  reasoningEffort: RuntimeReasoningEffort | null;
  envVars: Record<string, string> | null;
}): ProviderlessRuntimeConfig {
  if (input.definition.runtimeId !== "kimi-sdk") {
    throw new RuntimeConfigBuildError("formRuntimeMismatch", "Runtime form does not describe Kimi");
  }
  const modelSource = input.definition.optionSources.model;
  if (modelSource?.kind !== "select") {
    throw new RuntimeConfigBuildError("optionSourcesInvalid", "Runtime form option sources are invalid");
  }
  const selected = modelSource.options.find((option) => option.value === input.model);
  if (!selected) throw new RuntimeConfigBuildError("selectValidModel", "Select a valid Kimi model");
  if (input.reasoningEffort !== null && !selected.supportedReasoningEfforts?.includes(input.reasoningEffort)) {
    throw new RuntimeConfigBuildError("selectValidReasoningEffort", "Select an effort supported by this model");
  }
  return {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "kimi-sdk",
    model: { kind: "preset", id: selected.value },
    mode: { kind: "default" },
    reasoningEffort: input.reasoningEffort,
    envVars: input.envVars,
  };
}
