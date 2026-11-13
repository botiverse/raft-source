import type { ReactNode, Ref } from "react";
import { useIntl } from "react-intl";
import { CheckCheck } from "lucide-react";
import Tooltip from "../ui/Tooltip";

/** The "·" between the line's parts: between its segments, and before its hint. Visual only. */
export function ReadStatusSeparator() {
  return <span className="shrink-0" aria-hidden data-slot="read-status-separator">·</span>;
}

/**
 * The read-status line under a message (artin, option C): below everything
 * the message owns (footer, inline thread replies), like iMessage's "Read".
 * Its own row, right-aligned, one caption in foreground-hint. A DM's last
 * message says "Read" (DmReadStatusLine); in a channel or thread your latest
 * message says which agents it will not reach (AgentReadStatusLine, agent read
 * progress), when there are any.
 */
export function MessageReadStatusLine({
  rowRef,
  testId,
  affordance,
  icon,
  text,
  label,
  tooltip,
  truncate = false,
  hint,
}: {
  /** The line's row: as wide as the message's content, whatever the line draws (AgentReadStatusLine measures it). */
  rowRef?: Ref<HTMLDivElement>;
  testId: string;
  affordance: string;
  icon: ReactNode;
  /**
   * What the line says. With `truncate` its parts are laid out as items of
   * the line's own row (the slot is `display: contents`), so each says
   * whether it gives way: the agent line lets only its names take the
   * ellipsis, never a verb or a count. Nested in a box of their own, the
   * parts that never shrink would spill over the hint once the names are gone.
   */
  text: ReactNode;
  label: string;
  /** What the tooltip says instead of `text`. */
  tooltip?: string;
  /** The line may be cut on a narrow width (its full text in the tooltip). */
  truncate?: boolean;
  /**
   * What to do about it, after `text` and a "·". On a narrow width `text`
   * gives way first (its parts that can, AgentReadStatusLine's names, only
   * take the room left over); the hint is the line's one shrinking part and
   * loses its tail to an ellipsis once the rest no longer fits. Part of the
   * visible line only: `label` says it all for a screen reader, and the
   * tooltip has the names.
   */
  hint?: string;
}) {
  return (
    <div ref={rowRef} className={truncate ? "mt-1 flex h-5 min-w-0 justify-end" : "mt-1 flex h-5 justify-end"} data-testid={testId}>
      <Tooltip content={tooltip ?? text}>
      <span
        className={`inline-flex ${truncate ? "min-w-0" : "shrink-0"} items-center gap-1 whitespace-nowrap text-caption text-foreground-hint`}
        data-message-affordance={affordance}
        aria-label={label}
      >
        {icon}
        <span className={truncate ? "contents" : undefined} data-slot="read-status-text">{text}</span>
        {hint ? (
          <>
            <ReadStatusSeparator />
            <span className="min-w-0 truncate text-foreground-hint" data-slot="read-status-hint">{hint}</span>
          </>
        ) : null}
      </span>
      </Tooltip>
    </div>
  );
}

/** A DM's last message, read by its peer (MessageItem decides when). */
export function DmReadStatusLine() {
  const { formatMessage } = useIntl();
  const read = formatMessage({ id: "message.messageItem.read" });
  return (
    <MessageReadStatusLine
      testId="dm-read-status"
      affordance="read-receipt"
      icon={<CheckCheck size={12} className="shrink-0" />}
      text={read}
      label={read}
    />
  );
}
