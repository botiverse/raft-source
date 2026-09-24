import type {
  AgentCreateFormOptionSource,
  RuntimeConfig,
  RuntimeModelSourceOutcome,
} from "@botiverse/raft-shared";

export type BuiltInModelCatalogErrorCode =
  | "builtin_catalog_capability_required"
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
}

export type BuiltInCatalogRead = Omit<
  BuiltInModelCatalogValidation,
  "requestedModel"
>;

function builtInPresetSelectionKey(config: RuntimeConfig): string | null {
  return config.runtime === "builtin" &&
    config.provider.kind === "preset" &&
    config.model.kind === "preset"
    ? `${config.provider.providerId}\0${config.model.id}`
    : null;
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
  };
}

/** Validate only the closed Built-in preset namespace; gateways/connections are intentionally out of scope. */
export function assertBuiltInPresetSupportedByCatalog(
  config: RuntimeConfig,
  outcome: RuntimeModelSourceOutcome,
  target: BuiltInModelCatalogTarget,
): BuiltInModelCatalogValidation | null {
  if (
    config.runtime !== "builtin" ||
    config.provider.kind !== "preset" ||
    config.model.kind !== "preset"
  )
    return null;

  const requestedModel = config.model.id;
  const catalog = requireBuiltInCatalogCapability(
    outcome,
    target,
    requestedModel,
  );
  const { supportedModelIds } = catalog;
  if (!supportedModelIds.has(requestedModel)) {
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
  };
}

/** Filter only preset model options; provider/gateway topology and current persisted state live elsewhere. */
export function filterBuiltInPiFormOptionSourceForCatalog(
  source: AgentCreateFormOptionSource,
  supportedModelIds: ReadonlySet<string>,
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
    Object.entries(source.customValueAllowedByValue).filter(
      ([providerId]) => providerId in optionsByValue,
    ),
  );
  return {
    ...source,
    optionsByValue,
    defaultValueByValue,
    customValueAllowedByValue,
  };
}
