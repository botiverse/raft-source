const AGENT_DETAIL_PATH_RE = /^\/s\/[^/]+\/agent\/[^/]+$/;
const DEFAULT_AGENT_TAB = "profile";
const AGENT_TAB_ORDER_FALLBACK = ["profile", "activity", "chat", "reminders", "workspace", "integrations", "mcp"] as const;
const LEGACY_AGENT_TAB_ALIASES: Record<string, string> = {
  channels: "chat",
  dms: "chat",
};

export function isFullPageAgentDetailPath(pathname: string): boolean {
  return AGENT_DETAIL_PATH_RE.test(pathname);
}

export function shouldDeleteAgentTabDuringProfileSync(
  pathname: string,
  previousProfileParam: string | null,
  nextProfileType: "agent" | "human" | null,
  nextProfileId: string | null,
  options: { resetAgentTabForProfileReopen?: boolean } = {},
): boolean {
  if (options.resetAgentTabForProfileReopen && nextProfileType === "agent" && nextProfileId) {
    return true;
  }

  if (nextProfileType === "agent" && nextProfileId) {
    return previousProfileParam !== `agent:${nextProfileId}`;
  }

  return !isFullPageAgentDetailPath(pathname);
}

export function resolveOrderedFirstAgentTab(
  visibleAgentTabs: readonly string[],
  agentPanelTabOrder: readonly string[],
): string {
  const visible = new Set(visibleAgentTabs.length > 0 ? visibleAgentTabs : AGENT_TAB_ORDER_FALLBACK);
  for (const rawTab of agentPanelTabOrder) {
    const tab = LEGACY_AGENT_TAB_ALIASES[rawTab] ?? rawTab;
    if (visible.has(tab)) return tab;
  }

  return visibleAgentTabs[0] ?? DEFAULT_AGENT_TAB;
}

/**
 * Opens an agent's profile panel on the ACTIVITY tab.
 *
 * A named seam rather than an inline option at the call site: the tab choice IS
 * the requirement ("jump straight to that agent's activity"), and a call site
 * that quietly said "profile" would still open the right panel for the right
 * agent — looking correct while failing the request. Keeping it here gives that
 * choice one owner and one test.
 */
/** The agent panel tab id the activity affordance targets. */
export const AGENT_ACTIVITY_TAB = "activity";

export function openConversationAgentActivity(
  openProfile: (
    type: "agent",
    id: string,
    options: {
      defaultAgentTabIntent: string;
      openSource?: "channel" | "thread";
    },
  ) => void,
  agentId: string,
  options: { openSource?: "channel" | "thread" } = {},
): void {
  openProfile("agent", agentId, { defaultAgentTabIntent: AGENT_ACTIVITY_TAB, ...options });
}

export function openConversationAgentProfile(
  openProfile: (
    type: "agent",
    id: string,
    options: {
      defaultAgentTabIntent: "ordered-first";
      openSource?: "channel" | "thread";
    },
  ) => void,
  agentId: string,
  options: { openSource?: "channel" | "thread" } = {},
): void {
  openProfile("agent", agentId, { defaultAgentTabIntent: "ordered-first", ...options });
}
