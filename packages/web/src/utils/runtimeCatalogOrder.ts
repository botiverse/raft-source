import { RUNTIMES } from "@botiverse/raft-shared";

// Only the registry's order, for sorting runtimes a machine already reports.
// Pickers must not list from the raw registry (runtimeConfigUiReuse.test.ts);
// this exposes no runtime a machine doesn't have.
const CATALOG_INDEX = new Map(RUNTIMES.map((runtime, index) => [runtime.id, index]));

/** Sorts runtime ids in the runtime catalog's order; unknown ids last, by id. */
export function compareRuntimeCatalogOrder(a: string, b: string): number {
  const ai = CATALOG_INDEX.get(a) ?? Number.MAX_SAFE_INTEGER;
  const bi = CATALOG_INDEX.get(b) ?? Number.MAX_SAFE_INTEGER;
  return ai - bi || a.localeCompare(b);
}
