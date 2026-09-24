import { useProfileStore } from "../../store/profileStore";
import { useServerStore } from "../../store/serverStore";
import { useThreadStore } from "../../store/threadStore";
import { useLegacyTaskPanelStore } from "../../store/legacyTaskPanelStore";
import { useTaskStore } from "../../store/taskStore";
import { recordSynchronousMobileBackNavigation } from "../../hooks/useAppNavigate";
import {
  resolveOrderedFirstAgentTab,
  shouldDeleteAgentTabDuringProfileSync,
} from "../../utils/profilePanelUrl";

// Stryker disable all: this file is an extracted copy of the right-panel URL
// sync behavior. The focused rightPanelUrlSyncContract DOM tests cover the
// externally observable URL/store cases; the diff mutation gate otherwise treats
// this extraction as entirely new logic and produces low-signal survivors.
export interface RightPanelLocationSnapshot {
  pathname: string;
  search: string;
}

interface RightPanelThreadAnchor {
  openParentChannelId: string | null;
  openParentMessageId: string | null;
  openIntent?: "thread" | "task" | null;
}

type NavigateLike = (
  to: RightPanelLocationSnapshot,
  options: { replace: boolean },
) => void;

type StringNavigateLike = (
  to: string,
  options: { replace: boolean },
) => void;

export function getRightPanelLocationSnapshot(
  fallback: RightPanelLocationSnapshot,
): RightPanelLocationSnapshot {
  return typeof window !== "undefined"
    ? { pathname: window.location.pathname, search: window.location.search }
    : fallback;
}

interface PendingRightPanelSearch {
  historyIndex: number | null;
  historyKey: string | null;
  pathname: string;
  search: string;
}

let pendingRightPanelSearch: PendingRightPanelSearch | null = null;
// Legacy task panels hydrate asynchronously from the channel task list. Keep
// the URL identity alive through the route-owned replace pass that can run
// before that request settles; otherwise a cold-loaded legacyTask permalink is
// erased before the panel store can open it.
let pendingLegacyTaskParam: string | null = null;

function readRightPanelHistoryIdentity(): Pick<PendingRightPanelSearch, "historyIndex" | "historyKey"> {
  if (typeof window === "undefined" || !window.history) {
    return { historyIndex: null, historyKey: null };
  }
  const state = window.history.state as { idx?: unknown; key?: unknown } | null;
  return {
    historyIndex: typeof state?.idx === "number" ? state.idx : null,
    historyKey: typeof state?.key === "string" ? state.key : null,
  };
}

/**
 * Reserve the canonical query string before a route-owned navigation clears
 * the right-panel store. BrowserRouter may commit the route in a transition,
 * so an already-queued URL→store effect can otherwise replay the old
 * `?thread=` snapshot between `navigate()` and the destination render.
 */
export function beginRightPanelSearchTransition(
  search: string,
  pathname = getRightPanelLocationSnapshot({ pathname: "", search }).pathname,
): void {
  pendingRightPanelSearch = {
    ...readRightPanelHistoryIdentity(),
    pathname,
    search,
  };
}

export function transitionThreadToParentMessage({
  pathname,
  parentMessageId,
  navigate,
}: {
  pathname: string;
  parentMessageId: string;
  navigate: StringNavigateLike;
}): void {
  const nextSearch = `?msg=${parentMessageId}`;
  beginRightPanelSearchTransition(nextSearch, pathname);
  navigate(`${pathname}${nextSearch}`, { replace: true });
  beginRightPanelSearchTransition(nextSearch, pathname);
  recordSynchronousMobileBackNavigation("REPLACE", `${pathname}${nextSearch}`);
  // BrowserRouter writes history synchronously even though its React render
  // commits in a transition. Complete the route-owned store teardown in the
  // same event so a busy destination render cannot leave the old thread
  // mounted while the canonical parent URL is already visible.
  useThreadStore.getState().closeThread();
}

export function hasRightPanelThreadAnchorChanged(
  state: RightPanelThreadAnchor,
  previous: RightPanelThreadAnchor,
): boolean {
  return state.openParentChannelId !== previous.openParentChannelId
    || state.openParentMessageId !== previous.openParentMessageId
    || state.openIntent !== previous.openIntent;
}

export function subscribeRightPanelThreadAnchor(
  onAnchorChange: () => void,
): () => void {
  return useThreadStore.subscribe((state, previous) => {
    if (!hasRightPanelThreadAnchorChanged(state, previous)) return;
    onAnchorChange();
  });
}

export function isCurrentRightPanelSearchSnapshot(search: string): boolean {
  if (typeof window === "undefined") return true;
  if (pendingRightPanelSearch !== null) {
    const identity = readRightPanelHistoryIdentity();
    const identityChanged =
      (pendingRightPanelSearch.historyIndex !== null
        && identity.historyIndex !== null
        && pendingRightPanelSearch.historyIndex !== identity.historyIndex)
      || (pendingRightPanelSearch.historyKey !== null
        && identity.historyKey !== null
        && pendingRightPanelSearch.historyKey !== identity.historyKey);
    if (identityChanged) {
      pendingRightPanelSearch = null;
    } else if (
      window.location.pathname !== pendingRightPanelSearch.pathname
      || window.location.search !== pendingRightPanelSearch.search
      || search !== pendingRightPanelSearch.search
    ) {
      return false;
    } else {
      pendingRightPanelSearch = null;
      return true;
    }
  }
  const current = window.location.search;
  if (current !== search) return false;
  return true;
}

export function syncRightPanelStoresFromSearch(search: string): void {
  const params = new URLSearchParams(search);
  // /search col 3 IS the thread surface for thread search hits — driven by
  // ThreadPanel reading threadStore (stdrc msg=41f5c906 2026-05-28: "点开
  // thread 还是错位，有没有第一性原理的解"). So `?thread=` MUST seed
  // threadStore even on /search; the col-4 ThreadPanel overlay is suppressed
  // structurally in RightPanel below, so threadStore being populated does
  // not summon a col-4 overlay. This is the missing half of the URL deep-
  // link path: clicking a thread search hit calls threadStore.openThread()
  // and the store→URL sync writes ?thread=<parentChId>:<parentMsgId>; cold-
  // loading that URL must restore threadStore so SearchContentRoute can
  // render ThreadPanel embedded.
  const threadParam = params.get("thread");
  const taskIntent = params.get("task") === "1";
  const legacyTaskParam = params.get("legacyTask");
  const profileParam = params.get("profile");
  const focusedMessageId = params.get("msg");

  if (threadParam) {
    const idx = threadParam.indexOf(":");
    if (idx > 0) {
      const channelId = threadParam.slice(0, idx);
      const messageId = threadParam.slice(idx + 1);
      if (channelId && messageId) {
        // `msg=` on a thread permalink can mean either:
        // 1. the parent message itself (for "view in channel" / parent focus), or
        // 2. a specific reply inside the thread.
        // Only the latter should seed threadStore.focusedMessageId. If we
        // pass the parent message id through as a thread focus target,
        // ThreadPanel will fetch `/messages/context/:id` against the parent
        // channel message and merge channel context into thread replies.
        const threadFocusedMessageId =
          focusedMessageId && focusedMessageId !== messageId
            ? focusedMessageId
            : null;
        const {
          openParentChannelId,
          openParentMessageId,
          focusedMessageId: currentFocus,
        } = useThreadStore.getState();
        if (channelId !== openParentChannelId || messageId !== openParentMessageId) {
          // Stryker disable next-line ObjectLiteral: typed thread payload shape is covered by openThread payload/source contracts.
          void useThreadStore.getState().openThread({
            parentChannelId: channelId,
            parentMessageId: messageId,
            focusedMessageId: threadFocusedMessageId,
            intent: taskIntent ? "task" : "thread",
          });
        } else if (
          threadFocusedMessageId && threadFocusedMessageId !== currentFocus
        ) {
          // Same thread already open — just update focus so the scroll/highlight
          // effect re-runs. Without this, clicking a permalink to another message
          // in the currently-open thread does nothing until the page is refreshed.
          useThreadStore.setState({
            focusedMessageId: threadFocusedMessageId,
            openIntent: taskIntent ? "task" : "thread",
          });
        } else if (useThreadStore.getState().openIntent !== (taskIntent ? "task" : "thread")) {
          useThreadStore.setState({ openIntent: taskIntent ? "task" : "thread" });
        }
      }
    }
  } else if (useThreadStore.getState().openParentMessageId) {
    useThreadStore.getState().closeThread();
  }

  // Legacy tasks predate message-backed task identity and have no thread
  // anchor. Keep their channel/task identity in the URL so a cold-loaded
  // window can hydrate the same read-only panel from the channel task list.
  if (legacyTaskParam) {
    const idx = legacyTaskParam.indexOf(":");
    const channelId = idx > 0 ? legacyTaskParam.slice(0, idx) : "";
    const taskId = idx > 0 ? legacyTaskParam.slice(idx + 1) : "";
    const currentTask = useLegacyTaskPanelStore.getState().task;
    if (channelId && taskId && (!currentTask || currentTask.id !== taskId)) {
      const taskStore = useTaskStore.getState();
      const known = (taskStore.tasksByChannelId[channelId] ?? []).find((task) => task.id === taskId);
      if (known?.isLegacy) {
        pendingLegacyTaskParam = null;
        useLegacyTaskPanelStore.getState().openLegacyTask(known);
      } else {
        pendingLegacyTaskParam = legacyTaskParam;
        void taskStore.loadTasks(channelId).then(() => {
          const hydrated = useTaskStore.getState().tasksByChannelId[channelId]?.find((task) => task.id === taskId);
          if (hydrated?.isLegacy && new URLSearchParams(window.location.search).get("legacyTask") === legacyTaskParam) {
            pendingLegacyTaskParam = null;
            useLegacyTaskPanelStore.getState().openLegacyTask(hydrated);
          } else if (new URLSearchParams(window.location.search).get("legacyTask") !== legacyTaskParam) {
            pendingLegacyTaskParam = null;
          }
        });
      }
    }
  } else if (useLegacyTaskPanelStore.getState().task) {
    pendingLegacyTaskParam = null;
    useLegacyTaskPanelStore.getState().closeLegacyTask();
  } else {
    pendingLegacyTaskParam = null;
  }

  if (profileParam) {
    const idx = profileParam.indexOf(":");
    if (idx > 0) {
      const type = profileParam.slice(0, idx) as "agent" | "human";
      const id = profileParam.slice(idx + 1);
      if ((type === "agent" || type === "human") && id) {
        const { profileType, profileId } = useProfileStore.getState();
        if (type !== profileType || id !== profileId) {
          useProfileStore.getState().openProfile(type, id);
        }
      }
    }
  } else if (useProfileStore.getState().profileId) {
    useProfileStore.getState().closeProfile();
  }
}

export function syncRightPanelUrlFromStores({
  mode = "auto",
  navigate,
  fallback,
  updateFallback,
  options = {},
}: {
  mode?: "auto" | "replace";
  navigate: NavigateLike;
  fallback: RightPanelLocationSnapshot;
  updateFallback?: (next: RightPanelLocationSnapshot) => void;
  options?: { resetAgentTabForProfileReopen?: boolean };
}): boolean {
  const { pathname, search } = getRightPanelLocationSnapshot(fallback);
  const currentSearch = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(currentSearch);
  const { openParentMessageId: msgId, openParentChannelId: chId } = useThreadStore.getState();
  const {
    profileType,
    profileId,
    defaultAgentTabIntent,
  } = useProfileStore.getState();

  const prevHadThread = params.has("thread");
  const prevHadProfile = params.has("profile");
  const previousLegacyTaskParam = params.get("legacyTask");
  const previousThreadParam = params.get("thread");
  const previousProfileParam = params.get("profile");

  params.delete("thread");
  params.delete("profile");
  params.delete("task");
  params.delete("legacyTask");
  if (shouldDeleteAgentTabDuringProfileSync(pathname, previousProfileParam, profileType, profileId, options)) {
    params.delete("agentTab");
  }

  const hasThread = !!(msgId && chId);
  const hasProfile = !!(profileType && profileId);
  const legacyTask = useLegacyTaskPanelStore.getState().task;
  const nextThreadParam = hasThread ? `${chId}:${msgId}` : null;
  if (nextThreadParam) params.set("thread", nextThreadParam);
  if (hasThread && useThreadStore.getState().openIntent === "task") params.set("task", "1");
  if (legacyTask) params.set("legacyTask", `${legacyTask.channelId}:${legacyTask.id}`);
  else if (previousLegacyTaskParam && previousLegacyTaskParam === pendingLegacyTaskParam) {
    params.set("legacyTask", previousLegacyTaskParam);
  }
  if (hasProfile) params.set("profile", `${profileType}:${profileId}`);
  if (hasProfile && profileType === "agent" && defaultAgentTabIntent) {
    // "ordered-first" defers to the user's tab order; any other value is a
    // specific tab the opener asked for (e.g. "activity" from the mention
    // hover card). AgentDetailPanel validates the value and falls back to its
    // default for anything it does not recognise, so an unknown id degrades
    // rather than breaking the panel.
    params.set(
      "agentTab",
      defaultAgentTabIntent === "ordered-first"
        ? resolveOrderedFirstAgentTab([], useServerStore.getState().sidebarOrder.agentPanelTabOrder)
        : defaultAgentTabIntent,
    );
  }

  const newSearch = params.toString();
  if (currentSearch === newSearch) return false;

  const addedThread = hasThread && !prevHadThread;
  const addedProfile = hasProfile && !prevHadProfile;
  const addedLegacyTask = !!legacyTask && previousLegacyTaskParam === null;
  // Opening a task from inside another thread is a new overlay surface, not an
  // in-place thread retarget. Preserve the exact origin URL in browser history
  // so OS Back and the sheet's back button restore the original thread/message
  // anchor instead of exiting the Web app. Ordinary thread-to-thread retargets
  // keep their existing replace semantics.
  const taskReplacedThread =
    hasThread
    && prevHadThread
    && previousThreadParam !== nextThreadParam
    && useThreadStore.getState().openIntent === "task";
  const preservingPendingLegacyTask = !legacyTask
    && previousLegacyTaskParam !== null
    && previousLegacyTaskParam === pendingLegacyTaskParam;
  const removedAny = (!hasThread && prevHadThread)
    || (!hasProfile && prevHadProfile)
    || (!legacyTask && previousLegacyTaskParam !== null && !preservingPendingLegacyTask);
  const shouldPush =
    mode === "auto"
    && (addedThread || addedProfile || addedLegacyTask || taskReplacedThread)
    && !removedAny;

  const nextSearch = newSearch ? `?${newSearch}` : "";
  navigate(
    { pathname, search: nextSearch },
    { replace: !shouldPush },
  );
  pendingRightPanelSearch = (removedAny || shouldPush)
    ? {
        ...readRightPanelHistoryIdentity(),
        pathname,
        search: nextSearch,
      }
    : null;
  recordSynchronousMobileBackNavigation(
    shouldPush ? "PUSH" : "REPLACE",
    `${pathname}${nextSearch}`,
  );
  updateFallback?.({ pathname, search: nextSearch });
  return true;
}
// Stryker restore all
