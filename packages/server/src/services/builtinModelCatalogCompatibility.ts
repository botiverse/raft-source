import {
  isBuiltInRuntimeConfigMissingProvider,
  isBuiltInRuntimeCustomModelPresetProviderId,
  PI_BUILTIN_PROVIDER_MODELS,
  type AgentCreateFormOptionSource,
  type RuntimeConfig,
  type RuntimeModelConfig,
  type RuntimeModelSourceOutcome,
} from "@botiverse/raft-shared";

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
 * A Built-in selection the target Computer's catalog must vouch for, with the
 * preset provider it runs on: a preset model, or (task #10) a typed model on a
 * preset provider that takes one (OpenRouter, Qwen Token Plan, ...). An older
 * Computer's parser rejects a typed model outright. A gateway is not checked
 * here.
 */
export interface BuiltInCatalogSelection {
  providerId: string;
  model: RuntimeModelConfig;
  /** Identity for "did the selection change" (builtInPresetSelectionChanged). */
  key: string;
}

export function builtInCatalogSelection(config: RuntimeConfig): BuiltInCatalogSelection | null {
  if (config.runtime !== "builtin") return null;
  // A Built-in row that lost its provider (lenient hydration) has no provider
  // to check a model against; reading it must not throw (a settings save that
  // adds the provider compares against the stored config here).
  if (isBuiltInRuntimeConfigMissingProvider(config)) return null;
  const { provider, model } = config;
  if (provider.kind === "preset") {
    if (model.kind !== "preset" && !isBuiltInRuntimeCustomModelPresetProviderId(provider.providerId)) return null;
    return {
      providerId: provider.providerId,
      model,
      key: model.kind === "preset" ? `${provider.providerId}\0${model.id}` : `${provider.providerId}\0custom\0${model.name}`,
    };
  }
  return null;
}

export function isBuiltInCatalogCheckedSelection(config: RuntimeConfig): boolean {
  return builtInCatalogSelection(config) !== null;
}

/** Revalidate only a newly selected preset identity, not profile/reasoning/key-only edits. */
export function builtInPresetSelectionChanged(
  previous: RuntimeConfig,
  next: RuntimeConfig,
): boolean {
  const nextKey = builtInCatalogSelection(next)?.key ?? null;
  return nextKey !== null && nextKey !== (builtInCatalogSelection(previous)?.key ?? null);
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
    customModelProviderIds: providerIdSet(catalog.customModelProviderIds),
  };
}

function providerIdSet(ids: unknown): ReadonlySet<string> {
  return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
}

/** Validate only the closed Built-in preset namespace; gateways are intentionally out of scope. */
export function assertBuiltInPresetSupportedByCatalog(
  config: RuntimeConfig,
  outcome: RuntimeModelSourceOutcome,
  target: BuiltInModelCatalogTarget,
): BuiltInModelCatalogValidation | null {
  const selection = builtInCatalogSelection(config);
  if (!selection) return null;

  const requestedModel = selection.model.kind === "preset" ? selection.model.id : selection.model.name;
  const catalog = requireBuiltInCatalogCapability(
    outcome,
    target,
    requestedModel,
  );
  const { supportedModelIds } = catalog;
  if (selection.model.kind === "custom") {
    // task #10: only a Computer that says it runs a typed id on this provider
    // may get one; an older one would refuse the config, or fail to resolve
    // the model, at start.
    if (!catalog.customModelProviderIds.has(selection.providerId)) {
      // A listed model is stored as custom only for its limits
      // (normalizeBuiltInPresetCustomModel): the user did pick from the
      // list, so the way out is the limits, not another model.
      const listedWithLimits = (PI_BUILTIN_PROVIDER_MODELS[selection.providerId] ?? [])
        .some((candidate) => candidate.id === `${selection.providerId}/${requestedModel}`);
      throw new BuiltInModelCatalogError(
        "builtin_custom_model_upgrade_required",
        listedWithLimits
          ? "This Computer is too old to run this model with a context window or max output tokens set. Upgrade the Computer, or clear Context window and Max output tokens."
          : "This Computer is too old to run a model ID that is not in its list. Upgrade the Computer, or choose a model from the list.",
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
  // A gateway always takes a typed id; a preset provider only where this
  // Computer runs one for it.
  const customAllowed = (providerId: string) =>
    source.customValueAllowedByValue[providerId] === true &&
    (!isBuiltInRuntimeCustomModelPresetProviderId(providerId) ||
      customModelProviderIds.has(providerId));
  const optionsByValue = Object.fromEntries(
    Object.entries(source.optionsByValue).flatMap(([providerId, options]) => {
      const filtered = options.filter((option) =>
        supportedModelIds.has(option.value),
      );
      return filtered.length > 0 || customAllowed(providerId)
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
    Object.keys(source.customValueAllowedByValue)
      .filter((providerId) => providerId in optionsByValue)
      .map((providerId) => [providerId, customAllowed(providerId)]),
  );
  return {
    ...source,
    optionsByValue,
    defaultValueByValue,
    customValueAllowedByValue,
  };
}
