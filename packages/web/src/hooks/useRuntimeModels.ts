import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getModelLabel,
  getStaticRuntimeModelSourceSet,
  hasStaticRuntimeModelSource,
  isRuntimeModelDetectionErrorCode,
  isRuntimeModelDetectionLookupReason,
  RUNTIME_MODELS,
  runtimeModelSourceOutcomeFromSet,
  sanitizeRuntimeModelUnavailable,
} from "@botiverse/raft-shared";
import type {
  RuntimeModelCatalogCapability,
  RuntimeModelInfo,
  RuntimeModelSet,
  RuntimeModelSourceOutcome,
} from "@botiverse/raft-shared";
import api from "../api/client";
import { useServerStore } from "../store/serverStore";
import { catalogModelLabel, useModelLabelCatalogStore } from "../store/modelLabelCatalogStore";
import { canonicalizeCodexPresentation } from "../utils/codexModelOrder";

export type RuntimeModelSourceState =
  | { kind: "idle" }
  | { kind: "loading"; previous?: RuntimeModelSet }
  | RuntimeModelSourceOutcome;

/**
 * How the server answered (additive `state`): ok, the Computer's last list
 * because it did not answer in time (stale, received at `fetchedAt`), or
 * nothing in time (unavailable). An older server sends none: ok.
 */
export type RuntimeModelFreshness =
  | { state: "ok" }
  | { state: "stale"; fetchedAt?: string }
  | { state: "unavailable" };

const FRESH: RuntimeModelFreshness = { state: "ok" };

export function parseRuntimeModelFreshness(payload: unknown): RuntimeModelFreshness {
  if (!payload || typeof payload !== "object") return FRESH;
  const { state, fetchedAt } = payload as { state?: unknown; fetchedAt?: unknown };
  if (state === "stale") return typeof fetchedAt === "string" ? { state, fetchedAt } : { state };
  if (state === "unavailable") return { state };
  return FRESH;
}

/**
 * A model this Computer's runtime listed as disabled, shown greyed and never
 * selectable. `runtimeReason` is the runtime's own untrusted text (plain text
 * only; may be empty).
 */
export interface RuntimeModelUnavailableOption {
  id: string;
  label: string;
  runtimeReason: string;
}

export interface RuntimeModelsResult {
  source: RuntimeModelSourceState;
  freshness: RuntimeModelFreshness;
  models: RuntimeModelInfo[];
  /** Not selectable; never part of `models`. */
  unavailable: RuntimeModelUnavailableOption[];
  default?: string;
  /** Bundled metadata; terminal discovery failures may offer it as unverified. */
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
  machineId?: string | null,
): RuntimeModelLabelPresentation {
  // The machine-reported catalog is the shared display source (task #700):
  // the dropdown, the badge and every other surface show the same name.
  const sharedLabel = catalogModelLabel(
    useServerStore.getState().current?.id,
    machineId,
    runtime,
    model,
  );
  if (sharedLabel) return { kind: "resolved", label: sharedLabel };
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
    // A bundled entry never proves that the current Computer/config can launch
    // it, including when it is offered as a selectable fallback.
    verified: "suggestion_only",
  }));
}

/** Editing a known model is allowed without claiming that it can launch.
 * Provider-scoped Built-in/Pi forms continue to own their own catalogs.
 */
export function runtimeModelFallbackOptions(runtime: string | undefined, source: RuntimeModelSourceState): RuntimeModelInfo[] {
  if (!runtime || runtime === "builtin" || runtime === "pi"
    || source.kind === "live" || source.kind === "loading" || source.kind === "idle") return [];
  return (RUNTIME_MODELS[runtime] ?? []).map((model) => ({ ...model, verified: "suggestion_only" }));
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
    code?: unknown;
    reason?: unknown;
    recovery?: unknown;
    catalog?: unknown;
    models?: unknown;
    default?: unknown;
  };
  if (candidate.kind === "live") {
    const value = candidate.value as {
      models?: unknown; default?: unknown; catalog?: unknown; unavailable?: unknown;
    } | undefined;
    if (!value || !Array.isArray(value.models)) {
      return { kind: "error", retryable: true };
    }
    const catalog = parseBuiltInCatalogCapability(value.catalog);
    const unavailable = sanitizeRuntimeModelUnavailable(value.unavailable);
    return runtimeModelSourceOutcomeFromSet({
      models: value.models as RuntimeModelInfo[],
      ...(typeof value.default === "string" ? { default: value.default } : {}),
      ...(catalog ? { catalog } : {}),
      ...(unavailable ? { unavailable } : {}),
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
    return {
      kind: "error", retryable: candidate.retryable !== false,
      ...(isRuntimeModelDetectionErrorCode(candidate.code) ? { code: candidate.code } : {}),
      // task #735: the lookup miss reason rides `runtime_not_found` on new
      // daemons. Absent (old daemon) or unknown → dropped, so the display layer
      // reads it as unresolved and never as a confirmed miss.
          ...(isRuntimeModelDetectionLookupReason(candidate.reason) ? { reason: candidate.reason } : {}),
    };
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

export function projectRuntimeModelSourcePresentation(runtime: string, source: RuntimeModelSourceState): Omit<RuntimeModelsResult, "suggestions" | "rescan" | "freshness"> {
  const value = source.kind === "live"
    ? source.value
    : source.kind === "loading"
      ? source.previous
      : undefined;
  if (!value) {
    return {
      source,
      models: runtimeModelFallbackOptions(runtime, source),
      unavailable: [],
      loading: source.kind === "loading",
      fromMachine: false,
    };
  }
  const canon = canonicalizeCodexPresentation(runtime, value.models, value.default);
  const projectedValue: RuntimeModelSet = {
    ...canon,
    ...(value.catalog ? { catalog: value.catalog } : {}),
    ...(value.unavailable ? { unavailable: value.unavailable } : {}),
  };
  const usable = new Set(canon.models.map((model) => model.id));
  const unavailable: RuntimeModelUnavailableOption[] = source.kind === "live"
    ? (value.unavailable ?? [])
        .filter((model) => !usable.has(model.id))
        .map((model) => ({ id: model.id, label: model.label, runtimeReason: model.reason }))
    : [];
  return {
    source: source.kind === "live" ? { kind: "live", value: projectedValue } : source,
    models: canon.models,
    unavailable,
    default: canon.default,
    loading: source.kind === "loading",
    fromMachine: source.kind === "live",
  };
}

/**
 * Opt-in sharing for passive surfaces (the hover profile card). Every mount used
 * to ask the Computer to run the runtime's model probe; hovering over a few
 * agents in a row stacked several `cursor-agent models` on one Mac until each
 * hit the 15s deadline (2026-09-28). Passive readers share an in-flight request
 * and reuse a recent live catalog; the Create Agent dialog and agent details
 * stay fresh on every open, and a rescan always asks again.
 */
type RuntimeModelLoad = { source: RuntimeModelSourceState; freshness: RuntimeModelFreshness };
type SharedRuntimeModelRequest = { promise: Promise<RuntimeModelLoad>; settledAt?: number; load?: RuntimeModelLoad };
const sharedRuntimeModelRequests = new Map<string, SharedRuntimeModelRequest>();

export function resetSharedRuntimeModelRequestsForTests(): void {
  sharedRuntimeModelRequests.clear();
}

function loadRuntimeModelSource(serverId: string, machineId: string, runtime: string): Promise<RuntimeModelLoad> {
  return api
    .get(`/servers/${serverId}/machines/${machineId}/runtime-models/${runtime}`)
    .then((res): RuntimeModelLoad => {
      const source = parseRuntimeModelSourcePayload(res.data);
      // A successful live detect was upserted into the shared catalog server
      // side; refresh our copy so the dropdown never shows the older cached
      // name (Kai's review of #8639). Only when the app already uses the
      // catalog: nothing to align otherwise (and no stray request).
      if (source.kind === "live" && useModelLabelCatalogStore.getState().byServer[serverId]) {
        useModelLabelCatalogStore.getState().load(serverId, { force: true });
      }
      return { source, freshness: parseRuntimeModelFreshness(res.data) };
    })
    .catch((): RuntimeModelLoad => ({ source: { kind: "error", retryable: true }, freshness: FRESH }));
}

function sharedRuntimeModelSource(serverId: string, machineId: string, runtime: string, reuseRecentMs: number): Promise<RuntimeModelLoad> {
  const key = JSON.stringify([serverId, machineId, runtime]);
  const existing = sharedRuntimeModelRequests.get(key);
  // Only a fresh live list is worth sharing; a stale one asks again.
  if (existing && (existing.settledAt === undefined || (
    existing.load?.source.kind === "live"
    && existing.load.freshness.state === "ok"
    && Date.now() - existing.settledAt < reuseRecentMs
  ))) {
    return existing.promise;
  }
  const entry: SharedRuntimeModelRequest = {
    promise: loadRuntimeModelSource(serverId, machineId, runtime).then((load) => {
      entry.settledAt = Date.now();
      entry.load = load;
      return load;
    }),
  };
  sharedRuntimeModelRequests.set(key, entry);
  return entry.promise;
}

export function useRuntimeModels(
  machineId: string | null | undefined,
  runtime: string,
  options: { reuseRecentMs?: number } = {},
): RuntimeModelsResult {
  const reuseRecentMs = options.reuseRecentMs ?? 0;
  const serverId = useServerStore((s) => s.current?.id);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const requestKey = serverId && machineId && runtime
    ? JSON.stringify([serverId, machineId, runtime, refreshNonce])
    : null;
  const [sourceSnapshot, setSourceSnapshot] = useState<{
    requestKey: string | null;
    source: RuntimeModelSourceState;
    freshness: RuntimeModelFreshness;
  }>({ requestKey: null, source: { kind: "idle" }, freshness: FRESH });

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
  const freshness = requestKey && sourceSnapshot.requestKey === requestKey ? sourceSnapshot.freshness : FRESH;

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
      setSourceSnapshot({ requestKey: null, source: { kind: "idle" }, freshness: FRESH });
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
      freshness: FRESH,
    });
    // A rescan (refreshNonce > 0) always asks the Computer again.
    const pending = reuseRecentMs > 0 && refreshNonce === 0
      ? sharedRuntimeModelSource(serverId, machineId, runtime, reuseRecentMs)
      : loadRuntimeModelSource(serverId, machineId, runtime);
    void pending.then((load) => {
      if (cancelled) return;
      setSourceSnapshot({ requestKey, ...load });
    });
    return () => {
      cancelled = true;
    };
  }, [machineId, requestKey, runtime, serverId, reuseRecentMs, refreshNonce]);

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
    freshness,
    suggestions,
    rescan,
  }), [presentation, freshness, rescan, suggestions]);
}
