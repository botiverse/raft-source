import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { useIntl } from "react-intl";
import { useSearchParams } from "react-router-dom";
import { ArrowRight, Bot, Copy, ListFilter as ListFilterIcon, Info, ArrowRightFromLine, ArrowRightToLine, Monitor, EllipsisVertical, Repeat, SearchX, TriangleAlert, User, UserMinus } from "lucide-react";
import {
  Badge, Button, ContextMenu, ContextMenuContent,
  ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger, DescriptionDetails, DescriptionItem, DescriptionList,
  DescriptionTerm, Drawer, DrawerBody, DrawerContent, DrawerHeader, DrawerTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, EmptyStateActions, EmptyStateContent, EmptyStateDescription,
  EmptyStateIcon, EmptyStateTitle, ListRow, ListRowBody, ListRowBottom, ListRowDescription, ListRowGroup, ListRowMeta, ListRowTitle,
  ListRowTop, Popover, PopoverContent, ScrollArea, Skeleton, toast,
} from "@botiverse/raft-ui";
import type { PopoverProps } from "@botiverse/raft-ui";
import { FilterChip, FilterChipLabel, FilterChipRemove } from "@botiverse/raft-ui/wip";
import { isAxiosError } from "axios";
import { currentTimeMs } from "@botiverse/raft-shared";
import type { AgentMigrationLogEntry, AgentMigrationLogResponse } from "@botiverse/raft-shared";
import api from "../../../api/client";
import { useAgentStore } from "../../../store/agentStore";
import { useMachineStore } from "../../../store/machineStore";
import { useAppNavigate } from "../../../hooks/useAppNavigate";
import { useTimeFormatter } from "../../../hooks/useTimeFormatter";
import AvatarSlot from "../../ui/AvatarSlot";
import { dismissLayerProps, notDismissLayerProps } from "../../ui/dismissLayer";
import { MigrationChord, routeKey } from "./MigrationChord";
import type { ChordEvent, ChordTarget, ChordView } from "./MigrationChord";
import {
  CLOUD_NODE, EMPTY_FILTERS, OUTCOME_LABEL, buildNodes, filterEntries, filtersFromSearch, isFiltered, journey, routeCells, searchFromFilters, stats, targetNode,
  initiatedBy,
  withInitiator,
} from "./model";
import type { Initiator, LogFilters, LogNode, NodeId } from "./model";
import { ProfileNameLink } from "./ProfileNameLink";
import { ListFilter, OutcomeFilter, TimeFilter } from "./MigrationLogFilters";
import { FADE_MASK, useCoarsePointer, useIsDesktop, useScrollOverflow, useWindowWidth } from "./viewport";
import { useShortcutLayer } from "../../../features/shortcuts/useShortcutLayer";

type Point = { x: number; y: number };
/** A target shown in the details card, where it was pointed at, and whether the keyboard opened it. */
/** at: where on the chart, unzoomed (the card follows its point through zoom and pan). */
type Anchor = { target: ChordTarget; at: Point; keyboard?: boolean };
const UNZOOMED: ChordView = { k: 1, x: 0, y: 0, moving: false };
type Agents = ReturnType<typeof useAgentStore.getState>["agents"];

const EMPTY_AGENTS: Agents = [];
const DETAILS_CARD_WIDTH = 320;
const DETAILS_CARD_STYLE = { width: DETAILS_CARD_WIDTH };
const HOVER_PORTAL_PROPS = { className: "pointer-events-none" };
type CardOpenChangeDetails = Parameters<NonNullable<PopoverProps["onOpenChange"]>>[1];
const sameTarget = (a: ChordTarget, b: ChordTarget) => JSON.stringify(a) === JSON.stringify(b);

const REASON_LABEL = {
  too_large: "agent.migrationLog.reason.too_large",
  network: "agent.migrationLog.reason.network",
  other: "agent.migrationLog.reason.other",
} as const;

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const durationSec = (e: AgentMigrationLogEntry) => (e.endedAt ? Math.max(0, Math.round((Date.parse(e.endedAt) - Date.parse(e.startedAt)) / 1000)) : null);

/**
 * The server's migration log (owners and admins): every move of an agent
 * between computers as a directed chord diagram, filtered by agent, computer,
 * result and time. Opens from an agent's migration section (that agent
 * selected) and from a computer's page (that computer selected).
 */
export function MigrationLogPage() {
  const drawerTitleId = useId();
  const { formatMessage: t } = useIntl();
  const { formatShortDateTime, formatDuration } = useFormatters();
  const desktop = useIsDesktop();
  const navigate = useAppNavigate();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromSearch(params), [params]);
  // Hover (desktop), the item opened by a tap or click, the item a menu acts on.
  const [hover, setHover] = useState<Anchor | null>(null);
  const [opened, setOpened] = useState<Anchor | null>(null);
  const [menuTarget, setMenuTarget] = useState<ChordTarget | null>(null);
  // The menu opened by press and hold (touch) or the ContextMenu key, at that point on the screen.
  const [actions, setActions] = useState<{ target: ChordTarget; x: number; y: number; keyboard?: boolean } | null>(null);
  const coarse = useCoarsePointer();
  const chartAreaRef = useRef<HTMLDivElement>(null);
  const [hoverAgent, setHoverAgent] = useState<string | null>(null);
  // A new filter closes the details: what they showed may no longer be drawn.
  const setFilters = useCallback((next: LogFilters) => {
    setOpened(null);
    setHover(null);
    setParams(searchFromFilters(next), { replace: true });
  }, [setParams]);

  const agents = useAgentStore((s) => s.agents);
  const machines = useMachineStore((s) => s.machines);
  const [data, setData] = useState<AgentMigrationLogResponse | null>(null);
  // "forbidden": the server only lets owners and admins read the log (routes/agentMigrationLog.ts); retrying won't help.
  const [failed, setFailed] = useState<false | "error" | "forbidden">(false);
  const load = useCallback(async () => {
    setFailed(false);
    try {
      setData((await api.get<AgentMigrationLogResponse>("/agent-migrations/log")).data);
    } catch (err) {
      setFailed(isAxiosError(err) && err.response?.status === 403 ? "forbidden" : "error");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const entries = useMemo(() => data?.migrations ?? [], [data]);
  const nodes = useMemo(() => buildNodes(entries, machines), [entries, machines]);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const shown = useMemo(() => filterEntries(entries, filters, currentTimeMs()), [entries, filters]);
  const allCells = useMemo(() => routeCells(entries), [entries]);
  const cells = useMemo(() => routeCells(shown), [shown]);
  const residents = useMemo(() => {
    const m = new Map<NodeId, number>();
    for (const a of agents) if (a.machineId) m.set(a.machineId, (m.get(a.machineId) ?? 0) + 1);
    return m;
  }, [agents]);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const residentsOf = useMemo(() => {
    const m = new Map<NodeId, Agents>();
    for (const a of agents) if (a.machineId) m.set(a.machineId, [...(m.get(a.machineId) ?? []), a]);
    return m;
  }, [agents]);
  const agentName = useCallback((id: string) => agentById.get(id)?.displayName || agentById.get(id)?.name || id.slice(0, 8), [agentById]);
  // An agent's name, linked to its profile with the profile card on hover; plain text when the agent is no longer on the server.
  const agentLink = useCallback((id: string): ReactNode => {
    const agent = agentById.get(id);
    return agent ? <ProfileNameLink key={id} kind="agent" id={id} fallbackAgent={agent}>{agentName(id)}</ProfileNameLink> : agentName(id);
  }, [agentById, agentName]);
  const avatarOf = useCallback((id: string) => agentById.get(id)?.avatarUrl ?? null, [agentById]);
  const machineIdOf = useCallback((id: string) => agentById.get(id)?.machineId ?? null, [agentById]);
  const nodeName = useCallback((n: LogNode) => (n.id === CLOUD_NODE ? t({ id: "agent.migrationLog.group.cloud" }) : n.name), [t]);

  // What is opened, while it is still drawn: a route that passes the filters, or a computer on one of them.
  const live = useMemo(() => {
    const touched = new Set(cells.flatMap((c) => [c.src, c.dst]));
    const filtered = isFiltered(filters);
    return (target: ChordTarget) => (target.kind === "route"
      ? cells.some((c) => c.src === target.src && c.dst === target.dst)
      : nodeById.has(target.id) && (!filtered || touched.has(target.id)));
  }, [cells, filters, nodeById]);
  const shownOpened = opened && live(opened.target) ? opened : null;
  const shownHover = hover && live(hover.target) ? hover : null;
  const anchor = shownOpened ?? shownHover;
  // An open actions menu (press and hold, Shift+F10) lights what it acts on, as a pinned card does.
  const focus = actions?.target ?? anchor?.target ?? null;
  const highlight = useMemo(() => {
    if (hoverAgent) return new Set(shown.filter((e) => e.agentId === hoverAgent).map((e) => routeKey({ src: e.sourceMachineId, dst: targetNode(e) })));
    if (!focus) return null;
    if (focus.kind === "route") return new Set([routeKey(focus)]);
    return new Set(cells.filter((c) => c.src === focus.id || c.dst === focus.id).map(routeKey));
  }, [focus, hoverAgent, shown, cells]);
  const single = useMemo(() => (filters.agents.length === 1 ? journey(shown, filters.agents[0]) : null), [filters.agents, shown]);
  const numbered = useMemo(() => (single ? single.legs.map((l) => ({ src: l.entry.sourceMachineId, dst: targetNode(l.entry) })) : []), [single]);

  // The chart's zoom, as of the last settled gesture; the card hides while one runs.
  const [view, setView] = useState<ChordView>(UNZOOMED);
  const viewRef = useRef(view);
  viewRef.current = view;
  const onTarget = useCallback((target: ChordTarget | null, e: ChordEvent) => {
    const v = viewRef.current, at = { x: (e.x - v.x) / v.k, y: (e.y - v.y) / v.k };
    if (e.type === "hover") { if (desktop) setHover(target ? { target, at } : null); return; }
    // A right-click opens the ContextMenu around the chart; a touch opens ours on press and hold instead.
    if (e.type === "down" || e.type === "menu") { setMenuTarget(e.pointerType === "touch" ? null : target); return; }
    if (e.type === "actions") { if (target) setActions({ target, x: e.clientX ?? 0, y: e.clientY ?? 0, keyboard: e.keyboard }); return; }
    if (!target) { setOpened(null); return; }
    const next = { target, at, keyboard: e.keyboard };
    if (e.keyboard) { setOpened(next); return; }
    setOpened((cur) => (cur && sameTarget(cur.target, target) ? null : next));
  }, [desktop]);
  // Escape closes the details card (the phone's sheet closes itself). Focus was in the card (its Popover took the
  // key: `fromCard`; the card is portaled, so the chart does not contain it) or on the chart (opened from the
  // keyboard): it goes back to the chart, on the same item, as closing the actions menu does.
  const pinnedFromKeyboard = !!shownOpened?.keyboard;
  const closeCardOnEscape = useCallback((fromCard = false) => {
    const back = fromCard || pinnedFromKeyboard || (chartAreaRef.current?.contains(document.activeElement) ?? false);
    setOpened(null);
    if (back) window.requestAnimationFrame(() => chartAreaRef.current?.querySelector<SVGSVGElement>("svg.migration-chord")?.focus());
  }, [pinnedFromKeyboard]);
  // Esc with focus in the card reaches only its Popover (below); anywhere else this layer on the registry's stack takes it.
  const closeCardOnEscapeFromChart = useCallback(() => closeCardOnEscape(), [closeCardOnEscape]);
  useShortcutLayer("menu", desktop && !!shownOpened, { ignoreDefaultPrevented: true, onEscape: closeCardOnEscapeFromChart });

  // The pinned card's Popover: Esc or a press outside closes it, not one on the chart (the chart's own: it pins another
  // item, or unpins this one), nor focus leaving it. A hover preview goes when the pointer leaves its item.
  const pinned = !!shownOpened;
  const onCardOpenChange = useCallback((next: boolean, details: CardOpenChangeDetails) => {
    if (next) return;
    // A hover preview is always open and closes with the pointer: its Popover must not take Esc from the page.
    if (!pinned) {
      if (details.reason === "escape-key") { details.cancel(); details.allowPropagation(); }
      return;
    }
    if (details.reason === "escape-key") { closeCardOnEscape(true); return; }
    const target = details.event?.target;
    if (details.reason === "outside-press" && !(target instanceof Node && chartAreaRef.current?.contains(target))) setOpened(null);
  }, [pinned, closeCardOnEscape]);

  const actionsFromKeyboard = Boolean(actions?.keyboard);
  const closeActions = useCallback((open: boolean) => {
    if (open) return;
    setActions(null);
    // Opened from the keyboard: focus goes back to the chart, on the same item.
    if (actionsFromKeyboard) window.requestAnimationFrame(() => chartAreaRef.current?.querySelector<SVGSVGElement>("svg.migration-chord")?.focus());
  }, [actionsFromKeyboard]);
  const actionsAnchor = useMemo(() => (actions ? { getBoundingClientRect: () => DOMRect.fromRect({ x: actions.x, y: actions.y, width: 0, height: 0 }) } : null), [actions]);

  const openDetails = useCallback((target: ChordTarget) => setOpened((cur) => ({ target, at: cur && sameTarget(cur.target, target) ? cur.at : { x: 0, y: 0 } })), []);
  const act = useMenuActions({ filters, setFilters, nodeById, nodeName, agentName, open: openDetails, navigate });
  const windowWidth = useWindowWidth();
  const chartSize = desktop ? 640 : Math.min(360, windowWidth - 24);
  const st = stats(shown);
  const labels = useMemo(() => ({
    chart: t({ id: "agent.migrationLog.chart" }),
    computer: (n: LogNode, out: number, inn: number) => t({ id: "agent.migrationLog.chart.computer" }, { code: n.code, name: nodeName(n), out, in: inn }),
    route: (a: LogNode, b: LogNode, c: { ok: number; failed: number }) => t({ id: "agent.migrationLog.chart.route" }, { from: a.code, to: b.code, ok: c.ok, failed: c.failed }),
  }), [t, nodeName]);

  const agentMoves = useMemo(() => agentMoveCounts(entries), [entries]);
  const agentIds = useMemo(() => [...agentMoves.keys()], [agentMoves]);
  const computerIds = useMemo(() => nodes.map((n) => n.id), [nodes]);
  const computerLabel = useCallback((id: string) => {
    const n = nodeById.get(id);
    return n ? t({ id: "agent.migrationLog.fmt.codeName" }, { code: n.code, name: nodeName(n) }) : id;
  }, [nodeById, nodeName, t]);
  const computerShort = useCallback((id: string) => nodeById.get(id)?.code ?? id, [nodeById]);
  const onAgentsChange = useCallback((agents: string[]) => setFilters({ ...filters, agents }), [filters, setFilters]);
  const onComputersChange = useCallback((computers: string[]) => setFilters({ ...filters, computers }), [filters, setFilters]);
  const onOutcomesChange = useCallback((outcomes: LogFilters["outcomes"]) => setFilters({ ...filters, outcomes }), [filters, setFilters]);
  const onDaysChange = useCallback((days: number | null) => setFilters({ ...filters, days }), [filters, setFilters]);
  const clearFilters = useCallback(() => setFilters(EMPTY_FILTERS), [setFilters]);
  const retry = useCallback(() => void load(), [load]);
  const onDrawerOpenChange = useCallback((o: boolean) => { if (!o) setOpened(null); }, []);
  const renderAgentItem = useCallback((id: string) => (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="flex size-5 shrink-0 items-center justify-center"><AvatarSlot context="compact-list" type="agent" agentAvatarUrl={avatarOf(id)} /></span>
      <span className="truncate">{agentName(id)}</span>
      <span className="ml-auto pr-2 font-mono text-mono-meta text-foreground-hint">{agentMoves.get(id) ?? 0}</span>
    </span>
  ), [agentMoves, agentName, avatarOf]);
  const renderComputerItem = useCallback((id: string) => {
    const n = nodeById.get(id);
    return (
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="w-9 shrink-0 font-mono font-bold text-foreground">{n?.code}</span>
        <span className="truncate text-foreground-muted">{n ? nodeName(n) : id}</span>
      </span>
    );
  }, [nodeById, nodeName]);
  const filterRow = useScrollOverflow(!desktop, JSON.stringify(filters));
  // Nothing drawn, though there are moves: canceled ones aren't drawn (only successes and failures are).
  const nothingDrawn = shown.length > 0 && cells.length === 0;
  const skeletonStyle = useMemo(() => ({ width: chartSize, height: chartSize }), [chartSize]);
  const filterMask = FADE_MASK[filterRow.overflow];
  const filterMaskStyle = useMemo(() => ({ maskImage: filterMask, WebkitMaskImage: filterMask }), [filterMask]);
  const filterControls = (
    <>
      <ListFilter
        icon={<Bot aria-hidden />}
        name={t({ id: "agent.migrationLog.filter.agents" })}
        searchLabel={t({ id: "agent.migrationLog.filter.searchAgents" })}
        ids={agentIds}
        labelOf={agentName}
        value={filters.agents}
        onChange={onAgentsChange}
        renderItem={renderAgentItem}
        className="w-[280px]"
        testId="migration-log-filter-agents"
      />
      <ListFilter
        icon={<Monitor aria-hidden />}
        name={t({ id: "agent.migrationLog.filter.computers" })}
        searchLabel={t({ id: "agent.migrationLog.filter.searchComputers" })}
        ids={computerIds}
        labelOf={computerLabel}
        shortLabelOf={computerShort}
        value={filters.computers}
        onChange={onComputersChange}
        renderItem={renderComputerItem}
        className="w-[280px]"
        testId="migration-log-filter-computers"
      />
      {filters.from.map((id) => <DirectionChip key={`from:${id}`} side="from" id={id} filters={filters} setFilters={setFilters} nodeById={nodeById} />)}
      {filters.to.map((id) => <DirectionChip key={`to:${id}`} side="to" id={id} filters={filters} setFilters={setFilters} nodeById={nodeById} />)}
      <OutcomeFilter value={filters.outcomes} onChange={onOutcomesChange} />
      <TimeFilter value={filters.days} onChange={onDaysChange} />
      {isFiltered(filters) ? <Button variant="ghost" size="md" className="shrink-0" onClick={clearFilters}>{t({ id: "agent.migrationLog.filter.clearAll" })}</Button> : null}
    </>
  );

  const details = (target: ChordTarget) => target.kind === "computer"
    ? <ComputerDetails node={nodeById.get(target.id)!} entries={shown} nodeById={nodeById} agentLink={agentLink} residents={residentsOf.get(target.id) ?? EMPTY_AGENTS} formatTime={formatShortDateTime} />
    : <RouteDetails src={nodeById.get(target.src)!} dst={nodeById.get(target.dst)!} entries={shown} agentLink={agentLink} avatarOf={avatarOf} formatTime={formatShortDateTime} formatDuration={formatDuration} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Filters pinned at the top: one row that wraps on desktop and scrolls on a phone, faded on the side that hides filters.
          On a phone the row is a horizontal raft-ui ScrollArea (a small scrollbar only while it scrolls, no tab stop of
          its own: each filter is one), the row and its padding its content. On desktop it wraps and never scrolls. */}
      {desktop ? (
        <div className="flex flex-wrap items-center gap-2 px-(--surface-inset) pt-4" data-testid="migration-log-filters">
          {filterControls}
        </div>
      ) : (
        <ScrollArea
          ref={filterRow.ref}
          orientation="horizontal"
          overscroll="contain"
          size="small"
          trigger="scroll"
          tabIndex={-1}
          className="sticky top-0 z-chrome bg-layer-canvas"
          contentClassName="flex items-center gap-2 px-4 py-2"
          data-overflow={filterRow.overflow}
          style={filterMaskStyle}
          data-testid="migration-log-filters"
        >
          {filterControls}
        </ScrollArea>
      )}

      {/* The log scrolls under its filters in a raft-ui ScrollArea (one element
          at every width, only its padding changes): a region named like the
          page, a tab stop once it overflows. */}
      <ScrollArea
        role="region"
        aria-label={t({ id: "agent.migrationLog.title" })}
        className="flex-1"
        contentClassName={desktop ? "px-(--surface-inset) pb-6" : "px-4 pb-6"}
      >
        <div className={desktop ? "mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-footnote text-foreground-muted" : "mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-footnote text-foreground-muted"} data-testid="migration-log-stats">
          <span>{t({ id: "agent.migrationLog.stats.total" })} <span className="font-mono text-callout font-bold text-foreground">{st.total}</span></span>
          <span>{t({ id: "agent.migrationLog.stats.successRate" })} <span className="font-mono text-callout font-bold text-foreground">{st.successRate == null ? "—" : `${st.successRate}%`}</span></span>
          <span>{t({ id: "agent.migrationLog.stats.agents" })} <span className="font-mono text-callout font-bold text-foreground">{st.agents}</span></span>
          <span>{t({ id: "agent.migrationLog.stats.computers" })} <span className="font-mono text-callout font-bold text-foreground">{st.computers}</span></span>
          {isFiltered(filters) && data ? <span className="text-foreground-hint">{t({ id: "agent.migrationLog.stats.filteredOf" }, { total: entries.length })}</span> : null}
        </div>
        {data?.truncated ? <p className="mt-1 text-caption text-foreground-hint" data-testid="migration-log-truncated">{t({ id: "agent.migrationLog.truncated" })}</p> : null}

        <div className="relative mt-3 border-t border-line-hairline pt-4">
          {failed === "forbidden" ? (
            <EmptyState className="py-16" data-testid="migration-log-not-available">
              <EmptyStateIcon><TriangleAlert aria-hidden /></EmptyStateIcon>
              <EmptyStateContent><EmptyStateTitle>{t({ id: "agent.migrationLog.ownersAndAdminsOnly" })}</EmptyStateTitle></EmptyStateContent>
            </EmptyState>
          ) : failed ? (
            <EmptyState className="py-16">
              <EmptyStateIcon><TriangleAlert aria-hidden /></EmptyStateIcon>
              <EmptyStateContent><EmptyStateTitle>{t({ id: "agent.migrationLog.loadFailed" })}</EmptyStateTitle></EmptyStateContent>
              <EmptyStateActions><Button variant="outline" size="md" onClick={retry}>{t({ id: "agent.migrationLog.retry" })}</Button></EmptyStateActions>
            </EmptyState>
          ) : !data ? (
            <Skeleton className="mx-auto rounded-full" style={skeletonStyle} />
          ) : !entries.length ? (
            <EmptyState className="py-16">
              <EmptyStateIcon><Repeat aria-hidden /></EmptyStateIcon>
              <EmptyStateContent><EmptyStateTitle>{t({ id: "agent.migrationLog.empty.noneTitle" })}</EmptyStateTitle><EmptyStateDescription>{t({ id: "agent.migrationLog.empty.noneBody" })}</EmptyStateDescription></EmptyStateContent>
            </EmptyState>
          ) : !shown.length ? (
            <EmptyState className="py-16">
              <EmptyStateIcon><SearchX aria-hidden /></EmptyStateIcon>
              <EmptyStateContent><EmptyStateTitle>{t({ id: "agent.migrationLog.empty.filteredTitle" })}</EmptyStateTitle><EmptyStateDescription>{t({ id: "agent.migrationLog.empty.filteredBody" })}</EmptyStateDescription></EmptyStateContent>
              <EmptyStateActions><Button variant="outline" size="md" onClick={clearFilters}>{t({ id: "agent.migrationLog.filter.clearAll" })}</Button></EmptyStateActions>
            </EmptyState>
          ) : (
            <div className={desktop ? "grid items-start gap-6" : "stack-y-4"} style={desktop ? { gridTemplateColumns: `${chartSize}px minmax(0, 1fr)` } : undefined}>
              <div ref={chartAreaRef} className="relative flex flex-col items-center">
                {nothingDrawn ? <p className="mb-2 self-stretch text-center text-footnote text-foreground-muted" data-testid="migration-log-canceled-note">{t({ id: "agent.migrationLog.canceledNotDrawn" })}</p> : null}
                {/* Right-click opens the target's menu (DS ContextMenu); off over empty space and for touches, whose press and hold opens the same items below. */}
                <ContextMenu disabled={!menuTarget}>
                  <ContextMenuTrigger render={CHART_TRIGGER}>
                    <MigrationChord
                      size={chartSize}
                      nodes={nodes}
                      allCells={allCells}
                      cells={cells}
                      filtered={isFiltered(filters)}
                      residents={residents}
                      highlight={highlight}
                      numbered={numbered}
                      labels={labels}
                      onTarget={onTarget}
                      onView={setView}
                    />
                  </ContextMenuTrigger>
                  {menuTarget ? (
                    <ContextMenuContent className="w-60">
                      <TargetMenu target={menuTarget} act={act} Item={ContextMenuItem} Label={ContextMenuLabel} Separator={ContextMenuSeparator} />
                    </ContextMenuContent>
                  ) : null}
                </ContextMenu>
                {/* Press and hold, or the ContextMenu key: the same items as right-click and ⋯, at the finger or the item. */}
                <DropdownMenu open={Boolean(actions)} onOpenChange={closeActions}>
                  {actions && actionsAnchor ? (
                    <DropdownMenuContent anchor={actionsAnchor} align="start" side="bottom" className="w-60" data-testid="migration-log-actions-menu">
                      <TargetMenu target={actions.target} act={act} Item={DropdownMenuItem} Label={DropdownMenuLabel} Separator={DropdownMenuSeparator} />
                    </DropdownMenuContent>
                  ) : null}
                </DropdownMenu>
                {desktop && anchor ? (
                  <DetailsCard anchor={anchor} view={view} pinned={Boolean(shownOpened)} chartSize={chartSize} chartArea={chartAreaRef} onOpenChange={onCardOpenChange} title={titleOf(anchor.target, nodeById, nodeName)} act={act}>
                    {details(anchor.target)}
                  </DetailsCard>
                ) : null}
              </div>
              <div className={desktop ? "pt-2" : undefined}>
                <Side
                  filters={filters}
                  shown={shown}
                  single={single}
                  nodeById={nodeById}
                  agentName={agentName}
                  agentLink={agentLink}
                  avatarOf={avatarOf}
                  machineIdOf={machineIdOf}
                  formatTime={formatShortDateTime}
                  hoverAgent={hoverAgent}
                  setHoverAgent={setHoverAgent}
                  touch={coarse}
                  act={act}
                />
              </div>
            </div>
          )}
        </div>

        {entries.length ? <Legend /> : null}
      </ScrollArea>

      {/* A tap on a phone: the details in a bottom sheet; ⋯ opens the same menu as press and hold. */}
      {!desktop ? (
        <Drawer open={Boolean(shownOpened)} onOpenChange={onDrawerOpenChange} swipeDirection="down">
          <DrawerContent>
            {shownOpened ? (
              <>
                <DrawerHeader className="relative">
                  <DrawerTitle id={drawerTitleId}>{titleOf(shownOpened.target, nodeById, nodeName)}</DrawerTitle>
                  <span className="absolute right-3 top-2.5">
                    <TargetMoreMenu target={shownOpened.target} act={act} side="top" />
                  </span>
                </DrawerHeader>
                {/* The body is a raft-ui ScrollArea (DrawerBody's padding on it), the details a column in its content. */}
                <DrawerBody
                  render={<ScrollArea role="region" aria-labelledby={drawerTitleId} contentClassName="flex flex-col" />}
                  className="min-h-0 w-full text-left"
                >
                  {details(shownOpened.target)}
                </DrawerBody>
              </>
            ) : null}
          </DrawerContent>
        </Drawer>
      ) : null}
    </div>
  );
}

function useFormatters() {
  const { formatShortDateTime } = useTimeFormatter();
  const { formatMessage: t } = useIntl();
  const formatDuration = (s: number | null) => (s == null ? "—" : s < 60 ? t({ id: "agent.migrationLog.duration.seconds" }, { s }) : t({ id: "agent.migrationLog.duration.minutes" }, { m: Math.floor(s / 60), s: s % 60 }));
  return { formatShortDateTime, formatDuration };
}

/** Each agent's number of moves, the busiest first (the agent filter's order). */
function agentMoveCounts(entries: AgentMigrationLogEntry[]) {
  const n = new Map<string, number>();
  for (const e of entries) n.set(e.agentId, (n.get(e.agentId) ?? 0) + 1);
  return new Map([...n].sort((a, b) => b[1] - a[1]));
}

const titleOf = (target: ChordTarget, nodeById: Map<NodeId, LogNode>, nodeName: (n: LogNode) => string): ReactNode => target.kind === "computer"
  ? <><span className="font-mono">{nodeById.get(target.id)?.code}</span> <span className="font-normal text-foreground-muted">{nodeName(nodeById.get(target.id)!)}</span></>
  : <span className="font-mono"><FormattedRoute from={nodeById.get(target.src)?.code} to={nodeById.get(target.dst)?.code} /></span>;

type MenuActions = ReturnType<typeof useMenuActions>;

function useMenuActions({ filters, setFilters, nodeById, nodeName, agentName, open, navigate }: {
  filters: LogFilters;
  setFilters: (f: LogFilters) => void;
  nodeById: Map<NodeId, LogNode>;
  nodeName: (n: LogNode) => string;
  agentName: (id: string) => string;
  open: (target: ChordTarget) => void;
  navigate: ReturnType<typeof useAppNavigate>;
}) {
  const { formatMessage: t } = useIntl();
  return useMemo(() => {
    const copy = (text: string) => { void navigator.clipboard?.writeText(text).then(() => toast.success(t({ id: "agent.migrationLog.copied" }))); };
    return {
      t,
      nodeById,
      agentName,
      // Each replaces the computer filters: a computer on either end, or a direction (from / to).
      onlyComputer: (id: NodeId) => setFilters({ ...filters, computers: [id], from: [], to: [] }),
      onlyOut: (id: NodeId) => setFilters({ ...filters, computers: [], from: [id], to: [] }),
      onlyIn: (id: NodeId) => setFilters({ ...filters, computers: [], from: [], to: [id] }),
      onlyRoute: (src: NodeId, dst: NodeId) => setFilters({ ...filters, computers: [], from: [src], to: [dst] }),
      details: open,
      copyComputer: (id: NodeId) => copy(nodeName(nodeById.get(id)!)),
      copyRoute: (src: NodeId, dst: NodeId) => copy(t({ id: "agent.migrationLog.fmt.route" }, { from: nodeById.get(src)?.code, to: nodeById.get(dst)?.code })),
      onlyAgent: (id: string) => setFilters({ ...filters, agents: [id] }),
      removeAgent: (id: string) => setFilters({ ...filters, agents: filters.agents.filter((a) => a !== id) }),
      openProfile: (id: string) => navigate.toAgent(id),
    };
  }, [t, filters, setFilters, nodeById, nodeName, agentName, open, navigate]);
}

const CHART_TRIGGER = <div />;
const ROW_DIV = <div />;

/** Who started a move, linked to their profile with the profile card on hover (a former member stays plain text: model.ts). */
const personLink = (person: Initiator, label: string): ReactNode => (
  <ProfileNameLink key={person.id} kind="user" id={person.id} fallbackLabel={label}>{label}</ProfileNameLink>
);

/** A filter by direction (moves out of, or into, one place), shown so it can be seen and removed. */
function DirectionChip({ side, id, filters, setFilters, nodeById }: {
  side: "from" | "to";
  id: NodeId;
  filters: LogFilters;
  setFilters: (f: LogFilters) => void;
  nodeById: Map<NodeId, LogNode>;
}) {
  const { formatMessage: t } = useIntl();
  const label = t({ id: side === "from" ? "agent.migrationLog.filter.from" : "agent.migrationLog.filter.to" }, { code: nodeById.get(id)?.code ?? "···" });
  const remove = useCallback(() => setFilters({ ...filters, [side]: filters[side].filter((x) => x !== id) }), [filters, setFilters, side, id]);
  // The row's 8px gap plus 8px after the chip: the next control sits 16px
  // away, clear of the × tap area reaching 10px past the chip (raft-ui 0.73
  // FilterChip).
  return (
    <FilterChip className="me-2 shrink-0" data-testid={`migration-log-${side}-chip`}>
      {side === "from" ? <ArrowRightFromLine aria-hidden /> : <ArrowRightToLine aria-hidden />}
      <FilterChipLabel className="font-mono">{label}</FilterChipLabel>
      <FilterChipRemove aria-label={t({ id: "agent.migrationLog.filter.removeFilter" }, { name: label })} onClick={remove} />
    </FilterChip>
  );
}

/** The details card beside the pointer: a hover preview, or pinned by a click with the actions under ⋯. */
function DetailsCard({ anchor, view, pinned, chartSize, chartArea, onOpenChange, title, act, children }: {
  anchor: Anchor;
  view: ChordView;
  pinned: boolean;
  chartSize: number;
  /** The chart's column: the card's point is in its chart's coordinates, and it stays over the chart. */
  chartArea: RefObject<HTMLDivElement | null>;
  onOpenChange: (open: boolean, details: CardOpenChangeDetails) => void;
  title: ReactNode;
  act: MenuActions;
  children: ReactNode;
}) {
  // Beside the pointer, flipped to its left where the card would run off the chart. Through a zoom it
  // stays by its point; it hides while a gesture runs and while its point is panned out of the chart.
  const x = anchor.at.x * view.k + view.x, y = anchor.at.y * view.k + view.y;
  const away = view.moving || x < 0 || y < 0 || x > chartSize || y > chartSize;
  const titleId = useId();
  // raft-ui's Popover places it against that point (a zero-size anchor) and follows the page's scroll (contextElement).
  const point = useMemo(() => {
    const chart = () => chartArea.current?.querySelector("svg.migration-chord") ?? chartArea.current;
    const at = (box?: DOMRect) => DOMRect.fromRect({ x: (box?.left ?? 0) + x, y: (box?.top ?? 0) + y, width: 0, height: 0 });
    return { getBoundingClientRect: () => at(chart()?.getBoundingClientRect()), get contextElement() { return chart() ?? undefined; } };
  }, [chartArea, x, y]);
  return (
    // A hover preview lets the pointer through (its whole portal), so it never covers what it describes, and is inert, so
    // its name links aren't Tab stops while it shows. Pinned, a press outside closes it. Focus stays put (⋯ takes it itself).
    <Popover open onOpenChange={onOpenChange}>
      <PopoverContent
        anchor={point} side="right" align="start" sideOffset={16} alignOffset={-40}
        collisionBoundary={chartArea.current ?? undefined} collisionPadding={0}
        initialFocus={false} finalFocus={false}
        portalProps={pinned ? undefined : HOVER_PORTAL_PROPS}
        aria-labelledby={titleId}
        className={`px-4 py-3 ${away ? "invisible" : ""}`}
        style={DETAILS_CARD_STYLE}
        inert={!pinned}
        data-testid="migration-log-details-card"
        data-pinned={pinned ? "" : undefined}
        {...(pinned ? dismissLayerProps : notDismissLayerProps)}
      >
        {/* The same title on hover and pinned; ⋯ only once pinned (a hover card can't be reached). */}
        <div className={pinned ? "mb-2 flex items-center justify-between gap-2" : "mb-2 flex min-h-8 items-center"}>
          <div id={titleId} className="min-w-0 truncate text-callout font-semibold text-foreground">{title}</div>
          {pinned ? <TargetMoreMenu key={JSON.stringify(anchor.target)} target={anchor.target} act={act} side="bottom" autoFocus={Boolean(anchor.keyboard)} /> : null}
        </div>
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** ⋯ with the same actions as the context menu, for the pinned card and the phone's sheet (and the keyboard). */
function TargetMoreMenu({ target, act, side, autoFocus = false }: { target: ChordTarget; act: MenuActions; side: "top" | "bottom"; autoFocus?: boolean }) {
  const { formatMessage: t } = useIntl();
  // Opened from the keyboard: focus starts here so the actions are one Enter away (the caller keys this per target).
  const trigger = useMemo(() => (
    <Button autoFocus={autoFocus} variant="ghost" size="icon-md" aria-label={t({ id: "agent.migrationLog.menu.more" })} data-testid="migration-log-more"><EllipsisVertical /></Button>
  ), [t, autoFocus]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align="end" side={side} className="w-60">
        <TargetMenu target={target} act={act} Item={DropdownMenuItem} Label={DropdownMenuLabel} Separator={DropdownMenuSeparator} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ItemPart = (props: { onClick?: () => void; children: ReactNode }) => ReactNode;
type PlainPart = (props: { children?: ReactNode }) => ReactNode;

/** One menu, rendered as a ContextMenu (right-click, press and hold) or a DropdownMenu (⋯): same items, same order. */
function TargetMenu({ target, act, Item, Label, Separator }: { target: ChordTarget; act: MenuActions; Item: ItemPart; Label: PlainPart; Separator: PlainPart }) {
  return target.kind === "computer"
    ? <ComputerTargetMenu target={target} act={act} Item={Item} Label={Label} Separator={Separator} />
    : <RouteTargetMenu target={target} act={act} Item={Item} Label={Label} Separator={Separator} />;
}

type MenuParts = { act: MenuActions; Item: ItemPart; Label: PlainPart; Separator: PlainPart };

function ComputerTargetMenu({ target, act, Item, Label, Separator }: MenuParts & { target: Extract<ChordTarget, { kind: "computer" }> }) {
  const { t, nodeById } = act;
  const n = nodeById.get(target.id)!;
  const onlyComputer = useCallback(() => act.onlyComputer(n.id), [act, n.id]);
  const onlyOut = useCallback(() => act.onlyOut(n.id), [act, n.id]);
  const onlyIn = useCallback(() => act.onlyIn(n.id), [act, n.id]);
  const details = useCallback(() => act.details(target), [act, target]);
  const copyName = useCallback(() => act.copyComputer(n.id), [act, n.id]);
  return (<>
    <Label>{n.code}</Label>
    <Item onClick={onlyComputer}><ListFilterIcon />{t({ id: "agent.migrationLog.menu.onlyComputer" })}</Item>
    <Item onClick={onlyOut}><ArrowRightFromLine />{t({ id: "agent.migrationLog.menu.onlyOut" })}</Item>
    <Item onClick={onlyIn}><ArrowRightToLine />{t({ id: "agent.migrationLog.menu.onlyIn" })}</Item>
    <Separator />
    <Item onClick={details}><Info />{t({ id: "agent.migrationLog.menu.details" })}</Item>
    {n.id !== CLOUD_NODE ? <Item onClick={copyName}><Copy />{t({ id: "agent.migrationLog.menu.copyName" })}</Item> : null}
  </>);
}

function RouteTargetMenu({ target, act, Item, Label, Separator }: MenuParts & { target: Extract<ChordTarget, { kind: "route" }> }) {
  const { t, nodeById } = act;
  const a = nodeById.get(target.src)!, b = nodeById.get(target.dst)!;
  const onlyRoute = useCallback(() => act.onlyRoute(a.id, b.id), [act, a.id, b.id]);
  const onlyReverse = useCallback(() => act.onlyRoute(b.id, a.id), [act, a.id, b.id]);
  const details = useCallback(() => act.details(target), [act, target]);
  const copyRoute = useCallback(() => act.copyRoute(a.id, b.id), [act, a.id, b.id]);
  return (<>
    <Label><FormattedRoute from={a.code} to={b.code} /></Label>
    <Item onClick={onlyRoute}><ListFilterIcon />{t({ id: "agent.migrationLog.menu.onlyRoute" })}</Item>
    <Item onClick={onlyReverse}><Repeat />{t({ id: "agent.migrationLog.menu.onlyReverse" }, { route: t({ id: "agent.migrationLog.fmt.route" }, { from: b.code, to: a.code }) })}</Item>
    <Separator />
    <Item onClick={details}><Info />{t({ id: "agent.migrationLog.menu.details" })}</Item>
    <Item onClick={copyRoute}><Copy />{t({ id: "agent.migrationLog.menu.copyRoute" })}</Item>
  </>);
}

function Legend() {
  const { formatMessage: t } = useIntl();
  const sw = (cls: string, style?: React.CSSProperties) => <span className={`inline-block shrink-0 ${cls}`} style={{ width: 14, height: 8, ...style }} aria-hidden />;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 text-footnote text-foreground-muted" data-testid="migration-log-legend">
      <span className="flex items-center gap-1.5"><svg width="30" height="10" aria-hidden><path d="M0,0 L0,10 L22,6 L28,5 L22,4 Z" className="fill-foreground" opacity={0.8} /></svg>{t({ id: "agent.migrationLog.legend.ribbon" })}</span>
      <span className="flex items-center gap-1.5">{sw("bg-foreground")}/{sw("border-[1.5px] border-foreground")}{t({ id: "agent.migrationLog.legend.ring1" })}</span>
      <span className="flex items-center gap-1.5">{sw("bg-success")}{t({ id: "agent.migrationLog.legend.ring2" })}</span>
      <span className="flex items-center gap-1.5"><svg width="14" height="8" aria-hidden><rect width="14" height="8" className="migration-chord-fail" /></svg>{t({ id: "agent.migrationLog.legend.failing" })}</span>
      <span className="flex items-center gap-1.5">{sw("bg-foreground", { opacity: 0.7 })}{t({ id: "agent.migrationLog.legend.ring3" })}</span>
    </div>
  );
}

/** Codes along one agent's path, failed tries marked on the step they belong to. */
function Chain({ single, nodeById }: { single: NonNullable<ReturnType<typeof journey>>; nodeById: Map<NodeId, LogNode> }) {
  const { formatMessage: t } = useIntl();
  const code = (id: NodeId) => nodeById.get(id)?.code ?? "···";
  const failedTries = (xs: AgentMigrationLogEntry[]) => xs.filter((x) => x.outcome === "failed").length;
  const pending = failedTries(single.pending);
  return (
    <span className="flex flex-wrap items-center gap-x-1 gap-y-1 font-mono text-mono-code font-bold text-foreground">
      {single.start ? code(single.start) : null}
      {single.legs.map((l, i) => (
        <span key={i} className="flex items-center gap-1">
          <ArrowRight className="size-3 text-foreground-muted" aria-hidden />
          {failedTries(l.tries) ? <Badge appearance="outline" variant="warning">{t({ id: "agent.migrationLog.chain.failedTries" }, { count: failedTries(l.tries) })}</Badge> : null}
          {code(targetNode(l.entry))}
        </span>
      ))}
      {pending ? <span className="flex items-center gap-1"><ArrowRight className="size-3 text-foreground-muted" aria-hidden /><Badge appearance="outline" variant="warning">{t({ id: "agent.migrationLog.chain.pending" }, { count: pending })}</Badge></span> : null}
    </span>
  );
}

function Side({ filters, shown, single, nodeById, agentName, agentLink, avatarOf, machineIdOf, formatTime, hoverAgent, setHoverAgent, touch, act }: {
  filters: LogFilters;
  shown: AgentMigrationLogEntry[];
  single: ReturnType<typeof journey> | null;
  nodeById: Map<NodeId, LogNode>;
  agentName: (id: string) => string;
  agentLink: (id: string) => ReactNode;
  avatarOf: (id: string) => string | null;
  machineIdOf: (id: string) => string | null;
  formatTime: (iso: string) => string;
  hoverAgent: string | null;
  setHoverAgent: (id: string | null) => void;
  /** A touch screen: a row is tapped, not hovered. */
  touch: boolean;
  act: MenuActions;
}) {
  const { formatMessage: t } = useIntl();
  if (single && filters.agents.length === 1) {
    const id = filters.agents[0], mine = shown.filter((e) => e.agentId === id);
    const now = machineIdOf(id), nowNode = now ? nodeById.get(now) : null;
    const visited = new Set(mine.flatMap((e) => [e.sourceMachineId, targetNode(e)]));
    return (
      <div className="stack-y-3" data-testid="migration-log-agent-summary">
        <div className="flex items-center gap-2">
          <AvatarSlot context="list-row" type="agent" agentAvatarUrl={avatarOf(id)} />
          <div className="min-w-0">
            <div className="text-headline font-semibold text-foreground">{agentLink(id)}</div>
            {nowNode ? <div className="truncate text-caption text-foreground-hint">{t({ id: "agent.migrationLog.side.nowOn" }, { computer: nowNode.name, code: nowNode.code })}</div> : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge appearance="soft" variant="success">{t({ id: "agent.migrationLog.side.arrived" }, { count: single.legs.length })}</Badge>
          <Badge appearance="soft" variant="warning">{t({ id: "agent.migrationLog.side.failed" }, { count: mine.filter((e) => e.outcome === "failed").length })}</Badge>
          <Badge appearance="soft" variant="muted">{t({ id: "agent.migrationLog.side.canceled" }, { count: mine.filter((e) => e.outcome === "canceled").length })}</Badge>
        </div>
        <div><div className="mb-1 text-caption text-foreground-hint">{t({ id: "agent.migrationLog.side.path" })}</div><Chain single={single} nodeById={nodeById} /></div>
        {mine.length ? <div className="text-footnote text-foreground-muted">{t({ id: "agent.migrationLog.side.visited" }, { count: visited.size, time: formatTime(mine[0].startedAt) })}</div> : null}
      </div>
    );
  }
  if (filters.agents.length > 1) {
    return (
      <div className="stack-y-2">
        <div className="text-caption text-foreground-hint">{t({ id: touch ? "agent.migrationLog.side.selectedTouch" : "agent.migrationLog.side.selected" }, { count: filters.agents.length })}</div>
        <ListRowGroup>
          {filters.agents.map((id) => (
            <SelectedAgentRow key={id} id={id} shown={shown} nodeById={nodeById} agentName={agentName} agentLink={agentLink} avatarOf={avatarOf} hoverAgent={hoverAgent} setHoverAgent={setHoverAgent} act={act} />
          ))}
        </ListRowGroup>
      </div>
    );
  }
  if (!isFiltered(filters)) return <p className="text-callout text-foreground-muted">{t({ id: "agent.migrationLog.side.hint" })}</p>;
  const failures = [...shown].reverse().filter((e) => e.outcome === "failed").slice(0, 20);
  const list = failures.length ? failures : [...shown].reverse().slice(0, 20);
  return (
    <div className="stack-y-2">
      {failures.length ? <div className="text-caption text-foreground-hint">{t({ id: "agent.migrationLog.side.failures" })}</div> : null}
      <ListRowGroup>
        {list.map((e) => (
          <ListRow key={e.migrationRef} interactive={false}>
            <AvatarSlot context="list-row" type="agent" agentAvatarUrl={avatarOf(e.agentId)} />
            <ListRowBody>
              <ListRowTop><ListRowTitle>{agentLink(e.agentId)}</ListRowTitle><ListRowMeta>{formatTime(e.startedAt)}</ListRowMeta></ListRowTop>
              <ListRowBottom>
                <ListRowDescription wrap>
                  {withInitiator(t, e.failureKind
                    ? t({ id: "agent.migrationLog.fmt.withReason" }, { route: t({ id: "agent.migrationLog.fmt.route" }, { from: nodeById.get(e.sourceMachineId)?.code, to: nodeById.get(targetNode(e))?.code }), reason: t({ id: REASON_LABEL[e.failureKind] }) })
                    : t({ id: "agent.migrationLog.fmt.route" }, { from: nodeById.get(e.sourceMachineId)?.code, to: nodeById.get(targetNode(e))?.code }), e, personLink)}
                </ListRowDescription>
                {/* Under "Failed moves" every row is a failure, so the tag only shows in mixed lists. */}
                {failures.length ? null : <OutcomeBadge outcome={e.outcome} />}
              </ListRowBottom>
            </ListRowBody>
          </ListRow>
        ))}
      </ListRowGroup>
    </div>
  );
}

function SelectedAgentRow({ id, shown, nodeById, agentName, agentLink, avatarOf, hoverAgent, setHoverAgent, act }: {
  id: string;
  shown: AgentMigrationLogEntry[];
  nodeById: Map<NodeId, LogNode>;
  agentName: (id: string) => string;
  agentLink: (id: string) => ReactNode;
  avatarOf: (id: string) => string | null;
  hoverAgent: string | null;
  setHoverAgent: (id: string | null) => void;
  act: MenuActions;
}) {
  const { formatMessage: t } = useIntl();
  const onPointerEnter = useCallback(() => setHoverAgent(id), [setHoverAgent, id]);
  const onPointerLeave = useCallback(() => setHoverAgent(null), [setHoverAgent]);
  const onClick = useCallback(() => setHoverAgent(hoverAgent === id ? null : id), [setHoverAgent, hoverAgent, id]);
  const onlyAgent = useCallback(() => act.onlyAgent(id), [act, id]);
  const removeAgent = useCallback(() => act.removeAgent(id), [act, id]);
  const openProfile = useCallback(() => act.openProfile(id), [act, id]);
  // The name is a link to the profile, so the row is not a button around it (no link inside a button): the row
  // is a div that a click or tap toggles, and keyboard focus on the name lights the agent's routes as hovering does.
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<ListRow render={ROW_DIV} selected={hoverAgent === id} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} onFocus={onPointerEnter} onBlur={onPointerLeave} onClick={onClick} data-testid={`migration-log-selected-agent-${id}`} />}
      >
        <AvatarSlot context="list-row" type="agent" agentAvatarUrl={avatarOf(id)} />
        <ListRowBody>
          <ListRowTop><ListRowTitle>{agentLink(id)}</ListRowTitle><ListRowMeta>{t({ id: "agent.migrationLog.side.moves" }, { count: shown.filter((e) => e.agentId === id).length })}</ListRowMeta></ListRowTop>
          <ListRowBottom><ListRowDescription wrap><Chain single={journey(shown, id)} nodeById={nodeById} /></ListRowDescription></ListRowBottom>
        </ListRowBody>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuLabel>{agentName(id)}</ContextMenuLabel>
        <ContextMenuItem onClick={onlyAgent}><ListFilterIcon />{t({ id: "agent.migrationLog.menu.onlyAgent" }, { name: agentName(id) })}</ContextMenuItem>
        <ContextMenuItem onClick={removeAgent}><UserMinus />{t({ id: "agent.migrationLog.menu.removeAgent" })}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={openProfile}><User />{t({ id: "agent.migrationLog.menu.openProfile" })}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ComputerDetails({ node, entries, nodeById, agentLink, residents, formatTime }: {
  node: LogNode;
  entries: AgentMigrationLogEntry[];
  nodeById: Map<NodeId, LogNode>;
  agentLink: (id: string) => ReactNode;
  residents: Array<{ id: string; name: string; displayName: string | null; avatarUrl: string | null }>;
  formatTime: (iso: string) => string;
}) {
  const { formatMessage: t } = useIntl();
  const counted = entries.filter((e) => e.outcome === "completed" || e.outcome === "failed");
  const outs = counted.filter((e) => e.sourceMachineId === node.id), ins = counted.filter((e) => targetNode(e) === node.id);
  const top = (xs: AgentMigrationLogEntry[], pick: (e: AgentMigrationLogEntry) => NodeId) => {
    const m = new Map<NodeId, number>(); for (const e of xs) m.set(pick(e), (m.get(pick(e)) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id, n]) => t({ id: "agent.migrationLog.fmt.times" }, { label: nodeById.get(id)?.code ?? "···", count: n })).reduce((acc, x) => (acc ? t({ id: "agent.migrationLog.fmt.listSep" }, { a: acc, b: x }) : x), "") || "—";
  };
  const latest = [...entries].reverse().find((e) => e.sourceMachineId === node.id || targetNode(e) === node.id);
  return (
    <div data-testid="migration-log-computer-details">
      <DescriptionList direction="inline" className="gap-y-1">
        <DescriptionItem><DescriptionTerm>{t({ id: "agent.migrationLog.card.out" })}</DescriptionTerm><DescriptionDetails className="font-mono">{t({ id: "agent.migrationLog.card.outValue" }, { count: outs.length, targets: new Set(outs.map(targetNode)).size })}</DescriptionDetails></DescriptionItem>
        <DescriptionItem><DescriptionTerm>{t({ id: "agent.migrationLog.card.in" })}</DescriptionTerm><DescriptionDetails className="font-mono">{t({ id: "agent.migrationLog.card.inValue" }, { count: ins.length, ok: ins.filter((e) => e.outcome === "completed").length, failed: ins.filter((e) => e.outcome === "failed").length })}</DescriptionDetails></DescriptionItem>
        <DescriptionItem><DescriptionTerm>{t({ id: "agent.migrationLog.card.topTo" })}</DescriptionTerm><DescriptionDetails className="font-mono">{top(outs, targetNode)}</DescriptionDetails></DescriptionItem>
        <DescriptionItem><DescriptionTerm>{t({ id: "agent.migrationLog.card.topFrom" })}</DescriptionTerm><DescriptionDetails className="font-mono">{top(ins, (e) => e.sourceMachineId)}</DescriptionDetails></DescriptionItem>
        {latest ? <DescriptionItem><DescriptionTerm>{t({ id: "agent.migrationLog.card.latest" })}</DescriptionTerm><DescriptionDetails>{/* The card is narrow: the time never splits, and who started the move takes its own line (DescriptionDetails is a wrapping flex row, so each part spans the full row). */}<span className="basis-full">{t({ id: "agent.migrationLog.fmt.whoWhen" }, { who: agentLink(latest.agentId), when: <span className="whitespace-nowrap">{formatTime(latest.startedAt)}</span> })}</span><span className="basis-full">{initiatedBy(t, latest, personLink)}</span></DescriptionDetails></DescriptionItem> : null}
      </DescriptionList>
      {residents.length ? (
        <div className="mt-3 border-t border-line-hairline pt-2">
          <div className="mb-1.5 text-caption text-foreground-hint">{t({ id: "agent.migrationLog.card.residents" }, { count: residents.length })}</div>
          <div className="flex flex-wrap gap-2">{residents.map((a) => <span key={a.id} className="flex items-center gap-1 text-footnote text-foreground"><AvatarSlot context="compact-row" type="agent" agentAvatarUrl={a.avatarUrl} />{agentLink(a.id)}</span>)}</div>
        </div>
      ) : null}
    </div>
  );
}

function RouteDetails({ src, dst, entries, agentLink, avatarOf, formatTime, formatDuration }: {
  src: LogNode;
  dst: LogNode;
  entries: AgentMigrationLogEntry[];
  agentLink: (id: string) => ReactNode;
  avatarOf: (id: string) => string | null;
  formatTime: (iso: string) => string;
  formatDuration: (s: number | null) => string;
}) {
  const { formatMessage: t } = useIntl();
  const fl = entries.filter((e) => e.sourceMachineId === src.id && targetNode(e) === dst.id && (e.outcome === "completed" || e.outcome === "failed"));
  const ok = fl.filter((e) => e.outcome === "completed"), bad = fl.filter((e) => e.outcome === "failed");
  const reasons = new Map<keyof typeof REASON_LABEL, number>(); for (const e of bad) reasons.set(e.failureKind ?? "other", (reasons.get(e.failureKind ?? "other") ?? 0) + 1);
  const agents = [...new Set(fl.map((e) => e.agentId))];
  const ref = useRef(null);
  if (!fl.length) return null;
  return (
    <div ref={ref} data-testid="migration-log-route-details">
      <div className="mb-2 flex flex-wrap gap-2">
        <Badge appearance="soft" variant="success">{t({ id: "agent.migrationLog.card.succeeded" }, { count: ok.length })}</Badge>
        {bad.length ? <Badge appearance="soft" variant="warning"><TriangleAlert aria-hidden />{t({ id: "agent.migrationLog.card.failed" }, { count: bad.length })}</Badge> : null}
      </div>
      <DescriptionList direction="inline" className="gap-y-1">
        <DescriptionItem><DescriptionTerm>{t({ id: "agent.migrationLog.card.medianDuration" })}</DescriptionTerm><DescriptionDetails className="font-mono">{formatDuration(median(ok.map(durationSec).filter((x): x is number => x != null)))}</DescriptionDetails></DescriptionItem>
        <DescriptionItem><DescriptionTerm>{t({ id: "agent.migrationLog.card.firstLatest" })}</DescriptionTerm><DescriptionDetails>{t({ id: "agent.migrationLog.fmt.range" }, { first: formatTime(fl[0].startedAt), latest: formatTime(fl.at(-1)!.startedAt) })}</DescriptionDetails></DescriptionItem>
        {bad.length ? <DescriptionItem><DescriptionTerm>{t({ id: "agent.migrationLog.card.reasons" })}</DescriptionTerm><DescriptionDetails>{[...reasons].map(([k, n]) => t({ id: "agent.migrationLog.fmt.times" }, { label: t({ id: REASON_LABEL[k] }), count: n })).reduce((acc, x) => (acc ? t({ id: "agent.migrationLog.fmt.listSep" }, { a: acc, b: x }) : x), "")}</DescriptionDetails></DescriptionItem> : null}
      </DescriptionList>
      <div className="mt-3 border-t border-line-hairline pt-2">
        <div className="mb-1.5 text-caption text-foreground-hint">{t({ id: "agent.migrationLog.card.agentsOnRoute" })}</div>
        {agents.map((a) => {
          const mine = fl.filter((e) => e.agentId === a);
          return <div key={a} className="flex items-center gap-1.5 py-0.5 text-footnote text-foreground"><AvatarSlot context="compact-row" type="agent" agentAvatarUrl={avatarOf(a)} />{agentLink(a)}<span className="ml-auto font-mono text-foreground-hint">{t({ id: "agent.migrationLog.side.moves" }, { count: mine.length })}</span></div>;
        })}
      </div>
    </div>
  );
}

function FormattedRoute({ from, to }: { from: string | undefined; to: string | undefined }) {
  const { formatMessage: t } = useIntl();
  return <>{t({ id: "agent.migrationLog.fmt.route" }, { from, to })}</>;
}

function OutcomeBadge({ outcome }: { outcome: AgentMigrationLogEntry["outcome"] }) {
  const { formatMessage: t } = useIntl();
  if (outcome === "failed") return <Badge appearance="soft" variant="warning"><TriangleAlert aria-hidden />{t({ id: OUTCOME_LABEL.failed })}</Badge>;
  if (outcome === "canceled") return <Badge appearance="soft" variant="muted">{t({ id: OUTCOME_LABEL.canceled })}</Badge>;
  return null;
}
