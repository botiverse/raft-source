import {
  Badge,
  Button,
  Input,
  ListRow,
  ListRowBody,
  ListRowDescription,
  ListRowGroup,
  ListRowIcon,
  ListRowTitle,
  ListRowTop,
  Textarea,
} from "@botiverse/raft-ui";
import { formatJointInviteRateLimited, jointDisconnectGuestRefusalMessage } from "../../utils/jointChannelLimit";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { formatNameValidationError } from "../../i18n/nameValidation";
import { Archive, ArchiveRestore, Check, Info, Mail, Pencil, Server, SlidersHorizontal, Square, Trash2, Unplug } from "lucide-react";
import { useChannelStore } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import { showToast } from "../../components/toastBridge";
import { useAuthStore } from "../../store/authStore";
import { ChannelPreferencesSection } from "../../components/channel/ChannelPreferencesSection";
import { ChannelAnnouncementField } from "../../components/channel/ChannelAnnouncementField";
import { ChannelVisitorVisibleField } from "../../components/channel/ChannelVisitorVisibleField";
import {
  EXTERNAL_CHANNELS_FEATURE_FLAG_KEY,
  MAX_JOINT_CHANNEL_SERVERS,
  clearClockTimeout,
  setClockTimeout,
  validateNameReason,
  validateServerSlugReferenceReason,
} from "@botiverse/raft-shared";
import Banner from "../../components/ui/Banner";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import SectionHeader from "../../components/ui/SectionHeader";
import Tooltip from "../../components/ui/Tooltip";
import { PHONE_MEDIA_QUERY } from "../../components/ui/NarrowDialog";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import ConfirmDialog from "../../components/ConfirmDialog";
import LeaveChannelConfirmDialog from "../../components/channel/LeaveChannelConfirmDialog";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import FormField from "../../components/ui/FormField";
import { ChannelSlackBridgeRow, useChannelSlackBridgeEditor } from "../../components/channel/ChannelSlackBridgeField";
import SlugInput from "../../components/ui/SlugInput";
import { useSidePanelEscapeStep } from "../../components/task/sidePanelEscape";
import { useChannelConversionState } from "../../hooks/useChannelConversionState";
import JointAttachmentUploadSection, { useActiveAttachmentUploads } from "../../components/channel/JointAttachmentUploadSection";
import { SameAdminJointNotice } from "../../components/channel/SameAdminJointNotice";
import { JointServerDisconnectAction } from "../../components/channel/JointServerDisconnectAction";
import { ConnectedServersMenu } from "../../components/channel/ConnectedServersMenu";
import { useConnectedByYou, useMemberConnectRows } from "../../components/channel/memberConnect";
import { ArchivedNameCollisionBanner } from "../../components/channel/ArchivedNameCollisionBanner";
import { parseArchivedNameCollision } from "../../components/channel/archivedNameCollision";
import { LeaveChannelKindIcon } from "../../components/channel/channelKindIcon";
import { ChannelDetailsIdentity } from "../../components/channel/ChannelDetailsSurface";
import { channelDetailsExternal } from "../../components/channel/channelDetails";
import { findSameAdminJointTarget, parseInvitedPeopleText } from "../../utils/jointSameAdmin";

const CHANNEL_SETTINGS_FORM_ID = "channel-settings-form";

type EditChannelDialogProps = {
  channelId: string;
  initialName: string;
  initialDescription: string;
  onLeaveChannel?: () => Promise<void> | void;
  onClose: () => void;
  /** The channel has a Guest or an open external invite: it stays private,
   *  so Make Public is disabled with the reason (#wg-rbac:#16). */
  externalMembersKeepPrivate?: boolean;
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
  /** Stop all agents, for the actions card (ChannelOverflowMenu passes it where the person may). */
  onStopAllAgents?: () => void;
  /** The members card, under the channel's name and description (ChannelOverflowMenu's MembersStrip). */
  membersSlot?: ReactNode;
};

export function EditChannelDialog({
  channelId,
  initialName,
  initialDescription,
  onLeaveChannel,
  onClose,
  externalMembersKeepPrivate = false,
  dirtyRef,
  saveAndCloseAvailableRef,
  saveRef,
  activityMute,
  collapseLongMessages,
  onStopAllAgents,
  membersSlot,
}: EditChannelDialogProps) {
  const { formatMessage } = useIntl();
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  const { state: serverConversion, pendingCommand } = useChannelConversionState(channelId);
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  // Read first (raft-design channel.md): the name and description turn into fields only after Edit.
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  /** A rename to a name an archived channel holds (#proj-chat:#19). */
  const [archivedCollision, setArchivedCollision] = useState<ReturnType<typeof parseArchivedNameCollision>>(null);
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
  const [inviteSameAdminConfirmed, setInviteSameAdminConfirmed] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [showVisibilityConfirm, setShowVisibilityConfirm] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const updateChannel = useChannelStore((s) => s.updateChannel);
  const hideAllChannel = useChannelStore((s) => s.hideAllChannel);
  const restoreAllChannel = useChannelStore((s) => s.restoreAllChannel);
  const deleteChannel = useChannelStore((s) => s.deleteChannel);
  const disconnectJointChannel = useChannelStore((s) => s.disconnectJointChannel);
  const resendJointChannelInvite = useChannelStore((s) => s.resendJointChannelInvite);
  const inviteJointChannelServer = useChannelStore((s) => s.inviteJointChannelServer);
  const archiveChannel = useChannelStore((s) => s.archiveChannel);
  const unarchiveChannel = useChannelStore((s) => s.unarchiveChannel);
  const channels = useChannelStore((s) => s.channels);
  const channel = channels.find((c) => c.id === channelId);
  const currentServerSlug = useServerStore((s) => s.current?.slug ?? null);
  const currentServerName = useServerStore((s) => s.current?.name ?? "");
  const serverPublicPageLive = useServerStore((s) => s.current?.publicPageLive);
  const servers = useServerStore((s) => s.servers);
  const currentUser = useAuthStore((s) => s.user);
  // With external_channels_v1 on, inviting people outside the Server needs no
  // conversion first (design v5.0 A1), and it is what converts a channel: the
  // conversion section only follows a conversion already under way. Convert
  // to joint is retired on every Server (#wg-rbac:#50), so there is no offer.
  const externalChannels = useServerFeatureFlag(EXTERNAL_CHANNELS_FEATURE_FLAG_KEY);
  // With it on, new server invitations and their resend are closed
  // (#wg-rbac:45b37df9): pending ones stay listed until accepted or expired.
  // Until the flag is read they wait too, so they never flash on a Server that has External.
  const serverInviteOfferAllowed = externalChannels.resolved && !externalChannels.enabled;
  const isJointChannel = channel?.type === "joint";
  const currentVisibility = channel?.type === "private" ? "private" : "public";
  const nextVisibility = currentVisibility === "private" ? "public" : "private";
  const isArchived = !!channel?.archivedAt;
  const { capabilities } = useServerPermissions();
  const effectiveCapabilities = channel?.channelCapabilities ?? capabilities;
  const nav = useAppNavigate();
  // A conversion to an external channel under way (the conversation's
  // ChannelConversionStrip follows it and owns Retry and Cancel). The durable
  // receipt, or a command this browser sent that has no receipt yet, keeps
  // the completed external-channel settings and the private connect offer
  // away until it settles; channel.type alone is not the authority.
  const conversionInProgress = Boolean(pendingCommand) || serverConversion.command?.status === "pending" || Boolean(
    serverConversion.job && ["pending", "running", "failed"].includes(serverConversion.job.status),
  );
  const showCompletedJointSettings = isJointChannel && !conversionInProgress;
  const {
    uploads: activeAttachmentUploads,
    cancelBusyId: activeAttachmentUploadCancelBusyId,
    cancelUpload: cancelActiveAttachmentUpload,
  } = useActiveAttachmentUploads(channelId, showCompletedJointSettings || conversionInProgress);
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
  // Personal preferences are available in the settings sheet.
  const showLeaveAction = !!onLeaveChannel && !isAllChannel && !isArchived;
  const showManageActions = canEditChannel && !isArchived;
  // A joint channel's name and description are the host's to edit; another
  // server's admin there may only disconnect it (deleteChannels), not rename.
  const canEditInfo = isJointChannel ? Boolean(effectiveCapabilities.editChannelMetadata) : canEditChannel;
  const showVisibilityAction = showManageActions && Boolean(effectiveCapabilities.changeChannelVisibility);
  const showChannelInfoSettings = !isJointChannel || showCompletedJointSettings;
  // Edit opens the name and description in place (read first, raft-design channel.md).
  const canStartEditing = showManageActions && canEditInfo && showChannelInfoSettings;
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
  // The host's owner/admin in the channel may disconnect another server
  // (#wg-rbac:#52): this server hosts it, external_channels_v1 is on for it, and the
  // channel's own federateChannels (host entry, inherited, can open it) is
  // the server's check. Never the server-wide fallback, nor the legacy
  // peer row (its id may be a slug).
  const canDisconnectJointServers = showCompletedJointSettings && channel?.jointRole === "host"
    && externalChannels.enabled && channel.channelCapabilities?.federateChannels === true
    && Boolean(channel.jointServers?.length);
  // The host leads the list (it may be this server: same row, listed once);
  // the rest keep the order the server sent.
  // A member connects a server they own or administer (#wg-rbac:#36): the
  // ⋯ on Connected servers' heading, drawn only when they have one to
  // connect. A private channel takes one too (cindyz 38086073): it then
  // shows Connected servers with its one row, this server as the host.
  const memberConnect = useMemberConnectRows(channel);
  const connectedByYou = useConnectedByYou(channelId);
  const currentServerRole = useServerStore((s) => s.current?.role ?? null);
  const showPrivateConnectSection = channel?.type === "private" && !conversionInProgress && !isArchived && memberConnect.available;
  const jointServerRows = showPrivateConnectSection
    ? [{
        serverId: channel.serverId ?? "current",
        serverName: currentServerName,
        serverSlug: currentServerSlug ?? "",
        role: "host" as const,
        status: "active" as const,
        isCurrentServer: true,
      }]
    : [
        ...jointServers.filter((server) => server.role === "host"),
        ...jointServers.filter((server) => server.role !== "host"),
      ];
  const memberConnectHostName = jointServerRows.find((server) => server.role === "host")?.serverName || currentServerName;
  const hasCurrentServerPendingJointInvites = channel?.jointPendingInvites
    ? channel.jointPendingInvites.some((invite) => invite.fromServerId === channel.serverId)
    : channel?.jointPeerStatus === "pending";
  const normalizedInviteServerSlug = inviteServerSlug.trim();
  const normalizedInvitePeople = parseInvitedPeopleText(invitePeopleText);
  // RFC 075 §4.5: inviting yourself on a server you administer connects
  // directly (no email) once explicitly confirmed.
  const inviteSameAdminTarget = findSameAdminJointTarget({
    servers,
    currentServerSlug,
    user: currentUser,
    targetServerSlug: normalizedInviteServerSlug,
    invitedPeople: normalizedInvitePeople,
  });
  const inviteServerSlugValidation = validateServerSlugReferenceReason(normalizedInviteServerSlug);
  const inviteFormValid =
    inviteServerSlugValidation === null && normalizedInvitePeople.length > 0;
  const inviteServerSlugValidationMessage = inviteServerSlugValidation?.code === "required"
    ? formatMessage({ id: "channel.edit.inviteSlugRequired" })
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
  // Slack is no longer part of this draft: its own dialog applies it (ChannelSlackBridgeRow).
  // The name and description are a draft only while their fields are on screen: read first, the values follow the
  // channel (a rename by someone else, an archive) and are never a hidden draft that Save and close would write back.
  const isNameDescDirty = editing && canStartEditing && (name !== initialName || description !== initialDescription);
  const isDirty = isNameDescDirty || hasInviteDraft;

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

  const clearSaveStatus = useCallback(() => {
    if (saveStatusTimeoutRef.current !== null) {
      clearClockTimeout(saveStatusTimeoutRef.current);
      saveStatusTimeoutRef.current = null;
    }
    setSaveStatus("");
  }, []);

  const showSaveSuccess = useCallback(() => {
    clearSaveStatus();
    setSaveStatus(formatMessage({ id: "channel.edit.saveSuccess" }));
    saveStatusTimeoutRef.current = setClockTimeout(() => {
      saveStatusTimeoutRef.current = null;
      setSaveStatus("");
    }, 1500);
  }, [clearSaveStatus, formatMessage]);

  useEffect(() => () => {
    if (saveStatusTimeoutRef.current !== null) {
      clearClockTimeout(saveStatusTimeoutRef.current);
    }
    if (resendStatusTimeoutRef.current !== null) {
      clearClockTimeout(resendStatusTimeoutRef.current);
    }
  }, []);

  const clearResendStatus = useCallback(() => {
    if (resendStatusTimeoutRef.current !== null) {
      clearClockTimeout(resendStatusTimeoutRef.current);
      resendStatusTimeoutRef.current = null;
    }
    setResendStatus("");
  }, []);

  const showResendSuccess = useCallback((count: number) => {
    clearResendStatus();
    setResendStatus(formatMessage(
      { id: "channel.edit.inviteResentCount" },
      { count },
    ));
    resendStatusTimeoutRef.current = setClockTimeout(() => {
      resendStatusTimeoutRef.current = null;
      setResendStatus("");
    }, 1500);
  }, [clearResendStatus, formatMessage]);

  // Reset the name/description draft back to the last-saved values
  // (final6 in-section Cancel).
  const resetDraft = useCallback(() => {
    setName(initialName);
    setDescription(initialDescription);
    setError("");
    setArchivedCollision(null);
    clearSaveStatus();
    setEditing(false);
  }, [initialName, initialDescription, clearSaveStatus]);

  // Cancel, the button or Escape, puts focus back on Edit: the field that had it is gone, and focus stays in the
  // details, so the next Escape closes them (raft-design panel.md).
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusEditRef = useRef(false);
  const cancelEdit = useCallback(() => {
    focusEditRef.current = true;
    resetDraft();
  }, [resetDraft]);
  useEffect(() => {
    if (editing || !focusEditRef.current) return;
    focusEditRef.current = false;
    editButtonRef.current?.focus();
  }, [editing]);
  // Escape in the details cancels an open edit before it closes them, as Cancel does, but never drops typed text
  // unasked: with changes it is not this step's, so it reaches the details' close, which asks first (the
  // unsaved-changes prompt). While saving, Cancel is disabled and so is this.
  useSidePanelEscapeStep(editing && canStartEditing, () => {
    if (saving) return true;
    if (isNameDescDirty) return false;
    cancelEdit();
    return true;
  });

  const getFallbackChannel = useCallback(() =>
    channels.find((candidate) => candidate.id !== channelId && candidate.name === "all") ||
    channels.find((candidate) => candidate.id !== channelId), [channels, channelId]);

  /** Persist name/description. Returns true when the draft is clean
   *  afterwards (saved or nothing to save), false on validation/API
   *  failure. Does NOT close — callers decide what happens next. */
  const saveChanges = useCallback(async (): Promise<boolean> => {
    setError("");
    setArchivedCollision(null);
    clearSaveStatus();

    if (!canEditInfo || !editing) {
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
      showSaveSuccess();
      setEditing(false);
      return true;
    } catch (err: unknown) {
      // An archived channel holding the name is named, with Open Channel and
      // Unarchive, instead of the generic error.
      const collision = parseArchivedNameCollision(err);
      setArchivedCollision(collision);
      const axiosErr = err as { response?: { data?: { error?: string } } };
      if (!collision) setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedUpdate" }));
      return false;
    } finally {
      setSaving(false);
    }
  }, [clearSaveStatus, canEditInfo, editing, isAllChannel, name, description, initialName, initialDescription,
    formatMessage, updateChannel, channelId, showSaveSuccess]);
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

  const handleSubmit = useCallback((e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void saveChanges();
  }, [saveChanges]);
  const startEditing = useCallback(() => {
    setName(initialName);
    setDescription(initialDescription);
    clearSaveStatus();
    setEditing(true);
  }, [clearSaveStatus, initialDescription, initialName]);

  const handleVisibilityChange = useCallback(async () => {
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
      const axiosErr = err as { response?: { data?: { error?: string; code?: string } } };
      setError(axiosErr.response?.data?.code === "external_members_keep_private"
        ? formatMessage({ id: "channel.externalInvite.error.keepPrivate" })
        : axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedUpdateVisibility" }));
      setShowVisibilityConfirm(false);
    } finally {
      setVisibilityBusy(false);
    }
  }, [
    isAllChannel,
    nextVisibility,
    hideAllChannel,
    restoreAllChannel,
    updateChannel,
    channelId,
    onClose,
    getFallbackChannel,
    nav,
    formatMessage,
  ]);

  const handleUnarchive = useCallback(async () => {
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
  }, [unarchiveChannel, channelId, formatMessage, onClose]);

  const handleResendJointInvite = useCallback(async () => {
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
  }, [clearResendStatus, resendJointChannelInvite, channelId, showResendSuccess, formatMessage]);

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
    if (inviteSameAdminTarget && !inviteSameAdminConfirmed) {
      setInviteSubmitError(formatMessage({ id: "channel.jointInvite.sameAdmin.confirmRequired" }));
      return;
    }

    setInviteBusy(true);
    try {
      const updated = await inviteJointChannelServer(channelId, {
        targetServerSlug: normalizedInviteServerSlug,
        invitedPeople: normalizedInvitePeople,
        ...(inviteSameAdminTarget ? { sameAdmin: true } : {}),
      });
      // The server falls back to email if the direct accept fails, so read
      // the outcome from the returned server list instead of assuming it.
      const connectedDirectly = inviteSameAdminTarget !== null && updated.jointServers?.some(
        (server) => server.serverSlug === inviteSameAdminTarget.slug && server.status === "active",
      ) === true;
      setInviteServerSlug("");
      setInvitePeopleText("");
      setInviteSameAdminConfirmed(false);
      setInviteTouched({ serverSlug: false, people: false });
      // Anyone else on the list was still emailed.
      const emailedCount = connectedDirectly ? normalizedInvitePeople.length - 1 : normalizedInvitePeople.length;
      setInviteStatus([
        ...(connectedDirectly && inviteSameAdminTarget
          ? [formatMessage({ id: "channel.jointInvite.sameAdmin.connected" }, { server: inviteSameAdminTarget.name })]
          : []),
        ...(emailedCount > 0
          ? [formatMessage({ id: "channel.edit.inviteSentCount" }, { count: emailedCount })]
          : []),
      ].join(" "));
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string; code?: string; invitee?: string; targetServerSlug?: string; retryAfterSeconds?: number } } };
      const data = axiosErr.response?.data;
      const code = data?.code;
      const message = code === "joint_free_server_limit"
        ? formatMessage({ id: "channel.joint.freeServerLimit" })
        : code === "joint_server_limit"
          ? formatMessage({ id: "channel.joint.serverLimit" }, { max: MAX_JOINT_CHANNEL_SERVERS })
          : code === "joint_invite_rate_limited"
            ? formatJointInviteRateLimited(data?.retryAfterSeconds, formatMessage)
            : data?.error || formatMessage({ id: "channel.edit.failedInviteServer" });
      if (code === "joint_free_server_limit" || code === "joint_server_limit" || code === "joint_invite_rate_limited") {
        setInviteSubmitError(message);
      } else if (code === "joint_invitee_unavailable") {
        // Read by code, not text: the message names "the target server".
        setInvitePeopleServerError(data?.invitee && data.targetServerSlug
          ? formatMessage({ id: "channel.jointInvite.error.inviteeUnavailable" }, { invitee: data.invitee, server: data.targetServerSlug })
          : message);
      } else if (/target server|current server|server slug|already in this joint channel/i.test(message)) {
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

  const handleDisconnectJointChannel = useCallback(async () => {
    try {
      await disconnectJointChannel(channelId);
    } catch (err: unknown) {
      // The confirm dialog shows the thrown error's text: Guests bound to this
      // copy get the localized reason and the next step.
      const guestRefusal = jointDisconnectGuestRefusalMessage(err, initialName, formatMessage);
      throw guestRefusal ? new Error(guestRefusal) : err;
    }
    // Only after the server agreed: the channel just left the sidebar, so say
    // which server let go of which channel before moving the reader on.
    showToast({ title: formatMessage({ id: "channel.edit.disconnectedToast" }, { server: currentServerName, channel: initialName }), type: "success" });
    const fallbackChannel = getFallbackChannel();
    onClose();
    if (fallbackChannel) {
      nav.toChannel(fallbackChannel.id);
    } else {
      nav.toSettings("server");
    }
  }, [disconnectJointChannel, channelId, initialName, currentServerName, formatMessage, getFallbackChannel, onClose, nav]);

  const handleDeleteConfirm = useCallback(async () => {
    if (showCompletedJointSettings) {
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
  }, [showCompletedJointSettings, handleDisconnectJointChannel, deleteChannel, channelId, getFallbackChannel, onClose, nav]);

  const handleArchiveConfirm = useCallback(async () => {
    try {
      await archiveChannel(channelId);
      setShowArchiveConfirm(false);
      onClose();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedArchive" }));
      setShowArchiveConfirm(false);
    }
  }, [archiveChannel, channelId, onClose, formatMessage]);

  const handleLeaveConfirm = useCallback(async () => {
    await onLeaveChannel?.();
    onClose();
  }, [onLeaveChannel, onClose]);

  const openLeaveConfirm = useCallback(() => setShowLeaveConfirm(true), []);
  const closeLeaveConfirm = useCallback(() => setShowLeaveConfirm(false), []);
  const openVisibilityConfirm = useCallback(() => setShowVisibilityConfirm(true), []);
  const closeVisibilityConfirm = useCallback(() => setShowVisibilityConfirm(false), []);
  const openArchiveConfirm = useCallback(() => setShowArchiveConfirm(true), []);
  const closeArchiveConfirm = useCallback(() => setShowArchiveConfirm(false), []);
  const openDeleteConfirm = useCallback(() => setShowDeleteConfirm(true), []);
  const closeDeleteConfirm = useCallback(() => setShowDeleteConfirm(false), []);

  const cancelAttachmentUpload = useCallback((uploadId: string) => {
    void cancelActiveAttachmentUpload(uploadId).catch(() => undefined);
  }, [cancelActiveAttachmentUpload]);

  const handleInviteServerSlugChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setInviteServerSlug(e.target.value);
    setInviteSameAdminConfirmed(false);
    setInviteServerSlugServerError("");
    setInviteSubmitError("");
    setInviteStatus("");
  }, []);
  const handleInviteServerSlugBlur = useCallback(
    () => setInviteTouched((current) => ({ ...current, serverSlug: true })),
    [],
  );
  const handleInvitePeopleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setInvitePeopleText(e.target.value);
    setInviteSameAdminConfirmed(false);
    setInvitePeopleServerError("");
    setInviteSubmitError("");
    setInviteStatus("");
  }, []);
  const handleInvitePeopleBlur = useCallback(
    () => setInviteTouched((current) => ({ ...current, people: true })),
    [],
  );
  const handleNameChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
    setError("");
    setArchivedCollision(null);
    clearSaveStatus();
  }, [clearSaveStatus]);
  const handleDescriptionChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setDescription(e.target.value);
    setError("");
    clearSaveStatus();
  }, [clearSaveStatus]);

  // Make Public isn't offered while the channel has people from outside or
  // open external invites (cindyz: an unavailable action is hidden, not
  // explained); the server refuses it with external_members_keep_private.
  const publicBlockedByExternal = !isAllChannel && currentVisibility === "private" && externalMembersKeepPrivate;
  // With external channels on, the host can't disconnect its own joint
  // channel (the server refuses it, host_cannot_disconnect); only the other
  // servers' copies show Disconnect, and the host reads what Archive does.
  const hostCannotDisconnect = showCompletedJointSettings && channel?.jointRole === "host" && externalChannels.enabled;
  const showVisibilityRow = !isJointChannel && showVisibilityAction && !publicBlockedByExternal;
  const showArchiveRow = !isAllChannel && Boolean(effectiveCapabilities.archiveChannels) && (showManageActions || isArchived);
  const canDeleteOrDisconnect = !isAllChannel && effectiveCapabilities.deleteChannels && !hostCannotDisconnect;
  const showDeleteRow = showManageActions && canDeleteOrDisconnect;
  const showStopAgentsRow = !isArchived && !!onStopAllAgents;

  // Visible to visitors (#wg-rbac:#51): owners and admins only. Offered while
  // it is on, so it can always be turned off, or while the client sees
  // nothing that would refuse turning it on: the server's public page is
  // live (publicPageLive: public and public_server_v0 on), the channel is
  // public and has no people or invites from outside. An unknown condition
  // (an older payload) leaves the row up and the server's refusal says why.
  const visitorVisible = (channel?.visitorVisible ?? channel?.guestVisible) === true;
  const visitorVisibleCanTurnOn = channel?.type === "channel"
    && !isAllChannel
    && serverPublicPageLive !== false
    && channel.hasExternalRelation !== true;
  const showVisitorVisible = channel?.channelCapabilities?.manageVisitorAccess === true
    && !isArchived
    && (channel.type === "channel" || channel.type === "private");
  const regularChannel = channel?.type === "channel" || channel?.type === "private";
  const showSlack = canEditChannel && !isArchived && regularChannel && bridgeEditor.available;

  const jointAttachmentUploadSection = (showCompletedJointSettings || conversionInProgress) && (
    <JointAttachmentUploadSection
      uploads={activeAttachmentUploads}
      cancelBusyId={activeAttachmentUploadCancelBusyId}
      onOpenChannel={onClose}
      onCancel={cancelAttachmentUpload}
    />
  );
  const external = channelDetailsExternal(channel);
  // Who sees the name and description, under the fields (raft-design channel.md).
  const whoSees = showCompletedJointSettings || external
    ? formatMessage({ id: "message.channelSettings.infoDescriptionExternal" })
    : channel?.type === "private"
      ? formatMessage({ id: "channel.details.shownToMembers" })
      : formatMessage({ id: "channel.details.shownToServer" }, { server: currentServerName });

  // The identity block, read first: the channel's icon, name and tag, its description as body text; Edit turns
  // the name and description into fields in place, Save and Cancel under them at the start of the line
  // (raft-design channel.md, Forms "Forms in a dialog"; stdrc 2026-11-10).
  const identity = (
    <section className="stack-y-3">
      {error && (
        <Banner intent="warning" role="alert" data-testid="channel-settings-save-error">
          {error}
        </Banner>
      )}
      <ArchivedNameCollisionBanner collision={archivedCollision} onLeave={onClose} onError={setError} />
      {editing && canStartEditing ? (
        <form id={CHANNEL_SETTINGS_FORM_ID} onSubmit={handleSubmit} className="stack-y-3" data-testid="channel-details-edit-form">
          <FormField
            label={formatMessage({ id: "channel.edit.nameLabel" })}
            htmlFor="channel-settings-name"
            hint={isAllChannel ? formatMessage({ id: "channel.edit.allCannotRename" }) : undefined}
          >
            <Input
              id="channel-settings-name"
              type="text"
              value={name}
              onChange={handleNameChange}
              className="w-full"
              placeholder={formatMessage({ id: "channel.edit.namePlaceholder" })}
              required
              disabled={isAllChannel || isArchived}
            />
          </FormField>
          <FormField
            label={formatMessage({ id: "channel.edit.descriptionLabel" })}
            htmlFor="channel-settings-description"
            optional
            hint={whoSees}
          >
            <Textarea
              id="channel-settings-description"
              value={description}
              onChange={handleDescriptionChange}
              className="w-full"
              placeholder={formatMessage({ id: "channel.edit.descriptionPlaceholder" })}
              rows={4}
              disabled={isArchived}
            />
          </FormField>
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              disabled={!isNameDescDirty || saving || isArchived}
              size="md"
              variant="accent"
              data-testid="channel-settings-save-inline"
            >
              {saving ? formatMessage({ id: "channel.edit.saving" }) : formatMessage({ id: "channel.edit.saveChanges" })}
            </Button>
            <Button
              type="button"
              onClick={cancelEdit}
              disabled={saving}
              size="md"
              variant="ghost"
              data-testid="channel-settings-discard-draft"
            >
              {formatMessage({ id: "settings.common.cancel" })}
            </Button>
          </div>
        </form>
      ) : (
        <ChannelDetailsIdentity
          channel={channel}
          channelName={initialName}
          description={showChannelInfoSettings ? initialDescription : null}
          action={canStartEditing ? (
            <Button ref={editButtonRef} type="button" size="md" variant="ghost" className="shrink-0" onClick={startEditing} data-testid="channel-details-edit">
              <Pencil aria-hidden="true" />
              {formatMessage({ id: "settings.common.edit" })}
            </Button>
          ) : undefined}
        />
      )}
      {saveStatus && (
        <span className="sr-only" role="status" aria-live="polite" data-testid="channel-settings-save-status">
          {saveStatus}
        </span>
      )}
    </section>
  );

  // Connected servers (#wg-rbac:2ee0381d): a group of its own after the announcement, one row per server.
  const showServers = (isJointChannel && showCompletedJointSettings) || showPrivateConnectSection;
  const serversSection = showServers && (
    <section className="stack-y-3" data-testid="channel-settings-joint-section">
      <SectionHeader
        icon={<Server size={16} aria-hidden="true" />}
        label={formatMessage({ id: "channel.edit.connectedServers" })}
        action={(
          <div className="flex items-center gap-1">
            {/* The limit is a fact the name doesn't say: a hint it earns (raft-design writing.md). */}
            <Tooltip content={formatMessage({ id: "channel.edit.connectedServersRule" }, { max: MAX_JOINT_CHANNEL_SERVERS })}>
              <Button
                type="button"
                variant="ghost"
                size="icon-md"
                className="-my-1 text-foreground-hint hover:text-foreground"
                aria-label={formatMessage({ id: "channel.edit.connectedServersRule" }, { max: MAX_JOINT_CHANNEL_SERVERS })}
                data-testid="channel-settings-joint-servers-rule"
              >
                <Info aria-hidden="true" />
              </Button>
            </Tooltip>
            {memberConnect.available && (
              <ConnectedServersMenu
                channelId={channelId}
                channelName={initialName}
                channelType={showPrivateConnectSection ? "private" : "joint"}
                hostName={memberConnectHostName}
                // A Guest is bound to the host's copy: only there is this the host.
                guest={currentServerRole === "guest" && (showPrivateConnectSection || channel?.jointRole === "host")}
                rows={memberConnect.rows}
              />
            )}
          </div>
        )}
      />
      {jointServerRows.length > 0 ? (
        <ListRowGroup data-testid="channel-settings-joint-servers">
          {jointServerRows.map((server) => (
            <ListRow key={`${server.serverId}:${server.status}`} variant="plain" interactive={false} className="group" data-testid="channel-settings-joint-server-row">
              <ListRowBody>
                <ListRowTop>
                  <ListRowTitle>{server.serverName || server.serverSlug}</ListRowTitle>
                  {server.role === "host" && (
                    <Badge appearance="outline" data-testid="channel-settings-joint-server-host">
                      {formatMessage({ id: "channel.edit.serverRoleHost" })}
                    </Badge>
                  )}
                </ListRowTop>
                {/* The slug is an id (machine type); "this server" is words. */}
                <ListRowDescription>
                  <span className="font-mono text-mono-meta">{server.serverSlug}</span>{server.isCurrentServer ? ` · ${formatMessage({ id: "channel.edit.thisServer" })}` : ""}
                  {connectedByYou.has(server.serverId) ? <><span aria-hidden="true"> · </span>{formatMessage({ id: "channel.memberConnect.row.connectedByYou" })}</> : null}
                </ListRowDescription>
              </ListRowBody>
              <div className="flex shrink-0 items-center gap-2">
                {/* External channels on: no plan chips (#wg-rbac:2ee0381d). */}
                {"plan" in server && server.plan && !externalChannels.enabled && (
                  <Badge appearance="outline" data-testid="channel-settings-joint-server-plan">
                    {formatMessage({ id: server.plan === "paid" ? "channel.edit.serverPlanPaid" : "billing.free" })}
                  </Badge>
                )}
                {/* A connected server needs no badge; a legacy pending row still says so (Q2). */}
                {server.status !== "active" && (
                  <Badge appearance="soft" variant="warning" data-testid="channel-settings-joint-server-status">
                    {formatMessage({ id: "channel.edit.serverStatusPending" })}
                  </Badge>
                )}
                {canDisconnectJointServers && server.status === "active" && server.role !== "host" && !server.isCurrentServer && (
                  <JointServerDisconnectAction channelId={channelId} channelName={initialName} serverId={server.serverId} serverName={server.serverName || server.serverSlug} />
                )}
              </div>
            </ListRow>
          ))}
        </ListRowGroup>
      ) : (
        <p className="text-callout text-foreground-hint">{formatMessage({ id: "channel.edit.connectedMetaUnavailable" })}</p>
      )}
      {capabilities.federateChannels && serverInviteOfferAllowed && hasCurrentServerPendingJointInvites && !isArchived && (
        <div className="stack-y-2">
          <div className="flex" data-testid="channel-settings-joint-resend-row">
            <Button type="button" onClick={handleResendJointInvite} disabled={resendBusy} size="md" variant={resendStatus ? "success" : "outline"}>
              {resendStatus ? <Check size={16} aria-hidden="true" /> : <Mail size={16} aria-hidden="true" />}
              <span className="grid w-max whitespace-nowrap" data-testid="channel-settings-joint-resend-label-grid">
                <span aria-hidden="true" className="invisible col-start-1 row-start-1">{formatMessage({ id: "channel.edit.resendInvite" })}</span>
                <span aria-hidden="true" className="invisible col-start-1 row-start-1">{formatMessage({ id: "channel.edit.resending" })}</span>
                <span aria-hidden="true" className="invisible col-start-1 row-start-1">{formatMessage({ id: "channel.edit.resendSuccess" })}</span>
                <span className="col-start-1 row-start-1" data-testid="channel-settings-joint-resend-label">
                  {resendBusy ? formatMessage({ id: "channel.edit.resending" }) : resendStatus ? formatMessage({ id: "channel.edit.resendSuccess" }) : formatMessage({ id: "channel.edit.resendInvite" })}
                </span>
              </span>
            </Button>
          </div>
          {resendStatus && <span className="sr-only" role="status" aria-live="polite" data-testid="channel-settings-joint-resend-status">{resendStatus}</span>}
          {resendError && <p className="text-caption font-semibold text-warning-strong" role="alert">{resendError}</p>}
        </div>
      )}
      {capabilities.federateChannels && serverInviteOfferAllowed && !isArchived && (
        <div className="stack-y-3" data-testid="channel-settings-joint-invite">
          <SectionEyebrow as="div" tone="muted" role="heading" aria-level={4}>{formatMessage({ id: "channel.edit.inviteServerSection" })}</SectionEyebrow>
          {jointServerLimitReached ? (
            <p className="text-callout text-foreground-hint">{formatMessage({ id: "channel.edit.maxServers" }, { max: MAX_JOINT_CHANNEL_SERVERS })}</p>
          ) : (
            <form className="stack-y-3" data-testid="channel-settings-joint-invite-form" onSubmit={handleInviteJointServer} noValidate>
              <FormField label={formatMessage({ id: "channel.edit.serverSlugLabel" })} htmlFor="channel-settings-joint-server-slug" error={inviteServerSlugError}>
                <SlugInput id="channel-settings-joint-server-slug" name="targetServerSlug" type="text" value={inviteServerSlug} onChange={handleInviteServerSlugChange} onBlur={handleInviteServerSlugBlur} placeholder={formatMessage({ id: "channel.edit.serverSlugPlaceholder" })} required autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={inviteServerSlugError ? "true" : undefined} disabled={inviteBusy} />
              </FormField>
              <FormField label={formatMessage({ id: "channel.edit.invitedPeopleLabel" })} hint={formatMessage({ id: "channel.edit.invitedPeopleHint" })} htmlFor="channel-settings-joint-invited-people" error={invitePeopleError}>
                <Textarea id="channel-settings-joint-invited-people" name="invitedPeople" value={invitePeopleText} onChange={handleInvitePeopleChange} onBlur={handleInvitePeopleBlur} className="w-full" placeholder={formatMessage({ id: "channel.edit.invitedPeoplePlaceholder" })} rows={2} required data-invalid={Boolean(invitePeopleError)} disabled={inviteBusy} />
              </FormField>
              {inviteSameAdminTarget && (
                <SameAdminJointNotice
                  sourceServerName={currentServerName}
                  targetServerName={inviteSameAdminTarget.name}
                  confirmed={inviteSameAdminConfirmed}
                  onConfirmedChange={setInviteSameAdminConfirmed}
                  disabled={inviteBusy}
                />
              )}
              <div className="flex" data-testid="channel-settings-joint-send-invite-row">
                <Button type="submit" disabled={inviteBusy || !inviteFormValid} size="md" variant="outline" data-testid="channel-settings-joint-send-invite"><Mail size={16} aria-hidden="true" />{inviteBusy ? formatMessage({ id: "channel.edit.inviting" }) : formatMessage({ id: "channel.edit.sendInvite" })}</Button>
              </div>
              {inviteSubmitError && <Banner intent="warning" data-testid="channel-settings-joint-invite-submit-error">{inviteSubmitError}</Banner>}
              {inviteStatus && <p className="text-caption text-foreground-hint" role="status">{inviteStatus}</p>}
            </form>
          )}
        </div>
      )}
    </section>
  );

  // Channel settings: the same for everyone in the channel, for who can manage it (raft-design channel.md). Its
  // name says whom it reaches, so the heading has no hint (stdrc 2026-11-10).
  const visibilityRow = showVisibilityRow && (
    <ListRow variant="plain" interactive={false} data-testid="channel-settings-visibility">
      <ListRowBody>
        <ListRowTitle id="channel-settings-visibility-label">
          {isAllChannel
            ? formatMessage({ id: currentVisibility === "private" ? "channel.details.allHiddenTitle" : "message.chatPanel.overflow.visibilityPublic" })
            : formatMessage({ id: currentVisibility === "private" ? "message.chatPanel.overflow.visibilityPrivate" : "message.chatPanel.overflow.visibilityPublic" })}
        </ListRowTitle>
        <ListRowDescription id="channel-settings-visibility-description" wrap>
          {isAllChannel && currentVisibility === "private"
            ? formatMessage({ id: "channel.details.allHiddenDescription" })
            : currentVisibility === "private"
              ? formatMessage({ id: "channel.details.privateDescription" })
              : formatMessage({ id: "channel.details.publicDescription" }, { server: currentServerName })}
        </ListRowDescription>
      </ListRowBody>
      <Button
        type="button"
        size="md"
        variant="outline"
        className="shrink-0"
        onClick={openVisibilityConfirm}
        disabled={isArchived || visibilityBusy}
        aria-describedby="channel-settings-visibility-label"
        data-testid="channel-settings-visibility-action"
      >
        {visibilityBusy
          ? formatMessage({ id: "channel.edit.updating" })
          : isAllChannel
            ? formatMessage({ id: currentVisibility === "private" ? "channel.edit.restoreAll" : "channel.edit.hideAll" })
            : formatMessage({ id: currentVisibility === "private" ? "channel.edit.makePublic" : "channel.edit.makePrivate" })}
      </Button>
    </ListRow>
  );
  const channelSettingsRows = [
    visibilityRow,
    showVisitorVisible && (
      <ChannelVisitorVisibleField key={`visitors-${channelId}`} channelId={channelId} visitorVisible={visitorVisible} canTurnOn={visitorVisibleCanTurnOn} disabled={saving} />
    ),
    showSlack && <ChannelSlackBridgeRow key="slack" editor={bridgeEditor} channelId={channelId} channelName={initialName} disabled={saving} />,
  ].filter(Boolean);
  const channelSettingsSection = channelSettingsRows.length > 0 && (
    <section className="stack-y-3" data-testid="channel-settings-manage-group" aria-labelledby="channel-settings-manage-heading">
      <SectionHeader
        icon={<SlidersHorizontal size={16} aria-hidden="true" />}
        label={<span id="channel-settings-manage-heading">{formatMessage({ id: "channel.details.channelSettings" })}</span>}
      />
      <ListRowGroup>{channelSettingsRows}</ListRowGroup>
    </section>
  );

  // The actions, last, in a card of rows with no heading (DS Forms, "Danger zone"; ListRow "An action's risk"):
  // only Delete or Disconnect, which can't be undone, is red. Archive, Leave and Stop all agents are ink: they
  // interrupt but can be undone, and their confirmations' buttons are orange (cindyz, #triage:f2e107f7).
  // Each keeps its confirmation. raft-ui's ListRow risk tones (0.87, list-row.md "An action's risk") color the icon
  // and the title.
  const actionRow = ({ icon, label, onClick, disabled, tone, testId, ariaLabel }: {
    icon: ReactNode; label: string; onClick: () => void; disabled?: boolean; tone?: "danger"; testId: string; ariaLabel?: string;
  }) => (
    <ListRow
      key={testId}
      variant="plain"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={testId}
      tone={tone}
    >
      <ListRowIcon>{icon}</ListRowIcon>
      <ListRowBody>
        <ListRowTitle>{label}</ListRowTitle>
      </ListRowBody>
    </ListRow>
  );
  const actionRows = showChannelInfoSettings ? [
    showArchiveRow && (isArchived
      ? actionRow({ icon: <ArchiveRestore />, label: archiveBusy ? formatMessage({ id: "channel.edit.unarchiving" }) : formatMessage({ id: "channel.edit.unarchiveChannel" }), onClick: handleUnarchive, disabled: archiveBusy, testId: "channel-settings-archive-action" })
      : actionRow({ icon: <Archive />, label: formatMessage({ id: "channel.edit.archiveChannel" }), onClick: openArchiveConfirm, testId: "channel-settings-archive-action" })),
    showLeaveAction && actionRow({ icon: <LeaveChannelKindIcon type={channel?.type} size={20} />, label: formatMessage({ id: "channel.edit.leaveChannel" }), onClick: openLeaveConfirm, testId: "channel-overflow-leave" }),
    showStopAgentsRow && actionRow({ icon: <Square />, label: formatMessage({ id: "message.chatPanel.overflow.stopAgents" }), ariaLabel: formatMessage({ id: "message.chatPanel.stopAllAgents" }), onClick: onStopAllAgents!, testId: "channel-overflow-stop-agents" }),
    showDeleteRow && (showCompletedJointSettings
      ? actionRow({ icon: <Unplug />, label: formatMessage({ id: "channel.edit.disconnectChannel" }), onClick: openDeleteConfirm, tone: "danger", testId: "channel-settings-delete-action" })
      : actionRow({ icon: <Trash2 />, label: formatMessage({ id: "channel.edit.deleteChannel" }), onClick: openDeleteConfirm, tone: "danger", testId: "channel-settings-delete-action" })),
  ].filter(Boolean) : [];
  const actionsSection = actionRows.length > 0 && (
    <ListRowGroup data-testid="channel-settings-lifecycle-group">
      {actionRows}
    </ListRowGroup>
  );

  // The confirmations stay what they were (ConfirmDialog, LeaveChannelConfirmDialog, the conversion's).
  const confirmDialogs = (
    <>
      {showArchiveConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "channel.edit.archiveChannelTitle" })}
          // The host's copy (it can't disconnect): say archiving reaches every server (cindyz: in the confirm).
          message={hostCannotDisconnect ? (
            <>
              <p>{formatMessage({ id: "channel.edit.confirmArchive" }, { name: initialName })}</p>
              <p className="mt-2">{formatMessage({ id: "channel.edit.hostArchiveHint" })}</p>
            </>
          ) : formatMessage({ id: "channel.edit.confirmArchive" }, { name: initialName })}
          confirmLabel={formatMessage({ id: "channel.edit.archiveAction" })}
          loadingLabel={formatMessage({ id: "channel.edit.archiving" })}
          confirmVariant="warning"
          layer={1}
          onConfirm={handleArchiveConfirm}
          onClose={closeArchiveConfirm}
        />
      )}

      {showVisibilityConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={
            isAllChannel
              ? currentVisibility === "private" ? formatMessage({ id: "channel.edit.restoreAllTitle" }) : formatMessage({ id: "channel.edit.hideAllTitle" })
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
              ? currentVisibility === "private" ? formatMessage({ id: "channel.edit.confirmRestoreAllAction" }) : formatMessage({ id: "channel.edit.confirmHideAllAction" })
              : currentVisibility === "private" ? formatMessage({ id: "channel.edit.confirmPublicAction" }) : formatMessage({ id: "channel.edit.confirmPrivateAction" })
          }
          loadingLabel={formatMessage({ id: "channel.edit.updating" })}
          confirmVariant="warning"
          layer={1}
          onConfirm={handleVisibilityChange}
          onClose={closeVisibilityConfirm}
        />
      )}

      {showLeaveConfirm && (
        <LeaveChannelConfirmDialog
          channelId={channelId}
          channelName={initialName}
          confirmTestId="channel-overflow-leave-confirm"
          layer={1}
          onConfirm={handleLeaveConfirm}
          onClose={closeLeaveConfirm}
        />
      )}

      {showDeleteConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={showCompletedJointSettings ? formatMessage({ id: "channel.edit.disconnectJointChannel" }) : formatMessage({ id: "channel.edit.deleteChannelTitle" })}
          message={showCompletedJointSettings
            ? formatMessage({ id: "channel.edit.confirmDisconnect" }, { name: initialName })
            : formatMessage({ id: "channel.edit.confirmDelete" }, { name: initialName })}
          confirmLabel={showCompletedJointSettings ? formatMessage({ id: "channel.edit.disconnectAction" }) : formatMessage({ id: "channel.edit.deleteAction" })}
          loadingLabel={showCompletedJointSettings ? formatMessage({ id: "channel.edit.disconnecting" }) : formatMessage({ id: "channel.edit.deleting" })}
          layer={1}
          onConfirm={handleDeleteConfirm}
          onClose={closeDeleteConfirm}
        />
      )}
    </>
  );

  return (
    /* The channel details' body (ChannelOverflowMenu: a column of the conversation's row, or a pushed page on a
       phone). From the top: an upload under way, the channel's name and description, its members,
       its pinned content, its servers, Channel settings, Your preferences, then the actions (raft-design channel.md,
       stdrc 2026-11-10, #proj-raft-ui:dae8db07). Closing is the host's, guarded by the unsaved-changes prompt. */
    <>
      <div className="stack-y-6" data-testid="channel-settings-panel">
        {jointAttachmentUploadSection}
        {identity}
        {membersSlot}
        {/* Pinned content (the channel announcement, #proj-chat:#29 and #35): its own section, only while the flag is
            on, and to who can't change it only while there is one. On a phone the details are a page over the
            channel, so opening the pinned Artifact closes them to show it (as the upload section's channel link does);
            on a desktop it opens in the row beside the details, which stay. */}
        <ChannelAnnouncementField
          channelId={channelId}
          channelName={initialName}
          channelType={channel?.type}
          canEdit={Boolean(effectiveCapabilities.editChannelMetadata) && !isArchived}
          onOpened={phone ? onClose : undefined}
        />
        {serversSection}
        {channelSettingsSection}
        <ChannelPreferencesSection
          channelId={channelId}
          conversationKind="channel"
          isPanel
          activityMute={activityMute}
          collapseLongMessages={collapseLongMessages}
        />
        {actionsSection}
      </div>
      {confirmDialogs}
    </>
  );
}
