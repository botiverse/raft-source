// The conversation the personal assistant was opened from (#proj-assistant:
// 102aff91, tygg and Grace): opened from a composer's otter, the assistant's
// DM carries that conversation as a chip above its input. The chip is never
// sent alone: the next message the owner sends gets the conversation's
// ordinary reference token appended (`#general`, `#general:1a2b3c4d`,
// `dm:@alice`, `dm:@alice:1a2b3c4d`; raftRefs in shared), which every message
// renders as a reference chip, and then the chip clears. × removes it first.
//
// The assistant reads what its owner can see, DMs only while the owner's
// switch lets it (RFC 077, visibilityService's `delegated` actor). So a DM, or
// a thread in one, with that switch off says the assistant can't see it; the
// token still goes, since the owner may want to point at it all the same.

import { useId, useMemo } from "react";
import { useIntl } from "react-intl";
import { Hash, X } from "lucide-react";
import { DirectMessageIcon, ThreadIcon } from "@botiverse/ricons";
import { formatDmPeerRef, formatRaftRefTarget, parseRaftRefTarget } from "@botiverse/raft-shared";
import type { RaftRefTarget } from "@botiverse/raft-shared";
import { ReferenceChip } from "../components/message/ReferenceChip";
import type { ComposerReference } from "../features/composer/composerTypes";
import Tooltip from "../components/ui/Tooltip";
import { useChannelStore } from "../store/channelStore";
import { findStoredChannel } from "../store/storedChannel";
import type { Channel } from "../store/channelStore";

/** The thread line's excerpt of its parent message: its first line, cut to this many characters. */
const EXCERPT_MAX = 48;

export interface AssistantContextRef {
  kind: "channel" | "dm";
  /** "#general" or "@Alice": the conversation as its own header names it. */
  conversation: string;
  /** In a thread: the first line of its parent message ("" when it has no text). Null: not a thread. */
  threadExcerpt: string | null;
  /** The reference token the message carries. */
  token: string;
  /** False: a DM (or a thread in one) while the owner keeps DMs from the assistant. */
  readable: boolean;
}

function firstLineExcerpt(text: string | null): string {
  const line = (text ?? "").split("\n").map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  const flat = line.replace(/\s+/g, " ");
  return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX).trimEnd()}…` : flat;
}

/**
 * What the chip says and the token it appends, for a conversation the client
 * holds. Null where there is nothing a message could reference: a channel
 * kind with no token (a Lounge, a thread row), or a name or message id the
 * reference grammar can't carry (it would not render as a chip).
 */
export function assistantContextRef(
  channel: Channel,
  thread: { parentMessageId: string; parentText: string | null } | null,
  readsDms: boolean,
): AssistantContextRef | null {
  const shortId = thread ? thread.parentMessageId.slice(0, 8).toLowerCase() : null;
  let target: RaftRefTarget;
  let conversation: string;
  let kind: AssistantContextRef["kind"];
  if (channel.type === "dm") {
    const name = channel.peerName ?? channel.name;
    // A person and an agent may share a name: carry the peer's kind (dm:@name~agent),
    // so the reference names exactly this DM (dmPeerRef).
    const peerKind = channel.peerType === "agent" ? "agent" : channel.peerType === "user" ? "human" : null;
    const peerName = formatDmPeerRef(name, peerKind);
    target = shortId ? { kind: "dm-thread", peerName, threadShortId: shortId } : { kind: "dm", peerName };
    conversation = `@${channel.peerDisplayName || name}`;
    kind = "dm";
  } else if (channel.type === "channel" || channel.type === "private" || channel.type === "joint") {
    target = shortId
      ? { kind: "channel-thread", channelName: channel.name, threadShortId: shortId }
      : { kind: "channel", channelName: channel.name };
    conversation = `#${channel.name}`;
    kind = "channel";
  } else {
    return null;
  }
  const token = formatRaftRefTarget(target);
  if (parseRaftRefTarget(token)?.kind !== target.kind) return null;
  return {
    kind,
    conversation,
    threadExcerpt: thread ? firstLineExcerpt(thread.parentText) : null,
    token,
    readable: kind === "dm" ? readsDms : true,
  };
}

/** Where the assistant was opened from: a composer's conversation (a thread's parent channel, plus the thread); null on a page with none. */
export interface AssistantOrigin {
  channelId: string | null;
  threadParentMessageId: string | null;
  /** The thread's parent message text, while its panel has it. */
  threadParentText: string | null;
}

/** The conversation the assistant was opened from, as the store has it now. */
export function useAssistantContextRef(
  { channelId, threadParentMessageId, threadParentText }: AssistantOrigin,
  readsDms: boolean,
): AssistantContextRef | null {
  const channel = useChannelStore((s) => findStoredChannel(s, channelId) ?? null);
  return useMemo(
    () => (channel
      ? assistantContextRef(channel, threadParentMessageId ? { parentMessageId: threadParentMessageId, parentText: threadParentText } : null, readsDms)
      : null),
    [channel, threadParentMessageId, threadParentText, readsDms],
  );
}

/** The chip above the assistant DM's input, with its × and, when the assistant can't read it, a muted line saying so. */
export function AssistantContextChip({ context, onRemove }: { context: AssistantContextRef; onRemove: () => void }) {
  const { formatMessage } = useIntl();
  const warningId = useId();
  const label = context.threadExcerpt === null
    ? context.conversation
    : context.threadExcerpt
      ? formatMessage({ id: "assistant.context.thread" }, { conversation: context.conversation, excerpt: context.threadExcerpt })
      : formatMessage({ id: "assistant.context.threadNoExcerpt" }, { conversation: context.conversation });
  const remove = formatMessage({ id: "assistant.context.remove" }, { name: label });
  const icon = context.threadExcerpt !== null ? ThreadIcon : context.kind === "dm" ? DirectMessageIcon : Hash;
  return (
    <div
      role="group"
      aria-label={formatMessage({ id: "assistant.context.attached" }, { name: label })}
      aria-describedby={context.readable ? undefined : warningId}
      className="flex min-w-0 max-w-full basis-full flex-col items-start gap-1"
      data-testid="assistant-context-chip"
    >
      <span className="flex min-w-0 max-w-full">
        <ReferenceChip
          icon={icon}
          // As the sent token renders (MessageItem): a channel or DM in accent, a thread as a link.
          variant={context.threadExcerpt !== null ? "link" : "accent"}
          label={label}
          trailing={(
            <Tooltip content={remove}>
              <button
                type="button"
                aria-label={remove}
                onClick={onRemove}
                className="shrink-0 rounded-chip text-foreground-muted outline-none hover:text-foreground focus-visible:shadow-focus"
                data-testid="assistant-context-chip-remove"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </Tooltip>
          )}
        />
      </span>
      {context.readable ? null : (
        <p id={warningId} className="text-footnote text-foreground-muted" data-testid="assistant-context-unreadable">
          {formatMessage({ id: "assistant.context.unreadable" })}
        </p>
      )}
    </div>
  );
}

/** The composer reference ChatPanel's input takes: the chip, and the token for the next message. */
export function useAssistantComposerReference(context: AssistantContextRef | null, onDetach: () => void): ComposerReference | null {
  return useMemo(
    () => (context
      ? { chip: <AssistantContextChip context={context} onRemove={onDetach} />, token: context.token, onSent: onDetach }
      : null),
    [context, onDetach],
  );
}
