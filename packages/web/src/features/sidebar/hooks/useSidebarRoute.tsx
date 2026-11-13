import { SidebarItemIcon } from "@botiverse/raft-ui";
import { FeedbackIcon } from "@botiverse/ricons";
import { useCallback, useMemo } from "react";
import { User, FileText, BookOpenText, Keyboard, ArrowLeftRight, Bell, Building2, Languages, Palette, Type, CreditCard, Shield, BadgeInfo, FlaskConical, KeyRound, AppWindow, BellDot } from "lucide-react";
import { useServerStore } from "../../../store/serverStore";
import { isComputerOpen } from "../../../utils/computerPanel";
import { settingsTabIdForRouteSlug } from "../../../components/settings/settingsNavigation";
import type { SettingsSidebarGroup } from "../../../components/settings/SettingsSidebarList";
import { canUseRaftBench } from "../../../raftbench/access";
import { BenchIcon } from "../../../raftbench/BenchIcon";
import type { SidebarData } from "./useSidebarData";
import type { SidebarViewState } from "./useSidebarViewState";
import type { SidebarRowHandlers } from "./useSidebarRowHandlers";

/* oxlint-disable react-hooks/exhaustive-deps -- the dependency arrays are the single Sidebar component's,
 * unchanged (#proj-frontend:#27). What the rule misses here are the useState setters and useRef objects
 * of earlier Sidebar hooks, which are stable across renders. */
/**
 * Which row the route selects and the settings sub-nav (its groups and the active item).
 */
export function useSidebarRoute(mobileInline: boolean | undefined, data: SidebarData, view: SidebarViewState, rowHandlers: SidebarRowHandlers) {
  const {
    formatMessage, navigate, location, raftBenchEnabled, labsUiEnabled, providerConnectionsEnabled,
    slackBridgeEnabled,
  } = data;
  const {
    currentRole, canManageExternalAuth, canViewBillingSettings, canViewAdministrationSettings,
    canViewApplicationsSettings,
  } = view;
  const { openComputerId } = rowHandlers;

  // Stryker disable all: route identity glue is browser-smoke verified; selection semantics live in the pure helper.
  const serverSlug = useServerStore((s) => s.current?.slug);
  const pathBase = serverSlug ? `/s/${serverSlug}` : "";
  // Stryker restore all

  // Stryker disable all: route selection is browser-smoke verified.
  const isChannelSelected = (id: string) => location.pathname === `${pathBase}/channel/${id}`;
  const isDmSelected = (id: string) => location.pathname === `${pathBase}/dm/${id}`;
  const backToSettingsFromComputers = useCallback(() => {
    navigate(`${pathBase}/settings`);
  }, [navigate, pathBase]);
  // The computer open in the side panel, or on a phone its own page.
  const isMachineSelected = (machineId: string) => isComputerOpen(machineId, {
    pathname: location.pathname,
    pathBase,
    openComputerId,
  });
  // Stryker restore all
  const isReleaseNotesRoute = location.pathname.startsWith(`${pathBase}/release-notes`);
  const isKeyboardShortcutsRoute = location.pathname.startsWith(`${pathBase}/keyboard-shortcuts`);

  // Settings-mode sidebar contents — when the user is in the Settings rail
  // mode, the sidebar shows a sub-nav of settings sections (Account /
  // Browser / Server / Release Notes, plus Computers on mobile) with their
  // canonical icons. The main panel renders the active sub-page; Logout
  // lives at the bottom of the Account page itself, not as a sidebar item.
  //
  // Computers is part of this sub-nav ONLY on mobile. Desktop has a
  // dedicated Computers rail mode in the LeftRail — adding Computers to
  // the Settings sub-nav there would be a duplicate entry point. Mobile's
  // 4-tab bar (Chat/Tasks/Members/Settings) folds Computers into Settings
  // instead of giving it its own tab.
  const isComputersRoute =
    pathBase &&
    (location.pathname === `${pathBase}/computers`
      || location.pathname.startsWith(`${pathBase}/computers/`)
      || location.pathname.startsWith(`${pathBase}/computer/`)
      || location.pathname.startsWith(`${pathBase}/machine/`)); // legacy
  // On mobile, `/settings` is the Settings tab ROOT — a list of sub-items
  // with no sub-page rendered yet. Nothing should be highlighted until the
  // user actually picks a sub-tab. On desktop, `/settings` still defaults
  // to Account (SettingsRoute renders Account content there), so Account
  // stays highlighted.
  const settingsTabFromPath: string | null = (() => {
    if (location.pathname.replace(/\/$/, "") === `${pathBase}/raftbench`) return "raftbench";
    if (isComputersRoute) return "computers";
    if (isReleaseNotesRoute) return "release-notes";
    if (isKeyboardShortcutsRoute) return "keyboard-shortcuts";
    const m = location.pathname.match(new RegExp(`^${pathBase.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}/settings(?:/([^/?#]+))?`));
    if (!m) return null;
    const t = m[1];
    if (!t) return mobileInline ? null : "account";
    return settingsTabIdForRouteSlug(t);
  })();
  // On a phone Members and Computers are not in this list: they are buttons
  // in the server tab's popover, beside Settings (Raft DS › Raft Chat ›
  // Settings, stdrc 2026-10-22). Desktop reaches both from the rail.
  const settingsServerName = useServerStore((s) => s.current?.name);
  const settingsServerMuted = useServerStore((s) => s.current?.serverPushMuted === true);
  const settingsSidebarGroups = useMemo<SettingsSidebarGroup[]>(() => pathBase
    ? [
        {
          label: formatMessage({ id: "layout.sidebar.settingsGroupPersonal" }),
          items: [
            { id: "account", label: formatMessage({ id: "settings.tabs.account" }), icon: <SidebarItemIcon><User /></SidebarItemIcon>, onClick: () => navigate(`${pathBase}/settings/account`) },
            { id: "language-region", label: formatMessage({ id: "settings.tabs.languageRegion" }), icon: <SidebarItemIcon><Languages /></SidebarItemIcon>, onClick: () => navigate(`${pathBase}/settings/language-region`) },
            { id: "appearance", label: formatMessage({ id: "settings.tabs.appearance" }), icon: <SidebarItemIcon><Type /></SidebarItemIcon>, onClick: () => navigate(`${pathBase}/settings/appearance`) },
            { id: "notifications", label: formatMessage({ id: "settings.tabs.notifications" }), icon: <SidebarItemIcon><Bell /></SidebarItemIcon>, onClick: () => navigate(`${pathBase}/settings/notifications`) },
          ],
        },
        // The member's own settings in this server: only they see them.
        ...(settingsServerName ? [{
          id: "on-server",
          label: formatMessage({ id: "layout.sidebar.settingsGroupOnServer" }, { serverName: settingsServerName }),
          items: [
            {
              id: "theme",
              label: formatMessage({ id: "settings.tabs.theme" }),
              ariaLabel: formatMessage({ id: "settings.appearance.serverThemeLinkTitle" }, { serverName: settingsServerName }),
              icon: <SidebarItemIcon><Palette /></SidebarItemIcon>,
              onClick: () => navigate(`${pathBase}/settings/theme`),
            },
            {
              id: "server-notifications",
              label: formatMessage({ id: "settings.tabs.notifications" }),
              ariaLabel: formatMessage({ id: "settings.notifications.serverLinkTitle" }, { serverName: settingsServerName }),
              icon: <SidebarItemIcon><BellDot /></SidebarItemIcon>,
              trailing: settingsServerMuted
                ? <span className="ml-auto shrink-0 text-footnote text-foreground-hint">{formatMessage({ id: "settings.serverNotifications.muted" })}</span>
                : undefined,
              onClick: () => navigate(`${pathBase}/settings/server-notifications`),
            },
          ],
        }] : []),
        {
          label: formatMessage({ id: "layout.sidebar.settingsGroupServer" }),
          items: [
            { id: "server", label: formatMessage({ id: "settings.tabs.server" }), icon: <SidebarItemIcon><Building2 /></SidebarItemIcon>, onClick: () => navigate(`${pathBase}/settings/server`) },
            ...(raftBenchEnabled && canUseRaftBench(currentRole ?? undefined)
              ? [{ id: "raftbench", label: formatMessage({ id: "raftbench.nav" }), icon: <SidebarItemIcon><BenchIcon /></SidebarItemIcon>, onClick: () => navigate(`${pathBase}/raftbench`) }]
              : []),
            ...(canViewBillingSettings
              ? [{ id: "billing", label: formatMessage({ id: "settings.tabs.billingHeader" }), icon: <SidebarItemIcon><CreditCard /></SidebarItemIcon>, onClick: () => navigate(`${pathBase}/settings/billing`) }]
              : []),
            ...(canViewAdministrationSettings
              ? [{ id: "administration", label: formatMessage({ id: "settings.tabs.administration" }), icon: <SidebarItemIcon><Shield /></SidebarItemIcon>, onClick: () => navigate(`${pathBase}/settings/administration`) }]
              : []),
            ...(slackBridgeEnabled
              ? [{ id: "im-bridges", label: formatMessage({ id: "settings.tabs.imBridges" }), icon: <SidebarItemIcon><ArrowLeftRight /></SidebarItemIcon>, onClick: () => navigate(`${pathBase}/settings/im-bridges`) }]
              : []),
            ...(canViewApplicationsSettings && currentRole === "guest"
              // The server's Apps have their own page, the Rail's Apps (#proj-apps
              // task #22), and are not in Settings. A guest has no Apps page:
              // their Apps here holds only their own link previews.
              ? [{ id: "integrations", label: formatMessage({ id: "settings.tabs.integrations" }), icon: <SidebarItemIcon><AppWindow /></SidebarItemIcon>, onClick: () => navigate(`${pathBase}/settings/applications`) }]
              : []),
            ...(labsUiEnabled
              ? [{ id: "labs", label: formatMessage({ id: "settings.tabs.labs" }), icon: <SidebarItemIcon><FlaskConical /></SidebarItemIcon>, onClick: () => navigate(`${pathBase}/settings/labs`) }]
              : []),
            ...(providerConnectionsEnabled && canManageExternalAuth
              ? [{ id: "providers", label: formatMessage({ id: "settings.tabs.providers" }), icon: <SidebarItemIcon><KeyRound /></SidebarItemIcon>, onClick: () => navigate(`${pathBase}/settings/providers`) }]
              : []),
          ],
        },
        {
          label: formatMessage({ id: "layout.sidebar.settingsGroupAbout" }),
          items: [
            { id: "about", label: formatMessage({ id: "layout.sidebar.settingsAbout" }), icon: <SidebarItemIcon><BadgeInfo /></SidebarItemIcon>, onClick: () => navigate(`${pathBase}/settings/about`) },
            { id: "documentation", label: formatMessage({ id: "layout.sidebar.settingsDocumentation" }), icon: <SidebarItemIcon><BookOpenText /></SidebarItemIcon>, href: "https://docs.raft.build" },
            { id: "feedback", label: formatMessage({ id: "settings.about.feedbackTitle" }), icon: <SidebarItemIcon><FeedbackIcon /></SidebarItemIcon>, onClick: () => navigate(`${pathBase}/settings/feedback`) },
            { id: "release-notes", label: formatMessage({ id: "layout.sidebar.settingsReleaseNotes" }), icon: <SidebarItemIcon><FileText /></SidebarItemIcon>, onClick: () => navigate(`${pathBase}/release-notes`) },
            // A phone has no rail, so no Help menu and no side column for the shortcuts panel: a page instead.
            ...(mobileInline
              ? [{ id: "keyboard-shortcuts", label: formatMessage({ id: "layout.sidebar.settingsKeyboardShortcuts" }), icon: <SidebarItemIcon><Keyboard /></SidebarItemIcon>, onClick: () => navigate(`${pathBase}/keyboard-shortcuts`) }]
              : []),
          ],
        },
      ]
    : [], [
    canManageExternalAuth,
    canViewAdministrationSettings,
    canViewApplicationsSettings,
    canViewBillingSettings,
    currentRole,
    formatMessage,
    labsUiEnabled,
    mobileInline,
    raftBenchEnabled,
    navigate,
    pathBase,
    providerConnectionsEnabled,
    settingsServerMuted,
    settingsServerName,
    slackBridgeEnabled,
  ]);
  return {
    serverSlug, pathBase, isChannelSelected, isDmSelected, backToSettingsFromComputers, isMachineSelected,
    settingsTabFromPath, settingsSidebarGroups,
  };
}

export type SidebarRoute = ReturnType<typeof useSidebarRoute>;
