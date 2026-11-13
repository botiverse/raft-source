import { memo, useCallback, useMemo } from "react";
import type { CSSProperties, DragEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardLeading, CardTitle, CardTrailing, Separator } from "@botiverse/raft-ui";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import type { Agent } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import type { ComputersRackView } from "../../store/computersRackViewPreference";
import { useMachineStore } from "../../store/machineStore";
import type { Machine } from "../../store/machineStore";
import { useProfileStore } from "../../store/profileStore";
import { useServerStore } from "../../store/serverStore";
import { canManageMachine } from "../../utils/canManageMachine";
import { computerOsName } from "../../utils/computerDevice";
import { getComputerAvailableVersion } from "../../utils/computerVersionFact";
import { machineDiskLowPresentation } from "../../utils/machineDiskPresentation";
import { formatRelativeTime } from "../../utils/relativeTime";
import { liveDiskStatus, liveMemoryStatus } from "../../components/agentMigration/targetComputerInfo";
import { ComputerActionConfirms } from "../../components/machine/ComputerActionConfirms";
import { ComputerDeviceIcon } from "../../components/machine/ComputerDeviceIcon";
import StatusDot from "../../components/ui/StatusDot";
import { useThisDeviceRowStatus } from "../../components/machine/localComputer/useThisDeviceRowStatus";
import { ThisDeviceBadge } from "../../components/machine/localComputer/ThisDeviceBadge";
import { preloadComputerPanel } from "./machineDetailChunk";
import { ComputerRowStatusDot, ComputerRowVersionFact } from "../../components/machine/ComputerRowVersionFact";
import { MachineRunLabel } from "../../components/machine/MachineRunLabel";
import { useComputerRestart, useComputerUpgradeCard } from "../../components/machine/useComputerUpgradeCard";
import { AgentRackSlot } from "../../components/machine/rack/AgentRackSlot";
import { rackAgentModelGroups, rackOtherRuntimes, rackRuntimeColumns } from "../../components/machine/rack/rackRuntimeColumns";
import type { RackRuntimeColumns, RackUsageResults } from "../../components/machine/rack/rackRuntimeColumns";
import { RackOtherCardLine, RackOtherCell, RackUsageCardLine, RackUsageCell } from "../../components/machine/rack/RackRuntimeUsage";
import { RackSlotStrip } from "../../components/machine/rack/RackSlotStrip";
import type { RackVariant } from "./computersRackTypes";
import { RACK_ABOVE_LINK, RACK_CHILDREN_ABOVE_LINK, RACK_LINK_SURFACE, RACK_GAP_PX, RACK_ACTION_PX, RACK_USAGE_CELL_WIDTH, RACK_IDENTITY_WIDTH, RACK_OTHER_WIDTH, RACK_ACTION_WIDTH, phoneRuntimeGrid, metricsWidthPx } from "./computersRackLayout";
import { CardHeading } from "./CardHeading";
import type { ComputersRackSortKey } from "../../store/computersRackSortPreference";
import { parseRemainingSortKey } from "./computersRackSort";
import { ComputerOwnerLabel } from "./ComputerOwnerLabel";
import { RackResource } from "./RackResource";
import { RackRowAction } from "./RackRowAction";
import { RackRowMenu } from "./RackRowMenu";

// The computer open in the side panel beside the rack: Raft DS › States,
// "Selected: content" (the open item is info-soft), and, selected, it no
// longer answers hover.
const RACK_SELECTED_SURFACE = "relative bg-info-soft";

interface RackRowProps {
  machine: Machine;
  /** The machine Raft Desktop runs on (design §4.1): marked This device. */
  thisDevice?: boolean;
  agents: Agent[];
  variant: RackVariant;
  view: ComputersRackView;
  columns: RackRuntimeColumns;
  canDragAgent: (agent: Agent) => boolean;
  /** An agent is being dragged and this computer can take it (the list's isDropTarget). */
  droppable: boolean;
  /** That drag is over this computer. */
  hovered: boolean;
  onAgentDragStart: (agent: Agent) => void;
  onAgentDragEnd: () => void;
  onRowDragOver: (machineId: string) => void;
  onRowDragLeave: (machineId: string) => void;
  onRowDrop: (machineId: string) => void;
  /** The computer's runtime usage reads (the list reads them all); null for whoever may not see them, or offline. */
  usageResults: RackUsageResults | null;
  /** What the rack is sorted by: a card puts that metric's line first, bold. */
  sortKey?: ComputersRackSortKey | null;
  /** Told when the row's name opened the computer (product analytics, from the list); not its slots, its menu or its next step. */
  onOpened?: (machine: Machine) => void;
}

/**
 * One computer: who and what it is, its agents as slots, its meters and its
 * next step. A row of the list on desktop, a block of the list on a phone,
 * or a card. Memoized: a drag reaches it only as its two booleans, so a drag's
 * start and end render the computers that can take the agent, and a hover the
 * one it enters and the one it leaves.
 */
export const ComputerRackRow = memo(function ComputerRackRow({
  machine,
  thisDevice = false,
  agents,
  variant,
  view,
  columns,
  canDragAgent,
  droppable,
  hovered,
  onAgentDragStart,
  onAgentDragEnd,
  onRowDragOver,
  onRowDragLeave,
  onRowDrop,
  usageResults,
  sortKey = null,
  onOpened,
}: RackRowProps) {
  const sortedProvider = sortKey ? parseRemainingSortKey(sortKey) : null;
  const { formatMessage, locale } = useIntl();
  const nav = useAppNavigate();
  const latestComputerVersion = useMachineStore((s) => s.latestComputerVersion);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const { capabilities } = useServerPermissions();
  const canManage = canManageMachine(machine, currentUserId, capabilities);
  const upgrade = useComputerUpgradeCard(machine);
  // Offered as the row menu offers it (RackRowMenu's canRestart; the hook adds "no restart running").
  const restart = useComputerRestart(machine.id, canManage && machine.isComputer === true && machine.status === "online" && upgrade.cardState.kind !== "upgrading");
  // This device: the local host's answer when Raft Computer is not running
  // here (Stopped, Removed from this device, …), the same as the sidebar row.
  const local = useThisDeviceRowStatus(machine);
  const offline = machine.status !== "online" || local?.notRunning === true;
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const availableVersion = getComputerAvailableVersion(machine, latestComputerVersion);
  const diskLow = machineDiskLowPresentation(machine, formatMessage);
  const lastSeen = offline ? formatRelativeTime(machine.lastHeartbeat, locale) : null;
  // The model groups its agents' models count against (Antigravity's), for the usage cells' model line.
  const modelGroups = useMemo(() => rackAgentModelGroups(agents), [agents]);
  // Desktop: the computer opens in the side panel beside the rack, as a
  // profile does, and its card stays selected (Raft DS › Navigation,
  // "Opening an item"). A phone pushes the computer's page.
  const openProfile = useProfileStore((s) => s.openProfile);
  const selected = useProfileStore((s) => s.profileType === "computer" && s.profileId === machine.id);
  const openComputer = useCallback(() => {
    if (variant === "desktop") openProfile("computer", machine.id);
    else nav.toComputer(machine.id);
    onOpened?.(machine);
  }, [machine, nav, onOpened, openProfile, variant]);
  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!droppable) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    onRowDragOver(machine.id);
  }, [droppable, machine.id, onRowDragOver]);
  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    onRowDragLeave(machine.id);
  }, [machine.id, onRowDragLeave]);
  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!droppable) return;
    event.preventDefault();
    onRowDrop(machine.id);
  }, [droppable, machine.id, onRowDrop]);
  const dropProps = {
    "data-machine-status": machine.status,
    "data-selected": selected ? "" : undefined,
    // The detail's code starts loading before the click.
    onPointerEnter: preloadComputerPanel,
    onFocus: preloadComputerPanel,
    "data-drop-target": droppable ? (hovered ? "active" : "valid") : undefined,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
  };

  const versionText = machine.isComputer === true && machine.computerVersion
    ? formatMessage({ id: "machine.rack.version" }, { version: machine.computerVersion })
    : <MachineRunLabel machine={machine} />;
  const versionFact = (
    <ComputerRowVersionFact
      machine={machine}
      availableVersion={availableVersion}
      arrowClassName="ml-1.5 font-bold text-warning-strong"
      chipClassName="relative z-raised ml-1.5 font-bold text-warning-strong"
    />
  );
  // The card says it on a line of its own; the row after its state
  // ("Offline · last seen 2 hours ago").
  const lastSeenText = lastSeen ? formatMessage({ id: "machine.detail.lastSeen" }, { time: lastSeen }) : null;
  const lastSeenFact = lastSeen ? formatMessage({ id: "machine.rack.lastSeen" }, { time: lastSeen }) : null;
  // The OS only (the cloud provider is on the Computer page): the Linux
  // release, or macOS / Windows, which report none.
  const osName = computerOsName(machine);
  // Online, one line where the OS name gives way first (truncated, whole in
  // its title), so a release's "· v1.0.68 → v1.0.69" stays whole and the line
  // never ends in a bare "macOS ·" (the "·" goes with the version). Only a
  // version too long for the column (a staging build's) is cut, in its turn;
  // the Upgrade button still names the target whole.
  const onlineFacts = (arrowClassName: string, chipClassName: string) => (
    <>
      {osName ? <><span className="min-w-[2ch] shrink-[999] truncate" title={osName}>{osName}</span>{" "}<span className="min-w-0 truncate">· {versionText}</span></> : <span className="min-w-0 truncate">{versionText}</span>}
      {/* The line's gap sets the fact apart; no space, so no trailing one when there is no fact. */}
      <span className="min-w-0 truncate empty:hidden">
        <ComputerRowVersionFact
          machine={machine}
          availableVersion={availableVersion}
          arrowClassName={arrowClassName}
          chipClassName={chipClassName}
        />
      </span>
    </>
  );
  const facts: ReactNode = offline ? (
    <span data-testid={`rack-offline-line-${machine.id}`}>
      {local ? local.label : formatMessage({ id: "machine.detail.offline" })}
      {lastSeenFact ? <> · {lastSeenFact}</> : null}
    </span>
  ) : onlineFacts("font-bold text-warning-strong", "relative z-raised font-bold text-warning-strong");
  // The device shape in the leading slot with the row's light on its corner,
  // as on the sidebar's computer row and the agent avatars.
  const deviceIcon = (
    <span className="relative flex shrink-0 text-foreground-muted" data-testid={`rack-row-icon-${machine.id}`}>
      <ComputerDeviceIcon machine={machine} size={20} />
      {local ? (
        <StatusDot aria-hidden presence={local.presence} className="absolute -right-1 -bottom-1 z-raised" data-testid={`rack-local-dot-${machine.id}`} />
      ) : (
        <ComputerRowStatusDot className="absolute -right-1 -bottom-1 z-raised" machine={machine} availableVersion={availableVersion} />
      )}
    </span>
  );
  // The stretched link: its cover fills the card (with its corners) or the
  // row, with the focus ring inside it: the Card clips anything outside.
  const nameButton = (
    <button
      type="button"
      onClick={openComputer}
      aria-current={selected ? "true" : undefined}
      className={`min-w-0 truncate text-left text-callout font-bold text-foreground outline-none after:absolute after:inset-0 after:content-[''] ${view === "cards"
        ? "after:rounded-container focus-visible:after:inset-ring-2 focus-visible:after:inset-ring-ink"
        : "focus-visible:after:inset-ring-2 focus-visible:after:inset-ring-ink"}`}
      data-testid={`rack-row-name-${machine.id}`}
    >
      {machine.name}
    </button>
  );
  const thisDeviceBadge = thisDevice ? <ThisDeviceBadge className={RACK_ABOVE_LINK} testId={`rack-this-device-${machine.id}`} /> : null;
  const diskLowBadge = diskLow ? (
    <Badge
      appearance="soft"
      variant="warning"
      className={`${RACK_ABOVE_LINK} shrink-0`}
      data-testid={`rack-disk-low-${machine.id}`}
      title={formatMessage({ id: "machine.diskLow.chipTitle" }, { free: diskLow.free, total: diskLow.total })}
    >
      {formatMessage({ id: "machine.diskLow.chip" })}
    </Badge>
  ) : null;
  const identity = (
    <div className="flex min-w-0 items-center gap-2">
      {deviceIcon}
      {nameButton}
      {thisDeviceBadge}
      {/* Desktop shows no per-row count: the slots beside it are the agents
          and the header carries the total. The phone list has no header
          total, so its rows keep the number. */}
      {variant === "phone" ? (
        <span className="shrink-0 font-mono text-mono-meta text-foreground-hint" data-testid={`rack-row-count-${machine.id}`}>{agents.length}</span>
      ) : null}
      {diskLowBadge}
    </div>
  );
  const slotList = agents.map((agent) => (
    <AgentRackSlot
      key={agent.id}
      agent={agent}
      draggable={variant === "desktop" && canDragAgent(agent)}
      dimmed={offline}
      onDragStart={onAgentDragStart}
      onDragEnd={onAgentDragEnd}
    />
  ));
  // With the row's one next step, which every layout draws once: Upgrade's
  // and the menu's Restart's confirmations (portalled, so they add nothing here).
  const action = (
    <>
      <RackRowAction machine={machine} canManage={canManage} variant={variant} upgrade={upgrade} restart={restart} thisDevice={thisDevice} />
      <ComputerActionConfirms name={machine.name} agentCount={agents.length} upgrade={upgrade} restart={restart} />
    </>
  );
  const menu = <RackRowMenu machine={machine} agents={agents} canManage={canManage} upgrade={upgrade} restartState={restart} />;
  const surface = hovered && droppable
    ? "bg-info-soft"
    : selected
      ? ""
      : offline
        ? "bg-fill-subtle"
        : "";
  const linkSurface = selected ? RACK_SELECTED_SURFACE : RACK_LINK_SURFACE;
  const disk = (layout: "cell" | "line", emphasized = false) => (
    <RackResource
      emphasized={emphasized}
      label={formatMessage({ id: "agent.migration.target.disk" })}
      kind="disk"
      status={liveDiskStatus(machine)}
      warn={diskLow !== null}
      testId={`rack-disk-${machine.id}`}
      layout={layout}
    />
  );
  const memory = (layout: "cell" | "line", emphasized = false) => (
    <RackResource
      emphasized={emphasized}
      label={formatMessage({ id: "agent.migration.target.memory" })}
      kind="memory"
      status={liveMemoryStatus(machine)}
      warn={false}
      testId={`rack-memory-${machine.id}`}
      layout={layout}
    />
  );
  const otherRuntimes = rackOtherRuntimes(machine, columns.other);
  // The usage columns and Other, the same cells at the same x on every
  // row: table cells of the desktop list, grid cells of a phone block.
  const runtimeCell = (key: string, width: string, node: ReactNode) => (variant === "desktop"
    ? <div key={key} role="cell" className={`${RACK_ABOVE_LINK} ${width} shrink-0`}>{node}</div>
    : <div key={key} className={`${RACK_ABOVE_LINK} min-w-0`}>{node}</div>);
  const runtimeCells = (
    <>
      {columns.usage.map((column) => runtimeCell(column.provider, RACK_USAGE_CELL_WIDTH, (
        <RackUsageCell machine={machine} column={column} results={usageResults} serverId={serverId} modelGroups={modelGroups} className="w-full" />
      )))}
      {columns.other.length > 0
        ? runtimeCell("other", RACK_OTHER_WIDTH, <RackOtherCell machineId={machine.id} runtimeIds={otherRuntimes} className="max-w-full" />)
        : null}
    </>
  );

  if (view === "cards") {
    // The computer's own columns: a line per usage provider it has, then
    // one Other runtimes line.
    const cardRuntimes = rackRuntimeColumns([machine]);
    // The line the cards are sorted by leads the meters, bold (a usage line
    // only when this computer has that runtime).
    const leadUsage = sortedProvider ? cardRuntimes.usage.find((column) => column.provider === sortedProvider) ?? null : null;
    const leadResource = sortKey === "disk" || sortKey === "memory" ? sortKey : null;
    const usageLine = (column: (typeof cardRuntimes.usage)[number], emphasized: boolean) => (
      <RackUsageCardLine
        key={column.provider}
        machine={machine}
        column={column}
        results={usageResults}
        serverId={serverId}
        modelGroups={modelGroups}
        emphasized={emphasized}
      />
    );
    return (
      <Card
        className={`${linkSurface} h-full transition-colors ${surface}`}
        data-testid={`rack-row-${machine.id}`}
        data-this-device={thisDevice ? "true" : undefined}
        data-layout="card"
        {...dropProps}
      >
        <CardHeader>
          <CardLeading>{deviceIcon}</CardLeading>
          <CardTitle render={<CardHeading />} className="flex min-w-0 items-center gap-2">
            {nameButton}
            {thisDeviceBadge}
            {diskLowBadge}
          </CardTitle>
          <CardTrailing className={RACK_ABOVE_LINK}>{menu}</CardTrailing>
          {/* Under the title and the menu. Online, one line on every card (so
              the sections below line up across cards): the OS name gives way
              (truncated, whole in its title), the version and its upgrade
              never do. Offline cards have no meters to line up; they wrap. */}
          <CardDescription className={`col-span-2 font-mono text-mono-meta text-foreground-hint ${offline ? "" : "flex min-w-0 items-baseline gap-x-[1ch] whitespace-nowrap"}`} data-testid={`rack-row-facts-${machine.id}`}>
            {facts}
          </CardDescription>
          <ComputerOwnerLabel machine={machine} className="col-span-2 min-w-0 truncate text-caption text-foreground-hint" />
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-3">
          {/* Exactly one line on every card, so a card's meters and runtimes
              line up with its neighbours': more agents than fit scroll
              sideways and fade at the edge (the list's strip), and a computer
              with none keeps the line's height (a compact-row avatar, 28px). */}
          {agents.length > 0
            ? <RackSlotStrip testId={`rack-slots-${machine.id}`} hideScrollbar>{slotList}</RackSlotStrip>
            : <div className="h-7" aria-hidden data-testid={`rack-slots-empty-${machine.id}`} />}
          {!offline ? (
            <div
              className={`grid grid-cols-[76px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 ${RACK_CHILDREN_ABOVE_LINK}`}
              data-testid={`rack-card-meters-${machine.id}`}
              data-lead={leadUsage ? leadUsage.provider : leadResource ?? undefined}
            >
              {leadUsage ? (
                <>
                  {usageLine(leadUsage, true)}
                  <Separator className="col-span-3" />
                </>
              ) : null}
              {leadResource === "memory" ? memory("line", true) : null}
              {disk("line", leadResource === "disk")}
              {leadResource === "memory" ? null : memory("line")}
              {cardRuntimes.usage.some((column) => column !== leadUsage) ? <Separator className="col-span-3" /> : null}
              {cardRuntimes.usage.filter((column) => column !== leadUsage).map((column) => usageLine(column, false))}
            </div>
          ) : null}
          {!offline ? <RackOtherCardLine machineId={machine.id} runtimeIds={cardRuntimes.other} /> : null}
          {/* The card's one next step ends its content (Card: a card-level
              action is not a footer note). */}
          <div className={`mt-auto empty:hidden ${offline ? "" : "flex justify-end"} ${RACK_CHILDREN_ABOVE_LINK}`}>{action}</div>
        </CardContent>
      </Card>
    );
  }

  const slots = agents.length > 0 ? <RackSlotStrip testId={`rack-slots-${machine.id}`}>{slotList}</RackSlotStrip> : null;

  if (variant === "phone") {
    // The design's phone block: name line with the version (or Offline) on
    // the right, the slots on one scrolling line below, the runtime cells
    // under the list's header, then the row's one next step. No Disk /
    // Memory and no … menu (the Computer page, one tap away, has both).
    return (
      <div
        className={`${RACK_LINK_SURFACE} border-b border-line-seam px-4 py-3 ${surface}`}
        data-testid={`rack-row-${machine.id}`}
        data-this-device={thisDevice ? "true" : undefined}
        data-machine-status={machine.status}
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">{identity}</div>
          <span className="min-w-0 shrink truncate font-mono text-mono-meta text-foreground-hint" data-testid={`rack-row-version-${machine.id}`}>
            {offline ? (local ? local.label : formatMessage({ id: "machine.detail.offline" })) : <>{versionText}{versionFact}</>}
          </span>
        </div>
        <ComputerOwnerLabel machine={machine} className="mt-1 block truncate text-caption text-foreground-hint" />
        {slots && <div className="mt-2">{slots}</div>}
        {!offline && (columns.usage.length > 0 || columns.other.length > 0) && (
          <div className="mt-2" style={phoneRuntimeGrid(columns)} data-testid={`rack-metrics-${machine.id}`}>{runtimeCells}</div>
        )}
        {offline && lastSeenText && (
          <div className="mt-2 font-mono text-mono-meta text-foreground-hint" data-testid={`rack-offline-line-${machine.id}`}>{lastSeenText}</div>
        )}
        <div className={`mt-2 empty:hidden ${RACK_CHILDREN_ABOVE_LINK}`}>{action}</div>
      </div>
    );
  }

  // An offline row's recovery spans the metrics and the next step's column
  // (and may grow left into its few, dimmed slots), so the … stays aligned.
  const offlineMinWidth = metricsWidthPx(columns) + RACK_GAP_PX + RACK_ACTION_PX;
  const offlineSpan: CSSProperties = { minWidth: offlineMinWidth, maxWidth: Math.max(520, offlineMinWidth) };
  // Disk, Memory, the usage columns, Other, and the next step.
  const offlineColSpan = 2 + columns.usage.length + (columns.other.length > 0 ? 1 : 0) + 1;
  return (
    <div
      role="row"
      className={`${linkSurface} flex min-h-12 items-center gap-3 border-b border-line-hairline px-(--surface-inset) py-1 transition-colors ${surface}`}
      data-testid={`rack-row-${machine.id}`}
      data-this-device={thisDevice ? "true" : undefined}
      {...dropProps}
    >
      {/* An offline row's facts ("Offline · Last seen 14 minutes ago.") may
          run into its few, dimmed slots rather than be cut; online rows keep
          the fixed column. */}
      <div role="cell" className={offline ? "min-w-[252px] max-w-[400px] shrink-0" : `${RACK_IDENTITY_WIDTH} shrink-0`}>
        {identity}
        <div className={`mt-0.5 whitespace-nowrap pl-[28px] font-mono text-mono-meta text-foreground-hint ${offline ? "truncate" : "flex min-w-0 items-baseline gap-x-[1ch]"}`} data-testid={`rack-row-facts-${machine.id}`}>
          {facts}
        </div>
        <ComputerOwnerLabel machine={machine} className="block truncate pl-[28px] text-caption text-foreground-hint" />
      </div>
      <div role="cell" className="min-w-0 flex-1">
        {slots ?? (
          // No agents: a muted "—", as an empty usage cell, and said in words.
          <span className="font-mono text-mono-meta text-foreground-hint" data-testid={`rack-slots-empty-${machine.id}`}>
            <span aria-hidden="true">—</span>
            <span className="sr-only">{formatMessage({ id: "machine.detail.noAgentsAssigned" })}</span>
          </span>
        )}
      </div>
      {offline ? (
        <div role="cell" aria-colspan={offlineColSpan} className={`flex shrink-0 items-center justify-end ${RACK_CHILDREN_ABOVE_LINK}`} style={offlineSpan}>{action}</div>
      ) : (
        <>
          {/* Top-aligned: every cell's first line on one line; a two-line usage cell (its model line) grows the row. */}
          <div className="flex shrink-0 items-start gap-3" data-testid={`rack-metrics-${machine.id}`}>
            {disk("cell")}
            {memory("cell")}
            {columns.usage.length > 0 || columns.other.length > 0 ? <span className="w-px self-stretch" aria-hidden="true" /> : null}
            {runtimeCells}
          </div>
          <div role="cell" className={`flex shrink-0 items-center justify-end ${RACK_ACTION_WIDTH} ${RACK_CHILDREN_ABOVE_LINK}`} data-testid={`rack-action-${machine.id}`}>{action}</div>
        </>
      )}
      <div role="cell" className={`${RACK_ABOVE_LINK} flex shrink-0`}>{menu}</div>
    </div>
  );
});
