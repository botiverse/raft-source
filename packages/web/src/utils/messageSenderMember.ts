import type { User } from "../store/authStore";
import type { Message } from "../store/messageStore";
import type { Server, ServerMember } from "../store/serverStore";

function currentUserFallbackMember(
  currentUser: User,
  currentUserServerRole: Server["role"] | null | undefined,
): ServerMember {
  return {
    userId: currentUser.id,
    email: null,
    gravatarHash: currentUser.gravatarHash,
    name: currentUser.name,
    displayName: currentUser.displayName,
    description: currentUser.description,
    avatarUrl: currentUser.avatarUrl,
    role: currentUserServerRole ?? "member",
    joinedAt: "",
  };
}

export function resolveMessageSenderMember(
  message: Pick<Message, "senderType" | "senderId">,
  memberById: Map<string, ServerMember>,
  currentUser: User | null | undefined,
  currentUserServerRole?: Server["role"] | null,
): ServerMember | undefined {
  if (message.senderType !== "user") return undefined;

  const cachedMember = memberById.get(message.senderId);
  if (!currentUser || message.senderId !== currentUser.id) return cachedMember;

  if (!cachedMember) return currentUserFallbackMember(currentUser, currentUserServerRole);
  if (!currentUser.avatarUrl || cachedMember.avatarUrl) return cachedMember;

  // The sender-side HTTP/socket handoff can race with server-member hydration.
  // The auth profile is authoritative for the current user's uploaded avatar,
  // so never let a stale member snapshot downgrade self messages to default.
  return {
    ...cachedMember,
    email: cachedMember.email ?? currentUser.email,
    name: currentUser.name || cachedMember.name,
    displayName: currentUser.displayName ?? cachedMember.displayName,
    description: currentUser.description ?? cachedMember.description,
    avatarUrl: currentUser.avatarUrl,
  };
}

export function resolveMessageSenderMemberFromList(
  message: Pick<Message, "senderType" | "senderId">,
  members: ServerMember[],
  currentUser: User | null | undefined,
  currentUserServerRole?: Server["role"] | null,
): ServerMember | undefined {
  if (message.senderType !== "user") return undefined;
  const cachedMember = members.find((member) => member.userId === message.senderId);
  const memberById = cachedMember ? new Map([[cachedMember.userId, cachedMember]]) : new Map<string, ServerMember>();
  return resolveMessageSenderMember(message, memberById, currentUser, currentUserServerRole);
}
