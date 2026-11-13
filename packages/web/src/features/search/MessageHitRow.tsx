import { useCallback } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useIntl } from "react-intl";
import {
  Badge,
  SearchMessageResult,
  SearchMessageResultBody,
  SearchMessageResultHeader,
  SearchMessageResultMeta,
  SearchMessageResultSender,
  SearchMessageResultThreadMeta,
  SearchMessageResultTimestamp,
  SearchThreadMessageResult,
} from "@botiverse/raft-ui";
import { ThreadIcon } from "@botiverse/ricons";
import { ListTodo } from "lucide-react";
import { formatRelativeTimeParts } from "../../utils/relativeTime";
import { delegatedByOf, formatDelegatedSender, isRetractedPreviewOf } from "../../components/message/delegatedMessage";
import { formatTaskConversationRef, formatTaskConversationTitle } from "../../utils/taskConversation";
import { useChannelStore } from "../../store/channelStore";
import { useTaskConversationTask } from "../../components/task/useTaskConversationTask";
import AvatarSlot from "../../components/ui/AvatarSlot";
import { getSearchRelativeTimeParts } from "./searchGrouping";
import { SearchHighlight } from "./SearchHighlight";
import type { MessageSearchResult, SearchSenderMember } from "./searchResultTypes";
import { SEARCH_HIT_AVATAR_BOX, SEARCH_HIT_TEXT_INSET } from "./searchHitGeometry";

/** One message hit, top-level or nested inside a thread group. */
export function MessageHitRow({
  result,
  nested,
  selected,
  returnedFrom = false,
  sourceLabel,
  agentAvatarUrl,
  senderMember,
  query,
  onResultClick,
}: {
  result: MessageSearchResult;
  nested: boolean;
  selected: boolean;
  /** The row a phone user just came back from: located (states.md#located). */
  returnedFrom?: boolean;
  sourceLabel: string;
  agentAvatarUrl: string | null;
  senderMember: SearchSenderMember | null;
  query: string;
  onResultClick: (event: ReactMouseEvent<HTMLButtonElement>, result: MessageSearchResult) => void;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => onResultClick(event, result),
    [onResultClick, result],
  );

  const Result = nested ? SearchThreadMessageResult : SearchMessageResult;

  // DS search hit (`.rf-hit`): a 27px identity in its own column, then who /
  // where / time on one line and a two-line excerpt under it. The DOM keeps
  // the original reading order (where, then who, then when — so the button's
  // accessible name is unchanged): rui's raft recipe moves the sender to the
  // front visually, and the avatar is lifted into the left column by
  // positioning it against the row, on the content's start (raft-ui list
  // cell: the 8px shape inset + 12px inside it, 20px; 12px from the top),
  // with the text column 27 + 12px after it. No line between hits, and the
  // state shape stays raft-ui's (raft-design patterns/lists.md).
  return (
    <Result
      type="button"
      onClick={handleClick}
      selected={selected}
      data-returned-from={returnedFrom ? "" : undefined}
      data-located={returnedFrom ? "" : undefined}
      className={SEARCH_HIT_TEXT_INSET}
    >
    <SearchMessageResultHeader>
      {/* A task conversation hit names its place once: the task's ref
          (`#channel:#7 title`) already says the channel. */}
      <SearchMessageResultMeta>
        {result.channelType === "task" ? <TaskConversationHitLabel result={result} /> : sourceLabel}
      </SearchMessageResultMeta>
      {result.channelType === "thread" && (
        <SearchMessageResultThreadMeta>
          <ThreadIcon width={12} height={12} />
          {formatMessage({ id: "search.threadInline" })}
        </SearchMessageResultThreadMeta>
      )}
      {(result.channelType === "thread" || result.channelType === "task"
        ? result.parentChannelArchivedAt
        : result.channelArchivedAt) && (
        <Badge appearance="soft" variant="warning">
          {formatMessage({ id: "search.archived" })}
        </Badge>
      )}
      <SearchMessageResultSender>
        <span className={SEARCH_HIT_AVATAR_BOX}>
          {result.senderType === "agent" ? (
            <AvatarSlot context="compact-row" type="agent" agentAvatarUrl={agentAvatarUrl} />
          ) : result.senderType === "external_projection" ? (
            <AvatarSlot context="compact-row" type="app" appAvatarUrl={result.senderAvatarUrl} appInitials={result.senderName} />
          ) : (
            <AvatarSlot context="compact-row" type="human" humanAvatarUrl={senderMember?.avatarUrl} />
          )}
        </span>
        <span>{formatDelegatedSender(formatMessage, result.senderName, delegatedByOf(result))}</span>
      </SearchMessageResultSender>
      <SearchMessageResultTimestamp>{(() => {
        const parts = getSearchRelativeTimeParts(result.createdAt);
        return parts ? formatRelativeTimeParts(parts.value, parts.unit, intl.locale) : formatMessage({ id: "search.grpUnknownTime" });
      })()}</SearchMessageResultTimestamp>
    </SearchMessageResultHeader>
    <SearchMessageResultBody>
      {isRetractedPreviewOf(result.retracted, result.content) ? (
        // RFC 077: a retracted message shows the muted retracted line, never its text.
        <span className="text-foreground-hint" data-testid="search-hit-retracted">
          {formatMessage({ id: "message.delegated.retracted" })}
        </span>
      ) : (
        <SearchHighlight text={result.snippet} query={query} />
      )}
    </SearchMessageResultBody>
    </Result>
  );
}

/**
 * Task v2: a hit in a task's own conversation names its task (`#channel:#7
 * title`) where a thread hit says "thread". The hit names its task; a task the
 * client already holds keeps the title live (renamed since indexing).
 */
function TaskConversationHitLabel({ result }: { result: MessageSearchResult }) {
  const { formatMessage } = useIntl();
  const task = useTaskConversationTask({ taskId: result.taskId ?? null });
  const dmPeerName = useChannelStore((s) => (result.parentChannelType === "dm"
    ? s.dmChannels.find((c) => c.id === result.parentChannelId)?.peerName ?? null
    : null));
  const taskNumber = task?.taskNumber ?? result.taskNumber ?? null;
  const title = task?.title ?? result.taskTitle ?? null;
  const label = taskNumber != null
    ? formatTaskConversationTitle(
      formatTaskConversationRef({
        taskNumber,
        channelName: result.parentChannelName,
        channelType: result.parentChannelType,
        dmPeerName,
      }),
      title,
    )
    : formatMessage({ id: "search.taskConversationInline" });
  return (
    <span className="inline-flex min-w-0 items-center gap-1" data-testid="search-hit-task">
      <ListTodo width={12} height={12} aria-hidden className="shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
