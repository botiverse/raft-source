import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { CheckCheck } from "lucide-react";
import Tooltip from "../ui/Tooltip";

/**
 * The read-status line under a message (artin, option C): below everything
 * the message owns (footer, inline thread replies), like iMessage's "Read".
 * Its own row, right-aligned, one caption in foreground-hint. A DM's last
 * message says "Read" (DmReadStatusLine).
 */
export function MessageReadStatusLine({
  testId,
  affordance,
  icon,
  text,
  label,
}: {
  testId: string;
  affordance: string;
  icon: ReactNode;
  /** What the line says (also its tooltip). */
  text: ReactNode;
  label: string;
}) {
  return (
    <div className="mt-1 flex h-5 justify-end" data-testid={testId}>
      <Tooltip content={text}>
      <span
        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-caption text-foreground-hint"
        data-message-affordance={affordance}
        aria-label={label}
      >
        {icon}
        <span data-slot="read-status-text">{text}</span>
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
