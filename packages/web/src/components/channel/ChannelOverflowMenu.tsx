import { deferredDialog, deferredPanel } from "../../boot/deferredUi";
import { PanelLoading } from "../layout/PanelLoading";
import type { ReactNode } from "react";
import { Children, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Search, Settings } from "lucide-react";
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  PanelToggleAction,
} from "@botiverse/raft-ui";
import { ChannelPreferencesSection } from "./ChannelPreferencesSection";
import { ChannelDetailsIdentity, ChannelDetailsSurface } from "./ChannelDetailsSurface";
import { prepareChannelDetailsOpen } from "./channelDetails";
import { MemberAvatarPreloader, MembersStrip } from "./MembersStrip";
import type { ChannelAgent, ChannelExternalMember, ChannelHuman } from "../../hooks/useChannelMembers";
import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";
import { useServerStore } from "../../store/serverStore";
import { canUseChannelMemberAction } from "../../utils/channelMemberPermissions";
import { channelKeepsPrivateForExternal, useChannelExternalInvites, useExternalInviteManagement } from "./externalInvites";
import { clearChannelSwitchInterceptor, setChannelSwitchInterceptor } from "../../navigation/channelSwitchGuard";
import { ColumnOverflowMenu } from "../layout/ColumnOverflowMenu";
import type { ColumnMenuItem } from "../layout/ColumnOverflowMenu";
import { OverflowMenuTrigger } from "../ui/OverflowSheet";
import Tooltip from "../ui/Tooltip";

const EditChannelDialog = deferredDialog(() => import("../../features/channel/EditChannelDialog").then((mod) => ({ default: mod.EditChannelDialog })));
// The members page (opened from the sheet), off the first download: under the
// sheet's Suspense, with Try again in place on a failed load.
const ChannelMembers = deferredPanel(() => import("../../features/channel/ChannelMembers").then((module) => ({ default: module.ChannelMembers })));

const NO_CHANNEL_AGENTS: ChannelAgent[] = [];
const NO_CHANNEL_HUMANS: ChannelHuman[] = [];
const NO_CHANNEL_EXTERNAL_MEMBERS: ChannelExternalMember[] = [];
// The unsaved prompt stacks over the details on z-dialog-layer, the
// layer the old `Modal layer={1}` and ConfirmDialog's `layer={1}` use.
const UNSAVED_PROMPT_OVERLAY = { className: "z-dialog-layer" };

/**
 * The channel header's own buttons and the channel details (raft-design channel.md, Kirby's redesign that stdrc
 * approved, task #proj-raft-ui:#232, #proj-raft-ui:dae8db07).
 *
 * The header: Search, the toggles between (Tasks, Files), then Settings, a toggle pressed while the details are
 * open; they fold into ⋯ where the head is too narrow (#189 rule 6). The details are a column of the conversation's
 * row, like a thread or a profile (ChannelDetailsSurface): no scrim, the conversation stays in reach; on a phone a
 * pushed page titled Details. They read first: the channel's name and description (Edit turns them into fields in
 * place), its members (MembersStrip; the heading row opens the member list inside the column, with Back), the
 * announcement, its servers, Channel settings, Your preferences, then the actions. A DM and an Agent Lounge show
 * Your preferences alone. Every control maps to an existing API; visibility is trimmed by the caller with the same
 * RBAC predicates as before (optional props left undefined omit their row). Closing with an unsaved name or
 * description, or leaving the channel then, asks first (the unsaved-changes prompt).
 */
export interface ChannelOverflowMenuProps {
  channelId: string;
  channelName: string;
  /** Opens channel search. Rendered as the header icon (v2). */
  onSearch: () => void;
  /** Header toggles between Search and Settings: the Tasks and Files cards (one node each, in an array to fold). */
  middleActions?: ReactNode;
  /** `middleActions` as ⋯ items, in their order: what each becomes once folded (#189 rule 6). */
  middleItems?: readonly ColumnMenuItem[];
  /**
   * How many of the head's own buttons (Search, the middle ones, Settings) fold into a ⋯ after them, the last first,
   * where the head is too narrow for them (#189 rule 6; ChatPanel measures it).
   */
  fold?: number;
  /** A button before Search (Show announcement while hidden): first in the head, first to fold into ⋯; `fold` counts it. */ lead?: { node: ReactNode; item: ColumnMenuItem };
  /** Activity-mute switch, rendered in the settings panel's preferences
   *  group between Pin and collapse (final11: Mute is a per-user
   *  preference). Omit when the server does not support it. */
  activityMute?: {
    muted: boolean;
    busy: boolean;
    onToggle: () => void;
  };
  /** Collapse-long-messages switch, rendered in the settings panel's
   *  preferences group next to Pin. Omit when the server does not
   *  support it. */
  collapseLongMessages?: {
    enabled: boolean;
    busy: boolean;
    onToggle: () => void;
  };
  /** Show the members section (false e.g. for #all with
   *  hideHumansFromMembers). */
  showMembers?: boolean;
  /** Already-prefetched channel roster from ChatPanel. Passing it here keeps
   *  the details from issuing a second request only after opening. */
  members?: {
    agents: ChannelAgent[];
    humans: ChannelHuman[];
    externalMembers: ChannelExternalMember[];
    loading: boolean;
    addMembers: (input: { userIds: string[]; agentIds: string[] }) => Promise<unknown>;
    addAgent: (agentId: string) => Promise<void>;
    removeAgent: (agentId: string) => Promise<void>;
    addHuman: (userId: string) => Promise<void>;
    removeHuman: (userId: string) => Promise<void>;
    changeMemberRole: (targetType: "user" | "agent", memberId: string, role: "member" | "admin") => Promise<void>;
    roleChangeFailed: boolean;
  };
  /** Settings entry follows the existing management/leave policy.
   *  Individual actions retain their own capability checks. */
  settings?: {
    initialName: string;
    initialDescription: string;
    onLeaveChannel?: () => Promise<void> | void;
  };
  /** Stop all agents, a row of the actions card. Omit unless joined && canManageAgents. */
  onStopAllAgents?: () => void;
  /** Controlled open state: used when another surface (the archived channel banner's Unarchive link, the channel's
   *  name in the header) must open the details directly.
   *  Omit for the self-triggered usage. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export default function ChannelOverflowMenu({
  channelId,
  channelName,
  onSearch,
  middleActions,
  middleItems,
  fold = 0, lead,
  activityMute,
  collapseLongMessages,
  showMembers = false,
  members,
  settings,
  onStopAllAgents,
  open: controlledOpen,
  onOpenChange,
}: ChannelOverflowMenuProps) {
  const { formatMessage } = useIntl();
  const [internalOpen, setInternalOpen] = useState(false);
  const [showUnsavedPrompt, setShowUnsavedPrompt] = useState(false);
  const [unsavedCanSave, setUnsavedCanSave] = useState(true);
  const [unsavedBusy, setUnsavedBusy] = useState(false);
  // Drawer-internal page navigation (task #187): "members" swaps the
  // sheet into the members page (bare mode — the sheet SIZE is fixed);
  // the root view stays mounted underneath so a dirty settings draft
  // survives root → members → back. membersInitialView lets the strip's
  // dashed 「+」 tile land DIRECTLY in the add flow (v2: one hop fewer).
  const [view, setView] = useState<"root" | "members">("root");
  const [membersInitialView, setMembersInitialView] = useState<"add" | undefined>(undefined);
  const open = controlledOpen ?? internalOpen;
  // v2 identity header: visibility badge reads the live channel. DMs live in
  // the store's dmChannels list, so look there too (task #703: this sheet IS
  // the DM settings surface as well — same component as channels).
  const channel = useChannelStore((s) =>
    findStoredChannel(s, channelId));
  const isDmChannel = channel?.type === "dm";
  const currentUserId = useAuthStore((s) => s.user?.id);
  const currentServerId = useServerStore((s) => s.current?.id);
  const serverMembers = useServerStore((s) => s.members);
  const isAllChannel = channel?.name === "all" && channel?.type === "channel";
  const canAddMembers = canUseChannelMemberAction({
    currentUserId,
    currentServerId,
    channelServerId: channel?.serverId,
    channelHumans: members?.humans ?? [],
    serverMembers,
    hasChannelMemberCapability: channel?.channelCapabilities?.addChannelMembers === true,
    isAllChannel,
  }) && !channel?.archivedAt;
  // A channel with a Guest or an open external invite stays private
  // (#wg-rbac:#16; the server refuses with external_members_keep_private).
  // The channel row's `hasExternalRelation` says it for every non-guest member
  // (channel admins too). Without it (an older server) the guests in the
  // roster and, for host owners and admins, the open invites read while the
  // drawer is open; anyone else learns it from the server's refusal.
  const hasExternalRelation = channel?.hasExternalRelation;
  const externalInviteManagement = useExternalInviteManagement(channel);
  const { invites: externalInvites } = useChannelExternalInvites(
    channelId,
    hasExternalRelation === undefined && externalInviteManagement && open,
  );
  const externalMembersKeepPrivate = channelKeepsPrivateForExternal(channel, externalInvites, members?.humans ?? []);
  // task #187: the flat settings panel carries no Drawer chrome, so the
  // host drawer owns the unsaved-draft guard — a close attempt while a
  // draft exists opens the save/discard prompt (final6) instead of
  // silently blocking or discarding. Refs keep dirtiness and the save
  // callback out of this component's render cycle.
  const settingsDirtyRef = useRef(false);
  const settingsSaveAndCloseAvailableRef = useRef(true);
  const settingsSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const postCloseActionRef = useRef<(() => void) | null>(null);
  const setOpen = useCallback((next: boolean) => {
    if (!next) {
      settingsDirtyRef.current = false;
      settingsSaveAndCloseAvailableRef.current = true;
      postCloseActionRef.current = null;
      setView("root");
      setMembersInitialView(undefined);
    } else {
      prepareChannelDetailsOpen(channelId);
    }
    if (onOpenChange) onOpenChange(next);
    else setInternalOpen(next);
  }, [channelId, onOpenChange]);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const handleOpen = useCallback(() => setOpen(true), [setOpen]);
  // The members page ✕ rides the same draft guard as every other close
  // affordance; row → profile keeps the historical unguarded close (the
  // old drawer panel behavior).
  /** Closes, or asks first with an unsaved draft; true when it closed. */
  const guardedClose = useCallback((postCloseAction?: () => void): boolean => {
    if (settingsDirtyRef.current) {
      postCloseActionRef.current = postCloseAction ?? null;
      setUnsavedCanSave(settingsSaveAndCloseAvailableRef.current);
      setShowUnsavedPrompt(true);
      return false;
    }
    close();
    postCloseAction?.();
    return true;
  }, [close]);
  // The details stand beside the conversation, so searching it leaves them open (they were a modal sheet).
  const handleSearch = onSearch;
  // task #156: the sheet is keyed to a channel, but every nav.* call
  // (sidebar rows, #channel links, permalinks, agent/human entries, the
  // desktop search overlay) commits the route BEFORE this component's
  // channelId prop changes — by then the form has already remounted and
  // the draft is gone. The sheet therefore registers a pre-navigation
  // interceptor while mounted: an in-conversation navigation that would
  // leave the current channel becomes a postCloseAction parked behind the
  // same keep/discard/save prompt every other close affordance uses.
  // Navigations to the SAME channel (permalink inside it, its own sidebar
  // row) are let through untouched.
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const sameChannelTarget = (targetPath: string) =>
      new RegExp(`/(?:channel|dm)/${channelIdRef.current}(?:$|[?#])`).test(targetPath);
    const interceptor = (targetPath: string, proceed: () => void) => {
      if (openRef.current && settingsDirtyRef.current && !sameChannelTarget(targetPath)) {
        postCloseActionRef.current = proceed;
        setUnsavedCanSave(settingsSaveAndCloseAvailableRef.current);
        setShowUnsavedPrompt(true);
        return true;
      }
      return false;
    };
    setChannelSwitchInterceptor(interceptor);
    // Unregister only if the slot still holds THIS interceptor — a later
    // mount's unmount must not clear a newer registration.
    return () => clearChannelSwitchInterceptor(interceptor);
  }, []);

  const handleOpenMembers = useCallback(() => {
    setMembersInitialView(undefined);
    setView("members");
  }, []);
  const handleAddMembers = useCallback(() => {
    if (!canAddMembers) return;
    setMembersInitialView("add");
    // The add picker opens straight away: fetch the agent roster it lists.
    void useAgentStore.getState().loadAgents();
    setView("members");
  }, [canAddMembers]);
  const handleBackToRoot = useCallback(() => setView("root"), []);
  const prefetchedMembers = useMemo(() => members ? {
    channelAgents: members.agents,
    channelHumans: members.humans,
    channelExternalMembers: members.externalMembers,
    loading: members.loading,
    addMembers: members.addMembers,
    addAgent: members.addAgent,
    removeAgent: members.removeAgent,
    addHuman: members.addHuman,
    removeHuman: members.removeHuman,
    changeMemberRole: members.changeMemberRole,
    roleChangeFailed: members.roleChangeFailed,
  } : undefined, [members]);
  const handleKeepEditing = useCallback(() => {
    postCloseActionRef.current = null;
    setShowUnsavedPrompt(false);
  }, []);
  const handleUnsavedPromptOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen || unsavedBusy) return;
    handleKeepEditing();
  }, [unsavedBusy, handleKeepEditing]);
  const handleDiscardAndClose = useCallback(() => {
    const postCloseAction = postCloseActionRef.current;
    postCloseActionRef.current = null;
    setShowUnsavedPrompt(false);
    close();
    postCloseAction?.();
  }, [close]);
  const handleSaveAndClose = useCallback(async () => {
    setUnsavedBusy(true);
    try {
      const saved = (await settingsSaveRef.current?.()) ?? true;
      if (saved) {
        const postCloseAction = postCloseActionRef.current;
        postCloseActionRef.current = null;
        setShowUnsavedPrompt(false);
        close();
        postCloseAction?.();
      }
    } finally {
      setUnsavedBusy(false);
    }
  }, [close]);

  const handleToggle = useCallback(() => {
    if (open) guardedClose();
    else handleOpen();
  }, [guardedClose, handleOpen, open]);
  const closeDetails = useCallback(() => guardedClose(), [guardedClose]);
  // Escape closing the details gives focus back to what opened them; the gear when that is gone.
  const gearRef = useRef<HTMLButtonElement | null>(null);
  const gear = useCallback(() => gearRef.current, []);

  // The head always fits (#189 rule 6): its own buttons fold into a ⋯ after them, the last first.
  const middle = Children.toArray(middleActions);
  const foldable = middleItems && middleItems.length === middle.length;
  const total = 2 + middle.length;
  const leadItem = lead && fold > 0 ? lead.item : null; // the lead folds first, then the rest, the last first
  const shown = total - Math.min(foldable ? fold - (lead && fold > 0 ? 1 : 0) : 0, total);
  const searchLabel = formatMessage({ id: "message.chatPanel.searchChannel" });
  // The toggle keeps one name and says its state with aria-pressed; the folded ⋯ item, which has no state, says it.
  const settingsLabel = formatMessage({ id: "message.chatPanel.overflow.open" });
  const settingsItemLabel = formatMessage({ id: open ? "message.chatPanel.overflow.close" : "message.chatPanel.overflow.open" });
  const folded = useMemo(() => [...(leadItem ? [leadItem] : []), ...[
    { id: "search", label: searchLabel, icon: <Search />, onSelect: handleSearch, testId: "channel-header-overflow-search" },
    ...(middleItems ?? []),
    { id: "settings", label: settingsItemLabel, icon: <Settings />, onSelect: handleToggle, testId: "channel-header-overflow-settings" },
  ].slice(shown)], [handleSearch, handleToggle, leadItem, middleItems, searchLabel, settingsItemLabel, shown]);

  const membersStrip = showMembers ? (
    <MembersStrip
      channelAgents={members?.agents ?? NO_CHANNEL_AGENTS}
      channelHumans={members?.humans ?? NO_CHANNEL_HUMANS}
      channelExternalMembers={members?.externalMembers ?? NO_CHANNEL_EXTERNAL_MEMBERS}
      loading={members?.loading ?? true}
      onOpen={handleOpenMembers}
      onAdd={canAddMembers ? handleAddMembers : undefined}
    />
  ) : null;

  return (
    <>
      {lead && !leadItem ? lead.node : null}
      {shown > 0 ? (
        <OverflowMenuTrigger
          labelId="message.chatPanel.searchChannel"
          onClick={handleSearch}
          icon={<Search size={22} />}
          testId="channel-topbar-search"
        />
      ) : null}
      {middle.slice(0, Math.max(0, shown - 1))}
      {shown === total ? (
        /* A toggle, pressed while the details are open, as Tasks and Files are (raft-design channel.md). */
        <Tooltip content={settingsLabel}>
          <PanelToggleAction
            ref={gearRef}
            pressed={open}
            onPressedChange={handleToggle}
            aria-label={settingsLabel}
            data-testid="channel-overflow-trigger"
          >
            <Settings />
          </PanelToggleAction>
        </Tooltip>
      ) : null}
      <ColumnOverflowMenu items={folded} testId="channel-header-overflow" />
      {showMembers && members && (
        <MemberAvatarPreloader
          channelAgents={members.agents}
          channelHumans={members.humans}
          loading={members.loading}
        />
      )}
      <ChannelDetailsSurface
        open={open}
        onClose={closeDetails}
        returnFocus={gear}
        page={view === "members" ? (
          <Suspense fallback={<PanelLoading label={formatMessage({ id: "layout.main.loading" })} />}>
            <ChannelMembers
              presentation="page"
              channelId={channelId}
              initialView={membersInitialView}
              prefetchedMembers={prefetchedMembers}
              onBack={handleBackToRoot}
              onClose={guardedClose}
              onRequestClose={close}
            />
          </Suspense>
        ) : null}
      >
        {/* The root view stays MOUNTED (hidden) while the members page shows, so an unsaved name or description
            survives the round trip. */}
        <div className={view === "members" ? "hidden" : undefined}>
          {/* Keyed by channel: ChatPanel is not remounted per channel, so open details survive a channel switch.
              Without the key the form kept the previous channel's name and description as its "draft", and Save
              would have renamed the new channel to the old one's name. */}
          {settings ? (
            <EditChannelDialog
              key={channelId}
              channelId={channelId}
              initialName={settings.initialName}
              initialDescription={settings.initialDescription}
              onLeaveChannel={settings.onLeaveChannel}
              onClose={close}
              externalMembersKeepPrivate={externalMembersKeepPrivate}
              dirtyRef={settingsDirtyRef}
              saveAndCloseAvailableRef={settingsSaveAndCloseAvailableRef}
              saveRef={settingsSaveRef}
              activityMute={activityMute}
              collapseLongMessages={collapseLongMessages}
              onStopAllAgents={onStopAllAgents}
              membersSlot={membersStrip}
            />
          ) : !isDmChannel && !channel?.loungeAgentId ? (
            /* Someone who hasn't joined: the channel read-only and its members. */
            <div className="stack-y-6">
              <ChannelDetailsIdentity channel={channel} channelName={channelName} description={channel?.description} />
              {membersStrip}
            </div>
          ) : null}

          {/* task #703: a DM shares these details but has no name or description; it shows Your preferences.
              Mute only when ChatPanel passes it (a DM with an App bot, or a mute stored). An Agent Lounge the same
              (no section select) once you joined it. */}
          {(isDmChannel || (!!channel?.loungeAgentId && !settings && (activityMute || collapseLongMessages))) && (
            <ChannelPreferencesSection
              channelId={channelId}
              conversationKind={isDmChannel ? "dm" : "lounge"}
              isPanel
              activityMute={activityMute}
              collapseLongMessages={collapseLongMessages}
            />
          )}
        </div>
      </ChannelDetailsSurface>

      {/* Closing the details with unsaved settings asks first. Only name/description drafts can be saved here; an
          invitation draft must be sent from its own form or explicitly discarded. Three actions, so the raft-ui
          AlertDialog directly instead of the two-action ConfirmDialog. Escape dismisses it like Keep editing (gated
          while a save is in flight); a backdrop press never does. Keep is ghost, Discard (loses the draft,
          reversible) orange, Save pink. */}
      <AlertDialog
        open={showUnsavedPrompt}
        onOpenChange={handleUnsavedPromptOpenChange}
      >
        <AlertDialogContent
          className="z-dialog-layer"
          overlay={UNSAVED_PROMPT_OVERLAY}
          data-testid="channel-overflow-unsaved-prompt"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {formatMessage({ id: "message.chatPanel.overflow.unsavedTitle" })}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogBody>
            <AlertDialogDescription>
              {formatMessage({
                id: unsavedCanSave
                  ? "message.chatPanel.overflow.unsavedMessage"
                  : "message.chatPanel.overflow.unsavedInvitationMessage",
              })}
            </AlertDialogDescription>
          </AlertDialogBody>
          <AlertDialogFooter>
            <Button
              onClick={handleKeepEditing}
              disabled={unsavedBusy}
              size="lg"
              variant="ghost"
            >
              {formatMessage({ id: "message.chatPanel.overflow.keepEditing" })}
            </Button>
            <Button
              onClick={handleDiscardAndClose}
              disabled={unsavedBusy}
              size="lg"
              variant="warning"
              data-testid="channel-overflow-unsaved-discard"
            >
              {formatMessage({ id: "message.chatPanel.overflow.discardChanges" })}
            </Button>
            {unsavedCanSave && (
              <Button
                onClick={handleSaveAndClose}
                disabled={unsavedBusy}
                size="lg"
                variant="accent"
                data-testid="channel-overflow-unsaved-save"
              >
                {unsavedBusy
                  ? formatMessage({ id: "channel.edit.saving" })
                  : formatMessage({ id: "message.chatPanel.overflow.saveAndClose" })}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
