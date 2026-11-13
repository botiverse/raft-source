import { useIntl } from "react-intl";
import { Badge } from "@botiverse/raft-ui";
import type { Channel } from "../../store/channelStore";
import { slackSyncHeaderState } from "../../components/channel/slackSyncHeaderState";
import Tooltip from "../../components/ui/Tooltip";

export function ChannelSlackSyncBadge({ channel }: { channel: Pick<Channel, "type" | "bridge"> }) {
  const { formatMessage } = useIntl();
  const state = slackSyncHeaderState(channel);
  if (!state) return null;
  let label: string;
  let tooltip: string;
  let testId: string;
  if (state.kind === "paused") {
    label = formatMessage({ id: "message.chatPanel.slackSyncPaused" });
    tooltip = formatMessage({ id: state.tooltipId });
    testId = "channel-slack-sync-paused";
  } else if (state.kind === "waiting") {
    label = formatMessage({ id: "message.chatPanel.slackSyncWaiting" });
    tooltip = formatMessage(
      { id: "message.chatPanel.slackSyncWaiting.tooltip" },
      { reason: formatMessage({ id: state.reasonId }) },
    );
    testId = "channel-slack-sync-waiting";
  } else {
    label = formatMessage({ id: "message.chatPanel.slackSyncStalled" });
    tooltip = formatMessage({ id: "message.chatPanel.slackSyncStalled.tooltip" });
    testId = "channel-slack-sync-stalled";
  }
  return (
    <Tooltip content={tooltip}>
      <Badge appearance="soft" variant="warning" className="shrink-0" data-testid={testId}>
        {label}
      </Badge>
    </Tooltip>
  );
}
