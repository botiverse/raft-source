import { createServerViewPreference } from "../../store/serverViewPreference";
import { AGENTS_GROUPINGS, DEFAULT_AGENTS_GROUPING } from "./membersPageModel";
import type { AgentsGrouping, MembersTab } from "./membersPageModel";

/**
 * The Members page's view choices, kept per server on this device
 * (raft-design Members): the tab last chosen (All, Humans or Agents; All the
 * first time) and how the Agents tab groups its list (not at all, the
 * default, by creator or by computer). In localStorage, like the Computers
 * overview's grid / list choice; each server keeps its own.
 */
export const MEMBERS_TAB_STORAGE_PREFIX = "raft_members_tab.";
export const AGENTS_GROUPING_STORAGE_PREFIX = "raft_members_agents_grouping.";
/** Where the grouping was kept for the whole browser before it was kept per server: still read for a server with no choice yet. */
export const LEGACY_AGENTS_GROUPING_STORAGE_KEY = "raft_members_agents_grouping";

const MEMBERS_TABS: readonly MembersTab[] = ["all", "humans", "agents"];

const tabPreference = createServerViewPreference<MembersTab>({
  storagePrefix: MEMBERS_TAB_STORAGE_PREFIX,
  values: MEMBERS_TABS,
  fallback: "all",
});

const groupingPreference = createServerViewPreference<AgentsGrouping>({
  storagePrefix: AGENTS_GROUPING_STORAGE_PREFIX,
  values: AGENTS_GROUPINGS,
  fallback: DEFAULT_AGENTS_GROUPING,
  legacyKey: LEGACY_AGENTS_GROUPING_STORAGE_KEY,
});

export const writeMembersTab = tabPreference.write;
export const writeAgentsGrouping = groupingPreference.write;

export function useMembersTab(serverId: string | null | undefined): MembersTab {
  return tabPreference.useValue(serverId);
}

export function useAgentsGrouping(serverId: string | null | undefined): AgentsGrouping {
  return groupingPreference.useValue(serverId);
}

/** Tests: forget the choices that storage refused. */
export function resetMembersViewPreferencesForTests(): void {
  tabPreference.resetForTests();
  groupingPreference.resetForTests();
}
