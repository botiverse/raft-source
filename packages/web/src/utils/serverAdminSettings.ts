import { canChangeMemberRole } from "@botiverse/raft-shared";
import type { ServerRole } from "@botiverse/raft-shared";
import type { MessageId } from "../i18n/messages/en";

type FormatMessage = (descriptor: { id: MessageId }) => string;

export const UNKNOWN_MEMBER_MESSAGE_ID = "settings.admins.unknownMember" as const satisfies MessageId;

function memberSortLabel(member: Pick<ServerAdminSettingsMember, "name" | "displayName" | "email">) {
  return member.displayName || member.name || member.email || "";
}

function adminPrincipalSortLabel(
  principal: Pick<ServerAdminSettingsPrincipal, "kind" | "name" | "displayName">,
) {
  return principal.displayName || (principal.kind === "agent" ? `@${principal.name}` : principal.name) || "";
}

export interface ServerAdminSettingsMember {
  userId: string;
  name: string;
  displayName: string | null;
  email: string | null;
  avatarUrl?: string | null;
  gravatarHash?: string;
  role: ServerRole;
}

export interface ServerAdminSettingsAgent {
  id: string;
  name: string;
  displayName: string | null;
  avatarUrl?: string | null;
  serverRole: ServerRole | null;
}

export type ServerAdminSettingsPrincipal =
  | (ServerAdminSettingsMember & { kind: "human"; id: string })
  | {
    kind: "agent";
    id: string;
    name: string;
    displayName: string | null;
    avatarUrl?: string | null;
    role: Extract<ServerRole, "admin" | "member">;
  };

export function getAdminPrincipalKey(principal: Pick<ServerAdminSettingsPrincipal, "kind" | "id">) {
  return `${principal.kind}:${principal.id}`;
}

function getPrivilegedMembers(members: ServerAdminSettingsMember[]) {
  return members
    .filter((member) => member.role === "owner" || member.role === "admin")
    .sort((left, right) => {
      if (left.role !== right.role) return left.role === "owner" ? -1 : 1;
      return memberSortLabel(left).localeCompare(memberSortLabel(right));
    });
}

export const getAdminMembers = getPrivilegedMembers;

function toHumanPrincipal(member: ServerAdminSettingsMember): ServerAdminSettingsPrincipal {
  return { ...member, kind: "human", id: member.userId };
}

function toAgentPrincipal(agent: ServerAdminSettingsAgent): ServerAdminSettingsPrincipal | null {
  if (agent.serverRole !== "admin" && agent.serverRole !== "member") return null;
  return {
    kind: "agent",
    id: agent.id,
    name: agent.name,
    displayName: agent.displayName,
    avatarUrl: agent.avatarUrl,
    role: agent.serverRole,
  };
}

function sortAdminPrincipals(left: ServerAdminSettingsPrincipal, right: ServerAdminSettingsPrincipal) {
  if (left.role !== right.role) return left.role === "owner" ? -1 : right.role === "owner" ? 1 : 0;
  return adminPrincipalSortLabel(left).localeCompare(adminPrincipalSortLabel(right));
}

export function getAdminPrincipals(
  members: ServerAdminSettingsMember[],
  agents: ServerAdminSettingsAgent[],
) {
  return [
    ...members.filter((member) => member.role === "owner" || member.role === "admin").map(toHumanPrincipal),
    ...agents.map(toAgentPrincipal).filter((agent): agent is ServerAdminSettingsPrincipal => agent?.role === "admin"),
  ].sort(sortAdminPrincipals);
}

export function getAdminCandidateMembers(
  members: ServerAdminSettingsMember[],
  actorRole: ServerRole | null | undefined
) {
  return members
    .filter((member) =>
      member.role !== "owner" &&
      (canChangeMemberRole(actorRole, member.role, "owner") || canChangeMemberRole(actorRole, member.role, "admin"))
    )
    .sort((left, right) => memberSortLabel(left).localeCompare(memberSortLabel(right)));
}

export function getAdminCandidatePrincipals(
  members: ServerAdminSettingsMember[],
  agents: ServerAdminSettingsAgent[],
  actorRole: ServerRole | null | undefined,
) {
  const humanCandidates = getAdminCandidateMembers(members, actorRole).map(toHumanPrincipal);
  const agentCandidates = agents
    .map(toAgentPrincipal)
    .filter((agent): agent is ServerAdminSettingsPrincipal =>
      agent?.kind === "agent" && agent.role !== "admin" && canChangeMemberRole(actorRole, agent.role, "admin")
    );
  return [...humanCandidates, ...agentCandidates]
    .sort((left, right) => adminPrincipalSortLabel(left).localeCompare(adminPrincipalSortLabel(right)));
}

export function getAdminRoleOptions(
  actorRole: ServerRole | null | undefined,
  member: Pick<ServerAdminSettingsMember, "role">,
) {
  return (["owner", "admin"] as const).filter((role) => role !== member.role && canChangeMemberRole(actorRole, member.role, role));
}

export function getAdminPrincipalRoleOptions(
  actorRole: ServerRole | null | undefined,
  principal: Pick<ServerAdminSettingsPrincipal, "kind" | "role">,
): Extract<ServerRole, "owner" | "admin">[] {
  if (principal.kind === "agent") {
    return principal.role === "admin" || !canChangeMemberRole(actorRole, principal.role, "admin") ? [] : ["admin"];
  }
  return getAdminRoleOptions(actorRole, principal);
}

export function canRemoveAdminMember(
  actorRole: ServerRole | null | undefined,
  member: Pick<ServerAdminSettingsMember, "role">,
  ownerCount = Number.POSITIVE_INFINITY,
) {
  if (member.role !== "owner" && member.role !== "admin") return false;
  if (member.role === "owner" && ownerCount <= 1) return false;
  return canChangeMemberRole(actorRole, member.role, "member");
}

export function canRemoveAdminPrincipal(
  actorRole: ServerRole | null | undefined,
  principal: Pick<ServerAdminSettingsPrincipal, "kind" | "role">,
  ownerCount = Number.POSITIVE_INFINITY,
) {
  if (principal.kind === "human") return canRemoveAdminMember(actorRole, principal, ownerCount);
  return principal.role === "admin" && canChangeMemberRole(actorRole, principal.role, "member");
}

export function unknownMemberLabel(formatMessage: FormatMessage): string {
  return formatMessage({ id: UNKNOWN_MEMBER_MESSAGE_ID });
}

export function getMemberLabel(
  member: Pick<ServerAdminSettingsMember, "name" | "displayName" | "email">,
  formatMessage: FormatMessage,
) {
  return member.displayName || member.name || member.email || unknownMemberLabel(formatMessage);
}

export function getAdminPrincipalLabel(
  principal: Pick<ServerAdminSettingsPrincipal, "kind" | "name" | "displayName">,
  formatMessage: FormatMessage,
) {
  return principal.displayName
    || (principal.kind === "agent" ? `@${principal.name}` : principal.name)
    || unknownMemberLabel(formatMessage);
}
