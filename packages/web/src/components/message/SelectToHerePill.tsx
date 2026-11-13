import { ArrowDown, ArrowUp } from "lucide-react";
import { useIntl } from "react-intl";
import { MessageListJumpPill } from "@botiverse/raft-ui/wip";
import type { SelectToHere } from "./useSelectToHere";

/**
 * Select to here (task #235): "↑ Select to here" / "↓ Select to here", the
 * arrow toward the selection's anchor, out of view. BottomJumpControls renders
 * it while `selectToHere.direction` is set (useSelectToHere): first on the
 * controls' line, at its start, beside Back to bottom and the unread-thread
 * pill; where the line is too narrow for all, they wrap onto a line above it.
 */
export function SelectToHerePill({ selectToHere }: { selectToHere: SelectToHere }) {
  const { formatMessage } = useIntl();
  const { direction, select } = selectToHere;
  if (!direction) return null;
  return (
    <MessageListJumpPill
      // At the line's start, also when alone on a line it wrapped to.
      className="pointer-events-auto me-auto shrink-0"
      onClick={select}
      data-testid="select-to-here-pill"
      data-direction={direction}
    >
      {direction === "up" ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />}
      {formatMessage({ id: "message.selectModeToolbar.selectToHere" })}
    </MessageListJumpPill>
  );
}
