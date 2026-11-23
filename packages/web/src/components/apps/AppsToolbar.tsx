import { useCallback } from "react";
import type { ReactNode } from "react";
import { LayoutList, Store, X } from "lucide-react";
import { useIntl } from "react-intl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
} from "@botiverse/raft-ui";
import { FitToolbar, FitToolbarButton, FitToolbarGroup, FitToolbarPicker, FitToolbarSearch } from "@botiverse/raft-ui/wip";
import { MARKETPLACE_LISTINGS_QUERY_MAX_CHARS, OAUTH_CLIENT_CATEGORIES } from "@botiverse/raft-shared";
import type { OAuthClientCategory } from "@botiverse/raft-shared";
import { CONNECTED_APP_CATEGORY_LABEL_ID } from "../../features/apps/connected-apps/connectedAppCatalog";
import type { ConnectedAppsTab } from "../settings/SettingsSegmentedControls";
import { LIST_TOOLBAR_AIR_CLASS, LIST_TOOLBAR_STEP, LIST_TOOLBAR_MORE_GROUP_CLASS } from "../ui/listToolbar";
import { ListScope, ListToolbarMore } from "../ui/ListToolbarParts";
import type { ListScopeOption } from "../ui/ListToolbarParts";
import { APPS_ORIGIN_FILTERS, APPS_ORIGIN_LABEL_ID, hasActiveAppsFilters } from "./appsFilters";
import type { AppsFilters, AppsOriginFilter } from "./appsFilters";

const CATEGORY_VALUES: readonly (OAuthClientCategory | "all")[] = ["all", ...OAUTH_CLIENT_CATEGORIES];

function FilterSelect<T extends string>({
  value,
  values,
  labelOf,
  nameOf,
  icon,
  applied,
  labelOrder,
  onChange,
  testId,
}: {
  value: T;
  values: readonly T[];
  labelOf: (value: T) => string;
  /** The trigger's accessible name when the value alone doesn't say the filter ("Source: All"); it holds the visible text. */
  nameOf?: (value: T) => string;
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
        aria-label={nameOf ? nameOf(value) : labelOf(value)}
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
 * (Yours, Discover, with their counts; none for a member, who has Yours alone) at its start, the search filling the
 * line, the scope's one filter (Yours: where the App came from; Discover:
 * its Category), Clear All pinned after it once something narrows the list,
 * then Add App, the primary action, last. No view switch: Apps are always
 * cards. No scope names an App type (R4), and neither has a Sort: Discover
 * keeps the server's order, the most used first. As it narrows: the filter
 * shows its icon, then moves to a scrolling second line with its words back,
 * Add App becomes +, the scope becomes a Select, and last an empty search
 * becomes its button.
 */
export function AppsToolbar({
  tab,
  tabs,
  onTabChange,
  filters,
  onChange,
  onClearAll,
  addApp,
  variant = "page",
}: {
  tab: ConnectedAppsTab;
  tabs: readonly ListScopeOption<ConnectedAppsTab>[];
  onTabChange: (tab: ConnectedAppsTab) => void;
  filters: AppsFilters;
  onChange: (patch: Partial<AppsFilters>) => void;
  onClearAll: () => void;
  /** Add App, the primary action, at the line's end (a FitToolbarButton opening its menu); the page's only. */
  addApp?: ReactNode;
  /** The Apps page (a line of the toolbar over a list, edge to edge) or the Settings section (inside its column, no line of its own). */
  variant?: "page" | "settings";
}) {
  const { formatMessage } = useIntl();
  const handleSearch = useCallback((search: string) => onChange({ search }), [onChange]);
  const handleOrigin = useCallback((origin: AppsOriginFilter) => onChange({ origin }), [onChange]);
  const originLabel = useCallback((origin: AppsOriginFilter) => formatMessage({ id: APPS_ORIGIN_LABEL_ID[origin] }), [formatMessage]);
  const originName = useCallback(
    (origin: AppsOriginFilter) => formatMessage({ id: "apps.filter.originName" }, { value: formatMessage({ id: APPS_ORIGIN_LABEL_ID[origin] }) }),
    [formatMessage],
  );
  const handleCategory = useCallback((category: OAuthClientCategory | "all") => onChange({ category }), [onChange]);
  const categoryLabel = useCallback(
    (category: OAuthClientCategory | "all") => formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[category] ?? "settings.connectedApps.categoryOther" }),
    [formatMessage],
  );
  // "Apps, Yours".
  const scopeLabel = formatMessage({ id: "apps.page.title" });

  // One filter per scope, a button that shows its value (Raft DS › Select ›
  // Filters), as the Computers page's: Yours' Source, Discover's Category.
  const filter = tab === "yours" ? (
    <FilterSelect
      key="origin"
      value={filters.origin}
      values={APPS_ORIGIN_FILTERS}
      labelOf={originLabel}
      nameOf={originName}
      icon={<Store />}
      applied={filters.origin !== "all"}
      labelOrder={LIST_TOOLBAR_STEP.filterLabels}
      onChange={handleOrigin}
      testId="apps-filter-origin"
    />
  ) : (
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
  );

  return (
    <div className={variant === "page" ? `px-4 md:px-(--surface-inset) ${LIST_TOOLBAR_AIR_CLASS}` : undefined} data-testid="connected-apps-filters">
      <FitToolbar aria-label={formatMessage({ id: "apps.page.title" })} wrap className="gap-2">
        {/* A member's page has Yours alone (R15): no scope to switch. */}
        {tabs.length > 1 ? <ListScope value={tab} options={tabs} onValueChange={onTabChange} label={scopeLabel} testId="connected-apps-tabs" selectTestId="connected-apps-scope-select" /> : null}
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
          end={hasActiveAppsFilters(filters, tab) ? (
            <FitToolbarButton variant="ghost" collapsedIcon={<X />} labelOrder={LIST_TOOLBAR_STEP.filterLabels} onClick={onClearAll} data-testid="apps-filter-clear-all">
              {formatMessage({ id: "apps.filter.clearAll" })}
            </FitToolbarButton>
          ) : null}
        >
          {filter}
        </FitToolbarGroup>
        <FitToolbarGroup firstLine className={addApp ? "gap-2" : LIST_TOOLBAR_MORE_GROUP_CLASS}>
          <ListToolbarMore testId="apps-toolbar-more" />
          {addApp}
        </FitToolbarGroup>
      </FitToolbar>
    </div>
  );
}
