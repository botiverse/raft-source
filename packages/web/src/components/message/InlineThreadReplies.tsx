/**
 * Inline thread replies (task #47, artin-directed) — the "Feishu, no card" form.
 *
 * Replies render BELOW the message's chip area as one muted preview surface.
 * Up to three human/agent previews stack under the `N replies` label. The whole
 * surface is one button — not only the count — so a user can click any preview
 * row to open the thread (artin, task #594). System events do not consume a
 * preview slot, and a system-only history has no inline conversation affordance;
 * those events remain available inside the full Thread.
 *
 * Avatars go through `AvatarSlot context="compact-list"` per sender type —
 * rendering every sender with the agent sprite left humans (and agents with
 * null avatarUrl) as identical fallback blocks, which artin flagged.
 *
 * Rendering is memoized per message: a reply arriving in one thread must not
 * re-render the timeline (#4434 class). This component takes only plain data +
 * a stable callback so it can sit inside a memoized MessageItem without
 * punching through it.
 */
import { memo, useMemo } from "react";
import { useIntl } from "react-intl";
import { Pencil } from "lucide-react";
import AvatarSlot from "../ui/AvatarSlot";
import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import type { ServerMember } from "../../store/serverStore";
import type { ThreadReplyPreview } from "../../store/threadRepliesReadModel";
import { resolveMessageSenderMember } from "../../utils/messageSenderMember";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";

const MAX_INLINE_PREVIEWS = 3;

export function hasInlineThreadReplySurface(
  replies: ThreadReplyPreview[],
  replyCount: number,
): boolean {
  return replyCount > 0 && replies.some((reply) => reply.senderType !== "system");
}

export interface InlineThreadRepliesProps {
  replies: ThreadReplyPreview[];
  replyCount: number;
  unreadCount: number;
  hasDraft: boolean;
  onOpenThread: () => void;
  channelParticipantAgentsById?: ReadonlyMap<string, Agent>;
  channelParticipantMembersById?: ReadonlyMap<string, ServerMember>;
}

function ReplyAvatar({
  reply,
  channelParticipantAgentsById,
  channelParticipantMembersById,
}: {
  reply: ThreadReplyPreview;
  channelParticipantAgentsById?: ReadonlyMap<string, Agent>;
  channelParticipantMembersById?: ReadonlyMap<string, ServerMember>;
}) {
  // Keep identity subscriptions inside the individual avatar. The parent
  // message row remains memoized per thread scope, while an avatar still reacts
  // when this exact member/agent profile is hydrated or updated.
  const agent = useAgentStore((state) =>
    reply.senderType === "agent"
      ? state.agents.find((candidate) => candidate.id === reply.senderId)
      : undefined
  );
  const cachedMember = useServerStore((state) =>
    reply.senderType === "user"
      ? state.members.find((candidate) => candidate.userId === reply.senderId)
      : undefined
  );
  const currentUserServerRole = useServerStore((state) => state.current?.role);
  const currentUser = useAuthStore((state) => state.user);
  const channelParticipantAgent = channelParticipantAgentsById?.get(reply.senderId);
  const channelParticipantMember = channelParticipantMembersById?.get(reply.senderId);
  const member = useMemo(() => {
    if (reply.senderType !== "user") return undefined;
    const authoritativeMember = channelParticipantMember ?? cachedMember;
    const memberById = authoritativeMember
      ? new Map<string, ServerMember>([[authoritativeMember.userId, authoritativeMember]])
      : new Map<string, ServerMember>();
    return resolveMessageSenderMember(
      { senderType: "user", senderId: reply.senderId },
      memberById,
      currentUser,
      currentUserServerRole,
    );
  }, [cachedMember, channelParticipantMember, currentUser, currentUserServerRole, reply.senderId, reply.senderType]);

  if (reply.senderType === "system") return null;
  if (reply.senderType === "agent") {
    return (
      <AvatarSlot
        context="compact-list"
        type="agent"
        agentAvatarUrl={agent?.avatarUrl ?? channelParticipantAgent?.avatarUrl ?? reply.senderAvatarUrl}
      />
    );
  }
  if (reply.senderType === "external_projection") {
    return (
      <AvatarSlot
        context="compact-list"
        type="app"
        appAvatarUrl={reply.senderAvatarUrl}
        appInitials={reply.senderDisplayName || reply.senderName}
      />
    );
  }
  return (
    <AvatarSlot
      context="compact-list"
      type="human"
      humanAvatarUrl={member?.avatarUrl ?? reply.senderAvatarUrl}
      gravatarHash={member?.gravatarHash ?? null}
      email={member?.email ?? null}
      humanPlaceholder={!member?.avatarUrl && !member?.gravatarHash && !member?.email && !reply.senderAvatarUrl}
    />
  );
}

export const InlineThreadReplies = memo(function InlineThreadReplies({
  replies,
  replyCount,
  unreadCount,
  hasDraft,
  onOpenThread,
  channelParticipantAgentsById,
  channelParticipantMembersById,
}: InlineThreadRepliesProps) {
  const { formatMessage } = useIntl();
  const { formatMessageTime } = useTimeFormatter();
  if (!hasInlineThreadReplySurface(replies, replyCount)) return null;

  // The server may serve more than we show (or fewer, on an older payload);
  // the display cap is ours, not the transport's.
  const previews = replies
    .filter((reply) => reply.senderType !== "system")
    .slice(0, MAX_INLINE_PREVIEWS);
  // The header is always the thread's authoritative total. Preview truncation
  // is only a presentation detail and must not change the count's meaning.
  const countText = formatMessage(
    { id: "message.inlineThreadReplies.replyCount" },
    { count: replyCount },
  );
  const countLabel = (
    <span
      data-message-affordance="inline-thread-replies-count"
      className="shrink-0 text-[12.5px] font-bold text-black/55 transition-colors group-hover:text-black"
    >
      {countText}
      {unreadCount > 0
        ? ` · ${formatMessage({ id: "message.inlineThreadReplies.newReplyCount" }, { count: unreadCount })}`
        : ""}
      {hasDraft ? (
        <>
          {" · "}
          <Pencil
            aria-hidden="true"
            size={12}
            data-message-affordance="inline-thread-replies-draft-icon"
            className="mx-0.5 inline-block align-[-2px]"
          />
          {formatMessage({ id: "message.inlineThreadReplies.draft" })}
        </>
      ) : null}
      {" ›"}
    </span>
  );

  return (
    <button
      type="button"
      onClick={onOpenThread}
      data-message-affordance="inline-thread-replies"
      /* This is an intuitive row-level action, not a web link; keep the app's
         default arrow cursor while the full gray surface remains clickable. */
      className="group mt-1.5 flex min-w-0 w-full max-w-full flex-col gap-1 bg-black/[0.03] px-2.5 py-2 text-left transition-colors hover:bg-black/[0.08] focus-visible:outline focus-visible:outline-1 focus-visible:outline-black"
    >
      {countLabel}
      {previews.map((reply) => {
        return (
          <span
            key={reply.messageId}
            data-inline-thread-reply-row
            className="flex min-w-0 w-full max-w-full items-center gap-1.5 text-[12.5px] leading-tight"
          >
            <span className="shrink-0">
              <ReplyAvatar
                reply={reply}
                channelParticipantAgentsById={channelParticipantAgentsById}
                channelParticipantMembersById={channelParticipantMembersById}
              />
            </span>
            {/* The clock remains fixed, so the sender must be allowed to give
                width back on narrow panes; otherwise its intrinsic width can
                push the entire row past the preview surface. */}
            <span className="min-w-0 shrink truncate font-semibold text-black/70">
              {reply.senderDisplayName || reply.senderName}
            </span>
            <span className="min-w-0 flex-1 truncate text-black/60">{reply.preview}</span>
            <time
              dateTime={reply.createdAt}
              data-inline-thread-reply-time
              className="ml-auto shrink-0 text-[11.5px] tabular-nums text-black/40"
            >
              {formatMessageTime(reply.createdAt)}
            </time>
          </span>
        );
      })}
    </button>
  );
});
