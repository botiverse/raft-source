import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { useShallow } from "zustand/react/shallow";
import { SearchX } from "lucide-react";
import { Button } from "@botiverse/raft-ui";
import { isExternalAgentRuntime } from "@botiverse/raft-shared";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import type { Agent } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import type { ComputersRackView } from "../../store/computersRackViewPreference";
import { useComputersRackSort, writeComputersRackSort } from "../../store/computersRackSortPreference";
import type { ComputersRackSort } from "../../store/computersRackSortPreference";
import { useComputersRackFilters } from "../../store/computersRackFilterPreference";
import EmptyState from "../../components/ui/EmptyState";
import { useServerStore } from "../../store/serverStore";
import { openUpgradeDialog } from "../../store/upgradeDialogStore";
import { canViewAgentPrivateSurfaces } from "../../utils/agentVisibility";
import { agentMigrationRequiresUpgrade } from "../../components/agentMigration/billing";
import { useThisDeviceListEntry } from "../../components/machine/localComputer/useThisDeviceListEntry";
import { getLocalComputerBridge, useLocalComputerMachineId } from "../../components/machine/localComputer/localComputerStore";
import { rackRuntimeColumns } from "../../components/machine/rack/rackRuntimeColumns";
import { useThisDeviceRowStatus } from "../../components/machine/localComputer/useThisDeviceRowStatus";
import { sidebarMachineTier } from "../../components/layout/sidebarMachineOrder";
import { useRackRuntimeUsages } from "../../components/machine/rack/RackRuntimeUsage";
import { useMachineStore } from "../../store/machineStore";
import type { Machine } from "../../store/machineStore";
import { RackRowSkeleton } from "../../components/machine/rack/RackRowSkeleton";
import { canViewMachineRuntimeAccountUsage } from "../../utils/machineRuntimeUsageVisibility";
import { computersListSortKey, trackComputersListComputerOpened, trackComputersListControlChanged } from "../../analytics/computersList";
import type { ComputersListComputerOpened, ComputersListControlChanged } from "../../analytics/computersList";
import type { RackVariant } from "./computersRackTypes";
import { listMinWidthPx } from "./computersRackLayout";
import { useOrderedMachines } from "./useOrderedMachines";
import { effectiveRackSort, parseRemainingSortKey, rackSortValue, sortRackMachines } from "./computersRackSort";
import { effectiveRuntimeFilter, filterRackMachines, groupRackMachines, rackSearchMatch, runtimeFilterOptions } from "./computersRackFilter";
import type { RackGroup } from "./computersRackFilter";
import { useAgentsByMachine } from "./useAgentsByMachine";
import { ComputerRackRow } from "./ComputerRackRow";
import { RackListHeader } from "./RackListHeader";
import { RackMoveDialog } from "./RackMoveDialog";
import { RackGroupTitle } from "./RackGroupTitle";
import { ThisDeviceRackRow } from "./ThisDeviceRackRow";
import { useRackPlaceholderCardShapes, useRackPlaceholderRows, useRememberComputersRack, useRememberRackCardShapes } from "./computersRackRemembered";
import type { DrawnRackCard } from "./computersRackRemembered";

const EMPTY_AGENTS: Agent[] = [];
const NO_KEYS: ReadonlySet<string> = new Set();
/** Whose computer, by the list's own tiers (sidebarMachineTier). */
const RELATION_BY_TIER = ["this_device", "own", "other"] as const satisfies readonly ComputersListComputerOpened["relation"][];

/**
 * What the list's product events read at the click (reportChange,
 * reportOpened): the list as its last render drew it. Kept in a ref so those
 * handlers keep one identity: a memoized row takes `onOpened`, and no fold,
 * grouping or filter may render it for the handler's sake.
 */
interface RackEventInputs {
  /** Every computer of the server, before the search and the filters. */
  computerCount: number;
  sort: ComputersRackSort | null;
  collapsed: ReadonlySet<string>;
  /** The search text as the list last applied it. Read at the click, never sent. */
  query: string;
  /** What every opened computer says of the list. */
  listState: Pick<ComputersListComputerOpened, "variant" | "view" | "filtered" | "searched" | "sorted" | "grouped">;
  /** The computers' rows as drawn, top to bottom (folded groups' and the folded Offline section's are not drawn). */
  shown: () => readonly Machine[];
  /** This device's own row leads while it is not one of the server's computers. */
  unattachedThisDevice: boolean;
  localMachineId: string | null;
  currentUserId: string | null | undefined;
}

/** A computer can take a dragged agent: another, online, managed Computer (the move dialog's own rule). */
function isDropTarget(machine: Machine, agent: Agent | null): boolean {
  return Boolean(agent && agent.machineId !== machine.id && machine.isComputer === true && machine.status === "online");
}

/**
 * Every computer as one row (desktop list), one block (phone list) or one
 * card (cards, the person's choice). On desktop an agent slot can be dragged
 * onto another online computer's row or card, which opens the move dialog for
 * that one agent with the computer preselected.
 * The toolbar (ComputersRackToolbar, the phone's sheet) filters, groups and
 * sorts every layout; the desktop list's headings sort too, the same choice
 * (kept in this browser). With no sort chosen (the default, Mine first) the
 * list keeps useOrderedMachines' order: this device, the viewer's own
 * computers, the rest; grouped, the groups holding the viewer's own lead.
 */
export function ComputersRackList({ variant, view }: { variant: RackVariant; view: ComputersRackView }) {
  const { formatMessage, locale } = useIntl();
  const orderedMachines = useOrderedMachines();
  const agentsByMachine = useAgentsByMachine();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const { capabilities } = useServerPermissions();
  const columns = useMemo(() => rackRuntimeColumns(orderedMachines), [orderedMachines]);
  const sortable = variant === "desktop" && view === "list";
  const storedSort = useComputersRackSort();
  const sort = effectiveRackSort(storedSort, columns);
  const filters = useComputersRackFilters(useShallow((s) => ({ query: s.query, status: s.status, runtimes: s.runtimes, groupBy: s.groupBy })));
  const clearFilters = useComputersRackFilters((s) => s.clearFilters);
  // Product analytics (computers_list_control_changed): the controls the list itself holds (its headings, its folds, the
  // empty state's Clear all) say so from their own handlers, with how many computers the server has, before any filter.
  // They read the list from `eventInputs` (filled after each render, below) at the click, so each keeps one identity.
  const eventInputs = useRef<RackEventInputs | null>(null);
  const reportChange = useCallback((change: Omit<ComputersListControlChanged, "variant" | "computer_count">) => {
    const inputs = eventInputs.current;
    if (inputs) trackComputersListControlChanged({ ...change, variant, computer_count: inputs.computerCount });
  }, [variant]);
  const clearFromEmptyState = useCallback(() => {
    clearFilters();
    reportChange({ control: "clear_all", surface: "empty_state" });
  }, [clearFilters, reportChange]);
  // A heading clicked: the sorted column turned round is the direction, any other is a new key (which brings its own first direction).
  const sortFromHeading = useCallback((next: ComputersRackSort) => {
    const sort = eventInputs.current?.sort ?? null;
    writeComputersRackSort(next);
    if (sort?.key !== next.key) {
      const { key: value, runtime } = computersListSortKey(next.key);
      reportChange({ control: "sort_key", value, ...(runtime ? { runtime } : {}), surface: "column_heading" });
    } else if (sort.direction !== next.direction) {
      reportChange({ control: "sort_direction", value: next.direction, surface: "column_heading" });
    }
  }, [reportChange]);
  // The runtime accounts' usage, for whoever may see it (the usage card's
  // rule); an offline computer reads none. Read here, not per row, so a
  // usage column can sort the list.
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const canReadUsage = useCallback(
    (machine: Machine) => machine.status === "online" && canViewMachineRuntimeAccountUsage(machine, currentUserId ?? null, capabilities),
    [capabilities, currentUserId],
  );
  const usageByMachine = useRackRuntimeUsages(orderedMachines, serverId, canReadUsage);
  // Runtime as it applies: only runtimes the computers still have (one chosen
  // earlier whose computers have gone filters nothing).
  const runtimeOptions = useMemo(() => runtimeFilterOptions(columns), [columns]);
  const runtimes = useMemo(() => effectiveRuntimeFilter(filters.runtimes, runtimeOptions), [filters.runtimes, runtimeOptions]);
  const filteredMachines = useMemo(
    () => filterRackMachines(orderedMachines, { query: filters.query, status: filters.status, runtimes }),
    [filters.query, filters.status, orderedMachines, runtimes],
  );
  const machines = useMemo(
    () => (sort ? sortRackMachines(filteredMachines, sort, usageByMachine, locale) : filteredMachines),
    [filteredMachines, locale, sort, usageByMachine],
  );
  // Desktop (Raft Desktop): the computer it runs on is marked "This device"
  // (ThisDeviceBadge) and leads the list (design §4.1), whatever the
  // grouping, the sort and whether it is online: pinned above the groups,
  // with no heading of its own (one computer needs no section). Which
  // machine it is comes from the local identity, as the order of every list
  // of computers does (useOrderedMachines), so the badge and the place never
  // wait on the rest of the host state. The phone has no device of its own.
  const thisDeviceEntry = useThisDeviceListEntry();
  const entry = variant === "desktop" ? thisDeviceEntry : null;
  const localMachineId = useLocalComputerMachineId();
  // Only a shell that can drive this computer (hostCapable) takes over its
  // row's own recovery (the This device page); any other keeps the row as
  // every other computer's, restart command and manual upgrade included.
  const hostCapable = getLocalComputerBridge()?.hostCapable === true;
  const thisDeviceId = variant === "desktop" && hostCapable ? localMachineId : null;
  const thisDeviceMachine = useMemo(
    () => (thisDeviceId ? machines.find((machine) => machine.id === thisDeviceId) ?? null : null),
    [thisDeviceId, machines],
  );
  const grouped = filters.groupBy !== "none";
  const otherMachines = useMemo(
    () => (thisDeviceMachine ? machines.filter((machine) => machine !== thisDeviceMachine) : machines),
    [machines, thisDeviceMachine],
  );
  // Offline computers (most of a real fleet's, often for months, with nothing
  // to read) wait in one folded section at the end, whatever the grouping and
  // the sort; the online ones come first, grouped and sorted as chosen. With
  // Status: Offline they are the list itself, with no section.
  const offlineSection = filters.status !== "offline";
  const onlineMachines = useMemo(
    () => (offlineSection ? otherMachines.filter((machine) => machine.status === "online") : otherMachines),
    [otherMachines, offlineSection],
  );
  const offlineMachines = useMemo(
    () => (offlineSection ? otherMachines.filter((machine) => machine.status !== "online") : []),
    [otherMachines, offlineSection],
  );
  // Folded by default; open by default when nothing else is online, so the
  // page is never empty. A fold or unfold holds for this server and this
  // default: on another server, or once the default changes (a search that
  // leaves only offline computers, then cleared), it starts from the default.
  const offlineDefaultOpen = onlineMachines.length === 0;
  const offlineScope = `${serverId ?? ""}\0${offlineDefaultOpen ? "open" : "folded"}`;
  const [offlineChoice, setOfflineChoice] = useState<{ scope: string; open: boolean } | null>(null);
  const offlineOpen = offlineChoice?.scope === offlineScope ? offlineChoice.open : offlineDefaultOpen;
  const toggleOffline = useCallback(() => {
    setOfflineChoice({ scope: offlineScope, open: !offlineOpen });
    reportChange({ control: "offline_fold", value: offlineOpen ? "folded" : "open", surface: "list" });
  }, [offlineOpen, offlineScope, reportChange]);
  const groups = useMemo(() => {
    const labels = {
      personal: formatMessage({ id: "machine.rack.group.personal" }),
      other: formatMessage({ id: "machine.rack.group.other" }),
    };
    // Under a sort by a number, a group goes by its best member (the first in that order): with
    // Most remaining first, the group with the most left first. With no sort
    // (Mine first), the groups holding this device, then those holding the
    // viewer's own computers (the list's own tiers), then the rest; A to Z
    // within each; under Name, A to Z.
    const ranked = sort && sort.key !== "name" ? sort : null;
    const rankOf = new Map(onlineMachines.map((machine, index) => [machine.id, index]));
    const rank = ranked
      ? (machine: Machine) => (rackSortValue(machine, ranked.key, usageByMachine) === null ? null : rankOf.get(machine.id) ?? null)
      : !sort
        ? (machine: Machine) => {
          const tier = sidebarMachineTier(machine, localMachineId, currentUserId);
          return tier === 2 ? null : tier;
        }
        : null;
    return groupRackMachines(onlineMachines, filters.groupBy, labels, locale, rank);
  }, [currentUserId, filters.groupBy, formatMessage, locale, localMachineId, onlineMachines, sort, usageByMachine]);
  // Folded groups, on this server only (another server's groups start unfolded).
  const [folded, setFolded] = useState<{ serverId: string | null; keys: ReadonlySet<string> }>(() => ({ serverId, keys: NO_KEYS }));
  const collapsed = folded.serverId === serverId ? folded.keys : NO_KEYS;
  const toggleGroup = useCallback((key: string) => {
    setFolded((current) => {
      const next = new Set(current.serverId === serverId ? current.keys : NO_KEYS);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { serverId, keys: next };
    });
    // What the click leaves it as, read from the list as drawn (not inside the updater, which may run twice).
    reportChange({ control: "group_fold", value: eventInputs.current?.collapsed.has(key) ? "open" : "folded", surface: "list" });
  }, [reportChange, serverId]);
  const billing = useServerStore((s) => s.billing);
  const loadBilling = useServerStore((s) => s.loadBilling);
  const [dragAgent, setDragAgent] = useState<Agent | null>(null);
  // The drop reads the dragged agent from here, so its handler (a row's prop) stays the same through the drag.
  const dragAgentRef = useRef<Agent | null>(null);
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);
  const [move, setMove] = useState<{ agent: Agent; targetId: string } | null>(null);
  const machineById = useMemo(() => new Map(machines.map((machine) => [machine.id, machine])), [machines]);

  // The plan decides whether a drop opens the move or the upgrade prompt.
  useEffect(() => {
    void loadBilling();
  }, [loadBilling]);

  // Who may move an agent is who may manage it (the profile's Move section);
  // a move needs its computer online, and a cloud agent has none.
  const canDragAgent = useCallback((agent: Agent) => {
    if (!agent.machineId || agent.deletedAt) return false;
    if (agent.external === true || isExternalAgentRuntime(agent.runtime)) return false;
    if (machineById.get(agent.machineId)?.status !== "online") return false;
    return canViewAgentPrivateSurfaces(agent, currentUserId, capabilities.editAgents);
  }, [capabilities.editAgents, currentUserId, machineById]);
  const handleDragStart = useCallback((agent: Agent) => {
    dragAgentRef.current = agent;
    setDragAgent(agent);
  }, []);
  const handleDragEnd = useCallback(() => {
    dragAgentRef.current = null;
    setDragAgent(null);
    setHoveredRow(null);
  }, []);
  const handleRowDragOver = useCallback((machineId: string) => setHoveredRow(machineId), []);
  const handleRowDragLeave = useCallback((machineId: string) => {
    setHoveredRow((current) => (current === machineId ? null : current));
  }, []);
  const handleRowDrop = useCallback((machineId: string) => {
    const agent = dragAgentRef.current;
    dragAgentRef.current = null;
    setDragAgent(null);
    setHoveredRow(null);
    if (!agent) return;
    // Moving is a Pro feature: on other plans the drop opens the upgrade
    // prompt, as the profile's Move to Another Computer button does.
    if (agentMigrationRequiresUpgrade(billing?.plan)) {
      openUpgradeDialog("agent_migration");
      return;
    }
    setMove({ agent, targetId: machineId });
  }, [billing?.plan]);
  const closeMove = useCallback(() => setMove(null), []);

  // While the computers load, placeholders in their place, as many as the
  // list drew last time on this server (computersRackRemembered), so the
  // computers land where they were. Remembered once loaded, from the list as
  // it opens (no search, filter or fold of the person's), which is how the
  // next load opens it.
  const machinesLoading = useMachineStore((s) => s.loading);
  const machinesLoaded = useMachineStore((s) => s.loadStatus === "loaded" && !s.loading);
  const placeholderRows = useRackPlaceholderRows();
  const placeholderCards = useRackPlaceholderCardShapes();
  const placeholders = machinesLoading && orderedMachines.length === 0
    ? Array.from({ length: placeholderRows }, (_, index) => <RackRowSkeleton key={`placeholder-${index}`} view={view} shape={placeholderCards?.[index]} />)
    : null;
  const opensAsDrawn = filters.status === "all" && runtimes.length === 0 && filters.query.trim() === "" && collapsed.size === 0 && offlineOpen === offlineDefaultOpen;
  const drawnRows = (thisDeviceMachine ? 1 : 0)
    + (grouped ? groups.reduce((sum, group) => sum + group.machines.length, 0) : onlineMachines.length)
    + (offlineOpen ? offlineMachines.length : 0);
  useRememberComputersRack("rows", machinesLoaded && opensAsDrawn ? drawnRows : null);
  // Each drawn card's shape too (usage lines, Other runtimes, offline), so its placeholder is as tall.
  const thisDeviceStatus = useThisDeviceRowStatus(thisDeviceMachine);
  const drawnCardShapes = useMemo(() => {
    if (!machinesLoaded || !opensAsDrawn || view !== "cards") return null;
    const drawn = [
      ...(thisDeviceMachine ? [thisDeviceMachine] : []),
      ...(grouped ? groups.flatMap((group) => group.machines) : onlineMachines),
      ...(offlineOpen ? offlineMachines : []),
    ];
    // As ComputerRackRow draws a card: offline also when this device's own runner is not running; the sorted runtime leads.
    const sortedProvider = sort ? parseRemainingSortKey(sort.key) : null;
    return drawn.map((machine): DrawnRackCard => {
      const runtimes = rackRuntimeColumns([machine]);
      const offline = machine.status !== "online" || (machine === thisDeviceMachine && thisDeviceStatus?.notRunning === true);
      const leadUsage = sortedProvider !== null && runtimes.usage.some((column) => column.provider === sortedProvider);
      return {
        shape: { usageLines: runtimes.usage.length, leadUsage, otherRuntimes: runtimes.other.length > 0, offline },
        machineId: machine.id,
        usageProviders: runtimes.usage.map((column) => column.provider),
      };
    });
  }, [grouped, groups, machinesLoaded, offlineMachines, offlineOpen, onlineMachines, opensAsDrawn, sort, thisDeviceMachine, thisDeviceStatus, view]);
  useRememberRackCardShapes(drawnCardShapes, usageByMachine);

  // Product analytics (computers_list_computer_opened): a row's name opened its computer. Whose it is, its status and
  // what was applied to the list; its place among the rows shown, worked out at the click, in the order drawn below.
  const unattachedThisDevice = entry?.kind === "unattached";
  const reportOpened = useCallback((machine: Machine) => {
    const inputs = eventInputs.current;
    if (!inputs) return;
    const index = inputs.shown().indexOf(machine);
    const match = rackSearchMatch(machine, inputs.query);
    trackComputersListComputerOpened({
      ...inputs.listState,
      // Which of its fields the search found it by: the three answers, never the text.
      ...(match ? { search_matched_name: match.name, search_matched_hostname: match.hostname, search_matched_owner: match.owner } : {}),
      relation: RELATION_BY_TIER[sidebarMachineTier(machine, inputs.localMachineId, inputs.currentUserId)],
      status: machine.status === "online" ? "online" : "offline",
      // This device's own row, while it is not one of the server's computers, is the first row.
      ...(index >= 0 ? { position: index + 1 + (inputs.unattachedThisDevice ? 1 : 0) } : {}),
    });
  }, []);
  const reportThisDeviceOpened = useCallback((status: ComputersListComputerOpened["status"]) => {
    const inputs = eventInputs.current;
    if (inputs) trackComputersListComputerOpened({ ...inputs.listState, relation: "this_device", status, position: 1 });
  }, []);
  // After every render, so a click reads the list it was made on. Not state: nothing draws from it.
  useLayoutEffect(() => {
    eventInputs.current = {
      computerCount: orderedMachines.length,
      sort,
      collapsed,
      query: filters.query,
      listState: {
        variant,
        view,
        filtered: filters.status !== "all" || runtimes.length > 0,
        searched: filters.query.trim() !== "",
        sorted: sort !== null,
        grouped,
      },
      shown: () => [
        ...(thisDeviceMachine ? [thisDeviceMachine] : []),
        ...(grouped ? groups.filter((group) => !collapsed.has(group.key)).flatMap((group) => group.machines) : onlineMachines),
        ...(offlineOpen ? offlineMachines : []),
      ],
      unattachedThisDevice,
      localMachineId,
      currentUserId,
    };
  });

  const rowFor = (machine: Machine) => (
    <ComputerRackRow
      key={machine.id}
      machine={machine}
      thisDevice={machine === thisDeviceMachine}
      agents={agentsByMachine.get(machine.id) ?? EMPTY_AGENTS}
      variant={variant}
      view={view}
      columns={columns}
      canDragAgent={canDragAgent}
      droppable={isDropTarget(machine, dragAgent)}
      hovered={hoveredRow === machine.id}
      onAgentDragStart={handleDragStart}
      onAgentDragEnd={handleDragEnd}
      onRowDragOver={handleRowDragOver}
      onRowDragLeave={handleRowDragLeave}
      onRowDrop={handleRowDrop}
      usageResults={usageByMachine.get(machine.id) ?? null}
      sortKey={sort?.key ?? null}
      onOpened={reportOpened}
    />
  );
  const groupRows = (group: RackGroup): ReactNode => {
    const counts = formatMessage({ id: "machine.rack.computerCount" }, { count: group.machines.length });
    const isCollapsed = collapsed.has(group.key);
    return (
      <Fragment key={group.key}>
        <RackGroupTitle
          view={view}
          testId={`rack-group-${group.key}`}
          counts={counts}
          collapsed={isCollapsed}
          groupKey={group.key}
          onToggle={toggleGroup}
        >
          {group.title}
        </RackGroupTitle>
        {isCollapsed ? null : group.machines.map(rowFor)}
      </Fragment>
    );
  };
  const rows = (
    <>
      {entry?.kind === "unattached" ? <ThisDeviceRackRow key={entry.server.slug} entry={entry} view={view} onOpened={reportThisDeviceOpened} /> : null}
      {thisDeviceMachine ? rowFor(thisDeviceMachine) : null}
      {placeholders ?? (grouped ? groups.map(groupRows) : onlineMachines.map(rowFor))}
    </>
  );
  const offlineRows = offlineMachines.length > 0 ? (
    <>
      <RackGroupTitle
        view={view}
        testId="rack-group-offline"
        counts={formatMessage({ id: "machine.rack.computerCount" }, { count: offlineMachines.length })}
        collapsed={!offlineOpen}
        groupKey="offline"
        onToggle={toggleOffline}
      >
        {formatMessage({ id: "machine.rack.filter.status.offline" })}
      </RackGroupTitle>
      {offlineOpen ? offlineMachines.map(rowFor) : null}
    </>
  ) : null;
  if (orderedMachines.length > 0 && machines.length === 0 && !(entry?.kind === "unattached")) {
    return (
      <div data-testid="computers-rack" data-variant={variant} data-view={view} data-empty="filters">
        <EmptyState
          className="flex flex-col items-center justify-center py-16"
          icon={<SearchX size={36} />}
          title={formatMessage({ id: "machine.rack.noMatchTitle" })}
          description={formatMessage({ id: "machine.rack.noMatchDescription" })}
          action={(
            <Button size="md" variant="outline" onClick={clearFromEmptyState} data-testid="computers-rack-empty-clear">
              {formatMessage({ id: "machine.rack.filter.clearAll" })}
            </Button>
          )}
        />
      </div>
    );
  }
  return (
    <div data-testid="computers-rack" data-variant={variant} data-view={view} data-group-by={filters.groupBy} aria-busy={machinesLoading ? "true" : undefined}>
      {view === "cards" ? (
        // Cards of at least 250px: four a row at 1440 wide, one on a phone.
        <div className={variant === "desktop" ? "grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3 p-5" : "grid grid-cols-1 gap-3"}>
          {rows}
          {offlineRows}
        </div>
      ) : (
        // Desktop: the fixed columns never squeeze; a column narrower than
        // them scrolls the list sideways instead of cutting the … off.
        variant === "desktop" ? (
          <div role="table" aria-label={formatMessage({ id: "machine.mobile.title" })} className="pb-8" style={{ minWidth: listMinWidthPx(columns) }}>
            <RackListHeader variant={variant} columns={columns} sort={sortable ? sort : null} onSort={sortFromHeading} />
            {rows}
            {offlineRows}
          </div>
        ) : (
          <>
            <RackListHeader variant={variant} columns={columns} />
            {rows}
            {offlineRows}
          </>
        )
      )}
      {move && <RackMoveDialog agent={move.agent} targetId={move.targetId} onClose={closeMove} />}
    </div>
  );
}

