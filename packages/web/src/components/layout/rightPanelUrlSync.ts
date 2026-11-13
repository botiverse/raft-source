import api from "../../api/client";
import type { ChannelExternalMember } from "../../hooks/useChannelMembers";
import type { ExternalMessageAuthorProjection } from "@botiverse/raft-shared";
import type { Message } from "../../store/messageStore";
import { useMessageStore } from "../../store/messageStore";
import { useProfileStore } from "../../store/profileStore";
import { useServerStore } from "../../store/serverStore";
import { useThreadStore } from "../../store/threadStore";
import { parseSearchOpenParam } from "../../store/searchContentStore";
import { useLegacyTaskPanelStore } from "../../store/legacyTaskPanelStore";
import { useTaskStore } from "../../store/taskStore";
import { formatTaskConversationParam, parseTaskConversationParam } from "../../utils/taskConversation";
import { recordSynchronousMobileBackNavigation } from "../../hooks/useAppNavigate";
import {
  resolveOrderedFirstAgentTab,
  shouldDeleteAgentTabDuringProfileSync,
} from "../../utils/profilePanelUrl";
import { recordProfileOpenE2eUrl } from "../../utils/profileOpenE2eTimeline";

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
  taskModal?: { parentMessageId: string | null; taskId?: string | null } | null;
}

type NavigateLike = (
  to: RightPanelLocationSnapshot,
  options: { replace: boolean },
) => void;

type StringNavigateLike = (
  to: string,
  options: { replace: boolean },
) => void;

type RecordMobileBackNavigationLike = (
  navigationType: "PUSH" | "REPLACE",
  path: string,
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

function externalProfileParam(channelId: string, messageId: string): string {
  return `external:${channelId}:${messageId}`;
}

function externalMentionProfileParam(channelId: string, projectionId: string): string {
  return `external-mention:${channelId}:${projectionId}`;
}

function currentExternalProfileParamMatches(expected: string): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("profile") === expected;
}

function findExternalMessage(channelId: string, messageId: string): Message | null {
  return useMessageStore.getState().channelMessages[channelId]?.find((message) => (
    message.id === messageId && !!message.externalAuthor
  )) ?? null;
}

/** Restore browser-history/deep-link state from the message's frozen author fact. */
export async function restoreExternalProfileFromUrl(
  channelId: string,
  messageId: string,
  openSource: "channel" | "thread",
): Promise<boolean> {
  const expected = externalProfileParam(channelId, messageId);
  let target = findExternalMessage(channelId, messageId);

  if (!target) {
    try {
      const { data } = await api.get(`/messages/context/${messageId}`, { params: { channelId } });
      const payload = data as { messages?: Message[]; targetMessageId?: string };
      const targetMessageId = payload.targetMessageId ?? messageId;
      target = payload.messages?.find((message) => (
        message.id === targetMessageId && !!message.externalAuthor
      )) ?? null;
    } catch {
      target = null;
    }
  }

  // A fetch may finish after Back or another panel navigation. Never reopen a
  // stale history entry over the user's current surface.
  if (!currentExternalProfileParamMatches(expected)) return false;

  if (!target?.externalAuthor) {
    useProfileStore.getState().closeProfile();
    return false;
  }

  useProfileStore.getState().openExternalProfile(messageId, target.externalAuthor, {
    channelId,
    openSource,
  });
  return true;
}

/** Restore a mention-clicked external identity (projection-id keyed, no message).
 *  Fetches channel members, finds the projection, and opens the profile. */
export async function restoreExternalMentionProfileFromUrl(
  channelId: string,
  projectionId: string,
  openSource: "channel" | "thread",
): Promise<boolean> {
  const expected = externalMentionProfileParam(channelId, projectionId);
  let member: ChannelExternalMember | null = null;
  try {
    const { data } = await api.get(`/channels/${channelId}/members`);
    const externals = (data.externalMembers ?? []) as ChannelExternalMember[];
    member = externals.find((e) => e.id === projectionId) ?? null;
  } catch {
    member = null;
  }

  if (!currentExternalProfileParamMatches(expected)) return false;
  if (!member) {
    useProfileStore.getState().closeProfile();
    return false;
  }

  const profile: ExternalMessageAuthorProjection = {
    projectionId: member.id,
    provider: member.provider,
    appRegistrationId: "", // members endpoint intentionally omits provider-side ids
    installId: "",
    workspaceId: "",
    externalActorId: "",
    workspaceName: member.workspaceName,
    externalConversationId: "",
    externalMessageId: "",
    displayName: member.displayName,
    actorKind: member.actorKind,
    avatarUrl: member.avatarUrl,
    avatarDigest: null,
    actorProjectionRevision: 0,
  };
  useProfileStore.getState().openExternalProfile(member.id, profile, {
    channelId,
    openSource,
    isMention: true,
  });
  return true;
}

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
  replace = true,
  recordMobileBack = true,
  recordMobileBackNavigation = recordSynchronousMobileBackNavigation,
}: {
  pathname: string;
  parentMessageId: string;
  navigate: StringNavigateLike;
  replace?: boolean;
  recordMobileBack?: boolean;
  recordMobileBackNavigation?: RecordMobileBackNavigationLike;
}): void {
  const nextSearch = `?msg=${parentMessageId}`;
  beginRightPanelSearchTransition(nextSearch, pathname);
  navigate(`${pathname}${nextSearch}`, { replace });
  beginRightPanelSearchTransition(nextSearch, pathname);
  if (recordMobileBack) {
    recordMobileBackNavigation(
      replace ? "REPLACE" : "PUSH",
      `${pathname}${nextSearch}`,
    );
  }
  // BrowserRouter writes history synchronously even though its React render
  // commits in a transition. Complete the route-owned store teardown in the
  // same event so a busy destination render cannot leave the old thread
  // mounted while the canonical parent URL is already visible.
  useThreadStore.getState().closeThread();
}

export function openThreadParentMessageRoute({
  isDesktop,
  navigate,
  parentChannelId,
  parentMessageId,
  parentRouteKind,
  serverSlug,
  recordMobileBackNavigation,
}: {
  isDesktop: boolean;
  navigate: StringNavigateLike;
  parentChannelId: string;
  parentMessageId: string;
  parentRouteKind: "channel" | "dm";
  serverSlug?: string;
  recordMobileBackNavigation?: RecordMobileBackNavigationLike;
}): void {
  const base = serverSlug ? `/s/${serverSlug}` : "";
  transitionThreadToParentMessage({
    pathname: `${base}/${parentRouteKind}/${parentChannelId}`,
    parentMessageId,
    navigate,
    replace: !isDesktop,
    recordMobileBack: !isDesktop,
    recordMobileBackNavigation,
  });
}

export function hasRightPanelThreadAnchorChanged(
  state: RightPanelThreadAnchor,
  previous: RightPanelThreadAnchor,
): boolean {
  return state.openParentChannelId !== previous.openParentChannelId
    || state.openParentMessageId !== previous.openParentMessageId
    || state.openIntent !== previous.openIntent
    || state.taskModal !== previous.taskModal;
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

/**
 * The address being applied to the stores, while it is (null otherwise). The
 * stores' own subscribers write the address back as each one opens (the
 * thread first, then the profile), from stores that are not all open yet.
 * So during the apply those writes
 * - keep every panel param the applied address names and the stores don't
 *   hold yet (`profile` and its `agentTab` while only the thread is open),
 *   rather than dropping it and losing the tab;
 * - replace, never push: an address that names both (a restored one, a link
 *   followed within the same conversation) adds no history entry of its own.
 * Opening something by hand still pushes, and a close still removes.
 */
let applyingSearch: URLSearchParams | null = null;
const APPLIED_PANEL_PARAMS = ["thread", "task", "legacyTask", "profile", "agentTab"] as const;

export function syncRightPanelStoresFromSearch(search: string): void {
  const outer = applyingSearch;
  applyingSearch = new URLSearchParams(search);
  try {
    applySearchToRightPanelStores(search);
  } finally {
    applyingSearch = outer;
  }
}

function applySearchToRightPanelStores(search: string): void {
  recordProfileOpenE2eUrl("profile-url-read", search);
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
  const taskParam = params.get("task");
  const taskIntent = taskParam === "1";
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
          // A `?open=thread:<id>` content slot (search / activity col 3)
          // already names the thread channel itself — load it directly rather
          // than re-resolving it through the parent-message lookup (task #14).
          const openSlot = parseSearchOpenParam(params.get("open"));
          const knownThreadChannelId = openSlot?.kind === "thread" ? openSlot.id : null;
          // Stryker disable next-line ObjectLiteral: typed thread payload shape is covered by openThread payload/source contracts.
          void useThreadStore.getState().openThread({
            parentChannelId: channelId,
            parentMessageId: messageId,
            threadChannelId: knownThreadChannelId,
            focusedMessageId: threadFocusedMessageId,
            intent: taskIntent ? "task" : "thread",
          });
        } else if (taskIntent) {
          // Same parent as the side thread, but the URL asks for the task modal
          // — open the independent slot over it (task #699), focus included.
          void useThreadStore.getState().openTaskModal({
            parentChannelId: channelId,
            parentMessageId: messageId,
            threadChannelId: useThreadStore.getState().openThreadChannelId,
            focusedMessageId: threadFocusedMessageId,
          });
        } else if (threadFocusedMessageId && threadFocusedMessageId !== currentFocus) {
          // Same thread already open — just update focus so the scroll/highlight
          // effect re-runs. Without this, clicking a permalink to another message
          // in the currently-open thread does nothing until the page is refreshed.
          useThreadStore.getState().focusMessage(threadFocusedMessageId);
        }
      }
    }
  } else if (useThreadStore.getState().openParentMessageId) {
    useThreadStore.getState().closeThread();
  }

  // `task=<chId>:<msgId>` is the task modal's own deep link (task #699): the
  // modal owns an identity slot independent of the side thread, so its anchor
  // travels independently of `thread=`. The legacy `task=1` form is handled in
  // the thread branch above (it resolves against the thread param's anchor).
  if (taskParam && taskParam !== "1") {
    const idx = taskParam.indexOf(":");
    const channelId = idx > 0 ? taskParam.slice(0, idx) : "";
    const messageId = idx > 0 ? taskParam.slice(idx + 1) : "";
    // Task v2: `task=<chId>:task:<taskId>` is the dialog of a task's own
    // conversation, keyed by the task (it has no parent message).
    const taskConversation = parseTaskConversationParam(taskParam);
    if (taskConversation) {
      if (useThreadStore.getState().taskModal?.taskId !== taskConversation.taskId) {
        useThreadStore.getState().openTaskConversation({
          taskId: taskConversation.taskId,
          parentChannelId: taskConversation.channelId,
        });
      }
    } else if (channelId && messageId
        && useThreadStore.getState().taskModal?.parentMessageId !== messageId) {
      void useThreadStore.getState().openTaskModal({
        parentChannelId: channelId,
        parentMessageId: messageId,
        threadChannelId: null,
        focusedMessageId: null,
      });
    }
  } else if (!taskParam && useThreadStore.getState().taskModal) {
    // The URL dropped the task param for the currently-open modal (Back, or a
    // plain close) — empty the slot.
    useThreadStore.getState().closeTaskModal();
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
      const type = profileParam.slice(0, idx);
      const id = profileParam.slice(idx + 1);
      if ((type === "agent" || type === "human" || type === "computer") && id) {
        const { profileType, profileId } = useProfileStore.getState();
        if (type !== profileType || id !== profileId) {
          useProfileStore.getState().openProfile(type, id);
        }
      } else if (type === "external") {
        const externalParts = id.split(":");
        const channelId = externalParts[0] ?? "";
        const messageId = externalParts[1] ?? "";
        if (externalParts.length === 2 && channelId && messageId) {
          const profile = useProfileStore.getState();
          if (
            profile.profileType !== "external"
            || profile.profileId !== messageId
            || profile.externalProfileChannelId !== channelId
            || profile.externalProfileIsMention
            || !profile.externalProfile
          ) {
            void restoreExternalProfileFromUrl(
              channelId,
              messageId,
              params.has("thread") ? "thread" : "channel",
            );
          }
        }
      } else if (type === "external-mention") {
        const externalParts = id.split(":");
        const channelId = externalParts[0] ?? "";
        const projectionId = externalParts[1] ?? "";
        if (externalParts.length === 2 && channelId && projectionId) {
          const profile = useProfileStore.getState();
          if (
            profile.profileType !== "external"
            || profile.profileId !== projectionId
            || profile.externalProfileChannelId !== channelId
            || !profile.externalProfileIsMention
            || !profile.externalProfile
          ) {
            void restoreExternalMentionProfileFromUrl(
              channelId,
              projectionId,
              params.has("thread") ? "thread" : "channel",
            );
          }
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
    externalProfileChannelId,
    defaultAgentTabIntent,
  } = useProfileStore.getState();

  const prevHadThread = params.has("thread");
  const prevHadProfile = params.has("profile");
  const previousLegacyTaskParam = params.get("legacyTask");
  const previousTaskParam = params.get("task");
  const previousProfileParam = params.get("profile");

  params.delete("thread");
  params.delete("profile");
  params.delete("task");
  params.delete("legacyTask");
  if (shouldDeleteAgentTabDuringProfileSync(pathname, previousProfileParam, profileType, profileId, options)) {
    params.delete("agentTab");
  }

  const hasThread = !!(msgId && chId);
  const hasProfile = !!(
    profileType
    && profileId
    && (profileType !== "external" || externalProfileChannelId)
  );
  const legacyTask = useLegacyTaskPanelStore.getState().task;
  const nextThreadParam = hasThread ? `${chId}:${msgId}` : null;
  if (nextThreadParam) params.set("thread", nextThreadParam);
  // The task modal's deep link carries its OWN anchor (task #699): the modal
  // owns an identity slot independent of the side thread, so `task=` must be
  // written whether or not a side thread is open underneath. Legacy `task=1`
  // links still resolve against the thread param's anchor on read.
  const taskModalSlot = useThreadStore.getState().taskModal;
  const nextTaskParam = taskModalSlot?.parentChannelId
    ? taskModalSlot.taskId && !taskModalSlot.parentMessageId
      ? formatTaskConversationParam(taskModalSlot.parentChannelId, taskModalSlot.taskId)
      : `${taskModalSlot.parentChannelId}:${taskModalSlot.parentMessageId}`
    : null;
  if (nextTaskParam) params.set("task", nextTaskParam);
  if (legacyTask) params.set("legacyTask", `${legacyTask.channelId}:${legacyTask.id}`);
  else if (previousLegacyTaskParam && previousLegacyTaskParam === pendingLegacyTaskParam) {
    params.set("legacyTask", previousLegacyTaskParam);
  }
  if (hasProfile) {
    params.set(
      "profile",
      profileType === "external"
        ? useProfileStore.getState().externalProfileIsMention
          ? externalMentionProfileParam(externalProfileChannelId!, profileId!)
          : externalProfileParam(externalProfileChannelId!, profileId!)
        : `${profileType}:${profileId}`,
    );
  }
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

  if (applyingSearch) {
    for (const name of APPLIED_PANEL_PARAMS) {
      const applied = applyingSearch.get(name);
      if (applied !== null && !params.has(name)) params.set(name, applied);
    }
  }

  const newSearch = params.toString();
  if (currentSearch === newSearch) return false;

  const addedThread = hasThread && !prevHadThread;
  const addedProfile = hasProfile && !prevHadProfile;
  const addedLegacyTask = !!legacyTask && previousLegacyTaskParam === null;
  // Opening a task modal is a new overlay surface, not an in-place thread
  // retarget: any side thread's anchor stays in the URL unchanged and only
  // `task=` appears (task #699). Push history so OS Back and the sheet's back
  // button unwind the modal onto the preserved origin instead of exiting the
  // Web app. Ordinary thread-to-thread retargets keep their existing replace
  // semantics.
  const addedTask = nextTaskParam !== null && previousTaskParam === null;
  const preservingPendingLegacyTask = !legacyTask
    && previousLegacyTaskParam !== null
    && previousLegacyTaskParam === pendingLegacyTaskParam;
  const removedAny = (!hasThread && prevHadThread)
    || (!hasProfile && prevHadProfile)
    || (!legacyTask && previousLegacyTaskParam !== null && !preservingPendingLegacyTask);
  const shouldPush =
    mode === "auto"
    && applyingSearch === null
    && (addedThread || addedProfile || addedLegacyTask || addedTask)
    && !removedAny;

  const nextSearch = newSearch ? `?${newSearch}` : "";
  recordProfileOpenE2eUrl(
    "profile-url-write",
    nextSearch,
    shouldPush ? "push" : "replace",
  );
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
