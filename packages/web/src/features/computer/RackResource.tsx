import { useIntl } from "react-intl";
import type { MachineDiskStatus } from "@botiverse/raft-shared";
import { formatDiskSizeBytes, formatFileSizeBytes } from "../../utils/fileSizePresentation";
import { resourceUsedPercent } from "../../components/agentMigration/targetComputerInfo";
import ProgressBar from "../../components/ui/ProgressBar";
import Tooltip from "../../components/ui/Tooltip";
import { RackCardLine } from "../../components/machine/rack/RackRuntimeUsage";
import { RACK_ABOVE_LINK, RACK_CELL_WIDTH } from "./computersRackLayout";

/**
 * Disk or memory use: "62% used" over the bar, free of total on hover. The
 * bar is a Progress, not a Meter: a disk or memory is not an allowance that
 * resets, the disk warns from the shared low-disk rule (under 10% free, as
 * the low-disk chip) and memory never warns, even when full. Either keeps its
 * colour at 100% (a full disk is not a finished task, so not lime).
 * In the list a 64px cell, named by the column's heading; on a card a line
 * that names itself.
 */
export function RackResource({ label, kind, status, warn, testId, layout, emphasized = false }: {
  label: string;
  /** A disk's sizes are in decimal units (as Finder says them), memory's in binary ones. */
  kind: "disk" | "memory";
  status: MachineDiskStatus | null;
  warn: boolean;
  testId: string;
  layout: "cell" | "line";
  /** A card sorted by this resource: its line first, bold. */
  emphasized?: boolean;
}) {
  const { formatMessage } = useIntl();
  if (!status) {
    if (layout === "cell") return <div role="cell" className={`${RACK_CELL_WIDTH} shrink-0`} />;
    // A card keeps the line ("—", as a runtime with nothing to read shows), so
    // its meters stay in step with the cards beside it.
    return (
      <span className="col-span-3 grid grid-cols-subgrid items-center" data-testid={testId} data-empty="">
        <RackCardLine label={label} bar={null} value="—" emphasized={emphasized} />
      </span>
    );
  }
  const percent = resourceUsedPercent(status);
  const formatSize = kind === "disk" ? formatDiskSizeBytes : formatFileSizeBytes;
  const detail = formatMessage({ id: "agent.migration.target.diskDetail" }, {
    free: formatSize(status.availableBytes, formatMessage),
    total: formatSize(status.totalBytes, formatMessage),
  });
  const value = formatMessage({ id: "machine.rack.percentUsed" }, { percent });
  const bar = <ProgressBar value={percent} tone={warn ? "orange" : "cyan"} holdToneWhenFull aria-label={label} className={layout === "line" ? "w-full" : undefined} />;
  if (layout === "line") {
    return (
      <Tooltip content={detail}>
        <span className={`${RACK_ABOVE_LINK} col-span-3 grid cursor-help grid-cols-subgrid items-center`} data-testid={testId}>
          <RackCardLine label={label} bar={bar} value={value} warn={warn} emphasized={emphasized} />
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={detail}>
      <div role="cell" className={`${RACK_ABOVE_LINK} ${RACK_CELL_WIDTH} shrink-0`} data-testid={testId}>
        <div className={`mb-1 font-mono text-mono-meta whitespace-nowrap ${warn ? "text-warning-strong" : "text-foreground-hint"}`}>{value}</div>
        {bar}
      </div>
    </Tooltip>
  );
}
