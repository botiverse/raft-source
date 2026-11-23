import { useIntl } from "react-intl";
import { Blocks } from "lucide-react";
import { Button, Text } from "@botiverse/raft-ui";
import EmptyState from "../ui/EmptyState";
import { CONNECTED_APP_CATEGORY_LABEL_ID } from "../../features/apps/connected-apps/connectedAppCatalog";
import type { ConnectedAppsTab } from "../settings/SettingsSegmentedControls";
import { APPS_ORIGIN_LABEL_ID } from "./appsFilters";
import type { AppsFilters } from "./appsFilters";

/**
 * The heading of a section of the Apps page ("Recommended for {server}", and
 * "All apps" under it, on Discover): Raft DS › Text `group`, the heading of a group of
 * rows or cards, in an `h3` (the page's title is its `h2`).
 */
export function AppsSectionHeading({ id, children }: { id: string; children: string }) {
  return (
    <h3 id={id}>
      <Text.Sans size="group" render={<span />}>{children}</Text.Sans>
    </h3>
  );
}

/**
 * Filters or a search that match nothing (Raft DS › EmptyState): say which
 * conditions are on, so it doesn't read as an empty list, and offer Clear All.
 */
export function AppsNoMatchState({ title, scope, filters, onClearAll }: {
  /** The scope's own line: No apps match this view, … */
  title: string;
  /** Whose filter is on: Yours has its origin filter, Discover its Category. */
  scope: ConnectedAppsTab;
  filters: AppsFilters;
  onClearAll: () => void;
}) {
  const { formatMessage, formatList } = useIntl();
  const scopeCondition = scope === "yours"
    ? (filters.origin !== "all" ? formatMessage({ id: APPS_ORIGIN_LABEL_ID[filters.origin] }) : null)
    : (filters.category !== "all" ? formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[filters.category] ?? "settings.connectedApps.categoryOther" }) : null);
  const conditions = [
    filters.search.trim() ? `“${filters.search.trim()}”` : null,
    scopeCondition,
  ].filter((condition): condition is string => condition !== null);
  return (
    <EmptyState
      className="py-10"
      icon={<Blocks size={36} />}
      title={title}
      description={conditions.length > 0
        ? formatMessage({ id: "apps.empty.noMatchDescription" }, { conditions: formatList(conditions, { type: "unit" }) })
        : undefined}
      action={(
        <Button type="button" variant="default" size="md" onClick={onClearAll} data-testid="apps-no-match-clear-all">
          {formatMessage({ id: "apps.filter.clearAll" })}
        </Button>
      )}
      data-testid="apps-no-match"
    />
  );
}
