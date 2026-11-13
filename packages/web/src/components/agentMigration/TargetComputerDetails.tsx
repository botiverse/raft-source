import { Info } from "lucide-react";
import { useIntl } from "react-intl";
import type { MachineDiskStatus } from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverSeparator,
  PopoverTitle,
  PopoverTrigger,
  ScrollArea,
} from "@botiverse/raft-ui";
import { RuntimeUsageContents } from "../machine/RuntimeUsageSurface";
import type { RuntimeAccountUsageReadResult } from "../../utils/runtimeAccountUsageClient";
import { formatDiskSizeBytes, formatFileSizeBytes } from "../../utils/fileSizePresentation";
import Tooltip from "../ui/Tooltip";
import { formatRelativeTime } from "../../utils/relativeTime";
import { useMachineStore } from "../../store/machineStore";
import type { Machine } from "../../store/machineStore";
import { liveDiskStatus, liveMemoryStatus, offlineDuration, resourceUsedPercent } from "./targetComputerInfo";

interface SizeMessages {
  unknown: MessageId;
  offline: MessageId;
  offlineFor: MessageId;
}

const SIZE_MESSAGES: Record<"memory" | "disk", SizeMessages> = {
  memory: {
    unknown: "agent.migration.target.memoryUnknown",
    offline: "agent.migration.target.memoryOffline",
    offlineFor: "agent.migration.target.memoryOfflineFor",
  },
  disk: {
    unknown: "agent.migration.target.diskUnknown",
    offline: "agent.migration.target.diskOffline",
    offlineFor: "agent.migration.target.diskOfflineFor",
  },
};

function SizeSection({ title, text, testId }: { title: string; text: string; testId: string }) {
  return (
    <div data-testid={testId}>
      <div className="text-callout font-bold text-foreground">{title}</div>
      <div className="mt-0.5 text-footnote text-foreground-muted">{text}</div>
    </div>
  );
}

/** The usage read for one computer, when the viewer may see it. */
export interface TargetComputerUsageDetails {
  /** The runtime's display name ("Claude Code"), for the section's title. */
  runtimeName: string;
  result: RuntimeAccountUsageReadResult | null;
  loading: boolean;
  loadError: boolean;
}

/**
 * The info button beside a target computer's radio row, and what it opens: the
 * same usage card the computer page shows (every window, per-model included),
 * then how many agents it has, its memory and its disk, in the row's order.
 * A Popover, not a hover card, so a tap opens it on a phone.
 * It sits outside the row's <label>: inside, a click would also choose the
 * computer, and a screen reader would read it as part of the radio's name.
 * An offline computer's numbers are old: the usage says when it last
 * reported, and the disk (which the server does not send for it) says how
 * long it has been offline.
 */
export function TargetComputerDetails({
  machine,
  usage,
  agentCount,
}: {
  machine: Pick<Machine, "id" | "name" | "status" | "diskStatus" | "memoryStatus" | "lastHeartbeat">;
  usage: TargetComputerUsageDetails | null;
  /** How many agents live on the computer; null until the agent list has loaded (the section is left out). */
  agentCount: number | null;
}) {
  const { formatMessage, locale } = useIntl();
  const machineId = machine.id;
  const machineName = machine.name;
  const label = formatMessage({ id: "agent.migration.target.details" }, { name: machineName });
  const offline = machine.status === "offline";
  const lastReported = offline && usage?.result && usage.result.snapshot !== null
    ? formatMessage({ id: "agent.migration.target.lastReported" }, {
      time: formatRelativeTime(usage.result.snapshot.collectedAt, locale) ?? formatMessage({ id: "machine.runtimeUsage.recently" }),
    })
    : undefined;
  const offlineObservedAtMs = useMachineStore((state) => state.computerOfflineObservedAt[machine.id] ?? null);
  const offlineFor = offline ? offlineDuration(offlineObservedAtMs, machine.lastHeartbeat, formatMessage) : null;
  // What is used, as the row says it, then free of total, while online; an
  // offline computer has none to show (the server sends neither), so it says
  // how long it has been offline instead.
  // A disk in decimal units (as Finder says it), memory in binary ones.
  const sizeText = (status: MachineDiskStatus | null, messages: SizeMessages, formatSize: typeof formatFileSizeBytes) => status
    ? formatMessage({ id: "agent.migration.target.usedDetail" }, {
      percent: resourceUsedPercent(status),
      free: formatSize(status.availableBytes, formatMessage),
      total: formatSize(status.totalBytes, formatMessage),
    })
    : offline
      ? offlineFor
        ? formatMessage({ id: messages.offlineFor }, { duration: offlineFor })
        : formatMessage({ id: messages.offline })
      : formatMessage({ id: messages.unknown });
  return (
    <Popover>
      <Tooltip content={label}>
        <PopoverTrigger
          render={(
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              aria-label={label}
              data-testid={`agent-migration-target-details-${machineId}`}
            />
          )}
        >
          <Info aria-hidden="true" />
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        side="bottom"
        align="end"
        className="flex w-[300px] max-w-[calc(100vw-2rem)] flex-col p-0"
        data-testid="agent-migration-target-details-popover"
      >
        {/* The popover is the frame (available height, rounded clip); its
            content scrolls in a raft-ui ScrollArea that fills it, named after
            the Computer. Nothing inside takes focus: once it overflows it can be
            the popover's first tab stop (Base UI's opening focus), a named
            region the arrow keys scroll, as the popup itself was before. */}
        <ScrollArea role="region" aria-label={machineName} className="min-h-0 flex-1">
        <PopoverHeader className="pr-4">
          <PopoverTitle className="truncate">{machineName}</PopoverTitle>
        </PopoverHeader>
        {usage ? (
          <>
            <PopoverSeparator />
            <div className="px-4 pt-3 text-footnote font-semibold text-foreground-muted">
              {formatMessage({ id: "machine.runtimeUsage.title" }, { runtime: usage.runtimeName })}
            </div>
            <RuntimeUsageContents result={usage.result} loading={usage.loading} loadError={usage.loadError} metadata={lastReported} />
          </>
        ) : null}
        <PopoverSeparator />
        {/* In the row's order: agents, memory, disk. Here, opened for one row, nothing is cut off. */}
        <div className="grid gap-3 px-4 py-3">
          {agentCount !== null ? (
            <SizeSection
              title={formatMessage({ id: "agent.migration.target.agentsHeading" })}
              text={formatMessage({ id: "agent.migration.target.agents" }, { count: agentCount })}
              testId="agent-migration-target-details-agents"
            />
          ) : null}
          <SizeSection
            title={formatMessage({ id: "agent.migration.target.memory" })}
            text={sizeText(liveMemoryStatus(machine), SIZE_MESSAGES.memory, formatFileSizeBytes)}
            testId="agent-migration-target-details-memory"
          />
          <SizeSection
            title={formatMessage({ id: "agent.migration.target.disk" })}
            text={sizeText(liveDiskStatus(machine), SIZE_MESSAGES.disk, formatDiskSizeBytes)}
            testId="agent-migration-target-details-disk"
          />
        </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
