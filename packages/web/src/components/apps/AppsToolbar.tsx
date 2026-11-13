import { useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { ArrowDownUp, LayoutList, Shapes, X } from "lucide-react";
import { useIntl } from "react-intl";
import {
  DropdownMenuSeparator,
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
} from "@botiverse/raft-ui";
import { FitToolbar, FitToolbarButton, FitToolbarGroup, FitToolbarPicker, FitToolbarSearch } from "@botiverse/raft-ui/wip";
import { MARKETPLACE_LISTING_SORTS, MARKETPLACE_LISTING_TYPES, MARKETPLACE_LISTINGS_QUERY_MAX_CHARS, OAUTH_CLIENT_CATEGORIES } from "@botiverse/raft-shared";
import type { MarketplaceListingSort, MarketplaceListingType, OAuthClientCategory } from "@botiverse/raft-shared";
import { CONNECTED_APP_CATEGORY_LABEL_ID } from "../../features/apps/connected-apps/connectedAppCatalog";
import type { ConnectedAppsViewMode } from "../../features/apps/connected-apps/connectedAppTypes";
import type { ConnectedAppsTab } from "../settings/SettingsSegmentedControls";
import { LIST_TOOLBAR_AIR_CLASS, LIST_TOOLBAR_STEP, LIST_TOOLBAR_MORE_GROUP_CLASS } from "../ui/listToolbar";
import { ListScope, ListToolbarMore, MoreMenuChoices } from "../ui/ListToolbarParts";
import type { ListScopeOption } from "../ui/ListToolbarParts";
import { APPS_SORT_LABEL_ID, APPS_TYPE_LABEL_ID, hasActiveAppsFilters } from "./appsFilters";
import type { AppsFilters } from "./appsFilters";

const CATEGORY_VALUES: readonly (OAuthClientCategory | "all")[] = ["all", ...OAUTH_CLIENT_CATEGORIES];
const VIEW_MODES: readonly ConnectedAppsViewMode[] = ["grid", "list"];

function FilterSelect<T extends string>({
  value,
  values,
  labelOf,
  icon,
  applied,
  labelOrder,
  onChange,
  testId,
}: {
  value: T;
  values: readonly T[];
  labelOf: (value: T) => string;
  icon: ReactNode;
  applied: boolean;
  labelOrder: number;
  onChange: (value: T) => void;
  testId: string;
}) {
  const handleChange = useCallback((next: T | null) => {
    if (next != null) onChange(next);
  }, [onChange]);
  return (
    <Select<T> value={value} onValueChange={handleChange}>
      {/* Raft DS › Select › Filters: a button that shows the current value,
          filled info-soft once applied; the same list on a phone. Its name is
          the value it shows (WCAG 2.5.3 Label in Name): a combobox takes no
          name from its content, so the visible text is set as the label. */}
      <FitToolbarPicker
        trigger={<SelectTrigger />}
        icon={icon}
        labelOrder={labelOrder}
        aria-label={labelOf(value)}
        data-has-value={applied ? "" : undefined}
        data-active={applied ? "" : undefined}
        data-testid={testId}
      >
        {labelOf(value)}
      </FitToolbarPicker>
      <SelectContent align="start">
        <SelectList>
          {values.map((option) => (
            <SelectItem key={option} value={option} data-testid={`${testId}-${option}`}>
              <SelectItemText>{labelOf(option)}</SelectItemText>
              <SelectItemIndicator />
            </SelectItem>
          ))}
        </SelectList>
      </SelectContent>
    </Select>
  );
}

/**
 * The Apps list's toolbar, the toolbar over a list (Raft DS › Patterns ›
 * Responsive › The toolbar over a list), on raft-ui's FitToolbar: the scope
 * (Installed, Marketplace, Developer, with their counts) at its start, the
 * search filling the line, the filters Type and Category (the applied first,
 * Clear All pinned at their end once one narrows the list), then the
 * Marketplace's Sort, the grid/list switch and Add App, the primary action,
 * last. As it narrows: the sort and the switch show their icons, the filters
 * theirs, the filters move to a scrolling second line with their words back,
 * Add App becomes +, the scope becomes a Select, the sort and the switch fold
 * into ⋯, and last an empty search becomes its button.
 */
export function AppsToolbar({
  tab,
  tabs,
  onTabChange,
  filters,
  showSort,
  onChange,
  onClearAll,
  view,
  onViewChange,
  viewSwitch,
  addApp,
  variant = "page",
}: {
  tab: ConnectedAppsTab;
  tabs: readonly ListScopeOption<ConnectedAppsTab>[];
  onTabChange: (tab: ConnectedAppsTab) => void;
  filters: AppsFilters;
  /** Sort orders the Marketplace; Installed and My Apps keep their own order. */
  showSort: boolean;
  onChange: (patch: Partial<AppsFilters>) => void;
  onClearAll: () => void;
  view: ConnectedAppsViewMode;
  onViewChange: (view: ConnectedAppsViewMode) => void;
  /** The grid/list switch, at the line's end. */
  viewSwitch: ReactNode;
  /** Add App, the primary action, after it (a FitToolbarButton opening its menu); the page's only. */
  addApp?: ReactNode;
  /** The Apps page (a line of the toolbar over a list, edge to edge) or the Settings section (inside its column, no line of its own). */
  variant?: "page" | "settings";
}) {
  const { formatMessage } = useIntl();
  const handleSearch = useCallback((search: string) => onChange({ search }), [onChange]);
  const handleType = useCallback((type: MarketplaceListingType) => onChange({ type }), [onChange]);
  const handleCategory = useCallback((category: OAuthClientCategory | "all") => onChange({ category }), [onChange]);
  const handleSort = useCallback((sort: MarketplaceListingSort) => onChange({ sort }), [onChange]);
  const typeLabel = useCallback((type: MarketplaceListingType) => formatMessage({ id: APPS_TYPE_LABEL_ID[type] }), [formatMessage]);
  const categoryLabel = useCallback(
    (category: OAuthClientCategory | "all") => formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[category] ?? "settings.connectedApps.categoryOther" }),
    [formatMessage],
  );
  const sortLabel = useCallback((sort: MarketplaceListingSort) => formatMessage({ id: APPS_SORT_LABEL_ID[sort] }), [formatMessage]);
  const sortOptions = useMemo(() => MARKETPLACE_LISTING_SORTS.map((value) => ({ value, label: sortLabel(value) })), [sortLabel]);
  const viewOptions = useMemo(() => VIEW_MODES.map((value) => ({
    value,
    label: formatMessage({ id: value === "grid" ? "settings.connectedApps.gridView" : "settings.connectedApps.listView" }),
  })), [formatMessage]);
  // "Apps, Installed": not confusable with the grid/list switch.
  const scopeLabel = formatMessage({ id: "apps.page.title" });

  const filterItems = [
    {
      key: "type",
      applied: filters.type !== "all",
      node: (
        <FilterSelect
          key="type"
          value={filters.type}
          values={MARKETPLACE_LISTING_TYPES}
          labelOf={typeLabel}
          icon={<Shapes />}
          applied={filters.type !== "all"}
          labelOrder={LIST_TOOLBAR_STEP.filterLabels}
          onChange={handleType}
          testId="apps-filter-type"
        />
      ),
    },
    {
      key: "category",
      applied: filters.category !== "all",
      node: (
        <FilterSelect
          key="category"
          value={filters.category}
          values={CATEGORY_VALUES}
          labelOf={categoryLabel}
          icon={<LayoutList />}
          applied={filters.category !== "all"}
          labelOrder={LIST_TOOLBAR_STEP.filterLabels}
          onChange={handleCategory}
          testId="connected-apps-category-filter"
        />
      ),
    },
  ];
  // The applied filters first, so they are in view before any scrolling.
  const orderedFilters = [...filterItems.filter((item) => item.applied), ...filterItems.filter((item) => !item.applied)];

  return (
    <div className={variant === "page" ? `px-4 md:px-(--surface-inset) ${LIST_TOOLBAR_AIR_CLASS}` : undefined} data-testid="connected-apps-filters">
      <FitToolbar aria-label={formatMessage({ id: "apps.page.title" })} wrap className="gap-2">
        <ListScope value={tab} options={tabs} onValueChange={onTabChange} label={scopeLabel} testId="connected-apps-tabs" selectTestId="connected-apps-scope-select" />
        <FitToolbarSearch
          value={filters.search}
          onValueChange={handleSearch}
          collapseOrder={LIST_TOOLBAR_STEP.searchButton}
          // The Marketplace refuses a longer `q` (400), which would only fail and retry.
          maxLength={MARKETPLACE_LISTINGS_QUERY_MAX_CHARS}
          placeholder={formatMessage({ id: "settings.connectedApps.searchApps" })}
          aria-label={formatMessage({ id: "settings.connectedApps.searchAppsAriaLabel" })}
          clearLabel={formatMessage({ id: "ui.listToolbar.clearSearch" })}
          data-testid="connected-apps-search"
        />
        <FitToolbarGroup
          overflow="scroll"
          wrapOrder={LIST_TOOLBAR_STEP.filtersWrap}
          className="gap-2"
          data-testid="apps-filter-strip"
          end={hasActiveAppsFilters(filters) ? (
            <FitToolbarButton variant="ghost" collapsedIcon={<X />} labelOrder={LIST_TOOLBAR_STEP.filterLabels} onClick={onClearAll} data-testid="apps-filter-clear-all">
              {formatMessage({ id: "apps.filter.clearAll" })}
            </FitToolbarButton>
          ) : null}
        >
          {orderedFilters.map((item) => item.node)}
        </FitToolbarGroup>
        <FitToolbarGroup
          firstLine
          className="gap-2"
          moreOrder={LIST_TOOLBAR_STEP.displayMore}
          data-testid="apps-toolbar-trailing"
          moreItem={(
            <>
              {showSort ? (
                <>
                  <MoreMenuChoices heading={formatMessage({ id: "ui.listToolbar.sort" })} value={filters.sort} options={sortOptions} onValueChange={handleSort} testId="apps-more-sort" />
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <MoreMenuChoices heading={formatMessage({ id: "ui.listToolbar.view" })} value={view} options={viewOptions} onValueChange={onViewChange} testId="apps-more-view" />
            </>
          )}
        >
          {showSort ? (
            <FilterSelect
              value={filters.sort}
              values={MARKETPLACE_LISTING_SORTS}
              labelOf={sortLabel}
              icon={<ArrowDownUp />}
              applied={filters.sort !== "installs"}
              labelOrder={LIST_TOOLBAR_STEP.displayLabels}
              onChange={handleSort}
              testId="apps-filter-sort"
            />
          ) : null}
          {viewSwitch}
        </FitToolbarGroup>
        <FitToolbarGroup firstLine className={addApp ? "gap-2" : LIST_TOOLBAR_MORE_GROUP_CLASS}>
          <ListToolbarMore testId="apps-toolbar-more" />
          {addApp}
        </FitToolbarGroup>
      </FitToolbar>
    </div>
  );
}
