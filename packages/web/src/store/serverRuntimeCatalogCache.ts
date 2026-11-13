import type { ServerRuntimeCatalog } from "@botiverse/raft-shared";
import { useServerStore } from "./serverStore";

/**
 * The shared per-server runtime catalog reads (useServerRuntimeCatalog). The
 * server answers per user, so a sign-out clears it: logout empties the server
 * list (authStore.logout), and the next account starts from no reads.
 */
export type SharedCatalogRead = { promise: Promise<ServerRuntimeCatalog | null>; settledAt?: number; catalog?: ServerRuntimeCatalog | null };
export const sharedCatalogReads = new Map<string, SharedCatalogRead>();

useServerStore.subscribe((state, previous) => {
  if (state.servers.length === 0 && previous.servers.length > 0) sharedCatalogReads.clear();
});
