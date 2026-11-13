import { useIntl } from "react-intl";
import Banner from "../ui/Banner";
import { Button, Spinner } from "@botiverse/raft-ui";
import { JoinChannelIcon } from "@botiverse/ricons";
import Tooltip from "../ui/Tooltip";

type Props = {
  joinTargetCount: number;
  joinTargetSummary: string;
  joinTargetTitle: string;
  joinInFlight: boolean;
  onJoin: () => void;
  hasJointDestination: boolean;
};

export default function ForwardComposerWarnings({
  joinTargetCount,
  joinTargetSummary,
  joinTargetTitle,
  joinInFlight,
  onJoin,
  hasJointDestination,
}: Props) {
  const { formatMessage } = useIntl();
  const joinLabel = formatMessage({ id: "message.forwardComposer.joinSelected" });
  return (
    <>
      {joinTargetCount > 0 && (
        <Banner
          intent="warning"
          withIcon
          density="sm"
          className="mb-3 items-center"
          aria-live="polite"
          data-testid="forward-join-banner"
          actions={(
            <Button type="button" size="md" variant="outline" onClick={onJoin} disabled={joinInFlight} aria-label={joinLabel} data-testid="forward-join-selected-channels">
              {joinInFlight ? <Spinner size="xs" aria-label={formatMessage({ id: "message.forwardComposer.joining" })} /> : <JoinChannelIcon width={12} height={12} />}
              {formatMessage({ id: "message.forwardComposer.join" })}
            </Button>
          )}
        >
          <Tooltip content={formatMessage({ id: "message.forwardComposer.joinBeforeForwarding" }, { targets: joinTargetTitle })}>
            <span className="block min-h-6 min-w-0 truncate leading-6">
              {formatMessage({ id: "message.forwardComposer.joinBeforeForwarding" }, { targets: joinTargetSummary })}
            </span>
          </Tooltip>
        </Banner>
      )}
      {hasJointDestination && (
        <Banner intent="warning" withIcon className="mb-3">
          {formatMessage({ id: "message.forwardComposer.jointWarning" })}
        </Banner>
      )}
    </>
  );
}

/** Forwarding messages: which of the selected ones were left out, and why. */
export function ForwardSkippedNotice({ skippedCount, nestedForwardCount, sourceIsThread }: {
  skippedCount: number;
  nestedForwardCount: number;
  sourceIsThread: boolean;
}) {
  const { formatMessage } = useIntl();
  if (skippedCount === 0) return null;
  return (
    <Banner intent="warning" className="mb-3">
      {nestedForwardCount > 0
        ? formatMessage({ id: "message.forwardComposer.nestedForwardBlocked" })
        : sourceIsThread
          ? formatMessage({ id: "message.forwardComposer.threadOnlyIncluded" })
          : formatMessage({ id: "message.forwardComposer.skippedUnsupported" }, { count: skippedCount })}
    </Banner>
  );
}
