import { useIntl } from "react-intl";
import { Badge } from "@botiverse/raft-ui";
import { formatTaskConversationRef, formatTaskConversationTitle } from "../../utils/taskConversation";
import { TruncatedTooltip } from "./TruncatedTooltip";
import type { ForwardSearchTarget } from "./forwardComposerModel";

const TITLE_CLASS = "block min-w-0 truncate";

/** A thread / task row's text: `#channel › first line` or `#channel:#7 title`, as the server names it. */
function conversationTargetText(target: ForwardSearchTarget): string {
  if (target.title) return target.title;
  if (target.type === "task" && typeof target.taskNumber === "number") {
    const ref = formatTaskConversationRef({
      taskNumber: target.taskNumber,
      channelName: target.parentChannelName,
      channelType: target.parentChannelType,
    });
    return formatTaskConversationTitle(ref, target.taskTitle);
  }
  return target.parentMessagePreview ?? "";
}

/**
 * A thread or task destination's name in the Forward picker: one line, cut
 * off at the row's end. On a desktop a cut-off name shows in full in a
 * tooltip (only then); a phone has no hover, so none. The conversation the
 * forward was opened from carries a trailing "Current" marker.
 */
export function ForwardConversationTargetTitle({
  target,
  isMobile,
  current,
}: {
  target: ForwardSearchTarget;
  isMobile: boolean;
  current: boolean;
}) {
  const { formatMessage } = useIntl();
  const text = conversationTargetText(target);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      {isMobile ? (
        <span className={TITLE_CLASS} data-testid="forward-conversation-title">{text}</span>
      ) : (
        <TruncatedTooltip content={text} className={TITLE_CLASS} testId="forward-conversation-title">{text}</TruncatedTooltip>
      )}
      {current ? (
        <Badge appearance="soft" variant="muted" className="shrink-0" data-testid="forward-conversation-current">
          {formatMessage({ id: "message.forwardComposer.currentConversation" })}
        </Badge>
      ) : null}
    </span>
  );
}
