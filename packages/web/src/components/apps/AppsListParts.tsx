import { useIntl } from "react-intl";
import { Blocks, Plug } from "lucide-react";
import { Badge, Button, Text } from "@botiverse/raft-ui";
import EmptyState from "../ui/EmptyState";
import { CONNECTED_APP_CATEGORY_LABEL_ID } from "../../features/apps/connected-apps/connectedAppCatalog";
import { APPS_TYPE_LABEL_ID } from "./appsFilters";
import type { AppsFilters } from "./appsFilters";

/**
 * An MCP App's tag after its name: the outline Space Mono tag the `agent` tag
 * is (Raft DS › Status › Agent tag), with a plug. No new color.
 */
export function McpTag() {
  const { formatMessage } = useIntl();
  return (
    <Badge appearance="outline" variant="muted" className="shrink-0 gap-1 font-mono" data-testid="apps-mcp-tag">
      <Plug aria-hidden size={12} />
      {formatMessage({ id: "settings.connectedApps.mcp.badge" })}
    </Badge>
  );
}

/**
 * The heading of a section of the Apps page ("Recommended for you", and
 * "Installed" under it): Raft DS › Text `group`, the heading of a group of
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
export function AppsNoMatchState({ title, filters, onClearAll }: {
  /** The tab's own line: No installed apps match this view, … */
  title: string;
  filters: AppsFilters;
  onClearAll: () => void;
}) {
  const { formatMessage, formatList } = useIntl();
  const conditions = [
    filters.search.trim() ? `“${filters.search.trim()}”` : null,
    filters.type !== "all" ? formatMessage({ id: APPS_TYPE_LABEL_ID[filters.type] }) : null,
    filters.category !== "all" ? formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[filters.category] ?? "settings.connectedApps.categoryOther" }) : null,
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
