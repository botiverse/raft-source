import {
  isBuiltInRuntimeCustomModelPresetProviderId,
  type AgentCreateFormOptionSource,
  type BuiltInRuntimeConfig,
  type RuntimeConfig,
  type RuntimeModelSourceOutcome,
} from "@botiverse/raft-shared";

/** A Built-in config on a preset provider (the selections the catalog vouches for). */
type BuiltInPresetConfig = BuiltInRuntimeConfig & {
  provider: Extract<BuiltInRuntimeConfig["provider"], { kind: "preset" }>;
};

export type BuiltInModelCatalogErrorCode =
  | "builtin_catalog_capability_required"
  | "builtin_custom_model_upgrade_required"
  | "builtin_catalog_unavailable"
  | "builtin_model_unsupported_by_target"
  | "builtin_catalog_stale";

export type BuiltInModelCatalogRecovery =
  | "upgrade_required"
  | "retry"
  | "upgrade_or_reselect";

export class BuiltInModelCatalogError extends Error {
  constructor(
    readonly code: BuiltInModelCatalogErrorCode,
    message: string,
    readonly details: {
      requestedModel?: string;
      daemonVersion: string | null;
      computerVersion: string | null;
      catalogRuntimeVersion?: string;
      recovery: BuiltInModelCatalogRecovery;
    },
  ) {
    super(message);
    this.name = "BuiltInModelCatalogError";
  }

  get requestedModel(): string | undefined {
    return this.details.requestedModel;
  }
  get daemonVersion(): string | null {
    return this.details.daemonVersion;
  }
  get computerVersion(): string | null {
    return this.details.computerVersion;
  }
  get catalogRuntimeVersion(): string | undefined {
    return this.details.catalogRuntimeVersion;
  }
  get recovery(): BuiltInModelCatalogRecovery {
    return this.details.recovery;
  }
}

export interface BuiltInModelCatalogTarget {
  machineId: string;
  daemonVersion: string | null;
  computerVersion: string | null;
}

export interface BuiltInModelCatalogValidation {
  machineId: string;
  requestedModel: string;
  daemonVersion: string | null;
  computerVersion: string | null;
  catalogRuntimeVersion: string;
  supportedModelIds: ReadonlySet<string>;
  /** task #10: preset providers this Computer runs a typed model id for; empty on older Computers. */
  customModelProviderIds: ReadonlySet<string>;
}

export type BuiltInCatalogRead = Omit<
  BuiltInModelCatalogValidation,
  "requestedModel"
>;

/**
 * A Built-in selection the target Computer's catalog must vouch for: a preset
 * model, or (task #10) a typed model on a preset provider that takes one
 * (OpenRouter). An older Computer's parser rejects the latter outright.
 */
export function isBuiltInCatalogCheckedSelection(config: RuntimeConfig): config is BuiltInPresetConfig {
  if (config.runtime !== "builtin" || config.provider.kind !== "preset") return false;
  return config.model.kind === "preset"
    || isBuiltInRuntimeCustomModelPresetProviderId(config.provider.providerId);
}

function builtInPresetSelectionKey(config: RuntimeConfig): string | null {
  if (!isBuiltInCatalogCheckedSelection(config)) return null;
  return config.model.kind === "preset"
    ? `${config.provider.providerId}\0${config.model.id}`
    : `${config.provider.providerId}\0custom\0${config.model.name}`;
}

/** Revalidate only a newly selected preset identity, not profile/reasoning/key-only edits. */
export function builtInPresetSelectionChanged(
  previous: RuntimeConfig,
  next: RuntimeConfig,
): boolean {
  const nextKey = builtInPresetSelectionKey(next);
  return nextKey !== null && nextKey !== builtInPresetSelectionKey(previous);
}

function unavailable(
  target: BuiltInModelCatalogTarget,
  requestedModel?: string,
): never {
  throw new BuiltInModelCatalogError(
    "builtin_catalog_unavailable",
    "The target Computer's Built-in model catalog is unavailable. Retry after the Computer reconnects.",
    {
      ...(requestedModel ? { requestedModel } : {}),
      daemonVersion: target.daemonVersion,
      computerVersion: target.computerVersion,
      recovery: "retry",
    },
  );
}

export function requireBuiltInCatalogCapability(
  outcome: RuntimeModelSourceOutcome,
  target: BuiltInModelCatalogTarget,
  requestedModel?: string,
): BuiltInCatalogRead {
  if (outcome.kind !== "live") unavailable(target, requestedModel);
  const catalog = outcome.value.catalog;
  if (
    catalog?.protocolVersion !== 1 ||
    catalog.runtime !== "builtin" ||
    !catalog.runtimeVersion.trim()
  ) {
    throw new BuiltInModelCatalogError(
      "builtin_catalog_capability_required",
      "This Computer is too old to prove which Built-in models it supports. Upgrade the Computer before selecting or starting this model.",
      {
        ...(requestedModel ? { requestedModel } : {}),
        daemonVersion: target.daemonVersion,
        computerVersion: target.computerVersion,
        recovery: "upgrade_required",
      },
    );
  }
  return {
    machineId: target.machineId,
    daemonVersion: target.daemonVersion,
    computerVersion: target.computerVersion,
    catalogRuntimeVersion: catalog.runtimeVersion,
    supportedModelIds: new Set(outcome.value.models.map((model) => model.id)),
    customModelProviderIds: new Set(
      Array.isArray(catalog.customModelProviderIds)
        ? catalog.customModelProviderIds.filter((id): id is string => typeof id === "string")
        : [],
    ),
  };
}

/** Validate only the closed Built-in preset namespace; gateways/connections are intentionally out of scope. */
export function assertBuiltInPresetSupportedByCatalog(
  config: RuntimeConfig,
  outcome: RuntimeModelSourceOutcome,
  target: BuiltInModelCatalogTarget,
): BuiltInModelCatalogValidation | null {
  if (!isBuiltInCatalogCheckedSelection(config)) return null;

  const requestedModel = config.model.kind === "preset" ? config.model.id : config.model.name;
  const catalog = requireBuiltInCatalogCapability(
    outcome,
    target,
    requestedModel,
  );
  const { supportedModelIds } = catalog;
  if (config.model.kind === "custom") {
    // task #10: only a Computer that says it runs a typed id on this provider
    // may get one; an older one would refuse the config at start.
    if (!catalog.customModelProviderIds.has(config.provider.providerId)) {
      throw new BuiltInModelCatalogError(
        "builtin_custom_model_upgrade_required",
        "This Computer is too old to run a model ID that is not in its list. Upgrade the Computer, or choose a model from the list.",
        {
          requestedModel,
          daemonVersion: target.daemonVersion,
          computerVersion: target.computerVersion,
          catalogRuntimeVersion: catalog.catalogRuntimeVersion,
          recovery: "upgrade_or_reselect",
        },
      );
    }
  } else if (!supportedModelIds.has(requestedModel)) {
    throw new BuiltInModelCatalogError(
      "builtin_model_unsupported_by_target",
      "The selected model is not supported by the target Computer. Upgrade the Computer or explicitly choose a supported model.",
      {
        requestedModel,
        daemonVersion: target.daemonVersion,
        computerVersion: target.computerVersion,
        catalogRuntimeVersion: catalog.catalogRuntimeVersion,
        recovery: "upgrade_or_reselect",
      },
    );
  }
  return {
    machineId: target.machineId,
    requestedModel,
    daemonVersion: catalog.daemonVersion,
    computerVersion: catalog.computerVersion,
    catalogRuntimeVersion: catalog.catalogRuntimeVersion,
    supportedModelIds,
    customModelProviderIds: catalog.customModelProviderIds,
  };
}

/** Filter only preset model options; provider/gateway topology and current persisted state live elsewhere. */
export function filterBuiltInPiFormOptionSourceForCatalog(
  source: AgentCreateFormOptionSource,
  supportedModelIds: ReadonlySet<string>,
  /** task #10: a preset provider keeps its typed-id field only when this Computer runs one. */
  customModelProviderIds: ReadonlySet<string> = new Set(),
): AgentCreateFormOptionSource {
  if (source.kind === "select" && source.pointer === "/providerId") {
    const options = source.options.filter(
      (option) =>
        option.providerKind === "gateway" ||
        [...supportedModelIds].some((modelId) =>
          modelId.startsWith(`${option.value}/`),
        ),
    );
    return {
      ...source,
      options,
      defaultValue: options.some(
        (option) => option.value === source.defaultValue,
      )
        ? source.defaultValue
        : (options[0]?.value ?? ""),
    };
  }
  if (source.kind !== "dependent_select" || source.pointer !== "/model")
    return source;
  const optionsByValue = Object.fromEntries(
    Object.entries(source.optionsByValue).flatMap(([providerId, options]) => {
      const filtered = options.filter((option) =>
        supportedModelIds.has(option.value),
      );
      return filtered.length > 0 ||
        source.customValueAllowedByValue[providerId] === true
        ? [[providerId, filtered]]
        : [];
    }),
  );
  const defaultValueByValue = Object.fromEntries(
    Object.entries(source.defaultValueByValue).flatMap(
      ([providerId, value]) => {
        const options = optionsByValue[providerId];
        return options?.length
          ? [
              [
                providerId,
                supportedModelIds.has(value) ? value : options[0]!.value,
              ],
            ]
          : [];
      },
    ),
  );
  const customValueAllowedByValue = Object.fromEntries(
    Object.entries(source.customValueAllowedByValue)
      .filter(([providerId]) => providerId in optionsByValue)
      .map(([providerId, allowed]) => [
        providerId,
        allowed &&
          (!isBuiltInRuntimeCustomModelPresetProviderId(providerId) ||
            customModelProviderIds.has(providerId)),
      ]),
  );
  return {
    ...source,
    optionsByValue,
    defaultValueByValue,
    customValueAllowedByValue,
  };
}
