import {
  BadgeInfo,
  Bell,
  Building2,
  CreditCard,
  FlaskConical,
  Languages,
  KeyRound,
  ArrowLeftRight,
  Palette,
  Shield,
  Type,
  User,
  AppWindow,
  BellDot,
} from "lucide-react";
import { FeedbackIcon } from "@botiverse/ricons";
import type { ComponentType, SVGProps } from "react";
import type { MessageId } from "../../i18n/messages/en";
import type { ServerCapabilities, ServerRole } from "@botiverse/raft-shared";

const IM_BRIDGES_LABEL = "IM Bridges";
// The on-screen titles come from SETTINGS_TAB_TITLE_ID; these are the legacy English fields.
const THEME_LABEL = "Theme";
const SERVER_NOTIFICATIONS_LABEL = "Notifications";

/** A lucide or raft-ui icon component. */
type SettingsTabIcon = ComponentType<SVGProps<SVGSVGElement>>;

export const SETTINGS_TABS = [
  { id: "account", label: "Account", title: "Account", icon: User },
  { id: "language-region", label: "Language & Region", title: "Language & Region", icon: Languages },
  { id: "appearance", label: "Appearance", title: "Appearance", icon: Type },
  { id: "notifications", label: "Notifications", title: "Notifications", icon: Bell },
  // The member's own settings in the current server (its theme, its mute).
  { id: "theme", label: THEME_LABEL, title: THEME_LABEL, icon: Palette },
  { id: "server-notifications", label: SERVER_NOTIFICATIONS_LABEL, title: SERVER_NOTIFICATIONS_LABEL, icon: BellDot },
  { id: "server", label: "Server Profile", title: "Server Profile", icon: Building2 },
  { id: "billing", label: "Plan & Billing", title: "Plan & Billing", icon: CreditCard },
  { id: "administration", label: "Administration", title: "Administration", icon: Shield },
  { id: "im-bridges", label: IM_BRIDGES_LABEL, title: IM_BRIDGES_LABEL, icon: ArrowLeftRight },
  { id: "integrations", label: "Applications", title: "Applications", icon: AppWindow },
  { id: "labs", label: "Labs", title: "Labs", icon: FlaskConical },
  { id: "providers", label: "AI Providers", title: "AI Providers", icon: KeyRound },
  { id: "about", label: "About", title: "About", icon: BadgeInfo },
  { id: "feedback", label: "Feedback", title: "My Feedback", icon: FeedbackIcon },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  title: string;
  icon: SettingsTabIcon;
}>;

export type SettingsTabId = typeof SETTINGS_TABS[number]["id"];

export function canOpenSettingsTab(
  tab: SettingsTabId,
  capabilities: ServerCapabilities,
): boolean {
  if (tab === "billing") return capabilities.viewBilling;
  if (tab === "administration") {
    return capabilities.changeMemberRoles
      || capabilities.changeChannelVisibility
      || capabilities.inviteMembers
      || capabilities.editServerSettings;
  }
  return true;
}

/**
 * Everyone opens Applications, a guest too: it holds each person's own
 * link-preview answers (LinkPreviewConsentsRow). The server's Apps, MCP Apps
 * included, and everything that manages or lists them, are not for guests.
 */
export function canViewServerApplications(role: ServerRole | null | undefined): boolean {
  return role !== "guest";
}

export const SETTINGS_LABEL_BY_ID: Record<SettingsTabId, string> = Object.fromEntries(
  SETTINGS_TABS.map((tab) => [tab.id, tab.title]),
) as Record<SettingsTabId, string>;

// react-intl message ids for the settings panel HEADER titles. Pure id mapping
// over the `settings.tabs.*` catalog — the copy itself lives in
// `i18n/messages/{en,zh-cn}.ts` (source #3874 b41c72b4f).
//
// Total, not Partial. A Partial map here sat behind a silent `?:` fallback to
// the English `label` field, so a tab with no id compiled and rendered English
// with nothing going red — the defect @Wug blocked in #5858, and it had already
// happened: `about` was missing from this map, so zh users saw 关于 in the
// sidebar and "About" in the panel header. Making the map total moves that
// from "nobody noticed" to "does not compile". `billing`'s header reads
// "Plan & Billing" (billingHeader) while its sidebar label is "Billing".
export const SETTINGS_TAB_TITLE_ID: Record<SettingsTabId, MessageId> = {
  about: "settings.tabs.about",
  account: "settings.tabs.account",
  "language-region": "settings.tabs.languageRegion",
  appearance: "settings.tabs.appearance",
  notifications: "settings.tabs.notifications",
  theme: "settings.tabs.theme",
  "server-notifications": "settings.tabs.notifications",
  server: "settings.tabs.server",
  providers: "settings.tabs.providers",
  labs: "settings.tabs.labs",
  billing: "settings.tabs.billingHeader",
  administration: "settings.tabs.administration",
  "im-bridges": "settings.tabs.imBridges",
  integrations: "settings.tabs.integrations",
  feedback: "settings.about.feedbackWorkspaceTitle",
};

export const SETTINGS_ICON_BY_ID: Record<SettingsTabId, SettingsTabIcon> = Object.fromEntries(
  SETTINGS_TABS.map((tab) => [tab.id, tab.icon]),
) as Record<SettingsTabId, SettingsTabIcon>;

const SETTINGS_ROUTE_ALIASES: Readonly<Record<string, SettingsTabId>> = {
  applications: "integrations",
  // MCP Apps are Applications; the retired MCP Servers page's links land there.
  mcp: "integrations",
  "mcp-servers": "integrations",
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
  return tab;
}

/** A settings slug that names Applications (its own, or an old alias of it). */
export function isSettingsApplicationsSlug(slug: string | undefined): boolean {
  return settingsTabIdForRouteSlug(slug) === "integrations";
}

export function legacySettingsRouteRedirectSlug(slug: string | undefined): string | null {
  if (slug !== "integrations" && slug !== "browser" && slug !== "moderation" && slug !== "mcp" && slug !== "mcp-servers") return null;
  const tab = settingsTabIdForRouteSlug(slug);
  return tab ? settingsRouteSlugForTab(tab) : null;
}

export function normalizeSettingsTab(tab: string | undefined): SettingsTabId {
  return settingsTabIdForRouteSlug(tab) ?? "account";
}
