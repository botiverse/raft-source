import { Badge, ProfilePanelBody, Button, ScrollArea, PanelAction, PanelTitle, Separator, Textarea, ListRowGroup } from "@botiverse/raft-ui";
import { DirectMessageIcon } from "@botiverse/ricons";
import type { BadgeProps } from "@botiverse/raft-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import {
  HelpCircle,
  X,
  Pencil,
} from "lucide-react";
import { HUMAN_SEAT_LIMIT_REACHED_CODE, PRO_AGENT_SEAT_BLOCK_SIZE, seatTenths, seatsFromTenths } from "@botiverse/raft-shared";
import type {
  CapacityLimitDetail,
  GuestChannelField,
  ProfileVisibilityMembershipStatus,
  ServerRole,
} from "@botiverse/raft-shared";
import { useMachineStore } from "../../store/machineStore";
import { useAuthStore } from "../../store/authStore";
import { useChannelStore } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import { useProfileStore } from "../../store/profileStore";
import { useThreadStore } from "../../store/threadStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useAppNavigate, useMobileBack } from "../../hooks/useAppNavigate";
import { hasToastManager, showToast } from "../toastBridge";
import InlineBadgeEditor from "../InlineBadgeEditor";
import AvatarSlot from "../ui/AvatarSlot";
import { DeploymentUserLimitText } from "../ui/DeploymentUserLimitText";
import { isDeploymentUserLimitRefusal } from "../../utils/deploymentUserLimit";
import { HumanAvatarEditMenu } from "./HumanAvatarEditMenu";
import { useImageLightboxStore } from "../../store/imageLightboxStore";
import { isRaftUploadedHumanAvatarUrl } from "../../utils/humanAvatar";
import PanelHeader, { PROFILE_HANDLE_FONT_CLASS } from "../ui/PanelHeader";
import SectionEyebrow from "../ui/SectionEyebrow";
import SectionHeader from "../ui/SectionHeader";
import KeyValueRow from "../ui/KeyValueRow";
import {
  computeAgentDisplayState,
  selectAgentActivitiesSlice,
  useAgentStore,
} from "../../store/agentStore";
import type {
  AgentCreatedSummary,
} from "../../store/agentStore";
import Tooltip from "../ui/Tooltip";
import RolePermissionHelpDialog from "./RolePermissionHelpDialog";
import { getHumanDepartureLabel } from "./humanMembershipStatus";
import {
  avatarUploadApiErrorMessage,
  isAvatarFileTooLarge,
  isAvatarTooLargeError,
} from "../../utils/avatarUpload";
import { formatAgentDisplayStateText } from "../../utils/activity";
import type { MessageId } from "../../i18n/messages";
import { PRO_SEAT_ADD_FEATURE_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import type { AddSeatsNeed } from "../billing/AddSeatsDialog";
import { getEditableHumanServerRoles } from "./humanRoleTransitions";
import { CreatedAgentRow } from "./CreatedAgentRow";
import { GuestChannelRow } from "./GuestChannelRow";
import { canMessageHuman as canMessageHumanRule } from "./humanDmAccess";
import { HumanProfileActions } from "./HumanProfileActions";
import { OwnerGrantConfirmDialog, SelfDemoteConfirmDialog } from "./ownerHandOver";
import { useOwnerHandOver } from "./useOwnerHandOver";
import { memberServerBadgeLabels } from "../../utils/channelLocalMembership";
import type { ChannelMemberServer } from "../../utils/channelLocalMembership";
import { deferredDialog } from "../../boot/deferredUi";
import { trackUndoOffered, trackUndoUsed } from "../../analytics/confirmUndo";
import { RowExpandAction } from "../layout/RowExpandAction";
import { RowMoveMenu } from "../layout/ColumnMoveMenu";
import { shownOwnActions, useHeadWidth } from "../layout/headFit";
import { useRowExpand, useRowPlanned } from "../layout/rowPlanStore";
import { RowRegionBody } from "../layout/RowRegionBody";

const AddSeatsDialog = deferredDialog(() => import("../billing/AddSeatsDialog"));

// A role is a fact about the person, not a status or a signal (DS rule 4/5):
// owner, admin and member are the same neutral chip; a guest comes from
// outside the workspace and reads as the cyan-soft external chip.
const ROLE_CONFIG: Record<ServerRole, { labelId: MessageId; variant: NonNullable<BadgeProps["variant"]> }> = {
  owner: { labelId: "member.detail.roleOwner", variant: "default" },
  admin: { labelId: "member.detail.roleAdmin", variant: "default" },
  member: { labelId: "member.detail.roleMember", variant: "default" },
  guest: { labelId: "member.detail.roleGuest", variant: "information" },
};
// A small icon-only action beside a label (edit, help): raft-ui ghost
// `icon-md` in ink-3, pulled into the label's line (-4px above and below) so
// the 32px control doesn't grow the row.
const INLINE_ICON_ACTION_CLASS = "-my-1 text-foreground-hint hover:text-foreground";
// Help and Edit sit side by side after the Role label: 12px apart (the row's
// 8px gap plus 4px), so their 44px hit areas (6px past each 32px box) meet
// instead of overlapping.
const SECOND_INLINE_ICON_ACTION_CLASS = `${INLINE_ICON_ACTION_CLASS} ml-1`;
// Higher first: a pick further down this list demotes.
const ROLE_RANK: Record<ServerRole, number> = { owner: 3, admin: 2, member: 1, guest: 0 };

const EDITABLE_ROLE_OPTIONS: { id: ServerRole; labelId: MessageId }[] = [
  { id: "owner", labelId: "member.detail.roleOwner" },
  { id: "admin", labelId: "member.detail.roleAdmin" },
  { id: "member", labelId: "member.detail.roleMember" },
];
const MAX_HUMAN_DESCRIPTION_LENGTH = 3000;

export interface HumanProfile extends GuestChannelField {
  userId: string;
  serverId?: string;
  serverName?: string | null;
  serverSlug?: string | null;
  /** Joint channel context only (RFC 075 phase 1): every server the person
   *  participates through in that channel, viewed server first. */
  servers?: ChannelMemberServer[];
  email: string | null;
  name: string;
  displayName: string | null;
  description: string | null;
  avatarUrl: string | null;
  role: ServerRole | null;
  joinedAt: string | null;
  membershipStatus: ProfileVisibilityMembershipStatus;
  createdAgents: AgentCreatedSummary[];
  profileProjection?: "channel_summary";
}

export default function HumanDetailPanel({
  human,
  onClose,
  onBack,
  onOpenProfile,
}: {
  human: HumanProfile;
  onClose?: () => void;
  /** Drawer/page-stack mode: return to the previous in-drawer page.
   *  Unlike the responsive route back control, this stays visible on
   *  desktop and never consults browser history. */
  onBack?: () => void;
  /** Controlled page stacks use this instead of the global profile overlay. */
  onOpenProfile?: (type: "agent" | "human", id: string) => void;
}) {
  const intl = useIntl();
  const { formatDate, formatMessage } = intl;
  const currentUser = useAuthStore((s) => s.user);
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const uploadAvatar = useAuthStore((s) => s.uploadAvatar);
  const isSelf = currentUser?.id === human.userId;
  const openUserDM = useChannelStore((s) => s.openUserDM);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const updateMemberRole = useServerStore((s) => s.updateMemberRole);
  const removeMember = useServerStore((s) => s.removeMember);
  const loadMembers = useServerStore((s) => s.loadMembers);
  const members = useServerStore((s) => s.members);
  const serverSlug = useServerStore((s) => s.current?.slug);
  const currentServerId = useServerStore((s) => s.current?.id);
  const currentServerName = useServerStore((s) => s.current?.name ?? "");
  const loadBilling = useServerStore((s) => s.loadBilling);
  // An empty serverId is another server's person whom the channel the profile
  // was opened from lists through no server (#wg-rbac:#58): still not ours.
  const isRemoteJointHuman = Boolean(
    currentServerId && typeof human.serverId === "string" && human.serverId !== currentServerId,
  );
  const isChannelSummaryHuman = human.profileProjection === "channel_summary";
  // Every server the person participates through when any of them is not
  // this one (a person on both sides of a joint channel lists both).
  const sourceServerLabel = memberServerBadgeLabels(human, currentServerId).join(", ") || null;
  // Two render modes for HumanDetailPanel — see AgentDetailPanel for the
  // same pattern. Overlay mode (`onClose` provided) routes back through
  // the closer rather than skipping past the underlying channel/DM to
  // /members. Cold-start permalink repro: #proj-mobile:b1c622e5
  // (stdrc 2026-05-08).
  const responsiveBack = useMobileBack(
    onClose ?? (serverSlug ? `/s/${serverSlug}/members` : "/"),
  );
  const headerBack = onBack ?? responsiveBack;
  const { role: currentRole, capabilities } = useServerPermissions();
  const seatAddEnabled = useServerFeatureFlag(PRO_SEAT_ADD_FEATURE_FLAG_KEY).enabled;
  const nav = useAppNavigate();
  // Named-slice subscriptions + render-time compute (see MachineDetailPanel /
  // React #185 incident note): a selector-built map of display states is a
  // fresh object per snapshot and loops the render.
  const storeAgentsForDisplay = useAgentStore((s) => s.agents);
  const activitiesSliceForDisplay = useAgentStore(selectAgentActivitiesSlice);
  const machinesForDisplay = useMachineStore((s) => s.machines);
  // Panel state. Both parents (MainLayout, ProfilePanel) pass `key={resolvedHuman.userId}`
  // so this component fully unmounts and remounts whenever the displayed human
  // changes — every state below is therefore entity-scoped and gets clean
  // defaults on every entity switch. The description's Edit button re-seeds
  // `descriptionValue` from the current prop before flipping the editing flag,
  // so the initial value here is only observed before any edit.
  // A role applies when it is picked, with Undo on a toast (Raft DS ›
  // Feedback, "Confirming": a change to others that can be changed back).
  // Demoting yourself is confirmed first: you may lose the right to undo it.
  // The badge reads `human.role`: the parent resolves it from the live member
  // list, which `updateMemberRole` and the other routes keep current.
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  const [roleSaving, setRoleSaving] = useState(false);
  const [roleError, setRoleError] = useState("");
  // A Guest's promotion refused at the Raft License's user limit (its sentence has a mail link).
  const [roleUserLimitRefused, setRoleUserLimitRefused] = useState(false);
  /** The role waiting on the self-demotion confirmation. */
  const [pendingSelfDemotion, setPendingSelfDemotion] = useState<ServerRole | null>(null);
  /** The role waiting on a seat: Guest → member with the Pro seats full. */
  const [seatRole, setSeatRole] = useState<ServerRole | null>(null);
  /** Guest → member with the Pro seats full: an owner adds one, then the role is saved again. */
  const [seatNeed, setSeatNeed] = useState<AddSeatsNeed | null>(null);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionValue, setDescriptionValue] = useState(
    human.description || "",
  );
  const [descriptionSaving, setDescriptionSaving] = useState(false);
  const [descriptionError, setDescriptionError] = useState("");
  const [showRoleHelp, setShowRoleHelp] = useState(false);
  // Derive avatar from the canonical source per render. For self, the
  // currentUser store entry is authoritative — authStore.uploadAvatar
  // calls `set({ user: data })`, so the new URL flows back through the
  // selector without any local mirror. For other humans, the prop is the
  // only writer (no one else can upload their avatar). A bare
  // useState(human.avatarUrl) mirror is what react-doctor's
  // no-derived-useState rule guards against.
  const avatarUrl = isSelf ? (currentUser?.avatarUrl ?? null) : human.avatarUrl;
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  const currentHumanRole: ServerRole | null = human.role;
  // What Undo restores: never Guest, as the server never makes a member a Guest.
  const undoRole = currentHumanRole === "guest" ? null : currentHumanRole;
  const roleInfo = currentHumanRole
    ? ROLE_CONFIG[currentHumanRole] || ROLE_CONFIG.member
    : null;
  const editableRoleOptions = useMemo(
    () => {
      if (!currentHumanRole) return [];
      const allowed = new Set(getEditableHumanServerRoles({
        actorRole: currentRole,
        targetRole: currentHumanRole,
        isSelf,
        ownerCount: members.filter((member) => member.role === "owner").length,
      }));
      return EDITABLE_ROLE_OPTIONS.filter((option) => allowed.has(option.id));
    },
    [currentHumanRole, currentRole, isSelf, members],
  );
  const localizedEditableRoleOptions = useMemo(
    () =>
      editableRoleOptions.map((option) => ({
        id: option.id,
        label: formatMessage({ id: option.labelId }),
      })),
    [editableRoleOptions, formatMessage],
  );
  const canEditRole =
    human.membershipStatus === "active" &&
    !isRemoteJointHuman &&
    capabilities.changeMemberRoles &&
    editableRoleOptions.length > 0;
  const canRemove =
    human.membershipStatus === "active" &&
    !isRemoteJointHuman &&
    capabilities.removeMembers &&
    !isSelf &&
    (human.role === "owner"
      ? currentRole === "owner" &&
        members.filter((member) => member.role === "owner").length > 1
      : currentRole === "owner" || human.role === "member" || human.role === "guest");
  // Design D2: an owner/admin promotes a Guest from its profile (HumanProfileActions).
  const canPromoteGuest = canEditRole && !isSelf && human.role === "guest" && editableRoleOptions.some((option) => option.id === "member");
  const departureLabel = getHumanDepartureLabel(human.membershipStatus);
  const departureLabelText =
    departureLabel === "Left"
      ? formatMessage({ id: "member.detail.statusLeft" })
      : departureLabel === "Removed"
        ? formatMessage({ id: "member.detail.statusRemoved" })
        : null;

  const joinedDate = human.joinedAt
    ? formatDate(new Date(human.joinedAt), {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  // Find existing DM channel for this human
  const dmChannel = useMemo(
    () => dmChannels.find((c) => c.peerId === human.userId),
    [dmChannels, human.userId],
  );
  // A Guest has no DMs (#wg-rbac:#15): the rule the Members page's menu shares.
  const canMessageHuman = canMessageHumanRule(currentRole, human, { isRemoteJointHuman });

  useEffect(() => {
    if (!editingDescription || !descriptionRef.current) return;
    descriptionRef.current.style.height = "0px";
    descriptionRef.current.style.height = `${descriptionRef.current.scrollHeight}px`;
  }, [descriptionValue, editingDescription]);

  const handleUploadAvatar = useCallback(async (file: File) => {
    // Already correct in shape — this only converges the page-scoped duplicate
    // onto the shared id so there is one "too large" sentence, not two.
    if (isAvatarFileTooLarge(file)) {
      setAvatarError(formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) }));
      return;
    }
    setAvatarSaving(true);
    setAvatarError("");
    try {
      await uploadAvatar(file);
      // authStore.uploadAvatar already calls `set({ user: data })`, so
      // the currentUser selector above re-renders the derived avatarUrl
      // with the new URL — no local mirror needed.
      await loadMembers();
    } catch (err: any) {
      // Map the size code first — avatarUploadApiErrorMessage would otherwise
      // return err.message and render the raw "AVATAR_TOO_LARGE" identifier.
      setAvatarError(
        isAvatarTooLargeError(err)
          ? formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) })
          : avatarUploadApiErrorMessage(
              err,
              formatMessage({ id: "member.detail.uploadAvatarFailed" }),
            ),
      );
    } finally {
      setAvatarSaving(false);
    }
  }, [formatMessage, uploadAvatar, loadMembers]);

  const handleAvatarBuilt = useCallback(() => {
    setAvatarError("");
    void loadMembers();
  }, [loadMembers]);

  const mobileBackProps = useMemo(
    () => ({
      "data-testid": "human-mobile-back",
      title: formatMessage({ id: "common.announcement.back" }),
    }),
    [formatMessage],
  );

  const handleStartEditDescription = useCallback(() => {
    setDescriptionValue(human.description || "");
    setDescriptionError("");
    setEditingDescription(true);
  }, [human.description]);
  const handleShowRoleHelp = useCallback(() => setShowRoleHelp(true), []);
  const handOver = useOwnerHandOver({ serverId: currentServerId, selfUserId: currentUser?.id, actorIsOwner: currentRole === "owner", isSelf, selfDemotionPending: pendingSelfDemotion !== null });
  const { want: wantOwnImpact, asksFirst: ownerGrantAsksFirst } = handOver;
  const handleStartEditRole = useCallback(() => {
    wantOwnImpact();
    setRolePickerOpen(true);
    setRoleError("");
    setRoleUserLimitRefused(false);
  }, [wantOwnImpact]);
  const handleMessage = useCallback(async () => {
    useProfileStore.getState().closeProfile();
    useThreadStore.getState().closeThread();
    if (dmChannel) {
      nav.toDm(dmChannel.id);
    } else {
      const ch = await openUserDM(human.userId);
      if (ch) nav.toDm(ch.id);
    }
  }, [dmChannel, nav, openUserDM, human.userId]);
  // A column of the planned row (#189 rule 6): the head always fits. Its avatar goes under 240px (the prototype's),
  // and Message goes into ⋯ where the title would drop under its room; ⋯, Expand and Close stay.
  const headPlanned = useRowPlanned();
  const [measureHead, headWidth] = useHeadWidth();
  const headContainerProps = useMemo(() => ({ ref: measureHead }), [measureHead]);
  const headExpand = useRowExpand("profile");
  const headNarrow = headPlanned && headWidth > 0;
  const showHeadAvatar = !headNarrow || headWidth >= 240;
  const messageFolded = headNarrow && canMessageHuman && shownOwnActions({ width: headWidth, lead: showHeadAvatar ? 1 : 0, own: [32], controls: (headExpand.shown ? 1 : 0) + (onClose ? 1 : 0), menuItems: 0 }) === 0;
  const messageLabel = formatMessage({ id: "member.detail.message" });
  const foldedMessage = useMemo(() => (messageFolded ? [{ id: "message", label: messageLabel, icon: <DirectMessageIcon width={22} height={22} aria-hidden="true" />, onSelect: () => { void handleMessage(); } }] : undefined), [handleMessage, messageFolded, messageLabel]);

  const handleSaveDescription = useCallback(async () => {
    const nextDescription = descriptionValue.trim();
    if (
      nextDescription.length > MAX_HUMAN_DESCRIPTION_LENGTH
    ) {
      setDescriptionError(
        formatMessage(
          { id: "member.detail.descriptionMaxLength" },
          { count: MAX_HUMAN_DESCRIPTION_LENGTH },
        ),
      );
      return;
    }
    setDescriptionSaving(true);
    setDescriptionError("");
    try {
      await updateProfile({
        description: nextDescription || null,
      });
      await loadMembers();
      setEditingDescription(false);
    } catch (err: any) {
      setDescriptionError(
        err.response?.data?.error ||
          formatMessage({
            id: "member.detail.updateDescriptionFailed",
          }),
      );
    } finally {
      setDescriptionSaving(false);
    }
  }, [descriptionValue, formatMessage, updateProfile, loadMembers]);

  const handleDescriptionChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDescriptionError((current) => (current ? "" : current));
    setDescriptionValue(e.target.value);
  }, []);

  const handleCancelDescription = useCallback(() => {
    setDescriptionValue(human.description || "");
    setDescriptionError("");
    setEditingDescription(false);
  }, [human.description]);

  const personName = human.displayName || human.name;
  const toastPerson = useMemo(
    () => ({ avatarUrl }),
    [avatarUrl],
  );
  const roleLabel = useCallback(
    (role: ServerRole) => formatMessage({ id: (ROLE_CONFIG[role] || ROLE_CONFIG.member).labelId }),
    [formatMessage],
  );

  /**
   * Stores `nextRole`. `undoTo` is the role Undo puts back; a confirmed
   * self-demotion passes none, since you may no longer be allowed to.
   */
  const applyRole = useCallback(async (nextRole: ServerRole, undoTo: ServerRole | null) => {
    // Undo goes to the server the role was changed on, even after a switch.
    const serverId = useServerStore.getState().current?.id;
    const userId = human.userId;
    try {
      setRoleSaving(true);
      setRoleError("");
      setRoleUserLimitRefused(false);
      await updateMemberRole(userId, nextRole, serverId ? { serverId } : undefined);
      const title = formatMessage({ id: "member.detail.roleChanged" }, { name: personName, role: roleLabel(nextRole) });
      if (!undoTo || !serverId) {
        showToast({ title, type: "success", data: { person: toastPerson } });
        return;
      }
      let undoUsed = false;
      // Only a toast a host shows can offer it.
      if (hasToastManager()) trackUndoOffered("role_change", serverId);
      showToast({
        title,
        type: "success",
        data: { person: toastPerson },
        actionProps: {
          children: formatMessage({ id: "member.detail.undo" }),
          onClick: () => {
            if (undoUsed) return;
            undoUsed = true;
            // Only while the role is still the one this change stored: a
            // change made since (here or elsewhere) is not overwritten.
            void updateMemberRole(userId, undoTo, { serverId, onlyIfRole: nextRole }).then((result) => {
              trackUndoUsed("role_change", result === "changed" ? "superseded" : "undone", serverId);
              showToast(result === "changed"
                ? {
                    title: formatMessage({ id: "member.detail.undoRoleChangedSince" }, { name: personName }),
                    data: { person: toastPerson },
                  }
                : {
                    title: formatMessage({ id: "member.detail.roleRestored" }, { name: personName, role: roleLabel(undoTo) }),
                    type: "success",
                    data: { person: toastPerson },
                  });
            }, () => {
              trackUndoUsed("role_change", "failed", serverId);
              showToast({ title: formatMessage({ id: "member.detail.undoRoleFailed" }), type: "error" });
            });
          },
        },
      });
    } catch (err: unknown) {
      const axiosErr = err as {
        response?: { data?: { error?: string; code?: string; capacityLimit?: CapacityLimitDetail } };
      };
      const refusal = axiosErr.response?.data;
      const limit = refusal?.capacityLimit;
      // No form to fill in: the owner adds the seat right away. The dialog reads
      // the seats from billing, so load it first; without billing, the refusal shows as before.
      // An owner adds the seat; an admin asks an owner for it (task #10).
      const addsSeat = seatAddEnabled && refusal?.code === HUMAN_SEAT_LIMIT_REACHED_CODE && limit?.limitType === "universal";
      if (addsSeat) await loadBilling().catch(() => undefined);
      if (addsSeat && useServerStore.getState().billing) {
        const usedTenths = seatTenths(limit.humans, limit.agents);
        const roomTenths = Math.max(0, limit.limit * PRO_AGENT_SEAT_BLOCK_SIZE - usedTenths);
        const count = Math.max(1, Math.ceil((usedTenths + PRO_AGENT_SEAT_BLOCK_SIZE) / PRO_AGENT_SEAT_BLOCK_SIZE) - limit.limit);
        setSeatRole(nextRole);
        setSeatNeed({
          tenths: PRO_AGENT_SEAT_BLOCK_SIZE,
          label: formatMessage({ id: "addSeats.promote.label" }, { name: personName }),
          title: formatMessage({ id: "addSeats.promote.title" }, { name: personName, count }),
          hint: !capabilities.manageBilling
            ? formatMessage({ id: "addSeats.askHint" }, { seats: limit.limit, server: currentServerName })
            : roomTenths > 0
              ? formatMessage({ id: "addSeats.promote.hintRoom" }, { name: personName, room: seatsFromTenths(roomTenths), server: currentServerName })
              : formatMessage({ id: "addSeats.promote.hint" }, { name: personName, seats: limit.limit, server: currentServerName }),
          resume: formatMessage({ id: "addSeats.promote.resume" }, { name: personName }),
          gate: "seat_limit_invite",
        });
        return;
      }
      // The badge still shows the stored role; the failure is said under it.
      if (isDeploymentUserLimitRefusal(err)) {
        setRoleUserLimitRefused(true);
        return;
      }
      setRoleError(
        axiosErr.response?.data?.error ||
          formatMessage({
            id: "member.detail.updateRoleFailed",
          }),
      );
    } finally {
      setRoleSaving(false);
    }
  }, [updateMemberRole, human.userId, personName, roleLabel, toastPerson, formatMessage, seatAddEnabled, loadBilling, currentServerName, capabilities.manageBilling]);

  const handleSelectRole = useCallback((picked: string) => {
    const nextRole = picked as ServerRole;
    setRolePickerOpen(false);
    if (!currentHumanRole || nextRole === currentHumanRole) return;
    if (isSelf && ROLE_RANK[nextRole] < ROLE_RANK[currentHumanRole]) {
      setPendingSelfDemotion(nextRole);
      return;
    }
    if (ownerGrantAsksFirst(nextRole)) return;
    void applyRole(nextRole, undoRole);
  }, [applyRole, currentHumanRole, isSelf, ownerGrantAsksFirst, undoRole]);

  const handleToggleRolePicker = useCallback(() => {
    setRolePickerOpen((value) => !value);
  }, []);
  const handleCloseRolePicker = useCallback(() => setRolePickerOpen(false), []);

  const handleConfirmSelfDemotion = useCallback(async () => {
    if (!pendingSelfDemotion) return;
    await applyRole(pendingSelfDemotion, null);
    setPendingSelfDemotion(null);
  }, [applyRole, pendingSelfDemotion]);
  const handleCloseSelfDemotion = useCallback(() => {
    if (!roleSaving) setPendingSelfDemotion(null);
  }, [roleSaving]);

  // An admin asks an owner for the seat; once added, the role is changed as the admin.
  const seatAsk = useMemo(() => (capabilities.manageBilling ? undefined : {
    purpose: { kind: "member:promote" as const, userId: human.userId, name: personName, role: seatRole === "admin" ? "admin" as const : "member" as const },
  }), [capabilities.manageBilling, human.userId, personName, seatRole]);
  const closeSeats = useCallback(() => {
    setSeatNeed(null);
    setSeatRole(null);
  }, []);
  // The seat counts now: save the role the owner picked.
  const handleSeatsAdded = useCallback(() => {
    setSeatNeed(null);
    const role = seatRole;
    setSeatRole(null);
    if (role && currentHumanRole) void applyRole(role, undoRole);
  }, [applyRole, currentHumanRole, seatRole, undoRole]);

  // No Undo: a member is never made a Guest again. At the seat limit applyRole
  // opens the same Add Seats flow as the Role picker.
  const promoteGuest = useCallback(() => applyRole("member", null), [applyRole]);
  const removeThisMember = useCallback(() => removeMember(human.userId), [removeMember, human.userId]);

  const closeRoleHelp = useCallback(() => setShowRoleHelp(false), []);

  return (
    <ProfilePanelBody className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title={human.displayName || human.name}
        subtitle={`@${human.name}`}
        subtitleClassName={PROFILE_HANDLE_FONT_CLASS}
        iconSlot={showHeadAvatar ? (
          <AvatarSlot
            context="panel-header"
            type="human"
            humanAvatarUrl={avatarUrl}
          />
        ) : undefined}
        containerProps={headContainerProps}
        iconAlwaysVisible
        iconKind="avatar"
        onMobileBack={headerBack}
        backButtonVisibility={onBack ? "always" : "responsive"}
        mobileBackProps={mobileBackProps}
        actions={
          <>
            {/* DS header icon buttons (raft-ui PanelAction), like every panel
                header: borderless, 44 with a 22px glyph on a phone, the DS
                small 32 (18px glyph) on desktop. */}
            {canMessageHuman && !messageFolded && (
              <Tooltip content={formatMessage({ id: "member.detail.message" })}>
              <PanelAction
                onClick={handleMessage}
                aria-label={formatMessage({ id: "member.detail.message" })}
              >
                <DirectMessageIcon width={22} height={22} aria-hidden="true" />
              </PanelAction>
              </Tooltip>
            )}
            {/* The profile's Expand (#189 rule 5), a window control against Close; none outside the planned row. */}
            <RowMoveMenu folded={foldedMessage} />
            <RowExpandAction />
            {onClose && (
              <PanelAction
                onClick={onClose}
                className={onBack ? "flex" : "hidden md:flex"}
                aria-label={formatMessage({ id: "common.close" })}
                title={formatMessage({ id: "common.close" })}
              >
                <X size={22} aria-hidden="true" />
              </PanelAction>
            )}
          </>
        }
      />

      {/* Profile content — white paper, sections separated by hairlines; hidden while a region expanded in its
          column shows the profile as its head alone (#189 rule 5). */}
      <RowRegionBody>
      <ScrollArea className="flex-1 bg-layer-canvas">
        {sourceServerLabel && (
          <>
          <div className="px-(--surface-inset) py-3">
            <SectionEyebrow as="div" className="mb-1">
              {formatMessage({ id: "member.detail.from" })}
            </SectionEyebrow>
            <div className="text-callout font-semibold text-foreground">
              {sourceServerLabel}
            </div>
          </div>
          <Separator />
          </>
        )}
        {/* Avatar + name — left-aligned like agent profile */}
        <div className="flex items-start gap-4 px-(--surface-inset) py-5">
          {isSelf && human.membershipStatus === "active" ? (
            <HumanAvatarEditMenu
              testId="human-detail-avatar-edit"
              context="profile-hero"
              avatarUrl={avatarUrl}
              busy={avatarSaving}
              onUpload={handleUploadAvatar}
              onBuilt={handleAvatarBuilt}
            />
          ) : isRaftUploadedHumanAvatarUrl(avatarUrl) ? (
            <Tooltip content={formatMessage({ id: "member.detail.viewAvatar" })}>
            <button
              type="button"
              onClick={() =>
                useImageLightboxStore
                  .getState()
                  .openImage(avatarUrl, human.displayName || human.name)
              }
              className="group relative flex shrink-0 rounded-sticker outline-none focus-visible:shadow-focus"
              aria-label={formatMessage({ id: "member.detail.viewAvatar" })}
            >
              <AvatarSlot
                context="profile-hero"
                type="human"
                humanAvatarUrl={avatarUrl}
              />
            </button>
            </Tooltip>
          ) : (
            <AvatarSlot
              context="profile-hero"
              type="human"
              humanAvatarUrl={avatarUrl}
            />
          )}
          <div className="min-w-0 flex-1">
            {/* PanelTitle source (cindyz 2026-10-10): the detail-block name follows
                the panel-title spec so the same name reads identically in the
                header and the body. */}
            <PanelTitle className="min-w-0">{human.displayName || human.name}</PanelTitle>
            <div className="mt-0.5 flex min-w-0 items-center gap-2">
              <span
                className={`min-w-0 truncate ${PROFILE_HANDLE_FONT_CLASS} text-mono-meta text-foreground-hint`}
              >
                @{human.name}
              </span>
              {departureLabel && (
                <Badge appearance="soft" variant="muted" className="shrink-0">
                  {departureLabelText}
                </Badge>
              )}
              {isSelf && (
                <Badge appearance="outline" className="shrink-0">
                  {formatMessage({ id: "member.detail.you" })}
                </Badge>
              )}
            </div>
          </div>
        </div>
        {isSelf && human.membershipStatus === "active" && avatarError && (
          <div
            className="-mt-3 px-(--surface-inset) pb-4 text-caption font-semibold text-danger-strong"
            role="alert"
          >
            {avatarError}
          </div>
        )}

        <Separator />
        <div className="px-(--surface-inset) py-4">
          <div className="flex items-center gap-2 mb-1">
            <SectionEyebrow as="div">
              {formatMessage({ id: "member.detail.description" })}
            </SectionEyebrow>
            {isSelf &&
              human.membershipStatus === "active" &&
              !editingDescription && (
                <Tooltip content={formatMessage({ id: "member.detail.editDescription" })}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-md"
                  onClick={handleStartEditDescription}
                  className={INLINE_ICON_ACTION_CLASS}
                  aria-label={formatMessage({
                    id: "member.detail.editDescription",
                  })}
                >
                  <Pencil aria-hidden="true" />
                </Button>
                </Tooltip>
              )}
          </div>
          {isSelf && human.membershipStatus === "active" ? (
            editingDescription ? (
              <div className="stack-y-1.5">
                <Textarea
                  ref={descriptionRef}
                  value={descriptionValue}
                  onChange={handleDescriptionChange}
                  rows={3}
                  maxLength={MAX_HUMAN_DESCRIPTION_LENGTH}
                  placeholder={formatMessage({
                    id: "member.detail.descriptionPlaceholder",
                  })}
                  className="m-0 min-h-11 w-full resize-none overflow-hidden"
                />
                <div className="flex items-center gap-2">
                  <Button size="md" variant="accent"
                    type="button"
                    onClick={handleSaveDescription}
                    disabled={descriptionSaving}
                  >
                    {descriptionSaving
                      ? formatMessage({ id: "member.detail.saving" })
                      : formatMessage({ id: "member.detail.save" })}
                  </Button>
                  <Button size="md" variant="default"
                    type="button"
                    onClick={handleCancelDescription}
                    disabled={descriptionSaving}
                  >
                    {formatMessage({ id: "member.detail.cancel" })}
                  </Button>
                </div>
                {/* DS field foot: the error (danger ink) and the mono count. */}
                <div className="flex items-start justify-between gap-3">
                  {descriptionError ? (
                    <span className="text-caption font-semibold text-danger-strong">
                      {descriptionError}
                    </span>
                  ) : (
                    <span />
                  )}
                  <span className="shrink-0 font-mono text-mono-meta text-foreground-hint">
                    {descriptionValue.trim().length}/
                    {MAX_HUMAN_DESCRIPTION_LENGTH}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-callout text-foreground-muted">
                {human.description || (
                  <span className="text-foreground-hint">
                    {formatMessage({ id: "member.detail.noDescription" })}
                  </span>
                )}
              </p>
            )
          ) : (
            <div className="text-callout text-foreground-muted">
              {human.description || (
                <span className="text-foreground-hint">
                  {formatMessage({ id: "member.detail.noDescription" })}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Info */}
        {!isRemoteJointHuman && !isChannelSummaryHuman && (
          <>
          <Separator />
          <div className="px-(--surface-inset) py-4">
            <SectionEyebrow as="div" className="mb-3">
              {formatMessage({ id: "member.detail.info" })}
            </SectionEyebrow>
            <div className="stack-y-3">
              {/* Role */}
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <div className="text-footnote font-medium text-foreground-hint">
                    {departureLabel
                      ? formatMessage({ id: "member.detail.status" })
                      : formatMessage({ id: "member.detail.role" })}
                  </div>
                  {!departureLabel && (
                    <Tooltip content={formatMessage({
                      id: "member.detail.rolePermissions",
                    })}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-md"
                      onClick={handleShowRoleHelp}
                      className={INLINE_ICON_ACTION_CLASS}
                      aria-label={formatMessage({
                        id: "member.detail.rolePermissions",
                      })}
                    >
                      <HelpCircle aria-hidden="true" />
                    </Button>
                    </Tooltip>
                  )}
                  {canEditRole && roleInfo && !rolePickerOpen && (
                    <Tooltip content={formatMessage({ id: "member.detail.editRole" })}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-md"
                      onClick={handleStartEditRole}
                      disabled={roleSaving}
                      className={departureLabel ? INLINE_ICON_ACTION_CLASS : SECOND_INLINE_ICON_ACTION_CLASS}
                      aria-label={formatMessage({
                        id: "member.detail.editRole",
                      })}
                    >
                      <Pencil aria-hidden="true" />
                    </Button>
                    </Tooltip>
                  )}
                </div>
                {departureLabel ? (
                  <Badge appearance="soft" variant="muted">
                    {departureLabelText}
                  </Badge>
                ) : canEditRole && roleInfo ? (
                  rolePickerOpen ? (
                    <div className="relative inline-block">
                      <InlineBadgeEditor
                        displayValue={formatMessage({ id: roleInfo.labelId })}
                        selectedId={currentHumanRole ?? "member"}
                        options={localizedEditableRoleOptions}
                        onSelect={handleSelectRole}
                        open={rolePickerOpen}
                        onToggle={handleToggleRolePicker}
                        onRequestClose={handleCloseRolePicker}
                        badgeClassName=""
                        badgeVariant={roleInfo.variant}
                        dropdownMinWidth="min-w-[140px]"
                        dropdownAlign="left"
                        disabled={roleSaving}
                      />
                    </div>
                  ) : (
                    <Badge appearance="soft" variant={roleInfo.variant} data-testid="human-role-badge">{formatMessage({ id: roleInfo.labelId })}</Badge>
                  )
                ) : roleInfo ? (
                  <Badge appearance="soft" variant={roleInfo.variant}>{formatMessage({ id: roleInfo.labelId })}</Badge>
                ) : (
                  <Badge appearance="soft" variant="muted">
                    {formatMessage({ id: "member.detail.unknown" })}
                  </Badge>
                )}
                {(roleError || roleUserLimitRefused) && (
                  <div role="alert" className="mt-1 text-caption font-semibold text-warning-strong" data-testid="human-role-error">
                    {roleUserLimitRefused ? <DeploymentUserLimitText /> : roleError}
                  </div>
                )}
              </div>
              {/* Email */}
              {human.email && (
                <KeyValueRow
                  label={formatMessage({ id: "member.detail.email" })}
                  value={human.email}
                  breakAll
                />
              )}
              <GuestChannelRow human={human} />
              {/* Joined */}
              {joinedDate && (
                <KeyValueRow
                  label={formatMessage({ id: "member.detail.joined" })}
                  value={joinedDate}
                  mono
                />
              )}
            </div>
          </div>
          </>
        )}
        {!isRemoteJointHuman && !isChannelSummaryHuman && (
          <>
          <Separator />
          <div className="px-(--surface-inset) py-4">
            <SectionHeader
              className="mb-3"
              label={formatMessage({ id: "member.detail.createdAgents" })}
              count={human.createdAgents?.length ?? 0}
            />
            {human.createdAgents?.length ? (
              // DS ListRow › `rf-list--inset`: one card, hairlines between rows.
              <ListRowGroup>
                {human.createdAgents.map((createdAgent) => {
                  const displayState = computeAgentDisplayState(
                    storeAgentsForDisplay,
                    activitiesSliceForDisplay,
                    createdAgent.id,
                    createdAgent,
                    undefined,
                    machinesForDisplay,
                  );
                  const activityText = formatAgentDisplayStateText(intl, displayState);
                  return (
                    <CreatedAgentRow
                      key={createdAgent.id}
                      createdAgent={createdAgent}
                      displayState={displayState}
                      activityText={activityText}
                      onOpenProfile={onOpenProfile}
                    />
                  );
                })}
              </ListRowGroup>
            ) : (
              <span className="text-callout text-foreground-hint">
                {formatMessage({ id: "member.detail.noCreatedAgents" })}
              </span>
            )}
          </div>
          </>
        )}
        <HumanProfileActions serverId={currentServerId} memberId={human.userId} personName={personName} serverName={currentServerName} canPromote={canPromoteGuest} canRemove={canRemove}
          promoting={roleSaving} onPromote={promoteGuest} onRemove={removeThisMember} />
      </ScrollArea>
      </RowRegionBody>
      {pendingSelfDemotion ? (
        <SelfDemoteConfirmDialog roleLabel={roleLabel(pendingSelfDemotion)} ownImpact={currentRole === "owner" ? handOver.impact : null}
          onConfirm={handleConfirmSelfDemotion} onClose={handleCloseSelfDemotion} />
      ) : null}
      {handOver.grantPending ? (
        <OwnerGrantConfirmDialog personName={personName} ownImpact={handOver.impact} undoTo={undoRole} saving={roleSaving} applyRole={applyRole} onClose={handOver.closeGrant} />
      ) : null}
      {seatNeed ? (
        <AddSeatsDialog
          need={seatNeed}
          onClose={closeSeats}
          onAdded={handleSeatsAdded}
          ask={seatAsk}
        />
      ) : null}
      {showRoleHelp && (
        <RolePermissionHelpDialog
          subject="human"
          onClose={closeRoleHelp}
        />
      )}
    </ProfilePanelBody>
  );
}
