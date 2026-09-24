import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { formatNameValidationError } from "../../i18n/nameValidation";
import { Archive, ArchiveRestore, Check, Eye, EyeOff, GitBranch, Hash, Lock, LogOut, Mail, Trash2, Unplug, X } from "lucide-react";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  Switch,
} from "raft-ui";
import { useChannelStore } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import {
  MAX_JOINT_CHANNEL_SERVERS,
  clearClockTimeout,
  setClockTimeout,
  validateNameReason,
  validateServerSlugReason,
} from "@botiverse/raft-shared";
import Banner from "../ui/Banner";
import Button from "../ui/Button";
import ConfirmDialog from "../ConfirmDialog";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { SERVER_GUEST_FEATURE_FLAG_KEY, TOPBAR_OVERFLOW_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import {
  hasSidebarPinnedRef,
  removeSidebarPinnedRef,
  upsertSidebarPinnedRef,
} from "../../utils/sidebarPinnedRefs";
import FormField from "../ui/FormField";
import { ChannelSlackBridgeField, useChannelSlackBridgeEditor } from "./ChannelSlackBridgeField";
import { OverflowActionRow } from "../ui/OverflowSheet";
import SlugInput from "../ui/SlugInput";
import LegacyEditChannelDialog from "./LegacyEditChannelDialog";

interface TaskIdentityDropPrompt {
  consequence: string;
  totalCount: number;
  directTaskCount: number;
  threadTaskCount: number;
}

const CHANNEL_SETTINGS_FORM_ID = "channel-settings-form";

function ChannelSettingsSheet({
  children,
  isDirty,
  onClose,
}: {
  children: ReactNode;
  isDirty: boolean;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <Drawer
      open={open}
      modal
      swipeDirection="right"
      disablePointerDismissal={isDirty}
      onOpenChange={(nextOpen, eventDetails) => {
        if (
          !nextOpen &&
          isDirty &&
          (eventDetails.reason === "outside-press" || eventDetails.reason === "swipe")
        ) {
          eventDetails.cancel();
          return;
        }
        setOpen(nextOpen);
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DrawerContent
        data-testid="channel-settings-sheet"
        className="inset-y-0 right-0 h-dvh w-full max-w-[min(100vw,34rem)] [--drawer-content-height:100dvh] [--drawer-inset:0px] flex-col rounded-none border-y-0 border-r-0 border-l-2 bg-brutal-cream"
      >
        {children}
      </DrawerContent>
    </Drawer>
  );
}

type EditChannelDialogProps = {
  channelId: string;
  initialName: string;
  initialDescription: string;
  onLeaveChannel?: () => Promise<void> | void;
  onClose: () => void;
  presentation?: "sheet" | "panel";
  dirtyRef?: { current: boolean };
  saveAndCloseAvailableRef?: { current: boolean };
  saveRef?: { current: (() => Promise<boolean>) | null };
  activityMute?: {
    muted: boolean;
    busy: boolean;
    onToggle: () => void;
  };
  collapseLongMessages?: {
    enabled: boolean;
    busy: boolean;
    onToggle: () => void;
  };
  stopAgentsRow?: ReactNode;
};

function GatedEditChannelDialog({
  channelId,
  initialName,
  initialDescription,
  onLeaveChannel,
  onClose,
  presentation = "sheet",
  dirtyRef,
  saveAndCloseAvailableRef,
  saveRef,
  activityMute,
  collapseLongMessages,
  stopAgentsRow,
}: EditChannelDialogProps) {
  const { formatMessage } = useIntl();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const saveStatusTimeoutRef = useRef<ReturnType<typeof setClockTimeout> | null>(null);
  const [saving, setSaving] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendStatus, setResendStatus] = useState("");
  const [resendError, setResendError] = useState("");
  const resendStatusTimeoutRef = useRef<ReturnType<typeof setClockTimeout> | null>(null);
  const [inviteServerSlug, setInviteServerSlug] = useState("");
  const [invitePeopleText, setInvitePeopleText] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteStatus, setInviteStatus] = useState("");
  const [inviteTouched, setInviteTouched] = useState({ serverSlug: false, people: false });
  const [inviteServerSlugServerError, setInviteServerSlugServerError] = useState("");
  const [invitePeopleServerError, setInvitePeopleServerError] = useState("");
  const [inviteSubmitError, setInviteSubmitError] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [showVisibilityConfirm, setShowVisibilityConfirm] = useState(false);
  const [showConvertConfirm, setShowConvertConfirm] = useState(false);
  const [taskIdentityDropPrompt, setTaskIdentityDropPrompt] = useState<TaskIdentityDropPrompt | null>(null);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [guestPolicyBusy, setGuestPolicyBusy] = useState(false);
  const [convertBusy, setConvertBusy] = useState(false);
  const updateChannel = useChannelStore((s) => s.updateChannel);
  const hideAllChannel = useChannelStore((s) => s.hideAllChannel);
  const restoreAllChannel = useChannelStore((s) => s.restoreAllChannel);
  const convertChannelToJoint = useChannelStore((s) => s.convertChannelToJoint);
  const deleteChannel = useChannelStore((s) => s.deleteChannel);
  const disconnectJointChannel = useChannelStore((s) => s.disconnectJointChannel);
  const resendJointChannelInvite = useChannelStore((s) => s.resendJointChannelInvite);
  const inviteJointChannelServer = useChannelStore((s) => s.inviteJointChannelServer);
  const archiveChannel = useChannelStore((s) => s.archiveChannel);
  const unarchiveChannel = useChannelStore((s) => s.unarchiveChannel);
  const channels = useChannelStore((s) => s.channels);
  const channel = channels.find((c) => c.id === channelId);
  const plan = useServerStore((s) => s.current?.plan) || "free";
  const canShowConvertToJointEntry = useServerStore((s) => s.current?.slug === "botiverse");
  const sidebarOrder = useServerStore((s) => s.sidebarOrder);
  const updateSidebarOrder = useServerStore((s) => s.updateSidebarOrder);
  const isJointChannel = channel?.type === "joint";
  const currentVisibility = channel?.type === "private" ? "private" : "public";
  const nextVisibility = currentVisibility === "private" ? "public" : "private";
  const isArchived = !!channel?.archivedAt;
  const pinnedRefs = sidebarOrder.pinned ?? [];
  const isPinned = hasSidebarPinnedRef(pinnedRefs, { kind: "channel", id: channelId });
  const { capabilities } = useServerPermissions();
  const effectiveCapabilities = channel?.channelCapabilities ?? capabilities;
  const nav = useAppNavigate();

  const isAllChannel = initialName === "all";
  const canEditChannel = Boolean(effectiveCapabilities.editChannelMetadata
    || effectiveCapabilities.changeChannelVisibility
    || effectiveCapabilities.archiveChannels
    || effectiveCapabilities.deleteChannels
    || effectiveCapabilities.federateChannels);
  const bridgeEditor = useChannelSlackBridgeEditor({
    channelId,
    visibility: currentVisibility,
    canManage: canEditChannel,
  });
  // task #187 `topbar_overflow_v0`: the settings sheet gains the personal
  // pin/置顶 switch (previously only reachable via the Sidebar context
  // menu). Gated so flag-off surfaces stay byte-identical.
  const topbarOverflowEnabled = useServerFeatureFlag(TOPBAR_OVERFLOW_FEATURE_FLAG_KEY).enabled;
  const serverGuestEnabled = useServerFeatureFlag(SERVER_GUEST_FEATURE_FLAG_KEY).enabled;
  const channelPinRef = { kind: "channel" as const, id: channelId };
  const handleTogglePin = () => {
    const next = isPinned
      ? removeSidebarPinnedRef(pinnedRefs, channelPinRef)
      : upsertSidebarPinnedRef(pinnedRefs, channelPinRef);
    // Same fire-and-forget contract as the Sidebar context-menu toggle.
    void updateSidebarOrder({ pinned: next });
  };
  const canUseJointChannels = plan !== "free";
  const canManageGuestAccess = Boolean(
    serverGuestEnabled &&
    effectiveCapabilities.manageGuestAccess &&
    !isArchived &&
    !isJointChannel &&
    (channel?.type === "channel" || channel?.type === "private"),
  );
  const showLeaveAction = !!onLeaveChannel && !isAllChannel && !isArchived;
  const showManageActions = canEditChannel && !isArchived;
  const showVisibilityAction = showManageActions && Boolean(effectiveCapabilities.changeChannelVisibility);
  const showConvertAction = showManageActions &&
    canShowConvertToJointEntry &&
    canUseJointChannels &&
    !isAllChannel &&
    !isJointChannel &&
    Boolean(effectiveCapabilities.federateChannels) &&
    (channel?.type === "channel" || channel?.type === "private");
  const jointServers = channel?.jointServers?.length
    ? channel.jointServers
    : channel?.jointPeerServerId || channel?.jointPeerServerSlug
      ? [{
          serverId: channel.jointPeerServerId || channel.jointPeerServerSlug || "peer",
          serverName: channel.jointPeerServerName || channel.jointPeerServerSlug || formatMessage({ id: "channel.edit.connectedServerFallback" }),
          serverSlug: channel.jointPeerServerSlug || "",
          role: null,
          status: channel.jointPeerStatus === "pending" ? "pending" as const : "active" as const,
        }]
      : [];
  const jointServerLimitReached = jointServers.length >= MAX_JOINT_CHANNEL_SERVERS;
  const hasCurrentServerPendingJointInvites = channel?.jointPendingInvites
    ? channel.jointPendingInvites.some((invite) => invite.fromServerId === channel.serverId)
    : channel?.jointPeerStatus === "pending";
  const normalizedInviteServerSlug = inviteServerSlug.trim();
  const normalizedInvitePeople = invitePeopleText
    .split(/[\n,]+/)
    .map((person) => person.trim())
    .filter(Boolean);
  const inviteServerSlugValidation = validateServerSlugReason(normalizedInviteServerSlug);
  const inviteFormValid =
    inviteServerSlugValidation === null && normalizedInvitePeople.length > 0;
  const inviteServerSlugValidationMessage = inviteServerSlugValidation?.code === "required"
    ? formatMessage({ id: "channel.edit.inviteSlugRequired" })
    : inviteServerSlugValidation?.code === "too_short"
      ? formatMessage(
          { id: "channel.edit.inviteSlugTooShort" },
          { min: inviteServerSlugValidation.minLength },
        )
      : inviteServerSlugValidation?.code === "pattern"
        ? formatMessage({ id: "channel.edit.inviteSlugPattern" })
        : "";
  const inviteServerSlugError = inviteServerSlugServerError || (
    inviteTouched.serverSlug
      ? inviteServerSlugValidationMessage
      : ""
  );
  const invitePeopleError = invitePeopleServerError || (
    inviteTouched.people && normalizedInvitePeople.length === 0
      ? formatMessage({ id: "channel.edit.inviteePersonRequired" })
      : ""
  );
  const hasInviteDraft = inviteServerSlug.length > 0 || invitePeopleText.length > 0;
  const currentBridgeSelection = bridgeEditor.snapshot?.channelPairs
    .find((pair) => pair.raftChannelId === channelId)?.slackChannelId ?? "";
  const isBridgeDirty = bridgeEditor.available
    && bridgeEditor.selectedSlackChannelId !== currentBridgeSelection;
  const isDirty = name !== initialName ||
    description !== initialDescription ||
    isBridgeDirty ||
    hasInviteDraft;

  // Keep the host's dismissal guard current from COMMITTED state only.
  // Writing the ref during render is unsafe: an abandoned concurrent
  // render could publish a stale `false` and disarm the guard while the
  // committed draft is still dirty. An effect runs after commit, so the
  // guard always reflects the state actually on screen. The write targets
  // a ref (no re-render), which react-doctor/no-event-handler cannot
  // distinguish from a real prop mutation.
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler
    if (dirtyRef) dirtyRef.current = isDirty;
  }, [dirtyRef, isDirty]);

  // The host can persist name/description through saveChanges(), but the
  // Joint invitation form is an independent, explicit side effect. Keep the
  // close prompt honest: while an unsent invitation draft exists it may only
  // keep editing or explicitly discard, never claim it can save-and-close.
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler
    if (saveAndCloseAvailableRef) saveAndCloseAvailableRef.current = !hasInviteDraft;
  }, [hasInviteDraft, saveAndCloseAvailableRef]);

  const clearSaveStatus = () => {
    if (saveStatusTimeoutRef.current !== null) {
      clearClockTimeout(saveStatusTimeoutRef.current);
      saveStatusTimeoutRef.current = null;
    }
    setSaveStatus("");
  };

  const showSaveSuccess = () => {
    clearSaveStatus();
    setSaveStatus(formatMessage({ id: "channel.edit.saveSuccess" }));
    saveStatusTimeoutRef.current = setClockTimeout(() => {
      saveStatusTimeoutRef.current = null;
      setSaveStatus("");
    }, 1500);
  };

  useEffect(() => () => {
    if (saveStatusTimeoutRef.current !== null) {
      clearClockTimeout(saveStatusTimeoutRef.current);
    }
    if (resendStatusTimeoutRef.current !== null) {
      clearClockTimeout(resendStatusTimeoutRef.current);
    }
  }, []);

  const clearResendStatus = () => {
    if (resendStatusTimeoutRef.current !== null) {
      clearClockTimeout(resendStatusTimeoutRef.current);
      resendStatusTimeoutRef.current = null;
    }
    setResendStatus("");
  };

  const showResendSuccess = (count: number) => {
    clearResendStatus();
    setResendStatus(formatMessage(
      { id: "channel.edit.inviteResentCount" },
      { count },
    ));
    resendStatusTimeoutRef.current = setClockTimeout(() => {
      resendStatusTimeoutRef.current = null;
      setResendStatus("");
    }, 1500);
  };

  // Reset the name/description draft back to the last-saved values
  // (final6 in-section Cancel).
  const isNameDescDirty = name !== initialName || description !== initialDescription;
  const hasSavableDraft = isNameDescDirty || isBridgeDirty;
  const resetDraft = () => {
    setName(initialName);
    setDescription(initialDescription);
    bridgeEditor.setSelectedSlackChannelId(currentBridgeSelection);
    setError("");
    clearSaveStatus();
  };

  // Expose the save to the host's unsaved-changes prompt. The ref is
  // re-published after every commit so it always closes over the latest
  // draft; ref writes drive no renders (same react-doctor blind spot as
  // the dirtyRef sync above).
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler
    if (saveRef) saveRef.current = saveChanges;
    return () => {
      // oxlint-disable-next-line react-doctor/no-event-handler
      if (saveRef) saveRef.current = null;
    };
  });

  const getFallbackChannel = () =>
    channels.find((candidate) => candidate.id !== channelId && candidate.name === "all") ||
    channels.find((candidate) => candidate.id !== channelId);

  /** Persist name/description. Returns true when the draft is clean
   *  afterwards (saved or nothing to save), false on validation/API
   *  failure. Does NOT close — callers decide what happens next. */
  const saveChanges = async (): Promise<boolean> => {
    setError("");
    clearSaveStatus();

    if (!canEditChannel) {
      return true;
    }

    if (!isAllChannel) {
      const nameError = formatNameValidationError(
        validateNameReason(name),
        "channel.edit.nameFieldName",
        formatMessage,
      );
      if (nameError) {
        setError(nameError);
        return false;
      }
    }

    setSaving(true);
    try {
      const updates: { name?: string; description?: string } = {};
      if (!isAllChannel && name.trim() !== initialName) {
        updates.name = name.trim();
      }
      if (description.trim() !== initialDescription) {
        updates.description = description.trim();
      }
      if (Object.keys(updates).length > 0) {
        const updated = await updateChannel(channelId, updates);
        setName(updated.name);
        setDescription(updated.description || "");
      } else {
        setName(initialName);
        setDescription(initialDescription);
      }
      try {
        await bridgeEditor.apply(channelId);
      } catch {
        setError(formatMessage({ id: "channel.bridge.partialFailure" }));
        return false;
      }
      showSaveSuccess();
      return true;
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedUpdate" }));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await saveChanges()) {
      onClose();
    }
  };

  const handleVisibilityChange = async () => {
    setError("");
    setVisibilityBusy(true);
    try {
      // #all no longer travels through the generic visibility field -- the
      // server refuses it there, because hiding #all drops its whole derived
      // audience rather than narrowing a membership list. Both directions have
      // dedicated, id-free endpoints.
      if (isAllChannel) {
        await (nextVisibility === "private" ? hideAllChannel() : restoreAllChannel());
      } else {
        await updateChannel(channelId, { visibility: nextVisibility });
      }
      setShowVisibilityConfirm(false);
      onClose();
      if (isAllChannel && nextVisibility === "private") {
        const fallbackChannel = getFallbackChannel();
        if (fallbackChannel) {
          nav.toChannel(fallbackChannel.id);
        } else {
          nav.toSettings("server");
        }
      }
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedUpdateVisibility" }));
      setShowVisibilityConfirm(false);
    } finally {
      setVisibilityBusy(false);
    }
  };

  const updateGuestPolicy = async (updates: { guestVisible?: boolean; guestJoinable?: boolean }) => {
    setError("");
    setGuestPolicyBusy(true);
    try {
      await updateChannel(channelId, updates);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedUpdateGuestAccess" }));
    } finally {
      setGuestPolicyBusy(false);
    }
  };

  const handleConvertToJoint = async () => {
    setError("");
    setConvertBusy(true);
    try {
      await convertChannelToJoint(channelId, { confirmTaskIdentityDrop: taskIdentityDropPrompt !== null });
      setShowConvertConfirm(false);
      setTaskIdentityDropPrompt(null);
      onClose();
    } catch (err: unknown) {
      const axiosErr = err as {
        response?: {
          data?: {
            error?: string;
            code?: string;
            taskIdentityDrop?: {
              consequence?: string;
              inventory?: {
                totalCount?: number;
                directTaskCount?: number;
                threadTaskCount?: number;
              };
            };
          };
        };
      };
      const response = axiosErr.response?.data;
      if (response?.code === "channel_conversion_task_identity_drop_required" && response.taskIdentityDrop?.inventory) {
        const inventory = response.taskIdentityDrop.inventory;
        setTaskIdentityDropPrompt({
          consequence: response.taskIdentityDrop.consequence || response.error || formatMessage({ id: "channel.edit.taskIdentityDropDefault" }),
          totalCount: inventory.totalCount || 0,
          directTaskCount: inventory.directTaskCount || 0,
          threadTaskCount: inventory.threadTaskCount || 0,
        });
        return;
      }
      setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedConvertJoint" }));
      setShowConvertConfirm(false);
      setTaskIdentityDropPrompt(null);
    } finally {
      setConvertBusy(false);
    }
  };

  const handleUnarchive = async () => {
    setError("");
    setArchiveBusy(true);
    try {
      await unarchiveChannel(channelId);
      onClose();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedUnarchive" }));
    } finally {
      setArchiveBusy(false);
    }
  };

  const handleResendJointInvite = async () => {
    clearResendStatus();
    setResendError("");
    setResendBusy(true);
    try {
      const result = await resendJointChannelInvite(channelId);
      showResendSuccess(result.resentCount);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setResendError(axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedResendInvite" }));
    } finally {
      setResendBusy(false);
    }
  };

  const handleInviteJointServer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setInviteTouched({ serverSlug: true, people: true });
    setInviteStatus("");
    setInviteSubmitError("");
    setInviteServerSlugServerError("");
    setInvitePeopleServerError("");
    if (!inviteFormValid) return;
    if (jointServerLimitReached) {
      setInviteSubmitError(formatMessage({ id: "channel.edit.maxServers" }, { max: MAX_JOINT_CHANNEL_SERVERS }));
      return;
    }

    setInviteBusy(true);
    try {
      await inviteJointChannelServer(channelId, {
        targetServerSlug: normalizedInviteServerSlug,
        invitedPeople: normalizedInvitePeople,
      });
      setInviteServerSlug("");
      setInvitePeopleText("");
      setInviteTouched({ serverSlug: false, people: false });
      setInviteStatus(formatMessage(
        { id: "channel.edit.inviteSentCount" },
        { count: normalizedInvitePeople.length },
      ));
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      const message = axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedInviteServer" });
      if (/target server|current server|server slug|already in this joint channel/i.test(message)) {
        setInviteServerSlugServerError(message);
      } else if (/invited person|invitee|target server admin/i.test(message)) {
        setInvitePeopleServerError(message);
      } else {
        setInviteSubmitError(message);
      }
    } finally {
      setInviteBusy(false);
    }
  };

  const handleDisconnectJointChannel = async () => {
    await disconnectJointChannel(channelId);
    const fallbackChannel = getFallbackChannel();
    onClose();
    if (fallbackChannel) {
      nav.toChannel(fallbackChannel.id);
    } else {
      nav.toSettings("server");
    }
  };

  const isPanel = presentation === "panel";

  // Action buttons as composable pieces: the legacy sheet shows one flat
  // actions group, while the drawer panel (final4) splits them by object
  // boundary — shared-resource management vs lifecycle — and leaves
  // "Leave channel" to the members section (it edits my own membership).
  const leaveActionButton = showLeaveAction && (
    <button
      type="button"
      onClick={() => setShowLeaveConfirm(true)}
      className="btn-brutal flex w-full items-center justify-center gap-1.5 bg-brutal-orange px-4 py-2 text-sm"
    >
      <LogOut size={14} />
      {formatMessage({ id: "channel.edit.leaveChannel" })}
    </button>
  );
  const visibilityActionButton = !isJointChannel && showVisibilityAction && (
    <button
      type="button"
      onClick={() => setShowVisibilityConfirm(true)}
      disabled={isArchived || visibilityBusy}
      className="btn-brutal flex w-full items-center justify-center gap-1.5 bg-brutal-orange px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {isAllChannel
        ? currentVisibility === "private" ? <Eye size={14} /> : <EyeOff size={14} />
        : currentVisibility === "private" ? <Hash size={14} /> : <Lock size={14} />}
      {visibilityBusy
        ? formatMessage({ id: "channel.edit.updating" })
        : isAllChannel
          ? currentVisibility === "private"
            ? formatMessage({ id: "channel.edit.restoreAll" })
            : formatMessage({ id: "channel.edit.hideAll" })
          : currentVisibility === "private"
            ? formatMessage({ id: "channel.edit.makePublic" })
            : formatMessage({ id: "channel.edit.makePrivate" })}
    </button>
  );
  const convertActionButton = showConvertAction && (
    <button
      type="button"
      onClick={() => {
        setTaskIdentityDropPrompt(null);
        setShowConvertConfirm(true);
      }}
      disabled={isArchived || convertBusy}
      className="btn-brutal flex w-full items-center justify-center gap-1.5 bg-brutal-lime px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <GitBranch size={14} />
      {convertBusy ? formatMessage({ id: "channel.edit.converting" }) : formatMessage({ id: "channel.edit.convertToJoint" })}
    </button>
  );
  const lifecycleActionButtons = !isAllChannel && (
    <>
      {effectiveCapabilities.archiveChannels && (isArchived ? (
        <button
          type="button"
          onClick={handleUnarchive}
          disabled={archiveBusy}
          className="btn-brutal flex w-full items-center justify-center gap-1.5 bg-brutal-lime px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ArchiveRestore size={14} />
          {archiveBusy ? formatMessage({ id: "channel.edit.unarchiving" }) : formatMessage({ id: "channel.edit.unarchiveChannel" })}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setShowArchiveConfirm(true)}
          className="btn-brutal flex w-full items-center justify-center gap-1.5 bg-brutal-orange px-4 py-2 text-sm"
        >
          <Archive size={14} />
          {formatMessage({ id: "channel.edit.archiveChannel" })}
        </button>
      ))}
      {!isArchived && effectiveCapabilities.deleteChannels && (isJointChannel ? (
        <button
          type="button"
          onClick={() => setShowDeleteConfirm(true)}
          className="btn-brutal flex w-full items-center justify-center gap-1.5 bg-brutal-red px-4 py-2 text-sm"
        >
          <Unplug size={14} />
          {formatMessage({ id: "channel.edit.disconnectChannel" })}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setShowDeleteConfirm(true)}
          className="btn-brutal flex w-full items-center justify-center gap-1.5 bg-brutal-red px-4 py-2 text-sm"
        >
          <Trash2 size={14} />
          {formatMessage({ id: "channel.edit.deleteChannel" })}
        </button>
      ))}
    </>
  );

  // final9 panel rows: the same manage/lifecycle actions rendered with
  // the drawer's action-row primitive (icon + label row, red text for
  // irreversible) instead of the sheet's filled block buttons.
  const visibilityActionRow = !isJointChannel && showVisibilityAction && (
    <OverflowActionRow
      icon={
        isAllChannel
          ? currentVisibility === "private" ? <Eye size={14} /> : <EyeOff size={14} />
          : currentVisibility === "private" ? <Hash size={14} /> : <Lock size={14} />
      }
      label={
        visibilityBusy
          ? formatMessage({ id: "channel.edit.updating" })
          : isAllChannel
            ? currentVisibility === "private"
              ? formatMessage({ id: "channel.edit.restoreAll" })
              : formatMessage({ id: "channel.edit.hideAll" })
            : currentVisibility === "private"
              ? formatMessage({ id: "channel.edit.makePublic" })
              : formatMessage({ id: "channel.edit.makePrivate" })
      }
      onClick={() => setShowVisibilityConfirm(true)}
      disabled={isArchived || visibilityBusy}
      testId="channel-settings-visibility-action"
    />
  );
  const convertActionRow = showConvertAction && (
    <OverflowActionRow
      icon={<GitBranch size={14} />}
      label={convertBusy ? formatMessage({ id: "channel.edit.converting" }) : formatMessage({ id: "channel.edit.convertToJoint" })}
      onClick={() => {
        setTaskIdentityDropPrompt(null);
        setShowConvertConfirm(true);
      }}
      disabled={isArchived || convertBusy}
      testId="channel-settings-convert-action"
    />
  );
  const archiveActionRow = !isAllChannel && effectiveCapabilities.archiveChannels && (
    isArchived ? (
      <OverflowActionRow
        icon={<ArchiveRestore size={14} />}
        label={archiveBusy ? formatMessage({ id: "channel.edit.unarchiving" }) : formatMessage({ id: "channel.edit.unarchiveChannel" })}
        onClick={() => void handleUnarchive()}
        disabled={archiveBusy}
        testId="channel-settings-archive-action"
      />
    ) : (
      <OverflowActionRow
        icon={<Archive size={14} />}
        label={formatMessage({ id: "channel.edit.archiveChannel" })}
        onClick={() => setShowArchiveConfirm(true)}
        testId="channel-settings-archive-action"
      />
    )
  );
  // Artea 2026-08-05: Delete is the group's LAST row — the destructive
  // action closes the section, after Leave. v2「重量随风险」: the ONLY
  // filled block in the whole drawer — irreversible is what earns fill;
  // reversible actions (visibility/archive/leave/stop) stay outlined.
  const deleteActionRow = !isAllChannel && effectiveCapabilities.deleteChannels && (
    isJointChannel ? (
      <OverflowActionRow
        icon={<Unplug size={14} />}
        label={formatMessage({ id: "channel.edit.disconnectChannel" })}
        onClick={() => setShowDeleteConfirm(true)}
        danger
        className="[&_[data-slot=button-content]]:justify-center"
        testId="channel-settings-delete-action"
      />
    ) : (
      <OverflowActionRow
        icon={<Trash2 size={14} />}
        label={formatMessage({ id: "channel.edit.deleteChannel" })}
        onClick={() => setShowDeleteConfirm(true)}
        danger
        className="[&_[data-slot=button-content]]:justify-center"
        testId="channel-settings-delete-action"
      />
    )
  );

  // final11 频道偏好: per-user binary settings — Pin, Mute, and the
  // collapse-long-messages switch (server-persisted). Artea 2026-08-06:
  // Channel info (name/description) leads the panel, so BOTH modes render
  // preferences AFTER the form (sheet always did; panel moved). Mute is a
  // panel-only surface via the activityMute prop.
  // v2「重量随风险」: high-frequency, zero-risk, fully reversible toggles
  // stay BARE on the paper — hairline dividers, no borders, no shadow;
  // visual weight is reserved for the action zone below.
  const preferencesSection = topbarOverflowEnabled && (
    <section className="mt-5" data-testid="channel-settings-preferences">
      <h3 className="text-base font-bold text-black">
        {formatMessage({ id: "message.chatPanel.overflow.preferencesGroup" })}
      </h3>
      <div className="mt-2 divide-y divide-black/10">
        <div className="flex items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <h4 id="channel-settings-pin-label" className="text-sm font-medium text-black">
              {formatMessage({ id: "message.channelSettings.pinTitle" })}
            </h4>
            <p className="mt-1 text-xs font-normal text-black/55">
              {formatMessage({ id: "message.channelSettings.pinDescription" })}
            </p>
          </div>
          <Switch
            size="md"
            checked={isPinned}
            onCheckedChange={handleTogglePin}
            aria-labelledby="channel-settings-pin-label"
            className="shrink-0"
            data-testid="channel-settings-pin-switch"
          />
        </div>
        {isPanel && activityMute && (
          <div className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <h4 id="channel-settings-mute-label" className="text-sm font-medium text-black">
                {formatMessage({ id: "message.channelSettings.muteActivityTitle" })}
              </h4>
              <p className="mt-1 text-xs font-normal text-black/55">
                {formatMessage({ id: "message.channelSettings.muteActivityDescription" })}
              </p>
            </div>
            <Switch
              size="md"
              checked={activityMute.muted}
              disabled={activityMute.busy}
              onCheckedChange={() => activityMute.onToggle()}
              aria-labelledby="channel-settings-mute-label"
              className="shrink-0"
              data-testid="channel-overflow-mute-switch"
            />
          </div>
        )}
        {collapseLongMessages && (
          <div className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <h4 id="channel-settings-collapse-label" className="text-sm font-medium text-black">
                {formatMessage({ id: "message.channelSettings.collapseLongMessagesTitle" })}
              </h4>
              <p className="mt-1 text-xs font-normal text-black/55">
                {formatMessage({ id: "message.channelSettings.collapseLongMessagesDescription" })}
              </p>
            </div>
            <Switch
              size="md"
              checked={collapseLongMessages.enabled}
              disabled={collapseLongMessages.busy}
              onCheckedChange={() => collapseLongMessages.onToggle()}
              aria-labelledby="channel-settings-collapse-label"
              className="shrink-0"
              data-testid="channel-settings-collapse-switch"
            />
          </div>
        )}
      </div>
    </section>
  );

  const guestAccessSection = canManageGuestAccess && (
    <section className="mt-5" data-testid="channel-settings-guest-access">
      <h3 className="text-base font-bold text-black">
        {formatMessage({ id: "channel.edit.guestAccessTitle" })}
      </h3>
      <p className="mt-1 text-xs font-normal text-black/55">
        {formatMessage({ id: "channel.edit.guestAccessDescription" })}
      </p>
      <div className="mt-2 divide-y divide-black/10">
        <div className="flex items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <h4 id="channel-settings-guest-visible-label" className="text-sm font-medium text-black">
              {formatMessage({ id: "channel.edit.guestVisibleTitle" })}
            </h4>
            <p className="mt-1 text-xs font-normal text-black/55">
              {formatMessage({ id: "channel.edit.guestVisibleDescription" })}
            </p>
          </div>
          <Switch
            size="md"
            checked={channel?.guestVisible === true}
            disabled={guestPolicyBusy || (channel?.type === "private" && channel?.name !== "all")}
            onCheckedChange={(checked) => void updateGuestPolicy(checked
              ? { guestVisible: true }
              : { guestVisible: false, guestJoinable: false })}
            aria-labelledby="channel-settings-guest-visible-label"
            data-testid="channel-settings-guest-visible-switch"
          />
        </div>
        {channel?.name !== "all" && <div className="flex items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <h4 id="channel-settings-guest-joinable-label" className="text-sm font-medium text-black">
              {formatMessage({ id: "channel.edit.guestJoinableTitle" })}
            </h4>
            <p className="mt-1 text-xs font-normal text-black/55">
              {formatMessage({ id: "channel.edit.guestJoinableDescription" })}
            </p>
          </div>
          <Switch
            size="md"
            checked={channel?.guestJoinable === true}
            disabled={guestPolicyBusy || channel?.type === "private"}
            onCheckedChange={(checked) => void updateGuestPolicy(checked
              ? { guestVisible: true, guestJoinable: true }
              : { guestJoinable: false })}
            aria-labelledby="channel-settings-guest-joinable-label"
            data-testid="channel-settings-guest-joinable-switch"
          />
        </div>}
      </div>
    </section>
  );

  // final11 生命周期四合一: visibility (Make Private) / Archive / Delete /
  // Leave — one group, ordered by the design master. Leave edits only my
  // own membership, so it renders for plain members too; the manage-gated
  // rows keep their own capability guards. Rows bleed to the panel edge
  // (-mx-4) so they align with the host drawer's own action rows.
  const leaveActionRow = showLeaveAction && (
    <OverflowActionRow
      icon={<LogOut size={14} />}
      label={formatMessage({ id: "channel.edit.leaveChannel" })}
      onClick={() => setShowLeaveConfirm(true)}
      testId="channel-overflow-leave"
    />
  );

  // Shared body: the sheet (legacy flag-off) and the overflow-drawer panel
  // (task #187) render identical sections — only the chrome differs.
  const settingsBody = (
    <>
      {isPanel && showManageActions && (
        /* The one-word Info section owns the name/description form and its
           description directly; repeating a subordinate "Channel info"
           heading would flatten the hierarchy. Members with only Leave/Mute
           (no manage capability) never see an empty header. */
        <div className="mt-5 mb-3">
          <h3
            className="text-base font-bold text-black"
            data-testid="channel-settings-manage-group"
          >
            {formatMessage({ id: "message.chatPanel.overflow.manageGroup" })}
          </h3>
          <p
            className="mt-1 text-xs font-normal text-black/55"
            data-testid="channel-settings-info-description"
          >
            {formatMessage({ id: "message.channelSettings.infoDescription" })}
          </p>
        </div>
      )}
      <form id={CHANNEL_SETTINGS_FORM_ID} onSubmit={handleSubmit} className="space-y-5">
        {error && (
          <Banner
            intent="warning"
            className="font-bold"
            role="alert"
            data-testid="channel-settings-save-error"
          >
            {error}
          </Banner>
        )}
        {canEditChannel && (
          <section className="space-y-3 border-b border-black/10 pb-5">
            <div className="space-y-3">
                  <FormField
                    label={formatMessage({ id: "channel.edit.nameLabel" })}
                    labelStyle="plain"
                    className="[&>label]:!font-medium"
                    htmlFor="channel-settings-name"
                    required
                    hint={
                      isAllChannel
                        ? formatMessage({ id: "channel.edit.allCannotRename" })
                        : isJointChannel
                          ? formatMessage({ id: "channel.edit.jointNameShared" })
                          : undefined
                    }
                  >
                    <input
                      id="channel-settings-name"
                      type="text"
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value);
                        setError("");
                        clearSaveStatus();
                      }}
                      className="input-brutal w-full"
                      placeholder={formatMessage({ id: "channel.edit.namePlaceholder" })}
                      required
                      autoFocus={!isPanel}
                      disabled={isAllChannel || isArchived}
                    />
                  </FormField>
                  <FormField
                    label={formatMessage({ id: "channel.edit.descriptionLabel" })}
                    labelStyle="plain"
                    className="[&>label]:!font-medium"
                    htmlFor="channel-settings-description"
                    optional
                  >
                    <textarea
                      id="channel-settings-description"
                      value={description}
                      onChange={(e) => {
                        setDescription(e.target.value);
                        setError("");
                        clearSaveStatus();
                      }}
                      className="input-brutal w-full"
                      placeholder={formatMessage({ id: "channel.edit.descriptionPlaceholder" })}
                      rows={2}
                      disabled={isArchived}
                    />
                  </FormField>
                  {isPanel && (
                    /* Save/Cancel live inside the editable section in panel
                       mode. The same action also commits an optional Slack
                       bridge selection without closing the drawer. */
                    <>
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          onClick={resetDraft}
                          disabled={!hasSavableDraft || saving}
                          size="sm"
                          tone="white"
                          className="disabled:cursor-not-allowed disabled:opacity-50"
                          data-testid="channel-settings-discard-draft"
                        >
                          {formatMessage({ id: "settings.common.cancel" })}
                        </Button>
                        <Button
                          type="button"
                          onClick={() => void saveChanges()}
                          disabled={!hasSavableDraft || saving || isArchived}
                          size="sm"
                          shape="iconText"
                          tone={saveStatus ? "lime" : "pink"}
                          className="disabled:cursor-not-allowed disabled:opacity-50"
                          data-testid="channel-settings-save-inline"
                        >
                          {saving
                            ? formatMessage({ id: "channel.edit.saving" })
                            : saveStatus
                              ? <><Check size={12} aria-hidden="true" /> {saveStatus}</>
                              : formatMessage({ id: "channel.edit.saveChanges" })}
                        </Button>
                      </div>
                      {saveStatus && (
                        <span
                          className="sr-only"
                          role="status"
                          aria-live="polite"
                          data-testid="channel-settings-save-status"
                        >
                          {saveStatus}
                        </span>
                      )}
                    </>
                  )}
            </div>
          </section>
        )}
      </form>
      {canEditChannel && !isArchived && (channel?.type === "channel" || channel?.type === "private") && (
        <ChannelSlackBridgeField
          editor={bridgeEditor}
          visibility={currentVisibility}
          disabled={saving}
        />
      )}
      {isJointChannel && (
        <section
          className="space-y-4 border-b border-black/10 pb-5"
          data-testid="channel-settings-joint-section"
        >
                <div>
                  <h3 className="text-base font-bold text-black">
                    {formatMessage({ id: "message.channelSettings.jointTitle" })}
                  </h3>
                  <p className="mt-1 text-xs font-normal text-black/55">
                    {formatMessage({ id: "message.channelSettings.jointDescription" })}
                  </p>
                </div>
                <div>
                  <h4 className="text-sm font-medium text-black">
                    {formatMessage({ id: "channel.edit.connectedServers" })}
                  </h4>
                  {jointServers.length > 0 ? (
                    <div
                      className="mt-2 divide-y divide-black/10"
                      data-testid="channel-settings-joint-servers"
                    >
                      {jointServers.map((server) => (
                        <div
                          key={`${server.serverId}:${server.status}`}
                          className="flex items-center justify-between gap-3 py-3"
                          data-testid="channel-settings-joint-server-row"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-black">
                              {server.serverName || server.serverSlug}
                            </div>
                            <div className="mt-1 truncate text-xs font-normal text-black/55">
                              {server.serverSlug}
                              {server.isCurrentServer ? ` · ${formatMessage({ id: "channel.edit.thisServer" })}` : ""}
                            </div>
                          </div>
                          <span className={`shrink-0 border-[1.5px] border-black px-2 py-px text-[11px] font-bold ${server.status === "active" ? "bg-brutal-lime" : "bg-soft-signal"}`}>
                            {formatMessage({
                              id: server.status === "active"
                                ? "channel.edit.serverStatusActive"
                                : "channel.edit.serverStatusPending",
                            })}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-black/70">{formatMessage({ id: "channel.edit.connectedMetaUnavailable" })}</p>
                  )}
                </div>
                {effectiveCapabilities.federateChannels && hasCurrentServerPendingJointInvites && !isArchived && (
                  <div className="space-y-2">
                    <div
                      className="flex justify-end"
                      data-testid="channel-settings-joint-resend-row"
                    >
                      <Button
                        type="button"
                        onClick={handleResendJointInvite}
                        disabled={resendBusy}
                        size="sm"
                        shape="iconText"
                        tone={resendStatus ? "lime" : "white"}
                        className="disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {resendStatus
                          ? <Check size={14} aria-hidden="true" />
                          : <Mail size={14} aria-hidden="true" />}
                        <span
                          className="grid w-max whitespace-nowrap"
                          data-testid="channel-settings-joint-resend-label-grid"
                        >
                          <span aria-hidden="true" className="invisible col-start-1 row-start-1">
                            {formatMessage({ id: "channel.edit.resendInvite" })}
                          </span>
                          <span aria-hidden="true" className="invisible col-start-1 row-start-1">
                            {formatMessage({ id: "channel.edit.resending" })}
                          </span>
                          <span aria-hidden="true" className="invisible col-start-1 row-start-1">
                            {formatMessage({ id: "channel.edit.resendSuccess" })}
                          </span>
                          <span className="col-start-1 row-start-1" data-testid="channel-settings-joint-resend-label">
                            {resendBusy
                              ? formatMessage({ id: "channel.edit.resending" })
                              : resendStatus
                                ? formatMessage({ id: "channel.edit.resendSuccess" })
                                : formatMessage({ id: "channel.edit.resendInvite" })}
                          </span>
                        </span>
                      </Button>
                    </div>
                    {resendStatus && (
                      <span
                        className="sr-only"
                        role="status"
                        aria-live="polite"
                        data-testid="channel-settings-joint-resend-status"
                      >
                        {resendStatus}
                      </span>
                    )}
                    {resendError && (
                      <p className="text-xs font-bold text-brutal-red" role="alert">{resendError}</p>
                    )}
                  </div>
                )}
                {effectiveCapabilities.federateChannels && !isArchived && (
                  <div
                    className="space-y-3 border-t border-black/10 pt-4"
                    data-testid="channel-settings-joint-invite"
                  >
                    <h4 className="text-sm font-medium text-black">
                      {formatMessage({ id: "channel.edit.inviteServerSection" })}
                    </h4>
                    {jointServerLimitReached ? (
                      <p className="text-sm font-bold text-black/70">
                        {formatMessage({ id: "channel.edit.maxServers" }, { max: MAX_JOINT_CHANNEL_SERVERS })}
                      </p>
                    ) : (
                      <form
                        className="space-y-3"
                        data-testid="channel-settings-joint-invite-form"
                        onSubmit={handleInviteJointServer}
                        noValidate
                      >
                        <FormField
                          label={formatMessage({ id: "channel.edit.serverSlugLabel" })}
                          labelStyle="plain"
                          required
                          htmlFor="channel-settings-joint-server-slug"
                          error={inviteServerSlugError}
                        >
                          <SlugInput
                            id="channel-settings-joint-server-slug"
                            name="targetServerSlug"
                            type="text"
                            value={inviteServerSlug}
                            onChange={(e) => {
                              setInviteServerSlug(e.target.value);
                              setInviteServerSlugServerError("");
                              setInviteSubmitError("");
                              setInviteStatus("");
                            }}
                            onBlur={() => setInviteTouched((current) => ({ ...current, serverSlug: true }))}
                            placeholder={formatMessage({ id: "channel.edit.serverSlugPlaceholder" })}
                            required
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            aria-invalid={inviteServerSlugError ? "true" : undefined}
                            disabled={inviteBusy}
                          />
                        </FormField>
                        <FormField
                          label={formatMessage({ id: "channel.edit.invitedPeopleLabel" })}
                          labelStyle="plain"
                          required
                          hint={formatMessage({ id: "channel.edit.invitedPeopleHint" })}
                          htmlFor="channel-settings-joint-invited-people"
                          error={invitePeopleError}
                        >
                          <textarea
                            id="channel-settings-joint-invited-people"
                            name="invitedPeople"
                            value={invitePeopleText}
                            onChange={(e) => {
                              setInvitePeopleText(e.target.value);
                              setInvitePeopleServerError("");
                              setInviteSubmitError("");
                              setInviteStatus("");
                            }}
                            onBlur={() => setInviteTouched((current) => ({ ...current, people: true }))}
                            className="input-brutal w-full"
                            placeholder={formatMessage({ id: "channel.edit.invitedPeoplePlaceholder" })}
                            rows={2}
                            required
                            aria-invalid={invitePeopleError ? "true" : undefined}
                            disabled={inviteBusy}
                          />
                        </FormField>
                        <div className="flex justify-end" data-testid="channel-settings-joint-send-invite-row">
                          <Button
                            type="submit"
                            disabled={inviteBusy || !inviteFormValid}
                            size="sm"
                            shape="iconText"
                            tone="pink"
                            className="disabled:cursor-not-allowed disabled:opacity-50"
                            data-testid="channel-settings-joint-send-invite"
                          >
                            <Mail size={14} />
                            {inviteBusy ? formatMessage({ id: "channel.edit.inviting" }) : formatMessage({ id: "channel.edit.sendInvite" })}
                          </Button>
                        </div>
                        {inviteSubmitError && (
                          <Banner intent="warning" className="font-bold" data-testid="channel-settings-joint-invite-submit-error">
                            {inviteSubmitError}
                          </Banner>
                        )}
                        {inviteStatus && (
                          <p className="text-xs font-bold text-black/70" role="status">{inviteStatus}</p>
                        )}
                      </form>
                    )}
                  </div>
                )}
        </section>
      )}

          {guestAccessSection}
          {preferencesSection}

          {isPanel ? (
            /* final11 object boundaries in the drawer: the Joint convert
               row continues the 频道管理 group whose header sits above the
               name/description form. v2「重量随风险」 keeps lifecycle actions
               ordered visibility → Archive → Leave → Stop agents → Delete,
               with Delete as the only filled action. Artea 2026-08-09:
               render these as centered, vertically stacked raft-ui Buttons;
               the container adds no competing border or shadow. Leave still
               renders without manage capability. */
            <>
              {showManageActions && convertActionRow && (
                <div className="mt-3 -mx-4">
                  {convertActionRow}
                </div>
              )}
              {((showManageActions && (visibilityActionRow || archiveActionRow || deleteActionRow)) || (isArchived && archiveActionRow) || leaveActionRow || (!isArchived && stopAgentsRow)) && (
                <section className="mt-5" data-testid="channel-settings-lifecycle-group">
                  <h3 className="text-base font-bold text-black">
                    {formatMessage({ id: "message.chatPanel.overflow.lifecycleGroup" })}
                  </h3>
                  <div
                    className="mt-2 flex flex-col gap-2 [&_[data-slot=button-content]]:!justify-center"
                    data-testid="channel-settings-action-zone"
                  >
                    {showManageActions && visibilityActionRow}
                    {(showManageActions || isArchived) && archiveActionRow}
                    {leaveActionRow}
                    {!isArchived && stopAgentsRow}
                    {showManageActions && deleteActionRow}
                  </div>
                </section>
              )}
            </>
          ) : (
            (showLeaveAction || showManageActions || (isArchived && effectiveCapabilities.archiveChannels)) && (
              <section className="mt-5 space-y-3">
                <div>
                  <h3 className="text-xs font-bold tracking-wide text-black/65">
                    {formatMessage({ id: "message.channelSettings.actionsTitle" })}
                  </h3>
                  <p className="mt-1 text-xs text-black/60">
                    {formatMessage({ id: "message.channelSettings.actionsDescription" })}
                  </p>
                </div>
                <div className="flex flex-col gap-3">
                  {leaveActionButton}
                  {visibilityActionButton}
                  {convertActionButton}
                  {lifecycleActionButtons}
                </div>
              </section>
            )
          )}
    </>
  );

  const saveButton = canEditChannel && (
    <button
      type="submit"
      form={CHANNEL_SETTINGS_FORM_ID}
      disabled={saving || isArchived}
      className="btn-brutal bg-brutal-pink px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {saving ? formatMessage({ id: "channel.edit.saving" }) : formatMessage({ id: "channel.edit.saveChanges" })}
    </button>
  );

  return (
    <>
      {isPanel ? (
        /* Drawer-embedded flat sections (task #187): same body as the
           sheet, no Drawer chrome, and no global footer — final6 moves
           Save/Cancel into the name/description section; closing is the
           host drawer's job (guarded by the unsaved-changes prompt).
           v2: identity lives in the yellow header, so the panel drops
           its own title and keeps only a hairline from the members
           strip above. */
        <div className="safe-bottom border-t border-black/10 px-4 pt-3" data-testid="channel-settings-panel">
          {settingsBody}
        </div>
      ) : (
        <ChannelSettingsSheet isDirty={isDirty} onClose={onClose}>
          <div className="flex shrink-0 items-center justify-between gap-4 border-b-2 border-black bg-soft-signal px-4 py-3">
            <div className="min-w-0">
              <p className="text-[10px] font-bold tracking-wide text-black/55">
                {formatMessage({ id: "message.channelSettings.eyebrow" })}
              </p>
              <DrawerTitle id="channel-settings-title" className="truncate font-display text-xl font-bold">
                {formatMessage({ id: "message.channelSettings.title" })}
              </DrawerTitle>
              <DrawerDescription className="truncate font-mono text-xs text-black/60">
                #{initialName}
              </DrawerDescription>
            </div>
            <DrawerClose
              render={(
                <button
                  type="button"
                  className="btn-brutal-sm bg-white p-1"
                  aria-label={formatMessage({ id: "message.channelSettings.close" })}
                />
              )}
            >
              <X size={20} />
            </DrawerClose>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {settingsBody}
          </div>

          <div className="safe-bottom flex shrink-0 justify-end gap-3 border-t-2 border-black bg-brutal-cream px-4 py-3">
            <DrawerClose
              render={(
                <button
                  type="button"
                  className="btn-brutal bg-white px-4 py-2 text-sm"
                />
              )}
            >
              {formatMessage({ id: "settings.common.cancel" })}
            </DrawerClose>
            {saveButton}
          </div>
        </ChannelSettingsSheet>
      )}

      {showArchiveConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "channel.edit.archiveChannel" })}
          message={formatMessage({ id: "channel.edit.confirmArchive" }, { name: initialName })}
          confirmLabel={formatMessage({ id: "channel.edit.archiveAction" })}
          loadingLabel={formatMessage({ id: "channel.edit.archiving" })}
          confirmColor="bg-brutal-orange"
          layer={1}
          onConfirm={async () => {
            try {
              await archiveChannel(channelId);
              setShowArchiveConfirm(false);
              onClose();
            } catch (err: unknown) {
              const axiosErr = err as { response?: { data?: { error?: string } } };
              setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedArchive" }));
              setShowArchiveConfirm(false);
            }
          }}
          onClose={() => setShowArchiveConfirm(false)}
        />
      )}

      {showVisibilityConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={
            isAllChannel
              ? currentVisibility === "private" ? formatMessage({ id: "channel.edit.restoreAll" }) : formatMessage({ id: "channel.edit.hideAll" })
              : currentVisibility === "private" ? formatMessage({ id: "channel.edit.makeChannelPublic" }) : formatMessage({ id: "channel.edit.makeChannelPrivate" })
          }
          message={
            isAllChannel
              ? currentVisibility === "private"
                ? formatMessage({ id: "channel.edit.confirmRestoreAll" })
                : formatMessage({ id: "channel.edit.confirmHideAll" })
              : currentVisibility === "private"
                ? formatMessage({ id: "channel.edit.confirmMakePublic" }, { name: initialName })
                : formatMessage({ id: "channel.edit.confirmMakePrivate" }, { name: initialName })
          }
          confirmLabel={
            isAllChannel
              ? currentVisibility === "private" ? formatMessage({ id: "channel.edit.restoreAll" }) : formatMessage({ id: "channel.edit.hideAll" })
              : currentVisibility === "private" ? formatMessage({ id: "channel.edit.confirmPublicAction" }) : formatMessage({ id: "channel.edit.confirmPrivateAction" })
          }
          loadingLabel={formatMessage({ id: "channel.edit.updating" })}
          confirmColor="bg-brutal-orange"
          layer={1}
          onConfirm={handleVisibilityChange}
          onClose={() => setShowVisibilityConfirm(false)}
        />
      )}

      {showLeaveConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "channel.edit.leaveChannel" })}
          message={formatMessage({ id: "channel.edit.confirmLeave" }, { name: initialName })}
          confirmLabel={formatMessage({ id: "channel.edit.leaveAction" })}
          loadingLabel={formatMessage({ id: "channel.edit.leaving" })}
          confirmColor="bg-brutal-orange"
          confirmTestId={isPanel ? "channel-overflow-leave-confirm" : undefined}
          layer={1}
          onConfirm={async () => {
            await onLeaveChannel?.();
            onClose();
          }}
          onClose={() => setShowLeaveConfirm(false)}
        />
      )}

      {showConvertConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "channel.edit.convertToJoint" })}
          message={taskIdentityDropPrompt ? (
            <p>
              {taskIdentityDropPrompt.consequence}
              <strong className="ml-1">
                {formatMessage(
                  { id: "channel.edit.taskIdentityDropCount" },
                  {
                    count: taskIdentityDropPrompt.totalCount,
                    direct: taskIdentityDropPrompt.directTaskCount,
                    threads: taskIdentityDropPrompt.threadTaskCount,
                  },
                )}
              </strong>
            </p>
          ) : formatMessage({ id: "channel.edit.confirmConvert" }, { name: initialName })}
          confirmLabel={formatMessage({ id: "channel.edit.convertAction" })}
          loadingLabel={formatMessage({ id: "channel.edit.converting" })}
          confirmColor={taskIdentityDropPrompt ? "bg-brutal-orange" : "bg-brutal-lime"}
          layer={1}
          closeOnConfirm={false}
          onConfirm={handleConvertToJoint}
          onClose={() => {
            setTaskIdentityDropPrompt(null);
            setShowConvertConfirm(false);
          }}
        />
      )}

      {showDeleteConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={isJointChannel ? formatMessage({ id: "channel.edit.disconnectJointChannel" }) : formatMessage({ id: "channel.edit.deleteChannel" })}
          message={isJointChannel
            ? formatMessage({ id: "channel.edit.confirmDisconnect" }, { name: initialName })
            : formatMessage({ id: "channel.edit.confirmDelete" }, { name: initialName })}
          confirmLabel={isJointChannel ? formatMessage({ id: "channel.edit.disconnectAction" }) : formatMessage({ id: "channel.edit.deleteAction" })}
          loadingLabel={isJointChannel ? formatMessage({ id: "channel.edit.disconnecting" }) : formatMessage({ id: "channel.edit.deleting" })}
          layer={1}
          onConfirm={async () => {
            if (isJointChannel) {
              await handleDisconnectJointChannel();
              return;
            }
            await deleteChannel(channelId);
            const fallbackChannel = getFallbackChannel();
            onClose();
            if (fallbackChannel) {
              nav.toChannel(fallbackChannel.id);
            } else {
              nav.toSettings("server");
            }
          }}
          onClose={() => setShowDeleteConfirm(false)}
        />
      )}
    </>
  );
}

export default function EditChannelDialog(props: EditChannelDialogProps) {
  const topbarOverflowEnabled = useServerFeatureFlag(
    TOPBAR_OVERFLOW_FEATURE_FLAG_KEY,
  ).enabled;

  if (!topbarOverflowEnabled) {
    if (props.presentation === "panel") return null;
    return (
      <LegacyEditChannelDialog
        channelId={props.channelId}
        initialName={props.initialName}
        initialDescription={props.initialDescription}
        onLeaveChannel={props.onLeaveChannel}
        onClose={props.onClose}
      />
    );
  }

  return <GatedEditChannelDialog {...props} />;
}
