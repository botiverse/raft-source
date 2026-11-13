import type { ComponentType } from "react";
import { MessageIcon } from "@botiverse/ricons";
import { Activity, AlarmClock, AppWindow, Bot, ChartColumn, FolderOpen } from "lucide-react";

import type { MessageId } from "../../i18n/messages/en";

/** The agent panel's tabs (AgentDetailPanel). MCP Apps are rows of the Apps tab (`integrations`); there is no separate MCP tab. */
export const AGENT_TABS = ["profile", "activity", "usage", "chat", "reminders", "workspace", "integrations"] as const;
export type AgentTab = typeof AGENT_TABS[number];

type PanelTabItem<T extends string> = {
  id: T;
  labelId: MessageId;
  icon: ComponentType<{ size?: number; className?: string }>;
};

export const AGENT_PANEL_TABS: PanelTabItem<AgentTab>[] = [
  { id: "profile", icon: Bot, labelId: "agent.detail.tab.profile" },
  { id: "activity", icon: Activity, labelId: "agent.detail.tab.activity" },
  // Behind agent_usage_v0 (AgentDetailPanel); private, as Activity is.
  { id: "usage", icon: ChartColumn, labelId: "agent.detail.tab.usage" },
  { id: "chat", icon: MessageIcon, labelId: "agent.detail.tab.chat" },
  { id: "reminders", icon: AlarmClock, labelId: "agent.detail.tab.reminders" },
  { id: "workspace", icon: FolderOpen, labelId: "agent.detail.tab.workspace" },
  { id: "integrations", icon: AppWindow, labelId: "agent.detail.tab.apps" },
];

// Default-deny: Profile is the only public tab. Any new tab added to
// AGENT_TABS is private by default until explicitly added to PUBLIC_AGENT_TABS.
// Spec: #proj-server:175df9ee — agent-internal info must not silently widen
// visibility for non-creator members.
export const PUBLIC_AGENT_TABS = new Set<AgentTab>(["profile"]);
