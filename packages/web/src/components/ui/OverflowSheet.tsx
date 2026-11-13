import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { EllipsisVertical } from "lucide-react";
import { PanelAction } from "@botiverse/raft-ui";
import Tooltip from "./Tooltip";
import type { MessageId } from "../../i18n/messages";

/**
 * A panel head's icon button that opens something (a channel's Search, an agent DM's Lounge). The right-side
 * drawer this file was named for is gone: the channel details are a column of the conversation's row
 * (ChannelDetailsSurface, raft-design channel.md, stdrc 2026-11-10).
 */

/** A panel-head icon action: raft-ui PanelAction (44 on a phone, the DS small
 *  32 on desktop), so its size comes from the panel-action recipe. */
export function OverflowMenuTrigger({
  labelId,
  onClick,
  icon,
  testId,
}: {
  labelId: MessageId;
  onClick: () => void;
  /** Defaults to the generic overflow glyph; semantic surfaces may provide a more precise icon. */
  icon?: ReactNode;
  testId?: string;
}) {
  const { formatMessage } = useIntl();
  return (
    <Tooltip content={formatMessage({ id: labelId })}>
      <PanelAction
        onClick={onClick}
        aria-label={formatMessage({ id: labelId })}
        data-testid={testId}
      >
        {icon ?? <EllipsisVertical />}
      </PanelAction>
    </Tooltip>
  );
}
