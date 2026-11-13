import { useCallback, useRef, useMemo } from "react";
import { trackNavEntrySelected } from "../../../analytics/navigation";
import { useMobileBack } from "../../../hooks/useAppNavigate";
import { useTabRootScroll } from "../../../hooks/useTabRootScroll";
import { DRAFTS_SECTION_FLAG_KEY, useServerFeatureFlag } from "../../../store/serverFeatureFlags";
import { useRememberedAssistantShown, useRememberedEntryShown } from "../../../components/layout/useRememberedSidebarEntry";
import type { SidebarData } from "./useSidebarData";
import type { SidebarViewState } from "./useSidebarViewState";
import type { SidebarRoute } from "./useSidebarRoute";

/* oxlint-disable react-hooks/exhaustive-deps -- the dependency arrays are the single Sidebar component's,
 * unchanged (#proj-frontend:#27). What the rule misses here are the useState setters and useRef objects
 * of earlier Sidebar hooks, which are stable across renders. */
/**
 * The phone Home bar's state (server switcher, Back on a pushed page) and the
 * Saved, Drafts and Assistant entries.
 */
export function useSidebarHomeEntries(mobileInline: boolean | undefined, data: SidebarData, view: SidebarViewState, route: SidebarRoute) {
  const { formatMessage, serverId, rowCountUserId, navigate, nav, location, sidebarScrollRef } = data;
  const { setShowServerMenu, railMode } = view;
  const { serverSlug, pathBase } = route;

  const closeServerMenu = useCallback(() => setShowServerMenu(false), []);
  // The phone workspace switcher hangs from the whole Home bar.
  const mobileHeadRef = useRef<HTMLDivElement | null>(null);
  // Phone tab roots have no large title (design lead + artin 2026-10-21, as
  // in the mobile app): only the 56px frame bar. Home is the one tab root
  // this sidebar draws. The Settings list is one of the server's own pages,
  // pushed from the server tab's popover (stdrc 2026-10-22): a paper head
  // with Back, which returns where the popover was opened (Home when the page
  // was opened cold). Members is such a page too, its own (MembersPage).
  const isServerPushedPage = Boolean(mobileInline) && railMode === "settings";
  // Home's root: a re-tap of its tab scrolls the list to the top, and it
  // keeps its scroll position across tab switches and pushes.
  const tabRoot = mobileInline && railMode === "chat" ? "chat" : null;
  useTabRootScroll(tabRoot, sidebarScrollRef);
  const backFromServerPage = useMobileBack(pathBase || "/");
  const backFromServerPageProps = useMemo(
    () => ({ "data-testid": "server-page-mobile-back", title: formatMessage({ id: "common.announcement.back" }) }),
    [formatMessage],
  );
  // Drafts is behind drafts_section_v0 (on for botiverse and raft): off, the
  // row is gone, and with it its count's draft lookups. Until the flag is read
  // the row shows if it did last time here, without its count.
  const draftsFlag = useServerFeatureFlag(DRAFTS_SECTION_FLAG_KEY);
  const draftsKnown = draftsFlag.state !== "loading";
  const draftsEnabled = draftsKnown && draftsFlag.enabled;
  const showDraftsEntry = useRememberedEntryShown(
    rowCountUserId,
    serverId,
    "drafts",
    draftsKnown ? draftsFlag.enabled : null,
    draftsFlag.state !== "undetermined",
  );
  const openDrafts = useCallback(() => {
    nav.toDrafts();
  }, [nav]);
  const openSaved = useCallback(() => {
    if (mobileInline) trackNavEntrySelected("saved", "mobile_home_shortcuts", false);
    else trackNavEntrySelected("saved", "sidebar", location.pathname.endsWith("/saved"));
    nav.toSaved();
  }, [location.pathname, mobileInline, nav]);
  // Until the assistant API answers, as last time here (useRememberedSidebarEntry).
  const showAssistantEntry = useRememberedAssistantShown();
  // Only the phone's Home shows this row (the rail has the desktop entry).
  const openAssistantEntry = useCallback(() => {
    trackNavEntrySelected("assistant", "mobile_home_shortcuts", false);
    if (serverSlug) navigate(`/s/${serverSlug}/assistant`);
  }, [navigate, serverSlug]);
  return {
    closeServerMenu, mobileHeadRef, isServerPushedPage, backFromServerPage, backFromServerPageProps,
    draftsEnabled, showDraftsEntry, openDrafts, openSaved, showAssistantEntry, openAssistantEntry,
  };
}

export type SidebarHomeEntriesState = ReturnType<typeof useSidebarHomeEntries>;
