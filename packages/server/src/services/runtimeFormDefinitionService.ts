import {
  BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS,
  BUILTIN_RUNTIME_PROVIDER_ENV_KEYS,
  getRuntimeProviderDisplayName,
  PI_BUILTIN_PROVIDER_DEFAULT_MODELS,
  PI_BUILTIN_PROVIDER_MODELS,
  RUNTIME_CONFIG_VERSION,
  KIMI_SDK_FORM_DEFINITION_REF,
  KIMI_SDK_FORM_SCHEMA_VERSION,
  parseRuntimeConfig,
  type AgentCreateFormDefinition,
  type AgentCreateFormIssue,
  type AgentCreateFormOptionSource,
  type ResolvedAgentCreateFormDefinition,
  type RuntimeModelInfo,
  type RuntimeFormDefinitionRef,
} from "@botiverse/raft-shared";

export const BUILTIN_PI_FORM_SCHEMA_VERSION = "builtin-pi.create.v2";
export const BUILTIN_PI_FORM_DEFINITION_REF: RuntimeFormDefinitionRef = {
  protocolVersion: 1,
  runtimeId: "builtin",
  schemaVersion: BUILTIN_PI_FORM_SCHEMA_VERSION,
};

export { KIMI_SDK_FORM_DEFINITION_REF, KIMI_SDK_FORM_SCHEMA_VERSION };

const FORM_DEFINITION_REFS = new Map<string, RuntimeFormDefinitionRef>([
  [BUILTIN_PI_FORM_DEFINITION_REF.runtimeId, BUILTIN_PI_FORM_DEFINITION_REF],
  [KIMI_SDK_FORM_DEFINITION_REF.runtimeId, KIMI_SDK_FORM_DEFINITION_REF],
]);

const presetProviderIds = Object.keys(BUILTIN_RUNTIME_PROVIDER_ENV_KEYS);
const gatewayProviderIds = Object.keys(BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS);
const allProviderIds = [...presetProviderIds, ...gatewayProviderIds];

export function buildBuiltInPiFormDefinition(): AgentCreateFormDefinition {
  const ref = BUILTIN_PI_FORM_DEFINITION_REF;
  return {
    ...ref,
    dataSchema: {
      type: "object",
      additionalProperties: false,
      required: ["providerId", "apiKey", "model"],
      properties: {
        providerId: { type: "string", title: "Provider", minLength: 1 },
        apiKey: { type: "string", title: "API Key", minLength: 1, writeOnly: true },
        baseUrl: { type: "string", title: "Base URL", minLength: 1, format: "uri" },
        supportsImageInput: { type: "boolean", title: "Image input" },
        model: { type: "string", title: "Model", minLength: 1 },
        envVars: { type: "object", title: "Environment Variables", additionalProperties: { type: "string" } },
      },
    },
    uiSchema: {
      order: ["providerId", "apiKey", "baseUrl", "supportsImageInput", "model", "envVars"],
      layout: { advanced: ["/envVars"] },
      visibility: [
        {
          pointer: "/baseUrl",
          when: { pointer: "/providerId", in: gatewayProviderIds },
        },
        {
          pointer: "/supportsImageInput",
          when: { pointer: "/providerId", in: gatewayProviderIds },
        },
      ],
      localization: {
        providerId: {
          label: "Provider",
          hint: "Built-in Pi is ready to use without local runtime setup. It uses the provider key entered here.",
        },
        apiKey: { label: "API Key", placeholder: "sk-..." },
        baseUrl: { label: "Base URL", placeholder: "https://gateway.example.com/v1" },
        supportsImageInput: {
          label: "Supports image input",
          hint: "Enable only when this gateway endpoint and model accept images.",
        },
        model: { label: "Model", placeholder: "Model ID" },
        envVars: {
          label: "Environment Variables",
          hint: "These will be injected into the runtime command environment.",
        },
      },
    },
    capabilities: {
      providerKinds: ["preset", "gateway"],
      writeOnlyPointers: ["/apiKey"],
      forbiddenPointers: ["/hostUserState"],
    },
    optionSources: {
      provider: {
        ...ref,
        sourceId: "provider",
        kind: "select",
        pointer: "/providerId",
      },
      model: {
        ...ref,
        sourceId: "model",
        kind: "dependent_select",
        pointer: "/model",
        dependsOn: "/providerId",
      },
    },
  };
}

export function buildBuiltInPiFormOptionSource(sourceId: string): AgentCreateFormOptionSource | null {
  const ref = BUILTIN_PI_FORM_DEFINITION_REF;
  if (sourceId === "provider") {
    return {
      ...ref,
      sourceId,
      kind: "select",
      pointer: "/providerId",
      options: allProviderIds.map((providerId) => ({
        value: providerId,
        label: getRuntimeProviderDisplayName(providerId),
        providerKind: gatewayProviderIds.includes(providerId) ? "gateway" : "preset",
      })),
      defaultValue: presetProviderIds[0] ?? "deepseek",
    };
  }
  if (sourceId === "model") {
    return {
      ...ref,
      sourceId,
      kind: "dependent_select",
      pointer: "/model",
      dependsOn: "/providerId",
      optionsByValue: Object.fromEntries(allProviderIds.map((providerId) => [
        providerId,
        gatewayProviderIds.includes(providerId)
          ? []
          : (PI_BUILTIN_PROVIDER_MODELS[providerId] ?? []).map((model) => ({ value: model.id, label: model.label })),
      ])),
      defaultValueByValue: Object.fromEntries(presetProviderIds.map((providerId) => [
        providerId,
        PI_BUILTIN_PROVIDER_DEFAULT_MODELS[providerId as keyof typeof PI_BUILTIN_PROVIDER_DEFAULT_MODELS] ?? "",
      ])),
      customValueAllowedByValue: Object.fromEntries(allProviderIds.map((providerId) => [
        providerId,
        gatewayProviderIds.includes(providerId),
      ])),
    };
  }
  return null;
}

export function buildBuiltInPiResolvedFormDefinition(): ResolvedAgentCreateFormDefinition {
  const definition = buildBuiltInPiFormDefinition();
  return {
    ...definition,
    optionSources: {
      provider: buildBuiltInPiFormOptionSource("provider")!,
      model: buildBuiltInPiFormOptionSource("model")!,
    },
  };
}

export function buildKimiSdkFormDefinition(): AgentCreateFormDefinition {
  const ref = KIMI_SDK_FORM_DEFINITION_REF;
  return {
    ...ref,
    dataSchema: {
      type: "object",
      additionalProperties: false,
      required: ["model"],
      properties: {
        model: { type: "string", title: "Model", minLength: 1 },
        reasoningEffort: { type: "string", title: "Thinking effort", minLength: 1 },
        envVars: { type: "object", title: "Environment Variables", additionalProperties: { type: "string" } },
      },
    },
    uiSchema: {
      order: ["model", "reasoningEffort", "envVars"],
      layout: { advanced: ["/envVars"] },
      visibility: [],
      localization: {
        model: { label: "Model", hint: "Models available from this computer's Kimi configuration." },
        reasoningEffort: { label: "Thinking effort", hint: "Available values are declared by the selected model." },
        envVars: {
          label: "Environment Variables",
          hint: "These will be injected into the runtime command environment.",
        },
      },
    },
    capabilities: {
      providerKinds: [],
      writeOnlyPointers: [],
      forbiddenPointers: ["/hostUserState"],
    },
    optionSources: {
      model: {
        ...ref,
        sourceId: "model",
        kind: "select",
        pointer: "/model",
      },
    },
  };
}

function validEfforts(values: readonly string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const normalized = [...new Set(values.filter((value) => value.length > 0 && value.trim() === value && !value.includes("\0")))];
  return normalized.length > 0 ? normalized : undefined;
}

export function buildKimiSdkFormOptionSource(input: {
  models: readonly RuntimeModelInfo[];
  defaultModel?: string;
}): AgentCreateFormOptionSource {
  const options = input.models.map((model) => {
    const supportedReasoningEfforts = validEfforts(model.supportedReasoningEfforts);
    const defaultReasoningEffort = supportedReasoningEfforts?.includes(model.defaultReasoningEffort ?? "")
      ? model.defaultReasoningEffort
      : undefined;
    return {
      value: model.id,
      label: model.label,
      ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    };
  });
  const optionIds = new Set(options.map((option) => option.value));
  return {
    ...KIMI_SDK_FORM_DEFINITION_REF,
    sourceId: "model",
    kind: "select",
    pointer: "/model",
    options,
    defaultValue: input.defaultModel && optionIds.has(input.defaultModel)
      ? input.defaultModel
      : (options[0]?.value ?? ""),
  };
}

export function validateKimiSdkSelection(input: {
  source: AgentCreateFormOptionSource;
  model: string;
  reasoningEffort: string | null;
}): AgentCreateFormIssue[] {
  if (input.source.kind !== "select" || input.source.sourceId !== "model") {
    return [{ code: "definition_option_source_invalid", pointer: "/optionSources/model" }];
  }
  const selected = input.source.options.find((option) => option.value === input.model);
  if (!selected) return [{ code: "invalid_option", pointer: "/runtimeConfig/model" }];
  if (input.reasoningEffort !== null && !selected.supportedReasoningEfforts?.includes(input.reasoningEffort)) {
    return [{ code: "invalid_option", pointer: "/runtimeConfig/reasoningEffort" }];
  }
  return [];
}

export function validateKimiSdkDefinitionProjection(
  definition: AgentCreateFormDefinition = buildKimiSdkFormDefinition(),
): AgentCreateFormIssue[] {
  const source = definition.optionSources.model;
  if (
    definition.runtimeId !== KIMI_SDK_FORM_DEFINITION_REF.runtimeId
    || definition.schemaVersion !== KIMI_SDK_FORM_DEFINITION_REF.schemaVersion
    || !source
    || source.kind !== "select"
    || source.sourceId !== "model"
    || source.pointer !== "/model"
    || Object.keys(definition.optionSources).length !== 1
  ) {
    return [{ code: "definition_option_source_topology_drift", pointer: "/optionSources" }];
  }
  const properties = definition.dataSchema.properties;
  if (
    Object.keys(properties).sort().join("\0") !== ["envVars", "model", "reasoningEffort"].join("\0")
    || properties.model?.type !== "string"
    || properties.reasoningEffort?.type !== "string"
    || properties.envVars?.type !== "object"
    || definition.dataSchema.required.join("\0") !== "model"
  ) {
    return [{ code: "definition_data_schema_drift", pointer: "/dataSchema" }];
  }
  return [];
}

export function validateRuntimeFormDefinitionRef(value: unknown): AgentCreateFormIssue[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [{ code: "form_definition_ref_required", pointer: "/formDefinitionRef" }];
  }
  const ref = value as Record<string, unknown>;
  if (ref.protocolVersion !== 1) {
    return [{ code: "unsupported_form_protocol", pointer: "/formDefinitionRef/protocolVersion" }];
  }
  const registered = typeof ref.runtimeId === "string" ? FORM_DEFINITION_REFS.get(ref.runtimeId) : undefined;
  if (!registered) {
    return [{ code: "unknown_form_runtime", pointer: "/formDefinitionRef/runtimeId" }];
  }
  if (ref.schemaVersion !== registered.schemaVersion) {
    return [{ code: "stale_form_schema", pointer: "/formDefinitionRef/schemaVersion" }];
  }
  const knownKeys = new Set(["protocolVersion", "runtimeId", "schemaVersion"]);
  if (Object.keys(ref).some((key) => !knownKeys.has(key))) {
    return [{ code: "unknown_form_ref_field", pointer: "/formDefinitionRef" }];
  }
  return [];
}

export function runtimeConfigIssue(error: string): AgentCreateFormIssue {
  if (error.includes("hostUserState")) return { code: "forbidden_field", pointer: "/runtimeConfig/hostUserState" };
  if (error.includes("unknown fields")) return { code: "unknown_field", pointer: "/runtimeConfig" };
  if (error.includes("provider.apiKey")) return { code: "required", pointer: "/runtimeConfig/provider/apiKey" };
  if (error.includes("provider.baseUrl")) return { code: "invalid", pointer: "/runtimeConfig/provider/baseUrl" };
  if (error.includes("provider.supportsImageInput")) return { code: "invalid", pointer: "/runtimeConfig/provider/supportsImageInput" };
  if (error.includes("provider.providerId")) return { code: "invalid_option", pointer: "/runtimeConfig/provider/providerId" };
  if (error.includes("runtimeConfig.model")) return { code: "invalid_option", pointer: "/runtimeConfig/model" };
  return { code: "invalid_runtime_config", pointer: "/runtimeConfig" };
}

/**
 * Mutation tooth: the served projection must stay bidirectionally aligned with
 * the strict parser/registry. A changed provider/model catalog makes this fail.
 */
export function validateBuiltInPiDefinitionProjection(
  definition: ResolvedAgentCreateFormDefinition = buildBuiltInPiResolvedFormDefinition(),
  sourceRefs: AgentCreateFormDefinition = buildBuiltInPiFormDefinition(),
): AgentCreateFormIssue[] {
  const issues: AgentCreateFormIssue[] = [];
  const providerSource = definition.optionSources.provider;
  const modelSource = definition.optionSources.model;
  if (providerSource?.kind !== "select" || modelSource?.kind !== "dependent_select") {
    return [{ code: "definition_option_source_invalid", pointer: "/optionSources" }];
  }
  const providerRef = sourceRefs.optionSources.provider;
  const modelRef = sourceRefs.optionSources.model;
  if (
    providerRef?.kind !== "select"
    || modelRef?.kind !== "dependent_select"
    || providerRef.protocolVersion !== definition.protocolVersion
    || providerRef.runtimeId !== definition.runtimeId
    || providerRef.schemaVersion !== definition.schemaVersion
    || providerSource.protocolVersion !== providerRef.protocolVersion
    || providerSource.runtimeId !== providerRef.runtimeId
    || providerSource.schemaVersion !== providerRef.schemaVersion
    || providerRef.sourceId !== providerSource.sourceId
    || providerRef.pointer !== providerSource.pointer
    || modelRef.protocolVersion !== definition.protocolVersion
    || modelRef.runtimeId !== definition.runtimeId
    || modelRef.schemaVersion !== definition.schemaVersion
    || modelSource.protocolVersion !== modelRef.protocolVersion
    || modelSource.runtimeId !== modelRef.runtimeId
    || modelSource.schemaVersion !== modelRef.schemaVersion
    || modelRef.sourceId !== modelSource.sourceId
    || modelRef.pointer !== modelSource.pointer
    || modelRef.dependsOn !== modelSource.dependsOn
  ) {
    issues.push({ code: "definition_option_source_ref_drift", pointer: "/optionSources" });
  }
  if (
    providerSource.sourceId !== "provider"
    || providerSource.pointer !== "/providerId"
    || modelSource.sourceId !== "model"
    || modelSource.pointer !== "/model"
    || modelSource.dependsOn !== "/providerId"
  ) {
    issues.push({ code: "definition_option_source_topology_drift", pointer: "/optionSources" });
  }
  const imageInputSchema = definition.dataSchema.properties.supportsImageInput;
  const baseUrlVisibility = definition.uiSchema.visibility.find((rule) => rule.pointer === "/baseUrl");
  const imageInputVisibility = definition.uiSchema.visibility.find((rule) => rule.pointer === "/supportsImageInput");
  if (
    imageInputSchema?.type !== "boolean"
    || !baseUrlVisibility
    || baseUrlVisibility.when.pointer !== "/providerId"
    || baseUrlVisibility.when.in.slice().sort().join("\0") !== [...gatewayProviderIds].sort().join("\0")
    || !imageInputVisibility
    || imageInputVisibility.when.pointer !== "/providerId"
    || imageInputVisibility.when.in.slice().sort().join("\0") !== [...gatewayProviderIds].sort().join("\0")
  ) {
    issues.push({ code: "definition_image_input_topology_drift", pointer: "/dataSchema/properties/supportsImageInput" });
  }
  const servedProviderIds = providerSource.options.map((option) => option.value).sort();
  if (servedProviderIds.join("\0") !== [...allProviderIds].sort().join("\0")) {
    issues.push({ code: "definition_provider_registry_drift", pointer: "/optionSources/provider/options" });
  }
  for (const option of providerSource.options) {
    const expectedKind = gatewayProviderIds.includes(option.value) ? "gateway" : "preset";
    if (option.providerKind !== expectedKind) {
      issues.push({
        code: "definition_provider_kind_registry_drift",
        pointer: `/optionSources/provider/options/${option.value}/providerKind`,
      });
    }
  }
  for (const providerId of presetProviderIds) {
    const servedModels = modelSource.optionsByValue[providerId] ?? [];
    const servedModelIds = servedModels.map((option) => option.value).sort();
    const registryModelIds = (PI_BUILTIN_PROVIDER_MODELS[providerId] ?? []).map((model) => model.id).sort();
    if (servedModelIds.join("\0") !== registryModelIds.join("\0")) {
      issues.push({ code: "definition_model_registry_drift", pointer: `/optionSources/model/optionsByValue/${providerId}` });
      continue;
    }
    const registryDefault = PI_BUILTIN_PROVIDER_DEFAULT_MODELS[
      providerId as keyof typeof PI_BUILTIN_PROVIDER_DEFAULT_MODELS
    ] ?? "";
    if (modelSource.defaultValueByValue[providerId] !== registryDefault || !servedModelIds.includes(registryDefault)) {
      issues.push({
        code: "definition_default_model_registry_drift",
        pointer: `/optionSources/model/defaultValueByValue/${providerId}`,
      });
    }
    if (modelSource.customValueAllowedByValue[providerId] !== false) {
      issues.push({
        code: "definition_preset_custom_model_drift",
        pointer: `/optionSources/model/customValueAllowedByValue/${providerId}`,
      });
    }
    for (const model of servedModels) {
      const parsed = parseRuntimeConfig({
        runtimeConfig: {
          version: RUNTIME_CONFIG_VERSION,
          runtime: "builtin",
          provider: { kind: "preset", providerId, apiKey: "projection-check" },
          model: { kind: "preset", id: model.value },
          mode: { kind: "default" },
          reasoningEffort: null,
          envVars: null,
        },
      });
      if (!parsed.ok) {
        issues.push({ code: "definition_parser_drift", pointer: `/optionSources/model/optionsByValue/${providerId}` });
        break;
      }
    }
  }
  for (const providerId of gatewayProviderIds) {
    if ((modelSource.optionsByValue[providerId] ?? []).length !== 0 || providerId in modelSource.defaultValueByValue) {
      issues.push({
        code: "definition_gateway_model_policy_drift",
        pointer: `/optionSources/model/optionsByValue/${providerId}`,
      });
    }
    if (modelSource.customValueAllowedByValue[providerId] !== true) {
      issues.push({ code: "definition_gateway_custom_model_drift", pointer: `/optionSources/model/customValueAllowedByValue/${providerId}` });
    }
  }
  return issues;
}
