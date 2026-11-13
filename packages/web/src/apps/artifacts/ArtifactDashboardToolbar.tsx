import { useCallback } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ArrowDownUp, ChevronDown, Inbox, LayoutGrid, List, X } from "lucide-react";
import {
  Button,
  PickerTriggerButton,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlLabel,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  TasksPanelToolbar,
} from "@botiverse/raft-ui";

import { ICONS_ONLY_GROUP_CLASS, useIconsOnlyWhenWrapped } from "../../hooks/useIconsOnlyWhenWrapped";
import { ToolbarLabelTooltip } from "../../components/ui/ToolbarLabelTooltip";
import { FilterStrip } from "../../components/ui/FilterStrip";
import { ARTIFACT_HOME_DEFAULT_SORT, ARTIFACT_HOME_SORTS } from "./artifactDashboardPrefs";
import type { ArtifactDashboardView, ArtifactHomeSort } from "./artifactDashboardPrefs";

const SORT_LABEL_IDS = {
  opened: "artifacts.dashboard.sort.opened",
  updated: "artifacts.dashboard.sort.updated",
} as const satisfies Record<ArtifactHomeSort, string>;

/**
 * The filter bar (#proj-workspace:#210, the row Tasks draws under its head): the
 * title search, the filters, a ghost Clear after them (Raft DS › Select ›
 * Filters), then the sort and grid/list at the end of the first row (Kirby). A phone
 * has two rows: the search, the sort and the view, then the filters, which scroll
 * sideways when they don't fit (FilterStrip), their text whole, and Clear
 * is its ✕, as its words have no room there. Wider, the sort and grid/list keep the
 * end of the first row and the rest wraps beside them (#proj-workspace:dc3c9fc9,
 * xxchan): the search gives way first, from 260px down to 160px, and in a row
 * narrower than 56rem the sort is its icon, as on a phone. Where the filters would
 * still run onto a second line, they give up their words before their line, and
 * only then grid/list (Raft DS › Responsive layout › When a row runs out of room;
 * useIconsOnlyWhenWrapped, xxchan): a filter not set is its icon, 和我有关 its icon
 * and number, Clear its ×, each with its name in a tooltip; a set filter keeps its value. The order is the DOM's,
 * not CSS's, so focus moves as the eye does at either width.
 *
 * Clear only with both filters set (#proj-workspace:#221, Kirby's draft): each
 * filter has its own ×, so beside one value it would say the same thing twice.
 */

export function DashboardToolbar({ search, filters, clear, sort, view, phone }: {
  search: ReactNode;
  filters: ReactNode;
  clear: (() => void) | null;
  /** None while the server fixes the order. */
  sort: ReactNode;
  view: ReactNode;
  phone: boolean;
}) {
  const { formatMessage } = useIntl();
  const clearLabel = formatMessage({ id: "artifacts.dashboard.clearFilters" });
  const iconsOnlyWhenWrapped = useIconsOnlyWhenWrapped<HTMLDivElement>();
  return phone ? (
    <TasksPanelToolbar className="flex flex-col items-stretch gap-2" data-testid="artifacts-all-toolbar">
      <div className="flex min-w-0 items-center gap-2">{search}<div className="flex shrink-0 items-center gap-2">{sort}{view}</div></div>
      <FilterStrip testId="artifacts-all-filter-strip">
        {filters}
        {clear ? (
          <Button type="button" size="icon-md" variant="ghost" className="shrink-0" aria-label={clearLabel} onClick={clear} data-testid="artifacts-all-toolbar-clear">
            <X aria-hidden />
          </Button>
        ) : null}
      </FilterStrip>
    </TasksPanelToolbar>
  ) : (
    // Tasks' bar (TasksPanel draws the same): with a fine pointer, one row of controls makes the header height,
    // 44px with its 1px seam: the header's air above a control, and that less the seam below, on whole pixels.
    // Top-aligned so that, wrapped, the sort and grid/list stay at the end of the first line; with any other
    // pointer the group gets the 3px the switch's track has around its segments, so the two line up there too.
    <TasksPanelToolbar className="@container/artifacts-bar flex items-start gap-2 md:pointer-fine:pt-(--header-air) md:pointer-fine:pb-[calc(var(--header-air)-1px)]" data-testid="artifacts-all-toolbar">
      <div ref={iconsOnlyWhenWrapped} className={`flex min-w-40 flex-1 flex-wrap items-center gap-2 pt-[3px] md:pointer-fine:pt-0 ${ICONS_ONLY_GROUP_CLASS}`} data-testid="artifacts-all-toolbar-filters">
        {search}
        {filters}
        {clear ? (
          <ToolbarLabelTooltip label={clearLabel}>
            <Button type="button" size="md" variant="ghost" onClick={clear} data-testid="artifacts-all-toolbar-clear">
              <X aria-hidden className="hidden" data-toolbar-icon-only="" />
              <span data-toolbar-label="">{clearLabel}</span>
            </Button>
          </ToolbarLabelTooltip>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {sort}
        {/* With a fine pointer raft-ui's SegmentedControl is its segments (a control's height) in a 3px track:
            the track spills into the padding, so the segments line up with the buttons of the first line, as in
            Tasks. */}
        <div className="md:pointer-fine:-my-[3px]">{view}</div>
      </div>
    </TasksPanelToolbar>
  );
}

/**
 * Grid or list (design D10): a SegmentedControl at the toolbar's end, grid first; icons only in a narrow bar (a phone),
 * and wider the filters give up their words first (Raft DS › Responsive layout › When a row runs out of room).
 */
export function ViewToggle({ view, onChange }: { view: ArtifactDashboardView; onChange: (view: ArtifactDashboardView) => void }) {
  const { formatMessage } = useIntl();
  return (
    <SegmentedControl<ArtifactDashboardView> value={view} onValueChange={onChange} iconsOnlyBelow="md" aria-label={formatMessage({ id: "artifacts.dashboard.view.label" })} data-testid="artifacts-dashboard-view">
      <SegmentedControlItem value="grid" aria-label={formatMessage({ id: "artifacts.dashboard.view.grid" })} data-testid="artifacts-dashboard-view-grid">
        <LayoutGrid aria-hidden />
        <SegmentedControlLabel>{formatMessage({ id: "artifacts.dashboard.view.grid" })}</SegmentedControlLabel>
      </SegmentedControlItem>
      <SegmentedControlItem value="list" aria-label={formatMessage({ id: "artifacts.dashboard.view.list" })} data-testid="artifacts-dashboard-view-list">
        <List aria-hidden />
        <SegmentedControlLabel>{formatMessage({ id: "artifacts.dashboard.view.list" })}</SegmentedControlLabel>
      </SegmentedControlItem>
    </SegmentedControl>
  );
}

/**
 * The list's sort, the only control that orders it: a filter that shows its value (Raft DS › Select › Which filter
 * button), filled once it differs from the default. On a phone, and in a wide bar narrower than 56rem, it is the icon
 * and the chevron, so the search and the filters have the row: the value is in its name and its menu, and the fill
 * still says it isn't the default. Its value is what the reader chose, kept while 和我有关 hides it (the page draws none then).
 */
export function SortPicker({ sort, onChange }: { sort: ArtifactHomeSort; onChange: (sort: ArtifactHomeSort) => void }) {
  const { formatMessage } = useIntl();
  const change = useCallback((next: ArtifactHomeSort | null) => {
    if (next !== null) onChange(next);
  }, [onChange]);
  const label = formatMessage({ id: SORT_LABEL_IDS[sort] });
  const name = formatMessage({ id: "artifacts.dashboard.sort.label" }, { sort: label });
  return (
    <Select<ArtifactHomeSort> value={sort} onValueChange={change}>
      <ToolbarLabelTooltip label={name}>
        <SelectTrigger
          aria-label={name}
          data-testid="artifacts-all-sort"
          render={<PickerTriggerButton data-has-value={sort === ARTIFACT_HOME_DEFAULT_SORT ? undefined : ""} className="shrink-0" />}
        >
          <ArrowDownUp aria-hidden size={14} />
          <span className="max-md:hidden @max-[56rem]/artifacts-bar:hidden" data-toolbar-label="">{label}</span>
          <SelectIcon>
            <ChevronDown aria-hidden size={12} />
          </SelectIcon>
        </SelectTrigger>
      </ToolbarLabelTooltip>
      <SelectContent align="end">
        <SelectList>
          {ARTIFACT_HOME_SORTS.map((option) => (
            <SelectItem key={option} value={option} data-testid={`artifacts-all-sort-${option}`}>
              <SelectItemText>{formatMessage({ id: SORT_LABEL_IDS[option] })}</SelectItemText>
              <SelectItemIndicator />
            </SelectItem>
          ))}
        </SelectList>
      </SelectContent>
    </Select>
  );
}

/**
 * 和我有关 (design: a switch, not a list): one press and it is on, another and it is off, with an applied filter's
 * look while on. It lists everything the reader is involved with, read or not; its number is only what has something new
 * for them (`counts.relevant`), so it still reads "new for you", and isn't there when that's none (or an older Server sends none).
 */
export function RelevantToggle({ on, count, onChange }: { on: boolean; count: number | null; onChange: (on: boolean) => void }) {
  const { formatMessage } = useIntl();
  const toggle = useCallback(() => onChange(!on), [on, onChange]);
  const name = formatMessage({ id: "artifacts.dashboard.relevant" });
  return (
    <ToolbarLabelTooltip label={name}>
      <PickerTriggerButton type="button" aria-pressed={on} data-has-value={on ? "" : undefined} onClick={toggle} data-testid="artifacts-all-relevant">
        <Inbox size={14} aria-hidden />
        <span data-toolbar-label="">{name}</span>
        {count !== null && count > 0 ? <span className="font-mono text-mono-meta font-bold text-foreground" data-testid="artifacts-all-relevant-count">{count}</span> : null}
      </PickerTriggerButton>
    </ToolbarLabelTooltip>
  );
}
