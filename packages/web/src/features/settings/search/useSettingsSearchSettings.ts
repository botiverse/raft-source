import { useMemo } from "react";
import { useIntl } from "react-intl";
import { PUBLIC_SERVER_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { useLocale } from "../../../i18n/LocaleProvider";
import type { MessageId } from "../../../i18n/messages/en";
import { useServerPermissions } from "../../../hooks/useServerPermissions";
import { useServerFeatureFlag } from "../../../store/serverFeatureFlags";
import { useServerStore } from "../../../store/serverStore";
import { isElectronDesktopShell } from "../../../utils/desktopShell";
import { useServerSsoShown } from "../sso/useServerSsoShown";
import { SETTINGS_TAB_TITLE_ID, settingsTabIdForRouteSlug } from "../../../components/settings/settingsNavigation";
import { SETTINGS_SEARCH_COPY, settingsSearchEntriesFor } from "./settingsSearchCopy";
import { settingsSearchAliases } from "./settingsSearchMatch";
import type { SearchableSetting } from "./settingsSearchMatch";

/** The pages on the server, named after it as the list's rows are for a screen reader. */
const SERVER_PAGE_TITLE_ID: Readonly<Partial<Record<string, MessageId>>> = {
  theme: "settings.appearance.serverThemeLinkTitle",
  "server-notifications": "settings.notifications.serverLinkTitle",
};

/**
 * The settings this person can find, in the words of the display language and
 * in the list's order: those on the pages the list shows them (`visiblePages`,
 * its row ids in order), less the ones a page leaves out for them (a flag that
 * is off, a role that can't, the desktop app). `searching`: a query is typed;
 * a section the page shows only once a read answers (SSO) is asked then.
 */
export function useSettingsSearchSettings(visiblePages: readonly string[], searching: boolean): SearchableSetting[] {
  const { formatMessage } = useIntl();
  const { locale } = useLocale();
  const serverName = useServerStore((s) => s.current?.name ?? "");
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const { role, capabilities } = useServerPermissions();
  const publicServer = useServerFeatureFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY).enabled;
  const sso = useServerSsoShown(serverId, searching && capabilities.editServerSettings && visiblePages.includes("administration"));

  return useMemo(() => {
    const desktopApp = isElectronDesktopShell();
    // What each page shows only to some people, as the page itself decides it.
    const shown: Readonly<Partial<Record<string, boolean>>> = {
      "public-access": role === "owner" && publicServer,
      "leave-server": role !== null && role !== "owner",
      "invite-links": capabilities.inviteMembers,
      "single-sign-on": capabilities.editServerSettings && sso,
      "desktop-app": !desktopApp,
    };
    const values = { serverName };
    const text = (id: MessageId | undefined) => (id ? formatMessage({ id }, values) : undefined);
    const pageOrder = new Map(visiblePages.map((page, index) => [page, index]));
    const settings: SearchableSetting[] = [];
    for (const entry of settingsSearchEntriesFor(desktopApp ? "desktop" : "web")) {
      const copy = SETTINGS_SEARCH_COPY[entry.id];
      const { page } = entry;
      const tab = settingsTabIdForRouteSlug(page);
      if (!copy || !tab || !pageOrder.has(page) || shown[entry.id] === false) continue;
      const desktopCard = desktopApp && entry.id === "push-notifications";
      settings.push({
        id: entry.id,
        page,
        name: formatMessage({ id: desktopCard ? "settings.notifications.desktop.title" : copy.nameId }, values),
        description: desktopCard ? undefined : text(copy.descriptionId),
        pageLabel: formatMessage({ id: SERVER_PAGE_TITLE_ID[page] ?? SETTINGS_TAB_TITLE_ID[tab] }, values),
        sectionLabel: text(copy.sectionId),
        aliases: settingsSearchAliases(entry.aliases, locale),
      });
    }
    // The list's order: by page as the list shows them, then the index's.
    return settings
      .map((setting, index) => ({ setting, index }))
      .sort((a, b) => (pageOrder.get(a.setting.page) ?? 0) - (pageOrder.get(b.setting.page) ?? 0) || a.index - b.index)
      .map(({ setting }) => setting);
  }, [capabilities.editServerSettings, capabilities.inviteMembers, formatMessage, locale, publicServer, role, serverName, sso, visiblePages]);
}
