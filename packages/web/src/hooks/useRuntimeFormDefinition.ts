import { useEffect, useMemo, useState } from "react";
import { KIMI_SDK_FORM_SCHEMA_VERSION } from "@botiverse/raft-shared";
import type {
  AgentCreateFormDefinition,
  AgentCreateFormOptionSource,
  AgentCreateFormOptionSourceRef,
  ResolvedAgentCreateFormDefinition,
  RuntimeFormDefinitionRef,
} from "@botiverse/raft-shared";
import api from "../api/client";
import { useServerStore } from "../store/serverStore";

const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function isBoundedOption(value: unknown, kind: "provider" | "model"): boolean {
  if (!isRecord(value)) return false;
  const allowed = kind === "provider"
    ? ["value", "label", "providerKind"]
    : ["value", "label", "supportedReasoningEfforts", "defaultReasoningEffort"];
  if (!exactKeys(value, allowed) || typeof value.value !== "string" || typeof value.label !== "string") return false;
  if (kind === "provider") return value.providerKind === "preset" || value.providerKind === "gateway";
  if (value.supportedReasoningEfforts !== undefined) {
    if (!isStringArray(value.supportedReasoningEfforts) || value.supportedReasoningEfforts.length === 0) return false;
    if (new Set(value.supportedReasoningEfforts).size !== value.supportedReasoningEfforts.length) return false;
    if (value.supportedReasoningEfforts.some((effort) => !effort || effort.trim() !== effort || effort.includes("\0"))) return false;
  }
  if (value.defaultReasoningEffort !== undefined) {
    if (typeof value.defaultReasoningEffort !== "string") return false;
    if (!value.supportedReasoningEfforts?.includes(value.defaultReasoningEffort)) return false;
  }
  return true;
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isBooleanMap(value: unknown): value is Record<string, boolean> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "boolean");
}

const sameStringSet = (left: readonly string[], right: readonly string[]) =>
  [...left].sort().join("\0") === [...right].sort().join("\0");

/** Fail-closed validator for the renderer's intentionally bounded protocol. */
export function parseAgentCreateFormDefinition(
  value: unknown,
  ref: RuntimeFormDefinitionRef,
): AgentCreateFormDefinition | null {
  if (!isRecord(value) || !exactKeys(value, [
    "protocolVersion", "runtimeId", "schemaVersion", "dataSchema", "uiSchema", "capabilities", "optionSources",
  ])) return null;
  if (value.protocolVersion !== ref.protocolVersion || value.runtimeId !== ref.runtimeId || value.schemaVersion !== ref.schemaVersion) return null;
  if (!isRecord(value.dataSchema) || !exactKeys(value.dataSchema, ["type", "additionalProperties", "required", "properties"])) return null;
  if (value.dataSchema.type !== "object" || value.dataSchema.additionalProperties !== false || !isStringArray(value.dataSchema.required) || !isRecord(value.dataSchema.properties)) return null;
  for (const field of Object.values(value.dataSchema.properties)) {
    if (!isRecord(field) || typeof field.title !== "string") return null;
    if (field.type === "string") {
      if (!exactKeys(field, ["type", "title", "minLength", "format", "writeOnly"])) return null;
      if (field.minLength !== undefined && typeof field.minLength !== "number") return null;
      if (field.format !== undefined && field.format !== "uri") return null;
      if (field.writeOnly !== undefined && typeof field.writeOnly !== "boolean") return null;
      // Secrets are input-only and can never carry a server default/value.
      if (field.writeOnly === true && ("default" in field || "value" in field)) return null;
    } else if (field.type === "object") {
      if (!exactKeys(field, ["type", "title", "additionalProperties"]) || !isRecord(field.additionalProperties)) return null;
      if (!exactKeys(field.additionalProperties, ["type"]) || field.additionalProperties.type !== "string") return null;
    } else if (field.type === "boolean") {
      if (!exactKeys(field, ["type", "title"])) return null;
    } else {
      return null;
    }
  }
  if (!isRecord(value.uiSchema) || !exactKeys(value.uiSchema, ["order", "layout", "visibility", "localization"])) return null;
  if (!isStringArray(value.uiSchema.order) || !isRecord(value.uiSchema.layout) || !exactKeys(value.uiSchema.layout, ["advanced"]) || !isStringArray(value.uiSchema.layout.advanced) || !Array.isArray(value.uiSchema.visibility) || !isRecord(value.uiSchema.localization)) return null;
  for (const rule of value.uiSchema.visibility) {
    if (!isRecord(rule) || !exactKeys(rule, ["pointer", "when"]) || typeof rule.pointer !== "string" || !isRecord(rule.when)) return null;
    if (!exactKeys(rule.when, ["pointer", "in"]) || typeof rule.when.pointer !== "string" || !isStringArray(rule.when.in)) return null;
  }
  for (const localized of Object.values(value.uiSchema.localization)) {
    if (!isRecord(localized) || !exactKeys(localized, ["label", "hint", "placeholder"]) || typeof localized.label !== "string") return null;
    if (localized.hint !== undefined && typeof localized.hint !== "string") return null;
    if (localized.placeholder !== undefined && typeof localized.placeholder !== "string") return null;
  }
  if (!isRecord(value.capabilities) || !exactKeys(value.capabilities, ["providerKinds", "writeOnlyPointers", "forbiddenPointers"])) return null;
  if (!isStringArray(value.capabilities.providerKinds) || value.capabilities.providerKinds.some((kind) => kind !== "preset" && kind !== "gateway")) return null;
  if (!isStringArray(value.capabilities.writeOnlyPointers)) return null;
  if (!isStringArray(value.capabilities.forbiddenPointers) || !value.capabilities.forbiddenPointers.includes("/hostUserState")) return null;
  if (!isRecord(value.optionSources)) return null;
  for (const source of Object.values(value.optionSources)) {
    if (!isRecord(source)) return null;
    const common = ["protocolVersion", "runtimeId", "schemaVersion", "sourceId", "pointer", "kind"];
    const allowed = source.kind === "select"
      ? common
      : source.kind === "dependent_select"
        ? [...common, "dependsOn"]
        : [];
    if (allowed.length === 0 || !exactKeys(source, allowed)) return null;
    if (source.protocolVersion !== ref.protocolVersion || source.runtimeId !== ref.runtimeId || source.schemaVersion !== ref.schemaVersion) return null;
    if (typeof source.sourceId !== "string" || typeof source.pointer !== "string") return null;
    if (source.kind === "dependent_select" && typeof source.dependsOn !== "string") return null;
  }
  if (ref.runtimeId === "kimi-sdk") {
    if (ref.schemaVersion !== KIMI_SDK_FORM_SCHEMA_VERSION) return null;
    const expectedProperties = ["model", "reasoningEffort", "envVars"];
    if (!exactKeys(value.dataSchema.properties, expectedProperties)) return null;
    if (!sameStringSet(value.dataSchema.required, ["model"])) return null;
    const properties = value.dataSchema.properties as Record<string, Record<string, unknown>>;
    if (properties.model?.type !== "string" || properties.reasoningEffort?.type !== "string" || properties.envVars?.type !== "object") return null;
    if (!sameStringSet(value.uiSchema.order, expectedProperties)) return null;
    if (!sameStringSet(value.uiSchema.layout.advanced, ["/envVars"]) || value.uiSchema.visibility.length !== 0) return null;
    if (value.capabilities.providerKinds.length !== 0 || value.capabilities.writeOnlyPointers.length !== 0) return null;
    if (!sameStringSet(value.capabilities.forbiddenPointers, ["/hostUserState"])) return null;
    if (!exactKeys(value.optionSources, ["model"])) return null;
    const modelSource = value.optionSources.model;
    if (!isRecord(modelSource) || modelSource.kind !== "select" || modelSource.sourceId !== "model" || modelSource.pointer !== "/model") return null;
    return value as unknown as AgentCreateFormDefinition;
  }
  // Protocol v1 supports exact, version-pinned Built-in Pi topologies. This keeps a
  // new Web client compatible with a v1 server while ensuring the v2 image
  // capability cannot be silently added to or removed from either schema.
  const imageInputTopology = ref.schemaVersion === "builtin-pi.create.v2";
  if (!imageInputTopology && ref.schemaVersion !== "builtin-pi.create.v1") return null;
  const expectedProperties = imageInputTopology
    ? ["providerId", "apiKey", "baseUrl", "supportsImageInput", "model", "envVars"]
    : ["providerId", "apiKey", "baseUrl", "model", "envVars"];
  if (!exactKeys(value.dataSchema.properties, expectedProperties)) return null;
  if (!sameStringSet(value.dataSchema.required, ["providerId", "apiKey", "model"])) return null;
  const properties = value.dataSchema.properties as Record<string, Record<string, unknown>>;
  const providerIdSchema = properties.providerId;
  const apiKeySchema = properties.apiKey;
  const baseUrlSchema = properties.baseUrl;
  const supportsImageInputSchema = properties.supportsImageInput;
  const modelSchema = properties.model;
  const envVarsSchema = properties.envVars;
  if (providerIdSchema?.type !== "string" || apiKeySchema?.type !== "string" || baseUrlSchema?.type !== "string" || modelSchema?.type !== "string" || envVarsSchema?.type !== "object") return null;
  if (imageInputTopology && supportsImageInputSchema?.type !== "boolean") return null;
  if (apiKeySchema.writeOnly !== true || providerIdSchema.writeOnly === true || baseUrlSchema.writeOnly === true || modelSchema.writeOnly === true) return null;
  if (baseUrlSchema.format !== "uri") return null;
  if (!sameStringSet(value.uiSchema.order, expectedProperties)) return null;
  if (!sameStringSet(value.uiSchema.layout.advanced, ["/envVars"])) return null;
  if (value.uiSchema.visibility.length !== (imageInputTopology ? 2 : 1)) return null;
  const baseUrlVisibility = value.uiSchema.visibility.find((rule) => rule.pointer === "/baseUrl");
  if (baseUrlVisibility?.pointer !== "/baseUrl" || baseUrlVisibility.when.pointer !== "/providerId") return null;
  if (imageInputTopology) {
    const imageInputVisibility = value.uiSchema.visibility.find((rule) => rule.pointer === "/supportsImageInput");
    if (imageInputVisibility?.when.pointer !== "/providerId") return null;
  }
  if (!sameStringSet(value.capabilities.providerKinds, ["preset", "gateway"])) return null;
  if (!sameStringSet(value.capabilities.writeOnlyPointers, ["/apiKey"])) return null;
  if (!sameStringSet(value.capabilities.forbiddenPointers, ["/hostUserState"])) return null;
  if (!exactKeys(value.optionSources, ["provider", "model"])) return null;
  const providerSource = value.optionSources.provider;
  const modelSource = value.optionSources.model;
  if (!isRecord(providerSource) || providerSource.kind !== "select" || !isRecord(modelSource) || modelSource.kind !== "dependent_select") return null;
  if (providerSource.sourceId !== "provider" || providerSource.pointer !== "/providerId") return null;
  if (modelSource.sourceId !== "model" || modelSource.pointer !== "/model" || modelSource.dependsOn !== "/providerId") return null;
  return value as unknown as AgentCreateFormDefinition;
}

export function parseAgentCreateFormOptionSource(
  value: unknown,
  ref: AgentCreateFormOptionSourceRef,
): AgentCreateFormOptionSource | null {
  if (!isRecord(value)) return null;
  const common = ["protocolVersion", "runtimeId", "schemaVersion", "sourceId", "pointer", "kind"];
  const allowed = ref.kind === "select"
    ? [...common, "options", "defaultValue"]
    : [...common, "dependsOn", "optionsByValue", "defaultValueByValue", "customValueAllowedByValue"];
  if (!exactKeys(value, allowed)) return null;
  if (
    value.protocolVersion !== ref.protocolVersion
    || value.runtimeId !== ref.runtimeId
    || value.schemaVersion !== ref.schemaVersion
    || value.sourceId !== ref.sourceId
    || value.pointer !== ref.pointer
    || value.kind !== ref.kind
  ) return null;
  if (ref.kind === "select") {
    const optionKind = ref.pointer === "/providerId" ? "provider" : "model";
    if (!Array.isArray(value.options) || !value.options.every((option) => isBoundedOption(option, optionKind))) return null;
    if (typeof value.defaultValue !== "string") return null;
  } else {
    if (value.dependsOn !== ref.dependsOn || !isRecord(value.optionsByValue)) return null;
    if (!Object.values(value.optionsByValue).every(
      (options) => Array.isArray(options) && options.every((option) => isBoundedOption(option, "model")),
    )) return null;
    if (!isStringMap(value.defaultValueByValue) || !isBooleanMap(value.customValueAllowedByValue)) return null;
  }
  return value as unknown as AgentCreateFormOptionSource;
}

export function resolveAgentCreateFormDefinition(
  definition: AgentCreateFormDefinition,
  sources: Record<string, AgentCreateFormOptionSource>,
): ResolvedAgentCreateFormDefinition | null {
  if (definition.runtimeId === "kimi-sdk") {
    if (!exactKeys(sources, ["model"])) return null;
    const modelSource = sources.model;
    const modelRef = definition.optionSources.model;
    if (!modelSource || modelSource.kind !== "select" || !modelRef || modelRef.kind !== "select") return null;
    if (modelSource.sourceId !== modelRef.sourceId || modelSource.pointer !== modelRef.pointer) return null;
    const modelIds = modelSource.options.map((option) => option.value);
    if (modelIds.length === 0 || new Set(modelIds).size !== modelIds.length || !modelIds.includes(modelSource.defaultValue)) return null;
    return { ...definition, optionSources: sources };
  }
  if (!exactKeys(sources, ["provider", "model"])) return null;
  const providerSource = sources.provider;
  const modelSource = sources.model;
  if (providerSource?.kind !== "select" || modelSource?.kind !== "dependent_select") return null;
  const providerRef = definition.optionSources.provider;
  const modelRef = definition.optionSources.model;
  if (!providerRef || !modelRef || providerRef.kind !== "select" || modelRef.kind !== "dependent_select") return null;
  if (
    providerSource.sourceId !== providerRef.sourceId
    || providerSource.pointer !== providerRef.pointer
    || modelSource.sourceId !== modelRef.sourceId
    || modelSource.pointer !== modelRef.pointer
    || modelSource.dependsOn !== modelRef.dependsOn
  ) return null;
  const providerOptions = providerSource.options as Array<{ value: string; providerKind: "preset" | "gateway" }>;
  const providerIds = providerOptions.map((option) => option.value);
  if (providerIds.length === 0 || new Set(providerIds).size !== providerIds.length || !providerIds.includes(providerSource.defaultValue as string)) return null;
  const baseUrlVisibility = definition.uiSchema.visibility.find((rule) => rule.pointer === "/baseUrl");
  if (!baseUrlVisibility) return null;
  const gatewayProviderIds = providerOptions.filter((option) => option.providerKind === "gateway").map((option) => option.value);
  if (!sameStringSet(baseUrlVisibility.when.in, gatewayProviderIds)) return null;
  if ("supportsImageInput" in definition.dataSchema.properties) {
    const imageInputVisibility = definition.uiSchema.visibility.find((rule) => rule.pointer === "/supportsImageInput");
    if (!imageInputVisibility || !sameStringSet(imageInputVisibility.when.in, gatewayProviderIds)) return null;
  }
  const optionsByValue = modelSource.optionsByValue as Record<string, Array<{ value: string }>>;
  const defaultValueByValue = modelSource.defaultValueByValue as Record<string, string>;
  const customValueAllowedByValue = modelSource.customValueAllowedByValue as Record<string, boolean>;
  if (!sameStringSet(Object.keys(optionsByValue), providerIds) || !sameStringSet(Object.keys(customValueAllowedByValue), providerIds)) return null;
  const presetIds = providerOptions.filter((option) => option.providerKind === "preset").map((option) => option.value);
  if (!sameStringSet(Object.keys(defaultValueByValue), presetIds)) return null;
  for (const option of providerOptions) {
    const models = optionsByValue[option.value] ?? [];
    const modelIds = models.map((model) => model.value);
    if (new Set(modelIds).size !== modelIds.length) return null;
    if (option.providerKind === "preset") {
      if (customValueAllowedByValue[option.value] !== false || models.length === 0 || !modelIds.includes(defaultValueByValue[option.value]!)) return null;
    } else if (customValueAllowedByValue[option.value] !== true || models.length !== 0 || option.value in defaultValueByValue) {
      return null;
    }
  }
  return { ...definition, optionSources: sources };
}

type FormDefinitionCatalogEntry = {
  definition: ResolvedAgentCreateFormDefinition | null;
  error: boolean;
  errorCode?: string;
};

type FormDefinitionCatalogState = {
  requestKey: string;
  entries: Record<string, FormDefinitionCatalogEntry>;
  loading: boolean;
};

export function runtimeFormDefinitionRefKey(ref: RuntimeFormDefinitionRef): string {
  return `${ref.protocolVersion}\0${ref.runtimeId}\0${ref.schemaVersion}`;
}

async function loadRuntimeFormDefinition(
  serverId: string,
  machineId: string,
  ref: RuntimeFormDefinitionRef,
): Promise<ResolvedAgentCreateFormDefinition | null> {
  const definitionPath = `/servers/${serverId}/machines/${machineId}/runtime-form-definitions/${encodeURIComponent(ref.runtimeId)}`;
  const path = `${definitionPath}?schemaVersion=${encodeURIComponent(ref.schemaVersion)}`;
  const { data } = await api.get(path);
  const definition = parseAgentCreateFormDefinition(data, ref);
  if (!definition) return null;
  const sourceEntries = await Promise.all(Object.entries(definition.optionSources).map(async ([key, sourceRef]) => {
    const sourcePath = `${definitionPath}/option-sources/${encodeURIComponent(sourceRef.sourceId)}?schemaVersion=${encodeURIComponent(ref.schemaVersion)}`;
    const { data: sourceData } = await api.get(sourcePath);
    const source = parseAgentCreateFormOptionSource(sourceData, sourceRef);
    if (!source) throw new Error("Invalid runtime form option source");
    return [key, source] as const;
  }));
  return resolveAgentCreateFormDefinition(definition, Object.fromEntries(sourceEntries));
}

/**
 * Preloads every version-pinned create form (and its typed option sources) for
 * the selected computer. Runtime selection can then switch only local state;
 * changing computers creates one new catalog request set for that computer.
 */
export function useRuntimeFormDefinitionCatalog(
  machineId: string | null | undefined,
  refs: readonly RuntimeFormDefinitionRef[],
) {
  const serverId = useServerStore((state) => state.current?.id);
  const uniqueRefs = useMemo(() => {
    const byKey = new Map<string, RuntimeFormDefinitionRef>();
    for (const ref of refs) byKey.set(runtimeFormDefinitionRefKey(ref), ref);
    return [...byKey.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, ref]) => ref);
  }, [refs]);
  const refsKey = uniqueRefs.map(runtimeFormDefinitionRefKey).join("\x01");
  const requestKey = serverId && machineId && refsKey
    ? `${serverId}\0${machineId}\0${refsKey}`
    : "";
  const [state, setState] = useState<FormDefinitionCatalogState>({ requestKey: "", entries: {}, loading: false });

  // Async request state is a single coherent snapshot; each branch replaces
  // the whole object rather than chaining independent domain state.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (!serverId || !machineId || uniqueRefs.length === 0) return;
    let cancelled = false;
    setState({ requestKey, entries: {}, loading: true });
    void Promise.all(uniqueRefs.map(async (ref) => {
      const key = runtimeFormDefinitionRefKey(ref);
      try {
        const definition = await loadRuntimeFormDefinition(serverId, machineId, ref);
        return [key, { definition, error: definition === null }] as const;
      } catch (error) {
        const code = (error as { response?: { data?: { code?: unknown } } })
          .response?.data?.code;
        return [
          key,
          {
            definition: null,
            error: true,
            ...(typeof code === "string" ? { errorCode: code } : {}),
          },
        ] as const;
      }
    })).then((entries) => {
      if (!cancelled) setState({ requestKey, entries: Object.fromEntries(entries), loading: false });
    });
    return () => { cancelled = true; };
  }, [machineId, requestKey, serverId, uniqueRefs]);

  if (!requestKey) return { entries: {}, loading: false };
  if (state.requestKey !== requestKey) return { entries: {}, loading: true };
  return { entries: state.entries, loading: state.loading };
}
