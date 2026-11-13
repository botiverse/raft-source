import { useMemo } from "react";
import { useIntl } from "react-intl";
import { LayoutGrid, List } from "lucide-react";
import { ListViewSwitch } from "../../../components/ui/ListToolbarParts";
import type { ConnectedAppsViewMode } from "./connectedAppTypes";

/**
 * Grid / List at the end of the Apps toolbar, the view switch of the toolbar
 * over a list (ListViewSwitch): one toolbar item, its icons only from the
 * first step, each word kept as its name and tooltip; then into ⋯ with the sort.
 */
export function ConnectedAppsViewToggle({
  value,
  onValueChange,
}: {
  value: ConnectedAppsViewMode;
  onValueChange: (value: ConnectedAppsViewMode) => void;
}) {
  const { formatMessage } = useIntl();
  const options = useMemo(() => [
    { value: "grid" as const, label: formatMessage({ id: "settings.connectedApps.gridView" }), icon: <LayoutGrid size={16} aria-hidden="true" />, testId: "connected-apps-view-grid" },
    { value: "list" as const, label: formatMessage({ id: "settings.connectedApps.listView" }), icon: <List size={16} aria-hidden="true" />, testId: "connected-apps-view-list" },
  ], [formatMessage]);
  return (
    <ListViewSwitch
      value={value}
      options={options}
      onValueChange={onValueChange}
      label={formatMessage({ id: "settings.connectedApps.viewMode" })}
      testId="connected-apps-view-toggle"
    />
  );
}
