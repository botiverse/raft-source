import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ArrowDownUp, CircleDot, Cpu, LayoutGrid, LayoutList, Plus, Rows3, X } from "lucide-react";
import {
  CheckboxIndicator,
  DropdownMenuSeparator,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectItemIndicator,
  SelectItemLeading,
  SelectItemText,
  SelectList,
  SelectSeparator,
  SelectTrigger,
} from "@botiverse/raft-ui";
import { FitToolbar, FitToolbarButton, FitToolbarGroup, FitToolbarPicker, FitToolbarSearch } from "@botiverse/raft-ui/wip";
import { COMPUTERS_RACK_GROUP_BYS, COMPUTERS_RACK_STATUS_FILTERS } from "../../store/computersRackFilterPreference";
import type { ComputersRackGroupBy, ComputersRackRuntimeFilter, ComputersRackStatusFilter } from "../../store/computersRackFilterPreference";
import { writeComputersRackSort } from "../../store/computersRackSortPreference";
import { useComputersRackView, writeComputersRackView } from "../../store/computersRackViewPreference";
import type { ComputersRackView } from "../../store/computersRackViewPreference";
import type { ComputersRackSortDirection } from "../../store/computersRackSortPreference";
import { LIST_TOOLBAR_AIR_CLASS, LIST_TOOLBAR_STEP, LIST_TOOLBAR_MORE_GROUP_CLASS } from "../../components/ui/listToolbar";
import { ListToolbarMore, ListViewSwitch, MoreMenuChoices } from "../../components/ui/ListToolbarParts";
import { computersListSortKey, trackComputersListControlChanged } from "../../analytics/computersList";
import type { ComputersListControlChanged } from "../../analytics/computersList";
import { useMachineStore } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import type { RackVariant } from "./computersRackTypes";
import { useComputersListViewed } from "./useComputersListViewed";
import {
  chooseRackSortKey,
  groupByLabel,
  rackSortChoice,
  runtimeFilterLabel,
  sortDirectionLabel,
  sortKeyLabel,
  sortMenuSections,
  statusFilterLabel,
  useRackToolbarModel,
} from "./computersRackToolbarModel";
import type { RackSortChoice, RackToolbarModel } from "./computersRackToolbarModel";

/**
 * The Computers overview's toolbar, the toolbar over a list (Raft DS ›
 * Patterns › Responsive › The toolbar over a list), on raft-ui's FitToolbar:
 * the search filling the line, the filters Status and Runtime (several),
 * outlined at their default and filled `info-soft` once applied, the applied
 * first, Clear all pinned at their end while the search, Status or Runtime
 * differs from its default (it resets those three and leaves Group and Sort);
 * then Group, Sort (its key and, in their own group, its direction), Cards /
 * List and Add computer, the primary action, last. As the region narrows:
 * Group, Sort and the view switch show their icons, the filters theirs, the
 * filters move to a scrolling second line with their words back (Clear all
 * as ×), Add computer becomes +, Group, Sort and the view fold into ⋯
 * together, and last an empty search becomes its button. A phone gets the
 * same toolbar, narrow (raft-design computers.md › The toolbar).
 */

const DIRECTIONS: readonly ComputersRackSortDirection[] = ["desc", "asc"];
/** Cards / List, the default first (stdrc, 2026-11-05). */
const VIEWS: readonly ComputersRackView[] = ["cards", "list"];
const NAME_DIRECTIONS: readonly ComputersRackSortDirection[] = ["asc", "desc"];

/**
 * Tells product analytics that the person changed a control
 * (`computers_list_control_changed`): each control says what changed and
 * where it is; the toolbar adds the page it is on and how many computers the
 * server has. Called from the controls' own handlers, only for a change.
 */
type ReportChange = (change: Omit<ComputersListControlChanged, "variant" | "computer_count">) => void;
type ChangeSurface = ComputersListControlChanged["surface"];

/** A sort key picked, as the event says it (a runtime's remaining quota: `remaining` and the runtime). */
function sortKeyChange(key: RackSortChoice, surface: ChangeSurface): Parameters<ReportChange>[0] {
  const { key: value, runtime } = computersListSortKey(key);
  return { control: "sort_key", value, ...(runtime ? { runtime } : {}), surface };
}

/** A filter's trigger (Raft DS › Select › Filters): its icon, what it shows, the chevron; filled once applied. */
function FilterTrigger({ testId, name, applied, icon, labelOrder, value, children }: {
  testId: string;
  /** The accessible name, which says the filter and its value. */
  name: string;
  applied: boolean;
  icon: ReactNode;
  labelOrder: number;
  /** A count beside the words (several runtimes), in machine type. */
  value?: number;
  children: ReactNode;
}) {
  return (
    <FitToolbarPicker
      trigger={<SelectTrigger />}
      icon={icon}
      value={value}
      labelOrder={labelOrder}
      aria-label={name}
      data-has-value={applied ? "" : undefined}
      data-active={applied ? "" : undefined}
      data-testid={testId}
    >
      {children}
    </FitToolbarPicker>
  );
}

function RackStatusSelect({ model, report }: { model: RackToolbarModel; report: ReportChange }) {
  const { formatMessage } = useIntl();
  const { filters, setFilters } = model;
  const change = useCallback((next: ComputersRackStatusFilter | null) => {
    if (!next) return;
    setFilters({ status: next });
    if (next !== filters.status) report({ control: "status", value: next, surface: "toolbar" });
  }, [filters.status, report, setFilters]);
  const value = statusFilterLabel(filters.status, formatMessage);
  const name = formatMessage({ id: "machine.rack.filter.applied" }, { filter: formatMessage({ id: "machine.rack.filter.status" }), value });
  return (
    <Select<ComputersRackStatusFilter> value={filters.status} onValueChange={change}>
      <FilterTrigger testId="computers-rack-status" name={name} applied={filters.status !== "all"} icon={<CircleDot />} labelOrder={LIST_TOOLBAR_STEP.filterLabels}>
        {value}
      </FilterTrigger>
      <SelectContent align="start" data-testid="computers-rack-status-list">
        <SelectList>
          {COMPUTERS_RACK_STATUS_FILTERS.map((status) => (
            <SelectItem key={status} value={status} data-testid={`computers-rack-status-${status}`}>
              <SelectItemText>{statusFilterLabel(status, formatMessage)}</SelectItemText>
              <SelectItemIndicator />
            </SelectItem>
          ))}
        </SelectList>
      </SelectContent>
    </Select>
  );
}

function RackRuntimeSelect({ model, report }: { model: RackToolbarModel; report: ReportChange }) {
  const { formatMessage } = useIntl();
  const { filters, setFilters } = model;
  // Picking prunes any runtime chosen earlier that is no longer offered. The runtimes chosen that the computers still have (the model's filters), in the list's order.
  const options = model.runtimeOptions;
  const chosen = useMemo(() => options.filter((runtime) => filters.runtimes.includes(runtime)), [filters.runtimes, options]);
  const change = useCallback((next: ComputersRackRuntimeFilter[] | null, details: { reason: string }) => {
    const picked = next ?? [];
    setFilters({ runtimes: picked });
    // Only a pick is the person's: the Select also drops the values of items that leave the list (a runtime whose computers have gone).
    if (details.reason !== "item-press") return;
    // Against what the Select showed (`chosen`), so a runtime pruned along the way is not counted as taken out.
    for (const runtime of picked) if (!chosen.includes(runtime)) report({ control: "runtime", runtime, runtime_selected: true, surface: "toolbar" });
    for (const runtime of chosen) if (!picked.includes(runtime)) report({ control: "runtime", runtime, runtime_selected: false, surface: "toolbar" });
  }, [chosen, report, setFilters]);
  const filterName = formatMessage({ id: "machine.rack.filter.runtime" });
  const names = chosen.map((runtime) => runtimeFilterLabel(runtime, formatMessage));
  const name = chosen.length > 0 ? formatMessage({ id: "machine.rack.filter.applied" }, { filter: filterName, value: names.join(", ") }) : filterName;
  // Its runtimes come with the computers: while they load it holds its place, disabled, so the search beside it
  // does not narrow when they arrive; with no runtime to offer once loaded, it goes.
  const machinesLoading = useMachineStore((s) => s.loading);
  if (options.length === 0 && !machinesLoading) return null;
  return (
    <Select<ComputersRackRuntimeFilter, true> multiple value={chosen} onValueChange={change} disabled={options.length === 0}>
      {/* One runtime says its name; several, the filter's name and how many (Raft DS › Tasks › Filters). */}
      <FilterTrigger
        testId="computers-rack-runtime"
        name={name}
        applied={chosen.length > 0}
        icon={<Cpu />}
        labelOrder={LIST_TOOLBAR_STEP.filterLabels}
        value={chosen.length > 1 ? chosen.length : undefined}
      >
        {chosen.length === 1 ? names[0] : filterName}
      </FilterTrigger>
      <SelectContent align="start" data-testid="computers-rack-runtime-list">
        <SelectList>
          {options.map((runtime) => (
            <SelectItem key={runtime} value={runtime} data-testid={`computers-rack-runtime-${runtime}`}>
              <SelectItemLeading>
                <CheckboxIndicator checked={chosen.includes(runtime)} />
              </SelectItemLeading>
              <SelectItemText>{runtimeFilterLabel(runtime, formatMessage)}</SelectItemText>
            </SelectItem>
          ))}
        </SelectList>
      </SelectContent>
    </Select>
  );
}

function RackGroupSelect({ model, report }: { model: RackToolbarModel; report: ReportChange }) {
  const { formatMessage } = useIntl();
  const { filters, setFilters } = model;
  const change = useCallback((next: ComputersRackGroupBy | null) => {
    if (!next) return;
    setFilters({ groupBy: next });
    if (next !== filters.groupBy) report({ control: "group", value: next, surface: "toolbar" });
  }, [filters.groupBy, report, setFilters]);
  const grouped = filters.groupBy !== "none";
  const label = grouped
    ? formatMessage({ id: "machine.rack.group.button" }, { group: groupByLabel(filters.groupBy, formatMessage) })
    : formatMessage({ id: "machine.rack.group.label" });
  return (
    <Select<ComputersRackGroupBy> value={filters.groupBy} onValueChange={change}>
      <FilterTrigger testId="computers-rack-group" name={label} applied={grouped} icon={<Rows3 />} labelOrder={LIST_TOOLBAR_STEP.displayLabels}>
        {label}
      </FilterTrigger>
      <SelectContent align="end" data-testid="computers-rack-group-list">
        <SelectList>
          {COMPUTERS_RACK_GROUP_BYS.map((groupBy) => (
            <SelectItem key={groupBy} value={groupBy} data-testid={`computers-rack-group-${groupBy}`}>
              <SelectItemText>{groupByLabel(groupBy, formatMessage)}</SelectItemText>
              <SelectItemIndicator />
            </SelectItem>
          ))}
        </SelectList>
      </SelectContent>
    </Select>
  );
}

/**
 * The Sort holds two choices in one list, each checked in its own group: the
 * key (`key:<key>`) and the direction (`dir:<direction>`). A new key starts
 * at its own first direction; picking a direction keeps the key; the list
 * stays open, as a list with several values does. The default, Mine first
 * (`key:default`), is no sort and has no direction. Filled once a sort is
 * chosen.
 */
type SortItem = `key:${RackSortChoice}` | `dir:${ComputersRackSortDirection}`;

function RackSortSelect({ model, report }: { model: RackToolbarModel; report: ReportChange }) {
  const { formatMessage } = useIntl();
  const { sort, columns } = model;
  const sections = useMemo(() => sortMenuSections(columns), [columns]);
  const value = useMemo<SortItem[]>(() => (sort ? [`key:${sort.key}`, `dir:${sort.direction}`] : ["key:default"]), [sort]);
  const change = useCallback((next: SortItem[] | null, details: { reason: string }) => {
    // Only a pick counts: the Select also drops the values of items that leave
    // the list (the directions, once Mine first is picked), from the value it
    // last rendered, which would bring the old key back.
    if (details.reason !== "item-press") return;
    // The item just picked is the one not in the current value (a checked one picked again changes nothing).
    const picked = (next ?? []).find((item) => !value.includes(item));
    if (!picked) return;
    if (picked.startsWith("key:")) {
      // One of the list's own keys, found by its item (no cast from the item's text).
      const key = sections.flat().find((candidate) => `key:${candidate}` === picked);
      if (!key) return;
      writeComputersRackSort(chooseRackSortKey(key));
      report(sortKeyChange(key, "toolbar"));
    } else {
      const direction = DIRECTIONS.find((candidate) => `dir:${candidate}` === picked);
      if (!direction || !sort) return;
      writeComputersRackSort({ key: sort.key, direction });
      report({ control: "sort_direction", value: direction, surface: "toolbar" });
    }
  }, [report, sections, sort, value]);
  const label = formatMessage({ id: "machine.rack.sort.label" }, { sort: sortKeyLabel(rackSortChoice(sort), formatMessage) });
  const name = sort ? `${label}, ${sortDirectionLabel(sort.key, sort.direction, formatMessage)}` : label;
  return (
    <Select<SortItem, true> multiple value={value} onValueChange={change}>
      <FilterTrigger testId="computers-rack-sort" name={name} applied={sort !== null} icon={<ArrowDownUp />} labelOrder={LIST_TOOLBAR_STEP.displayLabels}>
        {label}
      </FilterTrigger>
      <SelectContent align="end" data-testid="computers-rack-sort-list">
        {/* Two groups in one list: taller than a Select's usual 16rem, as the window allows, so the direction shows. */}
        <SelectList className="max-h-[min(34rem,calc(var(--available-height)-0.5rem))]">
          {sections.map((keys, index) => (
            <SelectGroup key={keys[0]}>
              {index > 0 ? <SelectSeparator /> : null}
              {keys.map((key) => (
                <SelectItem key={key} value={`key:${key}`} data-testid={`computers-rack-sort-${key}`}>
                  <SelectItemText>{sortKeyLabel(key, formatMessage)}</SelectItemText>
                  <SelectItemIndicator />
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
          {sort ? (
            <SelectGroup>
              <SelectSeparator />
              {(sort.key === "name" ? NAME_DIRECTIONS : DIRECTIONS).map((direction) => (
                <SelectItem key={direction} value={`dir:${direction}`} data-testid={`computers-rack-sort-direction-${direction}`}>
                  <SelectItemText>{sortDirectionLabel(sort.key, direction, formatMessage)}</SelectItemText>
                  <SelectItemIndicator />
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
        </SelectList>
      </SelectContent>
    </Select>
  );
}

/** Clear all, while the search, Status or Runtime differs from its default: words, or × once the filters give way. */
function ClearAll({ model, report }: { model: RackToolbarModel; report: ReportChange }) {
  const { formatMessage } = useIntl();
  const { clearFilters } = model;
  const clear = useCallback(() => {
    clearFilters();
    report({ control: "clear_all", surface: "toolbar" });
  }, [clearFilters, report]);
  if (!model.filtered) return null;
  return (
    <FitToolbarButton variant="ghost" collapsedIcon={<X />} labelOrder={LIST_TOOLBAR_STEP.filterLabels} onClick={clear} data-testid="computers-rack-clear">
      {formatMessage({ id: "machine.rack.filter.clearAll" })}
    </FitToolbarButton>
  );
}

/** Group, Sort and the view as they are in ⋯ once they fold into it (step 6): the grouping, the sort key, its direction and the view. */
function RackDisplayMenu({ model, report }: { model: RackToolbarModel; report: ReportChange }) {
  const { formatMessage } = useIntl();
  const { filters, setFilters, sort, columns } = model;
  const groupOptions = useMemo(() => COMPUTERS_RACK_GROUP_BYS.map((value) => ({ value, label: groupByLabel(value, formatMessage) })), [formatMessage]);
  const keyOptions = useMemo(() => sortMenuSections(columns).flat().map((value) => ({ value, label: sortKeyLabel(value, formatMessage) })), [columns, formatMessage]);
  const sortKey = sort?.key ?? null;
  const directionOptions = useMemo(
    () => (sortKey ? (sortKey === "name" ? NAME_DIRECTIONS : DIRECTIONS).map((value) => ({ value, label: sortDirectionLabel(sortKey, value, formatMessage) })) : []),
    [formatMessage, sortKey],
  );
  const group = useCallback((groupBy: ComputersRackGroupBy) => {
    setFilters({ groupBy });
    if (groupBy !== filters.groupBy) report({ control: "group", value: groupBy, surface: "more_menu" });
  }, [filters.groupBy, report, setFilters]);
  const chosenKey = rackSortChoice(sort);
  const chooseKey = useCallback((key: RackSortChoice) => {
    writeComputersRackSort(chooseRackSortKey(key));
    if (key !== chosenKey) report(sortKeyChange(key, "more_menu"));
  }, [chosenKey, report]);
  const sortDirection = sort?.direction ?? null;
  const chooseDirection = useCallback((direction: ComputersRackSortDirection) => {
    if (!sortKey) return;
    writeComputersRackSort({ key: sortKey, direction });
    if (direction !== sortDirection) report({ control: "sort_direction", value: direction, surface: "more_menu" });
  }, [report, sortDirection, sortKey]);
  const view = useComputersRackView();
  const chooseView = useCallback((next: ComputersRackView) => {
    writeComputersRackView(next);
    if (next !== view) report({ control: "view", value: next, surface: "more_menu" });
  }, [report, view]);
  const viewOptions = useMemo(() => VIEWS.map((value) => ({ value, label: formatMessage({ id: value === "cards" ? "machine.rack.viewCards" : "machine.rack.viewList" }) })), [formatMessage]);
  return (
    <>
      <MoreMenuChoices heading={formatMessage({ id: "ui.listToolbar.group" })} value={filters.groupBy} options={groupOptions} onValueChange={group} testId="computers-rack-more-group" />
      <DropdownMenuSeparator />
      <MoreMenuChoices heading={formatMessage({ id: "ui.listToolbar.sort" })} value={rackSortChoice(sort)} options={keyOptions} onValueChange={chooseKey} testId="computers-rack-more-sort" />
      {sort ? (
        <>
          <DropdownMenuSeparator />
          <MoreMenuChoices heading={null} label={formatMessage({ id: "ui.listToolbar.order" })} value={sort.direction} options={directionOptions} onValueChange={chooseDirection} testId="computers-rack-more-direction" />
        </>
      ) : null}
      <DropdownMenuSeparator />
      <MoreMenuChoices heading={formatMessage({ id: "ui.listToolbar.view" })} value={view} options={viewOptions} onValueChange={chooseView} testId="computers-rack-more-view" />
    </>
  );
}

/** Cards / List (the choice kept in this browser, computersRackViewPreference): its icons alone from the first step. */
function RackViewSwitch({ report }: { report: ReportChange }) {
  const { formatMessage } = useIntl();
  const view = useComputersRackView();
  const chooseView = useCallback((next: ComputersRackView) => {
    writeComputersRackView(next);
    if (next !== view) report({ control: "view", value: next, surface: "toolbar" });
  }, [report, view]);
  const options = useMemo(() => [
    { value: "cards" as const, label: formatMessage({ id: "machine.rack.viewCards" }), icon: <LayoutGrid size={16} aria-hidden="true" />, testId: "computers-rack-view-cards" },
    { value: "list" as const, label: formatMessage({ id: "machine.rack.viewList" }), icon: <LayoutList size={16} aria-hidden="true" />, testId: "computers-rack-view-list" },
  ], [formatMessage]);
  return <ListViewSwitch value={view} options={options} onValueChange={chooseView} label={formatMessage({ id: "machine.rack.viewAria" })} testId="computers-rack-view" />;
}

/**
 * The toolbar under the Computers header; a phone's is the same toolbar.
 * `onAdd` is Add computer, given where the person may register computers.
 */
export function ComputersRackToolbar({ variant = "desktop", onAdd, onMountedChange }: {
  variant?: RackVariant;
  onAdd?: () => void;
  /** Told when it is on screen and when it leaves (the phone keeps its add row until then: its code loads apart). */
  onMountedChange?: (mounted: boolean) => void;
}) {
  const { formatMessage } = useIntl();
  useLayoutEffect(() => {
    onMountedChange?.(true);
    return () => onMountedChange?.(false);
  }, [onMountedChange]);
  // The toolbar is on screen as long as the page is: it says what the page stood at when its list showed (product analytics).
  useComputersListViewed(variant);
  const model = useRackToolbarModel();
  const { filters, setFilters } = model;
  const { computerCount } = model;
  const report = useCallback<ReportChange>(
    (change) => trackComputersListControlChanged({ ...change, variant, computer_count: computerCount }),
    [computerCount, variant],
  );
  // The search counts once per page and server: the first time it goes from empty to something (never what, nor how
  // long). A search already standing when the page opened is the snapshot's `searched`; editing it is not a beginning.
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const searchReportedFor = useRef<string | null>(null);
  const search = useCallback((query: string) => {
    setFilters({ query });
    if (!serverId || searchReportedFor.current === serverId || filters.query.trim() !== "" || query.trim() === "") return;
    searchReportedFor.current = serverId;
    report({ control: "search", surface: "toolbar" });
  }, [filters.query, report, serverId, setFilters]);
  const statusApplied = filters.status !== "all";
  const runtimeApplied = model.runtimeOptions.some((runtime) => filters.runtimes.includes(runtime));
  const filterItems = [
    { key: "status", applied: statusApplied, node: <RackStatusSelect key="status" model={model} report={report} /> },
    { key: "runtime", applied: runtimeApplied, node: <RackRuntimeSelect key="runtime" model={model} report={report} /> },
  ];
  // The applied filters first, so they are in view before any scrolling.
  const orderedFilters = [...filterItems.filter((item) => item.applied), ...filterItems.filter((item) => !item.applied)];
  return (
    <div
      className={`shrink-0 ${variant === "phone" ? "px-4" : "px-(--surface-inset)"} ${LIST_TOOLBAR_AIR_CLASS}`}
      data-testid="computers-rack-toolbar"
      data-variant={variant}
    >
      <FitToolbar aria-label={formatMessage({ id: "machine.mobile.title" })} wrap className="gap-2">
        <FitToolbarSearch
          value={filters.query}
          onValueChange={search}
          collapseOrder={LIST_TOOLBAR_STEP.searchButton}
          placeholder={formatMessage({ id: "machine.rack.search.placeholder" })}
          aria-label={formatMessage({ id: "machine.rack.search.label" })}
          clearLabel={formatMessage({ id: "ui.listToolbar.clearSearch" })}
          data-testid="computers-rack-search"
        />
        <FitToolbarGroup
          overflow="scroll"
          wrapOrder={LIST_TOOLBAR_STEP.filtersWrap}
          className="gap-2"
          data-testid="computers-rack-filter-strip"
          end={<ClearAll model={model} report={report} />}
        >
          {orderedFilters.map((item) => item.node)}
        </FitToolbarGroup>
        <FitToolbarGroup firstLine className="gap-2" moreOrder={LIST_TOOLBAR_STEP.displayMore} moreItem={<RackDisplayMenu model={model} report={report} />}>
          <RackGroupSelect model={model} report={report} />
          <RackSortSelect model={model} report={report} />
          <RackViewSwitch report={report} />
        </FitToolbarGroup>
        <FitToolbarGroup firstLine className={onAdd ? "gap-2" : LIST_TOOLBAR_MORE_GROUP_CLASS}>
          <ListToolbarMore testId="computers-rack-more" />
          {onAdd ? (
            <FitToolbarButton variant="primary" icon={<Plus />} plusOrder={LIST_TOOLBAR_STEP.primaryPlus} onClick={onAdd} data-testid="computers-rack-add">
              {formatMessage({ id: "machine.mobile.addComputer" })}
            </FitToolbarButton>
          ) : null}
        </FitToolbarGroup>
      </FitToolbar>
    </div>
  );
}
