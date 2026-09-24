import {
  BadgeInfo,
  Bell,
  Blocks,
  Building2,
  CreditCard,
  FlaskConical,
  Languages,
  KeyRound,
  Link2,
  MessageSquare,
  Network,
  Shield,
  Type,
  User,
} from "lucide-react";
import type {
  LucideIcon,
} from "lucide-react";
import type { MessageId } from "../../i18n/messages/en";
import type { ServerCapabilities, ServerRole } from "@botiverse/raft-shared";

const IM_BRIDGES_LABEL = "IM Bridges";

export const SETTINGS_TABS = [
  { id: "account", label: "Account", title: "Account", icon: User },
  { id: "language-region", label: "Language & Region", title: "Language & Region", icon: Languages },
  { id: "appearance", label: "Appearance", title: "Appearance", icon: Type },
  { id: "notifications", label: "Notifications", title: "Notifications", icon: Bell },
  { id: "server", label: "Server Profile", title: "Server Profile", icon: Building2 },
  { id: "wiki", label: "wiki.settings", title: "wiki.settings", icon: Network },
  { id: "billing", label: "Plan & Billing", title: "Plan & Billing", icon: CreditCard },
  { id: "administration", label: "Administration", title: "Administration", icon: Shield },
  { id: "im-bridges", label: IM_BRIDGES_LABEL, title: IM_BRIDGES_LABEL, icon: Network },
  { id: "integrations", label: "Applications", title: "Applications", icon: Link2 },
  { id: "labs", label: "Labs", title: "Labs", icon: FlaskConical },
  { id: "mcp", label: "MCP Servers", title: "MCP Servers", icon: Blocks },
  { id: "providers", label: "AI Providers", title: "AI Providers", icon: KeyRound },
  { id: "about", label: "About", title: "About", icon: BadgeInfo },
  { id: "feedback", label: "Feedback", title: "My Feedback", icon: MessageSquare },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  title: string;
  icon: LucideIcon;
}>;

export type SettingsTabId = typeof SETTINGS_TABS[number]["id"];

export function canOpenSettingsTab(
  tab: SettingsTabId,
  capabilities: ServerCapabilities,
  role?: ServerRole | null,
): boolean {
  if (role === "guest" && (tab === "integrations" || tab === "mcp")) return false;
  if (tab === "billing") return capabilities.viewBilling;
  if (tab === "administration") {
    return capabilities.changeMemberRoles
      || capabilities.changeChannelVisibility
      || capabilities.inviteMembers
      || capabilities.editServerSettings;
  }
  return true;
}

// `labelId` (not `label`) so the group headers localize; `key` stays a stable
// non-display identifier so React keys don't change with the display locale.
export const SETTINGS_GROUPS: ReadonlyArray<{
  key: string;
  labelId: MessageId;
  items: ReadonlyArray<typeof SETTINGS_TABS[number]>;
}> = [
  { key: "personal", labelId: "settings.tabs.groupPersonal", items: SETTINGS_TABS.slice(0, 4) },
  { key: "workspace", labelId: "settings.tabs.groupWorkspace", items: SETTINGS_TABS.slice(4, 12) },
  { key: "about", labelId: "settings.tabs.groupAbout", items: SETTINGS_TABS.slice(12) },
];

export const SETTINGS_LABEL_BY_ID: Record<SettingsTabId, string> = Object.fromEntries(
  SETTINGS_TABS.map((tab) => [tab.id, tab.title]),
) as Record<SettingsTabId, string>;

// react-intl message ids for the settings NAV labels (sidebar) and the panel
// HEADER titles. Pure id mapping over the `settings.tabs.*` catalog — the copy
// itself lives in `i18n/messages/{en,zh-cn}.ts` (source #3874 b41c72b4f).
//
// Total, not Partial. A Partial map here sat behind a silent `?:` fallback to
// the English `label` field, so a tab with no id compiled and rendered English
// with nothing going red — the defect @Wug blocked in #5858, and it had already
// happened: `about` was missing from the title map below, so zh users saw 关于 in
// the sidebar and "About" in the panel header. Making both maps total moves that
// from "nobody noticed" to "does not compile".
export const SETTINGS_TAB_NAV_LABEL_ID: Record<SettingsTabId, MessageId> = {
  about: "settings.tabs.about",
  account: "settings.tabs.account",
  "language-region": "settings.tabs.languageRegion",
  appearance: "settings.tabs.appearance",
  notifications: "settings.tabs.notifications",
  server: "settings.tabs.server",
  wiki: "wiki.settings",
  mcp: "settings.tabs.mcp",
  providers: "settings.tabs.providers",
  labs: "settings.tabs.labs",
  billing: "settings.tabs.billing",
  administration: "settings.tabs.administration",
  "im-bridges": "settings.tabs.imBridges",
  integrations: "settings.tabs.integrations",
  feedback: "settings.about.feedbackTitle",
};

// Panel header title id map. Differs from the nav map only for `billing`, whose
// header reads "Plan & Billing" (billingHeader) while its sidebar label is
// "Billing". Total for the same reason as the nav map above.
export const SETTINGS_TAB_TITLE_ID: Record<SettingsTabId, MessageId> = {
  about: "settings.tabs.about",
  account: "settings.tabs.account",
  "language-region": "settings.tabs.languageRegion",
  appearance: "settings.tabs.appearance",
  notifications: "settings.tabs.notifications",
  server: "settings.tabs.server",
  wiki: "wiki.settings",
  mcp: "settings.tabs.mcp",
  providers: "settings.tabs.providers",
  labs: "settings.tabs.labs",
  billing: "settings.tabs.billingHeader",
  administration: "settings.tabs.administration",
  "im-bridges": "settings.tabs.imBridges",
  integrations: "settings.tabs.integrations",
  feedback: "settings.about.feedbackWorkspaceTitle",
};

export const SETTINGS_ICON_BY_ID: Record<SettingsTabId, LucideIcon> = Object.fromEntries(
  SETTINGS_TABS.map((tab) => [tab.id, tab.icon]),
) as Record<SettingsTabId, LucideIcon>;

const SETTINGS_ROUTE_ALIASES: Readonly<Record<string, SettingsTabId>> = {
  applications: "integrations",
  "mcp-servers": "mcp",
  browser: "notifications",
  labs: "labs",
  moderation: "administration",
  "server-labs": "labs",
};

export function settingsTabIdForRouteSlug(slug: string | undefined): SettingsTabId | null {
  if (!slug) return null;
  const alias = SETTINGS_ROUTE_ALIASES[slug];
  if (alias) return alias;
  return SETTINGS_TABS.some((candidate) => candidate.id === slug)
    ? slug as SettingsTabId
    : null;
}

export function settingsRouteSlugForTab(tab: SettingsTabId): string {
  if (tab === "integrations") return "applications";
  if (tab === "mcp") return "mcp-servers";
  return tab;
}

export function legacySettingsRouteRedirectSlug(slug: string | undefined): string | null {
  if (slug !== "integrations" && slug !== "browser" && slug !== "moderation") return null;
  const tab = settingsTabIdForRouteSlug(slug);
  return tab ? settingsRouteSlugForTab(tab) : null;
}

export function normalizeSettingsTab(tab: string | undefined): SettingsTabId {
  return settingsTabIdForRouteSlug(tab) ?? "account";
}
