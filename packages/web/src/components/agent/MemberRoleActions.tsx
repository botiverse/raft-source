import type { ChannelAgent, ChannelHuman } from "../../hooks/useChannelMembers";
import { ChannelMemberHoverActions } from "../channel/ChannelMemberList";
import type { IntlShape } from "react-intl";
import { useCallback, useMemo } from "react";

type MemberRoleActionsProps = {
  targetType: "user" | "agent";
  member: ChannelHuman | ChannelAgent;
  removeAction?: () => void;
  isArchived: boolean;
  isAllChannel: boolean;
  roleCapabilitiesEnabled: boolean;
  currentUserId: string | undefined;
  roleChangingKey: string | null;
  changeMemberRole: (targetType: "user" | "agent", memberId: string, role: "member" | "admin") => Promise<void>;
  formatMessage: IntlShape["formatMessage"];
  onProtectedDemote: (name: string | null) => void;
  onRoleError: (error: string | null) => void;
  onRoleChanging: (key: string | null | ((current: string | null) => string | null)) => void;
};

export function MemberRoleActions({
  targetType,
  member,
  removeAction,
  isArchived,
  isAllChannel,
  roleCapabilitiesEnabled,
  currentUserId,
  roleChangingKey,
  changeMemberRole,
  formatMessage,
  onProtectedDemote,
  onRoleError,
  onRoleChanging,
}: MemberRoleActionsProps) {
  const serverRole = member.serverRole ?? ("role" in member ? member.role : "member");
  const effectiveRole = member.effectiveChannelRole
    ?? (serverRole === "owner" || serverRole === "admin" || member.channelRole === "admin" ? "admin" : "member");
  const protectedServerAdmin = serverRole === "owner" || serverRole === "admin";
  const canExplainProtectedDemote = !isArchived
    && !isAllChannel
    && roleCapabilitiesEnabled
    && member.id !== currentUserId
    && protectedServerAdmin
    && effectiveRole !== "member";
  const canChangeRole = !isArchived && !isAllChannel && member.canChangeChannelRole;
  const showRoleAction = canChangeRole || canExplainProtectedDemote;
  const nextRole = effectiveRole === "member" ? "admin" : "member";
  const key = `${targetType}:${member.id}`;

  const handleRoleClick = useCallback(() => {
    if (canExplainProtectedDemote) {
      onProtectedDemote(member.displayName || member.name);
      return;
    }
    onRoleError(null);
    onRoleChanging(key);
    void changeMemberRole(targetType, member.id, nextRole)
      .catch(() => onRoleError(formatMessage({ id: "agent.channelMembers.updateRoleFailed" })))
      .finally(() => onRoleChanging((current) => current === key ? null : current));
  }, [canExplainProtectedDemote, changeMemberRole, formatMessage, key, member, nextRole, onProtectedDemote, onRoleChanging, onRoleError, targetType]);

  const roleAction = useMemo(() => (showRoleAction ? {
    label: formatMessage({
      id: nextRole === "admin"
        ? "agent.channelMembers.makeAdminShort"
        : "agent.channelMembers.removeAdminShort",
    }),
    ariaLabel: formatMessage({
      id: nextRole === "admin"
        ? "agent.channelMembers.makeAdmin"
        : "agent.channelMembers.removeAdmin",
    }, { name: member.name }),
    disabled: roleChangingKey === key,
    onClick: handleRoleClick,
  } : undefined), [formatMessage, handleRoleClick, key, member.name, nextRole, roleChangingKey, showRoleAction]);

  const remove = useMemo(() => (removeAction ? {
    label: formatMessage({ id: "agent.channelMembers.removeName" }, { name: member.name }),
    onClick: removeAction,
  } : undefined), [formatMessage, member.name, removeAction]);

  if (!showRoleAction && !removeAction) return null;
  return <ChannelMemberHoverActions roleAction={roleAction} removeAction={remove} />;
}
