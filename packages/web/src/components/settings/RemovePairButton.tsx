import { useCallback } from "react";
import { Trash2 } from "lucide-react";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";
import type { SlackBridgeChannelPair } from "./slackBridgeProvisioning";

export function RemovePairButton({
  pair,
  onRemove,
}: {
  pair: SlackBridgeChannelPair;
  onRemove: (pair: SlackBridgeChannelPair) => void;
}) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => onRemove(pair), [onRemove, pair]);
  return (
    <Button size="icon-md" variant="ghost" aria-label={formatMessage({ id: "settings.slackBridge.removePair" })} onClick={handleClick}>
      <Trash2 size={16} />
    </Button>
  );
}
