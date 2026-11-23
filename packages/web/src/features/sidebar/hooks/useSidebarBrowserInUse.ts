import { useCallback, useEffect, useMemo } from "react";
import { conversationFromPathname } from "../../../components/layout/sidebarChannelFocus";
import { setBrowserMarkable, useBrowserInUseStore } from "../../webPreview/browserInUseStore";
import type { BrowserInUse } from "../../webPreview/browserInUseStore";
import { sidebarItemConversationId, sidebarMarkableConversationIds, sidebarRowBrowserInUse, sidebarSectionBrowserInUse } from "../sidebarBrowserInUse";
import type { SidebarData } from "./useSidebarData";
import type { SidebarViewState } from "./useSidebarViewState";
import type { SidebarItems } from "./useSidebarItems";
import type { SidebarProjection } from "./useSidebarProjection";

/**
 * The browser mark of each row and folded section head (sidebarBrowserInUse.ts): what the built-in browser's kept
 * pages of a conversation off screen do (Raft Desktop; nothing elsewhere). Re-renders the Sidebar only when that
 * changes (a page starts or stops playing or using a device), never per message.
 *
 * It also says which conversations it can mark (setBrowserMarkable: every row's, a folded section's too), once its
 * rows are read, and none while the chat sections are not shown (the Settings or Computers sub-nav, Members) or once it unmounts: the shell
 * keeps a page using a device only for those (no mark anywhere, no page kept).
 */
export function useSidebarBrowserInUse(data: SidebarData, view: SidebarViewState, items: SidebarItems, projection: SidebarProjection) {
  const byOwner = useBrowserInUseStore((s) => s.byOwner);
  const current = conversationFromPathname(data.location.pathname)?.id ?? null;
  // oxlint-disable-next-line react-doctor/no-event-handler -- No handler sees this: what the sidebar lists (its rows read, a server switched, a DM closed, a channel left) is the event; the effect keeps the shell's markable list in step with it.
  const { agentDmChannelId } = items;
  // oxlint-disable-next-line react-doctor/no-event-handler -- As above: the sidebar's rows are the event the markable effect follows.
  const { sidebarDndDisplayItems, sidebarDndBaseProjection } = projection;
  /** A row's mark, by the conversation it opens. */
  const rowBrowserInUse = useCallback(
    (conversationId: string | null | undefined) => sidebarRowBrowserInUse(byOwner, conversationId, current),
    [byOwner, current],
  );
  /** Each section's (by its drag container id), for its head while folded. */
  const sectionBrowserInUse = useMemo(() => {
    const bySection: Record<string, BrowserInUse | null> = {};
    if (Object.keys(byOwner).length === 0) return bySection;
    for (const [containerId, itemIds] of Object.entries(sidebarDndBaseProjection)) {
      const conversationIds = itemIds.map((itemId) => {
        const item = sidebarDndDisplayItems.get(itemId);
        return item ? sidebarItemConversationId(item, agentDmChannelId) : null;
      });
      bySection[containerId] = sidebarSectionBrowserInUse(byOwner, conversationIds, current);
    }
    return bySection;
  }, [agentDmChannelId, byOwner, current, sidebarDndBaseProjection, sidebarDndDisplayItems]);
  // oxlint-disable-next-line react-doctor/no-event-handler -- As above: the sidebar's rows are the event the markable effect follows.
  const { sidebarOrderLoaded, channelsLoading, dmsLoading } = data;
  // oxlint-disable-next-line react-doctor/no-event-handler -- As above: the sidebar's rows are the event the markable effect follows.
  const { showSettingsRail, showComputersRail, showChatRail } = view;
  // The chat sections are what shows (Sidebar.tsx): not the Settings or Computers sub-nav, not Members.
  const chatShown = showChatRail && !showSettingsRail && !showComputersRail;
  // Null while the rows are still read (nothing said: the list before stands, as after a reload of this page).
  const markable = useMemo(() => {
    if (!chatShown) return [];
    if (!sidebarOrderLoaded || channelsLoading || dmsLoading) return null;
    return sidebarMarkableConversationIds(sidebarDndBaseProjection, sidebarDndDisplayItems, agentDmChannelId);
  }, [agentDmChannelId, channelsLoading, chatShown, dmsLoading, sidebarDndBaseProjection, sidebarDndDisplayItems, sidebarOrderLoaded]);
  useEffect(() => {
    if (markable) setBrowserMarkable(markable);
  }, [markable]);
  // No sidebar, no mark: none can be marked (the shell hears it after a short wait, so a remount says its own first).
  useEffect(() => () => setBrowserMarkable([]), []);
  return { rowBrowserInUse, sectionBrowserInUse };
}

export type SidebarBrowserInUseMarks = ReturnType<typeof useSidebarBrowserInUse>;
