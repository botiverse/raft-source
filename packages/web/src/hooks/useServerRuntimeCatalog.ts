import { useCallback, useEffect, useState } from "react";
import { isRuntimeDeprecated } from "@botiverse/raft-shared";
import type { ServerRuntimeCatalog } from "@botiverse/raft-shared";
import api from "../api/client";
import { useServerStore } from "../store/serverStore";
import { sharedCatalogReads } from "../store/serverRuntimeCatalogCache";
import type { SharedCatalogRead } from "../store/serverRuntimeCatalogCache";

/**
 * One read per server shared by every mount: a list names a runtime on each of
 * its rows (Computer page agents, members, provider assignments), and each row
 * asks. Concurrent mounts share the request; a settled answer (a catalog, or
 * `null` for a server too old to serve one) is reused for a minute.
 */
const CATALOG_REUSE_MS = 60_000;

export function resetServerRuntimeCatalogReadsForTests(): void {
  sharedCatalogReads.clear();
}

function reusableRead(serverId: string): SharedCatalogRead | undefined {
  const existing = sharedCatalogReads.get(serverId);
  if (!existing) return undefined;
  return existing.settledAt === undefined || Date.now() - existing.settledAt < CATALOG_REUSE_MS ? existing : undefined;
}

function readServerRuntimeCatalog(serverId: string): Promise<ServerRuntimeCatalog | null> {
  const existing = reusableRead(serverId);
  if (existing) return existing.promise;
  const entry: SharedCatalogRead = {
    promise: api.get<ServerRuntimeCatalog>(`/servers/${serverId}/runtimes`)
      .then(({ data }) => (Array.isArray(data?.runtimes) ? data : null))
      .catch(() => null)
      .then((catalog) => {
        entry.settledAt = Date.now();
        entry.catalog = catalog;
        return catalog;
      }),
  };
  sharedCatalogReads.set(serverId, entry);
  return entry.promise;
}

/** The settled shared answer, so a row mounting after the read renders it at once. */
function settledCatalog(serverId: string | null | undefined): { serverId: string; catalog: ServerRuntimeCatalog | null } | null {
  const read = serverId ? reusableRead(serverId) : undefined;
  return serverId && read?.settledAt !== undefined ? { serverId, catalog: read.catalog ?? null } : null;
}

/**
 * This server's runtime catalog (`GET /servers/:id/runtimes`,
 * docs/contracts/server-runtime-catalog.md): whether a runtime is deprecated
 * is a per-server answer (Antigravity is not where `agent_runtime_oar_antigravity`
 * is on). `null` while it loads, and for a server too old to serve it or any
 * error: callers then fall back to the bundled catalog, which is what such a
 * server decides by anyway.
 */
export function useServerRuntimeCatalog(serverId: string | null | undefined): ServerRuntimeCatalog | null {
  const [state, setState] = useState(() => settledCatalog(serverId));

  // Async-loader: one shared read per server; a failure keeps the bundled fallback.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    void readServerRuntimeCatalog(serverId).then((catalog) => {
      if (cancelled) return;
      setState((previous) => (previous?.serverId === serverId && previous.catalog === catalog ? previous : { serverId, catalog }));
    });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  // A server switch renders the already settled answer at once (no flash of the bundled fallback).
  if (!serverId) return null;
  return state?.serverId === serverId ? state.catalog : settledCatalog(serverId)?.catalog ?? null;
}

/** Deprecated on this server: the catalog's answer, else (no catalog, or a runtime it does not list) the bundled one. */
export function isRuntimeDeprecatedOnServer(runtimeId: string, catalog: ServerRuntimeCatalog | null): boolean {
  const entry = catalog?.runtimes.find((runtime) => runtime.id === runtimeId);
  return typeof entry?.deprecated === "boolean" ? entry.deprecated : isRuntimeDeprecated(runtimeId);
}

/**
 * `(runtimeId) => deprecated` as the current server answers it, for the places
 * that name an agent's runtime with its lifecycle word (rows, chips, cards).
 * A runtime the server offers again (Antigravity on OAR) is not "(deprecated)"
 * there; before the catalog arrives, or on a server too old to serve it, the
 * bundled catalog says. Stable until the catalog changes (memo-safe).
 */
export function useRuntimeDeprecatedHere(): (runtimeId: string) => boolean {
  const serverId = useServerStore((s) => s.current?.id);
  const catalog = useServerRuntimeCatalog(serverId);
  return useCallback((runtimeId: string) => isRuntimeDeprecatedOnServer(runtimeId, catalog), [catalog]);
}
