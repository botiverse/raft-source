import { useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { formatNameValidationError } from "../../i18n/nameValidation";
import { Archive, ArchiveRestore, Eye, EyeOff, GitBranch, Hash, Lock, LogOut, Mail, Pin, PinOff, Trash2, X } from "lucide-react";
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
import { MAX_JOINT_CHANNEL_SERVERS, SERVER_GUEST_FEATURE_FLAG_KEY, validateNameReason } from "@botiverse/raft-shared";
import {
  hasSidebarPinnedRef,
  removeSidebarPinnedRef,
  upsertSidebarPinnedRef,
} from "../../utils/sidebarPinnedRefs";
import Banner from "../ui/Banner";
import Button from "../ui/Button";
import ConfirmDialog from "../ConfirmDialog";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import FormField from "../ui/FormField";

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

export default function LegacyEditChannelDialog({
  channelId,
  initialName,
  initialDescription,
  onLeaveChannel,
  onClose,
}: {
  channelId: string;
  initialName: string;
  initialDescription: string;
  onLeaveChannel?: () => Promise<void> | void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendStatus, setResendStatus] = useState("");
  const [inviteServerSlug, setInviteServerSlug] = useState("");
  const [invitePeopleText, setInvitePeopleText] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteStatus, setInviteStatus] = useState("");
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
  const serverGuestEnabled = useServerFeatureFlag(SERVER_GUEST_FEATURE_FLAG_KEY).enabled;
  const nav = useAppNavigate();

  const isAllChannel = initialName === "all";
  const canEditChannel = Boolean(effectiveCapabilities.editChannelMetadata
    || effectiveCapabilities.changeChannelVisibility
    || effectiveCapabilities.archiveChannels
    || effectiveCapabilities.deleteChannels
    || effectiveCapabilities.federateChannels);
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
  const showConvertAction = showManageActions && Boolean(effectiveCapabilities.federateChannels) &&
    canShowConvertToJointEntry &&
    canUseJointChannels &&
    !isAllChannel &&
    !isJointChannel &&
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
  const isDirty = name !== initialName ||
    description !== initialDescription ||
    inviteServerSlug.length > 0 ||
    invitePeopleText.length > 0;

  const getFallbackChannel = () =>
    channels.find((candidate) => candidate.id !== channelId && candidate.name === "all") ||
    channels.find((candidate) => candidate.id !== channelId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!canEditChannel) {
      onClose();
      return;
    }

    if (!isAllChannel) {
      const nameError = formatNameValidationError(
        validateNameReason(name),
        "channel.edit.nameFieldName",
        formatMessage,
      );
      if (nameError) {
        setError(nameError);
        return;
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
      if (Object.keys(updates).length === 0) {
        onClose();
        return;
      }
      await updateChannel(channelId, updates);
      onClose();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedUpdate" }));
    } finally {
      setSaving(false);
    }
  };

  const handlePinToggle = async () => {
    setError("");
    const next = isPinned
      ? removeSidebarPinnedRef(pinnedRefs, { kind: "channel", id: channelId })
      : upsertSidebarPinnedRef(pinnedRefs, { kind: "channel", id: channelId });
    try {
      await updateSidebarOrder({ pinned: next });
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedUpdate" }));
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
    setError("");
    setResendStatus("");
    setResendBusy(true);
    try {
      const result = await resendJointChannelInvite(channelId);
      setResendStatus(formatMessage(
        { id: "channel.edit.inviteResentCount" },
        { count: result.resentCount },
      ));
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedResendInvite" }));
    } finally {
      setResendBusy(false);
    }
  };

  const handleInviteJointServer = async () => {
    setError("");
    setInviteStatus("");
    const targetServerSlug = inviteServerSlug.trim();
    const invitedPeople = invitePeopleText
      .split(/[\n,]+/)
      .map((person) => person.trim())
      .filter(Boolean);
    if (!targetServerSlug) {
      setError(formatMessage({ id: "channel.edit.inviteSlugRequired" }));
      return;
    }
    if (invitedPeople.length === 0) {
      setError(formatMessage({ id: "channel.edit.inviteePersonRequired" }));
      return;
    }
    if (jointServerLimitReached) {
      setError(formatMessage({ id: "channel.edit.maxServers" }, { max: MAX_JOINT_CHANNEL_SERVERS }));
      return;
    }

    setInviteBusy(true);
    try {
      await inviteJointChannelServer(channelId, { targetServerSlug, invitedPeople });
      setInviteServerSlug("");
      setInvitePeopleText("");
      setInviteStatus(formatMessage(
        { id: "channel.edit.inviteSentCount" },
        { count: invitedPeople.length },
      ));
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedInviteServer" }));
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

  return (
    <>
      <ChannelSettingsSheet isDirty={isDirty} onClose={onClose}>
        <div className="flex shrink-0 items-center justify-between gap-4 border-b-2 border-black bg-soft-signal px-4 py-3">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-wide text-black/55">
              {formatMessage({ id: "message.channelSettings.eyebrow" })}
            </p>
            <DrawerTitle id="channel-settings-title" className="truncate font-display text-xl font-bold uppercase">
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
          <form id={CHANNEL_SETTINGS_FORM_ID} onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <Banner intent="warning" className="font-bold">
                {error}
              </Banner>
            )}
            {canEditChannel && (
              <section className="space-y-3 border-b-2 border-black pb-5">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wide text-black/65">
                    {formatMessage({ id: "message.channelSettings.infoTitle" })}
                  </h3>
                  <p className="mt-1 text-xs text-black/60">
                    {formatMessage({ id: "message.channelSettings.infoDescription" })}
                  </p>
                </div>
                <div className="space-y-3">
                  <FormField
                    label={formatMessage({ id: "channel.edit.nameLabel" })}
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
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="input-brutal w-full"
                      placeholder={formatMessage({ id: "channel.edit.namePlaceholder" })}
                      required
                      autoFocus
                      disabled={isAllChannel || isArchived}
                    />
                  </FormField>
                  <FormField label={formatMessage({ id: "channel.edit.descriptionLabel" })} optional>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="input-brutal w-full"
                      placeholder={formatMessage({ id: "channel.edit.descriptionPlaceholder" })}
                      rows={2}
                      disabled={isArchived}
                    />
                  </FormField>
                </div>
              </section>
            )}
            {canManageGuestAccess && (
              <section className="space-y-3 border-b-2 border-black pb-5" data-testid="channel-settings-guest-access">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wide text-black/65">
                    {formatMessage({ id: "channel.edit.guestAccessTitle" })}
                  </h3>
                  <p className="mt-1 text-xs text-black/60">
                    {formatMessage({ id: "channel.edit.guestAccessDescription" })}
                  </p>
                </div>
                <div className="divide-y divide-black/10">
                  <div className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <h4 id="legacy-channel-settings-guest-visible-label" className="text-sm font-medium text-black">
                        {formatMessage({ id: "channel.edit.guestVisibleTitle" })}
                      </h4>
                      <p className="mt-1 text-xs text-black/55">
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
                      aria-labelledby="legacy-channel-settings-guest-visible-label"
                      data-testid="channel-settings-guest-visible-switch"
                    />
                  </div>
                  {channel?.name !== "all" && <div className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <h4 id="legacy-channel-settings-guest-joinable-label" className="text-sm font-medium text-black">
                        {formatMessage({ id: "channel.edit.guestJoinableTitle" })}
                      </h4>
                      <p className="mt-1 text-xs text-black/55">
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
                      aria-labelledby="legacy-channel-settings-guest-joinable-label"
                      data-testid="channel-settings-guest-joinable-switch"
                    />
                  </div>}
                </div>
              </section>
            )}
            {isJointChannel && (
              <section className="space-y-3 border-b-2 border-black pb-5">
                <div>
                  <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-black/65">
                    <GitBranch size={14} />
                    {formatMessage({ id: "message.channelSettings.jointTitle" })}
                  </div>
                  <p className="mt-1 text-xs text-black/60">
                    {formatMessage({ id: "message.channelSettings.jointDescription" })}
                  </p>
                </div>
                <div>
                  <div className="mb-2 text-xs font-bold uppercase text-black/60">{formatMessage({ id: "channel.edit.connectedServers" })}</div>
                  {jointServers.length > 0 ? (
                    <div className="space-y-2">
                      {jointServers.map((server) => (
                        <div key={`${server.serverId}:${server.status}`} className="flex items-center justify-between gap-3 border-2 border-black bg-brutal-gray/20 px-3 py-2 text-sm">
                          <div className="min-w-0">
                            <div className="truncate font-bold">
                              {server.serverName || server.serverSlug}
                            </div>
                            <div className="truncate text-xs text-black/60">
                              {server.serverSlug}
                              {server.isCurrentServer ? ` · ${formatMessage({ id: "channel.edit.thisServer" })}` : ""}
                            </div>
                          </div>
                          <span className={`shrink-0 border-2 border-black px-2 py-0.5 text-xs font-bold uppercase ${server.status === "active" ? "bg-brutal-lime" : "bg-soft-signal"}`}>
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
                  <div className="mt-3 space-y-2">
                    <Button
                      type="button"
                      onClick={handleResendJointInvite}
                      disabled={resendBusy}
                      size="md"
                      shape="iconText"
                      className="w-full disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Mail size={14} />
                      {resendBusy ? formatMessage({ id: "channel.edit.resending" }) : formatMessage({ id: "channel.edit.resendInvite" })}
                    </Button>
                    {resendStatus && (
                      <p className="text-xs font-bold text-black/70">{resendStatus}</p>
                    )}
                  </div>
                )}
                {effectiveCapabilities.federateChannels && !isArchived && (
                  <div className="mt-4 space-y-3 border-t-2 border-black pt-3">
                    <div className="text-xs font-bold uppercase text-black/60">{formatMessage({ id: "channel.edit.inviteServerSection" })}</div>
                    {jointServerLimitReached ? (
                      <p className="text-sm font-bold text-black/70">
                        {formatMessage({ id: "channel.edit.maxServers" }, { max: MAX_JOINT_CHANNEL_SERVERS })}
                      </p>
                    ) : (
                      <>
                        <FormField label={formatMessage({ id: "channel.edit.serverSlugLabel" })} required>
                          <input
                            type="text"
                            value={inviteServerSlug}
                            onChange={(e) => setInviteServerSlug(e.target.value)}
                            className="input-brutal w-full"
                            placeholder={formatMessage({ id: "channel.edit.serverSlugPlaceholder" })}
                            disabled={inviteBusy}
                          />
                        </FormField>
                        <FormField label={formatMessage({ id: "channel.edit.invitedPeopleLabel" })} required hint={formatMessage({ id: "channel.edit.invitedPeopleHint" })}>
                          <textarea
                            value={invitePeopleText}
                            onChange={(e) => setInvitePeopleText(e.target.value)}
                            className="input-brutal w-full"
                            placeholder={formatMessage({ id: "channel.edit.invitedPeoplePlaceholder" })}
                            rows={2}
                            disabled={inviteBusy}
                          />
                        </FormField>
                        <Button
                          type="button"
                          onClick={handleInviteJointServer}
                          disabled={inviteBusy}
                          size="md"
                          shape="iconText"
                          className="w-full disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Mail size={14} />
                          {inviteBusy ? formatMessage({ id: "channel.edit.inviting" }) : formatMessage({ id: "channel.edit.sendInvite" })}
                        </Button>
                      </>
                    )}
                    {inviteStatus && (
                      <p className="text-xs font-bold text-black/70">{inviteStatus}</p>
                    )}
                  </div>
                )}
              </section>
            )}
          </form>

          {(showLeaveAction || showManageActions || (isArchived && effectiveCapabilities.archiveChannels)) && (
            <section className="mt-5 space-y-3">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wide text-black/65">
                  {formatMessage({ id: "message.channelSettings.actionsTitle" })}
                </h3>
                <p className="mt-1 text-xs text-black/60">
                  {formatMessage({ id: "message.channelSettings.actionsDescription" })}
                </p>
              </div>
              <div className="flex flex-col gap-3">
                {showLeaveAction && (
                  <button
                    type="button"
                    onClick={() => setShowLeaveConfirm(true)}
                    className="btn-brutal flex w-full items-center justify-center gap-1.5 bg-brutal-orange px-4 py-2 text-sm"
                  >
                    <LogOut size={14} />
                    {formatMessage({ id: "channel.edit.leaveChannel" })}
                  </button>
                )}
                {!isJointChannel && showVisibilityAction && (
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
                )}
                {showConvertAction && (
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
                )}
                {!isAllChannel && (
                  <>
                    {!isArchived && <button
                      type="button"
                      onClick={handlePinToggle}
                      className="btn-brutal flex w-full items-center justify-center gap-1.5 bg-brutal-lime px-4 py-2 text-sm"
                    >
                      {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
                      {isPinned
                        ? formatMessage({ id: "channel.edit.unpinChannel" })
                        : formatMessage({ id: "channel.edit.pinChannel" })}
                    </button>}
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
                        <LogOut size={14} />
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
                )}
              </div>
            </section>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-3 border-t-2 border-black bg-brutal-cream px-4 py-3">
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
          {canEditChannel && (
            <button
              type="submit"
              form={CHANNEL_SETTINGS_FORM_ID}
              disabled={saving || isArchived}
              className="btn-brutal bg-brutal-pink px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? formatMessage({ id: "channel.edit.saving" }) : formatMessage({ id: "channel.edit.saveChanges" })}
            </button>
          )}
        </div>
      </ChannelSettingsSheet>

      {showArchiveConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "channel.edit.archiveChannel" })}
          message={formatMessage({ id: "channel.edit.confirmArchive" }, { name: initialName })}
          confirmLabel={formatMessage({ id: "channel.edit.archiveChannel" })}
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
              : currentVisibility === "private" ? formatMessage({ id: "channel.edit.makePublic" }) : formatMessage({ id: "channel.edit.makePrivate" })
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
          confirmLabel={formatMessage({ id: "channel.edit.leaveChannel" })}
          loadingLabel={formatMessage({ id: "channel.edit.leaving" })}
          confirmColor="bg-brutal-orange"
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
            <div className="space-y-2">
              <p>{taskIdentityDropPrompt.consequence}</p>
              <p className="font-bold">
                {formatMessage(
                  { id: "channel.edit.taskIdentityDropCount" },
                  {
                    count: taskIdentityDropPrompt.totalCount,
                    direct: taskIdentityDropPrompt.directTaskCount,
                    threads: taskIdentityDropPrompt.threadTaskCount,
                  },
                )}
              </p>
            </div>
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
          confirmLabel={isJointChannel ? formatMessage({ id: "channel.edit.disconnectChannel" }) : formatMessage({ id: "channel.edit.deleteChannel" })}
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
