import { Meter, MeterIndicator, MeterTrack } from "@botiverse/raft-ui/wip";
import type { RuntimeAccountUsageWindow } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import { formatRelativeTime } from "../../utils/relativeTime";
import { runtimeUsagePercentUsed } from "./bulkChangeModelPlan";

/** Used up by the provider's word or the ratio itself (as the usage card). */
function windowUsedUp(window: RuntimeAccountUsageWindow): boolean {
  return window.status === "limit_reached" || (window.usedRatio ?? 0) >= 1;
}

/** One window: its name on a line, then a thin bar and the share used ("40%"). */
function UsageWindowLine({ window }: { window: RuntimeAccountUsageWindow }) {
  const { formatMessage, locale } = useIntl();
  if (window.status === "parse_unavailable") {
    return (
      <div className="flex flex-col gap-1" data-testid="runtime-usage-window">
        <span className="truncate text-footnote text-foreground">{window.label}</span>
        <span className="text-footnote text-warning-strong">{formatMessage({ id: "machine.runtimeUsage.parseUnavailable" })}</span>
      </div>
    );
  }
  const usedUp = windowUsedUp(window);
  const percent = usedUp ? 100 : runtimeUsagePercentUsed(window.usedRatio ?? 0);
  const reset = window.resetsAt
    ? formatRelativeTime(window.resetsAt, locale) ?? formatMessage({ id: "machine.runtimeUsage.later" })
    : null;
  // The words a screen reader hears, as the usage card says them.
  const valueText = usedUp
    ? reset === null
      ? formatMessage({ id: "machine.runtimeUsage.windowUsedUpResetUnavailable" })
      : formatMessage({ id: "machine.runtimeUsage.windowUsedUp" }, { reset })
    : reset === null
      ? formatMessage({ id: "machine.runtimeUsage.windowUsedResetUnavailable" }, { percent })
      : formatMessage({ id: "machine.runtimeUsage.windowUsed" }, { percent, reset });
  return (
    <div className="flex flex-col gap-1" data-testid="runtime-usage-window" data-usage-full={usedUp ? "true" : undefined}>
      <span className="truncate text-footnote text-foreground">{window.label}</span>
      {/* raft-ui Meter: cyan, orange from 80% used, a full orange bar when used up. */}
      <Meter used={usedUp ? 100 : (window.usedRatio ?? 0) * 100} valueText={valueText} size="sm" className="flex-row items-center gap-2">
        <MeterTrack className="min-w-0 flex-1">
          <MeterIndicator />
        </MeterTrack>
        <span className="shrink-0 font-mono text-mono-meta text-(--meter-value)" aria-hidden="true">
          {formatMessage({ id: "machine.rack.modelPercent" }, { percent })}
        </span>
      </Meter>
    </div>
  );
}

export function RuntimeUsageWindowList({ windows }: { windows: readonly RuntimeAccountUsageWindow[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="runtime-usage-windows">
      {windows.map((window, index) => <UsageWindowLine key={`${window.id}-${index}`} window={window} />)}
    </div>
  );
}
