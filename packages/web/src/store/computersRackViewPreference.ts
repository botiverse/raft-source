import { createLocalViewPreference } from "./localViewPreference";

/**
 * How the Computers overview lays out its
 * computers in this browser: `cards`, a grid of cards (the default), or
 * `list`, one aligned row per computer. The choice is kept in this browser's
 * localStorage, like the Applications grid / list choice; the desktop page and
 * the phone page share it.
 */
export type ComputersRackView = "list" | "cards";

export const COMPUTERS_RACK_VIEW_STORAGE_KEY = "raft_computers_rack_view";

const preference = createLocalViewPreference<ComputersRackView>({
  storageKey: COMPUTERS_RACK_VIEW_STORAGE_KEY,
  values: ["list", "cards"],
  fallback: "cards",
});

export const readComputersRackView = preference.read;
export const writeComputersRackView = preference.write;
/** Tests: forget a choice that storage refused. */
export const resetComputersRackViewForTests = preference.resetForTests;

export function useComputersRackView(): ComputersRackView {
  return preference.useValue();
}
