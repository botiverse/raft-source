import { create } from "zustand";
import type { ServerModelLabelCatalog } from "@botiverse/raft-shared";

import api from "../api/client";
import { useServerStore } from "./serverStore";

/**
 * One shared model-label catalog per server (task #700): the server stores
 * what each machine's daemon reported (id + the runtime's own label) and every
 * display surface — the runtime-config dropdown, name rows, the machine page,
 * the panel badge and the profile card — resolves names from this one copy.
 */
/**
 * Fetch window only: loads happen when the shell mounts / the server switches
 * and after a successful live detect. There is deliberately NO periodic
 * refresh — a user sitting on one server keeps the fetched catalog until one
 * of those events, because a machine's model list almost never changes (Kai's
 * review of #8639). The window just keeps those events from re-fetching.
 */
export const MODEL_LABEL_CATALOG_CACHE_MS = 5 * 60_000;
/** Failed loads back off before retrying, so render-time ensures cannot
 *  hammer the endpoint (rows render far more often than servers change). */
export const MODEL_LABEL_CATALOG_RETRY_MS = 60_000;

type CatalogEntry = { catalog: ServerModelLabelCatalog; fetchedAt: number };

interface ModelLabelCatalogState {
  byServer: Record<string, CatalogEntry | undefined>;
  inflight: Record<string, Promise<void> | undefined>;
  lastAttemptAt: Record<string, number | undefined>;
  load: (serverId: string, options?: { force?: boolean }) => void;
}

export const useModelLabelCatalogStore = create<ModelLabelCatalogState>((set, get) => ({
  byServer: {},
  inflight: {},
  lastAttemptAt: {},
  load: (serverId, options = {}) => {
    if (!serverId) return;
    const entry = get().byServer[serverId];
    if (!options.force && entry && Date.now() - entry.fetchedAt < MODEL_LABEL_CATALOG_CACHE_MS) return;
    if (get().inflight[serverId]) return;
    const lastAttemptAt = get().lastAttemptAt[serverId];
    if (!options.force && !entry && lastAttemptAt && Date.now() - lastAttemptAt < MODEL_LABEL_CATALOG_RETRY_MS) return;
    set((state) => ({ lastAttemptAt: { ...state.lastAttemptAt, [serverId]: Date.now() } }));
    const request = api
      .get(`/servers/${serverId}/model-label-catalog`)
      .then((res) => {
        // Never let a malformed payload replace a good catalog (or crash the
        // render paths that read it).
        if (!isServerModelLabelCatalog(res.data)) return;
        set((state) => ({
          byServer: {
            ...state.byServer,
            [serverId]: { catalog: res.data, fetchedAt: Date.now() },
          },
        }));
      })
      .catch(() => {
        // Display keeps the bundled fallback labels; a failed refresh must not
        // clear a previous good catalog.
      })
      .finally(() => {
        set((state) => ({ inflight: { ...state.inflight, [serverId]: undefined } }));
      });
    set((state) => ({ inflight: { ...state.inflight, [serverId]: request } }));
  },
}));

/** Defensive shape check for the member-readable payload. */
export function isServerModelLabelCatalog(value: unknown): value is ServerModelLabelCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const machines = (value as { machines?: unknown }).machines;
  if (!machines || typeof machines !== "object" || Array.isArray(machines)) return false;
  return Object.values(machines as Record<string, unknown>).every((machine) =>
    machine !== null
    && typeof machine === "object"
    && !Array.isArray(machine)
    && typeof (machine as { runtimes?: unknown }).runtimes === "object"
    && (machine as { runtimes?: unknown }).runtimes !== null,
  );
}

/** Pure resolution against a fetched catalog. */
export function modelLabelFromCatalog(
  catalog: ServerModelLabelCatalog | undefined,
  machineId: string | null | undefined,
  runtimeId: string | null | undefined,
  modelId: string | null | undefined,
): string | null {
  if (!catalog || !machineId || !runtimeId || !modelId) return null;
  const runtime = catalog.machines[machineId]?.runtimes[runtimeId];
  return runtime?.models.find((model) => model.id === modelId)?.label ?? null;
}

/**
 * A live model detect for a Computer was just upserted into the server's
 * catalog (the runtime-models probe, or a runtime-config form's model list
 * answered live): reload our copy so every surface shows the name the
 * dropdown shows (#triage:#548: after a Claude Code upgrade the editor said
 * Fable 5.2 while the chat and profile still said 5.1). Only when the app
 * already uses the catalog: nothing to align otherwise.
 */
export function refreshModelLabelCatalogAfterLiveDetect(serverId: string | null | undefined): void {
  if (!serverId) return;
  const store = useModelLabelCatalogStore.getState();
  if (store.byServer[serverId]) store.load(serverId, { force: true });
}

/** Synchronous read for render paths that already hold a machine + model. */
export function catalogModelLabel(
  serverId: string | null | undefined,
  machineId: string | null | undefined,
  runtimeId: string | null | undefined,
  modelId: string | null | undefined,
): string | null {
  if (!serverId) return null;
  return modelLabelFromCatalog(
    useModelLabelCatalogStore.getState().byServer[serverId]?.catalog,
    machineId,
    runtimeId,
    modelId,
  );
}

/**
 * Per-row subscription (Kai's review): rows behind a memo boundary must
 * re-render when the catalog arrives, so the name they render is selected
 * through this hook instead of a `getState()` read at render time. Rows only
 * subscribe: loading is triggered by the module-level server watcher below,
 * so neither a component nor a render ever fires a request.
 */
export function useCatalogModelLabel(
  machineId: string | null | undefined,
  runtimeId: string | null | undefined,
  modelId: string | null | undefined,
): string | null {
  const currentServerId = useServerStore((state) => state.current?.id);
  return useModelLabelCatalogStore((state) =>
    currentServerId
      ? modelLabelFromCatalog(state.byServer[currentServerId]?.catalog, machineId, runtimeId, modelId)
      : null,
  );
}

/** Subscribe to the current server's catalog (loading is triggered by the
 *  module-level watcher below; this hook is a pure subscription). */
export function useModelLabelCatalog(serverId?: string | null): ServerModelLabelCatalog | undefined {
  const currentServerId = useServerStore((state) => state.current?.id);
  const resolvedServerId = serverId ?? currentServerId;
  return useModelLabelCatalogStore((state) =>
    resolvedServerId ? state.byServer[resolvedServerId]?.catalog : undefined,
  );
}

function syncCatalogForServer(serverId: string | null | undefined): void {
  if (serverId) useModelLabelCatalogStore.getState().load(serverId);
}

/**
 * Watch the current server while the app shell is mounted (Kai's review: the
 * trigger belongs where the event happens — the server change — not in a
 * component's render or an effect). The shell's mount effect owns this
 * subscription, so surfaces rendered without the shell (isolated previews,
 * tests) never fetch; the store's dedupe + failure backoff keep the request
 * rate bounded. Returns the unsubscribe.
 */
export function watchModelLabelCatalog(): () => void {
  syncCatalogForServer(useServerStore.getState().current?.id);
  return useServerStore.subscribe((state, previous) => {
    const nextId = state.current?.id;
    if (nextId !== previous.current?.id) syncCatalogForServer(nextId);
  });
}
