import {
  locateMessageInOpenConversation,
  openThreadParentMessageRoute,
  threadParentConversationPath,
} from "../../components/layout/rightPanelUrlSync";
import { restoreRowExpand, threadExpandedNow, useRowPlanStore } from "../../components/layout/rowPlanStore";
import type { ThreadHeaderOriginal } from "./threadHeaderTitle";

type Navigate = Parameters<typeof openThreadParentMessageRoute>[0]["navigate"];

/**
 * The thread head's place name and its ⋯ View in channel (raft-design conversation.md, Threads; #proj-chat:#31 v3):
 * open the parent conversation scrolled to the message the thread started from, with the located highlight.
 * - In Focus Mode the row is restored first, then the message located.
 * - Beside its own conversation on a desktop, the thread stays open: the conversation is already there, so the
 *   message is located in it in place (a new highlightNonce each time, so every press restarts the highlight).
 *   Not where the thread covers the conversation (a narrow row folds it over the conversation's column, #189
 *   rule 3): the highlight would land under the thread, so the route takes it there.
 *   A parent behind the plan's history window is located the same way: the conversation's context load stops at
 *   the history paywall (messageStore.loadMessageContext), as the `?msg=` route does.
 * - Anywhere else (a phone, Activity, Search, a window of its own), the conversation's `?msg=` route, as before.
 * - A deleted parent has nothing to locate: the conversation opens alone. One the person can't see isn't offered.
 */
export function openThreadParentInConversation({
  original,
  isDesktop,
  presentation,
  currentPathname,
  parentChannelId,
  parentMessageId,
  parentRouteKind,
  serverSlug,
  navigate,
  nextFrame = requestAnimationFrame,
}: {
  original: ThreadHeaderOriginal | null;
  isDesktop: boolean;
  presentation: "side" | "modal" | "mobile-modal";
  currentPathname: string;
  parentChannelId: string;
  parentMessageId: string;
  parentRouteKind: "channel" | "dm";
  serverSlug?: string;
  navigate: Navigate;
  nextFrame?: (callback: () => void) => unknown;
}): void {
  if (original?.state === "unavailable") return;
  const locate = original?.state !== "deleted";
  // Focus Mode (the thread's Expand): the normal row first, so the conversation has its width when it scrolls.
  const restored = threadExpandedNow();
  if (restored) restoreRowExpand();
  const pathname = threadParentConversationPath({ parentChannelId, parentRouteKind, serverSlug });
  if (isDesktop && presentation === "side" && currentPathname === pathname && !threadCoversConversation()) {
    if (!locate) return;
    // The row applies the restore a render later (rowPlanStore): locate once it has, two frames on.
    if (restored) nextFrame(() => nextFrame(() => locateMessageInOpenConversation(parentChannelId, parentMessageId)));
    else locateMessageInOpenConversation(parentChannelId, parentMessageId);
    return;
  }
  openThreadParentMessageRoute({
    isDesktop,
    parentRouteKind,
    parentChannelId,
    parentMessageId: locate ? parentMessageId : null,
    serverSlug,
    navigate,
  });
}

/**
 * The side thread lies over its conversation: the row plan folds it into the conversation's column (#189 rule 3);
 * the column's own `data-covers` (rowLayout, MainLayout) answers where no plan lays the row out, and beside the
 * keyboard shortcuts panel, where the plan leaves the attribute to MainLayout.
 */
export function threadCoversConversation(): boolean {
  if (useRowPlanStore.getState().plan?.fold) return true;
  return typeof document !== "undefined" && document.querySelector(".thread-side-column[data-covers]") !== null;
}
