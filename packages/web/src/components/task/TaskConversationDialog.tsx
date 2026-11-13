import { Suspense, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft, ArrowRight, ChevronDown, X } from "lucide-react";
import type { KeyboardEvent, MutableRefObject, ReactNode } from "react";
import {
  DialogSurface,
  DropdownMenuItem,
  PanelAction,
  PanelActions,
  PanelHeader as PanelHead,
  ScrollArea,
} from "@botiverse/raft-ui";
import { ThreadIcon } from "@botiverse/ricons";

import api from "../../api/client";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useChannelStore } from "../../store/channelStore";
import { selectChannelMessageBucket, useMessageStore } from "../../store/messageStore";
import type { Message } from "../../store/messageStore";
import { useProfileStore } from "../../store/profileStore";
import { useServerStore } from "../../store/serverStore";
import type { Task } from "../../store/taskStore";
import { isTaskConversationFollowed, useThreadStore } from "../../store/threadStore";
import { resolveMessageSenderMemberFromList } from "../../utils/messageSenderMember";
import { openConversationAgentProfile } from "../../utils/profilePanelUrl";
import { useDetailSlotThreadOpener } from "../layout/detailSlotThread";
import { FOLLOWERS_HEAD_WIDTH, shownOwnActions, useHeadWidth } from "../layout/headFit";
import { ExpandToggleAction } from "../layout/RowExpandAction";
import { useThreadAgentFollowerStore } from "../../store/threadAgentFollowerStore";
import { formatTaskConversationRef, taskSourceDisplay } from "../../utils/taskConversation";
import InlineMarkdownPreview from "../markdown/InlineMarkdownPreview";
import ThreadOverflowMenu from "../message/ThreadOverflowMenu";
import type { ConversationFollowCommand } from "../message/ThreadOverflowMenu";
import { ThreadPanel } from "../../features/thread/ThreadPanel";
import { buildThreadParentContextRequest } from "../message/messageContextRequest";
import AvatarSlot from "../ui/AvatarSlot";
import ThreadAgentFollowers from "../thread/ThreadAgentFollowers";
import EmptyState from "../ui/EmptyState";
import { SkeletonTextBar } from "../ui/Skeleton";

import { StatusBadge, TASK_STATUS_UI } from "./StatusBadge";
import { useTaskAssigneeIdentity } from "./TaskAssignee";
import TaskHeadPullDown from "./TaskHeadPullDown";
import TaskModalHead, { TaskModalHeadSkeleton } from "./TaskModalHead";
import { BAR_LABEL_CLASS, BAR_NAME_CLASS, BAR_REF_CLASS } from "./taskConversationBarClasses";
import { useTaskDeleteMenu } from "./TaskDeleteMenu";
import { PropertyRow } from "./TaskProperties";
import { TaskFocusContext } from "./tasksPage/taskFocus";
import { useTaskConversationTask } from "./useTaskConversationTask";
import { useTaskProfileStack } from "./useTaskProfileStack";
import { lazyPanel } from "../../boot/deferredUi";
import type { ProfilePanelProps } from "../profile/ProfilePanel";

const ProfilePanel = lazyPanel<ProfilePanelProps>(() => import("../profile/ProfilePanel"));

/**
 * Task v2: the task dialog (reply-design §6, kept as a centered dialog).
 *
 * The task owns its conversation (channels.type = 'task'), so the dialog is
 * keyed by the task, not by a message: the bar names the task by its ref, the
 * head holds the title, the description and the properties (Status, Assignee,
 * Source, Created by, Created at; "Earlier discussion" for a pre-v2 task), and
 * the timeline below is the conversation itself — lifecycle lines as compact
 * event rows between the replies — with the thread composer (mentions,
 * attachments) at the bottom. ThreadPanel renders that timeline: it is a
 * sub-conversation surface, and a task conversation is one without a parent
 * message (`threadIdentity.parentTaskId`).
 *
 * A task without its own conversation yet (created lazily, like a thread
 * before its first reply; or a pre-v2 task) opens empty, its composer ready;
 * the first send, Follow or Unfollow creates the conversation (POST
 * /tasks/:id/conversation, via threadStore.ensureTaskModalThreadChannel) and
 * the dialog moves onto it. One created elsewhere (an agent's reply, a
 * lifecycle line) arrives on the task (`task:updated`) and is bound below.
 * The Agent followers, typing and read position need the conversation and
 * wait for it, as a thread's do before its first reply.
 *
 * An avatar (a sender's, a mention's, the assignee's) opens that person's or
 * agent's profile here, beside the conversation, as it does in a channel or
 * a thread: the app's own profile panel sits behind this dialog (and a task
 * window has none), so the dialog keeps its profile as an embedded page stack,
 * as the channel members page does. Where the dialog is narrower than a
 * conversation and a panel side by side, the profile covers it, with Back.
 */
export default function TaskConversationDialog({ presentation, onClose, page = false, appProfiles = false }: {
  presentation: "modal" | "mobile-modal";
  onClose: () => void;
  /** A `_blank` task window (ThreadWindowRoute): the content fills the page,
   *  with no dialog frame; × closes the window. */
  page?: boolean;
  /** In Activity's or Search's detail slot (TaskContentSlot): a person opens
   *  the app's profile panel beside it, as in a thread there, not its own. */
  appProfiles?: boolean;
}) {
  const slot = useThreadStore((s) => s.taskModal);
  // Leaving for a message (Source, Earlier discussion) empties the slot
  // directly: the route change that follows owns the history entry.
  const leave = useThreadStore((s) => s.closeTaskModal);
  const bindTaskConversationChannel = useThreadStore((s) => s.bindTaskConversationChannel);
  const task = useTaskConversationTask({ taskId: slot?.taskId ?? null, parentChannelId: slot?.parentChannelId ?? null });
  const channelIsJoint = useChannelStore((s) => (task ? s.channels.find((c) => c.id === task.channelId)?.type === "joint" : false));
  const conversationChannelId = slot?.threadChannelId ?? null;

  // The task DTO names its CANONICAL conversation. Outside a joint channel that
  // is the local one too; a joint channel's local conversation is answered by
  // the (idempotent) ensure endpoint, which only runs for a task that already
  // has a conversation — opening never creates one.
  const canonicalConversationId = task?.conversationChannelId ?? null;
  const joint = task?.channelType === "joint" || channelIsJoint;
  useEffect(() => {
    if (!task || conversationChannelId || !canonicalConversationId) return;
    if (!joint) {
      bindTaskConversationChannel(task.id, canonicalConversationId);
      return;
    }
    let cancelled = false;
    api.post(`/tasks/${task.id}/conversation`)
      .then(({ data }) => {
        const local = (data as { conversationChannelId?: unknown } | null)?.conversationChannelId;
        if (!cancelled && typeof local === "string" && local) bindTaskConversationChannel(task.id, local);
      })
      .catch((err: unknown) => console.error("Failed to resolve the task conversation:", err));
    return () => {
      cancelled = true;
    };
  }, [bindTaskConversationChannel, canonicalConversationId, conversationChannelId, joint, task]);

  // The timeline's ThreadPanel owns the in-conversation search; the bar's
  // More menu runs it through this ref (Search in Task).
  const searchCommandRef = useRef<(() => void) | null>(null);
  const mobile = presentation === "mobile-modal";
  // On a phone the head scrolls away with the conversation; while it is out
  // of view the bar carries the task's status and pulls the head down over
  // the messages.
  const [headInView, setHeadInView] = useState(true);
  const [headPanelOpen, setHeadPanelOpen] = useState(false);
  const onHeadInViewChange = useCallback((inView: boolean) => {
    setHeadInView(inView);
    // Back in the list, the head needs no panel.
    if (inView) setHeadPanelOpen(false);
  }, []);
  const closeHeadPanel = useCallback(() => setHeadPanelOpen(false), []);
  const profiles = useTaskProfileStack(slot?.taskId ?? null);
  const { profile, close: closeProfile } = profiles;
  const taskChannelId = task?.channelId ?? null;
  const openAppProfileInTask = useCallback((kind: "agent" | "human", id: string) => openAppProfile(kind, id, taskChannelId), [taskChannelId]);
  const openProfile = appProfiles ? openAppProfileInTask : profiles.open;
  // Escape where the dialog is not the desktop task dialog (a phone, a window); in that dialog,
  // focus anywhere, its onClose asks the profile first (useTaskProfileStack).
  const onKeyDown = useCallback((event: KeyboardEvent) => {
    if (!profile || event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    closeProfile();
  }, [closeProfile, profile]);
  const conversation = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="task-conversation-dialog" data-task-id={slot?.taskId ?? undefined}>
      {task ? (
        <>
          <TaskConversationBar
            task={task}
            conversationChannelId={conversationChannelId}
            onClose={onClose}
            onLeave={leave}
            mobile={mobile}
            searchCommandRef={searchCommandRef}
            headInView={headInView}
            headPanelOpen={headPanelOpen}
            onHeadPanelOpenChange={setHeadPanelOpen}
            onOpenProfile={openProfile}
          />
          <TaskConversationTimeline
            task={task}
            presentation={presentation}
            page={page}
            conversationChannelId={conversationChannelId}
            focusedMessageId={slot?.focusedMessageId ?? null}
            focusNonce={slot?.focusNonce ?? 0}
            onLeave={leave}
            appProfiles={appProfiles}
            searchCommandRef={searchCommandRef}
            onHeadInViewChange={onHeadInViewChange}
            onMessagesScrollStart={headPanelOpen ? closeHeadPanel : undefined}
            onOpenProfile={openProfile}
          />
        </>
      ) : (
        <TaskConversationLoading onClose={onClose} mobile={mobile} />
      )}
    </div>
  );
  const body = (
    <div className="@container/task-dialog relative flex min-h-0 flex-1" onKeyDown={onKeyDown}>
      {conversation}
      {profile ? (
        <div
          className="absolute inset-0 z-cover flex min-h-0 flex-col bg-layer-canvas @min-[720px]/task-dialog:static @min-[720px]/task-dialog:w-[400px] @min-[720px]/task-dialog:shrink-0 @min-[720px]/task-dialog:border-l @min-[720px]/task-dialog:border-line-hairline"
          data-testid="task-conversation-profile"
        >
          <Suspense fallback={null}>
            <ProfilePanel
              key={`${profile.type}:${profile.id}`}
              target={profile}
              channelId={taskChannelId}
              presentation="embedded"
              // Back for a profile opened from another, as on the members
              // page; off a phone the first one has only ×. On a phone it has
              // Back too, which returns to the conversation: the panel's own
              // phone Back would step the browser's history, out of the dialog.
              onBack={profiles.stack.length > 1 ? profiles.back : mobile ? closeProfile : undefined}
              onClose={closeProfile}
              onOpenProfile={profiles.openNested}
            />
          </Suspense>
        </div>
      ) : null}
    </div>
  );

  if (page) {
    return <div className="flex h-full min-h-0 w-full flex-col bg-layer-canvas" data-testid="task-conversation-window">{body}</div>;
  }
  if (mobile) {
    return <div className="absolute inset-0 z-cover flex flex-col bg-layer-canvas" data-testid="task-thread-modal">{body}</div>;
  }
  return (
    <DialogSurface
      className="h-[min(86vh,900px)] max-h-[calc(100dvh-2rem)] w-[min(960px,calc(100vw-2rem))]"
      data-testid="task-thread-modal"
    >
      {body}
    </DialogSurface>
  );
}

/** The app's profile panel (RightPanel, `?profile=`), opened as from a thread's message. */
function openAppProfile(kind: "agent" | "human", id: string, channelId: string | null) {
  const { openProfile } = useProfileStore.getState();
  if (kind === "agent") openConversationAgentProfile(openProfile, id, { openSource: "thread" });
  else openProfile("human", id, { openSource: "thread", channelId });
}

function TaskConversationLoading({ onClose, mobile }: { onClose: () => void; mobile: boolean }) {
  const { formatMessage } = useIntl();
  return (
    <>
      <PanelHead>
        {mobile ? (
          <PanelAction onClick={onClose} aria-label={formatMessage({ id: "task.modal.close" })} data-testid="task-modal-mobile-back">
            <ArrowLeft />
          </PanelAction>
        ) : null}
        <div className={BAR_NAME_CLASS} aria-hidden="true" data-testid="task-modal-bar-loading">
          <div className={BAR_REF_CLASS}><SkeletonTextBar className="w-28" /></div>
          <div className={BAR_LABEL_CLASS}><SkeletonTextBar className="w-16" /></div>
        </div>
        {!mobile ? (
          <PanelActions>
            <PanelAction onClick={onClose} aria-label={formatMessage({ id: "task.modal.close" })} data-testid="task-modal-close">
              <X />
            </PanelAction>
          </PanelActions>
        ) : null}
      </PanelHead>
      {/* As the loaded head: on a phone it is the conversation's first row, no rule under it. */}
      <TaskModalHeadSkeleton divider={!mobile} />
    </>
  );
}

/**
 * The bar: the task's ref (`#channel:#7`), then the actions in the thread
 * panel's order — the Agent followers (removable by the task's creator or a
 * channel manager), the More menu (the thread's rows, in its order: Search in
 * Task, View in Channel, Follow / Unfollow Task), and the way out.
 */
function TaskConversationBar({ task, conversationChannelId, onClose, onLeave, mobile, searchCommandRef, headInView, headPanelOpen, onHeadPanelOpenChange, onOpenProfile }: {
  task: Task;
  conversationChannelId: string | null;
  onClose: () => void;
  onLeave: () => void;
  mobile: boolean;
  searchCommandRef: MutableRefObject<(() => void) | null>;
  /** Whether the head is on screen (always, off a phone: it stays put there). */
  headInView: boolean;
  /** The head pulled down over the messages (a phone, once it has scrolled away). */
  headPanelOpen: boolean;
  onHeadPanelOpenChange: (open: boolean) => void;
  onOpenProfile: (kind: "agent" | "human", id: string) => void;
}) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const dmPeerName = useChannelStore((s) => (task.channelType === "dm"
    ? s.dmChannels.find((c) => c.id === task.channelId)?.peerName ?? null
    : null));
  const follow = useTaskConversationFollow(task, conversationChannelId);
  const deleteMenu = useTaskDeleteMenu(task, onClose);
  const ref = formatTaskConversationRef({
    taskNumber: task.taskNumber,
    channelName: task.channelName,
    channelType: task.channelType,
    dmPeerName,
  });
  // Search in Task: there is nothing to search before the conversation exists
  // (the row is omitted, as a thread's rows are without their anchor).
  const search = useCallback(() => searchCommandRef.current?.(), [searchCommandRef]);
  // View in Channel: leave the dialog for the task's place in its channel —
  // the message it hangs under (its source, or a pre-v2 task's host), or the
  // channel itself for a task created without one (its Tasks card).
  const viewInChannel = useCallback(() => {
    const anchorId = task.sourceMessageId ?? task.hostMessageId ?? null;
    onLeave();
    if (task.channelType === "dm") {
      if (anchorId) nav.toDmMessage(task.channelId, anchorId);
      else nav.toDm(task.channelId);
    } else if (anchorId) {
      nav.toMessage(task.channelId, anchorId);
    } else {
      nav.toChannel(task.channelId);
    }
  }, [nav, onLeave, task.channelId, task.channelType, task.hostMessageId, task.sourceMessageId]);
  const label = formatMessage({ id: "task.modal.taskWithNumber" }, { taskNumber: task.taskNumber });
  // The head has scrolled away (a phone): the bar names the task's state, and
  // selecting it pulls the head down over the messages (Kirby, for artin,
  // #proj-mobile:75baab6e). Scrolling back up to it lost the reader's place.
  const summarized = mobile && !headInView;
  const panelOpen = summarized && headPanelOpen;
  const panelId = useId();
  const summaryRef = useRef<HTMLButtonElement>(null);
  const closePanel = useCallback(() => onHeadPanelOpenChange(false), [onHeadPanelOpenChange]);
  // Beside the Tasks list, its Expand (the thread's Focus Mode; TasksRoute).
  const focus = useContext(TaskFocusContext);
  // The head always fits (#189 rule 6), as the thread's: in a narrow column the followers fold into ⋯.
  const [measure, headWidth, headElement] = useHeadWidth();
  const roster = useThreadAgentFollowerStore((state) => (conversationChannelId ? state.rosters[conversationChannelId] : undefined));
  const hasFollowers = !!roster && (roster.error || (roster.loaded && roster.agents.length > 0));
  const followersShown = shownOwnActions({ width: mobile ? 0 : headWidth, lead: 0, own: hasFollowers ? [FOLLOWERS_HEAD_WIDTH] : [], controls: (focus ? 1 : 0) + (mobile ? 0 : 1), menuItems: 1 }) > 0;
  const [followersOpen, setFollowersOpen] = useState(false);
  const openFollowers = useCallback(() => setFollowersOpen(true), []);
  const foldedFollowers = useMemo(() => (followersShown ? undefined : { open: followersOpen, onOpenChange: setFollowersOpen, anchor: headElement }), [followersOpen, followersShown, headElement]);
  return (
    // The panel hangs from the bar, over the conversation's own chrome; what follows the bar is what follows a head
    // in a clipped column (index.css, `data-slot`).
    <div className="relative z-chrome shrink-0" data-slot="task-conversation-bar">
      <PanelHead ref={measure}>
        {mobile ? (
          <PanelAction onClick={onClose} aria-label={formatMessage({ id: "task.modal.close" })} data-testid="task-modal-mobile-back">
            <ArrowLeft />
          </PanelAction>
        ) : null}
        {/* One line on a desktop (a 44px head): the label, then the ref after it. */}
        <div className={BAR_NAME_CLASS}>
          <div className={BAR_REF_CLASS} data-testid="task-modal-bar-ref">{ref}</div>
          {summarized ? (
            <button
              ref={summaryRef}
              type="button"
              onClick={() => onHeadPanelOpenChange(!panelOpen)}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || !panelOpen) return;
                event.stopPropagation();
                closePanel();
              }}
              className="-ml-1 flex max-w-full min-w-0 items-center gap-1.5 rounded-control px-1 text-left outline-none active:overlay-medium focus-visible:shadow-focus"
              aria-expanded={panelOpen}
              aria-controls={panelOpen ? panelId : undefined}
              data-testid="task-modal-bar-summary"
            >
              <span className="shrink-0 text-subhead font-bold" data-testid="task-modal-bar-label">{label}</span>
              <StatusBadge status={task.status} size="sm" className="shrink-0" data-testid="task-modal-bar-status">
                {formatMessage({ id: TASK_STATUS_UI[task.status]?.labelId ?? "task.status.todo" })}
              </StatusBadge>
              <TaskBarAssignee task={task} />
              <ChevronDown
                aria-hidden
                className={`size-3.5 shrink-0 text-foreground-hint motion-safe:transition-transform motion-safe:duration-220 motion-safe:ease-slide ${panelOpen ? "rotate-180" : ""}`}
              />
            </button>
          ) : (
            <div className={BAR_LABEL_CLASS} data-testid="task-modal-bar-label">{label}</div>
          )}
        </div>
        <PanelActions>
          {conversationChannelId && <ThreadAgentFollowers threadChannelId={conversationChannelId} variant="header" subject="task" onOpenProfile={onOpenProfile}
            folded={foldedFollowers} />}
          <ThreadOverflowMenu
            subject="task"
            leadingItems={hasFollowers && !followersShown ? (
              <DropdownMenuItem onClick={openFollowers} data-testid="task-overflow-followers">{formatMessage({ id: "thread.followers.title" })}</DropdownMenuItem>
            ) : undefined}
            threadChannelId={conversationChannelId}
            parentMessageId={null}
            follow={follow}
            onSearch={conversationChannelId ? search : undefined}
            viewInChannelLabel={formatMessage({ id: "message.threadPanel.viewInChannel" })}
            onViewInChannel={viewInChannel}
            trailingItems={deleteMenu.menuItems}
          />
          {deleteMenu.dialog}
          {focus && !mobile ? <ExpandToggleAction pressed={focus.focused} onPressedChange={focus.toggle} testId="task-focus-mode" /> : null}
          {!mobile ? (
            <PanelAction onClick={onClose} aria-label={formatMessage({ id: "task.modal.close" })} data-testid="task-modal-close">
              <X />
            </PanelAction>
          ) : null}
        </PanelActions>
      </PanelHead>
      {panelOpen ? (
        <TaskHeadPullDown id={panelId} label={label} barRef={summaryRef} onClose={closePanel}>
          <TaskConversationHead task={task} onLeave={onLeave} divider={false} onOpenProfile={onOpenProfile} />
        </TaskHeadPullDown>
      ) : null}
    </div>
  );
}

/** The assignee in the phone bar's summary: the avatar, named for screen
 *  readers, and the name beside it only where the bar has room for it whole
 *  (Kirby: a cut name says less than the face). */
function TaskBarAssignee({ task }: { task: Task }) {
  const { formatMessage } = useIntl();
  const { identity, viewerId } = useTaskAssigneeIdentity(task);
  if (!task.claimedById || !task.claimedByType) return null;
  const name = viewerId && task.claimedByType === "user" && task.claimedById === viewerId
    ? formatMessage({ id: "task.sidePanel.you" })
    : identity?.displayName || identity?.name || task.claimedByName || "";
  return (
    <span className="flex min-w-0 items-center gap-1" data-testid="task-modal-bar-assignee">
      <span role="img" aria-label={name} className="flex shrink-0" data-testid="task-modal-bar-assignee-avatar">
        {task.claimedByType === "agent" ? (
          <AvatarSlot context="compact-list" type="agent" agentAvatarUrl={identity?.avatarUrl ?? null} />
        ) : (
          <AvatarSlot
            context="compact-list"
            type="human"
            humanAvatarUrl={identity?.avatarUrl ?? null}
          />
        )}
      </span>
      <span aria-hidden className="hidden min-w-0 truncate text-callout text-foreground-muted @[22rem]:inline" data-testid="task-modal-bar-assignee-name">{name}</span>
    </span>
  );
}

/**
 * Follow the task's conversation, as one follows a thread — the More menu's
 * Follow / Unfollow command. The task DTO says whether the reader follows it
 * (`conversationFollowed`, through this surface's local conversation); a
 * follow or unfollow done here wins until the next load.
 *
 * A task's conversation is created lazily, like a thread before its first
 * reply, and the command is there before it exists, as the thread panel's
 * Follow is. Following or unfollowing creates it first (POST
 * /tasks/:id/conversation, as the first send does): its creator and assignee
 * follow it from creation, so their Unfollow leaves that follow.
 */
export function useTaskConversationFollow(task: Task, conversationChannelId: string | null): ConversationFollowCommand {
  const followTaskConversation = useThreadStore((s) => s.followTaskConversation);
  const unfollowTaskConversation = useThreadStore((s) => s.unfollowTaskConversation);
  const bindTaskConversationChannel = useThreadStore((s) => s.bindTaskConversationChannel);
  const ensureTaskModalThreadChannel = useThreadStore((s) => s.ensureTaskModalThreadChannel);
  const followed = useThreadStore((s) => isTaskConversationFollowed(s, conversationChannelId, task.conversationFollowed));
  const [busy, setBusy] = useState(false);

  const onFollowAction = useCallback(() => {
    if (busy) return;
    setBusy(true);
    const run = async () => {
      let channelId = conversationChannelId;
      if (!channelId) {
        channelId = await ensureTaskModalThreadChannel();
        bindTaskConversationChannel(task.id, channelId);
      }
      if (followed) await unfollowTaskConversation(channelId);
      else await followTaskConversation(channelId);
    };
    void run().catch(() => {}).finally(() => setBusy(false));
  }, [bindTaskConversationChannel, busy, conversationChannelId, ensureTaskModalThreadChannel, followTaskConversation, followed, task.id, unfollowTaskConversation]);

  return useMemo(() => ({ followed, disabled: busy, onFollowAction }), [busy, followed, onFollowAction]);
}

/** The task's head (title, description, properties, History) with the
 *  dialog's own property rows. One component wherever it shows: above the
 *  conversation, as its first row on a phone, and pulled down from the bar. */
function TaskConversationHead({ task, onLeave, divider, onOpenProfile }: {
  task: Task;
  onLeave: () => void;
  divider: boolean;
  onOpenProfile: (kind: "agent" | "human", id: string) => void;
}) {
  const propertyRows = useMemo(() => ({
    sourceRow: <TaskSourceProperty task={task} onLeave={onLeave} />,
    trailingRows: (
      <>
        <TaskCreatedAtProperty task={task} />
        <TaskEarlierDiscussionProperty task={task} onLeave={onLeave} />
      </>
    ),
  }), [onLeave, task]);
  return (
    <Suspense fallback={null}>
      <TaskModalHead task={task} propertyRows={propertyRows} divider={divider} onOpenProfile={onOpenProfile} />
    </Suspense>
  );
}

function TaskConversationTimeline({ task, presentation, page, conversationChannelId, focusedMessageId, focusNonce, onLeave, appProfiles, searchCommandRef, onHeadInViewChange, onMessagesScrollStart, onOpenProfile }: {
  task: Task;
  presentation: "modal" | "mobile-modal";
  page: boolean;
  /** The messages open the app's profile panel themselves (MessageItem's own way). */
  appProfiles: boolean;
  conversationChannelId: string | null;
  focusedMessageId: string | null;
  /** The jump to `focusedMessageId` (the task modal slot's `focusNonce`). */
  focusNonce: number;
  onLeave: () => void;
  searchCommandRef: MutableRefObject<(() => void) | null>;
  onHeadInViewChange: (inView: boolean) => void;
  /** The reader starts scrolling the messages (a wheel or a drag). */
  onMessagesScrollStart?: () => void;
  /** An avatar, a sender's name or a mention in the conversation. */
  onOpenProfile: (kind: "agent" | "human", id: string) => void;
}) {
  const { formatMessage } = useIntl();
  const identity = useMemo(() => ({
    parentMessageId: null,
    parentTaskId: task.id,
    parentChannelId: task.channelId,
    threadChannelId: conversationChannelId,
    focusedMessageId,
    focusNonce,
  }), [conversationChannelId, focusedMessageId, focusNonce, task.channelId, task.id]);
  // On a phone the head is the first row of the conversation and scrolls away
  // with it (Artea, #wg-task-v2 task #7): pinned, it left the replies a sliver
  // of the screen. The bar keeps the task's status while it is out of view.
  // As a row it has no rule under it: the first message follows it as the
  // messages follow one another (Kirby).
  const scrollsWithTimeline = presentation === "mobile-modal" && !page;
  const headContent = <TaskConversationHead task={task} onLeave={onLeave} divider={!scrollsWithTimeline} onOpenProfile={onOpenProfile} />;
  // Elsewhere the head (title, description, properties) stays put above the
  // conversation: only the timeline scrolls, so what the task is and what
  // state it is in are in view however far the discussion runs. A head taller
  // than its share (a long description unfolded, History open) scrolls inside
  // itself instead of pushing the conversation away.
  const head = scrollsWithTimeline ? null : (
    <ScrollArea
      role="region"
      aria-label={formatMessage({ id: "task.modal.taskWithNumber" }, { taskNumber: task.taskNumber })}
      overscroll="contain"
      className="max-h-[45%] shrink-0"
      data-testid="task-conversation-head"
    >
      {headContent}
    </ScrollArea>
  );
  const parentSlot = scrollsWithTimeline ? (
    <TaskHeadInView onChange={onHeadInViewChange}>{headContent}</TaskHeadInView>
  ) : undefined;
  // A pre-v2 task's earlier discussion is its message's replies (linked from
  // the properties); its own conversation starts with the first message here.
  const emptyState = (
    <EmptyState
      className="flex flex-1 flex-col items-center justify-center p-6"
      icon={<ThreadIcon width={36} height={36} />}
      title={formatMessage({ id: "task.conversation.emptyTitle" })}
      description={task.hostMessageId ? formatMessage({ id: "task.conversation.emptyBody" }) : undefined}
      data-testid="task-conversation-empty"
    />
  );
  return (
    <>
      {head}
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-testid="task-conversation-timeline"
        onWheel={onMessagesScrollStart}
        onTouchMove={onMessagesScrollStart}
      >
        <ThreadPanel
          key={task.id}
          presentation={presentation}
          mobilePage={page}
          threadIdentity={identity}
          hideHeader
          hideParentMessage
          emptyState={emptyState}
          searchCommandRef={searchCommandRef}
          parentSlot={parentSlot}
          onOpenProfile={appProfiles ? undefined : onOpenProfile}
        />
      </div>
    </>
  );
}

/** The head as a timeline row, reporting whether any of it is on screen. A
 *  row the timeline has virtualized away is detached, which reads as out of
 *  view. Unmounting reports it back in view, so the bar never keeps a summary
 *  for a head that is no longer a row. */
function TaskHeadInView({ onChange, children }: { onChange: (inView: boolean) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) onChange(entry.isIntersecting);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      onChange(true);
    };
  }, [onChange]);
  return <div ref={ref} data-testid="task-conversation-head">{children}</div>;
}

/** The message a task was created from, as a property: who said it, its first
 *  line and when; selecting it leaves the dialog for that message. A task with
 *  no recorded source says so, muted (#wg-task-v2:#23). */
function TaskSourceProperty({ task, onLeave }: { task: Task; onLeave: () => void }) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const { formatMessageTime } = useTimeFormatter();
  const display = taskSourceDisplay(task);
  const sourceId = display?.kind === "message" ? display.id : null;
  const cached = useMessageStore((s) => (sourceId
    ? selectChannelMessageBucket(s, task.channelId).find((m) => m.id === sourceId) ?? null
    : null));
  const [fetched, setFetched] = useState<{ id: string; message: Message | null } | null>(null);
  useEffect(() => {
    if (!sourceId || cached || fetched?.id === sourceId) return;
    let cancelled = false;
    const request = buildThreadParentContextRequest(sourceId, task.channelId);
    api.get(request.url, request.config)
      .then(({ data }) => {
        if (cancelled) return;
        const messages = ((data as { messages?: Message[] } | null)?.messages ?? []);
        setFetched({ id: sourceId, message: messages.find((m) => m.id === sourceId) ?? null });
      })
      .catch(() => {
        if (!cancelled) setFetched({ id: sourceId, message: null });
      });
    return () => {
      cancelled = true;
    };
  }, [cached, fetched?.id, sourceId, task.channelId]);
  const source = cached ?? (fetched?.id === sourceId ? fetched.message : null);
  const agents = useAgentStore((s) => s.agents);
  const members = useServerStore((s) => s.members);
  const currentUser = useAuthStore((s) => s.user);

  const goToSource = useCallback(() => {
    if (!sourceId) return;
    // Leave the dialog: the source lives in the channel behind it.
    onLeave();
    if (task.channelType === "dm") nav.toDmMessage(task.channelId, sourceId);
    else nav.toMessage(task.channelId, sourceId);
  }, [nav, onLeave, sourceId, task.channelId, task.channelType]);

  if (display?.kind === "notRecorded") {
    return (
      <PropertyRow label={formatMessage({ id: "task.source.label" })} testId="task-modal-source">
        <span className="text-foreground-muted" data-testid="task-modal-source-not-recorded">{formatMessage({ id: "task.source.notRecorded" })}</span>
      </PropertyRow>
    );
  }
  if (!sourceId) return null;
  const agent = source?.senderType === "agent" ? agents.find((a) => a.id === source.senderId) : null;
  const member = source?.senderType === "user"
    ? resolveMessageSenderMemberFromList(source, members, currentUser) ?? null
    : null;
  const sender = agent?.displayName || agent?.name || member?.displayName || member?.name || source?.senderDisplayName || source?.senderName || "";
  const preview = source?.content?.split("\n").find((line) => line.trim())?.trim() ?? "";
  return (
    <PropertyRow label={formatMessage({ id: "task.source.label" })} testId="task-modal-source">
      <button
        type="button"
        onClick={goToSource}
        // A shape beside plain facts hangs its padding outward (DS alignment).
        // Its texts sit on the facts' baseline (the first one gives the
        // button its baseline); the avatar and the arrow, marks, are centered
        // in it (raft-design foundations/alignment.md).
        className="-ml-1.5 flex max-w-[calc(100%+0.375rem)] min-w-0 items-baseline gap-1.5 [&>[data-avatar-context]]:self-center rounded-control px-1.5 py-0.5 text-left outline-none hover:overlay-medium active:overlay-medium focus-visible:shadow-focus"
        aria-label={formatMessage({ id: "task.source.open" })}
        data-testid="task-modal-source-open"
      >
        {source ? (
          source.senderType === "agent" ? (
            <AvatarSlot context="compact-list" type="agent" agentAvatarUrl={agent?.avatarUrl ?? null} />
          ) : (
            <AvatarSlot
              context="compact-list"
              type="human"
              humanAvatarUrl={member?.avatarUrl ?? null}
            />
          )
        ) : null}
        {sender ? <span className="shrink-0 font-semibold text-foreground" data-testid="task-modal-source-author">{sender}</span> : null}
        <span className="min-w-0 truncate text-foreground-muted" data-testid="task-modal-source-preview">
          {source ? <InlineMarkdownPreview markdown={preview} /> : formatMessage({ id: "task.source.unloaded" })}
        </span>
        {source?.createdAt ? (
          <time dateTime={source.createdAt} className="shrink-0 font-mono text-mono-meta text-foreground-hint" data-testid="task-modal-source-time">
            {formatMessageTime(source.createdAt)}
          </time>
        ) : null}
        <ArrowRight aria-hidden className="size-3.5 shrink-0 self-center text-foreground-hint" />
      </button>
    </PropertyRow>
  );
}

function TaskCreatedAtProperty({ task }: { task: Task }) {
  const { formatMessage } = useIntl();
  const { formatMediumDateTime24 } = useTimeFormatter();
  if (!task.createdAt) return null;
  return (
    <PropertyRow label={formatMessage({ id: "task.properties.createdAt" })} testId="task-modal-created-at">
      <time dateTime={task.createdAt} className="font-mono text-mono-meta">{formatMediumDateTime24(task.createdAt)}</time>
    </PropertyRow>
  );
}

/**
 * A pre-v2 task talked in the replies of its host message before it had its
 * own conversation. That discussion stays there; this row leads to it, with
 * its size. Hidden once it is known to have no replies.
 */
function TaskEarlierDiscussionProperty({ task, onLeave }: { task: Task; onLeave: () => void }) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const openThread = useThreadStore((s) => s.openThread);
  const hostId = task.hostMessageId ?? null;
  const summary = useThreadStore((s) => (hostId ? s.summaries[hostId] ?? null : null));
  // Without its own conversation, the task's served count IS its host thread's.
  const servedCount = !task.conversationChannelId ? task.conversationReplyCount : undefined;
  const [lookup, setLookup] = useState<{ hostId: string; replyCount: number; threadChannelId: string | null } | null>(null);
  const known = summary
    ? { replyCount: summary.replyCount, threadChannelId: summary.threadChannelId }
    : lookup?.hostId === hostId ? lookup : null;
  useEffect(() => {
    if (!hostId || summary || lookup?.hostId === hostId) return;
    let cancelled = false;
    api.get(`/channels/${task.channelId}/threads/${hostId}`)
      .then(({ data }) => {
        if (cancelled) return;
        const body = data as { threadChannelId?: string | null; replyCount?: number } | null;
        setLookup({ hostId, replyCount: body?.replyCount ?? 0, threadChannelId: body?.threadChannelId ?? null });
      })
      .catch(() => {
        // No thread (404) or not visible: nothing earlier to show.
        if (!cancelled) setLookup({ hostId, replyCount: 0, threadChannelId: null });
      });
    return () => {
      cancelled = true;
    };
  }, [hostId, lookup?.hostId, summary, task.channelId]);

  const replyCount = known?.replyCount ?? servedCount;
  const openInDetailSlot = useDetailSlotThreadOpener();
  const open = useCallback(() => {
    if (!hostId) return;
    // In a detail slot it takes the slot's place (detailSlotThread.ts).
    if (openInDetailSlot?.({ parentChannelId: task.channelId, parentMessageId: hostId, threadChannelId: known?.threadChannelId ?? null })) return;
    onLeave();
    if (task.channelType === "dm") nav.toDmMessage(task.channelId, hostId);
    else nav.toMessage(task.channelId, hostId);
    void openThread({
      parentChannelId: task.channelId,
      parentMessageId: hostId,
      threadChannelId: known?.threadChannelId ?? null,
      intent: "thread",
    });
  }, [hostId, known?.threadChannelId, nav, onLeave, openInDetailSlot, openThread, task.channelId, task.channelType]);

  if (!hostId || (known && known.replyCount === 0)) return null;
  return (
    <PropertyRow label={formatMessage({ id: "task.properties.earlierDiscussion" })} testId="task-modal-earlier-discussion">
      <button
        type="button"
        onClick={open}
        className="-ml-1.5 flex min-w-0 max-w-[calc(100%+0.375rem)] items-baseline gap-1 rounded-control px-1.5 py-0.5 text-left outline-none hover:overlay-medium active:overlay-medium focus-visible:shadow-focus"
        aria-label={formatMessage({ id: "task.earlierDiscussion.open" })}
        data-testid="task-modal-earlier-discussion-open"
      >
        <span className="min-w-0 truncate">
          {replyCount !== undefined
            ? formatMessage({ id: "task.earlierDiscussion.replies" }, { count: replyCount })
            : formatMessage({ id: "task.earlierDiscussion.view" })}
        </span>
        <ArrowRight aria-hidden className="size-3.5 shrink-0 self-center text-foreground-hint" />
      </button>
    </PropertyRow>
  );
}
