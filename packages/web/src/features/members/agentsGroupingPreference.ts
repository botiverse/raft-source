import { createLocalViewPreference } from "../../store/localViewPreference";
import { AGENTS_GROUPINGS, DEFAULT_AGENTS_GROUPING } from "./membersPageModel";
import type { AgentsGrouping } from "./membersPageModel";

/**
 * How the Members page's Agents tab groups its list in this browser: not at
 * all (the default), by creator or by computer. Kept in localStorage like
 * the Computers overview's grid / list choice.
 */
export const AGENTS_GROUPING_STORAGE_KEY = "raft_members_agents_grouping";

const preference = createLocalViewPreference<AgentsGrouping>({
  storageKey: AGENTS_GROUPING_STORAGE_KEY,
  values: AGENTS_GROUPINGS,
  fallback: DEFAULT_AGENTS_GROUPING,
});

export const writeAgentsGrouping = preference.write;
/** Tests: forget a choice that storage refused. */
export const resetAgentsGroupingForTests = preference.resetForTests;

export function useAgentsGrouping(): AgentsGrouping {
  return preference.useValue();
}
