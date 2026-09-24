import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getModelLabel,
  getStaticRuntimeModelSourceSet,
  hasStaticRuntimeModelSource,
  RUNTIME_MODELS,
  runtimeModelSourceOutcomeFromSet,
} from "@botiverse/raft-shared";
import type {
  RuntimeModelCatalogCapability,
  RuntimeModelInfo,
  RuntimeModelSet,
  RuntimeModelSourceOutcome,
} from "@botiverse/raft-shared";
import api from "../api/client";
import { useServerStore } from "../store/serverStore";
import { canonicalizeCodexPresentation } from "../utils/codexModelOrder";

export type RuntimeModelSourceState =
  | { kind: "idle" }
  | { kind: "loading"; previous?: RuntimeModelSet }
  | RuntimeModelSourceOutcome;

export interface RuntimeModelsResult {
  source: RuntimeModelSourceState;
  models: RuntimeModelInfo[];
  default?: string;
  /** Bundled explanatory metadata. Never feed this into selectable options. */
  suggestions: RuntimeModelInfo[];
  loading: boolean;
  fromMachine: boolean;
  rescan: () => void;
}

export type RuntimeModelLabelPresentation =
  | { kind: "pending" }
  | { kind: "resolved"; label: string };

export function parseBuiltInCatalogCapability(
  value: unknown,
): RuntimeModelCatalogCapability | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  return candidate.protocolVersion === 1 &&
    candidate.runtime === "builtin" &&
    typeof candidate.runtimeVersion === "string" &&
    candidate.runtimeVersion.trim().length > 0
    ? {
        protocolVersion: 1,
        runtime: "builtin",
        runtimeVersion: candidate.runtimeVersion,
      }
    : undefined;
}

export function builtInCatalogCapabilityIsLive(
  source: RuntimeModelSourceState,
): boolean {
  return (
    source.kind === "live" &&
    parseBuiltInCatalogCapability(source.value.catalog) !== undefined
  );
}

/**
 * Intersect the Server's provider presentation metadata with the exact target
 * Computer catalog. A persisted value remains visible when unavailable, but is
 * disabled so an unavailable legacy selection cannot become a new write.
 */
export function projectBuiltInPresetModelOptions(input: {
  source: RuntimeModelSourceState;
  providerModels: readonly RuntimeModelInfo[];
  persistedModel?: string;
}): Array<RuntimeModelInfo & { disabled?: boolean }> {
  const supported = builtInCatalogCapabilityIsLive(input.source)
    ? new Set(
        input.source.kind === "live"
          ? input.source.value.models.map((model) => model.id)
          : [],
      )
    : new Set<string>();
  const options: Array<RuntimeModelInfo & { disabled?: boolean }> =
    input.providerModels.filter((model) => supported.has(model.id));
  const persistedModel = input.persistedModel?.trim();
  if (
    persistedModel &&
    !options.some((option) => option.id === persistedModel)
  ) {
    const metadata = input.providerModels.find(
      (model) => model.id === persistedModel,
    );
    options.push({
      id: persistedModel,
      label: metadata?.label ?? getModelLabel("builtin", persistedModel),
      disabled: true,
    });
  }
  return options;
}

/**
 * Resolve persisted model identity into user-facing copy without leaking a
 * dynamic provider/model ID while its authoritative machine catalog is pending.
 * Terminal non-live outcomes deliberately fall back to the public/static label
 * so an unavailable catalog never leaves the field permanently blank.
 */
export function projectRuntimeModelLabelPresentation(
  runtime: string,
  model: string,
  catalog: Pick<RuntimeModelsResult, "models" | "source">,
): RuntimeModelLabelPresentation {
  const configuredLabel = catalog.models.find((candidate) => candidate.id === model)?.label;
  if (configuredLabel) return { kind: "resolved", label: configuredLabel };

  if (
    !hasStaticRuntimeModelSource(runtime)
    && catalog.source.kind === "loading"
  ) {
    return { kind: "pending" };
  }

  return { kind: "resolved", label: getModelLabel(runtime, model) };
}

export function projectBundledRuntimeModelSuggestions(runtime: string): RuntimeModelInfo[] {
  const staticSource = getStaticRuntimeModelSourceSet(runtime);
  if (staticSource) return staticSource.models;

  return (RUNTIME_MODELS[runtime] ?? []).map((model) => ({
    ...model,
    // A bundled entry for a dynamic source is explanation, never proof that
    // the current Computer/config can launch it. Downgrade even legacy catalog
    // entries that were annotated for the old selectable-fallback behavior.
    verified: "suggestion_only",
  }));
}

/** Project both new typed API payloads and old `{models, default}` payloads. */
export function parseRuntimeModelSourcePayload(payload: unknown): RuntimeModelSourceOutcome {
  if (!payload || typeof payload !== "object") {
    return { kind: "error", retryable: true };
  }
  const candidate = payload as {
    kind?: unknown;
    value?: unknown;
    retryable?: unknown;
    recovery?: unknown;
    catalog?: unknown;
    models?: unknown;
    default?: unknown;
  };
  if (candidate.kind === "live") {
    const value = candidate.value as { models?: unknown; default?: unknown; catalog?: unknown } | undefined;
    if (!value || !Array.isArray(value.models)) {
      return { kind: "error", retryable: true };
    }
    const catalog = parseBuiltInCatalogCapability(value.catalog);
    return runtimeModelSourceOutcomeFromSet({
      models: value.models as RuntimeModelInfo[],
      ...(typeof value.default === "string" ? { default: value.default } : {}),
      ...(catalog ? { catalog } : {}),
    });
  }
  if (candidate.kind === "missing_config" || candidate.kind === "no_models") {
    return {
      kind: candidate.kind,
      ...(typeof candidate.recovery === "string" ? { recovery: candidate.recovery } : {}),
    };
  }
  if (candidate.kind === "unsupported") return { kind: "unsupported" };
  if (candidate.kind === "error") {
    return { kind: "error", retryable: candidate.retryable !== false };
  }
  if (Array.isArray(candidate.models)) {
    const catalog = parseBuiltInCatalogCapability(candidate.catalog);
    return runtimeModelSourceOutcomeFromSet({
      models: candidate.models as RuntimeModelInfo[],
      ...(typeof candidate.default === "string" ? { default: candidate.default } : {}),
      ...(catalog ? { catalog } : {}),
    });
  }
  return { kind: "error", retryable: true };
}

export function runtimeModelSelectionIsRunnable(input: {
  source: RuntimeModelSourceState;
  model: string;
  modelIgnored?: boolean;
  customMode: boolean;
  customAllowed: boolean;
  providerCatalog?: boolean;
  persistedModel?: string;
  requireBuiltInCatalog?: boolean;
}): boolean {
  if (input.modelIgnored) return true;
  const model = input.model.trim();
  if (!model) return false;
  if (input.providerCatalog) return true;
  if (input.requireBuiltInCatalog && input.persistedModel?.trim() === model)
    return true;
  if (input.customMode) return input.customAllowed;
  if (input.source.kind === "live") {
    if (input.requireBuiltInCatalog &&
      !builtInCatalogCapabilityIsLive(input.source)
    )
      return false;
    if (input.source.value.models.some((candidate) => candidate.id === model)) return true;
    return input.customAllowed && input.persistedModel === model;
  }
  return false;
}

export function projectRuntimeModelSourcePresentation(runtime: string, source: RuntimeModelSourceState): Omit<RuntimeModelsResult, "suggestions" | "rescan"> {
  const value = source.kind === "live"
    ? source.value
    : source.kind === "loading"
      ? source.previous
      : undefined;
  if (!value) {
    return {
      source,
      models: [],
      loading: source.kind === "loading",
      fromMachine: false,
    };
  }
  const canon = canonicalizeCodexPresentation(runtime, value.models, value.default);
  const projectedValue: RuntimeModelSet = {
    ...canon,
    ...(value.catalog ? { catalog: value.catalog } : {}),
  };
  return {
    source: source.kind === "live" ? { kind: "live", value: projectedValue } : source,
    models: canon.models,
    default: canon.default,
    loading: source.kind === "loading",
    fromMachine: source.kind === "live",
  };
}

export function useRuntimeModels(machineId: string | null | undefined, runtime: string): RuntimeModelsResult {
  const serverId = useServerStore((s) => s.current?.id);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const requestKey = serverId && machineId && runtime
    ? JSON.stringify([serverId, machineId, runtime, refreshNonce])
    : null;
  const [sourceSnapshot, setSourceSnapshot] = useState<{
    requestKey: string | null;
    source: RuntimeModelSourceState;
  }>({ requestKey: null, source: { kind: "idle" } });

  // The render that changes Computer/runtime/request generation must not expose
  // the previous request's catalog. Project the new identity as loading before
  // its effect runs; this also gives every consumer one lifecycle truth instead
  // of asking leaf components to reconstruct whether a request should exist.
  const source = useMemo<RuntimeModelSourceState>(() => {
    if (!requestKey) return { kind: "idle" };
    if (sourceSnapshot.requestKey === requestKey) return sourceSnapshot.source;
    return {
      kind: "loading",
      previous: getStaticRuntimeModelSourceSet(runtime),
    };
  }, [requestKey, runtime, sourceSnapshot]);

  const rescan = useCallback(() => {
    setRefreshNonce((n) => n + 1);
  }, []);

  // Async-loader: every terminal request retains its typed truth. Successful
  // catalogs are intentionally not process-cached: a rescan, login, provider
  // grant, or Computer reconnect must be able to recover without a hidden TTL.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (!requestKey || !machineId || !runtime || !serverId) {
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- source identity changed; discard the previous machine/runtime truth
      setSourceSnapshot({ requestKey: null, source: { kind: "idle" } });
      return;
    }
    let cancelled = false;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- enter the explicit loading state for this new source identity/rescan generation
    setSourceSnapshot({
      requestKey,
      source: {
        kind: "loading",
        // A declared static catalog is a closed source, so it can remain visible
        // while the Computer confirms the same source over the wire. Dynamic
        // bundled catalogs never enter this field and therefore stay
        // suggestion-only during loading/error/no-model outcomes.
        previous: getStaticRuntimeModelSourceSet(runtime),
      },
    });
    void api
      .get(`/servers/${serverId}/machines/${machineId}/runtime-models/${runtime}`)
      .then((res) => {
        if (cancelled) return;
        setSourceSnapshot({ requestKey, source: parseRuntimeModelSourcePayload(res.data) });
      })
      .catch(() => {
        if (cancelled) return;
        setSourceSnapshot({ requestKey, source: { kind: "error", retryable: true } });
      });
    return () => {
      cancelled = true;
    };
  }, [machineId, requestKey, runtime, serverId]);

  const presentation = useMemo(
    () => projectRuntimeModelSourcePresentation(runtime, source),
    [runtime, source],
  );
  const suggestions = useMemo(
    () => projectBundledRuntimeModelSuggestions(runtime),
    [runtime],
  );

  return useMemo(() => ({
    ...presentation,
    suggestions,
    rescan,
  }), [presentation, rescan, suggestions]);
}
